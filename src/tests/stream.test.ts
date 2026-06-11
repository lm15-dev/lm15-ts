import assert from "node:assert/strict";
import { test } from "node:test";

import { handleLine } from "../vet.js";
import { parseSse, splitBodyLines } from "../sse.js";
import { coalesceStream, materializeResponse } from "../stream.js";
import * as t from "../types.js";

function replay(provider: string, body: string, request?: object): Record<string, unknown> {
  const msg = {
    op: "replay_stream",
    id: "t1",
    provider,
    canonical_request: request ?? {
      model: "m",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    },
    body_b64: Buffer.from(body, "utf8").toString("base64"),
  };
  const reply = handleLine(JSON.stringify(msg));
  assert.equal(reply["ok"], true, JSON.stringify(reply));
  return reply["result"] as Record<string, unknown>;
}

// ─── SSE parser ──────────────────────────────────────────────────────

test("sse: event names, comments, multi-line data, trailing event", () => {
  const events = parseSse(
    splitBodyLines(
      ": comment\nevent: message_start\ndata: {\"a\":1}\n\ndata: line1\ndata: line2\n\ndata: tail",
    ),
  );
  assert.deepEqual(events, [
    { event: "message_start", data: '{"a":1}' },
    { event: null, data: "line1\nline2" },
    { event: null, data: "tail" },
  ]);
});

// ─── MAP-3 coalescer ─────────────────────────────────────────────────

test("coalesce: post-finish usage-only chunk is absorbed (vLLM shape)", () => {
  const usage = t.usage({ input_tokens: 3, output_tokens: 4 });
  const events = coalesceStream([
    t.streamDeltaEvent(t.textDelta({ text: "hi" })),
    t.streamEndEvent({ finish_reason: "stop" }),
    t.streamEndEvent({ usage }),
    t.streamEndEvent({}), // [DONE]
  ]);
  assert.equal(events.length, 2);
  const end = events[1]!;
  assert.equal(end.type, "end");
  if (end.type === "end") {
    assert.equal(end.finish_reason, "stop");
    assert.deepEqual(end.usage, usage);
  }
});

test("coalesce: a non-null field is never overwritten by null, later non-null wins", () => {
  const events = coalesceStream([
    t.streamEndEvent({ finish_reason: "length" }),
    t.streamEndEvent({ finish_reason: "stop" }),
    t.streamEndEvent({}),
  ]);
  assert.equal(events.length, 1);
  const end = events[0]!;
  if (end.type === "end") assert.equal(end.finish_reason, "stop");
});

test("coalesce: no end event seen → none fabricated", () => {
  const events = coalesceStream([t.streamDeltaEvent(t.textDelta({ text: "x" }))]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "delta");
});

// ─── Materialization ─────────────────────────────────────────────────

test("materialize: empty stream yields MAP-2 placeholder and default finish", () => {
  const request = t.request({
    model: "m",
    messages: [t.message({ role: "user", parts: [t.textPart({ text: "hi" })] })],
  });
  const response = materializeResponse([t.streamEndEvent({ finish_reason: "stop" })], request);
  assert.deepEqual(response.message.parts, [t.textPart({ text: "" })]);
  assert.equal(response.finish_reason, "stop");
});

test("materialize: tool-call deltas assemble id/name/input and flip finish to tool_call", () => {
  const request = t.request({
    model: "m",
    messages: [t.message({ role: "user", parts: [t.textPart({ text: "hi" })] })],
  });
  const response = materializeResponse(
    [
      t.streamDeltaEvent(t.toolCallDelta({ input: '{"city":', id: "c1", name: "weather" })),
      t.streamDeltaEvent(t.toolCallDelta({ input: '"Paris"}' })),
      t.streamEndEvent({ finish_reason: "stop" }),
    ],
    request,
  );
  assert.equal(response.finish_reason, "tool_call");
  const part = response.message.parts[0]!;
  assert.equal(part.type, "tool_call");
  if (part.type === "tool_call") {
    assert.equal(part.id, "c1");
    assert.equal(part.name, "weather");
    assert.deepEqual(part.input, { city: "Paris" });
  }
});

