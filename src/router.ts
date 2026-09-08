/**
 * `LMRouter`: a lookup table you can read, not a framework. Three resolution
 * rungs in fixed order — explicit `provider:` prefix, catalog (opt-in),
 * built-in rules — then the AUTH-1 credential chain when an LM is built.
 *
 * Stated deviation: the reference's rung 0 (a `provider` attribute carried
 * by a `str` subclass) is a Python idiom with no TypeScript equivalent;
 * pass `provider:model` or a catalog instead.
 */

import type { ProviderLM } from "./adapter.ts";
import { hasStoredCredential } from "./auth/stores.ts";
import { ChainContext, credentialProvider, profileSettings } from "./cloud/chains.ts";
import { resolveSettings } from "./cloud/hosts.ts";
import { AmbiguousModelError, NotConfiguredError, UnknownModelError } from "./errors.ts";
import { adapterForDefinition } from "./providers.ts";
import { PROVIDERS, canonicalProvider, lookup, type ProviderDefinition } from "./registry.ts";
import type { Transport } from "./transport.ts";
import type { Request } from "./types/config.ts";
import { normalizeRequest } from "./types/config.ts";
import type { CredentialLike } from "./types/credential.ts";
import type { CachedPrefix } from "./types/endpoints.ts";
import type { ModelInfo, ModelRegistry } from "./types/model_info.ts";
import type { Response } from "./types/response.ts";
import type { StreamEvent } from "./types/stream.ts";

/** Maps a model-id prefix to a provider. That's all a rule is. */
export interface RouteRule {
  readonly prefix: string;
  readonly provider: string;
  readonly note: string;
}

const rule = (prefix: string, provider: string, note: string): RouteRule => Object.freeze({ prefix, provider, note });

/** The complete built-in knowledge of the router. First match wins. A convenience, not a registry of truth. */
export const DEFAULT_RULES: readonly RouteRule[] = Object.freeze([
  rule("claude-", "anthropic", "Anthropic Claude family"),
  rule("gpt-", "openai", "OpenAI GPT family (Responses API; use openai-chat: for Chat Completions)"),
  rule("o1", "openai", "OpenAI o1 reasoning family"),
  rule("o3", "openai", "OpenAI o3 reasoning family"),
  rule("o4", "openai", "OpenAI o4 reasoning family"),
  rule("gemini-", "gemini", "Google Gemini family"),
  rule("gemma-", "gemini", "Google Gemma open models, served by the Gemini API (live /models listing 2026-09-01)"),
  rule("nano-banana", "gemini", "Google image models on the Gemini API (live /models listing 2026-09-01)"),
  rule("grok-", "xai", "xAI Grok family (XAI_API_KEY or subscription OAuth)"),
  rule("sora-", "openai", "OpenAI Sora video generation"),
  rule("veo-", "gemini", "Google Veo video generation"),
  rule("chat-latest", "openai", "OpenAI rolling chat alias (live /models listing 2026-09-01)"),
]);

export type ResolutionSource = "prefix" | "catalog" | "rule";

/** The complete answer to "how did you route this string". `resolve()` returning this IS the explain method. */
export interface Resolution {
  readonly requested: string;
  /** The id sent on the wire (prefix stripped, alias resolved). */
  readonly model: string;
  readonly provider: string;
  readonly source: ResolutionSource;
  readonly rule?: RouteRule;
  /** WHICH env var the key would be read from; never the value. */
  readonly envKey?: string;
  readonly modelInfo?: ModelInfo;
  readonly compat?: string;
}

export function describeResolution(r: Resolution): string {
  const parts = [`${JSON.stringify(r.requested)} -> provider ${JSON.stringify(r.provider)}`];
  if (r.source === "prefix") parts.push("via explicit provider prefix");
  else if (r.source === "catalog") parts.push("via catalog match");
  else if (r.rule) parts.push(`via built-in rule prefix=${JSON.stringify(r.rule.prefix)}${r.rule.note ? ` — ${r.rule.note}` : ""}`);
  if (r.compat !== undefined) parts.push(`compat preset ${JSON.stringify(r.compat)}`);
  parts.push(`wire model ${JSON.stringify(r.model)}`);
  const definition = lookup(r.provider);
  const policy = definition?.access.credentialPolicy ?? "key";
  if (policy === "oauth-unless-explicit") {
    let chain = "key from explicit apiKeys, else the stored subscription OAuth credential";
    if (r.envKey !== undefined) chain += `, else $${r.envKey}`;
    parts.push(chain);
  } else if (r.envKey !== undefined) parts.push(`key from $${r.envKey}`);
  else if (policy === "oauth") parts.push("local OAuth credential (no env key)");
  else if (definition?.placeholderKey !== undefined) parts.push("key from explicit apiKeys or the preset's local-server default");
  else parts.push("key from explicit apiKeys");
  return parts.join("; ") + ".";
}

export interface RouterConfig {
  /** Catalog use is opt-in. */
  readonly registry?: ModelRegistry;
  readonly rules?: readonly RouteRule[];
  /** Defaults to `process.env` at lookup time. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** provider string → credential; beats env. */
  readonly apiKeys?: Readonly<Record<string, CredentialLike>>;
  /** Cloud-host settings per provider (AUTH-10). */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly transport?: Transport;
}

