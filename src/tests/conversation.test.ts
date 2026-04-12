import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../conversation.js";
import { Part, EMPTY_USAGE } from "../types.js";
import type { LMResponse } from "../types.js";

describe("Conversation", () => {
  it("accumulates user messages", () => {
    const conv = new Conversation({ system: "test" });
    conv.user("hello");
    conv.user("world");
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.system, "test");
  });

  it("accepts multimodal user content", () => {
    const conv = new Conversation();
    conv.user(["Describe this.", Part.image({ url: "https://example.com/img.jpg" })]);
    assert.equal(conv.messages.length, 1);
    assert.equal(conv.messages[0].parts.length, 2);
  });

  it("adds assistant from response", () => {
    const conv = new Conversation();
    conv.user("hi");
    const resp: LMResponse = {
      id: "r1",
      model: "test",
      message: { role: "assistant", parts: [Part.text("hello")] },
      finish_reason: "stop",
      usage: EMPTY_USAGE,
    };
    conv.assistant(resp);
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[1].role, "assistant");
  });

  it("adds prefill", () => {
    const conv = new Conversation();
    conv.user("Output JSON.");
    conv.prefill("{");
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[1].role, "assistant");
  });

  it("clears", () => {
    const conv = new Conversation();
    conv.user("hi");
    conv.clear();
    assert.equal(conv.messages.length, 0);
  });
});
