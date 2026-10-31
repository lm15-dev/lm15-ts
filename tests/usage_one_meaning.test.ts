// MAP-19 (one meaning per usage counter) and InferencePricing.estimate: the
// TypeScript surface around the contract's mapping/usage.json vectors.
import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { InferencePricing, PricingTier } from "../src/types/model_info.ts";
import { Usage } from "../src/types/response.ts";
import { ValueError } from "../src/types/validate.ts";
import { HttpResponse } from "../src/wire.ts";

const SOL = InferencePricing.create({
  inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2.5,
  tiers: [{ aboveInputTokens: 272_000, inputPerMillion: 4, outputPerMillion: 15, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5 }],
});

test("estimate charges cached tokens once and is undefined when unknown", () => {
  assert.equal(InferencePricing.estimate(SOL, Usage.create({ inputTokens: 100_000, outputTokens: 1_000, cacheReadTokens: 90_000, cacheWriteTokens: 0 })), 0.039);
  assert.equal(InferencePricing.estimate(SOL, Usage.create({ inputTokens: 10, outputTokens: 1 })), undefined);
  assert.equal(InferencePricing.estimate(SOL, Usage.create({ inputTokens: 300_000, outputTokens: 1_000, cacheReadTokens: 290_000, cacheWriteTokens: 0 })), 0.113);
});

test("tiers are strictly ascending and need a positive threshold", () => {
  assert.throws(() => InferencePricing.create({ tiers: [{ aboveInputTokens: 2 }, { aboveInputTokens: 1 }] }), ValueError);
  assert.throws(() => InferencePricing.create({ tiers: [{ aboveInputTokens: 1 }, { aboveInputTokens: 1 }] }), ValueError);
  assert.throws(() => PricingTier.create({ aboveInputTokens: 0 }), ValueError);
  assert.throws(() => PricingTier.create({}), ValueError);
  assert.deepEqual(InferencePricing.fromJSON(InferencePricing.toJSON(SOL)), SOL);
});

function chat(usage: object): HttpResponse {
  const body = { id: "c", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage };
  return new HttpResponse({ status: 200, body: new TextEncoder().encode(JSON.stringify(body)) });
}

const XAI = { prompt_tokens: 254, completion_tokens: 9, total_tokens: 374, completion_tokens_details: { reasoning_tokens: 111 } };
const REQ = { model: "grok-4.6", messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }] };

test("reasoningUsage: separate adds reasoning; the dialect rule withholds output", () => {
  assert.equal(new OpenAIChatLM({ apiKey: "k", compat: { reasoningUsage: "separate" } }).parseResponse(REQ as never, chat(XAI)).usage.outputTokens, 120);
  const plain = new OpenAIChatLM({ apiKey: "k" }).parseResponse(REQ as never, chat(XAI)).usage;
  assert.equal(plain.outputTokens, undefined);
  assert.equal(plain.totalTokens, 374);
  const perModel = new OpenAIChatLM({ apiKey: "k", compat: { modelOverrides: [["grok-", { reasoningUsage: "separate" }]] } });
  assert.equal(perModel.parseResponse(REQ as never, chat(XAI)).usage.outputTokens, 120);
});
