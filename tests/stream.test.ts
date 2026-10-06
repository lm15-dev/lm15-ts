import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseStream, StreamAccumulator, coalesceStream, materializeResponse, parseSse, parseSseAsync, splitLines, splitLinesAsync } from "../src/stream.ts";
import { StreamAssemblyError, RateLimitError, TransportError } from "../src/errors.ts";
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

// ─── INV-056: no default SSE size limit; linear line splitting ───────

test("INV-056: a line over the former 64 KiB / 1 MiB limits parses by default", async () => {
  const text = "x".repeat(3 * 1024 * 1024);
  const body = new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify({ text })}\n\n`);
  const sync = [...parseSse(splitLines(body))];
  assert.equal(sync.length, 1);
  assert.equal(JSON.parse(sync[0]!.data).text, text);
  async function* chunks() {
    for (let i = 0; i < body.length; i += 16 * 1024) yield body.subarray(i, i + 16 * 1024);
  }
  const events = [];
  for await (const event of parseSseAsync(splitLinesAsync(chunks()))) events.push(event);
  assert.deepEqual(events, sync);
});

test("INV-056: caps are opt-in and still refuse", () => {
  const line = new TextEncoder().encode("data: too long\n");
  assert.throws(() => [...parseSse([line], { maxLineBytes: 4 })], (e: unknown) => e instanceof TransportError && /SSE line exceeds limit/.test((e as Error).message));
  const lines = [new TextEncoder().encode("data: 1\n"), new TextEncoder().encode("data: 2\n")];
  assert.throws(() => [...parseSse(lines, { maxEventBytes: 8 })], (e: unknown) => e instanceof TransportError && /SSE event exceeds limit/.test((e as Error).message));
});

test("INV-056: splitLinesAsync matches a plain split for any chunking", async () => {
  let seed = 56;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pieces = ["a", "\n", "bc", "\r\n", "\n\n", "data: {}\n", "z".repeat(300)];
  for (let trial = 0; trial < 300; trial++) {
    let text = "";
    for (let k = rand(40); k > 0; k--) text += pieces[rand(pieces.length)];
    const body = new TextEncoder().encode(text);
    const cuts = [...new Set(Array.from({ length: rand(10) }, () => rand(body.length + 1)))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, body.length];
    async function* chunks() {
      for (let i = 0; i + 1 < bounds.length; i++) yield body.subarray(bounds[i]!, bounds[i + 1]!);
    }
    const got: string[] = [];
    for await (const line of splitLinesAsync(chunks())) got.push(new TextDecoder().decode(line));
    const parts = text.split("\n");
    const want = [...parts.slice(0, -1).map((p) => p + "\n"), ...(parts[parts.length - 1] ? [parts[parts.length - 1]!] : [])];
    assert.deepEqual(got, want);
    assert.deepEqual([...splitLines(body)].map((l) => new TextDecoder().decode(l)), want);
  }
});

test("INV-056: a 30 MB line in 16 KiB reads splits in linear time", async () => {
  const body = new Uint8Array(30 * 1024 * 1024 + 2).fill(0x61);
  body[body.length - 2] = 0x0a;
  body[body.length - 1] = 0x0a;
  async function* chunks() {
    for (let i = 0; i < body.length; i += 16 * 1024) yield body.subarray(i, i + 16 * 1024);
  }
  const started = performance.now();
  const lines = [];
  for await (const line of splitLinesAsync(chunks())) lines.push(line.length);
  // The old splitter re-merged and rescanned the pending line on every read
  // (about 1,900 reads x 15 MB here): tens of seconds. Linear is well under 2 s.
  assert.deepEqual(lines, [body.length - 1, 1]);
  assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`);
});
