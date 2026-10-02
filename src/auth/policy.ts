/**
 * Access policies (spec/auth.md AUTH-10): how a dialect reaches a backend,
 * as a value. The table is copied from the reference as data (port.md
 * rule 2) and consulted at the same named points.
 */

import { looksLikeAccessToken } from "./jwt.ts";
import { NotConfiguredError } from "../errors.ts";
import { ValueError } from "../types/validate.ts";
import { ApiKey, AwsCredentials, BearerToken, coerceCredential, type CredentialValue } from "../types/credential.ts";
import type { AuthScheme, CredentialPolicy, ModelPlacement, StreamFraming } from "../vocab.ts";
import {
  ANTHROPIC_BASE_URL_TABLE,
  DECLARED_LOGIN_ROWS,
  OPENAI_CHAT_BASE_URL_TABLE,
  OPENAI_RESPONSES_BASE_URL_TABLE,
  PROVIDER_ROWS,
} from "../generated/tables.ts";

export interface EndpointSupport {
  readonly complete: boolean;
  readonly stream: boolean;
  readonly live: boolean;
  readonly files: boolean;
  readonly batches: boolean;
  readonly images: boolean;
  readonly speech: boolean;
  readonly video: boolean;
  readonly responsesApi: boolean;
  readonly models: boolean;
  readonly caches: boolean;
  readonly extra: readonly string[];
}

export type Surface = keyof Omit<EndpointSupport, "extra">;

const SUPPORT_DEFAULTS: EndpointSupport = Object.freeze({
  complete: true,
  stream: true,
  live: false,
  files: false,
  batches: false,
  images: false,
  speech: false,
  video: false,
  responsesApi: false,
  models: false,
  caches: false,
  extra: Object.freeze([]) as readonly string[],
});

export function supports(overrides: Partial<EndpointSupport> = {}): EndpointSupport {
  return Object.freeze({ ...SUPPORT_DEFAULTS, ...overrides });
}

export function supportsEndpoint(s: EndpointSupport, name: string): boolean {
  if (s.extra.includes(name)) return true;
  const key = name === "responses_api" ? "responsesApi" : name;
  return Boolean((s as unknown as Record<string, unknown>)[key]);
}

/** One host setting: its name, the env variables consulted in order, and its default (`undefined` = required). */
export interface HostSetting {
  readonly name: string;
  readonly env: readonly string[];
  readonly default?: string;
}

/** How a dialect reaches a cloud door (AUTH-10 `host`). */
export interface HostSpec {
  /** Template over the settings: `{region}`, `{project}`, `{location}`, `{location_host}`, `{resource}`. */
  readonly baseUrl: string;
  readonly settings: readonly HostSetting[];
  /** Vendor endpoint variables, in priority order (AUTH-10). */
  readonly endpointEnv?: readonly string[];
  /** Endpoint-path overrides keyed by the dialect's endpoint name; `{model}` is the request's model. */
  readonly paths: Readonly<Record<string, string>>;
  readonly modelIn: ModelPlacement;
  /** `header` or `body:<value>`. */
  readonly anthropicVersionIn: string;
  readonly streamFraming: StreamFraming;
  /** `(header name, setting name)` pairs sent on every request. */
  readonly requiredHeaders: ReadonlyArray<readonly [string, string]>;
  readonly sigv4Service?: string;
}

export interface AccessPolicy {
  /** Canonical provider string (hyphenated). */
  readonly provider: string;
  readonly supports: EndpointSupport;
  readonly authModes: readonly string[];
  readonly enterpriseVariants: readonly string[];
  readonly envKeys: readonly string[];
  readonly credentialPolicy: CredentialPolicy;
  /** The schemes this door accepts, in preference order; the credential kind selects one. */
  readonly authScheme: readonly AuthScheme[];
  /** Static headers on every request, in order. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly host?: HostSpec;
  readonly loginHint?: string;
  /** Dialect-consulted variant; `api` is the public API. */
  readonly backend: string;
  readonly backendOptions: Readonly<Record<string, string>>;
  /** Text the backend requires first in system/instructions. */
  readonly systemPrefix?: string;
  /** This access path's default base URL, when not the dialect's. */
  readonly baseUrl?: string;
  /**
   * The `backendOptions` a caller may set on a door without a host (AUTH-10,
   * amended 2026-09-30): each names a `backendOptions` key and the env
   * variables the router consults for it; its default is the table's
   * `backendOptions` value. The subscription doors declare `client_version`.
   */
  readonly backendSettings: readonly HostSetting[];
}

