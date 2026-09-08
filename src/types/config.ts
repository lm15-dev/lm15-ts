/**
 * Tools, configuration, and Request (spec/types.md § Tools, § Configuration,
 * § Request). Plain readonly objects with validating constructors; the
 * `Request` a user writes is a literal `{ model, messages, tools?, config? }`
 * checked when it enters lm15 (`Request.create`, `Request.fromJSON`,
 * `router.complete`).
 */

import { float, isJsonObject, omitEmpty, type JsonObject, type JsonValue } from "../json.ts";
import {
  CACHE_MODES,
  CACHE_PREFIXES,
  CACHE_RETENTIONS,
  REASONING_EFFORTS,
  REASONING_SUMMARIES,
  TOOL_CHOICE_MODES,
  type CacheMode,
  type CachePrefix,
  type CacheRetention,
  type ReasoningEffort,
  type ReasoningSummary,
  type ToolChoiceMode,
} from "../vocab.ts";
import {
  Message,
  normalizeMessage,
  normalizeSystem,
  systemFromJSON,
  systemToJSON,
  type Part,
  type PartInput,
  type PromptPart,
} from "./parts.ts";
import {
  ValueError,
  absent,
  compact,
  extensionsField,
  frozen,
  optionalBool,
  optionalFloat,
  optionalInt,
  optionalJsonObject,
  optionalOneOf,
  optionalString,
  requireJsonObject,
  requireOneOf,
  requireString,
  stringArray,
} from "./validate.ts";

// ─── Tools ───────────────────────────────────────────────────────────

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  /** Opaque JSON Schema; defaults to `{type: "object", properties: {}}`; always emitted (INV-033). */
  readonly parameters?: JsonObject;
}

export interface BuiltinTool {
  readonly type: "builtin";
  /** Canonical builtin names (`web_search`, `code_execution`, …); unknown names pass through. */
  readonly name: string;
  readonly config?: JsonObject;
}

export type Tool = FunctionTool | BuiltinTool;

export function defaultParameters(): JsonObject {
  return { type: "object", properties: {} };
}

export function isTool(value: unknown): value is Tool {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const t = (value as { type?: unknown }).type;
  return t === "function" || t === "builtin";
}

export function normalizeTool(input: unknown): Tool {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a Tool object");
  const d = input as Record<string, unknown>;
  if (d["type"] === "builtin") {
    return frozen(
      compact({
        type: "builtin" as const,
        name: requireString(d["name"], "BuiltinTool.name", false),
        config: optionalJsonObject(d["config"], "config"),
      }),
    );
  }
  if (d["type"] !== undefined && d["type"] !== "function") {
    throw new ValueError(`unsupported tool type: ${String(d["type"])}`);
  }
  return frozen(
    compact({
      type: "function" as const,
      name: requireString(d["name"], "FunctionTool.name", false),
      description: optionalString(d["description"], "FunctionTool.description"),
      parameters: requireJsonObject(d["parameters"] ?? defaultParameters(), "parameters"),
    }),
  );
}

/**
 * Declare a function tool. Stated deviation (api-family.md § Tools): no
 * schema derivation from a function signature; the schema is written by
 * the user.
 */
export function tool(name: string, opts: { description?: string; parameters?: JsonObject } = {}): FunctionTool {
  return normalizeTool({ type: "function", name, ...opts }) as FunctionTool;
}

export function builtinTool(name: string, config?: JsonObject): BuiltinTool {
  return normalizeTool({ type: "builtin", name, config }) as BuiltinTool;
}

export const Tool = {
  create: normalizeTool,
  is: isTool,
  /** INV-034: `type: "builtin"` → BuiltinTool; anything else (or absent) → FunctionTool. */
  fromJSON(d: JsonObject): Tool {
    if (d["type"] === "builtin") return normalizeTool({ type: "builtin", name: d["name"], config: d["config"] });
    return normalizeTool({ type: "function", name: d["name"], description: d["description"], parameters: d["parameters"] });
  },
  toJSON(t: Tool): JsonObject {
    if (t.type === "builtin") return omitEmpty({ type: "builtin", name: t.name, config: t.config });
    const out = omitEmpty({ type: "function", name: t.name, description: t.description });
    out["parameters"] = t.parameters ?? defaultParameters();
    return out;
  },
};

// ─── ToolChoice ──────────────────────────────────────────────────────

