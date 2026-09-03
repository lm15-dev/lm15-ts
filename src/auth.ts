/**
 * lm15-contract auth surface (spec/auth.md, ratified 2026-08-31):
 * credential providers (AUTH-2), the resolution chain (AUTH-1), the explain
 * report (AUTH-7), and read-side borrowed CLI credentials (AUTH-8).
 *
 * Secrecy invariant (AUTH-5): no secret value is stored on an AuthReport,
 * rendered by describe(), or exposed by toString/inspect/JSON of any type
 * in this module.
 *
 * Not yet implemented in this port (stated, not absorbed): the AUTH-3/4
 * write side (locked double-checked refresh, atomic 0600 writes) and the
 * AUTH-9 login primitives. This port currently reads credentials only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A token inside this window counts as expired (AUTH-3 skew). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

// ─── credential providers (AUTH-2) ───────────────────────────────────

/**
 * A credential is a static key string or a zero-argument provider callable.
 * Adapters resolve it once per request at request-build time and never
 * cache the returned value; caching belongs to the provider itself.
 */
export type Credential = string | (() => string | Promise<string>);

/** Resolve a credential value, invoking a provider callable. */
export function resolveCredential(credential: Credential): string | Promise<string> {
  return typeof credential === "function" ? credential() : credential;
}

// ─── errors (AUTH-6) ─────────────────────────────────────────────────

/** No usable credential source. The hint names the fix. */
export class NotConfiguredError extends Error {
  readonly provider: string;
  readonly credentialHint: string;

