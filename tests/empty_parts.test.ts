/**
 * MAP-24: a part with nothing for a wire writes nothing (lm15-contract
 * changes/2026-11-11-empty-parts.md, issue #3).
 *
 * The contract's vectors (mapping/empty-parts.json) and the history replay pin the bytes for the four
 * dialects through the vet shim. These pin what they do not: nothing is recorded, the caller's request
 * is not touched, the state comes back on its own dialect, Gemini's cached prefix follows the rule.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { FakeTransport } from "../src/testing.ts";
import { Message, type AssistantPart, type ToolResultContentPart } from "../src/types/parts.ts";
import { isEmptyTextBlock, partsToText } from "../src/wire.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import type { JsonObject } from "../src/json.ts";
import type { Request } from "../src/types/config.ts";

installNodePlatform();

// What lm15 reads from a Responses reasoning item with no summary (MAP-7 rules 9 and 11).
const HIDDEN: AssistantPart = { type: "thinking", text: "", continuation: [{ provider: "openai", kind: "reasoning_item", data: { id: "rs_1", encrypted_content: "gAAAA" } }] };
const CALL: AssistantPart = { type: "tool_call", id: "call_1", name: "delete_program", input: {} };
const RESULT = Message.tool([{ type: "tool_result", id: "call_1", name: "delete_program", content: [{ type: "text", text: "ok" }] }]);

/** The history of issue #3: two steps answered by an OpenAI Responses model with hidden reasoning, then a new user message. */
const report = (model: string): Request => ({
  model,
  messages: [
    Message.user("Delete the test program now."),
    Message.assistant([HIDDEN, CALL]),
    RESULT,
    Message.assistant([HIDDEN, { type: "text", text: "Deleted." }]),
    Message.user("hello"),
  ],
});

const opts = () => ({ apiKey: "k", transport: new FakeTransport([]) });
const anthropic = (request: Request) => new AnthropicLM(opts()).payload(request, false);

