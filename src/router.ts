/**
 * `LMRouter`: a lookup table you can read, not a framework. Three resolution
 * rungs in fixed order — explicit `provider:` prefix, catalog (opt-in),
 * built-in rules — then the AUTH-1 credential chain when an LM is built.
 *
 * Stated deviation: the reference's rung 0 (a `provider` attribute carried
 * by a `str` subclass) is a Python idiom with no TypeScript equivalent;
 * pass `provider:model` or a catalog instead.
 */

import { checkPolicy, type Adaptation, type AdaptationPolicy } from "./adaptation.ts";
import type { ProviderLM } from "./adapter.ts";
import { requestFromOpenAIChat as readOpenAIChat } from "./dialects/openai_chat.ts";
import { endpointFromEnv, resolveSettings } from "./cloud/hosts.ts";
import { validateNamedCredential } from "./cloud/identity.ts";
import { explainAuth, type AuthReport } from "./auth/doctor.ts";
import { AmbiguousModelError, AuthOperationError, NotConfiguredError, UnknownModelError } from "./errors.ts";
import { DECLARED_LOGIN_PROVIDERS } from "./login/declared.ts";
import type { Auth } from "./login/manager.ts";
import { adapterForDefinition } from "./providers.ts";
import { getDefaultPlatform, noCloudChain } from "./platform.ts";
import { canonicalProvider, providerTable, type ProviderDefinition } from "./registry.ts";
import { createTransport, Timeouts, type Transport, type TransportBudgetOptions } from "./transport.ts";
import type { Request } from "./types/config.ts";
import { normalizeRequest } from "./types/config.ts";
import type { CredentialLike, NamedCredential } from "./types/credential.ts";
import type { CredentialPolicy } from "./vocab.ts";
import { CachedPrefix } from "./types/endpoints.ts";
import type { ModelInfo, ModelRegistry } from "./types/model_info.ts";
import type { Response } from "./types/response.ts";
import type { StreamEvent } from "./types/stream.ts";
import { ResponseStream } from "./stream.ts";

/** Maps a model-id prefix to a provider. That's all a rule is. */
export interface RouteRule {
  readonly prefix: string;
  readonly provider: string;
  readonly note?: string;
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
  rule("jev-", "typesafe", "TypeSafe System One judgment models"),
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
  readonly compat?: ProviderDefinition["compat"];
  /** Provenance belongs to the resolution, not a later global lookup. */
  readonly declared: boolean;
  readonly credentialPolicy: CredentialPolicy;
  readonly credential?: NamedCredential;
  readonly placeholderKey?: string;
  readonly note: string;
}

export function describeResolution(r: Resolution): string {
  const parts = [`${JSON.stringify(r.requested)} -> provider ${JSON.stringify(r.provider)}`];
  if (r.source === "prefix") parts.push("via explicit provider prefix");
  else if (r.source === "catalog") parts.push("via catalog match");
  else if (r.rule) parts.push(`via built-in rule prefix=${JSON.stringify(r.rule.prefix)}${r.rule.note ? ` — ${r.rule.note}` : ""}`);
  if (r.compat !== undefined) parts.push(typeof r.compat === "string" ? `compat preset ${JSON.stringify(r.compat)}` : "caller-declared compat policy");
  if (r.declared) parts.push("declared by RouterConfig.providers — no lm15 receipts");
  parts.push(`wire model ${JSON.stringify(r.model)}`);
  const policy = r.credentialPolicy;
  if (r.credential !== undefined) parts.push(`named credential ${JSON.stringify(r.credential)}; no fallback to another identity`);
  else if (policy.endsWith("-chain")) parts.push(`${policy} (doctor reports the selected identity)`);
  else if (policy === "oauth-unless-explicit") {
    let chain = "key from explicit apiKeys, else the stored subscription OAuth credential";
    if (r.envKey !== undefined) chain += `, else $${r.envKey}`;
    parts.push(chain);
  } else if (r.envKey !== undefined) parts.push(`key from $${r.envKey}`);
  else if (policy === "oauth") parts.push("local OAuth credential (no env key)");
  else if (r.placeholderKey !== undefined) parts.push("key from explicit apiKeys or the preset's local-server default");
  else parts.push("key from explicit apiKeys");
  return parts.join("; ") + ".";
}

