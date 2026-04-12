import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Result } from "../result.js";
import { Part, Message, EMPTY_USAGE } from "../types.js";
import type { LMRequest, LMResponse, StreamEvent } from "../types.js";

function makeRequest(model = "test-model"): LMRequest {
  return { model, messages: [Message.user("hello")] };
}

function makeTextStream(text: string): (req: LMRequest) => AsyncIterable<StreamEvent> {
  return async function* () {
    yield { type: "start", id: "r1", model: "test-model" };
    yield { type: "delta", part_index: 0, delta: { type: "text", text } };
    yield { type: "end", finish_reason: "stop", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
  };
}

describe("Result", () => {
  it("resolves text on await", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("Hello!"),
    });
    const text = await result.text;
    assert.equal(text, "Hello!");
  });

  it("streams text chunks", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("Hello!"),
    });
    const chunks: string[] = [];
    for await (const text of result) {
      chunks.push(text);
    }
    assert.deepEqual(chunks, ["Hello!"]);
  });

  it("streams events", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("Hi"),
    });
    const types: string[] = [];
    for await (const event of result.events()) {
      types.push(event.type);
    }
    assert.deepEqual(types, ["text", "finished"]);
  });

  it("resolves usage", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("Hi"),
    });
    const usage = await result.usage;
    assert.equal(usage.input_tokens, 5);
    assert.equal(usage.output_tokens, 3);
  });

  it("resolves finish_reason", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("Hi"),
    });
    assert.equal(await result.finishReason, "stop");
  });

  it("auto-executes tools", async () => {
    const result = new Result({
      request: { ...makeRequest(), tools: [{ type: "function", name: "greet", parameters: { type: "object", properties: {} } }] },
      startStream: async function* () {
        yield { type: "start", id: "r1", model: "test" };
        yield { type: "delta", part_index: 0, delta: { type: "tool_call", id: "c1", name: "greet", input: "{}" } };
        yield { type: "end", finish_reason: "tool_call", usage: EMPTY_USAGE };
      },
      callableRegistry: {
        greet: () => "Hi there!",
      },
      maxToolRounds: 1,
    });

    // It should call greet, then fail to get a follow-up stream since
    // the second round will get the same tool call. But it should execute the tool.
    const events: string[] = [];
    for await (const e of result.events()) {
      events.push(e.type);
    }
    // Should see: tool_call, tool_result, then... it loops and we'd need
    // a second stream that returns text. Let's verify tool_call appeared.
    assert.ok(events.includes("tool_call"));
    assert.ok(events.includes("tool_result"));
  });

  it("calls onFinished callback", async () => {
    let called = false;
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream("ok"),
      onFinished: () => { called = true; },
    });
    await result.text;
    assert.ok(called);
  });

  it("parses JSON from response", async () => {
    const result = new Result({
      request: makeRequest(),
      startStream: makeTextStream('{"name": "Alice", "age": 30}'),
    });
    const data = await result.json as { name: string; age: number };
    assert.equal(data.name, "Alice");
    assert.equal(data.age, 30);
  });
});
