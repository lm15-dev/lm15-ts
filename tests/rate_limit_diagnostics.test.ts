import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installNodePlatform } from "../src/platform_node.ts";
installNodePlatform();
import { OpenAILM, Message, Request, StreamEvent, ErrorDetail } from "../src/index.ts";
import { AuthError, ProviderError, RateLimitError, mapHttpError, withCredentialHint } from "../src/errors.ts";
import { attachErrorMetadata } from "../src/adapter.ts";
import { captureRateLimits } from "../src/rate_limits.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { HttpResponse } from "../src/wire.ts";
import { materializeResponse, materializeResponseAsync } from "../src/stream.ts";

type Case = {
  id: string; status: number; provider_code?: string; body_retry_after?: number; body_request_id?: string;
  headers: [string, string][];
  expect: { retry_after: number | null; request_id: string | null; rate_limit_headers: Record<string, string[]> };
};
const root = process.env["LM15_CONTRACT_DIR"] ?? resolve(import.meta.dirname, "../../lm15-contract");
const fixture = JSON.parse(readFileSync(resolve(root, "errors/diagnostic-headers.json"), "utf8")) as { sentinel: string; cases: Case[] };
const req = Request.create({ model: "deployment", messages: [Message.user("hi")] });
const headers: [string, string][] = [["Retry-After", "39"], ["x-ratelimit-limit-requests", "1"], ["x-ratelimit-remaining-requests", "-1"], ["x-ratelimit-reset-requests", "105"], ["apim-request-id", "request-1"], ["api-key", fixture.sentinel]];

for (const c of fixture.cases) test(`diagnostic contract: ${c.id}`, () => {
  const error = mapHttpError(c.status, "provider message", { provider: "azure", providerCode: c.provider_code ?? null, requestId: c.body_request_id ?? null, retryAfter: c.body_retry_after ?? null });
  const original = error.message;
  const resp = new HttpResponse({ status: c.status, headers: c.headers, body: new Uint8Array() });
  attachErrorMetadata(error, resp);
  assert.equal(error.retryAfter, c.expect.retry_after);
  assert.equal(error.requestId, c.expect.request_id);
  assert.deepEqual(error.rateLimitHeaders, c.expect.rate_limit_headers);
  assert.equal(String(error), String(error));
  assert.equal(error.message, original);
  assert.ok(!String(error).includes(fixture.sentinel));
  attachErrorMetadata(error, resp);
  assert.ok((String(error).match(/Provider rate-limit headers/g) ?? []).length <= 1);
});

test("diagnostic snapshots are bounded, copied, immutable, closed and safely displayed", () => {
  const input = { "x-ratelimit-limit-requests": ["1", "2", "3", "4", "5"], "api-key": [fixture.sentinel] };
  const error = new ProviderError("x", { rateLimitHeaders: input });
  input["x-ratelimit-limit-requests"][0] = "999";
  assert.deepEqual(error.rateLimitHeaders["x-ratelimit-limit-requests"], ["1", "2", "3", "4"]);
  assert.ok(Object.isFrozen(error.rateLimitHeaders));
  assert.ok(Object.isFrozen(error.rateLimitHeaders["x-ratelimit-limit-requests"]));
  for (const value of ["", "1".repeat(257), "\t1", "1\n", "\x1b[31m0", "数"])
    assert.deepEqual(captureRateLimits([["x-ratelimit-limit-requests", value]]), {});
  assert.ok(Object.keys(captureRateLimits([["x-ratelimit-limit-requests", "1".repeat(256)]])).length);
  const many = Object.fromEntries(["requests", "tokens"].flatMap(u => ["limit", "remaining", "reset", "renewalperiod"].map(f => [`x-ratelimit-${f}-${u}`, Array(4).fill("1".repeat(256))])));
  const verbose = new ProviderError("original", { rateLimitHeaders: many });
  assert.ok(String(verbose).length < 2300 && String(verbose).includes("full retained values"));
  assert.equal(Object.keys(verbose.rateLimitHeaders).length, 8);
});

