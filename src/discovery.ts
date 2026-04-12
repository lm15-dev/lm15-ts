/**
 * Model discovery — live provider APIs + models.dev fallback.
 */

import { providers as providerEnvKeys } from "./factory.js";
import { fetchModelsDev, type ModelSpec } from "./model_catalog.js";

const CACHE_TTL_MS = 300_000; // 5 minutes
const liveCache = new Map<string, { ts: number; specs: ModelSpec[] }>();

async function fetchJson(url: string, headers?: Record<string, string>, timeout = 5_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAIModels(apiKey: string, timeout: number): Promise<ModelSpec[]> {
  const data = await fetchJson(
    "https://api.openai.com/v1/models",
    { Authorization: `Bearer ${apiKey}` },
    timeout,
  ) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).filter(item => item.id).map(item => ({
    id: String(item.id),
    provider: "openai",
    context_window: undefined,
    max_output: undefined,
    input_modalities: [],
    output_modalities: [],
    tool_call: false,
    structured_output: false,
    reasoning: false,
    raw: item,
  }));
}

async function fetchAnthropicModels(apiKey: string, timeout: number): Promise<ModelSpec[]> {
  const data = await fetchJson(
    "https://api.anthropic.com/v1/models",
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    timeout,
  ) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).filter(item => item.id).map(item => ({
    id: String(item.id),
    provider: "anthropic",
    context_window: undefined,
    max_output: undefined,
    input_modalities: [],
    output_modalities: [],
    tool_call: false,
    structured_output: false,
    reasoning: false,
    raw: item,
  }));
}

async function fetchGeminiModels(apiKey: string, timeout: number): Promise<ModelSpec[]> {
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    undefined,
    timeout,
  ) as { models?: Array<Record<string, unknown>> };
  return (data.models ?? []).filter(item => item.name).map(item => {
    const name = String(item.name);
    const mid = name.startsWith("models/") ? name.slice(7) : name;
    return {
      id: mid,
      provider: "gemini",
      context_window: item.inputTokenLimit as number | undefined,
      max_output: item.outputTokenLimit as number | undefined,
      input_modalities: [],
      output_modalities: [],
      tool_call: false,
      structured_output: false,
      reasoning: false,
      raw: item,
    };
  });
}

const FETCHERS: Record<string, (key: string, timeout: number) => Promise<ModelSpec[]>> = {
  openai: fetchOpenAIModels,
  anthropic: fetchAnthropicModels,
  gemini: fetchGeminiModels,
};

function resolveApiKeys(
  apiKey: string | Record<string, string> | undefined,
  provider: string | undefined,
  env: string | undefined,
): Record<string, string> {
  const envMap = providerEnvKeys();
  const resolved: Record<string, string> = {};

  // From explicit apiKey
  if (apiKey) {
    if (typeof apiKey === "string") {
      if (provider) {
        resolved[provider] = apiKey;
      } else {
        for (const p of Object.keys(envMap)) resolved[p] = apiKey;
      }
    } else {
      Object.assign(resolved, apiKey);
    }
  }

  // From environment
  for (const [p, vars] of Object.entries(envMap)) {
    if (resolved[p]) continue;
    for (const v of vars) {
      const val = process.env[v];
      if (val) { resolved[p] = val; break; }
    }
  }

  return resolved;
}

