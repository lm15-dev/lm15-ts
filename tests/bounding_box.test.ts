/**
 * Bounding-box judgments (changes/2026-10-15-bounding-box.md), offline: the
 * schema convention, the helper, Jev's Box on the typesafe wire, the cloud
 * wires, and the token-trie driver that answers a box by generation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { TypeSafeLM } from "../src/dialects/typesafe.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import { BOX_EDGES, anthropicSchema, boundingBox, geminiSchema, judgments, judgmentsInSchema, measurableJudgments, yesNo } from "../src/judgments.ts";
import { RawNumber, type JsonObject } from "../src/json.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import type { TransportRequest } from "../src/wire.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";

installNodePlatform();

const decode = (req: TransportRequest) => JSON.parse(new TextDecoder().decode(req.body)) as JsonObject;
const header = (req: TransportRequest) => req.headers.find(([k]) => k === "TypeSafe-Danger-Zone-Images")?.[1];
const PHOTO = [Message.user({ type: "image", data: "iVBORw0KGgo=", mediaType: "image/png" })];
const FIND = judgments({ mug: boundingBox("the coffee mug"), mug_visible: yesNo("Is there a coffee mug in the image?") });
const BOX_ONLY = judgments({ mug: boundingBox("the coffee mug") });

test("the helper emits four described numbers, all required, and no bounds (Anthropic refuses them)", () => {
  const prop = boundingBox("the coffee mug");
  assert.equal(prop["type"], "object");
  assert.equal(prop["description"], "the coffee mug");
  assert.deepEqual(Object.keys(prop["properties"] as JsonObject), ["top", "bottom", "left", "right"]);
  assert.deepEqual([...BOX_EDGES], ["top", "bottom", "left", "right"]);
  assert.deepEqual(prop["required"], ["top", "bottom", "left", "right"]);
  assert.equal(prop["additionalProperties"], false);
  for (const edge of Object.values(prop["properties"] as JsonObject)) {
    const e = edge as JsonObject;
    assert.equal(e["type"], "number");
    assert.match(e["description"] as string, /fraction/);
    assert.equal("minimum" in e || "maximum" in e, false);
  }
  assert.throws(() => boundingBox(3 as unknown as string), TypeError);
});

test("a box is read by its shape and declares no keys; near misses are ordinary output", () => {
  const found = judgmentsInSchema(FIND.schema);
  assert.deepEqual([...found.values()].map((j) => [j.name, j.kind, j.keys, j.instruction]), [
    ["mug", "box", [], "the coffee mug"],
    ["mug_visible", "boolean", ["true", "false"], "Is there a coffee mug in the image?"],
  ]);
  assert.deepEqual([...measurableJudgments(found).keys()], ["mug_visible"]);
  const edge = { type: "number" };
  const all = (s: JsonObject) => ({ top: s, bottom: s, left: s, right: s });
  const read = judgmentsInSchema({ type: "object", properties: {
    hand_written: { properties: { left: edge, top: edge, right: edge, bottom: edge } },
    bounded: { type: "object", properties: all({ type: "number", minimum: 0, maximum: 1 }) },
    extra_edge: { type: "object", properties: { ...all(edge), label: { type: "string" } } },
    integer_edges: { type: "object", properties: all({ type: "integer" }) },
    three_edges: { type: "object", properties: { top: edge, bottom: edge, left: edge } },
    array: { type: "array", properties: all(edge) },
    pixels: { type: "object", properties: { x: edge, y: edge, w: edge, h: edge } },
  } });
  assert.deepEqual(Object.fromEntries([...read].map(([n, j]) => [n, j.kind])), { hand_written: "box", bounded: "box" });
  // The rewriting wires leave a box untouched.
  assert.deepEqual((anthropicSchema(FIND.schema, found)["properties"] as JsonObject)["mug"], (FIND.schema["properties"] as JsonObject)["mug"]);
  assert.deepEqual((geminiSchema(FIND.schema, found)["properties"] as JsonObject)["mug"], (FIND.schema["properties"] as JsonObject)["mug"]);
});

test("typesafe sends a Box question (no criteria) with the opt-in header, even with no image", async () => {
  const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([]) });
  const built = await lm.build({ model: "jev-preview", messages: PHOTO, config: { responseFormat: FIND } }, false);
  assert.deepEqual(decode(built.request)["questions"], {
    mug: { type: "box", instructions: "the coffee mug" },
    mug_visible: { type: "noul", instructions: "Is there a coffee mug in the image?" },
  });
  assert.equal(header(built.request), "true");
  assert.deepEqual(built.adaptations, []);
  const textOnly = await lm.build({ model: "jev-preview", messages: [Message.user("a kitchen")], config: { responseFormat: BOX_ONLY } }, false);
  assert.equal(header(textOnly.request), "true");
  assert.equal("assets" in decode(textOnly.request), false);
  const unnamed = { type: "object", properties: { top: { type: "number" }, bottom: { type: "number" }, left: { type: "number" }, right: { type: "number" } } };
  const defaulted = await lm.build({ model: "jev-preview", messages: [Message.user("a kitchen")], config: { responseFormat: judgments({ mug: unnamed }) } }, false);
  assert.deepEqual((decode(defaulted.request)["questions"] as JsonObject)["mug"], { type: "box", instructions: "mug" });
  assert.deepEqual(defaulted.adaptations.map((a) => [a.field, a.action]), [["config.response_format.schema.properties.mug.description", "defaulted"]]);
});

const reply = (answers: unknown) => new FakeResponse({ body: JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 290, output_tokens: 21 } }) });

test("typesafe answers the box verbatim with no distribution; Jev's confidence stays in providerData", async () => {
  const box = { top: 0.25, bottom: 0.82, left: 0.44, right: 1 };
  const answers = { mug: { type: "box", box, confidence: 0.92 }, mug_visible: { type: "noul", noul: 0.97 } };
  const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([reply(answers)]) });
  const r = await lm.complete({ model: "jev-preview", messages: PHOTO, config: { responseFormat: FIND, probabilities: "required" } });
  assert.deepEqual(JSON.parse(JSON.stringify(r.data)), { mug: box, mug_visible: true });
  assert.deepEqual(Object.keys(r.probabilities!), ["mug_visible"]);
  assert.equal(r.dataPart?.method, "provider_classification");
  const kept = ((r.providerData!["typesafe"] as JsonObject)["answers"] as JsonObject)["mug"] as JsonObject;
  assert.equal(Number(kept["confidence"]), 0.92);
  const only = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([reply({ mug: answers.mug })]) });
  const boxes = await only.complete({ model: "jev-preview", messages: PHOTO, config: { responseFormat: BOX_ONLY, probabilities: "required" } });
  assert.deepEqual(JSON.parse(JSON.stringify(boxes.data)), { mug: box });
  assert.equal(boxes.probabilities, undefined);
  assert.equal(boxes.dataPart?.method, undefined);
  // Numbers as written: the edge is the lexeme Jev sent.
  const edge = ((boxes.data as JsonObject)["mug"] as JsonObject)["right"];
  assert.equal(edge instanceof RawNumber ? edge.raw : String(edge), "1");
});

test("typesafe refuses a malformed box as a provider fault", async () => {
  for (const [box, where] of [
    [{ top: 0.1, bottom: 0.2, left: 0.3 }, "answers.mug.box"],
    [{ top: 0.1, bottom: 0.2, left: 0.3, right: 0.4, x: 0 }, "answers.mug.box"],
    [{ top: 0.1, bottom: 1.2, left: 0.3, right: 0.4 }, "answers.mug.box.bottom"],
    [{ top: "0.1", bottom: 0.2, left: 0.3, right: 0.4 }, "answers.mug.box.top"],
    [[0.1, 0.2, 0.3, 0.4], "answers.mug.box"],
  ] as const) {
    const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([reply({ mug: { type: "box", box } })]) });
    await assert.rejects(lm.complete({ model: "jev-preview", messages: PHOTO, config: { responseFormat: BOX_ONLY } }),
      (e: unknown) => e instanceof ProviderError && e.message.includes(where));
  }
  const wrong = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([reply({ mug: { type: "noul", noul: 0.5 } })]) });
  await assert.rejects(wrong.complete({ model: "jev-preview", messages: PHOTO, config: { responseFormat: BOX_ONLY } }),
    (e: unknown) => e instanceof ProviderError && e.message.includes("answers.mug.type"));
});

test("cloud wires send the box verbatim; the probabilities policy concerns only keyed judgments", async () => {
  const req = { model: "m", messages: PHOTO, config: { responseFormat: FIND, maxTokens: 200 } };
  const a = await new AnthropicLM({ apiKey: "k", transport: new FakeTransport([]) }).build(req, false);
  const aSchema = ((decode(a.request)["output_config"] as JsonObject)["format"] as JsonObject)["schema"] as JsonObject;
  assert.deepEqual((aSchema["properties"] as JsonObject)["mug"], (FIND.schema["properties"] as JsonObject)["mug"]);
  const g = await new GeminiLM({ apiKey: "k", transport: new FakeTransport([]) }).build(req, false);
  const gSchema = (decode(g.request)["generationConfig"] as JsonObject)["responseJsonSchema"] as JsonObject;
  assert.deepEqual((gSchema["properties"] as JsonObject)["mug"], (FIND.schema["properties"] as JsonObject)["mug"]);
  const chat = new OpenAIChatLM({ apiKey: "k", transport: new FakeTransport([]) });
  for (const probabilities of ["if_available", "required"] as const) {
    assert.deepEqual(await chat.plan({ model: "m", messages: PHOTO, config: { responseFormat: BOX_ONLY, probabilities } }), []);
  }
  await assert.rejects(chat.plan({ model: "m", messages: PHOTO, config: { responseFormat: FIND, probabilities: "required" } }),
    (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.probabilities");
  const recorded = await chat.plan({ model: "m", messages: PHOTO, config: { responseFormat: FIND, probabilities: "if_available" } });
  assert.deepEqual(recorded.map((x) => [x.field, x.action]), [["config.probabilities", "dropped"]]);
});

/** A vLLM-like server: /tokenize, one scoring /v1/completions, and the generated-JSON /chat/completions. */
class ScoringServer implements Transport {
  readonly requests: TransportRequest[] = [];
  private readonly generated: string;
  constructor(generated: string) {
    this.generated = generated;
  }
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const payload = decode(request);
    if (request.url.endsWith("/tokenize")) {
      const messages = payload["messages"] as { content: string }[];
      const answer = messages[messages.length - 1]!.content;
      const tokens = [100, ...answer.split(" ").map((w) => (w === "Answer:" ? 1 : w.charCodeAt(0)))];
      if (!payload["continue_final_message"]) tokens.push(999);
      return new FakeResponse({ body: JSON.stringify({ tokens }) });
    }
    if (request.url.endsWith("/v1/completions")) {
      const prompts = payload["prompt"] as number[][];
      const ids = payload["logprob_token_ids"] as number[];
      const top: Record<string, number> = {};
      for (const id of ids) top[`token_id:${id}`] = id === "true".charCodeAt(0) ? Math.log(0.9) : Math.log(0.05);
      return new FakeResponse({ body: JSON.stringify({ model: "lfm", choices: prompts.map((_p, index) => ({ index, logprobs: { top_logprobs: [top] } })), usage: { prompt_tokens: 40, completion_tokens: prompts.length } }) });
    }
    return new FakeResponse({ body: JSON.stringify({ id: "g", model: "lfm", choices: [{ index: 0, message: { role: "assistant", content: this.generated }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  }
}

test("token trie: the yes/no is measured, the box is generated beside it; boxes only take the ordinary path", async () => {
  const box = { top: 0.2, bottom: 0.6, left: 0.55, right: 0.85 };
  const server = new ScoringServer(JSON.stringify({ mug: box, mug_visible: false }));
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: server });
  const req = { model: "lfm", messages: [Message.user("a kitchen")], config: { responseFormat: FIND, probabilities: "required" as const } };
  assert.deepEqual((await lm.plan(req)).map((a) => [a.field, a.action]), [["config.response_format", "client_side"]]);
  const r = await lm.complete(req);
  assert.deepEqual(JSON.parse(JSON.stringify((r.data as JsonObject)["mug"])), box);
  assert.equal((r.data as JsonObject)["mug_visible"], true); // measured, overriding the generated pick
  assert.deepEqual(Object.keys(r.probabilities!), ["mug_visible"]);
  assert.equal(r.dataPart?.method, "candidate_sequence_likelihood");
  const urls = server.requests.map((t) => t.url.split("/").pop());
  assert.equal(urls.filter((u) => u === "completions").length, 2);
  // A box missing from the generated answer is a malformed reply, never a guess.
  const missing = new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: new ScoringServer(JSON.stringify({ mug_visible: false })) });
  await assert.rejects(missing.complete(req), (e: unknown) => e instanceof ProviderError && /mug/.test(e.message));
  // Boxes only: nothing to measure, one ordinary generated call.
  const only = new ScoringServer(JSON.stringify({ mug: box }));
  const plain = await new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: only }).complete({ ...req, config: { responseFormat: BOX_ONLY, probabilities: "required" } });
  assert.deepEqual(JSON.parse(JSON.stringify(plain.data)), { mug: box });
  assert.equal(plain.probabilities, undefined);
  assert.deepEqual(only.requests.map((t) => t.url.split("/").slice(-2).join("/")), ["chat/completions"]);
});
