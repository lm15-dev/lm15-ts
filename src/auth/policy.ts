/**
 * Access policies (spec/auth.md AUTH-10): how a dialect reaches a backend,
 * as a value. The table is copied from the reference as data (port.md
 * rule 2) and consulted at the same named points.
 */

import { looksLikeJwt } from "./jwt.ts";
import { NotConfiguredError } from "../errors.ts";
import { ApiKey, AwsCredentials, BearerToken, coerceCredential, type CredentialValue } from "../types/credential.ts";
import type { AuthScheme, CredentialPolicy, ModelPlacement, StreamFraming } from "../vocab.ts";

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

function host(spec: Partial<HostSpec> & { baseUrl: string }): HostSpec {
  return Object.freeze({
    settings: [],
    paths: {},
    modelIn: "body",
    anthropicVersionIn: "header",
    streamFraming: "sse",
    requiredHeaders: [],
    ...spec,
  });
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
    ...compactSpec(spec),
  } as AccessPolicy);
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

// ─── Base URLs shared with the compat tables (one copy each) ─────────

export const OPENAI_CHAT_PRESET_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1", // lmstudio.ai docs (Local Server)
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  vllm: "http://localhost:8000/v1",
  sglang: "http://localhost:30000/v1",
  deepseek: "https://api.deepseek.com",
  zai: "https://api.z.ai/api/paas/v4",
  meta: "https://api.meta.ai/v1",
  moonshotai: "https://api.moonshot.ai/v1",
});

// A server's OpenAI root is one address whichever OpenAI-shaped path is used;
// the local engines' roots are the chat table's. A preset that names a server
// absent here (qwen, deepseek, zai: no documented Responses root) is REFUSED
// at construction without an explicit baseUrl — never sent to the OpenAI
// cloud (compat.ts presetBaseUrl, 2026-09-11).
export const OPENAI_RESPONSES_PRESET_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  vllm: "http://localhost:8000/v1",
  sglang: "http://localhost:30000/v1",
  openrouter: "https://openrouter.ai/api/v1",
  meta: "https://api.meta.ai/v1",
  moonshotai: "https://api.moonshot.ai/v1",
});

export const ANTHROPIC_PRESET_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "https://api.anthropic.com/v1",
  deepseek: "https://api.deepseek.com/anthropic/v1",
  meta: "https://api.meta.ai/v1",
  moonshotai: "https://api.moonshot.ai/anthropic/v1",
});

// ─── Login hints (AUTH-6/AUTH-9) ─────────────────────────────────────

export const CLAUDE_CODE_LOGIN_HINT = "Log in again: run `claude` and use /login (Claude subscription auth)";
export const OPENAI_CODEX_LOGIN_HINT = "Log in again: run `codex login` (ChatGPT subscription auth)";
export const XAI_LOGIN_HINT = "Log in again: run lm15.auth.login_xai() (SuperGrok / X Premium subscription auth)";

// ─── The table ───────────────────────────────────────────────────────

export const ANTHROPIC_API = policy({
  provider: "anthropic",
  supports: supports({ files: true, batches: true, models: true }),
  authModes: ["x-api-key"],
  envKeys: ["ANTHROPIC_API_KEY"],
  authScheme: ["x-api-key"],
});

export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.170";
export const DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE = policy({
  provider: "claude-code",
  supports: supports({ models: true }),
  credentialPolicy: "oauth",
  authModes: ["claude-code-oauth", "bearer-oauth"],
  authScheme: ["bearer"],
  headers: [
    ["anthropic-dangerous-direct-browser-access", "true"],
    ["anthropic-beta", "claude-code-20250219,oauth-2025-04-20"],
    ["x-app", "cli"],
    ["user-agent", `claude-cli/${DEFAULT_CLAUDE_CODE_VERSION}`],
  ],
  loginHint: CLAUDE_CODE_LOGIN_HINT,
  backend: "claude-code",
  systemPrefix: DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT,
});

export const OPENAI_API = policy({
  provider: "openai",
  supports: supports({
    live: true,
    files: true,
    batches: true,
    images: true,
    speech: true,
    video: true,
    responsesApi: true,
    models: true,
  }),
  authModes: ["bearer"],
  envKeys: ["OPENAI_API_KEY"],
  enterpriseVariants: ["azure-openai"],
});

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_ORIGINATOR = "lm15";
export const DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant.";
export const DEFAULT_CODEX_CLIENT_VERSION = "0.147.0";

