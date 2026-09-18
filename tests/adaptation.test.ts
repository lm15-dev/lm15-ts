/**
 * MAP-13 (adapt freely, never invisibly) and what rides with it: the
 * mechanism, the three policies, `plan()`, the record on `Response` and on
 * the stream's start event, the client-side stop with score preservation
 * (2026-09-15), the router's switch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptationScope, adapt, collecting, nearestEffort } from "../src/adaptation.ts";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import { RawNumber, stringifyJson } from "../src/json.ts";
import { applyClientSideStop, scoresBeforeCut, truncateStreamAtStop } from "../src/stop.ts";
import { materializeResponse, responseToEvents } from "../src/stream.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { Response } from "../src/types/response.ts";
import { StreamEvent, type TextDelta } from "../src/types/stream.ts";
import { LMRouter } from "../src/router.ts";
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

const user = (text: string) => [Message.user(text)];

test("the scope: adapt() records under note, throws under refuse (deviations only), and is a no-op outside a scope", () => {
  const note = new AdaptationScope("note", "p");
  collecting(note, () => {
    adapt("config.seed", "dropped", "no seed field", { asked: 7 });
    adapt("config.max_tokens", "defaulted", "required", { applied: 16384 });
  });
  assert.deepEqual(note.records.map((a) => [a.field, a.action, a.asked, a.applied]), [["config.seed", "dropped", 7, undefined], ["config.max_tokens", "defaulted", undefined, 16384]]);

  const refuse = new AdaptationScope("refuse", "p");
  assert.throws(
    () => collecting(refuse, () => adapt("config.seed", "dropped", "no seed field", { asked: 7 })),
    (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.seed" && e.provider === "p" && /adaptations='refuse'/.test(e.message),
  );
  // satisfied / defaulted change nothing the caller asked for: recorded, never refused.
  collecting(refuse, () => adapt("config.store", "satisfied", "nothing kept", { asked: false }));
  assert.equal(refuse.records.length, 1);

  // "silent" still records into the scope (behaviour is read from the record); the LM hides it on the response.
  const silent = new AdaptationScope("silent", "p");
  collecting(silent, () => adapt("config.stop", "client_side", "cut after the wire", { asked: ["x"], applied: ["x"] }));
  assert.equal(silent.records.length, 1);

  // No scope: nothing recorded, nothing thrown (a bare payload() call, a unit test).
  adapt("config.seed", "dropped", "no seed field", { asked: 7 });

  // Nested scopes are independent and the outer one is restored.
  const outer = new AdaptationScope("note", "o");
  collecting(outer, () => {
    collecting(new AdaptationScope("note", "i"), () => adapt("inner", "dropped", "r"));
    adapt("outer", "dropped", "r");
  });
  assert.deepEqual(outer.records.map((a) => a.field), ["outer"]);

  // The synchronous discipline is checked: an async build would share the slot across awaits.
  assert.throws(() => collecting(new AdaptationScope("note", "p"), () => Promise.resolve(1)), TypeError);
});

test("nearestEffort: the closest level on the ordinal ladder; a tie goes to the cheaper level", () => {
  assert.equal(nearestEffort("medium", ["low", "high", "max"]), "low");
  assert.equal(nearestEffort("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(nearestEffort("minimal", ["low", "medium"]), "low");
  assert.equal(nearestEffort("high", ["low", "high"]), "high");
});

test("complete(): the record rides Response.adaptations under note, is empty under silent, and refuse throws before the wire with feature", async () => {
  const body = JSON.stringify({ id: "msg_1", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  const request = { model: "claude-sonnet-4-5", messages: user("hi"), config: { seed: 7, temperature: 1.5, store: false } };
  const note = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body })]) });
  const response = await note.complete(request);
  // A record keeps its field's JSON type: the clamped temperature is the float 1.0, never the integer 1.
  assert.deepEqual(
    response.adaptations.map((a) => [a.field, a.action, a.asked, a.applied instanceof RawNumber ? a.applied.raw : a.applied]),
    [["config.max_tokens", "defaulted", undefined, 16384], ["config.seed", "dropped", 7, undefined], ["config.temperature", "clamped", 1.5, "1.0"], ["config.store", "satisfied", false, undefined]],
  );
  assert.ok(stringifyJson(response.toJSON()).includes('"applied":1.0'));
  assert.equal(response.toJSON()["adaptations"] !== undefined, true);

  const silentTransport = new FakeTransport([new FakeResponse({ body })]);
  const silent = new AnthropicLM({ apiKey: "k", transport: silentTransport, adaptations: "silent" });
  assert.deepEqual((await silent.complete(request)).adaptations, []);
  // "silent" changed nothing on the wire: the clamp still happened.
  const sent = JSON.parse(new TextDecoder().decode(silentTransport.requests[0]!.body)) as { temperature: number; seed?: number };
  assert.equal(sent.temperature, 1.0);
  assert.equal("seed" in sent, false);

  const refuse = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([]), adaptations: "refuse" });
  await assert.rejects(refuse.complete(request), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.seed");
  // A strict user who set no max_tokens is not refused for the wire's required field being filled.
  const strictOk = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body })]), adaptations: "refuse" });
  const r = await strictOk.complete({ model: "claude-sonnet-4-5", messages: user("hi") });
  assert.deepEqual(r.adaptations.map((a) => a.action), ["defaulted"]);
});

test("plan(): the full record with no network and no credential invoked; under silent too; throws what the call would", async () => {
  let invoked = 0;
  const lm = new AnthropicLM({
    apiKey: () => { invoked++; return "k"; },
    transport: new FakeTransport([]),
    adaptations: "silent",
  });
  const plan = await lm.plan({ model: "claude-sonnet-4-5", messages: user("hi"), config: { seed: 7 } });
  assert.deepEqual(plan.map((a) => a.field), ["config.max_tokens", "config.seed"]);
  assert.equal(invoked, 0);
  await assert.rejects(lm.plan({ model: "claude-sonnet-4-5", messages: user("hi"), config: { seed: 7 } }, { policy: "refuse" }), UnsupportedFeatureError);
  // A refusal under any policy still refuses: the program depends on it (rule 4b).
  await assert.rejects(
    lm.plan({ model: "claude-sonnet-4-5", messages: user("hi"), config: { cache: { resource: "cache_1" } } }),
    (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.cache.resource",
  );
});

test("stream(): the visible record rides the start event and the materialized Response; silent hides both", async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const request = { model: "claude-sonnet-4-5", messages: user("hi"), config: { seed: 7, maxTokens: 10 } };
  const lm = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body: sse, headers: [["content-type", "text/event-stream"]] })]) });
  const events = [];
  for await (const e of lm.stream(request)) events.push(e);
  assert.equal(events[0]!.type, "start");
  assert.deepEqual((events[0] as { adaptations?: readonly { field: string }[] }).adaptations?.map((a) => a.field), ["config.seed"]);
  const response = materializeResponse(events, request);
  assert.deepEqual(response.adaptations.map((a) => a.field), ["config.seed"]);
  // The start event's canonical JSON carries the list; a replay reproduces it.
  assert.equal(Array.isArray(StreamEvent.toJSON(events[0]!)["adaptations"]), true);
  assert.deepEqual(materializeResponse(responseToEvents(response), request).adaptations, response.adaptations);

  const silent = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ body: sse, headers: [["content-type", "text/event-stream"]] })]), adaptations: "silent" });
  const first = (await silent.stream(request)[Symbol.asyncIterator]().next()).value as { adaptations?: unknown };
  assert.equal(first.adaptations, undefined);
});

test("client-side stop (Responses wire): complete() streams under the hood, cuts at the first sequence, closes the source, reports no usage", async () => {
  const frames = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"one two "}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"STOP three"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","status":"completed","usage":{"input_tokens":5,"output_tokens":9}}}\n\n',
  ];
  const source = new FakeResponse({ chunks: frames.map((f) => new TextEncoder().encode(f)), headers: [["content-type", "text/event-stream"]] });
  const transport = new FakeTransport([source]);
  const lm = new OpenAILM({ apiKey: "k", transport });
  const response = await lm.complete({ model: "gpt-5", messages: user("count"), config: { stop: ["STOP"] } });
  assert.equal(response.text, "one two ");
  assert.equal(response.finishReason, "stop");
  assert.deepEqual(response.usage, {}); // the final frame was never read: not reported, never estimated
  assert.deepEqual(response.adaptations.map((a) => [a.field, a.action]), [["config.stop", "client_side"]]);
  assert.equal(source.cancelled, true);
  // The wire request carried no stop field and was a stream.
  const sent = JSON.parse(new TextDecoder().decode(transport.requests[0]!.body)) as { stop?: unknown; stream: boolean };
  assert.equal(sent.stop, undefined);
  assert.equal(sent.stream, true);
  // A stream that never hits the sequence completes normally, usage included.
  const whole = new OpenAILM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ chunks: frames.map((f) => new TextEncoder().encode(f)), headers: [["content-type", "text/event-stream"]] })]) });
  const full = await whole.complete({ model: "gpt-5", messages: user("count"), config: { stop: ["NEVER"] } });
  assert.equal(full.text, "one two STOP three");
  assert.equal(full.usage.outputTokens, 9);
});

test("scores after a cut: whole tokens before the cut keep their scores; a token the cut lands inside loses its score and marks coverage incomplete", () => {
  const scores = [{ token: "hi ", logprob: -0.25 }, { token: "pre", logprob: -0.5 }, { token: "fix", logprob: -0.75 }];
  assert.deepEqual(scoresBeforeCut(scores, "hi prefix", 3), [[scores[0]], false]); // cut on a boundary
  assert.deepEqual(scoresBeforeCut(scores, "hi prefix", 5), [[scores[0]], true]); // cut inside "pre"
  assert.deepEqual(scoresBeforeCut(scores, "hi prefix", 9), [scores, false]);
  assert.deepEqual(scoresBeforeCut(scores, "different text", 3), [[], true]); // no alignment: no score survives
  // Byte alignment: a multi-byte character split across tokens is placed by bytes, not spellings —
  // the first token lies wholly before the cut and keeps its score; the second straddles it.
  const bytes = [{ token: "", logprob: -0.1, bytes: [0xe2, 0x82] }, { token: "", logprob: -0.2, bytes: [0xac, 0x21] }];
  assert.deepEqual(scoresBeforeCut(bytes, "€!", 1), [[bytes[0]], true]);

  const response = new Response({ model: "m", message: { role: "assistant", parts: [{ type: "text", text: "hi prefix END tail" }] }, finishReason: "length", logprobs: scores });
  const cut = applyClientSideStop(response, ["END"]);
  assert.equal(cut.text, "hi prefix ");
  assert.equal(cut.finishReason, "stop");
  assert.equal(cut.logprobsComplete, false); // "hi prefix " is longer than the scored tokens: no alignment for the tail
  assert.equal(cut.logprobs, undefined);
  assert.equal(cut.toJSON()["logprobs_complete"], false);
  const aligned = new Response({ model: "m", message: { role: "assistant", parts: [{ type: "text", text: "hi prefix" }] }, finishReason: "stop", logprobs: scores });
  const onBoundary = applyClientSideStop(aligned, ["prefix"]);
  assert.deepEqual(onBoundary.logprobs, [scores[0]]);
  assert.equal(onBoundary.logprobsComplete, true);
  // A sequence spanning two text parts is a hit; the later part is removed.
  const spanning = new Response({ model: "m", message: { role: "assistant", parts: [{ type: "text", text: "ab" }, { type: "text", text: "cd" }] }, finishReason: "stop" });
  assert.deepEqual(applyClientSideStop(spanning, ["bc"]).message.parts.map((p) => (p as TextDelta).text), ["a"]);
});

test("the stream cutter holds a possible suffix, never splits scores to release text earlier, and ends with a stop", () => {
  const events = [
    StreamEvent.create({ type: "start", model: "m" }),
    StreamEvent.create({ type: "delta", delta: { type: "text", text: "one ", logprobs: [{ token: "one ", logprob: -0.1 }] } }),
    StreamEvent.create({ type: "delta", delta: { type: "text", text: "twoST", logprobs: [{ token: "two", logprob: -0.2 }, { token: "ST", logprob: -0.3 }] } }),
    StreamEvent.create({ type: "delta", delta: { type: "text", text: "OP three" } }),
    StreamEvent.create({ type: "end", finishReason: "length", usage: { outputTokens: 4 } }),
  ];
  const out = [...truncateStreamAtStop(events, ["STOP"])];
  assert.deepEqual(out.map((e) => e.type), ["start", "delta", "delta", "end"]);
  const second = (out[2] as { delta: TextDelta }).delta;
  assert.equal(second.text, "two");
  assert.deepEqual(second.logprobs, [{ token: "two", logprob: -0.2 }]);
  assert.equal(second.logprobsComplete, undefined); // cut on a token boundary: complete
  assert.deepEqual(out[3], { type: "end", finishReason: "stop" });
  // Unmatched: every event passes untouched, usage included.
  const untouched = [...truncateStreamAtStop(events, ["NEVER"])];
  assert.deepEqual(untouched, events);
});

test("Response ⇄ events keeps logprobs_complete=false; a false with no text part refuses to stream", () => {
  const r = new Response({ model: "m", message: { role: "assistant", parts: [{ type: "text", text: "hi pre" }] }, finishReason: "stop", logprobs: [{ token: "hi ", logprob: -0.25 }], logprobsComplete: false });
  const back = materializeResponse(responseToEvents(r), { model: "m", messages: user("x") });
  assert.equal(back.logprobsComplete, false);
  assert.deepEqual(back.logprobs, r.logprobs);
  const noText = new Response({ model: "m", message: { role: "assistant", parts: [{ type: "tool_call", id: "c", name: "f", input: {} }] }, finishReason: "tool_call", logprobsComplete: false });
  assert.throws(() => responseToEvents(noText), TypeError);
});

test("router: RouterConfig.adaptations reaches every LM it builds; router.plan() previews the route", async () => {
  const router = new LMRouter({ apiKeys: { anthropic: "k", openai: "k" }, adaptations: "refuse", transport: new FakeTransport([]) });
  await assert.rejects(router.complete({ model: "anthropic:claude-sonnet-4-5", messages: user("hi"), config: { seed: 7 } }), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.seed");
  const noting = new LMRouter({ apiKeys: { anthropic: "k", openai: "k" }, transport: new FakeTransport([]) });
  const plan = await noting.plan({ model: "openai:gpt-5", messages: user("hi"), config: { topK: 3, stop: ["x"] } });
  assert.deepEqual(plan.map((a) => [a.field, a.action]), [["config.stop", "client_side"], ["config.top_k", "dropped"]]);
});

test("the chat wire under a compat that ignores a form: none and an allowlist go client-side, required refuses (rule 4b)", async () => {
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "zai", transport: new FakeTransport([]) });
  const tools = [{ type: "function" as const, name: "a" }, { type: "function" as const, name: "b" }];
  const narrowed = await lm.build({ model: "glm-5", messages: user("hi"), tools, config: { toolChoice: { allowed: ["a"] } } }, false);
  const sent = JSON.parse(new TextDecoder().decode(narrowed.request.body)) as { tools: { function: { name: string } }[]; tool_choice: string };
  assert.deepEqual(sent.tools.map((t) => t.function.name), ["a"]);
  assert.equal(sent.tool_choice, "auto");
  assert.deepEqual(narrowed.adaptations.map((a) => [a.field, a.action, a.applied]), [["config.tool_choice.allowed", "client_side", ["a"]]]);
  const none = await lm.build({ model: "glm-5", messages: user("hi"), tools, config: { toolChoice: { mode: "none" } } }, false);
  assert.equal("tools" in (JSON.parse(new TextDecoder().decode(none.request.body)) as object), false);
  await assert.rejects(lm.build({ model: "glm-5", messages: user("hi"), tools, config: { toolChoice: { mode: "required" } } }, false), (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === "config.tool_choice.mode");
});
