import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniversalLM } from "../client.js";
import { Model } from "../model.js";
import { Part, Message, EMPTY_USAGE } from "../types.js";
import type { LMAdapter } from "../providers/base.js";
import type { LMRequest, LMResponse, StreamEvent } from "../types.js";

function echoAdapter(): LMAdapter {
  return {
    provider: "echo",
    supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false },
    manifest: { provider: "echo", supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false }, envKeys: [] },
    async complete(request: LMRequest): Promise<LMResponse> {
      const text = request.messages.map(m =>
        m.parts.filter(p => p.type === "text").map(p => (p as { text: string }).text).join(""),
      ).join(" | ");
      return {
        id: "echo-1",
        model: request.model,
        message: { role: "assistant", parts: [Part.text(`Echo: ${text}`)] },
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
    },
    async *stream(request: LMRequest): AsyncIterable<StreamEvent> {
      const resp = await this.complete(request);
      yield { type: "start", id: "echo-1", model: request.model };
      yield { type: "delta", part_index: 0, delta: { type: "text", text: (resp.message.parts[0] as { text: string }).text } };
      yield { type: "end", finish_reason: "stop", usage: resp.usage };
    },
  };
}

function makeLM(): UniversalLM {
  const lm = new UniversalLM();
  lm.register(echoAdapter());
  return lm;
}

describe("Model", () => {
  it("calls and returns text", async () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo" });
    const text = await m.call("hello").text;
    assert.ok(text?.includes("hello"));
  });

  it("remembers conversation history", async () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo" });
    await m.call("first").text;
    await m.call("second").text;
    assert.equal(m.history.length, 2);
  });

  it("clears history", async () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo" });
    await m.call("first").text;
    m.clearHistory();
    assert.equal(m.history.length, 0);
  });

  it("copies with overrides", () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo", system: "original" });
    const copy = m.copy({ system: "override" });
    assert.equal(copy.system, "override");
    assert.equal(m.system, "original");
    assert.equal(copy.model, "echo-1");
  });

  it("streams text", async () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo" });
    const chunks: string[] = [];
    for await (const text of m.call("hello")) {
      chunks.push(text);
    }
    assert.ok(chunks.length > 0);
    assert.ok(chunks.join("").includes("hello"));
  });

  it("streams events", async () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo" });
    const types: string[] = [];
    for await (const event of m.call("hello").events()) {
      types.push(event.type);
    }
    assert.ok(types.includes("text"));
    assert.ok(types.includes("finished"));
  });

  it("prepares a request without sending", () => {
    const m = new Model({ lm: makeLM(), model: "echo-1", provider: "echo", system: "test" });
    const req = m.prepare("hello");
    assert.equal(req.model, "echo-1");
    assert.equal(req.system, "test");
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
  });
});
