// These tests import lm15 internals; the Node host is installed here as the `lm15` entry does on import.
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

import { test } from "node:test";
import assert from "node:assert/strict";
import { LMRouter, MissingCredentialError, resolveModel } from "../src/router.ts";
import { AmbiguousModelError, UnknownModelError, RateLimitError } from "../src/errors.ts";
import { ModelInfo, ModelRegistry } from "../src/types/model_info.ts";
import { Message } from "../src/types/parts.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";
import type { TransportRequest } from "../src/wire.ts";
import { ResponseStream } from "../src/stream.ts";

test("the three rungs, in order: prefix, catalog, rule", () => {
  assert.deepEqual(pick(resolveModel("openai_chat:gpt-4.1")), { provider: "openai-chat", model: "gpt-4.1", source: "prefix" });
  assert.deepEqual(pick(resolveModel("claude-haiku-4-5")), { provider: "anthropic", model: "claude-haiku-4-5", source: "rule" });
  const registry = new ModelRegistry();
  registry.add(ModelInfo.create({ id: "llama-3.3-70b-versatile", provider: "groq", apiFamily: "openai_chat", aliases: ["llama"] }));
  assert.deepEqual(pick(resolveModel("llama", { registry })), { provider: "groq", model: "llama-3.3-70b-versatile", source: "catalog" });
  // a fine-tune id with colons needs the explicit form
  assert.deepEqual(pick(resolveModel("openai:ft:gpt-4.1:org")), { provider: "openai", model: "ft:gpt-4.1:org", source: "prefix" });
});

test("unknown_model and ambiguous_model carry their payloads", () => {
  assert.throws(() => resolveModel("nope"), (e: unknown) => e instanceof UnknownModelError && e.model === "nope" && e.code === "unknown_model");
  const registry = new ModelRegistry();
  registry.add(ModelInfo.create({ id: "x", provider: "groq", apiFamily: "openai_chat" }));
  registry.add(ModelInfo.create({ id: "x", provider: "openrouter", apiFamily: "openai_chat" }));
  assert.throws(() => resolveModel("x", { registry }), (e: unknown) => e instanceof AmbiguousModelError && e.providers.join(",") === "groq,openrouter");
});

test("lm(): explicit keys beat env; the placeholder covers keyless local servers; nothing is a typed error", () => {
  const router = new LMRouter({ env: { GROQ_API_KEY: "env-key" }, apiKeys: { groq: "explicit" } });
  assert.ok(router.lm("groq:x") instanceof OpenAIChatLM);
  assert.equal(router.resolve("groq:x").envKey, undefined);
  assert.ok(new LMRouter({ env: {} }).lm("ollama:llama3") instanceof OpenAIChatLM);
  assert.throws(() => new LMRouter({ env: {} }).lm("claude-haiku-4-5"), MissingCredentialError);
  assert.ok(new LMRouter({ env: { ANTHROPIC_API_KEY: "k" } }).lm("claude-haiku-4-5") instanceof AnthropicLM);
});

class FakeTransport implements Transport {
  requests: TransportRequest[] = [];
  private readonly reply: (req: TransportRequest) => { status: number; body: string; headers?: Array<[string, string]> };
  constructor(reply: (req: TransportRequest) => { status: number; body: string; headers?: Array<[string, string]> }) {
    this.reply = reply;
  }
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const r = this.reply(request);
    const bytes = new TextEncoder().encode(r.body);
    return {
      status: r.status,
      reason: "OK",
      headers: r.headers ?? [["content-type", "application/json"]],
      bytes: async () => bytes,
      async *chunks() {
        yield bytes;
      },
    };
  }
}

