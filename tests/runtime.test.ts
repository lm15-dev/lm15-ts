import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { Config, Request, Message, Delta, Usage, RawNumber, toJSON, stringifyJson, parseJson, Response, StreamEvent, ResponseStream, responseToEvents, materializeResponse, OpenAILM, AnthropicLM, GeminiLM, OpenAIChatLM, ValueError } from "../src/index.ts";
import { FetchTransport } from "../src/transport.ts";
import { TransportError } from "../src/errors.ts";
import { FakeLM, FakeResponse, FakeTransport } from "../src/testing.ts";
import type { TransportRequest } from "../src/wire.ts";

const req = Request.create({ model: "m", messages: [Message.user("hi")] });
const wire: TransportRequest = { method: "GET", url: "https://example.invalid/", headers: [], body: new Uint8Array() };
const text = (s: string, index = 0) => StreamEvent.create({ type: "delta", delta: { type: "text", text: s, partIndex: index } });
const end = StreamEvent.create({ type: "end", finishReason: "stop" });

// These cases exercise public entry points, not just the contract shim.
test("generic serde preserves type identity; plain ambiguous objects require an explicit kind", () => {
  const d = Delta.create({ type: "text", text: "hello", partIndex: 7 });
  assert.deepEqual(toJSON(d), { type: "text", text: "hello", part_index: 7 });
  assert.deepEqual(toJSON(Config.create({ maxTokens: 8 })), { max_tokens: 8 });
  assert.deepEqual(toJSON(Usage.empty), {});
  assert.deepEqual(toJSON(Usage.create({})), {});
  assert.deepEqual(toJSON(Usage.create({ cacheReadTokens: 2 })), { cache_read_tokens: 2 });
  assert.throws(() => toJSON({ type: "text", text: "hello" }), /kind/);
  assert.deepEqual(toJSON({ ...d }, "delta"), Delta.toJSON(d));
  assert.throws(() => toJSON({}, "toString"), ValueError);
  assert.deepEqual(Reflect.ownKeys(d), ["type", "text", "partIndex"]);
});

test("typed integer fields and computed totals never silently round", () => {
  assert.throws(() => Usage.fromJSON(parseJson('{"input_tokens":9007199254740993}') as never), /exact integer/);
  assert.throws(() => Usage.create({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), /exact integer/);
  assert.equal(Usage.create({ inputTokens: Number.MAX_SAFE_INTEGER }).inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(Usage.fromJSON({ input_tokens: new RawNumber("2.0") }).inputTokens, 2);
  const opaque = parseJson('{"count":9007199254740993}');
  assert.equal(stringifyJson(opaque), '{"count":9007199254740993}');
});

test("direct providers validate before touching credentials or the transport", async () => {
  for (const LM of [OpenAILM, AnthropicLM, GeminiLM, OpenAIChatLM]) {
    let credentialCalls = 0;
    const lm = new LM({ apiKey: () => { credentialCalls++; return "fake"; }, transport: new FakeTransport() });
    await assert.rejects(lm.buildRequest({ ...req, config: { maxTokens: -1 } }, false), ValueError);
    await assert.rejects(lm.complete({ ...req, tools: [{ type: "function", name: "x" }, { type: "function", name: "x" }] }), /duplicate/);
    await assert.rejects(async () => { for await (const _ of lm.stream({ ...req, messages: [] })) {} }, /message/);
    await assert.rejects(lm.complete(req, { signal: AbortSignal.abort() }), TransportError);
    assert.equal(credentialCalls, 0);
  }
});

test("early text/event iteration pauses; response drains the source and closes it", async () => {
  for (const mode of ["text", "events"] as const) {
    let closed = false;
    async function* source() { try { yield text("a"); yield text("b"); yield end; } finally { closed = true; } }
    const rs = new ResponseStream(source(), req);
    if (mode === "text") { for await (const _ of rs) break; }
    else { for await (const _ of rs.events()) break; }
    assert.equal(closed, false);
    const response = await rs.response();
    assert.equal(response.text, "ab");
    assert.equal(closed, true);
    assert.equal(await rs.response(), response);
  }
});

test("breaking on end still materializes and finalizes; explicit close never returns a partial response", async () => {
  let finalized = 0;
  async function* source() { try { yield text("a"); yield end; } finally { finalized++; } }
  const rs = new ResponseStream(source(), req);
  for await (const event of rs.events()) if (event.type === "end") break;
  assert.equal((await rs.response()).text, "a");
  assert.equal(finalized, 1);
  const abandoned = new ResponseStream(source(), req);
  for await (const _ of abandoned) break;
  await abandoned.close();
  await abandoned.close();
  assert.equal(finalized, 2);
  await assert.rejects(abandoned.response(), /closed/);
});

test("ResponseStream refuses concurrent readers and remembers failure", async () => {
  const rs = new ResponseStream([text("a"), end], req);
  const reader = rs.events();
  await reader.next();
  await assert.rejects(rs.response(), /active reader/);
  await reader.return(undefined);
  assert.equal((await rs.response()).text, "a");
  let finalized = false;
  async function* failed() { try { yield StreamEvent.create({ type: "error", error: { code: "rate_limit", message: "slow" } }); } finally { finalized = true; } }
  const bad = new ResponseStream(failed(), req);
  await assert.rejects(bad.response(), /slow/);
  await assert.rejects(bad.response(), /slow/);
  assert.ok(finalized);
});

test("responseToEvents preserves replay state, logprobs, tools and provider data", () => {
  const response = new Response({
    model: "m", id: "r", finishReason: "tool_call", usage: { inputTokens: 2, outputTokens: 3 },
    message: Message.create({ role: "assistant", continuation: [{ provider: "openai", kind: "response_id", data: { id: "r" } }], parts: [
      { type: "text", text: "hello", continuation: [{ provider: "openai", kind: "opaque", data: { n: new RawNumber("9007199254740993") } }] },
      { type: "tool_call", id: "t", name: "weather", input: { city: "Oslo" } },
    ] }), logprobs: [{ token: "hello", logprob: -0.5 }], providerData: { original: true },
  });
  const assembled = materializeResponse(responseToEvents(response), req);
  assert.deepEqual(Response.toJSON(assembled, { includeProviderData: true }), Response.toJSON(response, { includeProviderData: true }));
  const refusal = response.with({ message: Message.assistant({ type: "refusal", text: "no" }) });
  assert.throws(() => responseToEvents(refusal), /no Delta variant/);
});

test("FetchTransport never sends a pre-aborted request", async () => {
  let calls = 0;
  const transport = new FetchTransport({ fetch: async () => { calls++; return new globalThis.Response("ok"); } });
  await assert.rejects(transport.send(wire, { signal: AbortSignal.abort() }), TransportError);
  assert.equal(calls, 0);
});

test("FetchTransport cancels early body exit and unused responses", async () => {
  let cancelled = 0;
  const transport = new FetchTransport({ fetch: async () => new globalThis.Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled++; } })) });
  const res = await transport.send(wire);
  for await (const _ of res.chunks()) break;
  assert.equal(cancelled, 1);
  await assert.rejects(res.bytes(), /already been consumed/);
  const unused = await transport.send(wire);
  await unused.cancel!();
  assert.equal(cancelled, 2);
});

