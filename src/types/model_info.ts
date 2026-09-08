/**
 * ModelInfo and its registry: optional model metadata for discovery,
 * routing, and cost estimation (mirrors `lm15.models`).
 */

import { float, isJsonObject, omitEmpty, type JsonObject } from "../json.ts";
import { ValueError, absent, compact, frozen, optionalInt, optionalJsonObject, requireFloat, stringArray } from "./validate.ts";
import type { Usage } from "./response.ts";

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new ValueError(`${field} must be a non-empty string`);
  return value;
}

function nonNegativeFloat(value: unknown, field: string): number | undefined {
  if (absent(value)) return undefined;
  if (typeof value === "boolean") throw new ValueError(`${field} must be a number or None`);
  let n: number;
  try {
    n = requireFloat(value, field);
  } catch {
    throw new ValueError(`${field} must be a number or None`);
  }
  if (n < 0) throw new ValueError(`${field} must be >= 0`);
  return n;
}

function positiveIntOrUndefined(value: unknown, field: string): number | undefined {
  if (absent(value)) return undefined;
  try {
    return optionalInt(value, field, { min: 1 });
  } catch {
    throw new ValueError(`${field} must be a positive integer or None`);
  }
}

export interface InferencePricing {
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
  readonly currency?: string;
  readonly dimensions?: JsonObject;
}

export function normalizeInferencePricing(input: unknown): InferencePricing {
  if (typeof input !== "object" || input === null) throw new TypeError("expected an InferencePricing");
  const d = input as Record<string, unknown>;
  const dims = d["dimensions"];
  if (!absent(dims) && !isJsonObject(dims)) throw new TypeError("dimensions must be a JSON object or None");
  return frozen(
    compact({
      inputPerMillion: nonNegativeFloat(d["inputPerMillion"], "input_per_million"),
      outputPerMillion: nonNegativeFloat(d["outputPerMillion"], "output_per_million"),
      cacheReadPerMillion: nonNegativeFloat(d["cacheReadPerMillion"], "cache_read_per_million"),
      cacheWritePerMillion: nonNegativeFloat(d["cacheWritePerMillion"], "cache_write_per_million"),
      currency: nonEmptyText(d["currency"] ?? "USD", "currency"),
      dimensions: absent(dims) ? undefined : (dims as JsonObject),
    }),
  );
}

export const InferencePricing = {
  create: normalizeInferencePricing,
  /** Unknown counts (`undefined`) contribute nothing — a lower bound, never zero-filled. */
  estimate(p: InferencePricing, usage: Usage): number {
    let total = 0;
    if (p.inputPerMillion !== undefined && usage.inputTokens !== undefined) total += (usage.inputTokens * p.inputPerMillion) / 1_000_000;
    if (p.outputPerMillion !== undefined && usage.outputTokens !== undefined) total += (usage.outputTokens * p.outputPerMillion) / 1_000_000;
    if (p.cacheReadPerMillion !== undefined && usage.cacheReadTokens !== undefined) {
      total += (usage.cacheReadTokens * p.cacheReadPerMillion) / 1_000_000;
    }
    if (p.cacheWritePerMillion !== undefined && usage.cacheWriteTokens !== undefined) {
      total += (usage.cacheWriteTokens * p.cacheWritePerMillion) / 1_000_000;
    }
    return total;
  },
  fromJSON(d: JsonObject): InferencePricing {
    return normalizeInferencePricing({
      inputPerMillion: d["input_per_million"],
      outputPerMillion: d["output_per_million"],
      cacheReadPerMillion: d["cache_read_per_million"],
      cacheWritePerMillion: d["cache_write_per_million"],
      currency: d["currency"] ?? "USD",
      dimensions: d["dimensions"],
    });
  },
  toJSON(p: InferencePricing): JsonObject {
    return omitEmpty({
      input_per_million: float(p.inputPerMillion),
      output_per_million: float(p.outputPerMillion),
      cache_read_per_million: float(p.cacheReadPerMillion),
      cache_write_per_million: float(p.cacheWritePerMillion),
      currency: p.currency ?? "USD",
      dimensions: p.dimensions,
    });
  },
};

export interface InferenceModelInfo {
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsReasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly pricing?: InferencePricing;
  readonly extensions?: JsonObject;
}

