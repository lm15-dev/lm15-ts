/**
 * The adapter for a provider string: the registry's dialect bound to its
 * access policy and compat preset, exactly as the router builds it.
 */

import type { LMOptions, ProviderLM } from "./adapter.ts";
import { ValueError } from "./types/validate.ts";
import { lookup, type ProviderDefinition } from "./registry.ts";
import { AnthropicLM, ClaudeCodeLM } from "./dialects/anthropic.ts";
import { GeminiLM } from "./dialects/gemini.ts";
import { OpenAIChatLM } from "./dialects/openai_chat.ts";
import { OpenAICodexLM, OpenAILM } from "./dialects/openai_responses.ts";
import { TypeSafeLM } from "./dialects/typesafe.ts";
import { XaiLM } from "./dialects/xai.ts";

export interface AdapterOptions extends LMOptions {
  readonly baseUrl?: string;
}

/**
 * The LM a provider string names. A chat-bound provider (groq, deepseek, …)
 * is the chat dialect with that provider's compat preset and access policy
 * bound; an adapter-owned provider is its class. `baseUrl` overrides the
 * provider's default (local vLLM/SGLang cases).
 */
export function adapterFor(provider: string, opts: AdapterOptions = {}): ProviderLM {
  const definition = lookup(provider);
  if (!definition) throw new ValueError(`unknown provider: ${provider}`);
  return adapterForDefinition(definition, opts);
}

export function adapterForDefinition(definition: ProviderDefinition, opts: AdapterOptions = {}): ProviderLM {
  const base: LMOptions = { ...opts };
  const bound = definition.bound ? { access: definition.access } : {};
  const compat = definition.compat !== undefined && definition.dialect !== "gemini" ? { compat: definition.compat } : {};
  switch (definition.id) {
    case "openai-codex":
      return new OpenAICodexLM(base);
    case "claude-code":
      return new ClaudeCodeLM(base);
    case "xai":
      return new XaiLM(base);
  }
  switch (definition.dialect) {
    case "openai-responses":
      return new OpenAILM({ ...base, ...bound, ...compat });
    case "openai-chat":
      return new OpenAIChatLM({ ...base, ...bound, ...compat });
    case "anthropic":
      return new AnthropicLM({ ...base, ...bound, ...compat });
    case "gemini":
      return new GeminiLM({ ...base, ...bound });
    case "typesafe":
      return new TypeSafeLM(base);
  }
}