export interface ToolChoice {
  readonly mode?: ToolChoiceMode;
  /** Non-empty tool names ⊆ Request.tools (INV-031). */
  readonly allowed?: readonly string[];
  /** Tri-state: `undefined` = no preference. */
  readonly parallel?: boolean;
}

export function normalizeToolChoice(input: unknown): ToolChoice {
  if (typeof input !== "object" || input === null) throw new TypeError("tool_choice must be a ToolChoice");
  const d = input as Record<string, unknown>;
  const mode = absent(d["mode"]) ? "auto" : requireOneOf(TOOL_CHOICE_MODES, d["mode"], "tool choice mode");
  const allowed = stringArray(d["allowed"], "ToolChoice.allowed");
  if (allowed.some((n) => n === "")) throw new ValueError("ToolChoice.allowed must contain non-empty tool names");
  const parallel = optionalBool(d["parallel"], "ToolChoice.parallel");
  if (mode === "none" && (allowed.length > 0 || parallel !== undefined)) {
    throw new ValueError("ToolChoice(mode='none') cannot specify allowed or parallel");
  }
  return frozen(compact({ mode, allowed: allowed.length > 0 ? Object.freeze(allowed) : undefined, parallel }));
}

export const ToolChoice = {
  create: normalizeToolChoice,
  /** Build a choice from Tool objects or names. */
  fromTools(allowed: Tool | string | ReadonlyArray<Tool | string>, opts: { mode?: ToolChoiceMode; parallel?: boolean } = {}): ToolChoice {
    const list = typeof allowed === "string" || isTool(allowed) ? [allowed] : allowed;
    const names = list.map((item) => (typeof item === "string" ? item : item.name));
    return normalizeToolChoice({ mode: opts.mode ?? "auto", allowed: names, parallel: opts.parallel });
  },
  fromJSON(d: JsonObject): ToolChoice {
    return normalizeToolChoice({ mode: d["mode"] ?? "auto", allowed: d["allowed"] ?? [], parallel: d["parallel"] });
  },
  toJSON(tc: ToolChoice): JsonObject {
    return omitEmpty({ mode: tc.mode ?? "auto", allowed: tc.allowed ? [...tc.allowed] : [], parallel: tc.parallel });
  },
};

// ─── Reasoning ───────────────────────────────────────────────────────

export interface Reasoning {
  /** The one dial (MAP-7). Required: `Reasoning` never means "the model decides" — leaving `config.reasoning` unset does. */
  readonly effort: ReasoningEffort;
  /** A token cap on budget wires only (`> 0`). */
  readonly thinkingBudget?: number;
  readonly summary?: ReasoningSummary;
}

export function normalizeReasoning(input: unknown): Reasoning {
  if (typeof input !== "object" || input === null) throw new TypeError("reasoning must be a Reasoning");
  const d = input as Record<string, unknown>;
  const effort = requireOneOf(REASONING_EFFORTS, d["effort"], "reasoning effort");
  const summary = optionalOneOf(REASONING_SUMMARIES, d["summary"], "reasoning summary");
  const thinkingBudget = optionalInt(d["thinkingBudget"], "thinking_budget", { min: 1 });
  if (effort === "off" && (thinkingBudget !== undefined || summary !== undefined)) {
    throw new ValueError("Reasoning(effort='off') cannot specify thinking_budget or summary");
  }
  return frozen(compact({ effort, thinkingBudget, summary }));
}

export function isReasoningOff(r: Reasoning | undefined): boolean {
  return r !== undefined && r.effort === "off";
}

export const Reasoning = {
  create: normalizeReasoning,
  /** INV-043: legacy `enabled: false` → off, `budget` → thinking_budget, `adaptive` → medium; off discards budgets. */
  fromJSON(d: JsonObject): Reasoning {
    const defaultEffort = d["enabled"] === false ? "off" : "medium";
    let effort = d["effort"] ?? defaultEffort;
    if (effort === "adaptive") effort = "medium";
    if (effort === "off") return normalizeReasoning({ effort: "off" });
    return normalizeReasoning({ effort, thinkingBudget: d["thinking_budget"] ?? d["budget"], summary: d["summary"] });
  },
  toJSON(r: Reasoning): JsonObject {
    return omitEmpty({ effort: r.effort, thinking_budget: r.thinkingBudget, summary: r.summary });
  },
};

