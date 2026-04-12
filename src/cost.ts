/**
 * Cost estimation from Usage + models.dev pricing data.
 */

import type { ModelSpec } from "./model_catalog.js";
import type { Usage } from "./types.js";

export interface CostBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly reasoning: number;
  readonly input_audio: number;
  readonly output_audio: number;
  readonly total: number;
}

/**
 * Providers where input_tokens already excludes cached tokens
 * (cache counts are additive to get total input).
 */
const ADDITIVE_CACHE_PROVIDERS = new Set(["anthropic"]);

/**
 * Providers where reasoning_tokens is separate from output_tokens
 * (not a subset).
 */
const SEPARATE_REASONING_PROVIDERS = new Set(["gemini", "google"]);

function perToken(ratePerMillion: number | undefined): number {
  return (ratePerMillion ?? 0) / 1_000_000;
}

/**
 * Estimate the cost of a single request from its Usage.
 *
 * @param usage Token counts returned by the provider.
 * @param spec A ModelSpec or a raw cost dict with rates in $/million tokens.
 * @param provider Provider name (required when spec is a plain object).
 */
export function estimateCost(
  usage: Usage,
  spec: ModelSpec | Record<string, number | undefined>,
  provider?: string,
): CostBreakdown {
  let cost: Record<string, number | undefined>;
  if ("raw" in spec && "id" in spec) {
    // ModelSpec
    cost = ((spec as ModelSpec).raw.cost ?? {}) as Record<string, number | undefined>;
    provider = (spec as ModelSpec).provider;
  } else {
    cost = spec as Record<string, number | undefined>;
    if (!provider) {
      throw new Error("provider is required when spec is a plain object");
    }
  }

  const rInput = perToken(cost.input);
  const rOutput = perToken(cost.output);
  const rCacheRead = perToken(cost.cache_read);
  const rCacheWrite = perToken(cost.cache_write);
  const rReasoning = perToken(cost.reasoning);
  const rInputAudio = perToken(cost.input_audio);
  const rOutputAudio = perToken(cost.output_audio);

  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const reasoning = usage.reasoning_tokens ?? 0;
  const inputAudio = usage.input_audio_tokens ?? 0;
  const outputAudio = usage.output_audio_tokens ?? 0;

  // Input tokens
  let textInput: number;
  if (ADDITIVE_CACHE_PROVIDERS.has(provider!)) {
    textInput = usage.input_tokens - inputAudio;
  } else {
    textInput = usage.input_tokens - cacheRead - cacheWrite - inputAudio;
  }
  textInput = Math.max(textInput, 0);

  // Output tokens
  let textOutput: number;
  if (SEPARATE_REASONING_PROVIDERS.has(provider!)) {
    textOutput = usage.output_tokens - outputAudio;
  } else {
    textOutput = usage.output_tokens - reasoning - outputAudio;
  }
  textOutput = Math.max(textOutput, 0);

  const cInput = textInput * rInput;
  const cOutput = textOutput * rOutput;
  const cCacheRead = cacheRead * rCacheRead;
  const cCacheWrite = cacheWrite * rCacheWrite;
  const cReasoning = reasoning * rReasoning;
  const cInputAudio = inputAudio * rInputAudio;
  const cOutputAudio = outputAudio * rOutputAudio;

  return {
    input: cInput,
    output: cOutput,
    cache_read: cCacheRead,
    cache_write: cCacheWrite,
    reasoning: cReasoning,
    input_audio: cInputAudio,
    output_audio: cOutputAudio,
    total: cInput + cOutput + cCacheRead + cCacheWrite + cReasoning + cInputAudio + cOutputAudio,
  };
}
