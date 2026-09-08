import { test } from "node:test";
import assert from "node:assert/strict";
import { Config, Request, Tool, ToolChoice, Reasoning, CacheConfig, tool } from "../src/types/config.ts";
import { Message, Part, image, text, toolCall, toolResult } from "../src/types/parts.ts";
import { Response, Usage } from "../src/types/response.ts";
import { Delta, StreamEvent } from "../src/types/stream.ts";
import { RawNumber, stringifyJson } from "../src/json.ts";
import { ValueError } from "../src/types/validate.ts";

test("INV-003: a bool is never a number", () => {
  assert.throws(() => Config.create({ maxTokens: true as unknown as number }), TypeError);
  assert.throws(() => Config.create({ temperature: false as unknown as number }), TypeError);
  assert.throws(() => Usage.create({ inputTokens: true as unknown as number }), TypeError);
});

test("INV-007: int fields take a same-valued float lexeme and reject the rest", () => {
  assert.equal(Config.fromJSON({ max_tokens: new RawNumber("2.0") }).maxTokens, 2);
  assert.throws(() => Config.create({ maxTokens: 2.5 }), TypeError);
  assert.throws(() => Config.create({ topK: 0 }), ValueError);
});

test("Number rule on the wire: temperature 1 is emitted as 1.0, max_tokens 2.0 as 2", () => {
  const out = Config.toJSON(Config.create({ temperature: 1, maxTokens: 2 }));
  assert.equal(stringifyJson(out), '{"max_tokens":2,"temperature":1.0}');
});

test("INV-011/012: media parts take exactly one source and base64-shaped data", () => {
  assert.throws(() => Part.create({ type: "image", url: "u", data: "QUJD" }), ValueError);
  assert.throws(() => Part.create({ type: "image" }), ValueError);
  assert.throws(() => Part.create({ type: "image", data: "not base64!" }), ValueError);
  const p = image({ data: "data:image/png;base64,QU JD\n", mediaType: "image/png" });
  assert.equal(p.data, "data:image/png;base64,QU JD\n"); // stored as given; validated after stripping
  assert.equal((Part.create({ type: "audio", url: "https://x" }) as { mediaType?: string }).mediaType, "audio/wav");
});

test("INV-013/014: tool results are non-empty and presentational", () => {
  assert.throws(() => toolResult("c1", []), ValueError);
  assert.throws(() => Part.create({ type: "tool_result", id: "c1", content: [toolCall("x", "y", {})] }), TypeError);
  assert.deepEqual(toolResult("c1", "").content[0], text("")); // INV-014: an empty OUTPUT is one empty TextPart
});

test("INV-020/021/022-024: factories normalize and roles are checked", () => {
  assert.equal(Message.user("hi").parts.length, 1);
  assert.equal(Message.user(["a", text("b")]).parts.length, 2);
  assert.throws(() => Message.user([]), ValueError);
  assert.throws(() => Message.create({ role: "user", parts: "text" }), TypeError);
  assert.throws(() => Message.user([toolCall("c", "n", {})] as never), TypeError);
  assert.throws(() => Message.assistant([toolResult("c", "x")] as never), TypeError);
  assert.throws(() => Message.create({ role: "tool", parts: [text("x")] }), TypeError);
  assert.equal(Config.create({ stop: "END" as unknown as string[] }).stop?.[0], "END");
});

test("INV-025: Message.tool map form", () => {
  const m = Message.tool({ c1: "one", c2: [text("two")] });
  assert.equal(m.parts.length, 2);
  assert.equal((m.parts[0] as { id: string }).id, "c1");
  assert.throws(() => Message.tool("c1"), TypeError);
});

test("INV-026/027/028: off forbids dead knobs", () => {
  assert.throws(() => Reasoning.create({ effort: "off", thinkingBudget: 10 }), ValueError);
  assert.throws(() => CacheConfig.create({ mode: "off", key: "k" }), ValueError);
  assert.throws(() => CacheConfig.create({ prefix: "stable", prefixUntilIndex: 1 }), ValueError);
  assert.throws(() => ToolChoice.create({ mode: "none", parallel: true }), ValueError);
});

