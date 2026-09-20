// Source-only cached destination regressions; scripted transport, no live I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../src/platform_node.ts";
import { LMRouter } from "../src/router.ts";
import { ProviderDefinition } from "../src/registry.ts";
import { OPENAI_CHAT_API } from "../src/auth/policy.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { Request } from "../src/types/config.ts";
import { Message } from "../src/types/parts.ts";
import { CacheInfo, CachedPrefix } from "../src/types/endpoints.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";

installNodePlatform();
const req = (model: string): Request => Request.create({ model, messages: [Message.user("prefix")] });
const chat = { id: "r", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
const responses = { id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] };
const privateDoor = ProviderDefinition.chat({ ...OPENAI_CHAT_API, provider: "private-chat", baseUrl: "https://private.invalid/v1", envKeys: [] }, { compat: {}, aliases: ["my-gateway"] });

for (const destination of ["azure", "private-chat"]) {
  test(`automatic cache roundtrip preserves ${destination} through router and bound adapter`, async () => {
    const body = JSON.stringify(destination === "azure" ? responses : chat);
    const transport = new FakeTransport([new FakeResponse({ body }), new FakeResponse({ body })]);
    const router = new LMRouter({ env: {}, providers: [privateDoor], apiKeys: { [destination]: "key" }, baseUrls: { azure: "https://account.services.ai.azure.com" }, transport });
    const inputProvider = destination === "private-chat" ? "my_gateway" : destination;
    const cached = await router.cache(req(`${inputProvider}:gpt-4.1-mini`));
    assert.equal(transport.requests.length, 0);
    assert.equal(cached.provider, destination);
    assert.equal(cached.prefix.model, "gpt-4.1-mini");
    const restored = CachedPrefix.fromJSON(CachedPrefix.toJSON(cached));
    const suffix = CachedPrefix.request(restored, "question");
    assert.equal(suffix.model, `${destination}:gpt-4.1-mini`);
    assert.equal(router.resolve(suffix.model).provider, destination);
    await router.complete(suffix);
    const direct = router.lm(suffix.model);
    await direct.plan(suffix);
    await direct.complete(suffix);
    assert.equal(transport.requests.length, 2);
    for (const wire of transport.requests) {
      assert.equal(JSON.parse(new TextDecoder().decode(wire.body)).model, "gpt-4.1-mini");
      assert.ok(wire.url.includes(destination === "azure" ? "account.services.ai.azure.com" : "private.invalid"));
    }
    await router.close();
  });
}

test("resource cache retains actual model and route across canonical roundtrip", async () => {
  const transport = new FakeTransport([new FakeResponse({ body: JSON.stringify({ name: "cachedContents/c", model: "models/gemini-2.5-flash" }) })]);
  const router = new LMRouter({ env: {}, apiKeys: { gemini: "key" }, transport });
  const cached = await router.cache(req("gemini:gemini-2.5-flash"), { ttlSeconds: 60 });
  assert.equal(cached.resource?.model, "gemini-2.5-flash");
  assert.equal(cached.prefix.model, cached.resource?.model);
  assert.equal(cached.provider, "gemini");
  const restored = CachedPrefix.fromJSON(CachedPrefix.toJSON(cached));
  assert.deepEqual(restored.resource, cached.resource);
  const suffix = CachedPrefix.request(restored, "question");
  assert.equal(suffix.model, "gemini:gemini-2.5-flash");
  assert.equal(suffix.config?.cache?.resource, "cachedContents/c");
  assert.equal(router.resolve(suffix.model).provider, "gemini");
  await router.close();
});

test("suffix destination validation and legacy canonical shape", () => {
  const legacy = CachedPrefix.create({ prefix: req("m") });
  assert.deepEqual(CachedPrefix.toJSON(legacy), { prefix: Request.toJSON(req("m")) });
  assert.equal(CachedPrefix.request(legacy, "q").model, "m");
  const cached = CachedPrefix.create({ prefix: req("m"), resource: CacheInfo.create({ id: "c", model: "m" }), provider: "private_chat" });
  assert.equal(cached.provider, "private-chat");
  for (const model of ["m", "private-chat:m", "private_chat:m"]) assert.equal(CachedPrefix.request(cached, req(model)).model, "private-chat:m");
  for (const model of ["azure:m", "openai:m", "private-chat:other"]) assert.throws(() => CachedPrefix.request(cached, req(model)));
  for (const provider of ["", "a:b", "a/b", "a b", "\t", 42]) assert.throws(() => CachedPrefix.create({ prefix: req("m"), provider }));
  assert.throws(() => CachedPrefix.create({ prefix: req("m"), resource: { id: "c", model: "azure:m" }, provider: "azure" }));
});

test("direct cache has no invented destination and strips only own prefix once", async () => {
  const lm = new OpenAIChatLM({ apiKey: "k", baseUrl: "https://custom.invalid/v1" });
  assert.equal((await lm.cache(req("m"))).provider, undefined);
  const cached = await lm.cache(req("openai_chat:m"));
  assert.equal(cached.provider, "openai-chat");
  assert.equal(cached.prefix.model, "m");
  assert.equal(CachedPrefix.request(cached, "q").model, "openai-chat:m");
  for (const [model, expected] of [["openai_chat:m", "m"], ["openai-chat:openai-chat:m", "openai-chat:m"], ["other:m", "other:m"], ["arn:aws:bedrock:model", "arn:aws:bedrock:model"]] as const) {
    const wire = await lm.buildRequest(req(model), false);
    assert.equal(JSON.parse(new TextDecoder().decode(wire.body)).model, expected);
    await lm.plan(req(model));
  }
  await lm.close();
});