const CLOUD_CHAINS = new Set<string>(["aws-chain", "azure-chain", "gcp-chain"]);

type PolicySpec = { [K in keyof AccessPolicy]?: AccessPolicy[K] | undefined } & { provider: string };

function policy(spec: PolicySpec): AccessPolicy {
  const p: AccessPolicy = Object.freeze({
    supports: SUPPORT_DEFAULTS,
    authModes: [],
    enterpriseVariants: [],
    envKeys: [],
    credentialPolicy: "key",
    authScheme: ["bearer"],
    headers: [],
    backend: "api",
    backendOptions: {},
    backendSettings: [],
    ...compactSpec(spec),
  } as AccessPolicy);
  for (const setting of p.backendSettings) {
    // One authority for the value a door sends by default: the table's option.
    if (setting.default !== undefined) throw new Error(`${p.provider}: backend setting '${setting.name}' takes its default from backendOptions`);
    if (!(setting.name in p.backendOptions)) throw new Error(`${p.provider}: backend setting '${setting.name}' has no backendOptions default`);
  }
  if (p.backendSettings.length > 0 && p.host) throw new Error(`${p.provider}: a door with a host declares its settings on the host`);
  if (p.credentialPolicy === "oauth" && p.envKeys.length > 0) throw new Error(`${p.provider}: an 'oauth' access policy declares no env_keys`);
  if (p.authScheme.includes("sigv4") && !p.host?.sigv4Service) throw new Error(`${p.provider}: sigv4 needs a host with sigv4_service`);
  if (CLOUD_CHAINS.has(p.credentialPolicy) && !p.host && p.provider !== "vertex-express") {
    throw new Error(`${p.provider}: a cloud chain policy needs a host`);
  }
  return p;
}

