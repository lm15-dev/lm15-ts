/**
 * Compatibility presets: how a dialect serializes a canonical request for a
 * specific server (mirrors `lm15.compat`, copied as data). A preset says
 * nothing about credentials or routing — that is the registry.
 *
 * Partial values: an absent field inherits; `"auto"` is the dialect's own
 * default, spelled explicitly. `resolve*` turns a partial into concrete
 * policy.
 */

import { isJsonObject, type JsonObject } from "./json.ts";
import { REASONING_EFFORTS } from "./vocab.ts";
import { ValueError } from "./types/validate.ts";
import { NotConfiguredError } from "./errors.ts";

export {
  ANTHROPIC_PRESET_BASE_URLS,
  OPENAI_CHAT_PRESET_BASE_URLS,
  OPENAI_RESPONSES_PRESET_BASE_URLS,
} from "./auth/policy.ts";

/** MAP-10: what a ToolResultPart's media parts may become on the wire. */
export type ToolResultMedia = "native" | "images" | "reject";
type Auto<T extends string> = T | "auto";

// ─── OpenAI Responses ────────────────────────────────────────────────

export interface OpenAIResponsesCompat {
  readonly developerRole?: Auto<"developer" | "system">;
  readonly maxOutputTokensField?: Auto<"max_output_tokens" | "max_completion_tokens" | "max_tokens">;
  readonly reasoningFormat?: Auto<"none" | "responses_reasoning" | "reasoning_effort" | "openrouter" | "deepseek" | "qwen" | "qwen_chat_template" | "zai">;
  readonly toolResultName?: Auto<"include" | "omit">;
  readonly strictTools?: Auto<"include" | "omit">;
  readonly cacheControl?: Auto<"none" | "openai" | "openai_implicit" | "anthropic">;
  readonly commentaryPhase?: Auto<"omit" | "tag">;
  readonly editImageField?: Auto<"array" | "indexed">;
  readonly builtinTools?: Auto<"openai" | "verbatim">;
  readonly toolResultMedia?: Auto<ToolResultMedia>;
  readonly routing?: JsonObject;
  readonly extensions?: JsonObject;
}

export interface ResolvedOpenAIResponsesCompat {
  readonly developerRole: "developer" | "system";
  readonly maxOutputTokensField: "max_output_tokens" | "max_completion_tokens" | "max_tokens";
  readonly reasoningFormat: "none" | "responses_reasoning" | "reasoning_effort" | "openrouter" | "deepseek" | "qwen" | "qwen_chat_template" | "zai";
  readonly toolResultName: "include" | "omit";
  readonly strictTools: "include" | "omit";
  readonly cacheControl: "none" | "openai" | "openai_implicit" | "anthropic";
  readonly commentaryPhase: "omit" | "tag";
  readonly editImageField: "array" | "indexed";
  readonly builtinTools: "openai" | "verbatim";
  readonly toolResultMedia: ToolResultMedia;
  readonly routing?: JsonObject;
  readonly extensions?: JsonObject;
}

export const OPENAI_RESPONSES_PRESETS: Readonly<Record<string, OpenAIResponsesCompat>> = Object.freeze({
  openai: {
    developerRole: "developer",
    maxOutputTokensField: "max_output_tokens",
    reasoningFormat: "responses_reasoning",
    toolResultName: "omit",
    strictTools: "omit",
    cacheControl: "openai",
  },
  openrouter: {
    developerRole: "developer",
    maxOutputTokensField: "max_tokens",
    reasoningFormat: "openrouter",
    toolResultName: "omit",
    strictTools: "omit",
    cacheControl: "openai",
    toolResultMedia: "reject",
  },
  ollama: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "none", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  get lmstudio() { return this.ollama; }, // LM Studio: ollama's wire policy at its own address (api-family, 2026-09-11)
  vllm: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "reasoning_effort", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  sglang: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "reasoning_effort", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  qwen: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "qwen", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  deepseek: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "deepseek", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  zai: { developerRole: "system", maxOutputTokensField: "max_tokens", reasoningFormat: "zai", toolResultName: "omit", strictTools: "omit", cacheControl: "none", toolResultMedia: "reject" },
  meta: {
    developerRole: "developer",
    maxOutputTokensField: "max_output_tokens",
    reasoningFormat: "responses_reasoning",
    toolResultName: "omit",
    strictTools: "omit",
    cacheControl: "openai_implicit",
    commentaryPhase: "tag",
    editImageField: "indexed",
    builtinTools: "verbatim",
    toolResultMedia: "native",
  },
  moonshotai: {
    developerRole: "developer",
    maxOutputTokensField: "max_output_tokens",
    reasoningFormat: "responses_reasoning",
    toolResultName: "omit",
    strictTools: "omit",
    cacheControl: "openai_implicit",
    builtinTools: "verbatim",
    toolResultMedia: "images",
  },
});

