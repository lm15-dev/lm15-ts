import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniversalLM } from "../client.js";
import { ProviderError, UnsupportedFeatureError } from "../errors.js";
import type { LMAdapter } from "../providers/base.js";
import { Part, Message, EMPTY_USAGE } from "../types.js";
import type { LMRequest, LMResponse, StreamEvent } from "../types.js";

function echoAdapter(): LMAdapter {
  return {
    provider: "echo",
    supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false },
    manifest: { provider: "echo", supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false }, envKeys: [] },
    async complete(request: LMRequest): Promise<LMResponse> {
      const text = request.messages
        .flatMap(m => m.parts)
        .filter(p => p.type === "text")
        .map(p => (p as { text: string }).text)
        .join("\n");
      return {
        id: "echo-1",
        model: request.model,
        message: { role: "assistant", parts: [Part.text(text)] },
        finish_reason: "stop",
        usage: EMPTY_USAGE,
      };
    },
    async *stream(request: LMRequest): AsyncIterable<StreamEvent> {
      const resp = await this.complete(request);
      yield { type: "start", id: resp.id, model: resp.model };
      for (const part of resp.message.parts) {
        if (part.type === "text") {
          yield { type: "delta", part_index: 0, delta: { type: "text", text: (part as { text: string }).text } };
        }
      }
      yield { type: "end", finish_reason: "stop", usage: EMPTY_USAGE };
    },
  };
}

describe("UniversalLM", () => {
  it("registers and routes to adapter", async () => {
    const lm = new UniversalLM();
    lm.register(echoAdapter());

    const resp = await lm.complete(
      { model: "echo-1", messages: [Message.user("ping")] },
      "echo",
    );
    assert.equal(resp.message.parts[0].type, "text");
    assert.equal((resp.message.parts[0] as { text: string }).text, "ping");
  });

  it("throws on unknown provider", async () => {
    const lm = new UniversalLM();
    await assert.rejects(
      () => lm.complete({ model: "x", messages: [Message.user("hi")] }, "nope"),
      ProviderError,
    );
  });

  it("streams events", async () => {
    const lm = new UniversalLM();
    lm.register(echoAdapter());

    const events: StreamEvent[] = [];
    for await (const e of lm.stream({ model: "echo-1", messages: [Message.user("hi")] }, "echo")) {
      events.push(e);
    }
    assert.ok(events.some(e => e.type === "start"));
    assert.ok(events.some(e => e.type === "delta"));
    assert.ok(events.some(e => e.type === "end"));
  });
});