export function normalizeInferenceModelInfo(input: unknown): InferenceModelInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected an InferenceModelInfo");
  const d = input as Record<string, unknown>;
  const ext = d["extensions"];
  if (!absent(ext) && !isJsonObject(ext)) throw new TypeError("extensions must be a JSON object or None");
  const inputModalities = absent(d["inputModalities"]) ? ["text"] : stringArray(d["inputModalities"], "input_modalities");
  const outputModalities = absent(d["outputModalities"]) ? ["text"] : stringArray(d["outputModalities"], "output_modalities");
  return frozen(
    compact({
      inputModalities: Object.freeze(inputModalities),
      outputModalities: Object.freeze(outputModalities),
      contextWindow: positiveIntOrUndefined(d["contextWindow"], "context_window"),
      maxOutputTokens: positiveIntOrUndefined(d["maxOutputTokens"], "max_output_tokens"),
      supportsReasoning: d["supportsReasoning"] === true,
      reasoningEfforts: Object.freeze(stringArray(d["reasoningEfforts"], "reasoning_efforts")),
      pricing: absent(d["pricing"]) ? undefined : normalizeInferencePricing(d["pricing"]),
      extensions: absent(ext) ? undefined : (ext as JsonObject),
    }),
  );
}

export const InferenceModelInfo = {
  create: normalizeInferenceModelInfo,
  fromJSON(d: JsonObject): InferenceModelInfo {
    return normalizeInferenceModelInfo({
      inputModalities: d["input_modalities"] ?? ["text"],
      outputModalities: d["output_modalities"] ?? ["text"],
      contextWindow: d["context_window"],
      maxOutputTokens: d["max_output_tokens"],
      supportsReasoning: d["supports_reasoning"] ?? false,
      reasoningEfforts: d["reasoning_efforts"] ?? [],
      pricing: isJsonObject(d["pricing"]) ? InferencePricing.fromJSON(d["pricing"]) : undefined,
      extensions: d["extensions"],
    });
  },
  toJSON(i: InferenceModelInfo): JsonObject {
    return omitEmpty({
      input_modalities: [...(i.inputModalities ?? ["text"])],
      output_modalities: [...(i.outputModalities ?? ["text"])],
      context_window: i.contextWindow,
      max_output_tokens: i.maxOutputTokens,
      supports_reasoning: i.supportsReasoning ? true : undefined,
      reasoning_efforts: [...(i.reasoningEfforts ?? [])],
      pricing: i.pricing ? InferencePricing.toJSON(i.pricing) : undefined,
      extensions: i.extensions,
    });
  },
};

export interface ModelOrigin {
  readonly type?: string;
  readonly id?: string;
  readonly baseModel?: string;
  readonly providerData?: JsonObject;
}

export function normalizeModelOrigin(input: unknown): ModelOrigin {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a ModelOrigin");
  const d = input as Record<string, unknown>;
  const pd = d["providerData"];
  if (!absent(pd) && !isJsonObject(pd)) throw new TypeError("provider_data must be a JSON object or None");
  return frozen(
    compact({
      type: nonEmptyText(d["type"] ?? "provider", "ModelOrigin.type"),
      id: absent(d["id"]) ? undefined : nonEmptyText(d["id"], "ModelOrigin.id"),
      baseModel: absent(d["baseModel"]) ? undefined : nonEmptyText(d["baseModel"], "ModelOrigin.base_model"),
      providerData: absent(pd) ? undefined : (pd as JsonObject),
    }),
  );
}

export const DEFAULT_ORIGIN: ModelOrigin = Object.freeze({ type: "provider" });

export const ModelOrigin = {
  create: normalizeModelOrigin,
  fromJSON(d: JsonObject): ModelOrigin {
    return normalizeModelOrigin({ type: d["type"] ?? "provider", id: d["id"], baseModel: d["base_model"], providerData: d["provider_data"] });
  },
  toJSON(o: ModelOrigin): JsonObject {
    return omitEmpty({ type: o.type ?? "provider", id: o.id, base_model: o.baseModel, provider_data: o.providerData });
  },
};

export interface ModelInfo {
  readonly id: string;
  /** Canonical (hyphenated) provider string. */
  readonly provider: string;
  /** The wire dialect, underscore-spelled (`openai_chat`, `anthropic_messages`, …). */
  readonly apiFamily: string;
  readonly aliases?: readonly string[];
  readonly origin?: ModelOrigin;
  readonly inference?: InferenceModelInfo;
  readonly extensions?: JsonObject;
}