test("INV-029: total_tokens auto-sums only when both primaries are present; absent is not zero", () => {
  assert.equal(Usage.create({ inputTokens: 1, outputTokens: 2 }).totalTokens, 3);
  assert.equal(Usage.create({ inputTokens: 1 }).totalTokens, undefined);
  assert.equal(Usage.create({ inputTokens: 1, outputTokens: 2, totalTokens: 10 }).totalTokens, 10);
  assert.deepEqual(Usage.toJSON(Usage.create({})), {});
});

test("INV-030/031: unique tool names; allowed ⊆ tools", () => {
  const t = tool("a");
  assert.throws(() => Request.create({ model: "m", messages: [Message.user("x")], tools: [t, t] }), ValueError);
  assert.throws(() => Request.create({ model: "m", messages: [Message.user("x")], tools: [t], config: { toolChoice: { allowed: ["b"] } } }), ValueError);
});

test("INV-033: parameters is required-with-shape; an explicit {} round-trips as {}", () => {
  assert.deepEqual(Tool.toJSON(Tool.fromJSON({ type: "function", name: "f", parameters: {} })), { type: "function", name: "f", parameters: {} });
  assert.deepEqual(Tool.toJSON(Tool.fromJSON({ name: "f" })), { type: "function", name: "f", parameters: { type: "object", properties: {} } });
  assert.equal(Tool.fromJSON({ type: "builtin", name: "web_search" }).type, "builtin");
});

test("INV-042: a present non-object config nest is a TypeError; telemetry nests stay lenient", () => {
  assert.throws(() => Config.fromJSON({ tool_choice: "auto" }), TypeError);
  assert.equal(Config.fromJSON({ tool_choice: null }).toolChoice, undefined);
  assert.deepEqual(Response.fromJSON({ model: "m", message: { role: "assistant", parts: [{ type: "text", text: "x" }] }, finish_reason: "stop", usage: "junk" }).usage, {});
});

test("INV-045: omitted optional fields read back as their defaults", () => {
  assert.equal((Delta.fromJSON({ type: "text", text: "x" }) as { partIndex: number }).partIndex, 0);
  assert.equal(ToolChoice.fromJSON({}).mode, "auto");
  assert.equal(Part.fromJSON({ type: "tool_result", id: "c", content: "out" }).type, "tool_result");
  assert.deepEqual(Part.fromJSON({ type: "tool_call", id: "c", name: "n" }), toolCall("c", "n", {}));
});

test("INV-050: response_format has exactly two shapes", () => {
  assert.throws(() => Config.create({ responseFormat: { format: "json" } as never }), ValueError);
  assert.throws(() => Config.create({ responseFormat: { type: "json_schema" } as never }), ValueError);
  assert.throws(() => Config.create({ responseFormat: { type: "json_object", schema: {} } as never }), ValueError);
  assert.ok(Config.create({ responseFormat: { type: "json_schema", schema: { type: "object" }, strict: true } }));
});

test("omission rule: the same part serializes identically standalone and nested", () => {
  const part = toolCall("c1", "f", { x: {}, y: "", z: [] });
  const direct = Part.toJSON(part);
  const nested = (Request.toJSON(Request.create({ model: "m", messages: [Message.assistant([part])] }))["messages"] as Array<{ parts: unknown[] }>)[0]!.parts[0];
  assert.deepEqual(nested, direct);
  assert.deepEqual(direct["input"], { x: {}, y: "", z: [] }); // opaque payload untouched
});

test("stream end event omits an empty usage; false store is emitted", () => {
  assert.deepEqual(StreamEvent.toJSON({ type: "end", usage: {} }), { type: "end" });
  assert.deepEqual(Config.toJSON(Config.create({ store: false, logprobs: 0 })), { store: false, logprobs: 0 });
});

test("Response accessors: text, toolCalls, parseJson", () => {
  const r = new Response({
    model: "m",
    message: { role: "assistant", parts: [text('{"a": 1}'), { type: "citation", url: "https://x" }] },
    finishReason: "stop",
  });
  assert.equal(r.text, '{"a": 1}');
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(r.citations.length, 1);
  assert.equal(r.toolCalls.length, 0);
});