// ─── replay_stream end-to-end (provider frame shapes) ────────────────

test("openai_chat: finish chunk + usage-only chunk + [DONE] coalesce into one end", () => {
  const body = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
    "",
    'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}',
    "",
    'data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":22,"total_tokens":36}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const result = replay("openai_chat", body);
  const events = result["events"] as Array<Record<string, unknown>>;
  assert.equal(events.filter((e) => e["type"] === "end").length, 1);
  assert.deepEqual(events[events.length - 1], {
    type: "end",
    finish_reason: "stop",
    usage: { input_tokens: 14, output_tokens: 22, total_tokens: 36 },
  });
  const response = result["canonical_response"] as Record<string, unknown>;
  assert.deepEqual(response["usage"], { input_tokens: 14, output_tokens: 22, total_tokens: 36 });
});

test("anthropic: message_delta carries finish+usage, message_stop absorbed", () => {
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x"}}',
    "",
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    "",
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":9,"output_tokens":12}}',
    "",
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
  ].join("\n");
  const result = replay("anthropic", body);
  const events = result["events"] as Array<Record<string, unknown>>;
  assert.equal(events[0]!["type"], "start");
  assert.equal(events.filter((e) => e["type"] === "end").length, 1);
  assert.deepEqual(events[events.length - 1], {
    type: "end",
    finish_reason: "stop",
    usage: { input_tokens: 9, output_tokens: 12, total_tokens: 21 },
  });
  const response = result["canonical_response"] as Record<string, unknown>;
  const message = response["message"] as Record<string, unknown>;
  assert.deepEqual(message["continuation"], [
    { provider: "anthropic", kind: "message_id", data: { id: "msg_1" } },
  ]);
  assert.equal(response["id"], "msg_1");
});

test("openai: [DONE] after response.completed does not lose tool_call finish", () => {
  const body = [
    'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-x"}}',
    "",
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"f","arguments":""}}',
    "",
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}',
    "",
    'data: {"type":"response.completed","response":{"output":[{"type":"function_call"}],"usage":{"input_tokens":5,"output_tokens":6}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const result = replay("openai", body, {
    model: "gpt-x",
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    tools: [{ type: "function", name: "f" }],
  });
  const response = result["canonical_response"] as Record<string, unknown>;
  // [DONE]'s "stop" overwrites in the coalescer, but materialization
  // restores tool_call when tool-call parts are present (reference parity).
  assert.equal(response["finish_reason"], "tool_call");
  const events = result["events"] as Array<Record<string, unknown>>;
  assert.equal(events.filter((e) => e["type"] === "end").length, 1);
});

test("gemini: finishReason chunk carries usage and provider_data", () => {
  const body = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"index":0}]}',
    "",
    'data: {"candidates":[{"content":{"parts":[{"text":"!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":9,"totalTokenCount":12}}',
    "",
  ].join("\n");
  const result = replay("gemini", body);
  const events = result["events"] as Array<Record<string, unknown>>;
  const end = events[events.length - 1]!;
  assert.equal(end["type"], "end");
  assert.equal(end["finish_reason"], "stop");
  assert.deepEqual(end["usage"], { input_tokens: 3, output_tokens: 9, total_tokens: 12 });
  assert.ok(end["provider_data"]);
  const response = result["canonical_response"] as Record<string, unknown>;
  const message = response["message"] as Record<string, unknown>;
  const parts = message["parts"] as Array<Record<string, unknown>>;
  assert.deepEqual(parts, [{ type: "text", text: "Hi!" }]);
});

test("stream error frame becomes ok result with error event (openai_chat)", () => {
  const body = 'data: {"error":{"code":"rate_limit_exceeded","message":"slow down"}}\n\ndata: [DONE]\n\n';
  const result = replay("openai_chat", body);
  const events = result["events"] as Array<Record<string, unknown>>;
  assert.deepEqual(events[0], {
    type: "error",
    error: { code: "rate_limit", message: "slow down", provider_code: "rate_limit_exceeded" },
  });
});
