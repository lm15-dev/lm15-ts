import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  partToDict, partFromDict,
  messageToDict, messageFromDict,
  toolToDict, toolFromDict,
  usageToDict, usageFromDict,
  requestToDict, requestFromDict,
  responseToDict, responseFromDict,
  streamEventToDict,
  liveClientEventToDict, liveServerEventToDict,
  errorInfoToDict, errorInfoFromDict,
} from "../serde.js";
import { Part, Message, EMPTY_USAGE } from "../types.js";
import type { LMRequest, LMResponse, Usage, Tool, StreamEvent, ErrorInfo, LiveClientEvent, LiveServerEvent } from "../types.js";

describe("serde round-trip", () => {
  it("round-trips text part", () => {
    const p = Part.text("hello");
    const d = partToDict(p);
    assert.equal(d.type, "text");
    assert.equal(d.text, "hello");
    const p2 = partFromDict(d);
    assert.equal(p2.type, "text");
    assert.equal((p2 as { text: string }).text, "hello");
  });

  it("round-trips tool call part", () => {
    const p = Part.toolCall("c1", "weather", { city: "Paris" });
    const d = partToDict(p);
    assert.equal(d.type, "tool_call");
    assert.equal(d.id, "c1");
    assert.equal(d.name, "weather");
    assert.deepEqual(d.input, { city: "Paris" });
    const p2 = partFromDict(d);
    assert.equal(p2.type, "tool_call");
  });

  it("round-trips message", () => {
    const m = Message.user("hello");
    const d = messageToDict(m);
    assert.equal(d.role, "user");
    const m2 = messageFromDict(d);
    assert.equal(m2.role, "user");
    assert.equal(m2.parts.length, 1);
  });

  it("round-trips function tool", () => {
    const t: Tool = { type: "function", name: "test", description: "Test tool", parameters: { type: "object", properties: {} } };
    const d = toolToDict(t);
    assert.equal(d.name, "test");
    const t2 = toolFromDict(d);
    assert.equal(t2.type, "function");
    assert.equal(t2.name, "test");
  });

  it("round-trips builtin tool", () => {
    const t: Tool = { type: "builtin", name: "web_search", description: "Search" };
    const d = toolToDict(t);
    assert.equal(d.type, "builtin");
    const t2 = toolFromDict(d);
    assert.equal(t2.type, "builtin");
  });

  it("round-trips usage", () => {
    const u: Usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150, cache_read_tokens: 30 };
    const d = usageToDict(u);
    assert.equal(d.input_tokens, 100);
    assert.equal(d.cache_read_tokens, 30);
    const u2 = usageFromDict(d);
    assert.equal(u2.input_tokens, 100);
    assert.equal(u2.cache_read_tokens, 30);
  });

  it("round-trips request", () => {
    const req: LMRequest = {
      model: "gpt-4.1-mini",
      messages: [Message.user("hi")],
      system: "Be terse.",
      tools: [{ type: "function", name: "test", parameters: { type: "object", properties: {} } }],
    };
    const d = requestToDict(req);
    assert.equal(d.model, "gpt-4.1-mini");
    assert.equal(d.system, "Be terse.");
    const req2 = requestFromDict(d);
    assert.equal(req2.model, "gpt-4.1-mini");
    assert.equal(req2.system, "Be terse.");
    assert.equal(req2.messages.length, 1);
  });

  it("round-trips response", () => {
    const resp: LMResponse = {
      id: "r1",
      model: "gpt-4.1-mini",
      message: { role: "assistant", parts: [Part.text("ok")] },
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const d = responseToDict(resp);
    assert.equal(d.id, "r1");
    const resp2 = responseFromDict(d);
    assert.equal(resp2.id, "r1");
    assert.equal(resp2.finish_reason, "stop");
  });

  it("round-trips error info", () => {
    const e: ErrorInfo = { code: "rate_limit", message: "Too fast", provider_code: "429" };
    const d = errorInfoToDict(e);
    const e2 = errorInfoFromDict(d);
    assert.equal(e2.code, "rate_limit");
    assert.equal(e2.message, "Too fast");
    assert.equal(e2.provider_code, "429");
  });

  it("round-trips image part", () => {
    const p = Part.image({ url: "https://example.com/img.png", media_type: "image/png" });
    const d = partToDict(p);
    assert.equal(d.type, "image");
    assert.ok(d.source);
    const p2 = partFromDict(d);
    assert.equal(p2.type, "image");
  });

  it("round-trips thinking part", () => {
    const p = Part.thinking("hmm", { redacted: false, summary: "thought" });
    const d = partToDict(p);
    assert.equal(d.type, "thinking");
    assert.equal(d.text, "hmm");
    assert.equal(d.redacted, false);
    assert.equal(d.summary, "thought");
    const p2 = partFromDict(d);
    assert.equal(p2.type, "thinking");
    assert.equal((p2 as { text: string }).text, "hmm");
  });
});
