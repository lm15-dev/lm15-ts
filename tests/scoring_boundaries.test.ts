import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import { judgments, yesNo } from "../src/judgments.ts";
import { RawNumber, type JsonObject } from "../src/json.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { materializeResponse } from "../src/stream.ts";
import { Request, type Config, type ResponseFormat } from "../src/types/config.ts";
import { Message } from "../src/types/parts.ts";
import type { AdaptationPolicy } from "../src/adaptation.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";
import type { TransportRequest } from "../src/wire.ts";

installNodePlatform();

const format = judgments({ ok: yesNo("Is it fine?") });
const base = Request.create({ model: "m", messages: [Message.user("Fine.")], config: { responseFormat: format, probabilities: "required" } });
const forbidden = (): never => { throw new Error("credential/tokenization/transport must not run"); };
const refused = (feature: string) => (error: unknown): boolean => error instanceof UnsupportedFeatureError && error.feature === feature;
const decode = (request: TransportRequest) => JSON.parse(new TextDecoder().decode(request.body)) as JsonObject;

function boundaryRequest(kind: string): [Request, string] {
  const config = base.config!;
  if (kind === "mixed") {
    const fmt: ResponseFormat = { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" }, explanation: { type: "string" } }, required: ["ok", "explanation"] } };
    return [Request.create({ ...base, config: { ...config, responseFormat: fmt } }), "config.response_format"];
  }
  if (kind === "tools") return [Request.create({ ...base, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }), "tools"];
  if (kind === "choice") return [Request.create({ ...base, config: { ...config, toolChoice: { mode: "none" } } }), "config.tool_choice"];
  if (kind === "cache") return [Request.create({ ...base, config: { ...config, cache: { resource: "cached/prompt" } } }), "config.cache.resource"];
  return [Request.create({ ...base, config: { ...config, extensions: { n: 2 } } }), "config.extensions.n"];
}

for (const policy of ["note", "silent", "refuse"] as const) {
  for (const probabilities of ["required", "if_available"] as const) {
    for (const kind of ["tools", "choice", "cache", "multiple"]) {
      test(`scoring refuses ${kind} before credentials (${policy}, ${probabilities})`, async () => {
        const [original, feature] = boundaryRequest(kind);
        const request = Request.create({ ...original, config: { ...original.config, probabilities } });
        const transport = new FakeTransport([]);
        const lm = new OpenAIChatLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
        for (const invoke of [() => lm.plan(request), () => lm.complete(request)]) {
          await assert.rejects(invoke, (error: unknown) => {
            assert.ok(refused(feature)(error));
            assert.match((error as Error).message, /generated JSON/);
            assert.match((error as Error).message, /separate scoring/);
            return true;
          });
        }
        assert.equal(transport.requests.length, 0);
      });
    }
  }
}

class NoTokenizationLM extends OpenAIChatLM {
  protected override judgmentTokenizeRequest(): Promise<TransportRequest> { return forbidden(); }
}

test("strict scoring plan/complete refuse before even building tokenization requests", async () => {
  const lm = new NoTokenizationLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1", adaptations: "refuse" });
  const [mixed] = boundaryRequest("mixed");
  await assert.rejects(lm.plan(mixed), refused("config.response_format"));
  await assert.rejects(lm.complete(mixed), refused("config.response_format"));
  const note = new NoTokenizationLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1" });
  await assert.rejects(note.plan(mixed, { policy: "refuse" }), refused("config.response_format"));
});

class ScoringTransport implements Transport {
  missingIds = false;
  scoringUsage: JsonObject | undefined;
  generatedUsage: JsonObject | undefined;
  generatedContent = '{"ok": false, "explanation": "ordinary answer", "extra": {"keep": [1, 2]}}';
  generatedFinish = "stop";
  readonly requests: TransportRequest[] = [];
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const payload = decode(request);
    if (request.url.endsWith("/tokenize")) {
      const messages = payload["messages"] as JsonObject[];
      const answer = messages[messages.length - 1]!["content"] as string;
      const tokens = [1];
      if (answer !== "Answer:") {
        tokens.push(answer.endsWith("true") ? 10 : 11);
        if (!payload["continue_final_message"]) tokens.push(99);
      }
      return new FakeResponse({ body: JSON.stringify({ tokens }) });
    }
    if (request.url.endsWith("/chat/completions")) {
      return new FakeResponse({ headers: [["x-request-id", "scoring-wire"]], body: JSON.stringify({ id: "generated", model: "m", usage: this.generatedUsage,
        choices: [{ index: 0, message: { role: "assistant", content: this.generatedContent }, finish_reason: this.generatedFinish }] }) });
    }
    assert.ok(request.url.endsWith("/completions"));
    const top = this.missingIds ? {} : Object.fromEntries((payload["logprob_token_ids"] as number[]).map(id => [`token_id:${id}`, -1]));
    return new FakeResponse({ body: JSON.stringify({ model: "m", usage: this.scoringUsage, choices: (payload["prompt"] as number[][]).map((_p, index) => ({ index, logprobs: { top_logprobs: [top] } })) }) });
  }
}

