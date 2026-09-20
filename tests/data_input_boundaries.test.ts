import test from "node:test";
import assert from "node:assert/strict";
import { data, Message, toolCall, toolResult } from "../src/types/parts.ts";
import { LiveClientEvent } from "../src/types/live.ts";
import { judgments } from "../src/judgments.ts";
import { parseJson } from "../src/json.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { TypeSafeLM } from "../src/dialects/typesafe.ts";
import { StreamAccumulator } from "../src/stream.ts";

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) yield* strings(item);
}

test("unmeasured data is legal tool and live input; measurements belong only to answers", () => {
  const part = data({ count: 1 });
  assert.deepEqual(toolResult("call", part).content, [part]);
  assert.equal(LiveClientEvent.create({ type: "tool_result", id: "call", content: [part] }).type, "tool_result");
  assert.equal(LiveClientEvent.create({ type: "turn", parts: [part] }).type, "turn");
  const measured = data({ q: true }, { probabilities: { q: { true: 0.7, false: 0.3 } }, method: "provider_classification" });
  assert.throws(() => toolResult("call", measured), /assistant/);
  assert.throws(() => LiveClientEvent.create({ type: "tool_result", id: "call", content: [measured] }), /assistant/);
  assert.throws(() => LiveClientEvent.create({ type: "turn", parts: [measured] }), /assistant/);
});

for (const Adapter of [OpenAILM, OpenAIChatLM, AnthropicLM, GeminiLM]) {
  test(`${Adapter.name}: tool data reaches the text wire as its compact JSON`, async () => {
    const wire = await new Adapter({ apiKey: "synthetic-key" }).buildRequest({
      model: "test-model", messages: [Message.user("count"), Message.assistant(toolCall("call", "count", {})), Message.tool(toolResult("call", data({ count: 1 }), { name: "count" }))],
    }, false);
    assert.ok([...strings(parseJson(new TextDecoder().decode(wire.body)))].includes('{"count":1}'));
  });
}

test("TypeSafe ordered titles are not sent as native score criteria", async () => {
  const wire = await new TypeSafeLM({ apiKey: "synthetic-key" }).buildRequest({
    model: "jev-test", messages: [Message.user("state")], config: {
      responseFormat: judgments({ q: { type: "integer", description: "Rate it", anyOf: [{ const: 0, title: "LOW" }, { const: 1, title: "HIGH" }] } }),
    },
  }, false);
  const body = JSON.parse(new TextDecoder().decode(wire.body));
  assert.deepEqual(body.questions.q.criteria, ["0", "1"]);
});

test("TypeSafe preserves explicit passthrough but refuses multiple answers", async () => {
  const lm = new TypeSafeLM({ apiKey: "synthetic-key" });
  const request = { model: "jev-test", messages: [Message.user("state")], config: { responseFormat: judgments({ q: { type: "boolean" } }), extensions: { state: "explicit override" } } };
  const wire = await lm.buildRequest(request, false);
  assert.equal(JSON.parse(new TextDecoder().decode(wire.body)).state, "explicit override");
  await assert.rejects(lm.buildRequest({ ...request, config: { ...request.config, extensions: { n: 2 } } }, false), (error: unknown) => {
    assert.ok(error instanceof Error && "feature" in error);
    assert.equal(error.feature, "config.extensions.n");
    return true;
  });
});

test("streamed judgments materialize as DataPart without inventing probabilities", () => {
  const acc = new StreamAccumulator({ model: "m", messages: [Message.user("state")], config: { responseFormat: judgments({ q: { type: "boolean" } }) } });
  acc.push({ type: "delta", delta: { type: "text", text: '{"q":' } });
  assert.equal(acc.response().message.parts[0]!.type, "text");
  acc.push({ type: "delta", delta: { type: "text", text: 'true}' } });
  acc.push({ type: "end", finishReason: "stop" });
  const part = acc.response().message.parts[0]!;
  assert.equal(part.type, "data");
  if (part.type !== "data") throw new Error("expected a data part");
  assert.deepEqual(part.value, { q: true });
  assert.equal(part.probabilities, undefined);
  const ordinary = new StreamAccumulator({ model: "m", messages: [Message.user("state")], config: { responseFormat: { type: "json_object" } } });
  ordinary.push({ type: "delta", delta: { type: "text", text: '{"q":true}' } });
  assert.equal(ordinary.response().message.parts[0]!.type, "text");
});