// ─── CacheConfig ─────────────────────────────────────────────────────

export interface CacheConfig {
  readonly mode?: CacheMode;
  readonly retention?: CacheRetention;
  readonly key?: string;
  /** Index of the last message of the reusable prefix; exclusive with `prefix`. */
  readonly prefixUntilIndex?: number;
  readonly prefix?: CachePrefix;
  /** A `CacheInfo.id` naming a stored cache object. */
  readonly resource?: string;
}

export function normalizeCacheConfig(input: unknown): CacheConfig {
  if (typeof input !== "object" || input === null) throw new TypeError("cache must be a CacheConfig");
  const d = input as Record<string, unknown>;
  const mode = absent(d["mode"]) ? "auto" : requireOneOf(CACHE_MODES, d["mode"], "cache mode");
  const retention = optionalOneOf(CACHE_RETENTIONS, d["retention"], "cache retention");
  const prefix = optionalOneOf(CACHE_PREFIXES, d["prefix"], "cache prefix");
  const key = optionalString(d["key"], "CacheConfig.key", false);
  const resource = optionalString(d["resource"], "CacheConfig.resource", false);
  const prefixUntilIndex = optionalInt(d["prefixUntilIndex"], "prefix_until_index", { min: 0 });
  if (
    mode === "off" &&
    (retention !== undefined || key !== undefined || prefix !== undefined || prefixUntilIndex !== undefined || resource !== undefined)
  ) {
    throw new ValueError("CacheConfig(mode='off') cannot specify retention, key, prefix, prefix_until_index, or resource");
  }
  if (prefix !== undefined && prefixUntilIndex !== undefined) {
    throw new ValueError("CacheConfig cannot specify both prefix and prefix_until_index");
  }
  return frozen(compact({ mode, retention, key, prefixUntilIndex, prefix, resource }));
}

export const CacheConfig = {
  create: normalizeCacheConfig,
  fromJSON(d: JsonObject): CacheConfig {
    return normalizeCacheConfig({
      mode: d["mode"] ?? "auto",
      retention: d["retention"],
      key: d["key"],
      prefixUntilIndex: d["prefix_until_index"],
      prefix: d["prefix"],
      resource: d["resource"],
    });
  },
  toJSON(c: CacheConfig): JsonObject {
    return omitEmpty({
      mode: c.mode ?? "auto",
      retention: c.retention,
      key: c.key,
      prefix_until_index: c.prefixUntilIndex,
      prefix: c.prefix,
      resource: c.resource,
    });
  },
};

// ─── Config ──────────────────────────────────────────────────────────

export type ResponseFormat =
  | { readonly type: "json_object" }
  | { readonly type: "json_schema"; readonly schema: JsonObject; readonly name?: string; readonly strict?: boolean };

export interface Config {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stop?: readonly string[];
  /** Exactly two shapes (INV-050); `schema` is opaque and verbatim. */
  readonly responseFormat?: ResponseFormat;
  readonly toolChoice?: ToolChoice;
  readonly reasoning?: Reasoning;
  readonly cache?: CacheConfig;
  /** Open namespace; the provider's own tier words. */
  readonly serviceTier?: string;
  readonly userId?: string;
  /** `false` is data (the opt-out) and is emitted. */
  readonly store?: boolean;
  /** `undefined` = do not request; `0` = chosen tokens only; `n` = also top-n alternatives. */
  readonly logprobs?: number;
  /** Provider-syntax passthrough; `{}` normalizes to absent (INV-004). */
  readonly extensions?: JsonObject;
}

const RESPONSE_FORMAT_TYPES = ["json_object", "json_schema"];

function validateResponseFormat(value: JsonObject | undefined): ResponseFormat | undefined {
  if (value === undefined) return undefined;
  const fmt = value["type"];
  if (typeof fmt !== "string" || !RESPONSE_FORMAT_TYPES.includes(fmt)) {
    throw new ValueError(
      `response_format must be {'type': 'json_object'} or {'type': 'json_schema', 'schema': {...}, 'name'?: str, 'strict'?: bool}; provider-native shapes go in Config.extensions (got keys ${JSON.stringify(Object.keys(value).sort())})`,
    );
  }
  const allowed = fmt === "json_object" ? ["type"] : ["type", "schema", "name", "strict"];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new ValueError(`response_format '${fmt}' does not take keys ${JSON.stringify(extra.sort())}; provider-native shapes go in Config.extensions`);
  }
  if (fmt === "json_schema") {
    if (!isJsonObject(value["schema"])) throw new ValueError("response_format json_schema requires a 'schema' object");
    if ("name" in value && (typeof value["name"] !== "string" || value["name"] === "")) {
      throw new ValueError("response_format name must be a non-empty string");
    }
    if ("strict" in value && typeof value["strict"] !== "boolean") throw new TypeError("response_format strict must be a bool");
  }
  return value as unknown as ResponseFormat;
}

