/** MAP-14 / INV-002, INV-029, INV-050, INV-052 regression coverage. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeLM } from "../src/dialects/typesafe.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import {
  anthropicSchema, choice, geminiSchema, judgments, judgmentsInSchema,
  parseTypeSafeResponse, score, yesNo,
} from "../src/judgments.ts";
import { RawNumber, deepFreeze, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../src/json.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Request, type Config } from "../src/types/config.ts";
import { Message } from "../src/types/parts.ts";
import { Response, Usage } from "../src/types/response.ts";
import { HttpResponse, textBytes } from "../src/wire.ts";

installNodePlatform();

const format = judgments({
  ok: yesNo("Is it fine?"),
  style: choice("Which style?", ["fruit", "oak"]),
  quality: score("How good?", ["poor", "good", "great"]),
});
const request = Request.create({ model: "jev-latest", messages: [Message.user("note")], config: { responseFormat: format } });

function goodAnswers(): JsonObject {
  return {
    ok: { type: "noul", noul: 0.75, confidence: new RawNumber("0.90") },
    style: { type: "choice", choice: "oak", probabilities: { fruit: 0.2, oak: 0.8 } },
    quality: { type: "score", score: new RawNumber("1.0"), probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } },
  };
}
function reply(body: string): HttpResponse {
  return new HttpResponse({ status: 200, headers: [["Content-Type", "application/json"], ["X-TypeSafe-Request-ID", "jev-request-1"]], body: textBytes(body) });
}
function fold(body: JsonValue): Response {
  return parseTypeSafeResponse(request, reply(stringifyJson(body)));
}
function providerFault(path: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "provider");
    assert.equal(error.provider, "typesafe");
    assert.equal(error.status, 200);
    assert.equal(error.requestId, "jev-request-1");
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes(path), error.message);
    return true;
  };
}

test("schema rewrites deep-copy RawNumber and opaque nested values without native JSON serialization", () => {
  const schema = parseJson('{"type":"object","properties":{"q":{"type":"string","anyOf":[{"const":"a","description":"A"},{"const":"b"}],"default":"b"},"plain":{"type":"number","minimum":9007199254740993,"default":1.0}},"$defs":{"opaque":{"enum":[1e2,{"__proto__":{"amount":9007199254740997}}]}},"additionalProperties":false}') as JsonObject;
  const before = stringifyJson(schema);
  deepFreeze(schema);
  const found = judgmentsInSchema(schema);
  for (const rewrite of [anthropicSchema, geminiSchema]) {
    const rewritten = rewrite(schema, found);
    assert.notEqual(rewritten, schema);
    const sourceProps = schema["properties"] as JsonObject;
    const props = rewritten["properties"] as JsonObject;
    assert.notEqual(props, sourceProps);
    assert.notEqual(props["plain"], sourceProps["plain"]);
    assert.equal(stringifyJson(props["plain"]), stringifyJson(sourceProps["plain"]));
    assert.equal(stringifyJson(rewritten["$defs"]), stringifyJson(schema["$defs"]));
    assert.equal(((props["plain"] as JsonObject)["minimum"] as RawNumber).raw, "9007199254740993");
    assert.equal(((props["plain"] as JsonObject)["default"] as RawNumber).raw, "1.0");
    assert.equal(stringifyJson(schema), before);
  }
});

test("judgment option descriptions do not inherit object prototype properties", () => {
  const prop = choice("Which?", ["constructor", "toString", "__proto__"]);
  const found = judgmentsInSchema({ properties: { q: prop } });
  for (const key of ["constructor", "toString", "__proto__"]) {
    assert.equal(found.get("q")!.descriptions[key], undefined);
    assert.equal(found.get("q")!.titles[key], undefined);
  }
  const described = judgmentsInSchema({ properties: { q: { anyOf: [{ const: "__proto__", description: "literal key" }] } } });
  assert.equal(described.get("q")!.descriptions["__proto__"], "literal key");
});

test("prototype-named judgment fields and keys survive request, reply and canonical normalization", async () => {
  const properties = Object.fromEntries([["__proto__", choice("Which?", ["__proto__", "constructor"])]]);
  const req = Request.create({ model: "jev-latest", messages: [Message.user("note")], config: { responseFormat: judgments(properties) } });
  const lm = new TypeSafeLM({ apiKey: "k" });
  const payload = lm.payload(req);
  const questions = payload["questions"] as JsonObject;
  assert.ok(Object.hasOwn(questions, "__proto__"));
  assert.ok(Object.hasOwn((questions["__proto__"] as JsonObject)["criteria"] as JsonObject, "__proto__"));
  const raw = reply('{"answers":{"__proto__":{"type":"choice","choice":"__proto__","probabilities":{"__proto__":0.6,"constructor":0.4}}}}');
  const result = lm.parseResponse(req, raw);
  assert.equal((result.data as JsonObject)["__proto__"], "__proto__");
  assert.equal(result.probabilities!["__proto__"]!["__proto__"], 0.6);
  assert.ok(stringifyJson(Response.toJSON(result)).includes('"__proto__":0.6'));
});

test("native judgments preserve measurements, argmax, opaque confidence/score and absent usage", () => {
  const answers = goodAnswers();
  const result = fold({ answers });
  assert.deepEqual(result.data, { ok: true, style: "oak", quality: 2 });
  assert.deepEqual(result.probabilities, { ok: { true: 0.75, false: 0.25 }, style: { fruit: 0.2, oak: 0.8 }, quality: { "0": 0.1, "1": 0.3, "2": 0.6 } });
  assert.equal(result.dataPart?.method, "provider_classification");
  assert.equal(result.model, request.model);
  assert.equal(result.id, "jev-request-1");
  assert.deepEqual(Usage.toJSON(result.usage), {});
  assert.equal(result.usage.inputTokens, undefined);
  assert.equal(result.usage.outputTokens, undefined);
  assert.equal(result.usage.totalTokens, undefined);
  assert.equal(stringifyJson((result.providerData!["typesafe"] as JsonObject)["answers"]), stringifyJson(answers));
});

test("INV-052: no sum check, no normalization, no choice re-selection; ordered ties use declaration order", () => {
  for (const probabilities of [{ fruit: 0.33, oak: 0.33 }, { fruit: 0, oak: 0 }, { fruit: 0.9, oak: 0.9 }]) {
    const answers = goodAnswers();
    answers["style"] = { type: "choice", choice: "oak", probabilities };
    answers["quality"] = { type: "score", probabilities: { "0": 0.7, "1": 0.7, "2": 0.1 } };
    const result = fold({ answers });
    assert.deepEqual(result.probabilities!["style"], probabilities);
    assert.deepEqual(result.data, { ok: true, style: "oak", quality: 0 });
  }
  const answers = goodAnswers();
  answers["style"] = { type: "choice", choice: "fruit", probabilities: { fruit: 0.1, oak: 0.9 } };
  assert.equal((fold({ answers }).data as JsonObject)["style"], "fruit");
});

test("INV-052: canonical assistant distributions accept rounded totals, input measurements refuse", () => {
  const part = { type: "data" as const, value: { q: "a" }, probabilities: { q: { a: 0.33, b: 0.33, c: 0.33 } }, method: "provider_classification" as const };
  const result = new Response({ model: "m", message: Message.assistant(part), finishReason: "stop" });
  assert.deepEqual(result.probabilities, part.probabilities);
  assert.throws(() => Message.user(part), /probabilities belong to assistant/);
});

test("numeric lexemes at boundaries are accepted as measurements, not coerced from strings/bools", () => {
  for (const [noul, pick] of [[new RawNumber("0.0"), false], [new RawNumber("1.0"), true], [0.5, true]] as const) {
    const answers = goodAnswers();
    answers["ok"] = { type: "noul", noul };
    assert.equal((fold({ answers }).data as JsonObject)["ok"], pick);
  }
});

const malformedBodies: Array<[string, JsonValue, string]> = [
  ["null root", null, "$"], ["array root", [], "$"], ["string root", "answer", "$"],
  ["missing answers", {}, "answers"], ["null answers", { answers: null }, "answers"],
  ["array answers", { answers: [] }, "answers"], ["missing all judgments", { answers: {} }, "answers"],
  ["missing judgment", { answers: { ok: { type: "noul", noul: 0.7 } } }, "answers"],
  ["extra judgment", { answers: { ...goodAnswers(), extra: { type: "noul", noul: 0.1 } } }, "answers"],
];
for (const [label, body, path] of malformedBodies) {
  test(`TypeSafe malformed reply: ${label} is a ProviderError`, () => {
    assert.throws(() => fold(body), providerFault(path));
  });
}

const malformedAnswers: Array<[string, JsonValue, string]> = [
  ["ok", null, "answers.ok"], ["ok", [], "answers.ok"], ["ok", {}, "answers.ok.type"],
  ["ok", { type: "choice", choice: "true" }, "answers.ok.type"],
  ["ok", { type: "noul" }, "answers.ok.noul"],
  ["style", { type: "choice", choice: "oak" }, "answers.style.probabilities"],
  ["style", { type: "choice", choice: "oak", probabilities: null }, "answers.style.probabilities"],
  ["style", { type: "choice", choice: "oak", probabilities: [0.2, 0.8] }, "answers.style.probabilities"],
  ["style", { type: "choice", choice: "oak", probabilities: { oak: 0.8 } }, "answers.style.probabilities"],
  ["style", { type: "choice", choice: "oak", probabilities: { fruit: 0.2, oak: 0.8, other: 0 } }, "answers.style.probabilities"],
  ["quality", { type: "score", score: 1.5 }, "answers.quality.probabilities"],
  ["quality", { type: "score", probabilities: { "0": 0.5, "1": 0.5 } }, "answers.quality.probabilities"],
  ["quality", { type: "choice", choice: "1", probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } }, "answers.quality.type"],
];
for (const [index, [name, answer, path]] of malformedAnswers.entries()) {
  test(`TypeSafe malformed answer ${index}: ${path}`, () => {
    assert.throws(() => fold({ answers: { ...goodAnswers(), [name]: answer } }), providerFault(path));
  });
}
for (const chosen of [undefined, null, true, 0, [], {}, "other"]) {
  test(`TypeSafe rejects undeclared/non-string choice ${String(chosen)}`, () => {
    const answer: JsonObject = { type: "choice", probabilities: { fruit: 0.2, oak: 0.8 } };
    if (chosen !== undefined) answer["choice"] = chosen;
    assert.throws(() => fold({ answers: { ...goodAnswers(), style: answer } }), providerFault("answers.style.choice"));
  });
}
for (const raw of ["null", "true", "false", '"0.5"', "[]", "{}", "-0.01", "1.01", "1e999", "-1e999", "9007199254740993"]) {
  test(`TypeSafe rejects malformed probability ${raw} in every primitive`, () => {
    for (const [name, answer, path] of [
      ["ok", `{"type":"noul","noul":${raw}}`, "answers.ok.noul"],
      ["style", `{"type":"choice","choice":"oak","probabilities":{"fruit":0.2,"oak":${raw}}}`, "answers.style.probabilities.oak"],
      ["quality", `{"type":"score","probabilities":{"0":0.1,"1":0.2,"2":${raw}}}`, "answers.quality.probabilities.2"],
    ] as const) {
      const answers = goodAnswers();
      delete answers[name];
      const prefix = stringifyJson(answers).slice(0, -1);
      assert.throws(() => parseTypeSafeResponse(request, reply(`{"answers":${prefix},"${name}":${answer}}}`)), providerFault(path));
    }
  });
}

test("usage absence/null/partial/zero remain distinct, and complete counters derive only total", () => {
  for (const usage of [undefined, null, {}]) {
    const body: JsonObject = { answers: goodAnswers() };
    if (usage !== undefined) body["usage"] = usage;
    assert.deepEqual(Usage.toJSON(fold(body).usage), {});
  }
  assert.deepEqual(Usage.toJSON(fold({ answers: goodAnswers(), usage: { input_tokens: 0 } }).usage), { input_tokens: 0 });
  assert.deepEqual(Usage.toJSON(fold({ answers: goodAnswers(), usage: { output_tokens: 4 } }).usage), { output_tokens: 4 });
  assert.deepEqual(Usage.toJSON(fold({ answers: goodAnswers(), usage: { input_tokens: new RawNumber("2.0"), output_tokens: 0 } }).usage), { input_tokens: 2, output_tokens: 0, total_tokens: 2 });
});
const malformedUsages: JsonValue[] = [false, "unknown", [], { input_tokens: true }, { output_tokens: "3" }, { input_tokens: -1 }, { output_tokens: 1.5 }, { input_tokens: new RawNumber("9007199254740993") }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }];
for (const usage of malformedUsages) {
  test(`TypeSafe malformed usage ${stringifyJson(usage)} is not fabricated zero`, () => {
    assert.throws(() => fold({ answers: goodAnswers(), usage }), providerFault("usage"));
  });
}
for (const model of ["", false, 0, [], {}]) {
  test(`TypeSafe malformed model ${stringifyJson(model)} is a ProviderError`, () => {
    assert.throws(() => fold({ answers: goodAnswers(), model }), providerFault("model"));
  });
}

test("non-JSON success includes status, request id, content type and a bounded byte excerpt", () => {
  const body = "<html>" + "x".repeat(220) + "NOT_IN_EXCERPT";
  const response = new HttpResponse({ status: 200, headers: [["content-type", "text/html"], ["x-typesafe-request-id", "jev-request-1"]], body: textBytes(body) });
  assert.throws(() => parseTypeSafeResponse(request, response), (error) => {
    providerFault("not valid JSON")(error);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.contentType, "text/html");
    assert.equal(error.bodyExcerpt, body.slice(0, 200));
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /text\/html/);
    assert.ok(error.message.includes(body.slice(0, 200)));
    assert.ok(!error.message.includes("NOT_IN_EXCERPT"));
    return true;
  });
});

test("TypeSafe adapter delegates native parsing: malformed noul never becomes false with certainty", async () => {
  const transport = new FakeTransport([new FakeResponse({ body: '{"answers":{"ok":{"type":"noul"}}}' })]);
  const lm = new TypeSafeLM({ apiKey: "k", transport });
  await assert.rejects(lm.complete({ model: "jev-latest", messages: [Message.user("note")], config: { responseFormat: judgments({ ok: yesNo("Fine?") }) } }), (error: unknown) => error instanceof ProviderError && /answers.ok.noul/.test(error.message));
});

test("TypeSafe adapter does not invent usage when the provider reports none", async () => {
  const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body: stringifyJson({ answers: goodAnswers() }) })]) });
  const response = await lm.complete(request);
  assert.deepEqual(Usage.toJSON(response.usage), {});
});

test("judgment helper malformed input diagnostics identify the argument", () => {
  assert.throws(() => choice(null as unknown as string, ["a"]), /choice instruction/);
  assert.throws(() => yesNo(42 as unknown as string), /yesNo instruction/);
  assert.throws(() => score(false as unknown as string, ["a", "b"]), /score instruction/);
  assert.throws(() => choice("q", "ab" as unknown as string[]), /choice options/);
  assert.throws(() => score("q", null as unknown as string[]), /score levels/);
  assert.throws(() => choice("q", { a: 1 } as unknown as Record<string, string>), /description/);
  assert.throws(() => score("q", ["a", 1] as unknown as string[]), /level 1 description/);
  assert.throws(() => choice("q", ["a", "a"]), /unique/);
  assert.throws(() => choice("q", [""]), /non-empty/);
  assert.throws(() => choice("q", new Array<string>(2)), /non-empty/);
  assert.throws(() => score("q", new Array<string>(2)), /description/);
  assert.throws(() => judgments([] as unknown as Record<string, JsonObject>), /properties/);
  assert.throws(() => judgments({ ok: [] as unknown as JsonObject }), /property/);
  assert.throws(() => judgments({ ok: yesNo("?") }, { name: "" }), /name/);
  assert.throws(() => judgments({ ok: yesNo("?") }, { strict: "yes" as unknown as boolean }), /strict/);
  assert.equal(judgments({ ok: yesNo("") }, { strict: false }).strict, false);
});

test("TypeSafe unsupported requests identify native fields before the wire", async () => {
  const transport = new FakeTransport([]);
  const lm = new TypeSafeLM({ apiKey: "k", transport });
  const cases: Array<[Request, string]> = [
    [{ ...request, config: {} }, "config.response_format"],
    [{ ...request, config: { responseFormat: { type: "json_object" } } }, "config.response_format"],
    [{ ...request, config: { responseFormat: judgments({ ok: yesNo("?"), text: { type: "string" } }) } }, "config.response_format"],
    [{ ...request, config: { responseFormat: judgments({ q: { enum: Array.from({ length: 256 }, (_, i) => `k${i}`) } }) } }, "config.response_format.schema.properties.q"],
    [{ ...request, config: { responseFormat: judgments({ q: { type: "integer", enum: Array.from({ length: 11 }, (_, i) => i) } }) } }, "config.response_format.schema.properties.q"],
    [{ ...request, system: "context" }, "system"],
    [{ ...request, messages: [Message.user("a"), Message.user("b")] }, "messages"],
    [{ ...request, messages: [Message.assistant("a")] }, "messages[0].role"],
    [{ ...request, messages: [Message.user(["a", "b"])] }, "messages[0].parts"],
    [{ ...request, messages: [Message.user({ type: "image", url: "https://example.test/image.png" })] }, "messages[0].parts[0]"],
    [{ ...request, tools: [{ type: "function", name: "f" }] }, "tools"],
    [{ ...request, config: { ...request.config, toolChoice: { mode: "none" } } }, "config.tool_choice"],
  ];
  for (const [input, feature] of cases) {
    await assert.rejects(lm.build(input, false), (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === feature && error.provider === "typesafe");
  }
  await assert.rejects(lm.build(request, true), (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "stream");
  assert.equal(transport.requests.length, 0);
});

test("TypeSafe records every unsupported knob, including explicit zero and false", async () => {
  const config: Config = {
    responseFormat: judgments({ ok: { type: "boolean" } }), probabilities: "required",
    maxTokens: 10, temperature: 0, topP: 1, topK: 1, stop: ["end"], seed: 0,
    frequencyPenalty: 0, presencePenalty: 0, reasoning: { effort: "off" },
    logprobs: 0, store: false, userId: "u", serviceTier: "default", cache: { mode: "off" },
  };
  const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([]) });
  const built = await lm.build({ ...request, config }, false);
  assert.deepEqual(built.adaptations.filter((a) => a.action === "dropped").map((a) => a.field), [
    "config.max_tokens", "config.temperature", "config.top_p", "config.top_k", "config.stop", "config.seed",
    "config.frequency_penalty", "config.presence_penalty", "config.reasoning", "config.logprobs", "config.store", "config.user_id", "config.service_tier", "config.cache",
  ]);
  assert.deepEqual(built.adaptations.filter((a) => a.action === "defaulted").map((a) => [a.field, a.applied]), [["config.response_format.schema.properties.ok.description", "ok"]]);
  assert.equal(built.adaptations.find((a) => a.field === "config.store")!.asked, false);
  assert.equal(built.adaptations.find((a) => a.field === "config.seed")!.asked, 0);
});