function pick<T extends string>(value: Auto<T> | undefined, dflt: T): T {
  return value === undefined || value === "auto" ? dflt : value;
}

export function resolveOpenAIResponsesCompat(partial: OpenAIResponsesCompat = {}): ResolvedOpenAIResponsesCompat {
  const out: ResolvedOpenAIResponsesCompat = {
    developerRole: pick(partial.developerRole, "developer"),
    maxOutputTokensField: pick(partial.maxOutputTokensField, "max_output_tokens"),
    reasoningFormat: pick(partial.reasoningFormat, "responses_reasoning"),
    toolResultName: pick(partial.toolResultName, "omit"),
    strictTools: pick(partial.strictTools, "omit"),
    cacheControl: pick(partial.cacheControl, "openai"),
    commentaryPhase: pick(partial.commentaryPhase, "omit"),
    editImageField: pick(partial.editImageField, "array"),
    builtinTools: pick(partial.builtinTools, "openai"),
    toolResultMedia: pick(partial.toolResultMedia, "native"),
    ...(partial.routing ? { routing: partial.routing } : {}),
    ...(partial.extensions ? { extensions: partial.extensions } : {}),
  };
  return out;
}

export function mergeOpenAIResponsesCompat(base: OpenAIResponsesCompat, override?: OpenAIResponsesCompat): OpenAIResponsesCompat {
  if (!override) return base;
  return mergePartial(base, override);
}

// ─── OpenAI Chat Completions ─────────────────────────────────────────

export type ChatThinkingFormat = "none" | "reasoning_effort" | "openrouter" | "deepseek" | "kimi" | "qwen" | "qwen_chat_template";

export interface OpenAIChatCompat {
  readonly instructionRole?: Auto<"developer" | "system">;
  readonly maxTokensField?: Auto<"max_completion_tokens" | "max_tokens">;
  readonly streamUsage?: Auto<"include" | "omit">;
  readonly toolResultName?: Auto<"include" | "omit">;
  readonly assistantAfterToolResult?: Auto<"insert" | "omit">;
  readonly thinkingFormat?: Auto<ChatThinkingFormat>;
  readonly thinkingReplay?: Auto<"native" | "as_text" | "omit">;
  readonly assistantReasoningContent?: Auto<"include_empty" | "omit">;
  readonly strictTools?: Auto<"include" | "omit">;
  readonly builtinTools?: Auto<"reject" | "groq">;
  readonly toolResultMedia?: Auto<ToolResultMedia>;
  readonly cacheControl?: Auto<"none" | "openai" | "openai_implicit" | "anthropic">;
  readonly userField?: Auto<"user" | "user_id" | "safety_identifier">;
  readonly forcedToolChoice?: Auto<"send" | "reject">;
  readonly jsonSchema?: Auto<"send" | "reject">;
  /** The server's native effort words when it does NOT refuse the others (MAP-7 rule 2). */
  readonly reasoningEfforts?: readonly string[];
  readonly routing?: JsonObject;
  readonly extensions?: JsonObject;
  /** `(model-id prefix, knobs)`; the first matching prefix wins. */
  readonly modelOverrides?: ReadonlyArray<readonly [string, Partial<OpenAIChatCompat>]>;
}

export interface ResolvedOpenAIChatCompat {
  readonly instructionRole: "developer" | "system";
  readonly maxTokensField: "max_completion_tokens" | "max_tokens";
  readonly streamUsage: "include" | "omit";
  readonly toolResultName: "include" | "omit";
  readonly assistantAfterToolResult: "insert" | "omit";
  readonly thinkingFormat: ChatThinkingFormat;
  readonly thinkingReplay: "native" | "as_text" | "omit";
  readonly assistantReasoningContent: "include_empty" | "omit";
  readonly strictTools: "include" | "omit";
  readonly builtinTools: "reject" | "groq";
  readonly toolResultMedia: ToolResultMedia;
  readonly cacheControl: "none" | "openai" | "openai_implicit" | "anthropic";
  readonly userField: "user" | "user_id" | "safety_identifier";
  readonly forcedToolChoice: "send" | "reject";
  readonly jsonSchema: "send" | "reject";
  readonly reasoningEfforts?: readonly string[];
  readonly routing?: JsonObject;
  readonly extensions?: JsonObject;
}