test("end to end through a fake transport: complete, stream (MAP-3/4), and a typed HTTP error", async () => {
  const body = JSON.stringify({
    id: "chatcmpl-1",
    model: "llama-3.3-70b-versatile",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  const transport = new FakeTransport((req) => {
    const payload = JSON.parse(new TextDecoder().decode(req.body)) as { stream?: boolean };
    return payload.stream ? { status: 200, body: sse, headers: [["content-type", "text/event-stream"]] } : { status: 200, body };
  });
  const router = new LMRouter({ env: { GROQ_API_KEY: "test-key" }, transport });
  const request = { model: "groq:llama-3.3-70b-versatile", messages: [Message.user("hi")] };

  const response = await router.complete(request);
  assert.equal(response.text, "Hello!");
  assert.equal(response.usage.totalTokens, 5);
  const sent = transport.requests[0]!;
  assert.equal(sent.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.ok(sent.headers.some(([k, v]) => k === "Authorization" && v === "Bearer test-key"));
  assert.equal((JSON.parse(new TextDecoder().decode(sent.body)) as { model: string }).model, "llama-3.3-70b-versatile"); // prefix stripped

  const rs = new ResponseStream(router.stream(request), request);
  const chunks: string[] = [];
  for await (const t of rs) chunks.push(t);
  assert.deepEqual(chunks, ["Hel", "lo"]);
  const streamed = await rs.response();
  assert.equal(streamed.text, "Hello");
  assert.equal(streamed.usage.totalTokens, 5); // the usage-only chunk was merged (MAP-3)
  assert.equal(streamed.finishReason, "stop");

  const failing = new LMRouter({
    env: { GROQ_API_KEY: "k" },
    transport: new FakeTransport(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
      headers: [["content-type", "application/json"], ["retry-after", "7"]],
    })),
  });
  await assert.rejects(failing.complete(request), (e: unknown) => e instanceof RateLimitError && e.status === 429 && e.retryAfter === 7 && e.retryable);
});

function pick(r: { provider: string; model: string; source: string }) {
  return { provider: r.provider, model: r.model, source: r.source };
}

test("R3: an unusable or signed-out xAI login blocks $XAI_API_KEY; a usable one wins; none leaves the env key", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const SECRET = "SECRET-SENTINEL-DO-NOT-PRINT";
  const saved = process.env["LM15_CREDENTIALS_PATH"];
  const savedHome = process.env["HOME"];
  const dir = mkdtempSync(join(tmpdir(), "lm15-r3-"));
  const file = join(dir, "credentials.json");
  process.env["LM15_CREDENTIALS_PATH"] = file;
  process.env["HOME"] = dir; // no Pi agent store either
  const router = new LMRouter({ env: { XAI_API_KEY: SECRET } });
  try {
    writeFileSync(file, JSON.stringify({ xai: { type: "oauth", access: "a", expires: 1 } }));
    const expired = (() => { try { router.lm("xai:grok-4"); } catch (e) { return e; } })();
    assert.ok(expired instanceof MissingCredentialError, String(expired));
    assert.match(String((expired as Error).message), /expired and cannot be renewed/);
    assert.match(String((expired as Error).message), /\$XAI_API_KEY is set but is used only when passed explicitly/);
    assert.ok(!String((expired as Error).message).includes(SECRET));

    writeFileSync(file, JSON.stringify({ _lm15: { slots: { xai: { logged_out: true } } } }));
    assert.throws(() => router.lm("xai:grok-4"), (e: unknown) => e instanceof MissingCredentialError && /was signed out/.test((e as Error).message));

    // An explicit key is deliberate authority (R2): it still works.
    assert.ok(new LMRouter({ env: { XAI_API_KEY: SECRET }, apiKeys: { xai: "explicit" } }).lm("xai:grok-4"));

    writeFileSync(file, JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
    assert.ok(router.lm("xai:grok-4"), "expired with a refresh token is usable");

    writeFileSync(file, JSON.stringify({}));
    assert.ok(router.lm("xai:grok-4"), "nothing stored: the env key applies");
  } finally {
    if (saved === undefined) delete process.env["LM15_CREDENTIALS_PATH"]; else process.env["LM15_CREDENTIALS_PATH"] = saved;
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
  }
});