export interface RouterConfig extends TransportBudgetOptions {
  /** Router-local declarations. Built-in ids and aliases cannot be replaced. */
  readonly providers?: readonly ProviderDefinition[];
  /** Name an identity, not a credential value. Never falls through to another identity. */
  readonly credentials?: Readonly<Record<string, NamedCredential>>;
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
  /** MAP-13: `"note"` (default: adapt and record on the response), `"silent"` (adapt, record nothing), `"refuse"` (every deviation refuses before the wire). */
  readonly adaptations?: AdaptationPolicy;
  /**
   * Managed authentication (AUTH-15 mode B): an `Auth` whose saved
   * connections supply the credential when no explicit `apiKeys` /
   * `credentials` entry does. With it, environment keys, other tools' login
   * files and the machine's cloud identity are never consulted: a missing,
   * expired, rejected or signed-out connection is a typed
   * `AuthOperationError`, never a silent switch to a metered key. Keyless
   * local servers still work without a connection. It also routes the
   * connection-only providers (`kimi-code`, `github-copilot`).
   */
  readonly auth?: Auth;
}

type DefinitionConfig = { readonly providers?: readonly ProviderDefinition[] | undefined };

/** Shared by routing and doctor; declarations remain local to this config. */
export function routerProviderLookup(provider: string, config: DefinitionConfig = {}): ProviderDefinition | undefined {
  return providerTable(config.providers).get(canonicalProvider(provider));
}

export function routerCanonicalProvider(provider: string, config: DefinitionConfig = {}): string {
  return routerProviderLookup(provider, config)?.id ?? canonicalProvider(provider);
}

function knownProviders(config: DefinitionConfig): string {
  return [...providerTable(config.providers).keys()].sort().join(", ");
}