export const OPENAI_CODEX = policy({
  provider: "openai-codex",
  supports: supports({ models: true }),
  credentialPolicy: "oauth",
  authModes: ["chatgpt-oauth", "bearer-oauth"],
  headers: [
    ["OpenAI-Beta", "responses=experimental"],
    ["originator", DEFAULT_CODEX_ORIGINATOR],
  ],
  loginHint: OPENAI_CODEX_LOGIN_HINT,
  backend: "chatgpt-codex",
  backendOptions: { client_version: DEFAULT_CODEX_CLIENT_VERSION },
  systemPrefix: DEFAULT_CODEX_INSTRUCTIONS,
  baseUrl: DEFAULT_CODEX_BASE_URL,
});

export const OPENAI_CHAT_API = policy({
  provider: "openai-chat",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: ["OPENAI_API_KEY"],
});

export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export const XAI = policy({
  provider: "xai",
  supports: supports({ models: true, images: true, video: true }),
  credentialPolicy: "oauth-unless-explicit",
  authModes: ["bearer", "xai-oauth"],
  envKeys: ["XAI_API_KEY"],
  loginHint: XAI_LOGIN_HINT,
  baseUrl: DEFAULT_XAI_BASE_URL,
});

export const GEMINI_API = policy({
  provider: "gemini",
  supports: supports({
    live: true,
    files: true,
    batches: true,
    images: true,
    speech: true,
    video: true,
    models: true,
    caches: true,
  }),
  authModes: ["query-api-key", "x-goog-api-key"],
  envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  authScheme: ["x-api-key"], // the dialect renders it as x-goog-api-key
});

export const META_ENV_KEYS = ["META_API_KEY"] as const;

export const META = policy({
  provider: "meta",
  supports: supports({ files: true, images: true, responsesApi: true, models: true }),
  authModes: ["bearer"],
  envKeys: META_ENV_KEYS,
  baseUrl: OPENAI_RESPONSES_PRESET_BASE_URLS["meta"],
});

export const GROQ = policy({
  provider: "groq",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: ["GROQ_API_KEY"],
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["groq"],
});

export const OPENROUTER = policy({
  provider: "openrouter",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: ["OPENROUTER_API_KEY"],
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["openrouter"],
});

export const DEEPSEEK = policy({
  provider: "deepseek",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: ["DEEPSEEK_API_KEY"],
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["deepseek"],
});

export const ZAI = policy({
  provider: "zai",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: ["ZAI_API_KEY"],
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["zai"],
});

export const MOONSHOTAI_ENV_KEYS = ["MOONSHOTAI_API_KEY", "MOONSHOT_API_KEY"] as const;

export const MOONSHOTAI = policy({
  provider: "moonshotai",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: MOONSHOTAI_ENV_KEYS,
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["moonshotai"],
});

export const MOONSHOTAI_RESPONSES = policy({
  provider: "moonshotai-responses",
  supports: supports({ responsesApi: true, models: true }),
  authModes: ["bearer"],
  envKeys: MOONSHOTAI_ENV_KEYS,
  baseUrl: OPENAI_RESPONSES_PRESET_BASE_URLS["moonshotai"],
});

export const META_CHAT = policy({
  provider: "meta-chat",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: META_ENV_KEYS,
  baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["meta"],
});

export const DEEPSEEK_ANTHROPIC = policy({
  provider: "deepseek-anthropic",
  supports: supports(),
  authModes: ["x-api-key"],
  envKeys: ["DEEPSEEK_API_KEY"],
  authScheme: ["x-api-key"],
  baseUrl: ANTHROPIC_PRESET_BASE_URLS["deepseek"],
});

export const META_ANTHROPIC = policy({
  provider: "meta-anthropic",
  supports: supports({ models: true }),
  authModes: ["bearer"],
  envKeys: META_ENV_KEYS,
  authScheme: ["bearer"],
  baseUrl: ANTHROPIC_PRESET_BASE_URLS["meta"],
});

export const MOONSHOTAI_ANTHROPIC = policy({
  provider: "moonshotai-anthropic",
  supports: supports(),
  authModes: ["bearer"],
  envKeys: MOONSHOTAI_ENV_KEYS,
  authScheme: ["bearer"],
  baseUrl: ANTHROPIC_PRESET_BASE_URLS["moonshotai"],
});

