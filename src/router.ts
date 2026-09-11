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
import { requestFromOpenAIChat as readOpenAIChat } from "./dialects/openai_chat.ts";
import { resolveSettings } from "./cloud/hosts.ts";
import { AmbiguousModelError, NotConfiguredError, UnknownModelError } from "./errors.ts";
import { adapterForDefinition } from "./providers.ts";
import { getDefaultPlatform, noCloudChain } from "./platform.ts";
import { PROVIDERS, canonicalProvider, lookup, type ProviderDefinition } from "./registry.ts";
import type { Transport } from "./transport.ts";
import type { Request } from "./types/config.ts";
import { normalizeRequest } from "./types/config.ts";
import type { CredentialLike } from "./types/credential.ts";
import type { CachedPrefix } from "./types/endpoints.ts";
import type { ModelInfo, ModelRegistry } from "./types/model_info.ts";
import type { Response } from "./types/response.ts";
import type { StreamEvent } from "./types/stream.ts";
import { ResponseStream } from "./stream.ts";

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
  /** Defaults to the host platform's environment at lookup time (`process.env` on Node; empty on the web). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * provider string → credential; beats env. An entry also serves a sibling
   * provider whose declared env-key list is identical (AUTH-1 shared
   * explicit keys, 2026-09-09): `openai` supplies `openai-chat`.
   */
  readonly apiKeys?: Readonly<Record<string, CredentialLike>>;
  /** provider string → the URL that provider's LM is built with; exact provider only, never shared. */
  readonly baseUrls?: Readonly<Record<string, string>>;
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

function declaredEnvKeys(provider: string): readonly string[] {
  return lookup(provider)?.access.envKeys ?? [];
}

function sameEnvKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Select a config key, not its value; never invoke credential providers
 * (spec/auth.md § Shared explicit keys, ratified 2026-09-09).
 *
 * Exact provider first, else the single entry whose declared env-key list is
 * identical (including order) to the target's non-empty list. Empty lists do
 * not join unrelated local servers, OAuth stores or cloud chains. Several
 * candidates are ambiguous even if their values look equal: credential
 * callables can change independently at request time.
 */
export function apiKeysSource(config: { readonly apiKeys?: Readonly<Record<string, CredentialLike>> | undefined }, provider: string): string | undefined {
  const keys = config.apiKeys;
  if (!keys) return undefined;
  const names = Object.keys(keys);
  const exact = names.filter((k) => canonicalProvider(k) === provider);
  let candidates = exact;
  if (exact.length === 0 && routable(provider)) {
    const envKeys = declaredEnvKeys(provider);
    if (envKeys.length > 0) {
      candidates = names.filter((k) => routable(canonicalProvider(k)) !== undefined && sameEnvKeys(declaredEnvKeys(canonicalProvider(k)), envKeys));
    }
  }
  if (candidates.length > 1) {
    throw new NotConfiguredError(
      `RouterConfig apiKeys: ambiguous credentials for ${JSON.stringify(provider)} from ${[...candidates].sort().map((k) => JSON.stringify(k)).join(", ")}; supply one entry under ${JSON.stringify(provider)} or keep only one shared entry`,
    );
  }
  if (candidates.length === 0) return undefined;
  const key = candidates[0]!;
  const value = keys[key];
  if (value === undefined || value === null || value === "") {
    throw new NotConfiguredError(`RouterConfig apiKeys: empty credential under ${JSON.stringify(key)}; no environment fallback`);
  }
  return key;
}

function apiKeysEntry(config: RouterConfig, provider: string): [CredentialLike | undefined, boolean] {
  const key = apiKeysSource(config, provider);
  return key === undefined ? [undefined, false] : [config.apiKeys![key], true];
}

function baseUrlEntry(config: RouterConfig, provider: string): string | undefined {
  if (!config.baseUrls) return undefined;
  for (const [key, value] of Object.entries(config.baseUrls)) if (canonicalProvider(key) === provider) return value;
  return undefined;
}

