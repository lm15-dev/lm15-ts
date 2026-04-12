import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSSE } from "../sse.js";

async function* chunksFrom(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function collect(text: string) {
  const events = [];
  for await (const e of parseSSE(chunksFrom(text))) {
    events.push(e);
  }
  return events;
}

describe("parseSSE", () => {
  it("parses basic events", async () => {
    const events = await collect("data: hello\n\ndata: world\n\n");
    assert.equal(events.length, 2);
    assert.equal(events[0].data, "hello");
    assert.equal(events[1].data, "world");
  });

  it("parses named events", async () => {
    const events = await collect("event: message\ndata: hi\n\n");
    assert.equal(events[0].event, "message");
    assert.equal(events[0].data, "hi");
  });

  it("joins multi-line data", async () => {
    const events = await collect("data: line1\ndata: line2\n\n");
    assert.equal(events[0].data, "line1\nline2");
  });

  it("ignores comments", async () => {
    const events = await collect(": comment\ndata: hi\n\n");
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "hi");
  });

  it("handles [DONE]", async () => {
    const events = await collect("data: {\"text\":\"hi\"}\n\ndata: [DONE]\n\n");
    assert.equal(events.length, 2);
    assert.equal(events[1].data, "[DONE]");
  });
});