export function normalizeConfig(input: unknown): Config {
  if (absent(input)) return EMPTY_CONFIG;
  if (typeof input !== "object") throw new TypeError("Request.config must be a Config");
  const d = input as Record<string, unknown>;
  for (const field of ["temperature", "topP"] as const) {
    const v = d[field];
    if (!absent(v) && (typeof v === "boolean" || (typeof v !== "number" && !(typeof v === "object")))) {
      throw new TypeError(`${field === "topP" ? "top_p" : field} must be numeric`);
    }
  }
  const temperature = optionalFloat(d["temperature"], "temperature");
  if (temperature !== undefined && temperature < 0) throw new ValueError("temperature must be >= 0");
  const topP = optionalFloat(d["topP"], "top_p");
  if (topP !== undefined && !(topP >= 0 && topP <= 1)) throw new ValueError("top_p must be in [0, 1]");
  const stop = stringArray(d["stop"], "stop");
  const config: Config = compact({
    maxTokens: optionalInt(d["maxTokens"], "max_tokens", { min: 1 }),
    temperature,
    topP,
    topK: optionalInt(d["topK"], "top_k", { min: 1 }),
    stop: stop.length > 0 ? Object.freeze(stop) : undefined,
    responseFormat: validateResponseFormat(optionalJsonObject(d["responseFormat"], "response_format")),
    toolChoice: absent(d["toolChoice"]) ? undefined : normalizeToolChoice(d["toolChoice"]),
    reasoning: absent(d["reasoning"]) ? undefined : normalizeReasoning(d["reasoning"]),
    cache: absent(d["cache"]) ? undefined : normalizeCacheConfig(d["cache"]),
    serviceTier: optionalString(d["serviceTier"], "Config.service_tier", false),
    userId: optionalString(d["userId"], "Config.user_id", false),
    store: optionalBool(d["store"], "Config.store"),
    logprobs: optionalInt(d["logprobs"], "logprobs", { min: 0 }),
    extensions: extensionsField(d["extensions"]),
  });
  return frozen(config);
}

const EMPTY_CONFIG: Config = Object.freeze({});

export function isDefaultConfig(config: Config | undefined): boolean {
  return config === undefined || Object.keys(Config.toJSON(config)).length === 0;
}

/** INV-042: a present non-object nest is malformed input, never silent loss. */
function configNest(d: JsonObject, key: string): JsonObject | undefined {
  const value = d[key];
  if (absent(value)) return undefined;
  if (!isJsonObject(value)) throw new TypeError(`config.${key} must be a JSON object, got ${Array.isArray(value) ? "list" : typeof value}`);
  return value;
}

export const Config = {
  create: normalizeConfig,
  fromJSON(d: JsonObject): Config {
    const toolChoice = configNest(d, "tool_choice");
    const reasoning = configNest(d, "reasoning");
    const cache = configNest(d, "cache");
    return normalizeConfig({
      maxTokens: d["max_tokens"],
      temperature: d["temperature"],
      topP: d["top_p"],
      topK: d["top_k"],
      stop: d["stop"] ?? [],
      responseFormat: d["response_format"],
      toolChoice: toolChoice ? ToolChoice.fromJSON(toolChoice) : undefined,
      reasoning: reasoning ? Reasoning.fromJSON(reasoning) : undefined,
      cache: cache ? CacheConfig.fromJSON(cache) : undefined,
      serviceTier: d["service_tier"],
      userId: d["user_id"],
      store: d["store"],
      logprobs: d["logprobs"],
      extensions: d["extensions"],
    });
  },
  toJSON(c: Config): JsonObject {
    const out = omitEmpty({
      max_tokens: c.maxTokens,
      temperature: float(c.temperature),
      top_p: float(c.topP),
      top_k: c.topK,
      stop: c.stop ? [...c.stop] : [],
      response_format: c.responseFormat as unknown as JsonValue,
      tool_choice: c.toolChoice ? ToolChoice.toJSON(c.toolChoice) : undefined,
      reasoning: c.reasoning ? Reasoning.toJSON(c.reasoning) : undefined,
      cache: c.cache ? CacheConfig.toJSON(c.cache) : undefined,
      service_tier: c.serviceTier,
      user_id: c.userId,
      extensions: c.extensions,
    });
    // false / 0 are data, not emptiness — emitted.
    if (c.store !== undefined) out["store"] = c.store;
    if (c.logprobs !== undefined) out["logprobs"] = c.logprobs;
    return out;
  },
};