const CHAT_BASE = {
  instructionRole: "system",
  streamUsage: "include",
  toolResultName: "omit",
  strictTools: "omit",
} as const;

export const OPENAI_CHAT_PRESETS: Readonly<Record<string, OpenAIChatCompat>> = Object.freeze({
  openai: { ...CHAT_BASE, maxTokensField: "max_completion_tokens", thinkingFormat: "reasoning_effort", cacheControl: "openai", toolResultMedia: "reject" },
  ollama: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "none", cacheControl: "none", toolResultMedia: "reject" },
  // LM Studio: ollama's wire policy (lmstudio.ai docs list the same Chat
  // Completions fields: max_tokens, no reasoning dial) at its own documented
  // address, http://localhost:1234/v1. Until 2026-09-11 the name was an alias
  // of "ollama" and took ollama's port. No live receipt for the policy yet.
  get lmstudio() { return this.ollama; },
  groq: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "reasoning_effort", builtinTools: "groq", cacheControl: "none", toolResultMedia: "reject" },
  openrouter: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "openrouter", cacheControl: "openai", toolResultMedia: "reject" },
  xai: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "deepseek", cacheControl: "none", toolResultMedia: "images" },
  vllm: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "reasoning_effort", cacheControl: "none", toolResultMedia: "reject" },
  sglang: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "reasoning_effort", cacheControl: "none", toolResultMedia: "reject" },
  deepseek: {
    ...CHAT_BASE,
    maxTokensField: "max_tokens",
    thinkingFormat: "deepseek",
    thinkingReplay: "native",
    assistantReasoningContent: "include_empty",
    cacheControl: "none",
    userField: "user_id",
    toolResultMedia: "reject",
  },
  qwen: { ...CHAT_BASE, maxTokensField: "max_tokens", thinkingFormat: "qwen", cacheControl: "none" },
  bedrock: {
    ...CHAT_BASE,
    maxTokensField: "max_completion_tokens",
    thinkingFormat: "reasoning_effort",
    cacheControl: "none",
    userField: "user",
    forcedToolChoice: "send",
    jsonSchema: "send",
    modelOverrides: [
      ["openai.gpt-oss", { forcedToolChoice: "reject", jsonSchema: "reject" }],
      ["google.gemma", { forcedToolChoice: "reject" }],
    ],
    toolResultMedia: "reject",
  },
  bedrock_mantle: {
    ...CHAT_BASE,
    maxTokensField: "max_completion_tokens",
    thinkingFormat: "reasoning_effort",
    cacheControl: "none",
    userField: "user",
    forcedToolChoice: "send",
    jsonSchema: "send",
    modelOverrides: [["openai.gpt-oss", { forcedToolChoice: "reject", jsonSchema: "reject" }]],
  },
  zai: {
    ...CHAT_BASE,
    maxTokensField: "max_tokens",
    thinkingFormat: "deepseek",
    thinkingReplay: "native",
    cacheControl: "none",
    userField: "user_id",
    forcedToolChoice: "reject",
    jsonSchema: "reject",
    toolResultMedia: "images",
  },
  meta: {
    ...CHAT_BASE,
    instructionRole: "developer",
    maxTokensField: "max_completion_tokens",
    thinkingFormat: "reasoning_effort",
    cacheControl: "openai_implicit",
    userField: "safety_identifier",
    toolResultMedia: "reject",
  },
  moonshotai: {
    ...CHAT_BASE,
    maxTokensField: "max_completion_tokens",
    thinkingFormat: "kimi",
    thinkingReplay: "native",
    cacheControl: "openai_implicit",
    userField: "safety_identifier",
    reasoningEfforts: ["low", "high", "max"],
    toolResultMedia: "images",
  },
});

