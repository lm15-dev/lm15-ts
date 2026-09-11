// Contract 2026-09-11-stream-completion-and-error-metadata: strict stream
// completion, a complete Response never withheld, HTTP error metadata from
// headers. The Python suite pins the same cases
// (tests/test_error_metadata_and_completion.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Message, OpenAIChatLM, RateLimitError, Request, ResponseStream, StreamAssemblyError, StreamEvent,
  TransportError, coalesceStreamAsync, materializeResponse, materializeResponseAsync,
} from "../src/index.ts";
import { REQUEST_ID_HEADERS, attachErrorMetadata, retryAfterSeconds } from "../src/adapter.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { HttpResponse } from "../src/wire.ts";

const req = Request.create({ model: "m", messages: [Message.user("hi")] });
const start = StreamEvent.create({ type: "start" });
const text = (s: string) => StreamEvent.create({ type: "delta", delta: { type: "text", text: s, partIndex: 0 } });
const end = StreamEvent.create({ type: "end", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 } });
const complete = [start, text("ok"), end];

/** A source that can fail while draining (after its events) or on return(). */
function source(events: StreamEvent[], opts: { drainError?: unknown; returnError?: unknown } = {}) {
  const state = { returned: 0 };
  const it: AsyncIterableIterator<StreamEvent> = {
    [Symbol.asyncIterator]() { return it; },
    async next() {
      if (events.length > 0) return { done: false, value: events.shift()! };
      if (opts.drainError !== undefined) { const e = opts.drainError; opts.drainError = undefined; throw e; }
      return { done: true, value: undefined };
    },
    async return() {
      state.returned++;
      if (opts.returnError !== undefined) throw opts.returnError;
      return { done: true, value: undefined };
    },
  };
  return { it, state };
}

function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const listener = (w: Error) => { seen.push(w.name); };
  process.on("warning", listener);
  return run().then(
    () => new Promise<string[]>((resolve) => setImmediate(() => { process.off("warning", listener); resolve(seen); })),
    (e) => { process.off("warning", listener); throw e; },
  );
}

test("a stream exhausted without an end event is a StreamAssemblyError carrying partial, in every wrapper", async () => {
  for (const wrapper of ["one-shot", "response-stream", "coalesced"]) {
    const { it, state } = source([start, text("partial")]);
    const events = wrapper === "coalesced" ? coalesceStreamAsync(it) : it;
    const run = wrapper === "response-stream" ? () => new ResponseStream(events, req).response() : () => materializeResponseAsync(events, req);
    await assert.rejects(run, (e: unknown) => e instanceof StreamAssemblyError && /without an end event/.test(e.message) && e.partial?.text === "partial", wrapper);
    if (wrapper !== "coalesced") assert.equal(state.returned, 1, wrapper);
  }
  assert.throws(() => materializeResponse([start, text("partial")], req), (e: unknown) => e instanceof StreamAssemblyError && e.partial?.text === "partial");
});

test("an event after the end event is refused (MAP-3), never merged or dropped", async () => {
  const late = [start, end, text("late")];
  assert.throws(() => materializeResponse([...late], req), (e: unknown) => e instanceof StreamAssemblyError && /after its end event/.test(e.message) && e.partial?.finishReason === "stop");
  const { it, state } = source([...late]);
  const rs = new ResponseStream(it, req);
  await assert.rejects(() => rs.response(), (e: unknown) => e instanceof StreamAssemblyError && /after its end event/.test(e.message));
  assert.equal(state.returned, 1);
});

test("a failure after the end event never withholds the Response: warning + cleanupErrors", async () => {
  for (const where of ["drain", "return"] as const) {
    const failure = new TransportError("connection reset after [DONE]");
    const { it, state } = source([...complete], where === "drain" ? { drainError: failure } : { returnError: failure });
    const rs = new ResponseStream(it, req);
    let response;
    const warned = await captureWarnings(async () => { response = await rs.response(); });
    assert.equal(response!.text, "ok", where);
    assert.equal(response!.usage.totalTokens, 3, where);
    assert.equal(response!.finishReason, "stop", where);
    assert.deepEqual(rs.cleanupErrors, [failure], where);
    assert.deepEqual(warned, ["StreamCleanupWarning"], where);
    assert.equal(state.returned, 1, where);
    // Reading again neither re-warns nor re-closes.
    assert.equal((await rs.response()).text, "ok");
    assert.equal(rs.cleanupErrors.length, 1);
  }
});

test("under the coalescer a raw read failure before EOF is BEFORE completion: it keeps its class", async () => {
  // The coalescer emits its merged end only once the raw source is exhausted
  // (MAP-3); the terminal frames may be incomplete, so this is not a
  // post-completion failure and nothing is warned.
  const failure = new TransportError("reset before EOF");
  const { it } = source([...complete], { drainError: failure });
  const rs = new ResponseStream(coalesceStreamAsync(it), req);
  const warned = await captureWarnings(async () => {
    await assert.rejects(() => rs.response(), (e: unknown) => e === failure);
  });
  assert.deepEqual(warned, []);
});