function mergeSpecs(primary: ModelSpec[], fallback: ModelSpec[]): ModelSpec[] {
  const merged = new Map<string, ModelSpec>();

  for (const s of primary) merged.set(`${s.provider}:${s.id}`, s);

  for (const f of fallback) {
    const key = `${f.provider}:${f.id}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, f);
      continue;
    }
    merged.set(key, {
      ...existing,
      context_window: existing.context_window ?? f.context_window,
      max_output: existing.max_output ?? f.max_output,
      input_modalities: existing.input_modalities.length ? existing.input_modalities : f.input_modalities,
      output_modalities: existing.output_modalities.length ? existing.output_modalities : f.output_modalities,
      tool_call: existing.tool_call || f.tool_call,
      structured_output: existing.structured_output || f.structured_output,
      reasoning: existing.reasoning || f.reasoning,
      raw: { ...f.raw, ...existing.raw },
    });
  }

  return [...merged.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}

function filterSpecs(
  specs: ModelSpec[],
  opts?: { supports?: Set<string>; input_modalities?: Set<string>; output_modalities?: Set<string> },
): ModelSpec[] {
  if (!opts) return specs;
  return specs.filter(s => {
    if (opts.supports) {
      const features = new Set<string>();
      if (s.tool_call) features.add("tools");
      if (s.structured_output) features.add("json_output");
      if (s.reasoning) features.add("reasoning");
      for (const f of opts.supports) {
        if (!features.has(f)) return false;
      }
    }
    if (opts.input_modalities) {
      const mods = new Set(s.input_modalities);
      for (const m of opts.input_modalities) {
        if (!mods.has(m)) return false;
      }
    }
    if (opts.output_modalities) {
      const mods = new Set(s.output_modalities);
      for (const m of opts.output_modalities) {
        if (!mods.has(m)) return false;
      }
    }
    return true;
  });
}

export interface ModelsOpts {
  provider?: string;
  live?: boolean;
  refresh?: boolean;
  timeout?: number;
  apiKey?: string | Record<string, string>;
  env?: string;
  supports?: Set<string>;
  input_modalities?: Set<string>;
  output_modalities?: Set<string>;
}

export async function models(opts?: ModelsOpts): Promise<ModelSpec[]> {
  const envMap = providerEnvKeys();
  const allProviders = Object.keys(envMap);
  const selected = opts?.provider ? [opts.provider] : allProviders;
  const keys = resolveApiKeys(opts?.apiKey, opts?.provider, opts?.env);
  const timeout = opts?.timeout ?? 5_000;
  const live = opts?.live !== false;
  const refresh = opts?.refresh ?? false;

  const liveSpecs: ModelSpec[] = [];
  if (live) {
    const now = Date.now();
    for (const p of selected) {
      const cached = liveCache.get(p);
      if (cached && !refresh && now - cached.ts <= CACHE_TTL_MS) {
        liveSpecs.push(...cached.specs);
        continue;
      }
      const key = keys[p];
      if (!key) continue;
      const fetcher = FETCHERS[p];
      if (!fetcher) continue;
      try {
        const fetched = await fetcher(key, timeout);
        liveCache.set(p, { ts: now, specs: fetched });
        liveSpecs.push(...fetched);
      } catch {
        // Silently skip
      }
    }
  }

  let fallbackSpecs: ModelSpec[] = [];
  try {
    const all = await fetchModelsDev(timeout);
    fallbackSpecs = all.filter(s => selected.includes(s.provider));
  } catch {
    // Silently skip
  }

  const merged = mergeSpecs(liveSpecs, fallbackSpecs);
  return filterSpecs(merged, opts);
}

export async function providersInfo(opts?: {
  live?: boolean;
  refresh?: boolean;
  timeout?: number;
  apiKey?: string | Record<string, string>;
  env?: string;
}): Promise<Record<string, { env_keys: readonly string[]; configured: boolean; model_count: number }>> {
  const envMap = providerEnvKeys();
  const keys = resolveApiKeys(opts?.apiKey, undefined, opts?.env);
  const specs = await models({ live: opts?.live, refresh: opts?.refresh, timeout: opts?.timeout, apiKey: opts?.apiKey, env: opts?.env });

  const counts = new Map<string, number>();
  for (const s of specs) {
    counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  }

  const out: Record<string, { env_keys: readonly string[]; configured: boolean; model_count: number }> = {};
  for (const [p, envKeys] of Object.entries(envMap)) {
    out[p] = {
      env_keys: envKeys,
      configured: p in keys,
      model_count: counts.get(p) ?? 0,
    };
  }
  return out;
}
