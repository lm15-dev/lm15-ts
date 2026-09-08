import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseStream, StreamAccumulator, coalesceStream, materializeResponse, parseSse, splitLines } from "../src/stream.ts";
import { StreamAssemblyError, RateLimitError } from "../src/errors.ts";
import { Request } from "../src/types/config.ts";
import { Message } from "../src/types/parts.ts";
import type { StreamEvent } from "../src/types/stream.ts";
import { Usage } from "../src/types/response.ts";

const request = Request.create({ model: "m", messages: [Message.user("hi")] });

test("MAP-3: many adapter end events merge into one final end; a bare terminator never overwrites", () => {
  const events: StreamEvent[] = [
    { type: "start", id: "r1", model: "m" },
    { type: "delta", delta: { type: "text", text: "a", partIndex: 0 } },
    { type: "end", finishReason: "tool_call", providerData: { f: 1 } },
    { type: "end", usage: Usage.create({ inputTokens: 1, outputTokens: 2 }), providerData: { u: 1 } },
    { type: "end" }, // [DONE]
  ];
  const out = [...coalesceStream(events, { model: "m" })];
  assert.equal(out.filter((e) => e.type === "end").length, 1);
  const end = out[out.length - 1] as StreamEvent & { type: "end" };
  assert.equal(end.finishReason, "tool_call");
  assert.equal(end.usage?.totalTokens, 3);
  assert.deepEqual(end.providerData, { u: 1 }); // D9: the usage frame wins over the finish frame
});

test("MAP-4: a dialect without a start frame gets one synthesized start; errors never force one", () => {
  const out = [...coalesceStream([{ type: "delta", delta: { type: "text", text: "a", partIndex: 0 } }, { type: "end" }], { model: "m" })];
  assert.deepEqual(out[0], { type: "start", model: "m" });
  const errOnly = [...coalesceStream([{ type: "error", error: { code: "server", message: "x" } }], { model: "m" })];
  assert.equal(errOnly.length, 1);
  assert.equal(errOnly[0]!.type, "error");
  // no end seen → none fabricated
  assert.deepEqual([...coalesceStream([{ type: "delta", delta: { type: "text", text: "a", partIndex: 0 } }])].map((e) => e.type), ["start", "delta"]);
});

test("MAP-9: an unnamed tool call is refused with the partial response; a missing id is minted", () => {
  const acc = new StreamAccumulator(request);
  acc.push({ type: "delta", delta: { type: "text", text: "hello", partIndex: 0 } });
  acc.push({ type: "delta", delta: { type: "tool_call", input: '{"a":', partIndex: 1, id: "c1" } });
  acc.push({ type: "delta", delta: { type: "tool_call", input: "1}", partIndex: 1 } });
  acc.push({ type: "end", finishReason: "tool_call" });
  assert.throws(
    () => acc.response(),
    (e: unknown) => e instanceof StreamAssemblyError && e.partIndex === 1 && e.partial?.text === "hello" && e.partial.finishReason === "tool_call",
  );
  const named = new StreamAccumulator(request);
  named.push({ type: "delta", delta: { type: "tool_call", input: '{"a":1}', partIndex: 0, name: "f" } });
  named.push({ type: "end" });
  const r = named.response();
  assert.equal(r.toolCalls[0]?.id, "tool_call_0");
  assert.deepEqual(r.toolCalls[0]?.input, { a: 1 });
  assert.equal(r.finishReason, "tool_call"); // rule 5: None becomes tool_call when a call was assembled
});

test("assembly: slots emit in the fixed kind order; continuation state rides every part of its slot", () => {
  const acc = new StreamAccumulator(request);
  acc.push({ type: "delta", delta: { type: "tool_call", input: "{}", partIndex: 0, name: "f" } });
  acc.push({ type: "delta", delta: { type: "text", text: "t", partIndex: 0 } });
  acc.push({ type: "delta", delta: { type: "thinking", text: "th", partIndex: 0 } });
  acc.push({ type: "delta", delta: { type: "continuation", provider: "gemini", kind: "thought_signature", data: { value: "s" }, partIndex: 0 } });
  acc.push({ type: "delta", delta: { type: "continuation", provider: "openai", kind: "x", data: {} } });
  acc.push({ type: "end", finishReason: "stop" });
  const r = acc.response();
  assert.deepEqual(r.message.parts.map((p) => p.type), ["thinking", "text", "tool_call"]);
  assert.equal(r.message.parts[0]?.continuation?.[0]?.kind, "thought_signature");
  assert.equal(r.message.continuation?.[0]?.provider, "openai");
  assert.equal(r.finishReason, "tool_call"); // a provider stop next to an assembled call becomes tool_call
});

test("a slot with only continuation state emits an empty text part carrying it (MAP-9 rule 4)", () => {
  const acc = new StreamAccumulator(request);
  acc.push({ type: "delta", delta: { type: "continuation", provider: "anthropic", kind: "redacted_thinking", data: { data: "x" }, partIndex: 2 } });
  acc.push({ type: "end", finishReason: "stop" });
  const r = acc.response();
  assert.deepEqual(r.message.parts[0], { type: "text", text: "", continuation: [{ provider: "anthropic", kind: "redacted_thinking", data: { data: "x" } }] });
});

test("ResponseStream yields text as it arrives and then the same Response", async () => {
  const events: StreamEvent[] = [
    { type: "start", model: "m" },
    { type: "delta", delta: { type: "text", text: "he", partIndex: 0 } },
    { type: "delta", delta: { type: "text", text: "llo", partIndex: 0 } },
    { type: "end", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  const rs = new ResponseStream(events, request);
  const chunks: string[] = [];
  for await (const t of rs) chunks.push(t);
  assert.deepEqual(chunks, ["he", "llo"]);
  const r = await rs.response();
  assert.equal(r.text, "hello");
  assert.deepEqual(r, materializeResponse(events, request));
});

test("a stream error event becomes the typed exception at the point it arrives", async () => {
  const rs = new ResponseStream([{ type: "error", error: { code: "rate_limit", message: "slow down", providerCode: "429" } }], request);
  await assert.rejects(rs.response(), (e: unknown) => e instanceof RateLimitError && e.providerCode === "429");
});

test("SSE parsing: multi-line data, comments, event names, CRLF", () => {
  const body = new TextEncoder().encode("event: ping\r\ndata: a\r\ndata: b\r\n\r\n: comment\ndata: [DONE]\n\n");
  const events = [...parseSse(splitLines(body))];
  assert.deepEqual(events, [{ event: "ping", data: "a\nb" }, { data: "[DONE]" }]);
});