test("a cleanup failure never replaces the primary failure; it rides along as cleanupErrors", async () => {
  const primary = new TransportError("read failed");
  const cleanup = new Error("return failed");
  const { it } = source([start], { drainError: primary, returnError: cleanup });
  const rs = new ResponseStream(it, req);
  await assert.rejects(() => rs.response(), (e: unknown) => e === primary && (e as { cleanupErrors?: unknown[] }).cleanupErrors?.[0] === cleanup);
});

test("HTTP diagnostics: request id from headers when the body has none; invalid retry hints are dropped", async () => {
  for (const header of REQUEST_ID_HEADERS) {
    const resp = new FakeResponse({ status: 429, body: '{"error":{"type":"rate_limit_error","message":"wait"}}', headers: [[header.toUpperCase(), "request-1"], ["Retry-After", "3"]] });
    const lm = new OpenAIChatLM({ apiKey: "k", transport: new FakeTransport([resp]) });
    await assert.rejects(() => lm.complete(req), (e: unknown) => e instanceof RateLimitError && e.requestId === "request-1" && e.retryAfter === 3 && e.status === 429, header);
  }
  for (const invalid of ["nan", "inf", "Infinity", "-1", "bad", Number.POSITIVE_INFINITY, Number.NaN, true]) {
    assert.equal(retryAfterSeconds(invalid), undefined, String(invalid));
    const error = new RateLimitError("wait", { retryAfter: invalid as never });
    attachErrorMetadata(error, new HttpResponse({ status: 429, headers: [["retry-after", "3"]], body: new Uint8Array() }));
    assert.equal(error.retryAfter, 3, String(invalid));
  }
  // A body value wins; absent in both stays absent.
  const body = new RateLimitError("wait", { retryAfter: 0, requestId: "body-id" });
  attachErrorMetadata(body, new HttpResponse({ status: 429, headers: [["retry-after", "3"], ["x-request-id", "header-id"]], body: new Uint8Array() }));
  assert.equal(body.retryAfter, 0);
  assert.equal(body.requestId, "body-id");
  const empty = new RateLimitError("wait");
  attachErrorMetadata(empty, new HttpResponse({ status: 429, headers: [], body: new Uint8Array() }));
  assert.equal(empty.retryAfter, null);
  assert.equal(empty.requestId, null);
});

// api-family 2026-09-11: a compat preset name supplies its server's address; never the cloud's.
test("lmstudio is ollama's policy at LM Studio's own address; the Responses door knows the local roots", async () => {
  const { OpenAILM, OpenAIChatLM, OPENAI_CHAT_PRESETS, OPENAI_RESPONSES_PRESETS } = await import("../src/index.ts");
  assert.equal(OPENAI_CHAT_PRESETS["lmstudio"], OPENAI_CHAT_PRESETS["ollama"]);
  assert.equal(OPENAI_RESPONSES_PRESETS["lmstudio"], OPENAI_RESPONSES_PRESETS["ollama"]);
  for (const name of ["lmstudio", "lm-studio", "LM Studio"]) {
    assert.equal(new OpenAIChatLM({ apiKey: "k", compat: name }).baseUrl, "http://localhost:1234/v1", name);
    assert.equal(new OpenAILM({ apiKey: "k", compat: name }).baseUrl, "http://localhost:1234/v1", name);
  }
  for (const [name, url] of Object.entries({ ollama: "http://localhost:11434/v1", vllm: "http://localhost:8000/v1", sglang: "http://localhost:30000/v1", openai: "https://api.openai.com/v1", responses: "https://api.openai.com/v1" })) {
    assert.equal(new OpenAILM({ apiKey: "k", compat: name }).baseUrl, url, name);
  }
});

test("a named server with no known address is refused, never sent to the OpenAI cloud", async () => {
  const { OpenAILM, OpenAIChatLM, NotConfiguredError } = await import("../src/index.ts");
  const cases: Array<[new (o: { apiKey: string; compat: string; baseUrl?: string }) => { baseUrl: string }, string]> = [
    [OpenAIChatLM, "qwen"], [OpenAIChatLM, "bedrock"], [OpenAILM, "deepseek"], [OpenAILM, "zai"],
  ];
  for (const [Cls, name] of cases) {
    assert.throws(() => new Cls({ apiKey: "k", compat: name }), (e: unknown) => e instanceof NotConfiguredError && /pass baseUrl/.test((e as Error).message), name);
    assert.equal(new Cls({ apiKey: "k", compat: name, baseUrl: "http://gateway.internal/v1" }).baseUrl, "http://gateway.internal/v1", name);
  }
});