test("the report builds a body Claude accepts", () => {
  const wire = anthropic(report("claude-opus-5-5"))["messages"] as JsonObject[];
  assert.deepEqual(wire.map((m) => m["role"]), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(wire[1]!["content"], [{ type: "tool_use", id: "call_1", name: "delete_program", input: {} }]);
  assert.deepEqual(wire[3]!["content"], [{ type: "text", text: "Deleted." }]);
  assert.equal(JSON.stringify(wire).includes('"text":""'), false);
});

test("nothing is recorded under any policy, and the caller's history is not touched", async () => {
  for (const [make, model] of [
    [(adaptations: "note" | "silent" | "refuse") => new AnthropicLM({ ...opts(), adaptations }), "claude-opus-5-5"],
    [(adaptations: "note" | "silent" | "refuse") => new GeminiLM({ ...opts(), adaptations }), "gemini-2.5-flash"],
    [(adaptations: "note" | "silent" | "refuse") => new OpenAIChatLM({ ...opts(), adaptations }), "gpt-5.4"],
  ] as const) {
    const request = report(model);
    const before = JSON.stringify(request);
    for (const policy of ["note", "silent", "refuse"] as const) {
      const lm = make(policy);
      assert.deepEqual((await lm.plan(request)).filter((a) => a.field.startsWith("messages")), [], `${model} ${policy}`);
    }
    assert.equal(JSON.stringify(request), before, model);
    assert.deepEqual(request.messages[1]!.parts[0], HIDDEN);
  }
});

test("the state goes back natively on its own dialect", () => {
  const request = report("gpt-5.4");
  anthropic(report("claude-opus-5-5"));
  const items = new OpenAILM(opts()).payload(request, false)["input"] as JsonObject[];
  assert.deepEqual(items.filter((i) => i["type"] === "reasoning"), [
    { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA", summary: [] },
    { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA", summary: [] },
  ]);
});

test("an empty thinking part with Claude's signature is still a thinking block; a signature with no value is not state", () => {
  const signed = (signature: string): AssistantPart => ({ type: "thinking", text: "", continuation: [{ provider: "anthropic", kind: "thinking_signature", data: { signature } }] });
  const kept = anthropic({ model: "claude-opus-5-5", messages: [Message.user("hi"), Message.assistant([signed("sig"), CALL]), RESULT] });
  assert.deepEqual(((kept["messages"] as JsonObject[])[1]!["content"] as JsonObject[])[0], { type: "thinking", thinking: "", signature: "sig" });
  const dropped = anthropic({ model: "claude-opus-5-5", messages: [Message.user("hi"), Message.assistant([signed(""), { type: "text", text: "Hello." }]), Message.user("again")] });
  assert.deepEqual((dropped["messages"] as JsonObject[])[1]!["content"], [{ type: "text", text: "Hello." }]);
});

test("Gemini's cached prefix leaves the message and the empty system prompt out", async () => {
  const lm = new GeminiLM(opts());
  const prefix: Request = {
    model: "gemini-2.5-flash",
    system: [{ type: "text", text: "" }],
    messages: [Message.user("Here is the manual."), Message.assistant([HIDDEN]), Message.user("And the appendix.")],
  };
  const created = JSON.parse(new TextDecoder().decode((await lm.cacheCreateRequest(prefix)).body)) as JsonObject;
  assert.deepEqual((created["contents"] as JsonObject[]).map((c) => c["role"]), ["user", "user"]);
  assert.equal("systemInstruction" in created, false);
});

test("a cache mark asked on a message left out goes to the one written before it", () => {
  // Not pinned by the contract (stated in the change entry): the reference's choice on the Messages wire.
  const wire = anthropic({
    model: "claude-opus-5-5",
    config: { cache: { prefixUntilIndex: 1 } },
    messages: [Message.user("Here is the manual."), Message.assistant([HIDDEN]), Message.user("And the appendix.")],
  })["messages"] as JsonObject[];
  const last = (m: JsonObject) => (m["content"] as JsonObject[]).at(-1)!;
  assert.equal("cache_control" in last(wire[0]!), true);
  assert.equal("cache_control" in last(wire[1]!), false);
});

test("a tool result keeps its empty output and drops an empty block beside an image", () => {
  const image: ToolResultContentPart = { type: "image", url: "https://example.com/receipt.png", mediaType: "image/png" };
  for (const [content, expected] of [
    [[{ type: "text", text: "" }], ""],
    [[{ type: "text", text: "" }, image], [{ type: "image", source: { type: "url", url: "https://example.com/receipt.png" } }]],
  ] as const) {
    const wire = anthropic({
      model: "claude-opus-5-5",
      messages: [Message.user("hi"), Message.assistant([CALL]), Message.tool([{ type: "tool_result", id: "call_1", name: "delete_program", content: [...content] as ToolResultContentPart[] }])],
    })["messages"] as JsonObject[];
    const block = (wire[2]!["content"] as JsonObject[])[0]!;
    assert.equal(block["type"], "tool_result");
    assert.deepEqual(block["content"], expected);
  }
});

test("text joined for a text-only slot has no line for an empty part; whitespace is content", () => {
  const t = (text: string): AssistantPart => ({ type: "text", text });
  assert.equal(partsToText([t(""), t("a"), t(""), t("b")]), "a\nb");
  assert.equal(partsToText([t("")]), "");
  const wire = anthropic({ model: "claude-opus-5-5", messages: [Message.user("hi"), Message.assistant([t("\n")]), Message.user("again")] })["messages"] as JsonObject[];
  assert.deepEqual(wire[1]!["content"], [{ type: "text", text: "\n" }]);
});

test("the block test reads the three typed spellings only", () => {
  for (const type of ["text", "input_text", "output_text"]) assert.equal(isEmptyTextBlock({ type, text: "" }), true);
  assert.equal(isEmptyTextBlock({ type: "text", text: " " }), false);
  assert.equal(isEmptyTextBlock({ type: "thinking", thinking: "", signature: "s" }), false);
  assert.equal(isEmptyTextBlock({ type: "tool_use", id: "c", name: "f", input: { text: "" } }), false);
});
