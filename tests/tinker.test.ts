/**
 * Tinker (Thinking Machines): the two doors, the reasoning switch per base
 * family, a checkpoint that follows its declared base model, URI model names,
 * FastAPI error bodies (MAP-21), the stop sequence returned in the text
 * (MAP-22) and the catalog's fine-tune origin (MAP-23). lm15-contract
 * changes/2026-11-09-tinker-live.md; the corpus pins the same rules through
 * the harness, these tests keep them visible here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { AuthError, InvalidRequestError, UnknownModelError, UnsupportedModelError, detailMessage } from "../src/errors.ts";
import { PROVIDERS } from "../src/registry.ts";
import { LMRouter, openaiChatModelString, resolveModel } from "../src/router.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

const CK = "tinker://e68146d2-1a2e-56e8-b42f-1f5957705501:train:0/sampler_weights/lm15-untrained";
const user = (text: string) => [Message.user(text)];

function chat(opts: { baseModels?: Record<string, string>; transport?: FakeTransport } = {}): OpenAIChatLM {
  return new OpenAIChatLM({ apiKey: "k", compat: "tinker", access: PROVIDERS.get("tinker")!.access, transport: opts.transport ?? new FakeTransport([]), ...(opts.baseModels ? { baseModels: opts.baseModels } : {}) });
}

async function wire(lm: OpenAIChatLM, model: string, config: Record<string, unknown>) {
  const built = await lm.build({ model, messages: user("hi"), config } as never, false);
  return { body: JSON.parse(new TextDecoder().decode(built.request.body)) as Record<string, unknown>, adaptations: built.adaptations };
}

test("two doors, one key; the alias names the chat door", () => {
  const c = PROVIDERS.get("tinker")!, m = PROVIDERS.get("tinker-anthropic")!;
  assert.deepEqual(c.access.envKeys, ["TINKER_API_KEY"]);
  assert.deepEqual(m.access.envKeys, ["TINKER_API_KEY"]);
  assert.equal(c.access.baseUrl, "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1");
  assert.equal(m.access.baseUrl, "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1");
  assert.deepEqual(c.aliases, ["thinkingmachines"]);
});

test("a URI is one name; aliases route", () => {
  for (const [model, provider, wireModel] of [
    [CK, "tinker", CK], [`tinker:${CK}`, "tinker", CK], [`tinker-anthropic:${CK}`, "tinker-anthropic", CK],
    [`thinkingmachines:${CK}`, "tinker", CK], ["thinkingmachines:Qwen/Qwen3-8B", "tinker", "Qwen/Qwen3-8B"],
  ] as const) {
    const r = resolveModel(model, { env: {} });
    assert.deepEqual([r.provider, r.model], [provider, wireModel], model);
  }
  assert.throws(() => resolveModel("openai://x", { env: {} }), UnknownModelError);
  assert.equal(openaiChatModelString("thinkingmachines/Qwen/Qwen3-8B"), "tinker:Qwen/Qwen3-8B");
});

test("reasoning off per family, and a checkpoint's default", async () => {
  const lm = chat();
  for (const [model, off] of [
    ["thinkingmachines/Inkling-Small", "none"], ["Qwen/Qwen3.5-4B", false], ["moonshotai/Kimi-K2.6", false],
    ["nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16", false], ["Qwen/Qwen3.8-27B", false],
    ["deepseek-ai/DeepSeek-V4.1-Flash:peft:262144", false], [CK, false],
  ] as const) {
    const { body, adaptations } = await wire(lm, model, { reasoning: { effort: "off" } });
    assert.equal(body["reasoning_effort"], off, model);
    assert.equal(adaptations.length, 0, model);
  }
});

test("an effort word on a switch is on, recorded; words elsewhere are verbatim", async () => {
  const { body, adaptations } = await wire(chat(), "Qwen/Qwen3.5-4B", { reasoning: { effort: "high" } });
  assert.equal(body["reasoning_effort"], true);
  assert.deepEqual([adaptations[0]!.field, adaptations[0]!.action, adaptations[0]!.asked, adaptations[0]!.applied], ["config.reasoning.effort", "substituted", "high", "on"]);
  for (const model of ["thinkingmachines/Inkling", "openai/gpt-oss-20b", CK]) {
    assert.equal((await wire(chat(), model, { reasoning: { effort: "low" } })).body["reasoning_effort"], "low", model);
  }
});

test("a checkpoint follows its declared base model, directly and through the router", async () => {
  assert.equal((await wire(chat({ baseModels: { [CK]: "thinkingmachines/Inkling-Small" } }), CK, { reasoning: { effort: "off" } })).body["reasoning_effort"], "none");
  const viaQwen = await wire(chat({ baseModels: { [CK]: "Qwen/Qwen3.5-4B" } }), CK, { reasoning: { effort: "medium" } });
  assert.equal(viaQwen.body["reasoning_effort"], true);
  const router = new LMRouter({ env: { TINKER_API_KEY: "k" }, baseModels: { [CK]: "thinkingmachines/Inkling" } });
  const lm = router.lm(CK) as OpenAIChatLM;
  assert.deepEqual(lm.baseModels, { [CK]: "thinkingmachines/Inkling" });
  assert.equal((await wire(lm, CK, { reasoning: { effort: "off" } })).body["reasoning_effort"], "none");
  assert.throws(() => new LMRouter({ baseModels: { [CK]: "" } }), TypeError);
});

test("response_format is dropped and recorded", async () => {
  for (const fmt of [{ type: "json_object" }, { type: "json_schema", name: "x", schema: { type: "object" } }]) {
    const { body, adaptations } = await wire(chat(), "thinkingmachines/Inkling", { responseFormat: fmt });
    assert.equal(body["response_format"], undefined);
    assert.deepEqual(adaptations.map((a) => [a.field, a.action]), [["config.response_format", "dropped"]]);
  }
});

const reply = (text: string) => JSON.stringify({
  id: "x", object: "chat.completion", model: "thinkingmachines/Inkling-Small",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } },
});

test("MAP-22: the returned stop sequence is cut, complete and stream, both doors", async () => {
  const transport = new FakeTransport([new FakeResponse({ body: reply("1 2 3 4 5 6 7") })]);
  const response = await chat({ transport }).complete({ model: "thinkingmachines/Inkling-Small", messages: user("count"), config: { stop: [" 7"] } } as never);
  assert.equal(response.text, "1 2 3 4 5 6");
  const sse = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "1 2 3 4 5 6 7" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
  ].map((f) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", ...f })}\n\n`).join("") + "data: [DONE]\n\n";
  const streamed = chat({ transport: new FakeTransport([new FakeResponse({ body: sse, headers: [["content-type", "text/event-stream"]] })]) });
  let text = "";
  for await (const e of streamed.stream({ model: "thinkingmachines/Inkling-Small", messages: user("count"), config: { stop: [" 7"] } } as never)) {
    if (e.type === "delta" && e.delta.type === "text") text += e.delta.text;
  }
  assert.equal(text, "1 2 3 4 5 6");
  const anth = new AnthropicLM({ apiKey: "k", compat: "tinker", access: PROVIDERS.get("tinker-anthropic")!.access, transport: new FakeTransport([new FakeResponse({ body: JSON.stringify({
    id: "msg", type: "message", role: "assistant", model: "thinkingmachines/Inkling-Small", content: [{ type: "text", text: "1 2 3 4 5 6 7" }],
    stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 15, cache_creation_input_tokens: 26, cache_read_input_tokens: 0 },
  }) })]) });
  const r = await anth.complete({ model: "thinkingmachines/Inkling-Small", messages: user("count"), config: { stop: [" 7"], maxTokens: 50 } } as never);
  assert.equal(r.text, "1 2 3 4 5 6");
  const plain = new OpenAIChatLM({ apiKey: "k", compat: "openai", transport: new FakeTransport([new FakeResponse({ body: reply("a END b") })]) });
  assert.equal((await plain.complete({ model: "gpt-4.1-mini", messages: user("x"), config: { stop: ["END"] } } as never)).text, "a END b");
});

test("MAP-21 and MAP-15: FastAPI detail bodies keep their message and their class", () => {
  const lm = chat();
  const cases: [number, unknown, Function, string | undefined][] = [
    [401, { detail: "Unable to validate api-key" }, AuthError, undefined],
    [404, { detail: `Weights not found for model_path ${CK}` }, UnsupportedModelError, `Weights not found for model_path ${CK}`],
    [400, { detail: "Sampling is not supported for lm15/none. (organization: x)" }, UnsupportedModelError, undefined],
    [400, { detail: "model_path 'tinker://not-a-path' is not a valid tinker path. Expected a checkpoint path" }, UnsupportedModelError, undefined],
    [422, { detail: "Validation Error", errors: [{ loc: "body -> messages -> 0 -> role", msg: "Input should be 'system'", type: "literal_error" }] }, InvalidRequestError,
      "Validation Error: body -> messages -> 0 -> role: Input should be 'system'"],
  ];
  for (const [status, body, cls, message] of cases) {
    const err = lm.normalizeError(status, JSON.stringify(body));
    assert.equal(err.constructor, cls, JSON.stringify(body));
    if (message) assert.equal(err.message.split("\n")[0], message);
  }
  assert.equal(detailMessage({ detail: [{ loc: ["body", "messages", 0], msg: "field required" }] }), "body -> messages -> 0: field required");
  const anth = new AnthropicLM({ apiKey: "k", compat: "tinker", access: PROVIDERS.get("tinker-anthropic")!.access });
  assert.ok(anth.normalizeError(404, JSON.stringify({ detail: `Weights not found for model_path ${CK}` })) instanceof UnsupportedModelError);
});

test("MAP-23: the catalog names each checkpoint's base model", async () => {
  const body = JSON.stringify({ object: "list", data: [{ id: CK, object: "model", created: 1, owned_by: "x", base_model: "Qwen/Qwen3.5-4B" }] });
  const models = await chat({ transport: new FakeTransport([new FakeResponse({ body })]) }).listModels();
  assert.equal(models.length, 1);
  assert.deepEqual([models[0]!.id, models[0]!.provider, models[0]!.origin?.type, models[0]!.origin?.baseModel], [CK, "tinker", "fine-tune", "Qwen/Qwen3.5-4B"]);
});