// AUTH-1 shared explicit keys (spec/auth.md, ratified 2026-09-09) and the OpenAI-shaped door.
test("router: an explicit openai key serves openai-chat; ambiguity and unknown providers are refused", async () => {
  const { LMRouter, NotConfiguredError, apiKeysSource, explainAuth, openaiChatModelString, UnknownModelError } = await import("../src/index.ts");
  assert.equal(apiKeysSource({ apiKeys: { openai: "k" } }, "openai-chat"), "openai");
  assert.equal(apiKeysSource({ apiKeys: { openai_chat: "k" } }, "openai"), "openai_chat");
  assert.equal(apiKeysSource({ apiKeys: { "vertex-express": "k" } }, "gemini"), undefined); // overlapping, not identical
  assert.equal(apiKeysSource({ apiKeys: { ollama: "k" } }, "vllm"), undefined); // empty env lists do not share
  assert.throws(() => apiKeysSource({ apiKeys: { meta: "a", "meta-chat": "b" } }, "meta-anthropic"), NotConfiguredError);
  assert.equal(apiKeysSource({ apiKeys: { meta: "a", "meta-chat": "b", "meta-anthropic": "c" } }, "meta-anthropic"), "meta-anthropic");
  assert.throws(() => apiKeysSource({ apiKeys: { openai: "" } }, "openai"), NotConfiguredError);
  assert.throws(() => new LMRouter({ apiKeys: { "openai-chat": "a", openai_chat: "b" } }), /duplicate spellings/);
  assert.throws(() => new LMRouter({ apiKeys: { opnai: "a" } }), /Did you mean "openai"/);
  assert.throws(() => new LMRouter({ baseUrls: { nope: "http://x" } }), NotConfiguredError);
  const report = explainAuth("openai-chat", { env: { OPENAI_API_KEY: "SECRET" }, apiKeys: { openai: "SECRET2" } });
  assert.deepEqual(report.steps.map((s) => [s.kind, s.state]), [["api_keys", "selected"], ["env:OPENAI_API_KEY", "shadowed"]]);
  assert.match(report.steps[0]!.source, /via "openai", shared env-key declarations/);
  assert.ok(!JSON.stringify(report).includes("SECRET"));

  assert.equal(openaiChatModelString("groq/openai/gpt-oss-20b"), "groq:openai/gpt-oss-20b");
  assert.equal(openaiChatModelString("openai-chat:gpt-4o-mini"), "openai-chat:gpt-4o-mini");
  assert.equal(openaiChatModelString("gpt-4o-mini"), "gpt-4o-mini");
  assert.throws(() => openaiChatModelString("bedrock/anthropic.claude"), UnknownModelError);
  const router = new LMRouter({ apiKeys: { openai: "k" }, env: {} });
  assert.equal(router.resolveOpenAIChat("gpt-4o-mini").provider, "openai-chat");
  assert.equal(router.resolveOpenAIChat("anthropic/claude-sonnet-4-5").provider, "anthropic");
  assert.throws(() => router.requestFromOpenAIChat("gpt-4o-mini", [{ role: "user", content: "hi" }], { api_key: "x" }), /configures the client/);
  const [request, lm] = router.requestFromOpenAIChat("gpt-4o-mini", [{ role: "user", content: "hi" }], { max_completion_tokens: 5 });
  assert.equal(lm.provider, "openai-chat");
  assert.equal(request.config?.maxTokens, 5);
  assert.equal(request.model, "gpt-4o-mini");
});

test("router.completeFromOpenAIChat answers the OpenAI SDK's call; stream: true is a lazy ResponseStream", async () => {
  const { LMRouter, ResponseStream, responseFromOpenAIChat, UnsupportedFeatureError } = await import("../src/index.ts");
  const chat = { id: "c1", model: "gpt-4o-mini", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
  const sse = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const transport = new FakeTransport([
    new FakeResponse({ status: 200, body: JSON.stringify(chat) }),
    new FakeResponse({ status: 200, headers: [["content-type", "text/event-stream"]], body: sse }),
  ]);
  const router = new LMRouter({ apiKeys: { openai: "k" }, env: {}, transport });
  const response = await router.completeFromOpenAIChat("gpt-4o-mini", [{ role: "user", content: "hi" }]);
  assert.equal(response.text, "Hello!");
  const stream = await router.completeFromOpenAIChat("gpt-4o-mini", [{ role: "user", content: "hi" }], { stream: true });
  assert.ok(stream instanceof ResponseStream);
  let seen = "";
  for await (const chunk of stream) seen += chunk;
  assert.equal(seen, "Hello");
  assert.equal((await stream.response()).finishReason, "stop");
  await assert.rejects(() => router.completeFromOpenAIChat("gpt-4o-mini", [], { stream: "yes" as never }), TypeError);

  // MAP-12 rule 9: the response door is parseResponse's reader, exposed.
  const read = responseFromOpenAIChat(chat);
  assert.equal(read.text, "Hello!");
  assert.equal(read.usage.totalTokens, 5);
  const two = { ...chat, choices: [chat.choices[0], chat.choices[0]] };
  assert.throws(() => responseFromOpenAIChat(two), UnsupportedFeatureError);
  assert.equal(responseFromOpenAIChat(two, { choice: 1 }).text, "Hello!");
  assert.equal(responseFromOpenAIChat({ choices: chat.choices }, { model: "m" }).model, "m");
  assert.throws(() => responseFromOpenAIChat({ choices: chat.choices }), /pass model/);
});