  constructor(message: string, provider: string, credentialHint: string) {
    super(`${message}\n\n  To fix:\n    - ${credentialHint}\n`);
    this.name = "NotConfiguredError";
    this.provider = provider;
    this.credentialHint = credentialHint;
  }
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider ${JSON.stringify(provider)}. Known providers: ${knownProviders().join(", ")}`);
    this.name = "UnknownProviderError";
  }
}

// ─── provider table (mirrors the reference router) ───────────────────

interface ProviderSpec {
  envKeys: readonly string[];
  defaultKey?: string;
  oauthFile?: "claude-code" | "openai-codex";
}

const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
  openai: { envKeys: ["OPENAI_API_KEY"] },
  "openai-chat": { envKeys: ["OPENAI_API_KEY"] },
  anthropic: { envKeys: ["ANTHROPIC_API_KEY"] },
  gemini: { envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  groq: { envKeys: ["GROQ_API_KEY"] },
  openrouter: { envKeys: ["OPENROUTER_API_KEY"] },
  deepseek: { envKeys: ["DEEPSEEK_API_KEY"] },
  zai: { envKeys: ["ZAI_API_KEY"] },
  ollama: { envKeys: [], defaultKey: "ollama" },
  vllm: { envKeys: [], defaultKey: "EMPTY" },
  sglang: { envKeys: [], defaultKey: "EMPTY" },
  "claude-code": { envKeys: [], oauthFile: "claude-code" },
  "openai-codex": { envKeys: [], oauthFile: "openai-codex" },
};

/** Maps the permanent underscore alias to the hyphenated provider string. */
export function canonicalProvider(name: string): string {
  return name.replaceAll("_", "-");
}

/** Every provider in the built-in table, sorted. */
export function knownProviders(): string[] {
  return Object.keys(PROVIDERS).sort();
}

// ─── explain report (AUTH-7) ─────────────────────────────────────────

export type StepState = "selected" | "shadowed" | "absent";

/**
 * One rung of the chain. `kind` uses the contract vocabulary ("api_keys",
 * "env:<KEY>", "placeholder", "oauth-file"); `detail` is human text and
 * carries no secret material by construction.
 */
export interface AuthStep {
  readonly kind: string;
  readonly detail: string;
  readonly state: StepState;
}

const MARKERS: Record<StepState, string> = { selected: "=> ", shadowed: " ~ ", absent: " - " };

export class AuthReport {
  readonly provider: string;
  readonly steps: readonly AuthStep[];
  readonly configured: boolean;

  constructor(provider: string, steps: readonly AuthStep[], configured: boolean) {
    this.provider = provider;
    this.steps = steps;
    this.configured = configured;
  }

  get selected(): AuthStep | undefined {
    return this.steps.find((step) => step.state === "selected");
  }

  describe(): string {
    const lines = [`auth for provider ${JSON.stringify(this.provider)}:`];
    for (const step of this.steps) {
      lines.push(`  ${MARKERS[step.state]}${step.kind}: ${step.detail}`);
    }
    const selected = this.selected;
    lines.push(selected ? `  configured: yes — ${selected.kind}` : "  configured: no");
    return lines.join("\n");
  }

  toString(): string {
    return this.describe();
  }
}

export interface ExplainOptions {
  /** Defaults to process.env. Pass a plain object for hermetic tests. */
  env?: Record<string, string | undefined>;
  /** Providers with explicit credentials (the api_keys rung). Presence
   * only — explain never consults the values. */
  apiKeyProviders?: readonly string[];
  claudeCredentialsPath?: string;
  codexAuthPath?: string;
}

/**
 * Walk the AUTH-1 chain and report every rung (AUTH-7). No network I/O.
 * Env values are tested for presence only and never retained — that
 * presence check is the one stated purity trade-off.
 */
export function explainAuth(provider: string, options: ExplainOptions = {}): AuthReport {
  const canonical = canonicalProvider(provider);
  const spec = PROVIDERS[canonical];
  if (spec === undefined) throw new UnknownProviderError(provider);

  if (spec.oauthFile !== undefined) {
    const step = oauthFileStep(spec.oauthFile, options);
    return new AuthReport(canonical, [step], step.state === "selected");
  }

  const env = options.env ?? process.env;
  const steps: AuthStep[] = [];
  let selected = false;

  if (options.apiKeyProviders?.includes(canonical)) {
    steps.push({ kind: "api_keys", detail: "provided (value never shown)", state: "selected" });
    selected = true;
  } else {
    steps.push({ kind: "api_keys", detail: "not provided", state: "absent" });
  }

  for (const key of spec.envKeys) {
    if (env[key]) {
      steps.push({
        kind: `env:${key}`,
        detail: "set (value never shown)",
        state: selected ? "shadowed" : "selected",
      });
      selected = true;
    } else {
      steps.push({ kind: `env:${key}`, detail: "not set", state: "absent" });
    }
  }

  if (spec.defaultKey !== undefined) {
    steps.push({
      kind: "placeholder",
      detail: `preset default for keyless ${canonical} servers`,
      state: selected ? "shadowed" : "selected",
    });
    selected = true;
  }

  return new AuthReport(canonical, steps, selected);
}

function oauthFileStep(oauthProvider: "claude-code" | "openai-codex", options: ExplainOptions): AuthStep {
  let credential: LocalOAuthCredential | undefined;
  try {
    credential =
      oauthProvider === "claude-code"
        ? readClaudeCodeCredential(options.claudeCredentialsPath ?? defaultClaudeCredentialsPath())
        : readCodexCliCredential(options.codexAuthPath ?? defaultCodexAuthPath());
  } catch (error) {
    if (!(error instanceof NotConfiguredError)) throw error;
  }
  if (credential === undefined) {
    return { kind: "oauth-file", detail: "missing or unreadable", state: "absent" };
  }
  if (credential.expired) {
    return credential.hasRefreshToken
      ? { kind: "oauth-file", detail: "expired, refresh token present", state: "selected" }
      : { kind: "oauth-file", detail: "expired, NO refresh token", state: "absent" };
  }
  return { kind: "oauth-file", detail: "fresh", state: "selected" };
}

// ─── borrowed CLI credentials, read side (AUTH-8) ────────────────────

/**
 * A locally stored OAuth credential. Token material lives in true private
 * fields: JSON.stringify sees nothing, and toString/inspect are redacted
 * (AUTH-5). Use the accessors.
 */
export class LocalOAuthCredential {
  readonly #accessToken: string;
  readonly #refreshToken: string | undefined;
  readonly expiresAtMs: number | undefined;
  readonly accountId: string | undefined;

  constructor(
    accessToken: string,
    refreshToken: string | undefined,
    expiresAtMs: number | undefined,
    accountId: string | undefined,
  ) {
    this.#accessToken = accessToken;
    this.#refreshToken = refreshToken;
    this.expiresAtMs = expiresAtMs;
    this.accountId = accountId;
  }

  get accessToken(): string {
    return this.#accessToken;
  }

  get hasRefreshToken(): boolean {
    return this.#refreshToken !== undefined;
  }

  get expired(): boolean {
    return this.expiresAtMs !== undefined && Date.now() >= this.expiresAtMs;
  }

  toString(): string {
    return `LocalOAuthCredential(expiresAtMs=${this.expiresAtMs}, refresh=${this.hasRefreshToken}, redacted)`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

/** `~/.claude/.credentials.json` (AUTH-8). */
export function defaultClaudeCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/** `~/.codex/auth.json` (AUTH-8). */
export function defaultCodexAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

const CLAUDE_HINT = "Log in again: run `claude` and use /login (Claude subscription auth)";
const CODEX_HINT = "Log in again: run `codex login` (ChatGPT subscription auth)";

function readJsonObject(path: string, provider: string, hint: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return raise(provider, `No readable credentials file at ${path}.`, hint);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return raise(provider, `Credentials file at ${path} is not valid JSON.`, hint);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return raise(provider, `Credentials file at ${path} has an unexpected shape.`, hint);
  }
  return data as Record<string, unknown>;
}

function raise(provider: string, message: string, hint: string): never {
  throw new NotConfiguredError(message, provider, hint);
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read-only loader for the Claude Code CLI credential file. */
export function readClaudeCodeCredential(path: string): LocalOAuthCredential {
  const data = readJsonObject(path, "claude-code", CLAUDE_HINT);
  const oauth = objectField(data, "claudeAiOauth");
  if (oauth === undefined) raise("claude-code", `Credentials file at ${path} has no claudeAiOauth section.`, CLAUDE_HINT);
  const access = stringField(oauth, "accessToken");
  if (access === undefined) raise("claude-code", `Credentials file at ${path} has no access token.`, CLAUDE_HINT);
  const expires = oauth["expiresAt"];
  return new LocalOAuthCredential(
    access,
    stringField(oauth, "refreshToken"),
    typeof expires === "number" ? expires : undefined,
    undefined,
  );
}

/**
 * Read-only loader for the OpenAI Codex CLI auth file; expiry comes from
 * the access token's JWT `exp` claim minus the AUTH-3 skew.
 */
export function readCodexCliCredential(path: string): LocalOAuthCredential {
  const data = readJsonObject(path, "openai-codex", CODEX_HINT);
  const tokens = objectField(data, "tokens");
  if (tokens === undefined) raise("openai-codex", `Credentials file at ${path} has no tokens section.`, CODEX_HINT);
  const access = stringField(tokens, "access_token");
  if (access === undefined) raise("openai-codex", `Credentials file at ${path} has no access token.`, CODEX_HINT);
  const payload = jwtPayload(access);
  const exp = payload?.["exp"];
  const authClaim = payload === undefined ? undefined : objectField(payload, "https://api.openai.com/auth");
  return new LocalOAuthCredential(
    access,
    stringField(tokens, "refresh_token"),
    typeof exp === "number" ? exp * 1000 - REFRESH_SKEW_MS : undefined,
    stringField(tokens, "account_id") ?? (authClaim && stringField(authClaim, "chatgpt_account_id")),
  );
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const decoded = Buffer.from(parts[1] as string, "base64url").toString("utf8");
    const payload: unknown = JSON.parse(decoded);
    return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