export function resolveOpenAIChatCompat(partial: OpenAIChatCompat = {}): ResolvedOpenAIChatCompat {
  return {
    instructionRole: pick(partial.instructionRole, "system"),
    maxTokensField: pick(partial.maxTokensField, "max_completion_tokens"),
    streamUsage: pick(partial.streamUsage, "include"),
    toolResultName: pick(partial.toolResultName, "omit"),
    assistantAfterToolResult: pick(partial.assistantAfterToolResult, "omit"),
    thinkingFormat: pick(partial.thinkingFormat, "reasoning_effort"),
    thinkingReplay: pick(partial.thinkingReplay, "as_text"),
    assistantReasoningContent: pick(partial.assistantReasoningContent, "omit"),
    strictTools: pick(partial.strictTools, "omit"),
    builtinTools: pick(partial.builtinTools, "reject"),
    toolResultMedia: pick(partial.toolResultMedia, "reject"),
    cacheControl: pick(partial.cacheControl, "openai"),
    userField: pick(partial.userField, "user"),
    forcedToolChoice: pick(partial.forcedToolChoice, "send"),
    jsonSchema: pick(partial.jsonSchema, "send"),
    ...(partial.reasoningEfforts ? { reasoningEfforts: partial.reasoningEfforts } : {}),
    ...(partial.routing ? { routing: partial.routing } : {}),
    ...(partial.extensions ? { extensions: partial.extensions } : {}),
  };
}

/** This compat with the first matching `modelOverrides` entry applied. */
export function chatCompatForModel(compat: OpenAIChatCompat, model: string): OpenAIChatCompat {
  for (const [prefix, knobs] of compat.modelOverrides ?? []) {
    if (model.startsWith(prefix)) {
      const { modelOverrides: _drop, ...rest } = compat;
      return { ...rest, ...knobs };
    }
  }
  return compat;
}

export function mergeOpenAIChatCompat(base: OpenAIChatCompat, override?: OpenAIChatCompat): OpenAIChatCompat {
  if (!override) return base;
  return mergePartial(base, override);
}

// ─── Anthropic Messages ──────────────────────────────────────────────

export interface AnthropicCompat {
  readonly thinkingFormat?: Auto<"anthropic" | "deepseek" | "adaptive" | "effort">;
  readonly thinkingReplay?: Auto<"signed" | "unsigned">;
  readonly cacheControl?: Auto<"anthropic" | "none">;
  readonly structuredOutput?: Auto<"send" | "reject">;
  readonly parallelToolCalls?: Auto<"send" | "reject">;
  readonly samplingParams?: Auto<"send" | "reject">;
  readonly toolResultMedia?: Auto<ToolResultMedia>;
  readonly reasoningEfforts?: readonly string[];
  /** Refuse, before the wire, a model id not starting with one of these. */
  readonly modelPrefixes?: readonly string[];
  readonly extensions?: JsonObject;
}

export interface ResolvedAnthropicCompat {
  readonly thinkingFormat: "anthropic" | "deepseek" | "adaptive" | "effort";
  readonly thinkingReplay: "signed" | "unsigned";
  readonly cacheControl: "anthropic" | "none";
  readonly structuredOutput: "send" | "reject";
  readonly parallelToolCalls: "send" | "reject";
  readonly samplingParams: "send" | "reject";
  readonly toolResultMedia: ToolResultMedia;
  readonly reasoningEfforts?: readonly string[];
  readonly modelPrefixes?: readonly string[];
  readonly extensions?: JsonObject;
}

export const ANTHROPIC_PRESETS: Readonly<Record<string, AnthropicCompat>> = Object.freeze({
  anthropic: {},
  deepseek: {
    thinkingFormat: "deepseek",
    cacheControl: "none",
    structuredOutput: "reject",
    parallelToolCalls: "reject",
    modelPrefixes: ["deepseek-"],
    toolResultMedia: "reject",
  },
  meta: { thinkingFormat: "adaptive", cacheControl: "none", structuredOutput: "send", parallelToolCalls: "send", toolResultMedia: "native" },
  moonshotai: {
    thinkingFormat: "effort",
    thinkingReplay: "unsigned",
    cacheControl: "none",
    structuredOutput: "send",
    parallelToolCalls: "reject",
    samplingParams: "reject",
    reasoningEfforts: ["low", "high", "max"],
    modelPrefixes: ["kimi-"],
    toolResultMedia: "images",
  },
});

