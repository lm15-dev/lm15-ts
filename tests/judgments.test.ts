/**
 * MAP-14 judgments: the schema convention (read and emitted), the two wire
 * rewrites, the DataPart answer with its accessors, `config.probabilities`
 * on a wire that measures nothing, the typesafe provider, and the
 * token-trie driver (candidate-sequence likelihood) end to end through a
 * fake server — the honoured path and the silently-absent path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { TypeSafeLM } from "../src/dialects/typesafe.ts";
import { foldJudgment, keyPaths, trieNodes } from "../src/dialects/token_trie.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import { anthropicSchema, choice, geminiSchema, judgments, judgmentsInSchema, score, yesNo } from "../src/judgments.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { Response } from "../src/types/response.ts";
import type { JsonObject } from "../src/json.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import type { TransportRequest } from "../src/wire.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";

installNodePlatform();

const user = (text: string) => [Message.user(text)];
const decode = (req: TransportRequest) => JSON.parse(new TextDecoder().decode(req.body)) as JsonObject;

test("the helpers emit the convention and judgmentsInSchema reads it back; anything else is ordinary output", () => {
  const fmt = judgments({
    mood: choice("How does the note read?", { happy: "Upbeat", sad: null }),
    style: choice("Style?", ["fruit", "oak"]),
    ok: yesNo("Is it fine?"),
    quality: score("How good?", { poor: "Bad", fine: "Okay", great: "Great" }),
  });
  assert.equal(fmt["type"], "json_schema");
  const found = judgmentsInSchema((fmt as { schema: JsonObject }).schema);
  assert.deepEqual([...found.keys()], ["mood", "style", "ok", "quality"]);
  assert.deepEqual(found.get("mood")!.keys, ["happy", "sad"]);
  assert.equal(found.get("mood")!.descriptions["happy"], "Upbeat");
  assert.equal(found.get("style")!.kind, "choice");
  assert.equal(found.get("ok")!.kind, "boolean");
  assert.equal(found.get("quality")!.kind, "ordered");
  assert.deepEqual(found.get("quality")!.keys, ["0", "1", "2"]);
  assert.equal(found.get("quality")!.titles["1"], "fine");
  // Not a judgment: a free string, an integer enum not 0..n-1, a one-level ordered set, a typed mismatch.
  const none = judgmentsInSchema({ type: "object", properties: { city: { type: "string" }, n: { type: "integer", enum: [1, 2] }, one: { type: "integer", enum: [0] }, odd: { type: "integer", enum: ["a"] } } });
  assert.equal(none.size, 0);
  assert.throws(() => score("x", ["only one"]), /at least two/);
  assert.throws(() => choice("x", []), /at least one/);
});

test("the two wire rewrites are translations, never recorded: Anthropic moves type into anyOf branches; Gemini folds anyOf into enum + description", () => {
  const fmt = judgments({ quality: score("How good?", { poor: "Bad", great: "Great" }), style: choice("Style?", { fruit: "Fruity", oak: null }), ok: yesNo("Fine?") });
  const schema = (fmt as { schema: JsonObject }).schema;
  const found = judgmentsInSchema(schema);
  const a = anthropicSchema(schema, found)["properties"] as Record<string, JsonObject>;
  assert.equal("type" in a["quality"]!, false);
  assert.deepEqual((a["quality"]!["anyOf"] as JsonObject[]).map((b) => b["type"]), ["integer", "integer"]);
  assert.equal(a["ok"]!["type"], "boolean");
  const g = geminiSchema(schema, found)["properties"] as Record<string, JsonObject>;
  assert.deepEqual(g["quality"]!["enum"], [0, 1]);
  assert.equal(g["quality"]!["description"], "How good? Levels: 0 = poor: Bad; 1 = great: Great");
  assert.deepEqual(g["style"]!["enum"], ["fruit", "oak"]);
  assert.equal(g["style"]!["description"], "Style? Options: fruit = Fruity; oak");
  assert.equal("anyOf" in g["style"]!, false);
  // The original schema is untouched (INV-050 verbatim elsewhere).
  assert.equal("anyOf" in (schema["properties"] as Record<string, JsonObject>)["quality"]!, true);
});

test("a cloud wire answers a judgment request with a DataPart; probabilities policy: if_available records dropped, required refuses before the wire", async () => {
  const fmt = judgments({ style: choice("Style?", ["fruit", "oak"]), ok: yesNo("Fine?") });
  const body = JSON.stringify({ id: "msg_1", model: "claude-sonnet-4-5", content: [{ type: "text", text: '{"style": "oak", "ok": true}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  const lm = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body })]) });
  const response = await lm.complete({ model: "claude-sonnet-4-5", messages: user("note"), config: { maxTokens: 50, responseFormat: fmt, probabilities: "if_available" } });
  assert.deepEqual(response.data, { style: "oak", ok: true });
  assert.equal(response.dataPart?.type, "data");
  assert.equal(response.probabilities, undefined);
  assert.equal(response.text, undefined);
  assert.deepEqual(response.adaptations.map((a) => [a.field, a.action, a.asked]), [["config.probabilities", "dropped", "if_available"]]);
  await assert.rejects(
    lm.plan({ model: "claude-sonnet-4-5", messages: user("note"), config: { maxTokens: 50, responseFormat: fmt, probabilities: "required" } }),
    (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.probabilities",
  );
  // A schema with no judgment is ordinary structured output: TextPart as before, no record.
  const plain = new GeminiLM({ apiKey: "k", transport: new FakeTransport([]) });
  const plan = await plain.plan({ model: "gemini-2.5-flash", messages: user("x"), config: { responseFormat: { type: "json_schema", schema: { type: "object", properties: { city: { type: "string" } } } }, probabilities: "required" } });
  assert.deepEqual(plan, []);
});

test("Response.expected(): Σ p·i over an ordered judgment, computed, never stored", () => {
  const r = new Response({
    model: "m",
    message: { role: "assistant", parts: [{ type: "data", value: { q: 7 }, probabilities: { q: { "0": 0.0, "1": 0.25, "2": 0.75 }, style: { a: 1 } }, method: "provider_classification" }] },
    finishReason: "stop",
  });
  assert.equal(r.expected("q"), 1.75);
  assert.equal(r.expected("missing"), undefined);
  assert.throws(() => r.expected("style"), /ordered levels/);
});

test("typesafe: refusals name the feature; a judgment without a description is defaulted to its name; the answer folds into one DataPart", async () => {
  const lm = new TypeSafeLM({ apiKey: "k", transport: new FakeTransport([]) });
  const fmt = judgments({ refund: { type: "boolean" } });
  const built = await lm.build({ model: "jev-latest", messages: user("I want my money back"), config: { responseFormat: fmt } }, false);
  assert.deepEqual(decode(built.request)["questions"], { refund: { type: "noul", instructions: "refund" } });
  assert.deepEqual(built.adaptations.map((a) => [a.field, a.action, a.applied]), [["config.response_format.schema.properties.refund.description", "defaulted", "refund"]]);
  await assert.rejects(lm.build({ model: "jev-latest", messages: user("x") }, false), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.response_format");
  await assert.rejects(lm.build({ model: "jev-latest", messages: user("x"), tools: [{ type: "function", name: "t" }], config: { responseFormat: fmt } }, false), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "tools");
  await assert.rejects(lm.build({ model: "jev-latest", messages: user("x"), config: { responseFormat: fmt } }, true), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "stream");
  // A data part is the state verbatim; a conversation becomes the messages object (D6).
  const data = await lm.build({ model: "jev-latest", messages: [Message.user([{ type: "data", value: { ticket: 12 } }])], config: { responseFormat: fmt } }, false);
  assert.deepEqual(decode(data.request)["state"], { ticket: 12 });
  const convo = await lm.build({ model: "jev-latest", system: "Be fair.", messages: [Message.user("a"), Message.assistant("b")], config: { responseFormat: fmt } }, false);
  assert.deepEqual(decode(convo.request)["state"], { system: "Be fair.", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
});

test("token trie (pure): key paths after the prefill are prefix-free; nodes are every prefix; the fold sums log-probs and normalizes once", () => {
  const prefix = [1, 2];
  const keys = new Map<string, readonly [number[], number[]]>([
    ["yes", [[1, 2, 10], [1, 2, 10, 99]]],
    ["no", [[1, 2, 11, 12], [1, 2, 11, 12, 99]]],
  ]);
  const paths = keyPaths(prefix, keys);
  assert.deepEqual([...paths.entries()], [["yes", [10, 99]], ["no", [11, 12, 99]]]);
  const nodes = trieNodes(paths);
  assert.deepEqual([...nodes.keys()], ["", "10", "11", "11,12"]);
  assert.deepEqual([...nodes.get("")!.children], [10, 11]);
  const table = new Map([
    ["", new Map([[10, Math.log(0.6)], [11, Math.log(0.3)]])],
    ["10", new Map([[99, Math.log(1.0)]])],
    ["11", new Map([[12, Math.log(0.5)]])],
    ["11,12", new Map([[99, Math.log(1.0)]])],
  ]);
  const { distribution, coverage } = foldJudgment(paths, table);
  assert.ok(Math.abs(coverage - 0.75) < 1e-9); // 0.6 + 0.3·0.5
  assert.ok(Math.abs(distribution["yes"]! - 0.8) < 1e-9);
  assert.ok(Math.abs(distribution["no"]! - 0.2) < 1e-9);
  assert.throws(() => keyPaths([1, 2], new Map([["x", [[9, 9], [9, 9, 1]]]])), UnsupportedFeatureError);
  assert.throws(() => keyPaths([1, 2], new Map([["x", [[1, 2], [1, 2]]]])), UnsupportedFeatureError);
});

/** A vLLM-shaped server: /tokenize by a fixed vocabulary; /v1/completions scoring every node the same way. */
class TrieServer implements Transport {
  readonly requests: TransportRequest[] = [];
  private readonly honoursIds: boolean;
  private readonly scores: Record<string, number>;
  constructor(honoursIds: boolean, scores: Record<string, number>) {
    this.honoursIds = honoursIds;
    this.scores = scores;
  }
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const payload = decode(request);
    if (request.url.endsWith("/tokenize")) {
      const messages = payload["messages"] as { role: string; content: string }[];
      const answer = messages[messages.length - 1]!.content;
      const tokens = [100, ...answer.split(" ").map((w) => (w === "Answer:" ? 1 : w.charCodeAt(0)))];
      if (!payload["continue_final_message"]) tokens.push(999);
      return new FakeResponse({ body: JSON.stringify({ tokens }) });
    }
    if (request.url.endsWith("/v1/completions")) {
      const prompts = payload["prompt"] as number[][];
      const ids = payload["logprob_token_ids"] as number[];
      const choices = prompts.map((_p, index) => {
        const top: Record<string, number> = {};
        if (this.honoursIds) for (const id of ids) top[`token_id:${id}`] = this.scores[String(id)] ?? Math.log(0.01);
        return { index, logprobs: { top_logprobs: [top] } };
      });
      return new FakeResponse({ body: JSON.stringify({ model: "lfm", choices, usage: { prompt_tokens: 40, completion_tokens: prompts.length } }) });
    }
    // The structured-output fallback (the silently-absent path).
    return new FakeResponse({ body: JSON.stringify({ id: "c", model: "lfm", choices: [{ index: 0, message: { role: "assistant", content: '{"ok": true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  }
}

test("token-trie driver: one scoring call over every node, a distribution with coverage; a server that drops logprob_token_ids falls back (if_available) or refuses (required)", async () => {
  const fmt = judgments({ ok: yesNo("Is it fine?") });
  const yes = "true".charCodeAt(0), no = "false".charCodeAt(0), end = 999;
  const server = new TrieServer(true, { [yes]: Math.log(0.7), [no]: Math.log(0.2), [end]: Math.log(0.9) });
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: server });
  const request = { model: "lfm", messages: user("Looks fine to me"), config: { responseFormat: fmt, probabilities: "if_available" as const } };
  const response = await lm.complete(request);
  assert.equal(response.dataPart?.method, "candidate_sequence_likelihood");
  assert.deepEqual(response.data, { ok: true });
  const dist = response.probabilities!["ok"]!;
  assert.ok(Math.abs(dist["true"]! - 0.7 / 0.9) < 1e-9); // 0.7·0.9 vs 0.2·0.9, one normalisation
  assert.ok(Math.abs((response.providerData!["coverage"] as Record<string, number>)["ok"]! - 0.81) < 1e-9);
  assert.deepEqual(response.adaptations.map((a) => [a.field, a.action]), [["config.response_format", "client_side"]]);
  // 1 prefill + 2 keys × 2 tokenizations = 5 tokenize calls, then exactly one scoring call.
  assert.deepEqual(server.requests.map((r) => r.url.split("/").pop()), ["tokenize", "tokenize", "tokenize", "tokenize", "tokenize", "completions"]);
  const scoring = decode(server.requests[5]!);
  assert.equal(scoring["max_tokens"], 1);
  assert.deepEqual(scoring["logprob_token_ids"], [yes, no, end].sort((a, b) => a - b));
  assert.equal(response.usage.inputTokens, 40);

  const dropping = new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: new TrieServer(false, {}) });
  const fallback = await dropping.complete(request);
  assert.deepEqual(fallback.data, { ok: true });
  assert.equal(fallback.probabilities, undefined);
  assert.deepEqual(fallback.adaptations.map((a) => [a.field, a.action]), [["config.probabilities", "dropped"]]);
  await assert.rejects(
    new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: new TrieServer(false, {}) }).complete({ ...request, config: { ...request.config, probabilities: "required" } }),
    (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.probabilities",
  );
  // Without a probabilities policy the trie is never engaged: plain structured output, one call.
  const off = new TrieServer(true, {});
  const plain = await new OpenAIChatLM({ apiKey: "k", compat: "vllm", transport: off }).complete({ ...request, config: { responseFormat: fmt } });
  assert.deepEqual(plain.data, { ok: true });
  assert.equal(off.requests.length, 1);
});
