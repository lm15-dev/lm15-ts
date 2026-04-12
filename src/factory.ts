/**
 * Factory — build a configured UniversalLM from environment/options.
 */

import { UniversalLM } from "./client.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { GeminiAdapter } from "./providers/gemini.js";
import { FetchTransport, type TransportPolicy, DEFAULT_POLICY } from "./transport.js";
import type { ProviderManifest } from "./providers/base.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface AdapterFactory {
  manifest: ProviderManifest;
  create: (apiKey: string, transport: FetchTransport) => unknown;
}

const CORE_ADAPTERS: AdapterFactory[] = [
  {
    manifest: OpenAIAdapter.prototype.manifest ?? { provider: "openai", supports: {}, envKeys: ["OPENAI_API_KEY"] },
    create: (key, t) => new OpenAIAdapter({ apiKey: key, transport: t }),
  },
  {
    manifest: AnthropicAdapter.prototype.manifest ?? { provider: "anthropic", supports: {}, envKeys: ["ANTHROPIC_API_KEY"] },
    create: (key, t) => new AnthropicAdapter({ apiKey: key, transport: t }),
  },
  {
    manifest: GeminiAdapter.prototype.manifest ?? { provider: "gemini", supports: {}, envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
    create: (key, t) => new GeminiAdapter({ apiKey: key, transport: t }),
  },
];

// Static manifest access
const ADAPTER_MANIFESTS: ProviderManifest[] = [
  { provider: "openai", supports: { complete: true, stream: true, live: true, embeddings: true, files: true, batches: true, images: true, audio: true }, envKeys: ["OPENAI_API_KEY"] },
  { provider: "anthropic", supports: { complete: true, stream: true, live: false, embeddings: false, files: true, batches: true, images: false, audio: false }, envKeys: ["ANTHROPIC_API_KEY"] },
  { provider: "gemini", supports: { complete: true, stream: true, live: true, embeddings: true, files: true, batches: true, images: true, audio: true }, envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
];

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const resolved = filePath.startsWith("~")
      ? path.join(process.env.HOME ?? "", filePath.slice(1))
      : filePath;
    const text = fs.readFileSync(resolved, "utf-8");
    for (const raw of text.split("\n")) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7);
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) result[key] = value;
    }
  } catch { /* file not found is fine */ }
  return result;
}

export interface BuildDefaultOpts {
  policy?: Partial<TransportPolicy>;
  apiKey?: string | Record<string, string>;
  providerHint?: string;
  env?: string;
}

export function buildDefault(opts?: BuildDefaultOpts): UniversalLM {
  const transport = new FetchTransport(opts?.policy);
  const client = new UniversalLM();

  // Build env key map: { ENV_VAR: provider }
  const envKeyMap = new Map<string, string>();
  for (const m of ADAPTER_MANIFESTS) {
    for (const k of m.envKeys) envKeyMap.set(k, m.provider);
  }

  // Resolve explicit keys
  const explicit: Record<string, string> = {};
  if (opts?.apiKey) {
    if (typeof opts.apiKey === "string") {
      if (opts.providerHint) {
        explicit[opts.providerHint] = opts.apiKey;
      } else {
        for (const m of ADAPTER_MANIFESTS) explicit[m.provider] = opts.apiKey;
      }
    } else {
      Object.assign(explicit, opts.apiKey);
    }
  }

  // Parse env file
  const fileKeys: Record<string, string> = {};
  if (opts?.env) {
    const parsed = parseEnvFile(opts.env);
    for (const [envVar, value] of Object.entries(parsed)) {
      const provider = envKeyMap.get(envVar);
      if (provider) fileKeys[provider] = value;
      // Also set in process.env for plugins
      if (!process.env[envVar]) process.env[envVar] = value;
    }
  }

  // Register adapters
  for (const factory of CORE_ADAPTERS) {
    const p = factory.manifest.provider;
    let key = explicit[p];
    if (!key) key = fileKeys[p];
    if (!key) {
      for (const envVar of factory.manifest.envKeys) {
        key = process.env[envVar] ?? "";
        if (key) break;
      }
    }
    if (key) {
      client.register(factory.create(key, transport) as import("./providers/base.js").LMAdapter);
    }
  }

  return client;
}

/** Return { provider: envKeys[] } for all core adapters. */
export function providers(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const m of ADAPTER_MANIFESTS) out[m.provider] = m.envKeys;
  return out;
}