function compactSpec<T extends object>(spec: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function isCloudChain(p: AccessPolicy): boolean {
  return CLOUD_CHAINS.has(p.credentialPolicy);
}

/** The first header-carrying scheme, in the two-value spelling the dialects consult for an ApiKey. */
export function authHeaderKind(p: AccessPolicy): "bearer" | "x-api-key" {
  for (const scheme of p.authScheme) {
    if (scheme === "bearer") return "bearer";
    if (scheme === "x-api-key" || scheme === "api-key") return "x-api-key";
  }
  return "bearer";
}

/** A copy with these static headers replaced or appended (names compared case-insensitively). */
export function withHeaders(p: AccessPolicy, headers: Record<string, string>): AccessPolicy {
  const lowered = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const kept = p.headers.filter(([k]) => !lowered.has(k.toLowerCase()));
  return Object.freeze({ ...p, headers: [...kept, ...Object.entries(headers)] });
}

// ─── Backend settings (AUTH-10, amended 2026-09-30) ──────────────────

/**
 * The door's backend settings: the caller's value, then `env` (when given —
 * the router passes the environment, an adapter built by hand does not),
 * then the table's `backendOptions` value. `sources` receives each origin
 * (`explicit`, `env:<VAR>`, `default`). A name the door does not declare is
 * a configuration error that lists the names it does: a setting nothing
 * reads would otherwise be dropped with nothing said.
 */
export function resolveBackendSettings(
  p: AccessPolicy,
  given: Readonly<Record<string, string>> | undefined,
  env?: Readonly<Record<string, string | undefined>>,
  sources?: Record<string, string>,
): Record<string, string> {
  const supplied = given ?? {};
  const known = p.backendSettings.map((s) => s.name);
  const unknown = Object.keys(supplied).filter((n) => !known.includes(n)).sort();
  if (unknown.length > 0) {
    const hint = known.length > 0 ? `known: ${known.join(", ")}` : "this door takes no settings";
    throw new NotConfiguredError(`${p.provider}: unknown setting(s) ${unknown.map((n) => `'${n}'`).join(", ")}; ${hint}`, {
      provider: p.provider,
      credentialHint: known.length > 0 ? `Pass only ${known.join(", ")} for ${p.provider}` : `Remove the settings entry for ${p.provider}`,
    });
  }
  const out: Record<string, string> = {};
  for (const setting of p.backendSettings) {
    let value = supplied[setting.name] ?? "";
    let origin = value ? "explicit" : "";
    if (!value && env) {
      for (const name of setting.env) {
        const candidate = env[name];
        if (candidate) {
          value = candidate;
          origin = `env:${name}`;
          break;
        }
      }
    }
    if (!value) [value, origin] = [p.backendOptions[setting.name] ?? "", "default"];
    out[setting.name] = value;
    if (sources) sources[setting.name] = origin;
  }
  return out;
}

/**
 * The policy with these resolved backend settings in `backendOptions`.
 * `client_version` on the `claude-code` backend is also the version the
 * `user-agent` header claims (`claude-cli/<client_version>`); on
 * `chatgpt-codex` it is the `/models` query parameter.
 */
export function withBackendSettings(p: AccessPolicy, values: Readonly<Record<string, string>>): AccessPolicy {
  const options = { ...p.backendOptions, ...values };
  if (Object.entries(options).every(([k, v]) => p.backendOptions[k] === v)) return p;
  let out: AccessPolicy = Object.freeze({ ...p, backendOptions: Object.freeze(options) });
  if (p.backend === "claude-code" && values["client_version"] !== undefined) {
    out = withHeaders(out, { "user-agent": `claude-cli/${options["client_version"]}` });
  }
  return out;
}

/** `settings` with the `client_version` a named option gave; two different answers are a configuration error. */
export function mergeClientVersion(
  settings: Readonly<Record<string, string>> | undefined,
  version: string | undefined,
  option: string,
): Readonly<Record<string, string>> | undefined {
  if (version === undefined) return settings;
  const current = settings?.["client_version"];
  if (current !== undefined && current !== version) {
    throw new ValueError(`${option}=${JSON.stringify(version)} and settings client_version=${JSON.stringify(current)} disagree; pass one`);
  }
  return { ...(settings ?? {}), client_version: version };
}

const CLAUDE_CODE_FLOOR = /Claude Code (\S+) does not support this model; version (\S+) or newer is required/;

/**
 * The claude-code door's minimum-version refusal, with what an lm15 caller
 * changes: the server says "run 'claude update'", which does not move the
 * version lm15 claims (AUTH-10 backend settings). Any other message is
 * returned unchanged.
 */
export function claudeCodeVersionGuidance(message: string): string {
  const match = CLAUDE_CODE_FLOOR.exec(message);
  if (!match || message.includes("\n\n  To fix:")) return message;
  const required = match[2]!;
  return `${message}\n\n  To fix:\n`
    + "    - lm15 sends this version itself; updating Claude Code does not change it\n"
    + `    - Set the claude-code setting client_version to ${required} or newer (or ${CLAUDE_CODE_VERSION_ENV}=${required})\n`;
}

// ─── Base URLs shared with the compat tables (one copy each) ─────────

// Generated from lm15-contract tables/providers.json (src/generated/tables.ts):
// the reference's preset roots, one copy each.
export const OPENAI_CHAT_PRESET_BASE_URLS: Readonly<Record<string, string>> = OPENAI_CHAT_BASE_URL_TABLE;
export const OPENAI_RESPONSES_PRESET_BASE_URLS: Readonly<Record<string, string>> = OPENAI_RESPONSES_BASE_URL_TABLE;
export const ANTHROPIC_PRESET_BASE_URLS: Readonly<Record<string, string>> = ANTHROPIC_BASE_URL_TABLE;

// ─── The table ───────────────────────────────────────────────────────

// Every access policy, registry and managed-login declared providers alike,
// generated from the reference's table and validated by `policy()`. The named
// constants below are the public `access.*` names; a provider added to the
// table needs none (the registry iterates the rows).
const ACCESS_TABLE: ReadonlyMap<string, AccessPolicy> = new Map(
  [...PROVIDER_ROWS, ...DECLARED_LOGIN_ROWS].map((row) => [row.id, policy(row.access)] as const),
);

/** The table's access policy for `provider`; a name the table lacks is a build-time bug. */
export function tablePolicy(provider: string): AccessPolicy {
  const found = ACCESS_TABLE.get(provider);
  if (!found) throw new Error(`no access policy for ${JSON.stringify(provider)} in src/generated/tables.ts`);
  return found;
}

function tableSetting(provider: string, name: string): HostSetting {
  const found = tablePolicy(provider).backendSettings.find((s) => s.name === name);
  if (!found) throw new Error(`${provider}: no backend setting ${JSON.stringify(name)} in the table`);
  return found;
}

function tableHeader(provider: string, name: string): string {
  const found = tablePolicy(provider).headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`${provider}: no ${JSON.stringify(name)} header in the table`);
  return found[1];
}

