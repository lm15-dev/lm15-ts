/**
 * MAP-7 rule 7 (amended 2026-11-07): a summary asked for on Claude is `thinking.display: "summarized"`;
 * Opus 4.7, 4.8 and every Claude 5 hide the thinking without it. The wire of the adaptive and budget
 * cases is pinned by the contract (anthropic.reasoning_summary, anthropic.reasoning_summary_budget);
 * these pin what the contract's cases do not: no summary, no knob; other servers of the wire, no knob.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLM } from "../src/dialects/anthropic.ts";
import { FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

const thinking = (lm: AnthropicLM, model: string, reasoning: Record<string, unknown>) =>
  (lm.payload({ model, messages: [Message.user("q")], config: { reasoning: reasoning as never } }, false) as Record<string, unknown>)["thinking"];

test("a summary asked for sends display summarized, adaptive or budget; none asked, none sent", () => {
  const lm = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([]) });
  assert.deepEqual(thinking(lm, "claude-opus-5-5", { effort: "high", summary: "auto" }), { type: "adaptive", display: "summarized" });
  assert.deepEqual(thinking(lm, "claude-opus-5-5", { effort: "high", summary: "detailed" }), { type: "adaptive", display: "summarized" });
  assert.deepEqual(thinking(lm, "claude-haiku-4-5-20251001", { effort: "low", summary: "auto" }), { type: "enabled", budget_tokens: 2048, display: "summarized" });
  assert.deepEqual(thinking(lm, "claude-opus-5-5", { effort: "high" }), { type: "adaptive" });
});

test("servers of the Messages wire with another thinking format get no display", () => {
  for (const [compat, model] of [["deepseek", "deepseek-v4-flash"], ["meta", "muse-spark-1.3"], ["moonshotai", "kimi-k3"]] as const) {
    const lm = new AnthropicLM({ apiKey: "k", transport: new FakeTransport([]), compat });
    assert.equal(JSON.stringify(thinking(lm, model, { effort: "high", summary: "auto" }) ?? null).includes("display"), false, compat);
  }
});
