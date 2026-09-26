/**
 * DeepInfra, Together AI, Fireworks AI and Parasail: the registry entries and
 * the compat rules each carries (lm15-contract changes/2026-09-26-inference-
 * hosts-live.md, ratified 2026-09-26; every rule has a receipt under
 * receipts/2026-09-26-<host>/). The contract corpus pins the same rules
 * through the harness; these tests keep them visible in this repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { usageFromChat } from "../src/dialects/openai_shared.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import { PROVIDERS } from "../src/registry.ts";
import { LITELLM_PROVIDER_PREFIXES, LMRouter, openaiChatModelString } from "../src/router.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

const HOSTS: Record<string, [baseUrl: string, envKey: string, litellm: string]> = {
  deepinfra: ["https://api.deepinfra.com/v1/openai", "DEEPINFRA_API_KEY", "deepinfra"],
  together: ["https://api.together.ai/v1", "TOGETHER_API_KEY", "together_ai"],
  fireworks: ["https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY", "fireworks_ai"],
  parasail: ["https://api.parasail.io/v1", "PARASAIL_API_KEY", "parasail"],
};
const WEATHER = { type: "function" as const, name: "get_weather", description: "Get weather.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const user = (text: string) => [Message.user(text)];

async function build(provider: string, request: Parameters<OpenAIChatLM["build"]>[0]) {
  const lm = new OpenAIChatLM({ apiKey: "k", compat: provider, transport: new FakeTransport([]) });
  const built = await lm.build(request, false);
  return { body: JSON.parse(new TextDecoder().decode(built.request.body)) as Record<string, unknown>, adaptations: built.adaptations };
}

const refused = (e: unknown) => e instanceof UnsupportedFeatureError;

for (const [provider, [baseUrl, envKey, litellm]] of Object.entries(HOSTS)) {
  test(`${provider}: registry entry, router prefix, env key, litellm spelling`, () => {
    const entry = PROVIDERS.get(provider)!;
    assert.equal(entry.dialect, "openai-chat");
    assert.equal(entry.access.baseUrl, baseUrl);
    assert.deepEqual([...entry.access.envKeys], [envKey]);
    assert.ok(entry.consoleUrl?.startsWith("https://"));
    const router = new LMRouter({ env: { [envKey]: "k" } });
    const res = router.resolve(`${provider}:vendor/some-model`);
    assert.deepEqual([res.provider, res.model, res.envKey], [provider, "vendor/some-model", envKey]);
    assert.equal(LITELLM_PROVIDER_PREFIXES[litellm], provider);
    assert.equal(openaiChatModelString(`${litellm}/vendor/some-model`), `${provider}:vendor/some-model`);
  });

  test(`${provider}: effort on reasoning_effort, the cap on max_completion_tokens, reasoning replayed as reasoning_content`, async () => {
    const { body } = await build(provider, { model: "vendor/reasoner", messages: user("hi"), config: { maxTokens: 50, reasoning: { effort: "low" } } });
    assert.equal(body["reasoning_effort"], "low");
    assert.equal(body["max_completion_tokens"], 50);
    assert.equal("reasoning" in body, false); // Fireworks answers 400 to the object
    const turn = Message.assistant([{ type: "thinking", text: "Need the tool." }, { type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Paris" } }]);
    const replay = await build(provider, { model: "vendor/m", tools: [WEATHER], messages: [Message.user("Weather?"), turn, Message.tool({ call_1: "Sunny" })] });
    const assistant = (replay.body["messages"] as Record<string, unknown>[])[1]!;
    assert.equal(assistant["reasoning_content"], "Need the tool.");
    assert.equal(assistant["content"], null);
  });
}

test("deepinfra: a forced tool choice goes only to the receipted models (survey of 24, ratified 2026-09-26)", async () => {
  const cases: [string, boolean][] = [
    ["meta-llama/Llama-3.3-70B-Instruct-Turbo", false],
    ["openai/gpt-oss-120b", false],
    ["zai-org/GLM-4.7", false],
    ["deepseek-ai/DeepSeek-V4-Pro", false], // untested: refused, never silently ignored
    ["deepseek-ai/DeepSeek-V4.1-Flash", true],
    ["zai-org/GLM-5.3-Flash", true],
    ["anthropic/claude-haiku-4-5", true],
    ["deepseek-ai/DeepSeek-V4-Flash-0731", true], // a suffixed variant inherits its entry
  ];
  for (const [model, sent] of cases) {
    const request = { model, messages: user("hi"), tools: [WEATHER], config: { toolChoice: { mode: "required" as const } } };
    if (sent) assert.equal((await build("deepinfra", request)).body["tool_choice"], "required", model);
    else await assert.rejects(build("deepinfra", request), refused, model);
  }
});

test("together: gpt-oss refuses a forced tool choice (the server answers 500) and clamps effort to low|medium|high", async () => {
  const forced = (model: string) => ({ model, messages: user("hi"), tools: [WEATHER], config: { toolChoice: { mode: "required" as const } } });
  await assert.rejects(build("together", forced("openai/gpt-oss-120b")), refused);
  assert.equal((await build("together", forced("meta-llama/Llama-3.3-70B-Instruct-Turbo"))).body["tool_choice"], "required");
  for (const [asked, applied] of [["max", "high"], ["xhigh", "high"], ["minimal", "low"]] as const) {
    const { body, adaptations } = await build("together", { model: "openai/gpt-oss-120b", messages: user("hi"), config: { reasoning: { effort: asked } } });
    assert.equal(body["reasoning_effort"], applied);
    assert.deepEqual(adaptations.map((a) => [a.field, a.action, a.asked, a.applied]), [["config.reasoning.effort", "clamped", asked, applied]]);
  }
  assert.equal((await build("together", { model: "deepseek-ai/DeepSeek-V4.1-Flash", messages: user("hi"), config: { reasoning: { effort: "max" } } })).body["reasoning_effort"], "max");
});

test("reasoning off becomes the lowest level where the server accepts none and reasons anyway; sent as none elsewhere", async () => {
  for (const [provider, model] of [["together", "openai/gpt-oss-120b"], ["together", "zai-org/GLM-5.3-Flash"], ["deepinfra", "openai/gpt-oss-120b"]]) {
    const { body, adaptations } = await build(provider!, { model: model!, messages: user("hi"), config: { reasoning: { effort: "off" } } });
    assert.equal(body["reasoning_effort"], "low", model);
    assert.deepEqual(adaptations.map((a) => [a.field, a.action, a.asked, a.applied]), [["config.reasoning.effort", "substituted", "off", "low"]]);
  }
  for (const [provider, model] of [["together", "deepseek-ai/DeepSeek-V4.1-Flash"], ["fireworks", "accounts/fireworks/models/gpt-oss-120b"], ["parasail", "openai/gpt-oss-20b"]]) {
    const { body, adaptations } = await build(provider!, { model: model!, messages: user("hi"), config: { reasoning: { effort: "off" } } });
    assert.equal(body["reasoning_effort"], "none", model);
    assert.deepEqual(adaptations, []);
  }
});

test("chat listModels reads a bare-array catalog (Together) and refuses an unknown shape instead of answering no models", async () => {
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "together" });
  assert.deepEqual(lm.modelsFromBody('[{"id": "a"}, {"id": "b"}]').map((m) => m.id), ["a", "b"]);
  assert.deepEqual(lm.modelsFromBody('{"object": "list", "data": [{"id": "c"}]}').map((m) => m.id), ["c"]);
  const fake = new OpenAIChatLM({ apiKey: "k", compat: "together", transport: new FakeTransport([new FakeResponse({ body: '{"models": [{"id": "x"}]}' })]) });
  await assert.rejects(fake.listModels(), (e: unknown) => e instanceof ProviderError && /malformed provider reply/.test(e.message));
});

test("chat usage: cached tokens nested first, then flat (Together's non-reasoning models)", () => {
  assert.equal(usageFromChat({ prompt_tokens: 9, cached_tokens: 0 }).cacheReadTokens, 0);
  assert.equal(usageFromChat({ prompt_tokens_details: { cached_tokens: 3 }, cached_tokens: 9 }).cacheReadTokens, 3);
  assert.equal(usageFromChat({ prompt_tokens: 9 }).cacheReadTokens, undefined);
});