// ─── Request ─────────────────────────────────────────────────────────

export interface Request {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string | readonly PromptPart[];
  readonly tools?: readonly Tool[];
  readonly config?: Config;
}

export interface RequestInput {
  readonly model: string;
  readonly messages: Message | readonly Message[];
  readonly system?: string | PartInput<PromptPart> | null;
  readonly tools?: Tool | readonly Tool[] | null;
  readonly config?: Config | null;
}

export function normalizeRequest(input: unknown): Request {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a Request object");
  const d = input as Record<string, unknown>;
  if (typeof d["model"] !== "string" || d["model"] === "") throw new ValueError("model is required");
  const rawMessages = d["messages"];
  const list = Array.isArray(rawMessages) ? rawMessages : absent(rawMessages) ? [] : [rawMessages];
  if (list.length === 0) throw new ValueError("at least one message is required");
  const messages = Object.freeze(
    list.map((m) => {
      if (typeof m !== "object" || m === null || typeof (m as { role?: unknown }).role !== "string") {
        throw new TypeError('Request.messages must contain Message objects — wrap plain text with Message.user("...").');
      }
      return normalizeMessage(m);
    }),
  );
  const rawTools = d["tools"];
  const toolList = Array.isArray(rawTools) ? rawTools : absent(rawTools) ? [] : [rawTools];
  const tools = Object.freeze(
    toolList.map((t) => {
      if (!isTool(t)) throw new TypeError("Request.tools must contain Tool objects");
      return normalizeTool(t);
    }),
  );
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new ValueError("Request.tools cannot contain duplicate tool names");
  const config = normalizeConfig(d["config"]);
  if (config.toolChoice?.allowed) {
    const missing = config.toolChoice.allowed.filter((n) => !names.includes(n));
    if (missing.length > 0) {
      throw new ValueError(`ToolChoice.allowed contains tools not present in Request.tools: ${JSON.stringify([...missing].sort())}`);
    }
  }
  return frozen(
    compact({
      model: d["model"],
      messages,
      system: normalizeSystem(d["system"]),
      tools: tools.length > 0 ? tools : undefined,
      config: Object.keys(config).length > 0 ? config : undefined,
    }),
  ) as Request;
}

export const Request = {
  /** The validating constructor: `Request.create({ model, messages, ... })`. */
  create(input: RequestInput): Request {
    return normalizeRequest(input);
  },
  fromJSON(d: JsonObject): Request {
    if (!isJsonObject(d)) throw new TypeError("Request.fromJSON expects an object");
    const messages = d["messages"];
    if (!Array.isArray(messages)) throw new TypeError("Request.messages must be a list");
    const tools = d["tools"] ?? [];
    if (!Array.isArray(tools)) throw new TypeError("Request.tools must be a list");
    return normalizeRequest({
      model: d["model"],
      messages: messages.map((m) => {
        if (!isJsonObject(m)) throw new TypeError("Request.messages must contain Message objects");
        return Message.fromJSON(m);
      }),
      system: systemFromJSON(d["system"]),
      tools: tools.map((t) => {
        if (!isJsonObject(t)) throw new TypeError("Request.tools must contain Tool objects");
        return Tool.fromJSON(t);
      }),
      config: isJsonObject(d["config"]) ? Config.fromJSON(d["config"]) : absent(d["config"]) ? undefined : d["config"],
    });
  },
  toJSON(r: Request): JsonObject {
    return omitEmpty({
      model: r.model,
      messages: r.messages.map(Message.toJSON),
      system: systemToJSON(r.system),
      tools: (r.tools ?? []).map(Tool.toJSON),
      config: r.config ? Config.toJSON(r.config) : {},
    });
  },
};

export type { Part };
