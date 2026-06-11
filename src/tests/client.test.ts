import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIChatLM, type FetchLike } from "../client.js";
import { AuthError, RateLimitError } from "../errors.js";
import * as t from "../types.js";

type Captured = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function jsonFetch(status: number, body: string, captured: Captured[]): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      body: null,
    };
  };
}

function sseFetch(chunks: string[], captured: Captured[]): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    const encoder = new TextEncoder();
    async function* iter(): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) yield encoder.encode(chunk);
    }
    return { ok: true, status: 200, text: async () => "", body: iter() };
  };
}

const CHAT_BODY = JSON.stringify({
  id: "chatcmpl-1",
  model: "qwen3.5:0.8b",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

function req(): t.Request {
  return t.request({
    model: "qwen3.5:0.8b",
    messages: [t.Message.user("hi")],
    config: t.config({ max_tokens: 80, temperature: 0.5 }),
  });
}

test("complete() parses a chat completion and exposes accessors", async () => {
  const captured: Captured[] = [];
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "ollama", fetch: jsonFetch(200, CHAT_BODY, captured) });
  const response = await lm.complete(req());
  assert.equal(response.text, "hello there");
  assert.deepEqual(response.toolCalls, []);
  assert.equal(response.usage.total_tokens, 8);
  assert.equal(response.finish_reason, "stop");
  // compat preset supplied ollama's base URL
  assert.equal(captured[0]!.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(captured[0]!.init.method, "POST");
});

test("client body goes through the canonical number emitter", async () => {
  const captured: Captured[] = [];
  const lm = new OpenAIChatLM({ apiKey: "k", fetch: jsonFetch(200, CHAT_BODY, captured) });
  await lm.complete(
    t.request({
      model: "m",
      messages: [t.Message.user("hi")],
      config: t.config({ temperature: 1 }),
    }),
  );
  // temperature is a declared float: canonical emitter must render 1.0
  assert.match(captured[0]!.init.body!, /"temperature":1\.0/);
});

test("non-2xx is normalized to the canonical error hierarchy", async () => {
  const lm401 = new OpenAIChatLM({
    apiKey: "k",
    fetch: jsonFetch(401, JSON.stringify({ error: { message: "bad key" } }), []),
  });
  await assert.rejects(lm401.complete(req()), AuthError);

  const lm429 = new OpenAIChatLM({
    apiKey: "k",
    fetch: jsonFetch(429, JSON.stringify({ error: { message: "slow down" } }), []),
  });
  await assert.rejects(lm429.complete(req()), RateLimitError);
});

test("stream() yields deltas and exactly one merged end event", async () => {
  const frames = [
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ];
  // split frames across odd chunk boundaries to exercise incremental SSE
  const raw = frames.join("");
  const chunks = [raw.slice(0, 37), raw.slice(37, 90), raw.slice(90)];
  const lm = new OpenAIChatLM({ apiKey: "k", fetch: sseFetch(chunks, []) });

  const events: t.StreamEvent[] = [];
  for await (const event of lm.stream(req())) events.push(event);

  const ends = events.filter((e) => e.type === "end");
  assert.equal(ends.length, 1);
  assert.equal(events[events.length - 1]!.type, "end");
  const end = ends[0] as t.StreamEndEvent;
  assert.equal(end.finish_reason, "stop");
  assert.equal(end.usage?.total_tokens, 7);
  const text = events
    .filter((e): e is t.StreamDeltaEvent => e.type === "delta")
    .map((e) => (e.delta.type === "text" ? e.delta.text : ""))
    .join("");
  assert.equal(text, "hello");
});

test("Message factories mirror the reference", () => {
  const user = t.Message.user("hi");
  assert.equal(user.role, "user");
  assert.equal((user.parts[0] as t.TextPart).text, "hi");

  const toolMsg = t.Message.tool({ call_1: "sunny" });
  assert.equal(toolMsg.role, "tool");
  const part = toolMsg.parts[0] as t.ToolResultPart;
  assert.equal(part.id, "call_1");
  assert.equal((part.content[0] as t.TextPart).text, "sunny");

  assert.equal(t.Message.assistant("yo").role, "assistant");
  assert.equal(t.Message.developer("be terse").role, "developer");
});

test("Response accessors are non-enumerable (serde view unchanged)", () => {
  const response = t.response({
    model: "m",
    message: t.message({ role: "assistant", parts: [t.textPart({ text: "x" })] }),
    finish_reason: "stop",
  });
  assert.equal(response.text, "x");
  assert.ok(!Object.keys(response).includes("text"));
  assert.ok(!Object.keys(response).includes("toolCalls"));
});
