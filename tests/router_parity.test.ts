import { test } from "node:test";
import assert from "node:assert/strict";
import { LMRouter, describeResolution } from "../src/router.ts";
import { PROVIDERS, ProviderDefinition, lookup } from "../src/registry.ts";
import { OPENAI_CHAT_API, ANTHROPIC_API, type AccessPolicy } from "../src/auth/policy.ts";
import { getDefaultPlatform, setDefaultPlatform, webPlatform } from "../src/platform.ts";
import { FetchTransport, Timeouts, installTransportFactory, type Transport, type TransportBudgetOptions } from "../src/transport.ts";
import { NotConfiguredError, UnknownModelError, UnsupportedFeatureError } from "../src/errors.ts";
import { Message } from "../src/types/parts.ts";
import { ModelInfo, ModelRegistry } from "../src/types/model_info.ts";
import { RawNumber, stringifyJson } from "../src/json.ts";
import { BearerToken, type NamedCredential } from "../src/types/credential.ts";

const messages = [Message.user("hello")];
const access = (provider: string, overrides: Partial<AccessPolicy> = {}): AccessPolicy => ({
  ...OPENAI_CHAT_API, provider, envKeys: ["PRIVATE_GATEWAY_KEY"], baseUrl: "https://gateway.invalid/v1", ...overrides,
});
const privateDoor = ProviderDefinition.chat(access("private-chat"), {
  compat: { maxTokensField: "max_tokens", thinkingFormat: "none" }, aliases: ["my-gateway"], note: "application declaration",
});
const noSend: Transport = { async send(): Promise<never> { throw new Error("unexpected wire call"); } };

test("plan is independent of host services, real credentials, settings and pools", async () => {
  const previous = getDefaultPlatform();
  let touched = 0;
  const forbidden = (): never => { touched++; throw new Error("planning touched a host service"); };
  setDefaultPlatform({
    name: "host-must-not-run", env: forbidden, readFile: forbidden, webSocketHeaders: false,
    openCloudChain: forbidden, storedCredentials: { load: forbidden, has: forbidden, describe: forbidden },
  });
  installTransportFactory(() => forbidden());
  try {
    const router = new LMRouter();
    for (const model of ["gpt-4.1", "openai-chat:gpt-4.1", "claude-sonnet-4-5", "gemini-2.5-flash", "grok-4", "claude-code:claude-sonnet-4-5", "openai-codex:gpt-5", "azure:deployment", "azure-chat:deployment", "azure-anthropic:deployment", "bedrock-chat:openai.gpt-oss-120b", "bedrock-anthropic:claude-opus-4-7", "aws-anthropic:claude-sonnet-4-5", "vertex:gemini-2.5-flash", "vertex-anthropic:claude-sonnet-4-5"]) {
      await router.plan({ model, messages });
    }
    const named = new LMRouter({ credentials: { azure: "platform" } });
    await named.plan({ model: "azure:deployment", messages });
    const callable = new LMRouter({ apiKeys: { anthropic: forbidden } });
    const records = await callable.plan({ model: "claude-sonnet-4-5", messages, config: { seed: 7 } });
    assert.ok(records.some((r) => r.field === "config.seed"));
    await assert.rejects(callable.plan({ model: "claude-sonnet-4-5", messages, config: { seed: 7 } }, { policy: "refuse" }), UnsupportedFeatureError);
    await router.close();
    assert.equal(touched, 0);
  } finally {
    setDefaultPlatform(previous);
    installTransportFactory((opts) => new FetchTransport(opts));
  }
});

test("path media planning does not read a file", async () => {
  const previous = getDefaultPlatform();
  setDefaultPlatform({ ...webPlatform, readFile: () => { throw new Error("plan read a local file"); } });
  try {
    await new LMRouter({ env: {} }).plan({
      model: "openai-chat:gpt-4.1",
      messages: [{ role: "user", parts: [{ type: "image", path: "/must-not-be-read.png", mediaType: "image/png" }] }],
    });
  } finally { setDefaultPlatform(previous); }
});

