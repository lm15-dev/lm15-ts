/**
 * Live smoke tests — real network, env-gated so CI without keys skips them.
 *
 * Targets:
 *  - local ollama (http://localhost:11434/v1, qwen3.5:0.8b) — skipped when
 *    the server is unreachable;
 *  - Groq (GROQ_API_KEY, llama-3.1-8b-instant);
 *  - OpenAI (OPENAI_API_KEY, gpt-4.1-mini), incl. one tools round-trip.
 *
 * Spend is kept tiny: max_tokens <= 80 local, <= 8 Groq, <= 16/64 OpenAI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIChatLM, OpenAILM } from "../client.js";
import * as t from "../types.js";

const OLLAMA_URL = "http://localhost:11434/v1";

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function textOf(events: t.StreamEvent[]): string {
  return events
    .filter((e): e is t.StreamDeltaEvent => e.type === "delta")
    .map((e) => (e.delta.type === "text" ? e.delta.text : ""))
    .join("");
}

function assertOneEndWithUsage(events: t.StreamEvent[]): t.StreamEndEvent {
  const ends = events.filter((e): e is t.StreamEndEvent => e.type === "end");
  assert.equal(ends.length, 1, "exactly one end event");
  assert.equal(events[events.length - 1], ends[0], "end event is final");
  const usage = ends[0]!.usage;
  assert.ok(usage !== null, "end event carries usage");
  assert.ok((usage.total_tokens ?? 0) > 0, "usage.total_tokens > 0");
  return ends[0]!;
}

function saneUsage(response: t.Response): void {
  assert.ok((response.usage.total_tokens ?? 0) > 0, "usage.total_tokens > 0");
  assert.ok((response.usage.output_tokens ?? 0) > 0, "usage.output_tokens > 0");
}

// ─── ollama ──────────────────────────────────────────────────────────

test("live: ollama complete + stream", { timeout: 60_000 }, async (ctx) => {
  if (!(await ollamaUp())) {
    ctx.skip("ollama not reachable on localhost:11434");
    return;
  }
  const lm = new OpenAIChatLM({ apiKey: "ollama", compat: "ollama" });
  const request = t.request({
    model: "qwen3.5:0.8b",
    messages: [t.Message.user("Say hello in five words or fewer.")],
    config: t.config({ max_tokens: 80, extensions: { reasoning_effort: "none" } }),
  });

  const response = await lm.complete(request);
  assert.ok(response.text !== null && response.text.length > 0, "non-empty text");
  saneUsage(response);
  console.log(`[live ollama complete] ${response.text} | usage=${response.usage.total_tokens}`);

  const events: t.StreamEvent[] = [];
  for await (const event of lm.stream(request)) events.push(event);
  const streamed = textOf(events);
  assert.ok(streamed.length > 0, "stream produced text deltas");
  const end = assertOneEndWithUsage(events);
  console.log(`[live ollama stream] ${streamed} | usage=${end.usage!.total_tokens}`);
});

// ─── Groq ────────────────────────────────────────────────────────────

test("live: groq complete + stream", { timeout: 60_000 }, async (ctx) => {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) {
    ctx.skip("GROQ_API_KEY not set");
    return;
  }
  const lm = new OpenAIChatLM({ apiKey, compat: "groq" });
  const request = t.request({
    model: "llama-3.1-8b-instant",
    messages: [t.Message.user("Say hi.")],
    config: t.config({ max_tokens: 8 }),
  });

  const response = await lm.complete(request);
  assert.ok(response.text !== null && response.text.length > 0, "non-empty text");
  saneUsage(response);
  console.log(`[live groq complete] ${response.text} | usage=${response.usage.total_tokens}`);

  const events: t.StreamEvent[] = [];
  for await (const event of lm.stream(request)) events.push(event);
  assert.ok(textOf(events).length > 0, "stream produced text deltas");
  const end = assertOneEndWithUsage(events);
  console.log(`[live groq stream] ${textOf(events)} | usage=${end.usage!.total_tokens}`);
});

// ─── OpenAI (first-party) ────────────────────────────────────────────

test("live: openai complete + stream", { timeout: 60_000 }, async (ctx) => {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    ctx.skip("OPENAI_API_KEY not set");
    return;
  }
  const lm = new OpenAILM({ apiKey });
  const request = t.request({
    model: "gpt-4.1-mini",
    messages: [t.Message.user("Say hi in two words.")],
    config: t.config({ max_tokens: 16 }),
  });

  const response = await lm.complete(request);
  assert.ok(response.text !== null && response.text.length > 0, "non-empty text");
  saneUsage(response);
  console.log(`[live openai complete] ${response.text} | usage=${response.usage.total_tokens}`);

  const events: t.StreamEvent[] = [];
  for await (const event of lm.stream(request)) events.push(event);
  assert.ok(textOf(events).length > 0, "stream produced text deltas");
  const end = assertOneEndWithUsage(events);
  console.log(`[live openai stream] ${textOf(events)} | usage=${end.usage!.total_tokens}`);
});

test("live: openai tools round-trip", { timeout: 60_000 }, async (ctx) => {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    ctx.skip("OPENAI_API_KEY not set");
    return;
  }
  const lm = new OpenAILM({ apiKey });
  const weatherTool = t.functionTool({
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  });

  const messages: t.Message[] = [t.Message.user("What is the weather in Montreal?")];
  const first = await lm.complete(
    t.request({
      model: "gpt-4.1-mini",
      messages,
      tools: [weatherTool],
      config: t.config({ max_tokens: 64 }),
    }),
  );
  assert.ok(first.toolCalls.length > 0, "model issued a tool call");
  const call = first.toolCalls[0]!;
  assert.equal(call.type, "tool_call");
  assert.equal(call.name, "get_weather");
  assert.ok(typeof call.input["city"] === "string", "typed input has city");
  console.log(`[live openai tool_call] ${call.name} ${JSON.stringify(call.input)}`);

  const final = await lm.complete(
    t.request({
      model: "gpt-4.1-mini",
      messages: [
        ...messages,
        first.message,
        t.Message.tool({ [call.id]: `Sunny and 22°C in ${String(call.input["city"])}.` }),
      ],
      tools: [weatherTool],
      config: t.config({ max_tokens: 64 }),
    }),
  );
  assert.ok(final.text !== null && final.text.length > 0, "final text after tool result");
  console.log(`[live openai tools final] ${final.text}`);
});