for (const operation of ["complete", "stream", "listModels", "fileGet"] as const) test(`HTTP diagnostics through ${operation}`, async () => {
  const transport = new FakeTransport([new FakeResponse({ status: 429, headers, body: '{"error":{"code":"no_capacity","message":"busy"}}' })]);
  const lm = new OpenAILM({ apiKey: "fake", transport });
  await assert.rejects(async () => {
    if (operation === "stream") { for await (const _ of lm.stream(req)) { /* exhaust */ } }
    else if (operation === "complete") await lm.complete(req);
    else if (operation === "listModels") await lm.listModels();
    else await lm.fileGet("file-1");
  }, (e: unknown) => {
    assert.ok(e instanceof RateLimitError);
    assert.deepEqual(e.rateLimitHeaders["x-ratelimit-reset-requests"], ["105"]);
    assert.equal(e.retryAfter, 39); assert.equal(e.requestId, "request-1");
    assert.equal(e.providerCode, "no_capacity"); assert.equal(e.status, 429);
    return true;
  });
  assert.equal(transport.requests.length, 1);
});

test("HTTP 200 stream failures and saved/replayed errors carry handshake evidence", async () => {
  const body = 'event: error\ndata: {"type":"error","error":{"type":"too_many_requests","code":"no_capacity","message":"busy"}}\n\n';
  const transport = new FakeTransport([new FakeResponse({ status: 200, headers, body })]);
  const lm = new OpenAILM({ apiKey: "fake", transport });
  const events: StreamEvent[] = [];
  for await (const e of lm.stream(req)) events.push(e);
  const event = events.find(e => e.type === "error");
  assert.ok(event?.type === "error");
  assert.equal(event.error.httpResponse?.["request_id"], "request-1");
  assert.equal(event.error.code, "rate_limit");
  const replay = events.map(e => StreamEvent.fromJSON(StreamEvent.toJSON(e)));
  assert.deepEqual(replay, events);
  function check(e: unknown): boolean {
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.status, null); assert.equal(e.retryAfter, 39); assert.equal(e.requestId, "request-1");
    assert.deepEqual(e.rateLimitHeaders["x-ratelimit-limit-requests"], ["1"]);
    return true;
  }
  assert.throws(() => materializeResponse(replay, req), check);
  async function* source() { yield* replay; }
  await assert.rejects(() => materializeResponseAsync(source(), req), check);
});

test("HTTP 200 complete and parser-raised stream failures keep diagnostics", async () => {
  const complete = new OpenAILM({ apiKey: "fake", transport: new FakeTransport([
    new FakeResponse({ status: 200, headers, body: '{"error":{"code":"no_capacity","message":"busy"}}' }),
  ]) });
  function check(e: unknown): boolean {
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.requestId, "request-1");
    assert.equal(e.status, null);
    assert.deepEqual(e.rateLimitHeaders["x-ratelimit-limit-requests"], ["1"]);
    return true;
  }
  await assert.rejects(() => complete.complete(req), check);
  class RaisingLM extends OpenAILM {
    override parseStreamEvents(): StreamEvent[] { throw new RateLimitError("busy", { providerCode: "no_capacity" }); }
  }
  const stream = new RaisingLM({ apiKey: "fake", transport: new FakeTransport([
    new FakeResponse({ status: 200, headers, body: 'data: {}\n\n' }),
  ]) });
  await assert.rejects(async () => { for await (const _ of stream.stream(req)) { /* exhaust */ } }, check);
});

test("auth reconstruction preserves evidence; canonical metadata validates and omits empties", () => {
  const error = new AuthError("bad", { rateLimitHeaders: { "retry-after": ["3"] } });
  assert.deepEqual(withCredentialHint(error, "login").rateLimitHeaders, error.rateLimitHeaders);
  assert.deepEqual(ErrorDetail.toJSON(ErrorDetail.create({ code: "rate_limit", message: "busy" })), { code: "rate_limit", message: "busy" });
  const raw = { code: "rate_limit", message: "busy", http_response: { retry_after: 0, rate_limit_headers: { "retry-after": ["3"] } } };
  const value = ErrorDetail.fromJSON(raw);
  raw.http_response.rate_limit_headers["retry-after"][0] = "4";
  assert.deepEqual(value.httpResponse?.["rate_limit_headers"], { "retry-after": ["3"] });
  for (const bad of [null, [], { status: 200 }, { retry_after: -1 }, { retry_after: true }, { retry_after: Infinity }, { request_id: "" }, { rate_limit_headers: { "retry-after": "3" } }])
    assert.throws(() => ErrorDetail.create({ code: "rate_limit", message: "busy", httpResponse: bad }));
});