// ─── Cloud hosts ─────────────────────────────────────────────────────

const AWS_REGION: HostSetting = { name: "region", env: ["AWS_REGION", "AWS_DEFAULT_REGION"] };
const AWS_WORKSPACE: HostSetting = { name: "workspace", env: ["ANTHROPIC_AWS_WORKSPACE_ID"] };
const GCP_PROJECT: HostSetting = { name: "project", env: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"] };
const GCP_LOCATION: HostSetting = { name: "location", env: ["GOOGLE_CLOUD_LOCATION"], default: "global" };
const AZURE_OPENAI_RESOURCE: HostSetting = { name: "resource", env: ["AZURE_OPENAI_RESOURCE"] };
const AZURE_FOUNDRY_RESOURCE: HostSetting = { name: "resource", env: ["ANTHROPIC_FOUNDRY_RESOURCE"] };
const AZURE_AUTHORITY: HostSetting = { name: "authority_host", env: ["AZURE_AUTHORITY_HOST"], default: "https://login.microsoftonline.com" };
const AZURE_SCOPE: HostSetting = { name: "scope", env: [], default: "https://ai.azure.com/.default" };

export const AWS_ANTHROPIC = policy({
  provider: "aws-anthropic",
  supports: supports(),
  credentialPolicy: "aws-chain",
  authModes: ["sigv4", "x-api-key"],
  envKeys: ["ANTHROPIC_AWS_API_KEY"],
  authScheme: ["sigv4", "x-api-key"],
  backend: "aws-external-anthropic",
  host: host({
    baseUrl: "https://aws-external-anthropic.{region}.api.aws/v1",
    settings: [AWS_REGION, AWS_WORKSPACE],
    requiredHeaders: [["anthropic-workspace-id", "workspace"]],
    sigv4Service: "aws-external-anthropic",
  }),
});

export const BEDROCK_ANTHROPIC = policy({
  provider: "bedrock-anthropic",
  supports: supports(),
  credentialPolicy: "aws-chain",
  authModes: ["sigv4", "x-api-key"],
  envKeys: ["AWS_BEARER_TOKEN_BEDROCK"],
  authScheme: ["sigv4", "x-api-key"],
  backend: "bedrock-mantle",
  host: host({ baseUrl: "https://bedrock-mantle.{region}.api.aws/anthropic/v1", settings: [AWS_REGION], sigv4Service: "bedrock-mantle" }),
});

export const BEDROCK_CHAT = policy({
  provider: "bedrock-chat",
  supports: supports(),
  credentialPolicy: "aws-chain",
  authModes: ["sigv4", "bearer"],
  envKeys: ["AWS_BEARER_TOKEN_BEDROCK"],
  authScheme: ["sigv4", "bearer"],
  backend: "bedrock-runtime",
  host: host({ baseUrl: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", settings: [AWS_REGION], sigv4Service: "bedrock" }),
});

export const BEDROCK_MANTLE_CHAT = policy({
  provider: "bedrock-mantle-chat",
  supports: supports({ models: true }),
  credentialPolicy: "aws-chain",
  authModes: ["sigv4", "bearer"],
  envKeys: ["AWS_BEARER_TOKEN_BEDROCK"],
  authScheme: ["sigv4", "bearer"],
  backend: "bedrock-mantle",
  host: host({ baseUrl: "https://bedrock-mantle.{region}.api.aws/v1", settings: [AWS_REGION], sigv4Service: "bedrock-mantle" }),
});

export const AZURE = policy({
  provider: "azure",
  supports: supports({ live: true, files: true, batches: true, speech: true, responsesApi: true, models: true }),
  credentialPolicy: "azure-chain",
  authModes: ["api-key", "entra-oauth"],
  envKeys: ["AZURE_OPENAI_API_KEY"],
  authScheme: ["api-key", "bearer"],
  backend: "azure-openai",
  host: host({ baseUrl: "https://{resource}.openai.azure.com/openai/v1", settings: [AZURE_OPENAI_RESOURCE, AZURE_AUTHORITY, AZURE_SCOPE] }),
});

export const AZURE_CHAT = policy({
  provider: "azure-chat",
  supports: supports({ models: true }),
  credentialPolicy: "azure-chain",
  authModes: ["api-key", "entra-oauth"],
  envKeys: ["AZURE_OPENAI_API_KEY"],
  authScheme: ["api-key", "bearer"],
  backend: "azure-openai",
  host: host({ baseUrl: "https://{resource}.openai.azure.com/openai/v1", settings: [AZURE_OPENAI_RESOURCE, AZURE_AUTHORITY, AZURE_SCOPE] }),
});

export const AZURE_ANTHROPIC = policy({
  provider: "azure-anthropic",
  supports: supports(),
  credentialPolicy: "azure-chain",
  authModes: ["x-api-key", "entra-oauth"],
  envKeys: ["ANTHROPIC_FOUNDRY_API_KEY"],
  authScheme: ["x-api-key", "bearer"],
  backend: "azure-foundry",
  host: host({
    baseUrl: "https://{resource}.services.ai.azure.com/anthropic/v1",
    settings: [AZURE_FOUNDRY_RESOURCE, AZURE_AUTHORITY, AZURE_SCOPE],
  }),
});

const VERTEX_BASE = "https://{location_host}/v1/projects/{project}/locations/{location}";

export const VERTEX = policy({
  provider: "vertex",
  supports: supports(),
  credentialPolicy: "gcp-chain",
  authModes: ["google-oauth"],
  envKeys: [],
  authScheme: ["bearer"],
  backend: "vertex",
  host: host({ baseUrl: VERTEX_BASE + "/publishers/google", settings: [GCP_PROJECT, GCP_LOCATION] }),
});

export const VERTEX_EXPRESS = policy({
  provider: "vertex-express",
  supports: supports(),
  credentialPolicy: "key",
  authModes: ["query-api-key"],
  envKeys: ["GOOGLE_API_KEY"],
  authScheme: ["query-key"],
  backend: "vertex-express",
  host: host({ baseUrl: "https://aiplatform.googleapis.com/v1/publishers/google" }),
});

export const VERTEX_ANTHROPIC = policy({
  provider: "vertex-anthropic",
  supports: supports(),
  credentialPolicy: "gcp-chain",
  authModes: ["google-oauth"],
  envKeys: [],
  authScheme: ["bearer"],
  backend: "vertex",
  host: host({
    baseUrl: VERTEX_BASE,
    settings: [GCP_PROJECT, GCP_LOCATION],
    paths: {
      messages: "/publishers/anthropic/models/{model}:rawPredict",
      "messages/stream": "/publishers/anthropic/models/{model}:streamRawPredict",
    },
    modelIn: "path",
    anthropicVersionIn: "body:vertex-2023-10-16",
  }),
});

export const CLOUD_HOST_POLICIES: readonly AccessPolicy[] = Object.freeze([
  AZURE,
  AZURE_CHAT,
  AZURE_ANTHROPIC,
  AWS_ANTHROPIC,
  BEDROCK_ANTHROPIC,
  BEDROCK_CHAT,
  BEDROCK_MANTLE_CHAT,
  VERTEX,
  VERTEX_EXPRESS,
  VERTEX_ANTHROPIC,
]);

export const OLLAMA = policy({ provider: "ollama", supports: supports({ models: true }), authModes: ["bearer"], baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["ollama"] });
export const VLLM = policy({ provider: "vllm", supports: supports({ models: true }), authModes: ["bearer"], baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["vllm"] });
export const SGLANG = policy({ provider: "sglang", supports: supports({ models: true }), authModes: ["bearer"], baseUrl: OPENAI_CHAT_PRESET_BASE_URLS["sglang"] });

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
  if ((scheme === "api-key" || scheme === "x-api-key") && p.authScheme.includes("bearer") && looksLikeJwt(value.value)) {
    throw new NotConfiguredError(
      `${p.provider}: the credential is a JWT (a bearer token), but a plain string travels as an API key here (\`${
        scheme === "x-api-key" ? "x-api-key" : "api-key"
      }\` header); wrap it: new BearerToken(token)`,
      { provider: p.provider, envKeys: p.envKeys, credentialHint: "apiKey: () => new BearerToken(provider())" },
    );
  }
  if (scheme === "bearer") return ["Authorization", `Bearer ${value.value}`];
  if (scheme === "x-api-key") return [apiKeyHeader, value.value];
  if (scheme === "api-key") return ["api-key", value.value];
  return undefined;
}

export { ApiKey };
