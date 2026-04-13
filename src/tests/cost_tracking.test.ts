import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

function assertClose(actual: number | undefined, expected: number, epsilon = 1e-12): void {
  assert.ok(actual != null);
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
}
import { configure } from "../api.js";
import { UniversalLM } from "../client.js";
import {
  disableCostTracking,
  getCostIndex,
  lookupCost,
  setCostIndex,
  type CostBreakdown,
} from "../cost.js";
import { Model } from "../model.js";
import { Result } from "../result.js";
import { Message, Part } from "../types.js";
import type { LMAdapter } from "../providers/base.js";
import type { LMRequest, LMResponse, ModelSpec, StreamEvent, Usage } from "../index.js";

function spec(model: string, provider: string, input: number, output: number): ModelSpec {
  return {
    id: model,
    provider,
    context_window: undefined,
    max_output: undefined,
    input_modalities: [],
    output_modalities: [],
    tool_call: false,
    structured_output: false,
    reasoning: false,
    raw: { cost: { input, output } },
  };
}

function makeResult(model = "gpt-4.1-mini", usage: Usage = { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 }): Result {
  const request: LMRequest = { model, messages: [Message.user("hello")] };
  return new Result({
    request,
    startStream: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "start", id: "r1", model };
      yield { type: "delta", part_index: 0, delta: { type: "text", text: "hi" } };
      yield { type: "end", finish_reason: "stop", usage };
    },
  });
}

function echoAdapter(): LMAdapter {
  return {
    provider: "echo",
    supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false },
    manifest: { provider: "echo", supports: { complete: true, stream: true, live: false, embeddings: false, files: false, batches: false, images: false, audio: false }, envKeys: [] },
    async complete(request: LMRequest): Promise<LMResponse> {
      return {
        id: "echo-1",
        model: request.model,
        message: { role: "assistant", parts: [Part.text("ok")] },
        finish_reason: "stop",
        usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
      };
    },
    async *stream(request: LMRequest): AsyncIterable<StreamEvent> {
      const resp = await this.complete(request);
      yield { type: "start", id: resp.id, model: request.model };
      yield { type: "delta", part_index: 0, delta: { type: "text", text: "ok" } };
      yield { type: "end", finish_reason: "stop", usage: resp.usage };
    },
  };
}

function makeModel(): Model {
  const lm = new UniversalLM();
  lm.register(echoAdapter());
  return new Model({ lm, model: "gpt-4.1-mini", provider: "echo" });
}

afterEach(() => {
  disableCostTracking();
});

describe("cost tracking", () => {
  it("lookupCost returns undefined when tracking is disabled", async () => {
    const cost = await lookupCost("gpt-4.1-mini", { input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    assert.equal(cost, undefined);
  });

  it("result.cost works with an installed cost index", async () => {
    setCostIndex(new Map([["gpt-4.1-mini", spec("gpt-4.1-mini", "openai", 3.0, 15.0)]]));
    const cost = await makeResult().cost;
    assert.ok(cost);
    assertClose(cost?.input, 1000 * 3.0 / 1_000_000);
    assertClose(cost?.output, 500 * 15.0 / 1_000_000);
  });

  it("model.totalCost sums history", async () => {
    setCostIndex(new Map([["gpt-4.1-mini", spec("gpt-4.1-mini", "openai", 3.0, 15.0)]]));
    const model = makeModel();
    await model.call("one").text;
    await model.call("two").text;
    const total = await model.totalCost;
    assert.ok(total);
    assertClose(total?.total, 2 * ((1000 * 3.0 / 1_000_000) + (500 * 15.0 / 1_000_000)));
  });

  it("model.totalCost is zero for empty history when tracking is enabled", async () => {
    setCostIndex(new Map([["gpt-4.1-mini", spec("gpt-4.1-mini", "openai", 3.0, 15.0)]]));
    const total = await makeModel().totalCost;
    assert.deepEqual(total, {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
      input_audio: 0,
      output_audio: 0,
      total: 0,
    } satisfies CostBreakdown);
  });

  it("configure({ trackCosts: true }) hydrates pricing automatically", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({
        providers: {
          openai: {
            models: {
              "gpt-4.1-mini": {
                cost: { input: 3.0, output: 15.0 },
                limit: {},
                modalities: {},
                tool_call: false,
                structured_output: false,
                reasoning: false,
              },
            },
          },
        },
      }),
    })) as unknown as typeof fetch;

    try {
      configure({ trackCosts: true });
      const cost = await makeResult().cost;
      assert.ok(cost);
      assert.ok((getCostIndex()?.get("gpt-4.1-mini")) != null);
    } finally {
      globalThis.fetch = originalFetch;
      disableCostTracking();
    }
  });
});
