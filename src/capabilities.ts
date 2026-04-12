/**
 * Model → provider resolution and capability lookup.
 */

import { UnsupportedModelError } from "./errors.js";

export interface Capabilities {
  readonly input_modalities: ReadonlySet<string>;
  readonly output_modalities: ReadonlySet<string>;
  readonly features: ReadonlySet<string>;
}

interface ModelCapabilities {
  readonly provider: string;
  readonly pattern: string;
  readonly caps: Capabilities;
}

const REGISTRY: readonly ModelCapabilities[] = [
  {
    provider: "anthropic",
    pattern: "claude",
    caps: {
      input_modalities: new Set(["text", "image", "document"]),
      output_modalities: new Set(["text"]),
      features: new Set(["streaming", "tools", "reasoning"]),
    },
  },
  {
    provider: "gemini",
    pattern: "gemini",
    caps: {
      input_modalities: new Set(["text", "image", "audio", "video", "document"]),
      output_modalities: new Set(["text"]),
      features: new Set(["streaming", "tools", "json_output", "live"]),
    },
  },
  {
    provider: "openai",
    pattern: "gpt",
    caps: {
      input_modalities: new Set(["text", "image", "audio", "video", "document"]),
      output_modalities: new Set(["text", "audio"]),
      features: new Set(["streaming", "tools", "json_output", "reasoning", "live", "embeddings"]),
    },
  },
];

/** Additional patterns that resolve to known providers. */
const EXTRA_PATTERNS: readonly [string, string][] = [
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["chatgpt", "openai"],
  ["dall-e", "openai"],
  ["tts", "openai"],
  ["whisper", "openai"],
];

export class CapabilityResolver {
  private _modelIndex = new Map<string, { provider: string; caps?: Capabilities }>();

  resolveProvider(model: string): string {
    const indexed = this._modelIndex.get(model);
    if (indexed) return indexed.provider;

    const lower = model.toLowerCase();
    for (const item of REGISTRY) {
      if (lower.startsWith(item.pattern)) return item.provider;
    }
    for (const [prefix, provider] of EXTRA_PATTERNS) {
      if (lower.startsWith(prefix)) return provider;
    }
    throw new UnsupportedModelError(
      `unable to resolve provider for model '${model}'\n\n` +
      `  To fix, do one of:\n` +
      `    1. Use provider to specify the provider explicitly:\n` +
      `       lm15.call('${model}', ..., { provider: 'openai' })\n` +
      `    2. Check available models with lm15.models()\n` +
      `    3. Verify the model name is correct (common prefixes: gpt-, claude-, gemini-)\n`,
    );
  }

  resolveCapabilities(model: string): Capabilities {
    const indexed = this._modelIndex.get(model);
    if (indexed?.caps) return indexed.caps;

    const lower = model.toLowerCase();
    for (const item of REGISTRY) {
      if (lower.startsWith(item.pattern)) return item.caps;
    }
    return REGISTRY[REGISTRY.length - 1].caps;
  }
}

const _defaultResolver = new CapabilityResolver();

export function resolveProvider(model: string): string {
  return _defaultResolver.resolveProvider(model);
}

export function resolveCapabilities(model: string): Capabilities {
  return _defaultResolver.resolveCapabilities(model);
}
