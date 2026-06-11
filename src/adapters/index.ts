/** Adapter registry: provider name → adapter class (PROTOCOL.md providers). */

import { ValueError } from "../errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import type { ProviderAdapter } from "./common.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIChatAdapter } from "./openai-chat.js";
import { OpenAIAdapter } from "./openai.js";

export type { ProviderAdapter, WireRequest } from "./common.js";
export { AnthropicAdapter } from "./anthropic.js";
export { GeminiAdapter } from "./gemini.js";
export { OpenAIAdapter } from "./openai.js";
export { OpenAIChatAdapter } from "./openai-chat.js";

export function adapterForProvider(
  provider: string,
  apiKey: string,
  baseUrl: string | null = null,
): ProviderAdapter {
  switch (provider) {
    case "openai":
      return baseUrl === null ? new OpenAIAdapter(apiKey) : new OpenAIAdapter(apiKey, baseUrl);
    case "openai_chat":
      return baseUrl === null
        ? new OpenAIChatAdapter(apiKey)
        : new OpenAIChatAdapter(apiKey, baseUrl);
    case "anthropic":
      return baseUrl === null
        ? new AnthropicAdapter(apiKey)
        : new AnthropicAdapter(apiKey, baseUrl);
    case "gemini":
      return baseUrl === null ? new GeminiAdapter(apiKey) : new GeminiAdapter(apiKey, baseUrl);
    default:
      throw new ValueError(`unknown provider: ${provider}`);
  }
}