test("FetchTransport bounds header and idle waits, including custom fetch/read implementations", { timeout: 2000 }, async () => {
  const hangingHead = new FetchTransport({ headersTimeoutMs: 15, fetch: () => new Promise(() => {}) });
  await assert.rejects(hangingHead.send(wire), TransportError);
  let cancelled = false;
  const hangingBody = new FetchTransport({ readTimeoutMs: 15, fetch: async () => new globalThis.Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects((await hangingBody.send(wire)).bytes(), TransportError);
  assert.ok(cancelled);
});

test("idle deadline restarts per read and does not time consumer work", { timeout: 2000 }, async () => {
  let count = 0;
  const transport = new FetchTransport({ readTimeoutMs: 100, fetch: async () => new globalThis.Response(new ReadableStream<Uint8Array>({
    async pull(c) { await new Promise(r => setTimeout(r, 10)); if (++count <= 3) c.enqueue(new Uint8Array([count])); else c.close(); },
  })) });
  const out: number[] = [];
  for await (const chunk of (await transport.send(wire)).chunks()) { out.push(...chunk); await new Promise(r => setTimeout(r, 120)); }
  assert.deepEqual(out, [1, 2, 3]);
});

test("abort interrupts a pending body read and cancels the source", { timeout: 2000 }, async () => {
  let cancelled = false;
  const controller = new AbortController();
  const transport = new FetchTransport({ fetch: async () => new globalThis.Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const res = await transport.send(wire, { signal: controller.signal });
  const reading = res.bytes();
  controller.abort();
  await assert.rejects(reading, TransportError);
  assert.ok(cancelled);
});

test("real platform fetch closes an abandoned local HTTP stream", { timeout: 5000 }, async (t) => {
  let notifyClosed!: () => void;
  const closed = new Promise<void>(resolve => { notifyClosed = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    res.once("close", notifyClosed);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const res = await new FetchTransport().send({ ...wire, url: `http://127.0.0.1:${address.port}/` });
  for await (const _ of res.chunks()) break;
  await closed;
});

test("test doubles support canonical and real adapter paths", async () => {
  const fake = new FakeLM(["hello", "streamed", new Error("scripted")]);
  assert.equal((await fake.complete(req)).text, "hello");
  assert.equal((await new ResponseStream(fake.stream(req), req).response()).text, "streamed");
  await assert.rejects(fake.complete(req), /scripted/);
  assert.equal(fake.requests.length, 3);
  const transport = new FakeTransport([new FakeResponse({ body: JSON.stringify({ id: "r", model: "m", choices: [{ message: { role: "assistant", content: "wire" }, finish_reason: "stop" }] }) })]);
  assert.equal((await new OpenAIChatLM({ apiKey: "fake", transport }).complete(req)).text, "wire");
  assert.equal(transport.requests.length, 1);
  const oneShot = new FakeResponse({ body: "once" });
  await oneShot.bytes();
  await assert.rejects(oneShot.bytes(), /already been consumed/);
  const cancelled = new FakeResponse();
  await cancelled.cancel();
  await assert.rejects(cancelled.bytes(), /cancelled/);
});
