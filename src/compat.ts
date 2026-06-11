/**
 * Provider/API compatibility policies (wire-dialect quirks).
 *
 * Mirrors the contract's compat layering: a base-URL/preset default,
 * optionally overridden by request-level `config.extensions` escape hatches
 * (`openai_responses_compat` / `openai_chat_compat` / `compat`). Resolved
 * policies drive the serializers in the adapter classes.
 */

import { isJsonObject, type JsonObject } from "./canonical-json.js";
import { ValueError } from "./errors.js";

// ─── OpenAI Responses ────────────────────────────────────────────────

export interface ResolvedOpenAIResponsesCompat {
  readonly developer_role: "developer" | "system";
  readonly max_output_tokens_field: "max_output_tokens" | "max_completion_tokens" | "max_tokens";
  readonly reasoning_format:
    | "none"
    | "responses_reasoning"
    | "reasoning_effort"
    | "openrouter"
    | "deepseek"
    | "qwen"
    | "qwen_chat_template"
    | "zai";
  readonly tool_result_name: "include" | "omit";
  readonly strict_tools: "include" | "omit";
  readonly cache_control: "none" | "openai" | "anthropic";
  readonly routing: JsonObject | null;
}

const RESPONSES_DEFAULT: ResolvedOpenAIResponsesCompat = {
  developer_role: "developer",
  max_output_tokens_field: "max_output_tokens",
  reasoning_format: "responses_reasoning",
  tool_result_name: "omit",
  strict_tools: "omit",
  cache_control: "openai",
  routing: null,
};

const RESPONSES_PRESETS: Record<string, Partial<ResolvedOpenAIResponsesCompat>> = {
  openai: {},
  responses: {},
  openai_responses: {},
  openrouter: {
    max_output_tokens_field: "max_tokens",
    reasoning_format: "openrouter",
  },
  ollama: {
    developer_role: "system",
    max_output_tokens_field: "max_tokens",
    reasoning_format: "none",
    cache_control: "none",
  },
  vllm: {
    developer_role: "system",
    max_output_tokens_field: "max_tokens",
    reasoning_format: "reasoning_effort",
    cache_control: "none",
  },
  sglang: {
    developer_role: "system",
    max_output_tokens_field: "max_tokens",
    reasoning_format: "reasoning_effort",
    cache_control: "none",
  },
};

function presetKey(name: string): string {
  return name.toLowerCase().replace(/[- ]/g, "_");
}

function compatOverrideFromExtensions(
  extensions: JsonObject | null,
  ownKey: string,
  compatKeys: readonly string[],
): JsonObject | null {
  if (extensions === null) return null;
  let raw = extensions[ownKey];
  if (raw === undefined) raw = extensions["openai_compat"];
  if (raw === undefined) {
    const compat = extensions["compat"];
    if (isJsonObject(compat)) {
      for (const key of compatKeys) {
        if (compat[key] !== undefined) {
          raw = compat[key];
          break;
        }
      }
    }
  }
  return isJsonObject(raw) ? raw : null;
}

function applyOverride<T extends object>(base: T, override: JsonObject | null, fields: readonly (keyof T & string)[]): T {
  if (override === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const field of fields) {
    const value = override[field];
    if (value !== undefined && value !== null && value !== "auto") {
      out[field] = value;
    }
  }
  return out as T;
}

export function resolveOpenAIResponsesCompat(
  baseUrl: string,
  extensions: JsonObject | null,
): ResolvedOpenAIResponsesCompat {
  const lower = baseUrl.toLowerCase();
  let base: ResolvedOpenAIResponsesCompat = RESPONSES_DEFAULT;
  if (lower.includes("openrouter.ai")) {
    base = { ...RESPONSES_DEFAULT, ...RESPONSES_PRESETS["openrouter"] };
  }
  const override = compatOverrideFromExtensions(extensions, "openai_responses_compat", [
    "openai_responses",
    "openai",
  ]);
  const merged = applyOverride(base, override, [
    "developer_role",
    "max_output_tokens_field",
    "reasoning_format",
    "tool_result_name",
    "strict_tools",
    "cache_control",
  ]);
  if (override !== null && isJsonObject(override["routing"])) {
    return { ...merged, routing: override["routing"] as JsonObject };
  }
  return merged;
}

