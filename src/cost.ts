/**
 * Cost estimation from Usage + models.dev pricing data.
 */

import { fetchModelsDev, type ModelSpec } from "./model_catalog.js";
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

let _costIndex: Map<string, ModelSpec> | undefined;
let _costIndexPromise: Promise<Map<string, ModelSpec>> | undefined;

function emptyCostBreakdown(): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    input_audio: 0,
    output_audio: 0,
    total: 0,
  };
}

async function hydrateCostIndex(): Promise<Map<string, ModelSpec>> {
  const specs = await fetchModelsDev();
  return new Map(specs.filter(s => !!(s.raw as { cost?: unknown }).cost).map(s => [s.id, s]));
}

export async function enableCostTracking(): Promise<void> {
  if (_costIndex) return;
  if (!_costIndexPromise) {
    _costIndexPromise = hydrateCostIndex().then(index => {
      _costIndex = index;
      return index;
    }).finally(() => {
      _costIndexPromise = undefined;
    });
  }
  await _costIndexPromise;
}

export function disableCostTracking(): void {
  _costIndex = undefined;
  _costIndexPromise = undefined;
}

export function getCostIndex(): ReadonlyMap<string, ModelSpec> | undefined {
  return _costIndex;
}

export function setCostIndex(index: ReadonlyMap<string, ModelSpec> | undefined): void {
  _costIndex = index ? new Map(index) : undefined;
  _costIndexPromise = undefined;
}

export async function lookupCost(
  model: string,
  usage: Usage,
): Promise<CostBreakdown | undefined> {
  if (_costIndex == null && _costIndexPromise) {
    await _costIndexPromise;
  }
  const spec = _costIndex?.get(model);
  if (!spec) return undefined;
  return estimateCost(usage, spec);
}

export function sumCosts(costs: Iterable<CostBreakdown>): CostBreakdown {
  const total: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
    input_audio: number;
    output_audio: number;
    total: number;
  } = emptyCostBreakdown();
  for (const cost of costs) {
    total.input += cost.input;
    total.output += cost.output;
    total.cache_read += cost.cache_read;
    total.cache_write += cost.cache_write;
    total.reasoning += cost.reasoning;
    total.input_audio += cost.input_audio;
    total.output_audio += cost.output_audio;
    total.total += cost.total;
  }
  return total;
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