for (const [model, wireModel] of [["openai_chat:m", "m"], ["openai-chat:openai-chat:m", "openai-chat:m"]] as const) {
  for (const [mixed, missing] of [[false, false], [true, false], [true, true]]) {
    test(`scoring strips its own prefix once in every exchange (${model}, mixed=${mixed}, fallback=${missing})`, async () => {
      const original = mixed ? boundaryRequest("mixed")[0] : base;
      const request = Request.create({ ...original, model, config: { ...original.config, probabilities: missing ? "if_available" : "required" } });
      const transport = new ScoringTransport();
      transport.missingIds = missing!;
      const lm = new OpenAIChatLM({ apiKey: "synthetic-key", compat: "vllm", baseUrl: "http://scoring/v1", transport });
      await lm.plan(request);
      assert.equal(transport.requests.length, 0);
      await lm.complete(request);
      assert.equal(transport.requests.length, mixed || missing ? 7 : 6);
      assert.deepEqual([...new Set(transport.requests.map(r => decode(r)["model"]))], [wireModel]);
    });
  }
}

for (const policy of ["note", "silent", "refuse"] as const) {
  test(`pure offline plan and native complete have no adaptation (${policy})`, async () => {
    let credentials = 0;
    const transport = new ScoringTransport();
    const lm = new OpenAIChatLM({ apiKey: () => { credentials++; return "k"; }, compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
    const plan = await lm.plan(base);
    assert.equal(credentials, 0);
    assert.equal(transport.requests.length, 0);
    assert.deepEqual(plan, []);
    const response = await lm.complete(base);
    assert.deepEqual(response.adaptations, policy === "note" ? plan : []);
    assert.equal(response.dataPart?.method, "candidate_sequence_likelihood");
    assert.equal(transport.requests.length, 6);
    assert.deepEqual(await lm.plan(base), plan);
  });
}

async function collect(lm: OpenAIChatLM, request: Request) {
  const events = [];
  for await (const event of lm.stream(request)) events.push(event);
  return events;
}

for (const policy of ["note", "silent", "refuse"] as const) {
  test(`required scoring stream refuses before credentials (${policy})`, async () => {
    const transport = new FakeTransport([]);
    const lm = new OpenAIChatLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
    await assert.rejects(collect(lm, base), refused("config.probabilities"));
    assert.equal(transport.requests.length, 0);
  });
}

const streamBody = [
  { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: '{"ok": true}' }, finish_reason: null }] },
  { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";

for (const policy of ["note", "silent", "refuse"] as const satisfies readonly AdaptationPolicy[]) {
  test(`if_available stream is generated JSON with a visible drop (${policy})`, async () => {
    const request = Request.create({ ...base, config: { ...base.config, probabilities: "if_available" } });
    const transport = new FakeTransport([new FakeResponse({ body: streamBody, headers: [["content-type", "text/event-stream"]] })]);
    const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
    if (policy === "refuse") {
      await assert.rejects(collect(lm, request), refused("config.probabilities"));
      assert.equal(transport.requests.length, 0);
      return;
    }
    const events = await collect(lm, request);
    const start = events.find(event => event.type === "start");
    assert.ok(start?.type === "start");
    assert.deepEqual((start.adaptations ?? []).map(a => [a.field, a.action]), policy === "silent" ? [] : [["config.probabilities", "dropped"]]);
    assert.equal(transport.requests.length, 1);
    assert.ok(transport.requests[0]!.url.endsWith("/chat/completions"));
    const response = materializeResponse(events, request);
    assert.deepEqual(response.data, { ok: true });
    assert.equal(response.probabilities, undefined);
    assert.equal(response.dataPart?.method, undefined);
  });
}

test("ordinary generated JSON does not acquire scoring restrictions or extension protection", async () => {
  const [mixed] = boundaryRequest("mixed");
  const off = Request.create({ ...mixed, config: { ...mixed.config, probabilities: "off" } });
  const lm = new OpenAIChatLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1" });
  assert.deepEqual(await lm.plan(off), []);
  const plain = new OpenAIChatLM({ apiKey: "k" });
  const request = Request.create({ ...mixed, config: { ...mixed.config, probabilities: "if_available", extensions: { temperature: 0.25 } } });
  const payload = plain.payload(request, false);
  assert.deepEqual(((payload["response_format"] as JsonObject)["json_schema"] as JsonObject)["schema"], (request.config!.responseFormat as { schema: JsonObject }).schema);
  assert.equal(payload["temperature"], 0.25);
  assert.deepEqual((await plain.plan(request)).map(a => [a.field, a.action]), [["config.probabilities", "dropped"]]);
});

for (const policy of ["note", "silent"] as const) for (const missingIds of [false, true]) {
  test(`mixed preserves ordinary fields, one generation and usage (${policy}, missing=${missingIds})`, async () => {
    const [mixed] = boundaryRequest("mixed");
    const request = Request.create({ ...mixed, config: { ...mixed.config, probabilities: "if_available", temperature: 0.25 } });
    const transport = new ScoringTransport();
    transport.missingIds = missingIds;
    transport.scoringUsage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 99, completion_tokens_details: { reasoning_tokens: 2 } };
    transport.generatedUsage = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 30 };
    const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
    const plan = await lm.plan(request);
    assert.deepEqual(plan.map(a => [a.field, a.action]), [["config.response_format", "client_side"], ["config.temperature", "dropped"]]);
    const response = await lm.complete(request);
    assert.deepEqual(response.data, { ok: !missingIds, explanation: "ordinary answer", extra: { keep: [1, 2] } });
    assert.equal(response.id, "generated");
    assert.equal(response.finishReason, "stop");
    assert.equal(response.dataPart?.method, missingIds ? undefined : "candidate_sequence_likelihood");
    if (missingIds) assert.equal(response.probabilities, undefined);
    else assert.deepEqual(Object.keys(response.probabilities!), ["ok"]);
    assert.deepEqual(response.adaptations.map(a => [a.field, a.action]), policy === "silent" ? [] : [
      ...plan.map(a => [a.field, a.action]), ...(missingIds ? [["config.probabilities", "dropped"]] : []),
    ]);
    assert.deepEqual([response.usage.inputTokens, response.usage.outputTokens, response.usage.totalTokens], [18, 8, 129]);
    assert.equal(response.usage.reasoningTokens, undefined);
    assert.equal(response.usage.cacheReadTokens, undefined);
    assert.equal((response.providerData!["scoring_usage"] as JsonObject)["total_tokens"], 99);
    assert.equal(transport.requests.length, 7);
    assert.ok(transport.requests[5]!.url.endsWith("/completions"));
    assert.ok(transport.requests[6]!.url.endsWith("/chat/completions"));
    const payload = decode(transport.requests[6]!);
    assert.deepEqual(((payload["response_format"] as JsonObject)["json_schema"] as JsonObject)["schema"], (request.config!.responseFormat as { schema: JsonObject }).schema);
    assert.equal(payload["temperature"], 0.25);
    assert.equal(decode(transport.requests[5]!)["temperature"], 1);
  });
}