export const ANTHROPIC_API = tablePolicy("anthropic");
export const CLAUDE_CODE = tablePolicy("claude-code");
export const OPENAI_API = tablePolicy("openai");
export const OPENAI_CODEX = tablePolicy("openai-codex");
export const OPENAI_CHAT_API = tablePolicy("openai-chat");
export const XAI = tablePolicy("xai");
export const TYPESAFE_API = tablePolicy("typesafe");
export const GEMINI_API = tablePolicy("gemini");
export const META = tablePolicy("meta");
export const GROQ = tablePolicy("groq");
export const OPENROUTER = tablePolicy("openrouter");
export const KIMI_CODE = tablePolicy("kimi-code");
export const GITHUB_COPILOT = tablePolicy("github-copilot");
export const DEEPSEEK = tablePolicy("deepseek");
export const ZAI = tablePolicy("zai");
export const DEEPINFRA = tablePolicy("deepinfra");
export const TOGETHER = tablePolicy("together");
export const FIREWORKS = tablePolicy("fireworks");
export const PARASAIL = tablePolicy("parasail");
export const MOONSHOTAI = tablePolicy("moonshotai");
export const MOONSHOTAI_RESPONSES = tablePolicy("moonshotai-responses");
export const META_CHAT = tablePolicy("meta-chat");
export const DEEPSEEK_ANTHROPIC = tablePolicy("deepseek-anthropic");
export const META_ANTHROPIC = tablePolicy("meta-anthropic");
export const MOONSHOTAI_ANTHROPIC = tablePolicy("moonshotai-anthropic");
export const AWS_ANTHROPIC = tablePolicy("aws-anthropic");
export const BEDROCK_ANTHROPIC = tablePolicy("bedrock-anthropic");
export const BEDROCK_CHAT = tablePolicy("bedrock-chat");
export const BEDROCK_MANTLE_CHAT = tablePolicy("bedrock-mantle-chat");
export const AZURE = tablePolicy("azure");
export const AZURE_CHAT = tablePolicy("azure-chat");
export const AZURE_ANTHROPIC = tablePolicy("azure-anthropic");
export const VERTEX = tablePolicy("vertex");
export const VERTEX_EXPRESS = tablePolicy("vertex-express");
export const VERTEX_ANTHROPIC = tablePolicy("vertex-anthropic");
export const OLLAMA = tablePolicy("ollama");
export const VLLM = tablePolicy("vllm");
export const SGLANG = tablePolicy("sglang");

export const CLOUD_HOST_POLICIES: readonly AccessPolicy[] = Object.freeze(
  [...ACCESS_TABLE.values()].filter((p) => p.host !== undefined),
);

// ─── Values the table carries, by their historic names ───────────────

// Login hints (AUTH-6/AUTH-9).
export const CLAUDE_CODE_LOGIN_HINT = CLAUDE_CODE.loginHint!;
export const OPENAI_CODEX_LOGIN_HINT = OPENAI_CODEX.loginHint!;
export const XAI_LOGIN_HINT = XAI.loginHint!;