function levenshteinClose(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const c of candidates) {
    const score = ratio(word, c);
    if (score >= 0.6 && score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Every provider string a RouterConfig is keyed by (apiKeys, baseUrls,
 * settings) must name a routable provider. A near miss is named: an entry
 * that matches nothing is otherwise silently ignored, and the request goes
 * out on whatever the environment holds — the wrong account, with nothing
 * said (AUTH-1). Duplicate spellings of one provider under apiKeys are
 * refused rather than resolved by map order.
 */
function checkProviderKeyed(config: RouterConfig): void {
  const known = [...PROVIDERS.keys()].sort();
  for (const field of ["apiKeys", "baseUrls", "settings"] as const) {
    const mapping = config[field];
    if (!mapping) continue;
    const seen = new Set<string>();
    for (const key of Object.keys(mapping)) {
      const provider = canonicalProvider(key);
      if (field === "apiKeys" && seen.has(provider)) {
        throw new NotConfiguredError(`RouterConfig apiKeys: duplicate spellings for ${JSON.stringify(provider)}; use one entry`);
      }
      seen.add(provider);
      if (PROVIDERS.has(provider)) continue;
      const close = levenshteinClose(provider, known);
      const hint = close ? ` Did you mean ${JSON.stringify(close)}?` : "";
      throw new NotConfiguredError(
        `RouterConfig ${field}: ${JSON.stringify(key)} is not a provider lm15 routes to.${hint} router.resolve(model).provider (or resolveOpenAIChat) names the one a model string uses; known: ${known.join(", ")}`,
      );
    }
  }
}

function envOf(config: RouterConfig): Readonly<Record<string, string | undefined>> {
  return config.env ?? getDefaultPlatform().env();
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
  const transport: { transport?: Transport; baseUrl?: string } = config.transport ? { transport: config.transport } : {};
  const baseUrl = baseUrlEntry(config, res.provider);
  if (baseUrl !== undefined) {
    if (definition.hosted) {
      throw new NotConfiguredError(
        `RouterConfig baseUrls { ${JSON.stringify(res.provider)}: ... }: a cloud door's URL is built from its host settings (resource, region), not given whole; set them in RouterConfig settings { ${JSON.stringify(res.provider)}: {...} } instead.`,
      );
    }
    transport.baseUrl = baseUrl;
  }
  if (policy === "oauth") return adapterForDefinition(definition, transport);
  let [apiKey] = apiKeysEntry(config, res.provider);
  const env = envOf(config);
  if (definition.hosted) {
    const given = config.settings?.[res.provider];
    // The cloud chain is a host service (AUTH-11): profile files, CLIs, metadata
    // endpoints. Without one, explicit and env values still build the door.
    const chain = getDefaultPlatform().openCloudChain?.({ env, online: true });
    const profile = chain ? chain.profile(definition.access) : undefined;
    const settings = resolveSettings(definition.access.host, given, env as Record<string, string>, { provider: res.provider, ...(profile ? { profile } : {}) });
    if (chain) chain.settings = settings;
    if (apiKey === undefined && definition.access.credentialPolicy !== "key") {
      if (!chain) throw noCloudChain(getDefaultPlatform(), definition.access);
      apiKey = chain.credentialProvider(definition.access);
    } else if (apiKey === undefined) {
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
  if (apiKey === undefined && policy === "oauth-unless-explicit" && getDefaultPlatform().storedCredentials?.has(definition.access)) return adapterForDefinition(definition, transport);
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


// ------------------------------------------------- the OpenAI-shaped door ----

/**
 * litellm's routing prefixes (`<provider>/<model>`) that name a door lm15
 * has, copied as data. A prefix absent here is refused by name — never
 * routed by rule — because litellm's own rule is "a leading known provider
 * name is the provider", and an unknown one is an error there too. Where
 * litellm's name covers two lm15 doors (bedrock, vertex_ai: Anthropic or
 * not, by model) it is left out: choosing would be a guess.
 */
export const LITELLM_PROVIDER_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai-chat",
  anthropic: "anthropic",
  gemini: "gemini",
  groq: "groq",
  openrouter: "openrouter",
  deepseek: "deepseek",
  xai: "xai",
  ollama: "ollama",
  ollama_chat: "ollama",
  hosted_vllm: "vllm",
  moonshot: "moonshotai",
  azure: "azure-chat",
});

/** Keyword arguments of `create()` / `completion()` that configure the CLIENT, not the request: refused with the lm15 place they belong. */
const CLIENT_KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  api_key: "new LMRouter({ apiKeys: { provider: key } }) or the environment",
  api_base: "new LMRouter({ baseUrls: { provider: url } })",
  base_url: "new LMRouter({ baseUrls: { provider: url } })",
  timeout: "RouterConfig.transport",
  num_retries: "your own retry loop over RETRYABLE_ERRORS (lm15 never retries)",
  max_retries: "your own retry loop over RETRYABLE_ERRORS (lm15 never retries)",
  headers: "RouterConfig.transport",
  extra_headers: "RouterConfig.transport",
  extra_body: "config.extensions on the Request (build it with requestFromOpenAIChat and edit)",
  extra_query: "RouterConfig.transport",
  cache: "your own cache keyed on the Request (lm15 has no response cache)",
  caching: "your own cache keyed on the Request (lm15 has no response cache)",
  mock_response: "lm15/testing FakeLM",
  drop_params: "nothing: lm15 refuses what it cannot carry instead of dropping it",
  custom_llm_provider: "the model string's prefix",
});

/**
 * The lm15 model string for a model string written for the OpenAI SDK or
 * litellm (api-family § Ingest): an lm15 string (`provider:model`) is left
 * alone; litellm's `provider/model` maps its prefix through
 * `LITELLM_PROVIDER_PREFIXES` (only the first segment; a model id may
 * contain slashes itself: `groq/openai/gpt-oss-20b`); a bare name routes by
 * lm15's rules, except that OpenAI's models go to the Chat Completions door.
 */
export function openaiChatModelString(model: string): string {
  if (model.includes(":")) return model;
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const head = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (!rest) return model;
  const provider = LITELLM_PROVIDER_PREFIXES[head];
  if (provider === undefined) {
    throw new UnknownModelError(
      `could not read ${JSON.stringify(model)} as a litellm model string: ${JSON.stringify(head)} is not a provider prefix lm15 has a door for (known: ${Object.keys(LITELLM_PROVIDER_PREFIXES).sort().join(", ")}); write it as lm15's provider:model instead`,
      { model },
    );
  }
  return `${provider}:${rest}`;
}

/** `(model, messages, kwargs)` → the Chat Completions body, after refusing the client keywords by name. */
function splitOpenAIChatCall(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  for (const [key, where] of Object.entries(CLIENT_KEYWORDS)) {
    if (key in kwargs) throw new NotConfiguredError(`${JSON.stringify(key)} configures the client, not the request; in lm15 it lives in ${where}`);
  }
  return { model, messages, ...kwargs };
}

/**
 * Routes model strings to provider LMs. Config is frozen; the only state is
 * an LM cache keyed by provider (one LM per provider, built lazily).
 */
export class LMRouter {
  readonly config: RouterConfig;
  private readonly lms = new Map<string, ProviderLM>();

  constructor(config: RouterConfig = {}) {
    checkProviderKeyed(config);
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

  // ─── the OpenAI-shaped door (api-family § Ingest) ──────────────────

  /**
   * `resolve()` for the OpenAI-shaped door: `model` is read by
   * `openaiChatModelString`, and a bare OpenAI name goes to Chat Completions
   * (`openai-chat`), the endpoint the OpenAI SDK and litellm were using.
   * Like `resolve()`: no network, no credential invocation, no secret values.
   */
  resolveOpenAIChat(model: string): Resolution {
    let res = this.resolve(openaiChatModelString(model));
    if (res.source === "rule" && res.provider === "openai") res = this.resolve(`openai-chat:${res.model}`);
    return res;
  }

  /**
   * The Request behind `completeFromOpenAIChat`, and the LM it routes to.
   * `model` may be written for the OpenAI SDK, for litellm, or for lm15; the
   * body is read with the destination door's own spellings when it speaks
   * the Chat Completions wire, else with OpenAI's.
   */
  requestFromOpenAIChat(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>> = {}): [Request, ProviderLM] {
    const res = this.resolveOpenAIChat(model);
    const body = splitOpenAIChatCall(res.requested, messages, kwargs);
    const lm = this.lm(res.requested);
    const reader = (lm as ProviderLM & { requestFromOpenAIChat?: (body: unknown) => Request }).requestFromOpenAIChat;
    const request = reader ? reader.call(lm, body) : readOpenAIChat(body);
    return [routedRequest(request, res), lm];
  }

  /**
   * `client.chat.completions.create({ model, messages, ...})` or
   * `litellm.completion(...)` — the same call, answered by lm15. Messages and
   * keywords are read by `requestFromOpenAIChat` (MAP-12: every key maps,
   * passes through, or is refused by name); the model string by
   * `openaiChatModelString`. Returns a canonical `Response`, or with
   * `stream: true` a lazy `ResponseStream` (iterate for text, `.events()`
   * for typed events, `.response()` for the assembled answer; close it when
   * leaving early). Client keywords (`api_key`, `timeout`, …) are refused
   * with the RouterConfig place named.
   */
  completeFromOpenAIChat(model: string, messages: unknown, kwargs?: Readonly<Record<string, unknown>> & { stream?: false; signal?: AbortSignal }): Promise<Response>;
  completeFromOpenAIChat(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>> & { stream: true; signal?: AbortSignal }): Promise<ResponseStream>;
  completeFromOpenAIChat(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>> & { stream?: boolean; signal?: AbortSignal }): Promise<Response | ResponseStream>;
  async completeFromOpenAIChat(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>> & { stream?: boolean; signal?: AbortSignal } = {}): Promise<Response | ResponseStream> {
    const { stream = false, signal, ...rest } = kwargs;
    if (typeof stream !== "boolean") throw new TypeError("stream must be a boolean");
    const [request, lm] = this.requestFromOpenAIChat(model, messages, rest);
    const opts = signal ? { signal } : {};
    if (stream) return new ResponseStream(lm.stream(request, opts), request);
    return lm.complete(request, opts);
  }

  /** The raw-event twin of `completeFromOpenAIChat`: typed lm15 stream events, not OpenAI-shaped chunks. */
  streamFromOpenAIChat(model: string, messages: unknown, kwargs: Readonly<Record<string, unknown>> & { signal?: AbortSignal } = {}): AsyncIterable<StreamEvent> {
    const { signal, ...rest } = kwargs;
    const [request, lm] = this.requestFromOpenAIChat(model, messages, rest);
    return lm.stream(request, signal ? { signal } : {});
  }
}