for (const missingIds of [false, true]) test(`mixed unknown scoring usage stays unknown (missing=${missingIds})`, async () => {
  const [mixed] = boundaryRequest("mixed");
  const request = Request.create({ ...mixed, config: { ...mixed.config, probabilities: "if_available" } });
  const transport = new ScoringTransport();
  transport.missingIds = missingIds;
  transport.generatedUsage = { prompt_tokens: 11, completion_tokens: 5 };
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport });
  const response = await lm.complete(request);
  assert.equal(response.usage.inputTokens, undefined);
  assert.equal(response.usage.outputTokens, undefined);
  assert.equal(response.usage.totalTokens, undefined);
});

for (const [content, finish] of [
  ['{"ok": false}', "stop"], ['{"ok":', "stop"], ['[]', "stop"],
  ['{"ok": false, "explanation": "cut"}', "length"], ['{"ok": false, "explanation": NaN}', "stop"],
]) test(`mixed malformed or incomplete reply refuses (${content}, ${finish})`, async () => {
  const [request] = boundaryRequest("mixed");
  const transport = new ScoringTransport();
  transport.generatedContent = content!;
  transport.generatedFinish = finish!;
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport });
  await assert.rejects(lm.complete(request), (error: unknown) => error instanceof ProviderError && error.provider === "openai-chat" && error.status === 200 && error.requestId === "scoring-wire");
  assert.equal(transport.requests.length, 7);
});