function declaredEnvKeys(provider: string, config: DefinitionConfig): readonly string[] {
  return routerProviderLookup(provider, config)?.access.envKeys ?? [];
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
export function apiKeysSource(config: DefinitionConfig & { readonly apiKeys?: Readonly<Record<string, CredentialLike>> | undefined }, provider: string): string | undefined {
  provider = routerCanonicalProvider(provider, config);
  const keys = config.apiKeys;
  if (!keys) return undefined;
  const names = Object.keys(keys);
  const exact = names.filter((k) => routerCanonicalProvider(k, config) === provider);
  let candidates = exact;
  if (exact.length === 0 && routerProviderLookup(provider, config)) {
    const envKeys = declaredEnvKeys(provider, config);
    if (envKeys.length > 0) {
      candidates = names.filter((k) => routerProviderLookup(k, config) !== undefined && sameEnvKeys(declaredEnvKeys(k, config), envKeys));
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

function providerEntry<T>(mapping: Readonly<Record<string, T>> | undefined, provider: string, config: DefinitionConfig): T | undefined {
  for (const [key, value] of Object.entries(mapping ?? {})) if (routerCanonicalProvider(key, config) === provider) return value;
  return undefined;
}

function baseUrlEntry(config: RouterConfig, provider: string): string | undefined {
  return providerEntry(config.baseUrls, provider, config);
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
  const table = providerTable(config.providers);
  const known = [...table.keys()].sort();
  const litellm = new Map(Object.entries(LITELLM_PROVIDER_PREFIXES).map(([name, provider]) => [canonicalProvider(name), provider]));
  for (const d of config.providers ?? []) {
    for (const name of [d.id, ...(d.aliases ?? [])]) {
      if (litellm.has(name)) throw new NotConfiguredError(`RouterConfig providers: ${JSON.stringify(name)} already names the built-in ${JSON.stringify(litellm.get(name))} door in OpenAI-shaped routing`);
    }
  }
  for (const field of ["apiKeys", "baseUrls", "settings", "credentials"] as const) {
    const mapping = config[field];
    if (!mapping) continue;
    const seen = new Set<string>();
    for (const key of Object.keys(mapping)) {
      const provider = canonicalProvider(key);
      const aliasTarget = table.get(provider)?.id;
      if (aliasTarget !== undefined && aliasTarget !== provider) throw new NotConfiguredError(`RouterConfig ${field}: ${JSON.stringify(key)} is a model-prefix alias, not a configuration id. Did you mean ${JSON.stringify(aliasTarget)}?`);
      if (seen.has(provider)) {
        throw new NotConfiguredError(`RouterConfig ${field}: duplicate spellings for ${JSON.stringify(provider)}; use one entry`);
      }
      seen.add(provider);
      if (table.has(provider)) {
        if (field === "credentials") {
          const name = config.credentials![key];
          if (typeof name !== "string") throw new NotConfiguredError(`RouterConfig credentials: ${JSON.stringify(key)} must name platform, workload, environment or cli`);
          validateNamedCredential(table.get(provider)!.access, name, apiKeysSource(config, provider) !== undefined);
        }
        continue;
      }
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
  if (apiKeysEntry(config, provider)[1] || providerEntry(config.credentials, provider, config) !== undefined) return undefined;
  const envKeys = declaredEnvKeys(provider, config);
  if (envKeys.length === 0) return undefined;
  const env = envOf(config);
  for (const key of envKeys) if (env[key]) return key;
  return envKeys[0];
}

function resolution(requested: string, model: string, provider: string, source: ResolutionSource, config: RouterConfig, extra: { rule?: RouteRule; modelInfo?: ModelInfo } = {}): Resolution {
  const definition = routerProviderLookup(provider, config)!;
  const envKey = envKeyFor(provider, config);
  return Object.freeze({
    requested,
    model,
    provider,
    source,
    declared: (config.providers ?? []).some((d) => d.id === provider),
    credentialPolicy: definition.access.credentialPolicy,
    ...(providerEntry(config.credentials, provider, config) !== undefined ? { credential: providerEntry(config.credentials, provider, config)! } : {}),
    note: definition.note,
    ...(definition.placeholderKey !== undefined ? { placeholderKey: definition.placeholderKey } : {}),
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
    const head = routerCanonicalProvider(model.slice(0, colon), config);
    const rest = model.slice(colon + 1);
    if (routerProviderLookup(head, config) && rest) return resolution(requested, rest, head, "prefix", config);
  }

  // Rung 2: catalog (only when a registry was supplied).
  if (config.registry) {
    const matches = config.registry.list().filter((info) => info.id === model || (info.aliases ?? []).includes(model));
    const providers = [...new Set(matches.map((m) => routerCanonicalProvider(m.provider, config)))];
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
      const provider = routerCanonicalProvider(info.provider, config);
      if (!routerProviderLookup(provider, config)) {
        throw new UnknownModelError(
          `model ${JSON.stringify(model)} resolved in the catalog to provider ${JSON.stringify(info.provider)}, but lm15 has no adapter or compat preset for it. Known providers: ${knownProviders(config)}. Declare a provider with RouterConfig.providers or construct a provider LM directly (e.g. OpenAIChatLM with a custom baseUrl) for OpenAI-compatible servers.`,
          { model },
        );
      }
      return resolution(requested, (info.aliases ?? []).includes(model) ? info.id : model, provider, "catalog", config, { modelInfo: info });
    }
  }

  // Rung 3: built-in prefix rules, first match wins.
  for (const r of rules) {
    if (model.startsWith(r.prefix)) {
      const provider = routerCanonicalProvider(r.provider, config);
      if (!routerProviderLookup(provider, config)) {
        throw new UnknownModelError(`rule ${JSON.stringify(r)} names provider ${JSON.stringify(r.provider)}, which has no adapter. Known providers: ${knownProviders(config)}.`, { model });
      }
      return resolution(requested, model, provider, "rule", config, { rule: r });
    }
  }

  const hints: string[] = [];
  if (colon >= 0) {
    const close = closeMatch(canonicalProvider(model.slice(0, colon)), [...providerTable(config.providers).keys()].sort());
    if (close) hints.push(`Did you mean "${close}:${model.slice(colon + 1)}"?`);
  }
  hints.push(`Use an explicit provider prefix — "provider:${model}" with provider one of: ${knownProviders(config)}.`);
  if (!config.registry) hints.push("Or pass a model catalog: new LMRouter({ registry }) built from canonical ModelInfo entries.");
  throw new UnknownModelError(
    `could not route model ${JSON.stringify(model)}: no provider prefix, ${config.registry ? "no catalog match" : "no catalog supplied"}, and none of the ${rules.length} built-in rules matched. ${hints.join(" ")}`,
    { model },
  );
}

/** Provider resolved but no key was found: a `NotConfiguredError` under the family. */
export class MissingCredentialError extends NotConfiguredError {}

function buildLm(res: Resolution, config: RouterConfig, shared: Transport): ProviderLM {
  const definition = routerProviderLookup(res.provider, config)!;
  const policy = definition.access.credentialPolicy;
  const env = envOf(config);
  const baseUrl = baseUrlEntry(config, res.provider) ?? endpointFromEnv(definition.access.host, env);
  const options = {
    transport: shared,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(config.adaptations !== undefined ? { adaptations: checkPolicy(config.adaptations) } : {}),
  };
  if (config.auth !== undefined) return buildManagedLm(res, config, definition, shared);
  if (policy === "oauth") return adapterForDefinition(definition, options);
  const entry = apiKeysSource(config, res.provider);
  let apiKey = entry === undefined ? undefined : config.apiKeys![entry];
  let origin: string | undefined;
  if (entry !== undefined && typeof apiKey !== "function") origin = `an explicit apiKeys entry (${JSON.stringify(entry)})`;
  let settings: Readonly<Record<string, string>> | undefined;
  if (definition.hosted) {
    const named = providerEntry(config.credentials, res.provider, config);
    const chain = getDefaultPlatform().openCloudChain?.({ env, online: true });
    const profile = chain?.profile(definition.access);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) values[key] = value;
    settings = resolveSettings(definition.access.host, providerEntry(config.settings, res.provider, config), values, {
      provider: res.provider, ...(profile ? { profile } : {}), ...(baseUrl !== undefined ? { endpoint: baseUrl } : {}),
    });
    if (chain) chain.settings = settings;
    if (apiKey === undefined && policy !== "key") {
      if (!chain) throw noCloudChain(getDefaultPlatform(), definition.access, named);
      apiKey = chain.credentialProvider(definition.access, named);
    }
  }
  if (apiKey === undefined && policy === "oauth-unless-explicit") {
    // A usable stored subscription login outranks ambient env keys: it spends no money per token
    // (AUTH-1). An unusable or signed-out one BLOCKS them (R3, ratified 2026-09-22): a failed
    // subscription is never silently replaced by a metered key.
    const stored = getDefaultPlatform().storedCredentials;
    const state = stored ? (stored.state ? stored.state(definition.access) : stored.has(definition.access) ? "usable" : "absent") : "absent";
    if (state === "usable") return adapterForDefinition(definition, options);
    if (state === "unusable" || state === "logged_out") {
      const present = definition.access.envKeys.find((key) => env[key]);
      const what = state === "logged_out" ? "was signed out" : "is expired and cannot be renewed";
      throw new MissingCredentialError(
        `the ${JSON.stringify(res.provider)} subscription login ${what}. `
          + (present ? `$${present} is set but is used only when passed explicitly: ` : "")
          + `sign in again (${definition.access.loginHint ?? "sign in"}), or pass the key deliberately with { apiKeys: { ${JSON.stringify(res.provider)}: "..." } }.`,
        { provider: res.provider, envKeys: definition.access.envKeys },
      );
    }
  }
  if (apiKey === undefined) {
    for (const key of definition.access.envKeys) {
      if (env[key]) {
        apiKey = env[key]!;
        origin = `env $${key} (value never shown)`;
        break;
      }
    }
  }
  if (apiKey === undefined && definition.placeholderKey !== undefined) {
    apiKey = definition.placeholderKey;
    origin = "the local server's placeholder key";
  }
  if (apiKey === undefined && policy === "oauth-unless-explicit") return adapterForDefinition(definition, options);
  if (apiKey === undefined) {
    throw new MissingCredentialError(
      `no credential found for provider ${JSON.stringify(res.provider)}. Set ${definition.access.envKeys.join(" or ")} in the environment, or pass { apiKeys: { ${JSON.stringify(res.provider)}: "..." } }.`,
      { provider: res.provider, envKeys: definition.access.envKeys },
    );
  }
  const lm = adapterForDefinition(definition, { apiKey, ...options, ...(settings !== undefined ? { settings } : {}) });
  if (origin !== undefined) lm.setCredentialOrigin(origin);
  return lm;
}

/**
 * AUTH-15 mode B. Order: an explicit `apiKeys` entry; an explicit named
 * cloud identity; the scope's saved connection (its credential resolved and
 * renewed per request); a keyless local server's placeholder. Never an
 * environment key, another tool's login file or the machine's cloud chain.
 */
function buildManagedLm(res: Resolution, config: RouterConfig, definition: ProviderDefinition, shared: Transport): ProviderLM {
  const auth = config.auth!;
  const provider = res.provider;
  const env = envOf(config);
  let baseUrl = baseUrlEntry(config, provider) ?? (definition.hosted ? endpointFromEnv(definition.access.host, env) : undefined);
  const entry = apiKeysSource(config, provider);
  let apiKey: CredentialLike | undefined = entry === undefined ? undefined : config.apiKeys![entry];
  let named = providerEntry(config.credentials, provider, config) as string | undefined;
  let origin: string | undefined = entry !== undefined && typeof apiKey !== "function" ? `an explicit apiKeys entry (${JSON.stringify(entry)})` : undefined;
  let accountId: string | undefined;
  let access = definition.access;
  if (entry === undefined && named === undefined) {
    let selection: ReturnType<Auth["selectionSync"]>;
    try {
      selection = auth.selectionSync(provider);
    } catch (error) {
      const loginRequired = error instanceof AuthOperationError && error.reason === "login_required";
      if (loginRequired && definition.placeholderKey !== undefined && !auth.statusSync(provider)?.loggedOut) {
        apiKey = definition.placeholderKey;
        origin = "the local server's placeholder key";
      } else if (loginRequired && definition.hosted) {
        throw new AuthOperationError(
          `${provider}: no saved connection in this scope; the machine's cloud identity is not used under a managed Auth — save a named identity (auth.configure(${JSON.stringify(provider)}, { method: "cloud", ... })) or pass { credentials: ... } explicitly`,
          { reason: "login_required", stage: "resolution", recovery: "select_connection", provider },
        );
      } else throw error;
    }
    if (selection) {
      if (selection.named) named = selection.named;
      else {
        apiKey = auth.credentialProvider(provider);
        if (selection.accountId) accountId = selection.accountId;
        if (selection.baseUrl && baseUrl === undefined) baseUrl = selection.baseUrl;
        const lowered = new Set(access.headers.map(([k]) => k.toLowerCase()));
        const extra = Object.entries(selection.headers).filter(([k]) => !lowered.has(k.toLowerCase()) && k.toLowerCase() !== "chatgpt-account-id");
        if (extra.length > 0 && !definition.hosted) access = Object.freeze({ ...access, headers: Object.freeze([...access.headers, ...extra]) });
      }
      origin = `managed connection ${selection.connection.id} (${selection.connection.label})`;
    } else if (apiKey === undefined) {
      // A store that cannot read synchronously: the connection is resolved at the first request.
      apiKey = auth.credentialProvider(provider);
      origin = "managed connection";
    }
  }
  const options = {
    transport: shared,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(config.adaptations !== undefined ? { adaptations: checkPolicy(config.adaptations) } : {}),
  };
  const bound = access === definition.access ? definition : Object.freeze({ ...definition, access }) as ProviderDefinition;
  if (definition.hosted) {
    const chain = getDefaultPlatform().openCloudChain?.({ env, online: true });
    const profile = chain?.profile(definition.access);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) values[key] = value;
    const settings = resolveSettings(definition.access.host, providerEntry(config.settings, provider, config), values, {
      provider, ...(profile ? { profile } : {}), ...(baseUrl !== undefined ? { endpoint: baseUrl } : {}),
    });
    if (chain) chain.settings = settings;
    if (apiKey === undefined && named !== undefined) {
      if (!chain) throw noCloudChain(getDefaultPlatform(), definition.access, named as NamedCredential);
      apiKey = chain.credentialProvider(definition.access, named as NamedCredential);
    }
    if (apiKey === undefined) {
      throw new AuthOperationError(`${provider}: no credential for this cloud door under a managed Auth`, { reason: "login_required", stage: "resolution", recovery: "select_connection", provider });
    }
    const lm = adapterForDefinition(bound, { apiKey, ...options, settings });
    if (origin !== undefined) lm.setCredentialOrigin(origin);
    return lm;
  }
  const lm = adapterForDefinition(bound, { ...(apiKey !== undefined ? { apiKey } : {}), ...options });
  if (origin !== undefined) lm.setCredentialOrigin(origin);
  return lm;
}

// Planning owns neither a pool nor a credential. Even an accidental send refuses locally.
const PLANNING_TRANSPORT: Transport = Object.freeze({
  async send(): Promise<never> { throw new Error("planning must never send a request"); },
});

function planningLm(res: Resolution, config: RouterConfig): ProviderLM {
  const definition = routerProviderLookup(res.provider, config)!;
  const host = definition.access.host;
  const given = providerEntry(config.settings, res.provider, config) ?? {};
  const settings = Object.fromEntries((host?.settings ?? []).map((s) => [s.name, given[s.name] ?? s.default ?? "planning"]));
  const baseUrl = baseUrlEntry(config, res.provider) ?? endpointFromEnv(host, config.env ?? {});
  return adapterForDefinition(definition, {
    apiKey: "lm15-planning",
    accountId: "lm15-planning",
    transport: PLANNING_TRANSPORT,
    // Explicit empty env is important: no host service may run during plan.
    env: {},
    settings,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(config.adaptations !== undefined ? { adaptations: config.adaptations } : {}),
  });
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
  drop_params: "RouterConfig { adaptations: 'silent' }: lm15 adapts what a wire cannot carry and records it on the response (MAP-13); 'silent' keeps no record, 'refuse' throws instead",
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
export function openaiChatModelString(model: string, config: DefinitionConfig = {}): string {
  if (model.includes(":")) return model;
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const head = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (!rest) return model;
  const declared = (config.providers ?? []).find((d) => [d.id, ...(d.aliases ?? [])].includes(canonicalProvider(head)));
  const provider = LITELLM_PROVIDER_PREFIXES[head] ?? declared?.id;
  if (provider === undefined) {
    throw new UnknownModelError(
      `could not read ${JSON.stringify(model)} as a litellm model string: ${JSON.stringify(head)} is not a provider prefix lm15 has a door for (known: ${[...new Set([...Object.keys(LITELLM_PROVIDER_PREFIXES), ...(config.providers ?? []).flatMap((d) => [d.id, ...(d.aliases ?? [])])])].sort().join(", ")}); write it as lm15's provider:model instead`,
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
  private ownedTransport: Transport | undefined;

  constructor(config: RouterConfig = {}) {
    checkProviderKeyed(config);
    if (config.transport !== undefined && (config.timeouts !== undefined || config.maxConnections !== undefined)) {
      throw new NotConfiguredError("RouterConfig transport cannot be combined with timeouts or maxConnections; configure the supplied transport directly");
    }
    if (config.timeouts !== undefined) new Timeouts(config.timeouts);
    if (config.maxConnections !== undefined && (!Number.isSafeInteger(config.maxConnections) || config.maxConnections < 1)) throw new NotConfiguredError("maxConnections must be a positive safe integer");
    if (config.adaptations !== undefined) checkPolicy(config.adaptations);
    if (config.auth !== undefined) {
      // A managed router also routes the connection-only doors: declared
      // providers, added only here because only a managed Auth can hold
      // their credential.
      const taken = new Set((config.providers ?? []).map((d) => d.id));
      const declared = DECLARED_LOGIN_PROVIDERS.filter((d) => !taken.has(d.id));
      if (declared.length > 0) config = { ...config, providers: [...(config.providers ?? []), ...declared] };
    }
    const table = providerTable(config.providers);
    for (const r of config.rules ?? []) {
      if (!r || typeof r.prefix !== "string" || typeof r.provider !== "string" || !table.has(canonicalProvider(r.provider))) throw new NotConfiguredError("RouterConfig rules must name a declared or built-in provider");
    }
    for (const key of Object.keys(config.apiKeys ?? {})) apiKeysSource(config, key);
    this.config = Object.freeze({
      ...config,
      ...(config.providers ? { providers: Object.freeze([...config.providers]) } : {}),
      ...(config.rules ? { rules: Object.freeze(config.rules.map((r) => Object.freeze({ ...r }))) } : {}),
      ...(config.apiKeys ? { apiKeys: Object.freeze({ ...config.apiKeys }) } : {}),
      ...(config.credentials ? { credentials: Object.freeze({ ...config.credentials }) } : {}),
      ...(config.baseUrls ? { baseUrls: Object.freeze({ ...config.baseUrls }) } : {}),
      ...(config.settings ? { settings: Object.freeze(Object.fromEntries(Object.entries(config.settings).map(([k, v]) => [k, Object.freeze({ ...v })]))) } : {}),
      ...(config.timeouts ? { timeouts: Object.freeze({ ...config.timeouts }) } : {}),
    });
  }

  private sharedTransport(): Transport {
    if (this.config.transport) return this.config.transport;
    return this.ownedTransport ??= createTransport({
      ...(this.config.timeouts !== undefined ? { timeouts: this.config.timeouts } : {}),
      ...(this.config.maxConnections !== undefined ? { maxConnections: this.config.maxConnections } : {}),
    });
  }

  /** Close only the pool this router owns; a supplied transport remains caller-owned.
   * Idempotent. The next lm() creates a fresh shared pool.
   */
  async close(): Promise<void> {
    const owned = this.ownedTransport;
    this.ownedTransport = undefined;
    this.lms.clear();
    await owned?.close?.();
  }

  /** Offline credential/endpoint explanation for the route, including local declarations. */
  explainAuth(model: string): AuthReport {
    const res = this.resolve(model);
    const credential = providerEntry(this.config.credentials, res.provider, this.config);
    const settings = providerEntry(this.config.settings, res.provider, this.config);
    const baseUrl = baseUrlEntry(this.config, res.provider);
    return explainAuth(res.provider, {
      ...(this.config.auth !== undefined ? { auth: this.config.auth } : {}),
      ...(this.config.credentials !== undefined ? { credentials: this.config.credentials } : {}),
      ...(this.config.providers !== undefined ? { providers: this.config.providers } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
      ...(this.config.apiKeys !== undefined ? { apiKeys: this.config.apiKeys } : {}),
      ...(credential !== undefined ? { credential } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    });
  }

  doctor(model: string): AuthReport { return this.explainAuth(model); }

  /** Pure lookup; touches no network and reads no secret values. */
  resolve(model: string): Resolution {
    return resolveModel(model, this.config);
  }

  /** `resolve()`, then construct-or-reuse the provider LM. */
  lm(model: string): ProviderLM {
    const res = this.resolve(model);
    let lm = this.lms.get(res.provider);
    if (!lm) {
      lm = buildLm(res, this.config, this.sharedTransport());
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

  /**
   * MAP-13 pre-flight: what a call with this request WOULD adapt on the
   * route it resolves to, with no network and no credential invoked. Throws
   * what the call would throw. The answer to "can this route carry this
   * request?" for an engine that picks between routes.
   */
  plan(request: Request, opts: { policy?: AdaptationPolicy } = {}): Promise<readonly Adaptation[]> {
    const req = normalizeRequest(request);
    const planningConfig = { ...this.config, env: this.config.env ?? {} };
    const res = resolveModel(req.model, planningConfig);
    return planningLm(res, planningConfig).plan(routedRequest(req, res), opts);
  }

  /** The MAP-6 door, routed by the prefix's model. */
  async cache(prefix: Request, opts: { ttlSeconds?: number; label?: string } = {}): Promise<CachedPrefix> {
    const req = normalizeRequest(prefix);
    const res = this.resolve(req.model);
    const cached = await this.lm(req.model).cache(routedRequest(req, res), opts);
    return CachedPrefix.create({ ...cached, provider: res.provider });
  }

  // ─── the OpenAI-shaped door (api-family § Ingest) ──────────────────

  /**
   * `resolve()` for the OpenAI-shaped door: `model` is read by
   * `openaiChatModelString`, and a bare OpenAI name goes to Chat Completions
   * (`openai-chat`), the endpoint the OpenAI SDK and litellm were using.
   * Like `resolve()`: no network, no credential invocation, no secret values.
   */
  resolveOpenAIChat(model: string): Resolution {
    let res = this.resolve(openaiChatModelString(model, this.config));
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