test("declarations route aliases, catalogs and rules without mutating the registry", async () => {
  const count = PROVIDERS.size;
  const registry = new ModelRegistry();
  registry.add(ModelInfo.create({ id: "canonical-model", provider: "private-chat", aliases: ["catalog-model"], apiFamily: "openai_chat" }));
  const router = new LMRouter({
    env: {}, providers: [privateDoor], registry, apiKeys: { "private-chat": "explicit" },
    rules: [{ prefix: "private-", provider: "private-chat" }], transport: noSend,
  });
  for (const model of ["private-chat:model", "my-gateway:model", "my_gateway:model"]) {
    const result = router.resolve(model);
    assert.equal(result.provider, "private-chat");
    assert.equal(result.model, "model");
    assert.equal(result.declared, true);
    assert.match(describeResolution(result), /no lm15 receipts/);
    assert.equal(typeof result.compat, "object");
  }
  assert.equal(router.resolveOpenAIChat("my_gateway/organization/model").model, "organization/model");
  assert.equal(router.resolve("catalog-model").model, "canonical-model");
  assert.equal(router.resolve("private-model").source, "rule");
  const lm = router.lm("private-chat:model");
  const built = await lm.build({ model: "model", messages, config: { maxTokens: 12 } }, false);
  assert.equal(JSON.parse(new TextDecoder().decode(built.request.body)).max_tokens, 12);
  assert.equal(lm.provider, "private-chat");
  assert.equal(lm.baseUrl, "https://gateway.invalid/v1");
  assert.equal(PROVIDERS.size, count);
  assert.equal(lookup("private-chat"), undefined);
  assert.throws(() => new LMRouter({ env: {} }).resolve("my-gateway:model"), UnknownModelError);
  assert.equal(router.doctor("my-gateway:model").configured, true);
});

test("definition factories cover three dialects and snapshot precision-safe custom knobs", () => {
  const extensions = { value: new RawNumber("9007199254740993") };
  const declared = ProviderDefinition.responses(access("private-responses"), { compat: { extensions } });
  extensions.value = new RawNumber("1.0");
  assert.ok(stringifyJson(declared.compat).includes("9007199254740993"));
  assert.equal(declared.dialect, "openai-responses");
  assert.equal(ProviderDefinition.anthropic({ ...ANTHROPIC_API, provider: "private-messages", baseUrl: "https://messages.invalid" }, { compat: {} }).dialect, "anthropic");
  assert.throws(() => ProviderDefinition.chat(access("missing", { baseUrl: undefined } as unknown as Partial<AccessPolicy>), { compat: {} }), /baseUrl/);
  assert.throws(() => ProviderDefinition.chat(access("oauth", { credentialPolicy: "oauth", envKeys: [] }), { compat: {} }), /key-based/);
  assert.throws(() => ProviderDefinition.chat(access("bad"), { compat: { thinkingFormat: "not-a-policy" } as never }), /invalid compat/);
  assert.throws(() => ProviderDefinition.chat(access("bad"), { compat: { developerRole: "system" } as never }), /unknown compat/);
  assert.throws(() => ProviderDefinition.chat(access("bad"), { compat: {}, aliases: ["bad_alias"] }), /hyphenated/);
  assert.throws(() => ProviderDefinition.chat(access("bad"), { compat: {}, aliases: ["same", "same"] }), /repeat/);
  assert.throws(() => ProviderDefinition.chat(access("bad"), { compat: "groq" }), /compat table/);
});

test("declaration collisions and configuration spelling errors fail at construction", () => {
  for (const alias of ["groq", "openai-chat", "hosted-vllm", "ollama-chat"]) {
    const declaration = ProviderDefinition.chat(access("new-door"), { compat: {}, aliases: [alias] });
    assert.throws(() => new LMRouter({ providers: [declaration] }), NotConfiguredError);
  }
  const other = ProviderDefinition.chat(access("other"), { compat: {}, aliases: ["my-gateway"] });
  assert.throws(() => new LMRouter({ providers: [privateDoor, other] }), NotConfiguredError);
  assert.throws(() => new LMRouter({ providers: [privateDoor], apiKeys: { "my-gateway": "k" } }), /configuration id/);
  assert.throws(() => new LMRouter({ apiKeys: { openai_chat: "a", "openai-chat": "b" } }), /duplicate/);
  assert.throws(() => new LMRouter({ baseUrls: { openai_chat: "https://a.invalid", "openai-chat": "https://b.invalid" } }), /duplicate/);
});

test("named credentials reject key conflicts including shared-key siblings and unknown/noncloud names", () => {
  assert.throws(() => new LMRouter({ credentials: { azure: "bogus" as NamedCredential } }), NotConfiguredError);
  assert.throws(() => new LMRouter({ credentials: { openai: "platform" } }), NotConfiguredError);
  assert.throws(() => new LMRouter({ credentials: { azure: "platform" }, apiKeys: { azure: "key" } }), NotConfiguredError);
  assert.throws(() => new LMRouter({ credentials: { "azure-chat": "platform" }, apiKeys: { azure: "key" } }), NotConfiguredError);
  assert.throws(() => new LMRouter({ credentials: { azure_chat: "platform", "azure-chat": "cli" } }), /duplicate/);
});