function routable(provider: string): ProviderDefinition | undefined {
  return PROVIDERS.get(provider);
}

function knownProviders(): string {
  return [...PROVIDERS.keys()].sort().join(", ");
}

function apiKeysEntry(config: RouterConfig, provider: string): [CredentialLike | undefined, boolean] {
  if (!config.apiKeys) return [undefined, false];
  for (const [key, value] of Object.entries(config.apiKeys)) if (canonicalProvider(key) === provider) return [value, true];
  return [undefined, false];
}

function envOf(config: RouterConfig): Readonly<Record<string, string | undefined>> {
  return config.env ?? process.env;
}

function envKeyFor(provider: string, config: RouterConfig): string | undefined {
  if (apiKeysEntry(config, provider)[1]) return undefined;
  const envKeys = lookup(provider)?.access.envKeys ?? [];
  if (envKeys.length === 0) return undefined;
  const env = envOf(config);
  for (const key of envKeys) if (env[key]) return key;
  return envKeys[0];
}

function resolution(requested: string, model: string, provider: string, source: ResolutionSource, config: RouterConfig, extra: { rule?: RouteRule; modelInfo?: ModelInfo } = {}): Resolution {
  const definition = lookup(provider);
  const envKey = envKeyFor(provider, config);
  return Object.freeze({
    requested,
    model,
    provider,
    source,
    ...(extra.rule ? { rule: extra.rule } : {}),
    ...(envKey !== undefined ? { envKey } : {}),
    ...(extra.modelInfo ? { modelInfo: extra.modelInfo } : {}),
    ...(definition?.bound && definition.compat !== undefined ? { compat: definition.compat } : {}),
  });
}

