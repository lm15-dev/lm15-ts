/**
 * MAP-12: requestFromOpenAIChat — what the contract deliberately does not
 * pin: the malformed-input class (ValueError / TypeError, MAP-12 rule 6),
 * the preset-conditioned rows, and the build→ingest identity on a rich
 * request. The corpus round trip lives in contract_corpus.test.ts.
 */
// These tests import lm15 internals; the Node host is installed here as the `lm15` entry does on import.
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIChatLM, requestFromOpenAIChat } from "../src/dialects/openai_chat.ts";
import { UnsupportedFeatureError } from "../src/errors.ts";
import { parseJson } from "../src/json.ts";
import { Request } from "../src/types/config.ts";
import { ValueError } from "../src/types/validate.ts";

const USER = [{ role: "user", content: "Hi" }];
const body = (extra: Record<string, unknown> = {}) => ({ model: "gpt-5-mini", messages: USER, ...extra });

test("ingest: refused keys name the key; an unknown key is refused, never dropped; spellings translate (MAP-13)", () => {
  for (const extra of [{ n: 2 }, { audio: { voice: "alloy" } }, { never_heard_of_it: 1 }]) {
    const key = Object.keys(extra)[0]!;
    assert.throws(() => requestFromOpenAIChat(body(extra)), (e: unknown) => e instanceof UnsupportedFeatureError && e.message.includes(key));
  }
  // top_k is canonical (the builder drops it with a record); functions / function_call are a spelling of tools / tool_choice.
  assert.equal(requestFromOpenAIChat(body({ top_k: 3 })).config?.topK, 3);
  const legacy = requestFromOpenAIChat(body({ functions: [{ name: "lookup", parameters: { type: "object", properties: {} } }], function_call: { name: "lookup" } }));
  assert.deepEqual(legacy.tools?.map((t) => t.name), ["lookup"]);
  assert.deepEqual(legacy.config?.toolChoice, { mode: "required", allowed: ["lookup"] });
  assert.throws(() => requestFromOpenAIChat(body({ functions: [], tools: [] })), ValueError);
});

test("ingest: preset-conditioned spellings", () => {
  const b = body({ reasoning: { effort: "low" } });
  assert.equal(requestFromOpenAIChat(b, { compat: "openrouter" }).config?.reasoning?.effort, "low");
  assert.throws(() => requestFromOpenAIChat(b), UnsupportedFeatureError);
  const thinking = body({ thinking: { type: "disabled" } });
  assert.equal(requestFromOpenAIChat(thinking, { compat: "deepseek" }).config?.reasoning?.effort, "off");
  assert.throws(() => requestFromOpenAIChat(thinking), UnsupportedFeatureError);
});

test("ingest: the method form uses the adapter's compat", () => {
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "groq" });
  const req = lm.requestFromOpenAIChat(body({ tools: [{ type: "browser_search" }] }));
  assert.deepEqual(req.tools, [{ type: "builtin", name: "web_search" }]);
  assert.throws(() => requestFromOpenAIChat(body({ tools: [{ type: "browser_search" }] })), UnsupportedFeatureError);
});

test("ingest: malformed input is ValueError / TypeError, not a refusal", () => {
  const cases: Array<[unknown, typeof ValueError | typeof TypeError]> = [
    [{ model: "", messages: USER }, ValueError],
    [{ model: "m" }, ValueError],
    [{ model: "m", messages: "hi" }, TypeError],
    [{ model: "m", messages: [{ role: "narrator", content: "x" }] }, ValueError],
    [{ model: "m", messages: [{ role: "tool", content: "x" }] }, TypeError],
    [{ model: "m", messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "f", arguments: "not json" } }] }] }, ValueError],
    [{ model: "m", messages: USER, max_tokens: 1, max_completion_tokens: 2 }, ValueError],
    [{ model: "m", messages: USER, user: "a", safety_identifier: "b" }, ValueError],
    [{ model: "m", messages: USER, top_logprobs: 3 }, ValueError],
    [{ model: "m", messages: USER, tool_choice: { type: "function", function: { name: "ghost" } } }, ValueError],
    [[], TypeError],
  ];
  for (const [bad, cls] of cases) assert.throws(() => requestFromOpenAIChat(bad), cls, JSON.stringify(bad));
});

test("ingest: build then ingest is the identity on a rich request", async () => {
  const request = Request.fromJSON(parseJson(JSON.stringify({
    model: "gpt-5-mini",
    system: "Be brief.",
    messages: [
      { role: "user", parts: [{ type: "text", text: "Weather in Paris and Lyon?" }] },
      { role: "assistant", parts: [
        { type: "tool_call", id: "c1", name: "w", input: { city: "Paris" } },
        { type: "tool_call", id: "c2", name: "w", input: { city: "Lyon" } }] },
      { role: "tool", parts: [
        { type: "tool_result", id: "c1", content: [{ type: "text", text: "18C" }] },
        { type: "tool_result", id: "c2", content: [{ type: "text", text: "21C" }] }] },
      { role: "user", parts: [{ type: "text", text: "Thanks" }] },
    ],
    tools: [{ type: "function", name: "w", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    config: { max_tokens: 100, temperature: 0.5, top_p: 0.9, stop: ["END"], logprobs: 2,
      response_format: { type: "json_schema", schema: { type: "object" }, name: "Out", strict: true },
      tool_choice: { mode: "auto", parallel: false }, reasoning: { effort: "low" },
      service_tier: "flex", user_id: "u", store: false, seed: 7 },
  })) as Parameters<typeof Request.fromJSON>[0]);
  const lm = new OpenAIChatLM({ apiKey: "k" });
  const wire = await lm.buildRequest(request, false);
  const back = lm.requestFromOpenAIChat(parseJson(new TextDecoder().decode(wire.body)));
  assert.deepEqual(Request.toJSON(back), Request.toJSON(request));
});