// ─── OpenAI Chat Completions ─────────────────────────────────────────

export interface ResolvedOpenAIChatCompat {
  readonly instruction_role: "developer" | "system";
  readonly max_tokens_field: "max_completion_tokens" | "max_tokens";
  readonly stream_usage: "include" | "omit";
  readonly tool_result_name: "include" | "omit";
  readonly assistant_after_tool_result: "insert" | "omit";
  readonly thinking_format:
    | "none"
    | "reasoning_effort"
    | "openrouter"
    | "deepseek"
    | "qwen"
    | "qwen_chat_template"
    | "zai";
  readonly thinking_replay: "native" | "as_text" | "omit";
  readonly assistant_reasoning_content: "include_empty" | "omit";
  readonly strict_tools: "include" | "omit";
  readonly cache_control: "none" | "openai" | "anthropic";
  readonly routing: JsonObject | null;
}

const CHAT_DEFAULT: ResolvedOpenAIChatCompat = {
  instruction_role: "system",
  max_tokens_field: "max_completion_tokens",
  stream_usage: "include",
  tool_result_name: "omit",
  assistant_after_tool_result: "omit",
  thinking_format: "reasoning_effort",
  thinking_replay: "omit",
  assistant_reasoning_content: "omit",
  strict_tools: "omit",
  cache_control: "openai",
  routing: null,
};

const CHAT_PRESETS: Record<string, Partial<ResolvedOpenAIChatCompat>> = {
  openai: {},
  openai_chat: {},
  chat: {},
  chat_completions: {},
  ollama: { max_tokens_field: "max_tokens", thinking_format: "none", cache_control: "none" },
  lmstudio: { max_tokens_field: "max_tokens", thinking_format: "none", cache_control: "none" },
  lm_studio: { max_tokens_field: "max_tokens", thinking_format: "none", cache_control: "none" },
  groq: { max_tokens_field: "max_tokens", cache_control: "none" },
  openrouter: { max_tokens_field: "max_tokens", thinking_format: "openrouter" },
  vllm: { max_tokens_field: "max_tokens", cache_control: "none" },
  sglang: { max_tokens_field: "max_tokens", cache_control: "none" },
};

/** Default base URLs for OpenAI Chat Completions preset names. */
export const OPENAI_CHAT_PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vllm: "http://localhost:8000/v1",
  sglang: "http://localhost:30000/v1",
};

export function chatCompatPreset(name: string): ResolvedOpenAIChatCompat {
  const key = presetKey(name);
  const preset = CHAT_PRESETS[key];
  if (preset === undefined) {
    throw new ValueError(`unknown OpenAIChatCompat preset: ${name}`);
  }
  return { ...CHAT_DEFAULT, ...preset };
}

export function resolveOpenAIChatCompat(
  base: ResolvedOpenAIChatCompat | null,
  extensions: JsonObject | null,
): ResolvedOpenAIChatCompat {
  const start = base ?? CHAT_DEFAULT;
  const override = compatOverrideFromExtensions(extensions, "openai_chat_compat", [
    "openai_chat",
    "openai",
  ]);
  const merged = applyOverride(start, override, [
    "instruction_role",
    "max_tokens_field",
    "stream_usage",
    "tool_result_name",
    "assistant_after_tool_result",
    "thinking_format",
    "thinking_replay",
    "assistant_reasoning_content",
    "strict_tools",
    "cache_control",
  ]);
  if (override !== null && isJsonObject(override["routing"])) {
    return { ...merged, routing: override["routing"] as JsonObject };
  }
  return merged;
}