export function normalizeModelInfo(input: unknown): ModelInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a ModelInfo");
  const d = input as Record<string, unknown>;
  const ext = d["extensions"];
  if (!absent(ext) && !isJsonObject(ext)) throw new TypeError("extensions must be a JSON object or None");
  const aliases = stringArray(d["aliases"], "ModelInfo.aliases");
  if (aliases.some((a) => a === "")) throw new ValueError("ModelInfo.aliases must contain non-empty strings");
  return frozen(
    compact({
      id: nonEmptyText(d["id"], "ModelInfo.id"),
      provider: nonEmptyText(d["provider"], "ModelInfo.provider"),
      apiFamily: nonEmptyText(d["apiFamily"], "ModelInfo.api_family"),
      aliases: Object.freeze(aliases),
      origin: absent(d["origin"]) ? DEFAULT_ORIGIN : normalizeModelOrigin(d["origin"]),
      inference: absent(d["inference"]) ? undefined : normalizeInferenceModelInfo(d["inference"]),
      extensions: optionalJsonObject(ext, "extensions"),
    }),
  );
}

export const ModelInfo = {
  create: normalizeModelInfo,
  fromJSON(d: JsonObject): ModelInfo {
    return normalizeModelInfo({
      id: d["id"],
      provider: d["provider"],
      apiFamily: d["api_family"],
      aliases: d["aliases"] ?? [],
      origin: isJsonObject(d["origin"]) ? ModelOrigin.fromJSON(d["origin"]) : DEFAULT_ORIGIN,
      inference: isJsonObject(d["inference"]) ? InferenceModelInfo.fromJSON(d["inference"]) : undefined,
      extensions: d["extensions"],
    });
  },
  toJSON(m: ModelInfo): JsonObject {
    let origin = ModelOrigin.toJSON(m.origin ?? DEFAULT_ORIGIN);
    const keys = Object.keys(origin);
    if (keys.length === 1 && origin["type"] === "provider") origin = {}; // the default origin carries no information
    return omitEmpty({
      id: m.id,
      provider: m.provider,
      api_family: m.apiFamily,
      aliases: [...(m.aliases ?? [])],
      origin,
      inference: m.inference ? InferenceModelInfo.toJSON(m.inference) : undefined,
      extensions: m.extensions,
    });
  },
};

/** A registry of ModelInfo by (provider, id) with alias lookup. */
export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();
  private readonly aliases = new Map<string, string>();

  private static key(provider: string, id: string): string {
    return `${provider}\u0000${id}`;
  }

  add(model: ModelInfo, opts: { replace?: boolean } = {}): void {
    const info = normalizeModelInfo(model);
    const key = ModelRegistry.key(info.provider, info.id);
    if (opts.replace === false && this.models.has(key)) throw new ValueError(`model already registered: ${info.provider}/${info.id}`);
    this.models.set(key, info);
    for (const alias of info.aliases ?? []) this.aliases.set(ModelRegistry.key(info.provider, alias), key);
  }

  get(provider: string, model: string): ModelInfo | undefined {
    const key = ModelRegistry.key(provider, model);
    return this.models.get(key) ?? (this.aliases.has(key) ? this.models.get(this.aliases.get(key)!) : undefined);
  }

  /** Unique match by id or alias, optionally within one provider. */
  resolve(model: string, provider?: string): ModelInfo | undefined {
    if (provider !== undefined) return this.get(provider, model);
    const matches = this.matches(model);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Every entry whose id or alias equals `model`, in insertion order. */
  matches(model: string): ModelInfo[] {
    return [...this.models.values()].filter((m) => m.id === model || (m.aliases ?? []).includes(model));
  }

  list(provider?: string): ModelInfo[] {
    const values = [...this.models.values()];
    return provider === undefined ? values : values.filter((m) => m.provider === provider);
  }

  providers(): string[] {
    return [...new Set([...this.models.values()].map((m) => m.provider))].sort();
  }

  get size(): number {
    return this.models.size;
  }

  static fromJSON(entries: Iterable<JsonObject>): ModelRegistry {
    const registry = new ModelRegistry();
    for (const entry of entries) registry.add(ModelInfo.fromJSON(entry));
    return registry;
  }
}