const harmfulControls: Array<[Config, string]> = [
  [{ store: false }, "config.store"], [{ userId: "safety" }, "config.user_id"],
  [{ serviceTier: "priority" }, "config.service_tier"], [{ cache: { mode: "off" } }, "config.cache.mode"],
  [{ cache: { retention: "long" } }, "config.cache.retention"],
  [{ extensions: { store: false } }, "config.extensions.store"], [{ extensions: { mystery: 1 } }, "config.extensions.mystery"],
];
for (const policy of ["note", "silent", "refuse"] as const) for (const [config, feature] of harmfulControls) {
  test(`unknown or harmful measurement controls refuse prewire (${policy}, ${feature})`, async () => {
    const request = Request.create({ ...base, config: { ...base.config, ...config } });
    const lm = new OpenAIChatLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1", adaptations: policy });
    await assert.rejects(lm.plan(request), refused(feature));
    await assert.rejects(lm.complete(request), refused(feature));
  });
}

test("ignored measurement hints are visible and strict refuses prewire", async () => {
  const request = Request.create({ ...base, config: { ...base.config, temperature: 0.2, maxTokens: 10, stop: ["end"], seed: 0, extensions: { top_p: 0.9 } } });
  const lm = new NoTokenizationLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1" });
  assert.deepEqual((await lm.plan(request)).map(a => [a.field, a.action]), ["max_tokens", "temperature", "stop", "seed", "extensions"].map(name => [`config.${name}`, "dropped"]));
  await assert.rejects(lm.plan(request, { policy: "refuse" }), refused("config.max_tokens"));
});

for (const [probabilities, policy] of [["required", "note"], ["if_available", "refuse"]] as const) {
  test(`missing IDs never generate when required or strict (${probabilities}, ${policy})`, async () => {
    const request = Request.create({ ...base, config: { ...base.config, probabilities } });
    const transport = new ScoringTransport();
    transport.missingIds = true;
    const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport, adaptations: policy });
    await assert.rejects(lm.complete(request), refused("config.probabilities"));
    assert.equal(transport.requests.length, 6);
    assert.ok(!transport.requests.some(r => r.url.endsWith("/chat/completions")));
  });
}

test("fallback cannot omit a required judgment", async () => {
  const [mixed] = boundaryRequest("mixed");
  const request = Request.create({ ...mixed, config: { ...mixed.config, probabilities: "if_available" } });
  const transport = new ScoringTransport();
  transport.missingIds = true;
  transport.generatedContent = '{"explanation": "ordinary only"}';
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport });
  await assert.rejects(lm.complete(request), (error: unknown) => error instanceof ProviderError && error.status === 200 && error.requestId === "scoring-wire");
  assert.equal(transport.requests.length, 7);
});

test("multiple judgments still use one batch and one generation", async () => {
  const fmt = judgments({ ok: yesNo("Fine?"), another: yesNo("Again?"), explanation: { type: "string" } });
  const request = Request.create({ ...base, config: { ...base.config, responseFormat: fmt } });
  const transport = new ScoringTransport();
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport });
  const response = await lm.complete(request);
  assert.deepEqual(response.data, { ok: true, another: true, explanation: "ordinary answer", extra: { keep: [1, 2] } });
  assert.deepEqual(Object.keys(response.probabilities!).sort(), ["another", "ok"]);
  assert.equal(transport.requests.length, 12);
  assert.equal((decode(transport.requests[10]!)["prompt"] as number[][]).length, 6);
  assert.equal((response.providerData!["judgments"] as JsonObject)["tokenize_calls"], 10);
});

test("opaque numeric n > 1 also refuses; n = 1 is not a multiple-output refusal", async () => {
  const lm = new OpenAIChatLM({ apiKey: forbidden, compat: "vllm", baseUrl: "http://scoring/v1" });
  const many = Request.create({ ...base, config: { ...base.config, extensions: { n: new RawNumber("2.0") } } });
  await assert.rejects(lm.plan(many), refused("config.extensions.n"));
  const one = Request.create({ ...base, config: { ...base.config, extensions: { n: 1 } } });
  assert.deepEqual((await lm.plan(one)).map(a => [a.field, a.action]), [["config.extensions", "dropped"]]);
});