/**
 * The Claude Code release this door says it is (`user-agent:
 * claude-cli/<version>`). Anthropic's server reads it: a model can require a
 * newer release (claude-opus-5-5 refuses anything before 2.1.280, live
 * 2026-09-23 and 2026-09-30). Callers move it without a release through the
 * `client_version` setting or LM15_CLAUDE_CODE_VERSION (AUTH-10 backend
 * settings).
 */
export const DEFAULT_CLAUDE_CODE_VERSION = CLAUDE_CODE.backendOptions["client_version"]!;
export const DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT = CLAUDE_CODE.systemPrefix!;
export const CLAUDE_CODE_VERSION_ENV = tableSetting("claude-code", "client_version").env[0]!;
export const CODEX_CLIENT_VERSION_ENV = tableSetting("openai-codex", "client_version").env[0]!;
export const DEFAULT_CODEX_BASE_URL = OPENAI_CODEX.baseUrl!;
export const DEFAULT_CODEX_ORIGINATOR = tableHeader("openai-codex", "originator");
export const DEFAULT_CODEX_INSTRUCTIONS = OPENAI_CODEX.systemPrefix!;
export const DEFAULT_CODEX_CLIENT_VERSION = OPENAI_CODEX.backendOptions["client_version"]!;
export const DEFAULT_XAI_BASE_URL = XAI.baseUrl!;
export const META_ENV_KEYS: readonly string[] = META.envKeys;
export const MOONSHOTAI_ENV_KEYS: readonly string[] = MOONSHOTAI.envKeys;

// ─── Scheme selection (AUTH-2, D1) ───────────────────────────────────

const ACCEPTED_SCHEMES: Readonly<Record<string, readonly AuthScheme[]>> = Object.freeze({
  api_key: ["bearer", "x-api-key", "api-key", "query-key"],
  bearer_token: ["bearer", "x-api-key"],
  aws: ["sigv4"],
});

/**
 * ApiKey: the first scheme in the POLICY's order that carries a key.
 * BearerToken: `bearer` if listed, else `x-api-key` if listed (the TOKEN's order).
 * AwsCredentials: `sigv4` only.
 */
export function selectScheme(p: AccessPolicy, credential: CredentialValue): AuthScheme {
  const accepted = ACCEPTED_SCHEMES[credential.kind]!;
  if (credential instanceof BearerToken) {
    for (const scheme of accepted) if (p.authScheme.includes(scheme)) return scheme;
  } else {
    for (const scheme of p.authScheme) if (accepted.includes(scheme)) return scheme;
  }
  throw new NotConfiguredError(
    `${p.provider}: a ${credential.kind} credential cannot travel under ${p.authScheme.join("/")}; it accepts ${accepted.join("/")}`,
    { provider: p.provider, envKeys: p.envKeys },
  );
}


/**
 * The `[name, value]` header carrying `credential` under this policy, or
 * `undefined` when the scheme is not a header (`sigv4` signs the finished
 * request; `query-key` is a query parameter).
 */
export function authHeader(
  p: AccessPolicy,
  credential: string | CredentialValue,
  apiKeyHeader = "x-api-key",
): readonly [string, string] | undefined {
  const value = coerceCredential(credential);
  const scheme = selectScheme(p, value);
  if (value instanceof AwsCredentials) return undefined;
  // A token-shaped string (a JWT, or a Google `ya29.` access token) is never a
  // key on any door lm15 has; sent in a key header it is a certain 401.
  if ((scheme === "api-key" || scheme === "x-api-key") && p.authScheme.includes("bearer") && looksLikeAccessToken(value.value) !== undefined) {
    return ["Authorization", `Bearer ${value.value}`];
  }
  if (scheme === "bearer") return ["Authorization", `Bearer ${value.value}`];
  if (scheme === "x-api-key") return [apiKeyHeader, value.value];
  if (scheme === "api-key") return ["api-key", value.value];
  return undefined;
}

export { ApiKey };