function closeMatch(word: string, candidates: string[]): string | undefined {
  // difflib.get_close_matches(cutoff=0.75) approximated with a Levenshtein ratio.
  let best: string | undefined;
  let bestScore = 0;
  for (const c of candidates) {
    const score = ratio(word, c);
    if (score >= 0.75 && score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function ratio(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return 1;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return (2 * dp[m]![n]!) / (m + n);
}

/** The pure resolution: no network, no files, no secret values. */
export function resolveModel(model: string, config: RouterConfig = {}): Resolution {
  const rules = config.rules ?? DEFAULT_RULES;
  if (typeof model !== "string" || model === "") throw new UnknownModelError("model must be a non-empty string", { model: String(model) });
  const requested = model;

  // Rung 1: explicit provider prefix (split on the FIRST colon).
  const colon = model.indexOf(":");
  if (colon >= 0) {
    const head = canonicalProvider(model.slice(0, colon));
    const rest = model.slice(colon + 1);
    if (routable(head) && rest) return resolution(requested, rest, head, "prefix", config);
  }

  // Rung 2: catalog (only when a registry was supplied).
  if (config.registry) {
    const matches = config.registry.list().filter((info) => info.id === model || (info.aliases ?? []).includes(model));
    const providers = [...new Set(matches.map((m) => m.provider))];
    if (providers.length > 1) {
      const options = providers.map((p) => `"${p}:${model}"`).join(" or ");
      throw new AmbiguousModelError(
        `model ${JSON.stringify(model)} is offered by multiple providers: ${providers.join(", ")}. Fix: use the explicit form, e.g. { model: ${JSON.stringify(providers[0] + ":" + model)} } — options: ${options}.`,
        { model, providers },
      );
    }
    if (matches.length > 0) {
      const exact = matches.filter((m) => m.id === model);
      const narrowed = exact.length > 0 ? exact : matches;
      if (narrowed.length > 1) {
        throw new AmbiguousModelError(
          `model ${JSON.stringify(model)} matches multiple catalog entries (${narrowed.map((m) => m.id).join(", ")}) under provider ${JSON.stringify(narrowed[0]!.provider)}. Fix: request a canonical id directly.`,
          { model, providers },
        );
      }
      const info = narrowed[0]!;
      const provider = canonicalProvider(info.provider);
      if (!routable(provider)) {
        throw new UnknownModelError(
          `model ${JSON.stringify(model)} resolved in the catalog to provider ${JSON.stringify(info.provider)}, but lm15 has no adapter or compat preset for it. Known providers: ${knownProviders()}. Construct a provider LM directly (e.g. OpenAIChatLM with a custom baseUrl) for OpenAI-compatible servers.`,
          { model },
        );
      }
      return resolution(requested, (info.aliases ?? []).includes(model) ? info.id : model, provider, "catalog", config, { modelInfo: info });
    }
  }

  // Rung 3: built-in prefix rules, first match wins.
  for (const r of rules) {
    if (model.startsWith(r.prefix)) {
      const provider = canonicalProvider(r.provider);
      if (!routable(provider)) {
        throw new UnknownModelError(`rule ${JSON.stringify(r)} names provider ${JSON.stringify(r.provider)}, which has no adapter. Known providers: ${knownProviders()}.`, { model });
      }
      return resolution(requested, model, provider, "rule", config, { rule: r });
    }
  }

  const hints: string[] = [];
  if (colon >= 0) {
    const close = closeMatch(canonicalProvider(model.slice(0, colon)), [...PROVIDERS.keys()].sort());
    if (close) hints.push(`Did you mean "${close}:${model.slice(colon + 1)}"?`);
  }
  hints.push(`Use an explicit provider prefix — "provider:${model}" with provider one of: ${knownProviders()}.`);
  if (!config.registry) hints.push("Or pass a model catalog: new LMRouter({ registry }) built from canonical ModelInfo entries.");
  throw new UnknownModelError(
    `could not route model ${JSON.stringify(model)}: no provider prefix, ${config.registry ? "no catalog match" : "no catalog supplied"}, and none of the ${rules.length} built-in rules matched. ${hints.join(" ")}`,
    { model },
  );
}

/** Provider resolved but no key was found: a `NotConfiguredError` under the family. */
export class MissingCredentialError extends NotConfiguredError {}

function buildLm(res: Resolution, config: RouterConfig): ProviderLM {
  const definition = lookup(res.provider)!;
  const policy = definition.access.credentialPolicy;
  const transport = config.transport ? { transport: config.transport } : {};
  if (policy === "oauth") return adapterForDefinition(definition, transport);
  let [apiKey] = apiKeysEntry(config, res.provider);
  const env = envOf(config);
  if (definition.hosted) {
    const given = config.settings?.[res.provider];
    const ctx = ChainContext.online(env);
    const settings = resolveSettings(definition.access.host, given, env as Record<string, string>, { provider: res.provider, profile: profileSettings(definition.access, ctx) });
    ctx.settings = settings;
    if (apiKey === undefined && definition.access.credentialPolicy !== "key") apiKey = credentialProvider(definition.access, ctx);
    else if (apiKey === undefined) {
      for (const key of definition.access.envKeys) {
        if (env[key]) {
          apiKey = env[key]!;
          break;
        }
      }
    }
    if (apiKey === undefined) {
      throw new MissingCredentialError(
        `no credential found for provider ${JSON.stringify(res.provider)}. Set ${definition.access.envKeys.join(" or ")} in the environment, or pass { apiKeys: { ${JSON.stringify(res.provider)}: "..." } }.`,
        { provider: res.provider, envKeys: definition.access.envKeys },
      );
    }
    return adapterForDefinition(definition, { apiKey, settings, ...transport });
  }
  if (apiKey === undefined && policy === "oauth-unless-explicit" && hasStoredCredential(definition.access)) return adapterForDefinition(definition, transport);
  if (apiKey === undefined) {
    for (const key of definition.access.envKeys) {
      if (env[key]) {
        apiKey = env[key]!;
        break;
      }
    }
  }
  if (apiKey === undefined && definition.placeholderKey !== undefined) apiKey = definition.placeholderKey;
  if (!apiKey && policy === "oauth-unless-explicit") return adapterForDefinition(definition, transport);
  if (!apiKey) {
    throw new MissingCredentialError(
      `no API key found for provider ${JSON.stringify(res.provider)}. Set ${definition.access.envKeys.join(" or ")} in the environment, or pass { apiKeys: { ${JSON.stringify(res.provider)}: "..." } }.`,
      { provider: res.provider, envKeys: definition.access.envKeys },
    );
  }
  return adapterForDefinition(definition, { apiKey, ...transport });
}

function routedRequest(request: Request, res: Resolution): Request {
  return request.model === res.model ? request : normalizeRequest({ ...request, model: res.model });
}

/**
 * Routes model strings to provider LMs. Config is frozen; the only state is
 * an LM cache keyed by provider (one LM per provider, built lazily).
 */
export class LMRouter {
  readonly config: RouterConfig;
  private readonly lms = new Map<string, ProviderLM>();

  constructor(config: RouterConfig = {}) {
    this.config = Object.freeze({ ...config });
  }

  /** Pure lookup; touches no network and reads no secret values. */
  resolve(model: string): Resolution {
    return resolveModel(model, this.config);
  }

  /** `resolve()`, then construct-or-reuse the provider LM. */
  lm(model: string): ProviderLM {
    const res = this.resolve(model);
    let lm = this.lms.get(res.provider);
    if (!lm) {
      lm = buildLm(res, this.config);
      this.lms.set(res.provider, lm);
    }
    return lm;
  }

  async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    const req = normalizeRequest(request);
    const res = this.resolve(req.model);
    return this.lm(req.model).complete(routedRequest(req, res), opts);
  }

  stream(request: Request, opts: { signal?: AbortSignal } = {}): AsyncIterable<StreamEvent> {
    const req = normalizeRequest(request);
    const res = this.resolve(req.model);
    return this.lm(req.model).stream(routedRequest(req, res), opts);
  }

  /** The MAP-6 door, routed by the prefix's model. */
  cache(prefix: Request, opts: { ttlSeconds?: number; label?: string } = {}): Promise<CachedPrefix> {
    const req = normalizeRequest(prefix);
    const res = this.resolve(req.model);
    return this.lm(req.model).cache(routedRequest(req, res), opts);
  }
}