export function resolveAnthropicCompat(partial: AnthropicCompat = {}): ResolvedAnthropicCompat {
  return {
    thinkingFormat: pick(partial.thinkingFormat, "anthropic"),
    thinkingReplay: pick(partial.thinkingReplay, "signed"),
    cacheControl: pick(partial.cacheControl, "anthropic"),
    structuredOutput: pick(partial.structuredOutput, "send"),
    parallelToolCalls: pick(partial.parallelToolCalls, "send"),
    samplingParams: pick(partial.samplingParams, "send"),
    toolResultMedia: pick(partial.toolResultMedia, "native"),
    ...(partial.reasoningEfforts ? { reasoningEfforts: partial.reasoningEfforts } : {}),
    ...(partial.modelPrefixes ? { modelPrefixes: partial.modelPrefixes } : {}),
    ...(partial.extensions ? { extensions: partial.extensions } : {}),
  };
}

export function mergeAnthropicCompat(base: AnthropicCompat, override?: AnthropicCompat): AnthropicCompat {
  if (!override) return base;
  return mergePartial(base, override);
}

// ─── Shared ──────────────────────────────────────────────────────────

/** Absent fields inherit; present ones (including "auto") override; `extensions` merge. */
function mergePartial<T extends { readonly extensions?: JsonObject }>(base: T, override: T): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (key === "extensions" && isJsonObject(base.extensions) && isJsonObject(value)) {
      out[key] = { ...base.extensions, ...value };
    } else out[key] = value;
  }
  return out as T;
}

/** Spelling aliases → canonical preset key. Every alias is permanent. */
const PRESET_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  openai_chat: "openai",
  chat: "openai",
  chat_completions: "openai",
  responses: "openai",
  openai_responses: "openai",
  lm_studio: "lmstudio",
  dashscope_qwen: "qwen",
  z_ai: "zai",
});

export function presetKey(name: string): string {
  const key = name.toLowerCase().replace(/[-\s.]/g, "_");
  return PRESET_ALIASES[key] ?? key;
}

/**
 * The address a preset name supplies for one dialect (api-family, 2026-09-11).
 * A name that names a server supplies that server's root. Only the dialect's
 * own default (`defaultPreset`: `openai` / `anthropic`) resolves to the cloud
 * default. Any other name with no entry in `table` is refused with
 * `NotConfiguredError`: a request meant for a named server must never be
 * sent to the OpenAI cloud with whatever key is around because a table
 * lacked a row (before, `compat: "lmstudio"` went to ollama's port here and
 * to api.openai.com in Python).
 */
export function presetBaseUrl(table: Readonly<Record<string, string>>, name: string, dialect: string, defaultPreset: string): string {
  const key = presetKey(name);
  const url = table[key];
  if (url !== undefined) return url;
  if (key === defaultPreset) return table[defaultPreset]!;
  throw new NotConfiguredError(
    `compat ${JSON.stringify(name)} names a server whose ${dialect} address lm15 does not know; pass baseUrl (the server's OpenAI-compatible root, e.g. "http://localhost:PORT/v1")`,
  );
}

export function openaiChatPreset(name: string): OpenAIChatCompat {
  const p = OPENAI_CHAT_PRESETS[presetKey(name)];
  if (!p) throw new ValueError(`unknown OpenAIChatCompat preset: ${JSON.stringify(name)}`);
  return p;
}

export function openaiResponsesPreset(name: string): OpenAIResponsesCompat {
  const p = OPENAI_RESPONSES_PRESETS[presetKey(name)];
  if (!p) throw new ValueError(`unknown OpenAIResponsesCompat preset: ${JSON.stringify(name)}`);
  return p;
}

export function anthropicPreset(name: string): AnthropicCompat {
  const p = ANTHROPIC_PRESETS[presetKey(name)];
  if (!p) throw new ValueError(`unknown AnthropicCompat preset: ${JSON.stringify(name)}`);
  return p;
}

export function validateReasoningEfforts(words: readonly string[] | undefined): void {
  if (!words) return;
  const bad = words.filter((w) => !(REASONING_EFFORTS as readonly string[]).includes(w) || w === "off");
  if (bad.length > 0) throw new ValueError(`reasoning_efforts must be ReasoningEffort words other than 'off'; got ${JSON.stringify(words)}`);
}

/** MAP-7: the one effort→budget grading table. */
export const EFFORT_THINKING_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
});