test("explicit cloud endpoint works on web without resource or host identity services", async () => {
  const previous = getDefaultPlatform();
  setDefaultPlatform(webPlatform);
  try {
    const router = new LMRouter({ env: {}, apiKeys: { azure: "key" }, baseUrls: { azure: "https://account.services.ai.azure.com" }, transport: noSend });
    const lm = router.lm("azure:deployment");
    assert.equal(lm.baseUrl, "https://account.services.ai.azure.com/openai/v1");
    assert.equal(lm.access.provider, "azure");
    const built = await lm.build({ model: "deployment", messages }, false);
    assert.ok(built.request.headers.some(([k, v]) => k === "api-key" && v === "key"));
    assert.throws(() => new LMRouter({ env: {}, credentials: { azure: "platform" }, baseUrls: { azure: "https://account.services.ai.azure.com" }, transport: noSend }).lm("azure:deployment"), /platform/);
    assert.throws(() => new LMRouter({ env: {}, apiKeys: { "bedrock-chat": new BearerToken("key") }, baseUrls: { "bedrock-chat": "https://gateway.invalid" }, transport: noSend }).lm("bedrock-chat:model"), /region/);
  } finally { setDefaultPlatform(previous); }
});

test("named selector reaches only the configured cloud chain provider", () => {
  const previous = getDefaultPlatform();
  const names: Array<NamedCredential | undefined> = [];
  setDefaultPlatform({
    ...webPlatform,
    openCloudChain: () => ({
      settings: {}, profile: () => () => undefined,
      credentialProvider: (_policy, named) => { names.push(named); return async () => new BearerToken("token"); },
      explain: () => [[], false],
    }),
  });
  try {
    const router = new LMRouter({ env: {}, credentials: { azure: "workload" }, baseUrls: { azure: "https://account.services.ai.azure.com" }, transport: noSend });
    router.lm("azure:deployment");
    assert.deepEqual(names, ["workload"]);
    assert.match(describeResolution(router.resolve("azure:deployment")), /named credential "workload"/);
  } finally { setDefaultPlatform(previous); }
});

test("router owns one shared lazy transport and preserves configured budgets and caller ownership", async () => {
  const created: Array<{ transport: Transport; opts: TransportBudgetOptions; closed: number }> = [];
  installTransportFactory((opts) => {
    const item = { opts, closed: 0, transport: undefined as unknown as Transport };
    item.transport = { ...noSend, close: () => { item.closed++; } };
    created.push(item);
    return item.transport;
  });
  try {
    const router = new LMRouter({ env: {}, apiKeys: { openai: "k", anthropic: "k" }, timeouts: { read: 1800 }, maxConnections: 7 });
    await router.plan({ model: "gpt-4.1", messages });
    assert.equal(created.length, 0);
    const first = router.lm("gpt-4.1");
    assert.equal(router.lm("claude-sonnet-4-5").transport, first.transport);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0]!.opts, { timeouts: { read: 1800 }, maxConnections: 7 });
    await router.close();
    await router.close();
    assert.equal(created[0]!.closed, 1);
    assert.notEqual(router.lm("gpt-4.1").transport, first.transport);
    await router.close();
    const borrowed = new LMRouter({ env: {}, apiKeys: { openai: "k" }, transport: first.transport });
    assert.equal(borrowed.lm("gpt-4.1").transport, first.transport);
    await borrowed.close();
    assert.equal(created[0]!.closed, 1);
    for (const budget of [{ timeouts: new Timeouts() }, { maxConnections: 2 }]) assert.throws(() => new LMRouter({ ...budget, transport: noSend }), NotConfiguredError);
    for (const maxConnections of [0, -1, 1.5, Infinity]) assert.throws(() => new LMRouter({ maxConnections }), NotConfiguredError);
    assert.throws(() => new LMRouter({ timeouts: { read: -1 } }));
  } finally { installTransportFactory((opts) => new FetchTransport(opts)); }
});

test("bare jev names route only to TypeSafe and plan does not populate the real LM cache", async () => {
  const router = new LMRouter({ env: {}, transport: noSend });
  assert.equal(router.resolve("jev-3").provider, "typesafe");
  await router.plan({ model: "gpt-4.1", messages });
  assert.throws(() => router.lm("gpt-4.1"), NotConfiguredError);
  const local = ProviderDefinition.chat(access("local-box", { envKeys: [] }), { compat: {}, placeholderKey: "EMPTY" });
  const localRouter = new LMRouter({ providers: [local], env: {}, transport: noSend });
  assert.match(describeResolution(localRouter.resolve("local-box:model")), /local-server default/);
  assert.equal(localRouter.doctor("local-box:model").configured, true);
});
