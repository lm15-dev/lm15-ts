import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateCost } from "../cost.js";
import type { Usage } from "../types.js";

function assertClose(actual: number, expected: number, epsilon = 1e-12) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
}

describe("estimateCost", () => {
  it("calculates cost from usage and rates", () => {
    const usage: Usage = {
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
    };
    const cost = estimateCost(usage, { input: 3.0, output: 15.0 }, "openai");
    assert.ok(cost.total > 0);
    assertClose(cost.input, 1000 * 3.0 / 1_000_000);
    assertClose(cost.output, 500 * 15.0 / 1_000_000);
    assertClose(cost.total, cost.input + cost.output);
  });

  it("handles cache tokens for anthropic (additive)", () => {
    const usage: Usage = {
      input_tokens: 500,   // non-cached only for anthropic
      output_tokens: 200,
      total_tokens: 700,
      cache_read_tokens: 300,
      cache_write_tokens: 100,
    };
    const cost = estimateCost(usage, { input: 3.0, output: 15.0, cache_read: 1.5, cache_write: 3.75 }, "anthropic");
    assert.equal(cost.input, 500 * 3.0 / 1_000_000);
    assert.equal(cost.cache_read, 300 * 1.5 / 1_000_000);
    assert.equal(cost.cache_write, 100 * 3.75 / 1_000_000);
  });

  it("handles cache tokens for openai (subtractive)", () => {
    const usage: Usage = {
      input_tokens: 1000,  // total including cached for openai
      output_tokens: 200,
      total_tokens: 1200,
      cache_read_tokens: 300,
    };
    const cost = estimateCost(usage, { input: 3.0, output: 15.0, cache_read: 1.5 }, "openai");
    // text_input = 1000 - 300 = 700
    assert.equal(cost.input, 700 * 3.0 / 1_000_000);
    assert.equal(cost.cache_read, 300 * 1.5 / 1_000_000);
  });

  it("handles reasoning tokens for openai (subset of output)", () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 500,
      total_tokens: 600,
      reasoning_tokens: 200,
    };
    const cost = estimateCost(usage, { input: 3.0, output: 15.0, reasoning: 15.0 }, "openai");
    // text_output = 500 - 200 = 300
    assertClose(cost.output, 300 * 15.0 / 1_000_000);
    assertClose(cost.reasoning, 200 * 15.0 / 1_000_000);
  });

  it("handles reasoning tokens for gemini (separate)", () => {
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 300,  // candidatesTokenCount, does NOT include reasoning
      total_tokens: 600,
      reasoning_tokens: 200,
    };
    const cost = estimateCost(usage, { input: 3.0, output: 15.0, reasoning: 15.0 }, "gemini");
    // text_output = 300 (not subtracted)
    assertClose(cost.output, 300 * 15.0 / 1_000_000);
    assertClose(cost.reasoning, 200 * 15.0 / 1_000_000);
  });

  it("requires provider when spec is plain object", () => {
    const usage: Usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    assert.throws(() => estimateCost(usage, { input: 3.0 }), /provider is required/);
  });

  it("accepts ModelSpec", () => {
    const usage: Usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    const spec = {
      id: "gpt-4.1-mini",
      provider: "openai",
      context_window: undefined,
      max_output: undefined,
      input_modalities: [],
      output_modalities: [],
      tool_call: false,
      structured_output: false,
      reasoning: false,
      raw: { cost: { input: 3.0, output: 15.0 } },
    };
    const cost = estimateCost(usage, spec);
    assert.ok(cost.total > 0);
  });
});
