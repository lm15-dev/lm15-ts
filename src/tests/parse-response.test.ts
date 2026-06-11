/** Stage D: parse_response unit tests (harness vectors are the real gate). */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleLine } from "../vet.js";
import {
  parseAnthropicResponse,
  parseGeminiResponse,
  parseOpenAIChatResponse,
  parseOpenAIResponse,
} from "../adapters/parse-response.js";
import { requestFromDict } from "../serde.js";

const REQ = requestFromDict({
  model: "m",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
});

test("openai: text output with usage and continuation", () => {
  const resp = parseOpenAIResponse(REQ, {
    id: "resp_1",
    model: "m-2025",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    status: "completed",
  });
  assert.equal(resp.id, "resp_1");
  assert.equal(resp.model, "m-2025");
  assert.deepEqual(resp.message.parts[0], { type: "text", text: "hello", continuation: [] });
  assert.equal(resp.finish_reason, "stop");
  assert.equal(resp.usage.total_tokens, 7);
  assert.equal(resp.message.continuation[0]?.kind, "response_id");
});

test("openai: MAP-1 provider-executed items never become parts", () => {
  const resp = parseOpenAIResponse(REQ, {
    id: "r",
    model: "m",
    output: [
      { type: "code_interpreter_call", id: "ci_1", code: "1+1" },
      { type: "message", content: [{ type: "output_text", text: "2" }] },
    ],
    status: "completed",
  });
  assert.deepEqual(
    resp.message.parts.map((p) => p.type),
    ["text"],
  );
  assert.equal(resp.provider_data?.["_lm15_unmapped"], undefined);
});

test("openai: unknown output item recorded as unmapped", () => {
  const resp = parseOpenAIResponse(REQ, {
    output: [{ type: "mystery_item" }],
    model: "m",
  });
  assert.deepEqual(resp.provider_data?.["_lm15_unmapped"], [
    { path: "output[0]", type: "mystery_item" },
  ]);
});

test("openai: tool_call finish_reason and arguments parsing", () => {
  const resp = parseOpenAIResponse(REQ, {
    model: "m",
    output: [{ type: "function_call", call_id: "c1", name: "f", arguments: '{"a": 1}' }],
    status: "completed",
  });
  assert.equal(resp.finish_reason, "tool_call");
  const part = resp.message.parts[0];
  assert.equal(part?.type, "tool_call");
  assert.deepEqual(part.type === "tool_call" ? part.input : null, { a: 1 });
});

test("anthropic: MAP-2 empty content yields single empty text part", () => {
  const resp = parseAnthropicResponse(REQ, {
    id: "msg_1",
    model: "claude",
    content: [],
    stop_reason: "max_tokens",
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.deepEqual(resp.message.parts, [{ type: "text", text: "", continuation: [] }]);
  assert.equal(resp.finish_reason, "length");
  assert.equal(resp.usage.total_tokens, 3);
});

test("anthropic: thinking signature becomes continuation", () => {
  const resp = parseAnthropicResponse(REQ, {
    id: "msg_2",
    model: "claude",
    content: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
  });
  const thinking = resp.message.parts[0];
  assert.equal(thinking?.type, "thinking");
  assert.deepEqual(thinking.type === "thinking" ? thinking.continuation[0]?.data : null, {
    signature: "sig",
  });
});

test("gemini: function call + thought signature, model from request", () => {
  const resp = parseGeminiResponse(REQ, {
    responseId: "g1",
    candidates: [
      {
        content: {
          parts: [{ functionCall: { id: "fc1", name: "f", args: { x: 1 } }, thoughtSignature: "s" }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
  });
  assert.equal(resp.model, "m");
  assert.equal(resp.finish_reason, "tool_call");
  const part = resp.message.parts[0];
  assert.equal(part?.type, "tool_call");
  assert.equal(part.type === "tool_call" ? part.continuation[0]?.kind : null, "thought_signature");
});

test("gemini: unmapped part records sorted joined keys", () => {
  const resp = parseGeminiResponse(REQ, {
    candidates: [{ content: { parts: [{ zeta: 1, alpha: 2 }] }, finishReason: "STOP" }],
  });
  assert.deepEqual(resp.provider_data?.["_lm15_unmapped"], [
    { path: "candidates[0].content.parts[0]", type: "alpha+zeta" },
  ]);
});

test("gemini: in-band prompt block raises InvalidRequestError", () => {
  assert.throws(
    () => parseGeminiResponse(REQ, { promptFeedback: { blockReason: "SAFETY" } }),
    (err: Error) => err.name === "InvalidRequestError",
  );
});

test("openai_chat: reasoning + content + unknown finish_reason unmapped", () => {
  const resp = parseOpenAIChatResponse(REQ, {
    id: "c1",
    model: "m",
    choices: [
      {
        message: { content: "hi", reasoning_content: "think" },
        finish_reason: "weird_reason",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.deepEqual(
    resp.message.parts.map((p) => p.type),
    ["thinking", "text"],
  );
  assert.equal(resp.finish_reason, "stop");
  assert.deepEqual(resp.provider_data?.["_lm15_unmapped"], [
    { path: "choices[0].finish_reason", type: "weird_reason" },
  ]);
});

test("vet shim: parse_response op surfaces unmapped canary", () => {
  const body = Buffer.from(JSON.stringify({ model: "m", output: [{ type: "wat" }] })).toString(
    "base64",
  );
  const reply = handleLine(
    JSON.stringify({
      op: "parse_response",
      id: "1",
      provider: "openai",
      canonical_request: {
        model: "m",
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      },
      status: 200,
      body_b64: body,
    }),
  );
  assert.equal(reply["ok"], true);
  const result = reply["result"] as { unmapped?: unknown; canonical_response?: unknown };
  assert.deepEqual(result.unmapped, [{ path: "output[0]", type: "wat" }]);
  assert.ok(result.canonical_response);
});
