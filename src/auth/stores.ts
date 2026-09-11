/**
 * Stored credentials (spec/auth.md AUTH-3, AUTH-4, AUTH-8): the borrowed
 * Claude Code and Codex CLI files, the lm15-owned store (xAI), the
 * double-checked refresh under a lock, and atomic private writes.
 *
 * Linux: the system `flock` utility locks an inherited open file description.
 * Node retains the descriptor after the utility exits; close or process death
 * releases the kernel lock. The lock path and primitive match Python/Rust.
 * Requires util-linux flock on PATH; other platforms fail explicitly.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, LockTimeoutError, NotConfiguredError, UnsupportedFeatureError } from "../errors.ts";
import { isJsonObject, parseJson, stringifyJson, type JsonObject } from "../json.ts";
import { ApiKey, BearerToken, type CredentialLike, type CredentialValue } from "../types/credential.ts";
import { decodeJwtPayload, extractChatgptAccountId } from "./jwt.ts";
import type { LoadedCredential } from "../platform.ts";
import { CLAUDE_CODE_LOGIN_HINT, OPENAI_CODEX_LOGIN_HINT, XAI_LOGIN_HINT, type AccessPolicy } from "./policy.ts";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d5-88ed-5944d1962f5e";
export const CLAUDE_CODE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEFAULT_TOKEN_LIFETIME_S = 3600;

export function expandHome(p: string, home?: string): string {
  if (p === "~") return home ?? os.homedir();
  if (p.startsWith("~/")) return path.join(home ?? os.homedir(), p.slice(2));
  return p;
}

// ─── AUTH-8 well-known paths ─────────────────────────────────────────

export function claudeCodeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["HOME"] ?? os.homedir(), ".claude", ".credentials.json");
}
export function codexCliAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["HOME"] ?? os.homedir(), ".codex", "auth.json");
}
export function piAgentAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env["HOME"] ?? os.homedir(), ".pi", "agent", "auth.json");
}
/** The lm15-owned credential store. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LM15_CREDENTIALS_PATH"];
  if (override) return expandHome(override, env["HOME"]);
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg ? expandHome(xdg, env["HOME"]) : path.join(env["HOME"] ?? os.homedir(), ".config");
  return path.join(base, "lm15", "credentials.json");
}
export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LM15_LOCK_DIR"];
  if (override) return expandHome(override, env["HOME"]);
  const xdg = env["XDG_CACHE_HOME"];
  const base = xdg ? expandHome(xdg, env["HOME"]) : path.join(env["HOME"] ?? os.homedir(), ".cache");
  return path.join(base, "lm15", "locks");
}

// ─── AUTH-4: lock + atomic write ─────────────────────────────────────

function realPathAllowMissing(target: string): string {
  try { return fs.realpathSync(target); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = path.dirname(target);
    if (parent === target) throw e;
    return path.join(realPathAllowMissing(parent), path.basename(target));
  }
}

export function lockPathFor(target: string): string {
  const canonical = realPathAllowMissing(path.resolve(expandHome(target)));
  const digest = createHash("sha256").update(canonical, "utf-8").digest("hex").slice(0, 32);
  return path.join(lockDir(), `${digest}.lock`);
}

function tryFlock(fd: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000,
    });
    child.once("error", (cause) => reject(new NotConfiguredError("credential locking requires util-linux flock on PATH", { cause })));
    child.once("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 75) resolve(false);
      else reject(new NotConfiguredError("flock could not acquire the credential lock; no unsafe fallback was used"));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold the exclusive advisory lock for `target` while `fn` runs. Not re-entrant. */
export async function withFileLock<T>(target: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  if (process.platform !== "linux") throw new NotConfiguredError("shared credential locking currently requires Linux and util-linux flock; pass an explicit credential on other platforms");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("lock timeoutMs must be non-negative and finite");
  const lockFile = lockPathFor(target);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = performance.now() + timeoutMs;
  const fd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new NotConfiguredError("credential lock must be a regular file");
    while (!(await tryFlock(fd))) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new LockTimeoutError(`Could not lock credential file ${target} within ${timeoutMs}ms; another process holds the lock. Do not delete the lock file.`, { path: target, lockPath: lockFile });
      await sleep(Math.min(50, remaining));
    }
    return await fn();
  } finally {
    // Never unlink: concurrent processes must keep locking the same inode.
    fs.closeSync(fd);
  }
}

/** Write-to-temp (0600) → fsync → rename; a reader sees the old or the new file, never a partial one. */
export function writePrivateJsonAtomic(target: string, data: JsonObject): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const text = stringifyJson(data, { indent: 2 }) + "\n";
  const temp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (e) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort
    }
    throw e;
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best effort
  }
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // best effort
  }
}

// ─── Local OAuth credentials ─────────────────────────────────────────

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A locally stored OAuth credential; token fields never print. */
export class LocalOAuthCredential {
  readonly #accessToken: string;
  readonly #refreshToken: string | undefined;
  /** Epoch milliseconds, already skewed by five minutes where lm15 wrote it. */
  readonly expiresAt: number | undefined;
  readonly accountId: string | undefined;

  constructor(fields: { accessToken: string; refreshToken?: string | undefined; expiresAt?: number | undefined; accountId?: string | undefined }) {
    this.#accessToken = fields.accessToken;
    this.#refreshToken = fields.refreshToken;
    this.expiresAt = fields.expiresAt;
    this.accountId = fields.accountId;
    Object.freeze(this);
  }

  get accessToken(): string {
    return this.#accessToken;
  }
  get refreshToken(): string | undefined {
    return this.#refreshToken;
  }
  get expired(): boolean {
    return this.expiresAt !== undefined && Date.now() >= this.expiresAt;
  }
  toString(): string {
    return `LocalOAuthCredential(<redacted>${this.expiresAt !== undefined ? `, expires_at=${this.expiresAt}` : ""})`;
  }
  [INSPECT](): string {
    return this.toString();
  }
  toJSON(): string {
    return this.toString();
  }
}

function notConfigured(provider: string, message: string, hint: string): NotConfiguredError {
  return new NotConfiguredError(message, { provider, credentialHint: hint });
}

function readJsonFile(file: string, provider: string, hint: string): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw notConfigured(provider, `No credentials file at ${file}.`, hint);
    throw notConfigured(provider, `Could not read credentials file at ${file}: ${(e as Error).message}`, hint);
  }
  let data: unknown;
  try {
    data = parseJson(text);
  } catch {
    throw notConfigured(provider, `Credentials file at ${file} is not valid JSON.`, hint);
  }
  if (!isJsonObject(data)) throw notConfigured(provider, `Credentials file at ${file} has an unexpected shape.`, hint);
  return data;
}

export function readJsonFileOrUndefined(file: string): JsonObject | undefined {
  try {
    const data = parseJson(fs.readFileSync(file, "utf-8"));
    return isJsonObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

export { decodeJwtPayload, extractChatgptAccountId } from "./jwt.ts";

export function jwtExpiresAtMs(token: string): number | undefined {
  try {
    const exp = decodeJwtPayload(token)["exp"];
    const n = typeof exp === "number" ? exp : typeof exp === "object" && exp !== null && "raw" in exp ? Number((exp as { raw: string }).raw) : undefined;
    return n === undefined ? undefined : Math.trunc(n * 1000) - REFRESH_SKEW_MS;
  } catch {
    return undefined;
  }
}

async function postJson(url: string, payload: JsonObject): Promise<JsonObject> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: stringifyJson(payload),
  });
  const data = parseJson(await res.text());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return isJsonObject(data) ? data : {};
}

async function postForm(url: string, payload: Record<string, string>): Promise<{ ok: boolean; status: number; data: JsonObject }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(payload).toString(),
  });
  let data: unknown = {};
  try {
    data = parseJson(await res.text());
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data: isJsonObject(data) ? data : {} };
}

// ─── Claude Code (~/.claude/.credentials.json) ───────────────────────

export function loadClaudeCodeCredential(credentialsPath?: string): LocalOAuthCredential {
  const file = credentialsPath ? expandHome(credentialsPath) : claudeCodeCredentialsPath();
  const data = readJsonFile(file, "claude-code", CLAUDE_CODE_LOGIN_HINT);
  const raw = data["claudeAiOauth"];
  if (!isJsonObject(raw)) throw notConfigured("claude-code", `Credentials file at ${file} has no claudeAiOauth section.`, CLAUDE_CODE_LOGIN_HINT);
  const access = raw["accessToken"];
  if (typeof access !== "string" || !access) throw notConfigured("claude-code", `Credentials file at ${file} has no access token.`, CLAUDE_CODE_LOGIN_HINT);
  const refresh = raw["refreshToken"];
  const expires = raw["expiresAt"];
  return new LocalOAuthCredential({
    accessToken: access,
    refreshToken: typeof refresh === "string" && refresh ? refresh : undefined,
    expiresAt: typeof expires === "number" ? Math.trunc(expires) : undefined,
  });
}

async function refreshClaudeCodeCredential(refreshToken: string): Promise<LocalOAuthCredential> {
  const payload = await postJson(CLAUDE_CODE_TOKEN_URL, { grant_type: "refresh_token", client_id: CLAUDE_CODE_CLIENT_ID, refresh_token: refreshToken });
  const access = payload["access_token"];
  const refresh = payload["refresh_token"];
  const expiresIn = payload["expires_in"];
  if (typeof access !== "string" || typeof refresh !== "string" || typeof expiresIn !== "number") {
    throw new Error("Claude Code token refresh response is missing required fields");
  }
  return new LocalOAuthCredential({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS });
}

function writeClaudeCodeCredentialUnlocked(credential: LocalOAuthCredential, file: string): void {
  const data = readJsonFileOrUndefined(file) ?? {};
  const current = isJsonObject(data["claudeAiOauth"]) ? { ...data["claudeAiOauth"] } : {};
  current["accessToken"] = credential.accessToken;
  if (credential.refreshToken) current["refreshToken"] = credential.refreshToken;
  if (credential.expiresAt !== undefined) current["expiresAt"] = credential.expiresAt;
  data["claudeAiOauth"] = current;
  writePrivateJsonAtomic(file, data);
}

/** A usable Claude Code access token, refreshing under the lock if expired (AUTH-3). */
export async function getClaudeCodeAccessToken(credentialsPath?: string, opts: { refresh?: boolean } = {}): Promise<string> {
  const file = credentialsPath ? expandHome(credentialsPath) : claudeCodeCredentialsPath();
  const credential = loadClaudeCodeCredential(file);
  if (!credential.expired) return credential.accessToken;
  const expiredError = () =>
    new AuthError("Claude Code OAuth token is expired and no refresh token is available.", { provider: "claude-code", credentialHint: CLAUDE_CODE_LOGIN_HINT });
  if (opts.refresh === false || !credential.refreshToken) throw expiredError();
  return withFileLock(file, async () => {
    const fresh = loadClaudeCodeCredential(file);
    if (!fresh.expired) return fresh.accessToken;
    if (!fresh.refreshToken) throw expiredError();
    let refreshed: LocalOAuthCredential;
    try {
      refreshed = await refreshClaudeCodeCredential(fresh.refreshToken);
    } catch (e) {
      throw new AuthError("Claude Code OAuth token is expired and the refresh attempt failed.", {
        provider: "claude-code",
        credentialHint: CLAUDE_CODE_LOGIN_HINT,
        cause: e,
      });
    }
    writeClaudeCodeCredentialUnlocked(refreshed, file);
    return refreshed.accessToken;
  });
}

// ─── OpenAI Codex CLI (~/.codex/auth.json) ───────────────────────────

export function loadCodexCliCredential(authPath?: string): LocalOAuthCredential {
  const file = authPath ? expandHome(authPath) : codexCliAuthPath();
  const data = readJsonFile(file, "openai-codex", OPENAI_CODEX_LOGIN_HINT);
  const tokens = data["tokens"];
  if (!isJsonObject(tokens)) throw notConfigured("openai-codex", `Credentials file at ${file} has no tokens section.`, OPENAI_CODEX_LOGIN_HINT);
  const access = tokens["access_token"];
  if (typeof access !== "string" || !access) throw notConfigured("openai-codex", `Credentials file at ${file} has no access token.`, OPENAI_CODEX_LOGIN_HINT);
  const refresh = tokens["refresh_token"];
  const accountId = (typeof tokens["account_id"] === "string" && tokens["account_id"]) || extractChatgptAccountId(access);
  return new LocalOAuthCredential({
    accessToken: access,
    refreshToken: typeof refresh === "string" && refresh ? refresh : undefined,
    expiresAt: jwtExpiresAtMs(access),
    accountId: accountId || undefined,
  });
}

async function refreshCodexCliCredential(refreshToken: string): Promise<LocalOAuthCredential> {
  const { ok, data } = await postForm(OPENAI_CODEX_TOKEN_URL, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: OPENAI_CODEX_CLIENT_ID });
  const access = data["access_token"];
  const refresh = typeof data["refresh_token"] === "string" && data["refresh_token"] ? data["refresh_token"] : refreshToken;
  if (!ok || typeof access !== "string") throw new Error("Codex token refresh response is missing required fields");
  return new LocalOAuthCredential({ accessToken: access, refreshToken: refresh, expiresAt: jwtExpiresAtMs(access), accountId: extractChatgptAccountId(access) });
}

function writeCodexCliCredentialUnlocked(credential: LocalOAuthCredential, file: string, idToken?: string): void {
  const data = readJsonFileOrUndefined(file) ?? {};
  const current = isJsonObject(data["tokens"]) ? { ...data["tokens"] } : {};
  current["access_token"] = credential.accessToken;
  if (credential.refreshToken) current["refresh_token"] = credential.refreshToken;
  if (credential.accountId) current["account_id"] = credential.accountId;
  if (idToken !== undefined) current["id_token"] = idToken;
  data["tokens"] = current;
  if (data["auth_mode"] === undefined) data["auth_mode"] = "chatgpt";
  data["last_refresh"] = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writePrivateJsonAtomic(file, data);
}

export async function getCodexCliCredential(authPath?: string, opts: { refresh?: boolean } = {}): Promise<LocalOAuthCredential> {
  const file = authPath ? expandHome(authPath) : codexCliAuthPath();
  const credential = loadCodexCliCredential(file);
  if (!credential.expired) return credential;
  const expiredError = () =>
    new AuthError("Codex CLI OAuth token is expired and no refresh token is available.", { provider: "openai-codex", credentialHint: OPENAI_CODEX_LOGIN_HINT });
  if (opts.refresh === false || !credential.refreshToken) throw expiredError();
  return withFileLock(file, async () => {
    const fresh = loadCodexCliCredential(file);
    if (!fresh.expired) return fresh;
    if (!fresh.refreshToken) throw expiredError();
    let refreshed: LocalOAuthCredential;
    try {
      refreshed = await refreshCodexCliCredential(fresh.refreshToken);
    } catch (e) {
      throw new AuthError("Codex CLI OAuth token is expired and the refresh attempt failed.", {
        provider: "openai-codex",
        credentialHint: OPENAI_CODEX_LOGIN_HINT,
        cause: e,
      });
    }
    const original = readJsonFileOrUndefined(file) ?? {};
    const tokens = isJsonObject(original["tokens"]) ? original["tokens"] : {};
    writeCodexCliCredentialUnlocked(refreshed, file, typeof tokens["id_token"] === "string" ? tokens["id_token"] : undefined);
    return refreshed;
  });
}

// ─── xAI (lm15 store or the Pi agent store) ──────────────────────────

function xaiStorePaths(): string[] {
  return [defaultCredentialsPath(), piAgentAuthPath()];
}

function xaiEntryToCredential(entry: unknown): LocalOAuthCredential | undefined {
  if (!isJsonObject(entry)) return undefined;
  const access = entry["access"];
  if (typeof access !== "string" || !access) return undefined;
  const refresh = entry["refresh"];
  const expires = entry["expires"];
  return new LocalOAuthCredential({
    accessToken: access,
    refreshToken: typeof refresh === "string" && refresh ? refresh : undefined,
    expiresAt: typeof expires === "number" && Number.isInteger(expires) ? expires : undefined,
  });
}

function xaiCredentialToEntry(credential: LocalOAuthCredential, current: JsonObject | undefined): JsonObject {
  const entry: JsonObject = { ...(current ?? {}) };
  entry["type"] = "oauth";
  entry["access"] = credential.accessToken;
  if (credential.refreshToken) entry["refresh"] = credential.refreshToken;
  if (credential.expiresAt !== undefined) entry["expires"] = credential.expiresAt;
  return entry;
}

function loadXaiWithSource(authPath?: string): [LocalOAuthCredential, string] {
  const paths = authPath ? [expandHome(authPath)] : xaiStorePaths();
  for (const file of paths) {
    const data = readJsonFileOrUndefined(file);
    const credential = data ? xaiEntryToCredential(data["xai"]) : undefined;
    if (credential) return [credential, file];
  }
  throw notConfigured("xai", `No xAI OAuth credential found (checked: ${paths.join(", ")}).`, XAI_LOGIN_HINT);
}

export function loadXaiCredential(authPath?: string): LocalOAuthCredential {
  return loadXaiWithSource(authPath)[0];
}

/** Offline probe (files only, never the network) for the router's `oauth-unless-explicit` chain. */
export function usableXaiCredential(authPath?: string): boolean {
  let credential: LocalOAuthCredential;
  try {
    credential = loadXaiCredential(authPath);
  } catch {
    return false;
  }
  return !credential.expired || Boolean(credential.refreshToken);
}

function xaiCredentialFromTokenResponse(payload: JsonObject, previousRefresh?: string): LocalOAuthCredential {
  const access = payload["access_token"];
  if (typeof access !== "string" || !access) throw new Error("xAI token response is missing access_token");
  const refresh = typeof payload["refresh_token"] === "string" && payload["refresh_token"] ? payload["refresh_token"] : previousRefresh;
  const expiresIn = payload["expires_in"];
  const lifetime = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : XAI_DEFAULT_TOKEN_LIFETIME_S;
  return new LocalOAuthCredential({ accessToken: access, refreshToken: refresh, expiresAt: Date.now() + lifetime * 1000 - REFRESH_SKEW_MS });
}

async function refreshXaiCredential(refreshToken: string): Promise<LocalOAuthCredential> {
  const { ok, data } = await postForm(XAI_TOKEN_URL, { grant_type: "refresh_token", client_id: XAI_CLIENT_ID, refresh_token: refreshToken });
  if (!ok) throw new Error(`xAI token refresh failed: ${String(data["error_description"] ?? data["error"] ?? "request failed")}`);
  return xaiCredentialFromTokenResponse(data, refreshToken);
}

/** The lm15-owned store: `{ "<provider>": {...} }` per file, mutated under the lock. */
export class CredentialFileStore {
  readonly path: string;

  constructor(file?: string) {
    this.path = file ? expandHome(file) : defaultCredentialsPath();
  }

  private readAll(): JsonObject {
    return readJsonFileOrUndefined(this.path) ?? {};
  }

  read(provider: string): JsonObject | undefined {
    const entry = this.readAll()[provider];
    return isJsonObject(entry) ? entry : undefined;
  }

  list(): string[] {
    return Object.keys(this.readAll()).sort();
  }

  async write(provider: string, credential: JsonObject): Promise<void> {
    await this.mutate(provider, () => credential);
  }

  async delete(provider: string): Promise<void> {
    await this.mutate(provider, () => undefined, { removeOnUndefined: true });
  }

  /** Read-modify-write under the lock; `fn` returns the new entry, or `undefined` to leave the file untouched. */
  async mutate(
    provider: string,
    fn: (current: JsonObject | undefined) => JsonObject | undefined | Promise<JsonObject | undefined>,
    opts: { removeOnUndefined?: boolean } = {},
  ): Promise<void> {
    await withFileLock(this.path, async () => {
      const all = this.readAll();
      const current = isJsonObject(all[provider]) ? all[provider] : undefined;
      const next = await fn(current);
      if (next === undefined) {
        if (!opts.removeOnUndefined) return;
        delete all[provider];
      } else all[provider] = next;
      writePrivateJsonAtomic(this.path, all);
    });
  }

  toString(): string {
    return `CredentialFileStore(${this.path})`;
  }
}

export async function writeXaiCredential(credential: LocalOAuthCredential, authPath?: string): Promise<void> {
  await new CredentialFileStore(authPath).mutate("xai", (current) => xaiCredentialToEntry(credential, current));
}

export async function getXaiAccessToken(authPath?: string, opts: { refresh?: boolean } = {}): Promise<string> {
  const [credential, source] = loadXaiWithSource(authPath);
  if (!credential.expired) return credential.accessToken;
  const expiredError = () => new AuthError("xAI OAuth token is expired and no refresh token is available.", { provider: "xai", credentialHint: XAI_LOGIN_HINT });
  if (opts.refresh === false || !credential.refreshToken) throw expiredError();
  let access: string | undefined;
  await new CredentialFileStore(source).mutate("xai", async (current) => {
    const fresh = xaiEntryToCredential(current);
    if (fresh && !fresh.expired) {
      access = fresh.accessToken;
      return undefined;
    }
    const refreshToken = fresh?.refreshToken ?? credential.refreshToken;
    if (!refreshToken) throw expiredError();
    let refreshed: LocalOAuthCredential;
    try {
      refreshed = await refreshXaiCredential(refreshToken);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("xAI OAuth token is expired and the refresh attempt failed.", { provider: "xai", credentialHint: XAI_LOGIN_HINT, cause: e });
    }
    access = refreshed.accessToken;
    return xaiCredentialToEntry(refreshed, current);
  });
  return access!;
}

// ─── AUTH-1: the credential an adapter sends under a policy ─────────

export type { LoadedCredential } from "../platform.ts";

const LOADERS: Record<string, (credentialsPath?: string) => LoadedCredential> = {
  "claude-code": (p) => {
    loadClaudeCodeCredential(p); // validate now; re-resolve per request so a long-lived client sends a fresh token
    return { credential: () => getClaudeCodeAccessToken(p), source: "stored" };
  },
  "openai-codex": (p) => {
    const initial = loadCodexCliCredential(p);
    const accountId = initial.accountId ?? extractChatgptAccountId(initial.accessToken);
    return {
      credential: async () => (await getCodexCliCredential(p)).accessToken,
      ...(accountId ? { accountId } : {}),
      source: "stored",
    };
  },
  xai: (p) => {
    loadXaiCredential(p);
    return { credential: () => getXaiAccessToken(p), source: "stored" };
  },
};

const STORED_PROBES: Record<string, () => boolean> = { xai: () => usableXaiCredential() };

function noCredential(policy: AccessPolicy): NotConfiguredError {
  return new NotConfiguredError(
    `${policy.provider}: no credential given` + (policy.envKeys.length > 0 ? `; set ${policy.envKeys.join(" or ")} or pass apiKey` : "; pass apiKey"),
    { provider: policy.provider, envKeys: policy.envKeys, credentialHint: policy.loginHint ?? null },
  );
}

/** AUTH-8 on Node: the stored login a policy names, re-read per request. The `StoredCredentials.load` of the Node platform. */
export function loadStoredCredential(policy: AccessPolicy, credentialsPath?: string): LoadedCredential {
  const loader = policy.credentialPolicy !== "key" ? LOADERS[policy.provider] : undefined;
  if (loader) return loader(credentialsPath);
  throw noCredential(policy);
}

/** An explicit key always wins (AUTH-1); a stored-login policy loads through its loader. */
export function loadCredential(policy: AccessPolicy, apiKey: CredentialLike | undefined, credentialsPath?: string): LoadedCredential {
  if (apiKey !== undefined && apiKey !== "") return { credential: apiKey, source: "explicit" };
  return loadStoredCredential(policy, credentialsPath);
}

/** Offline probe for the router's `oauth-unless-explicit` chain. */
export function hasStoredCredential(policy: AccessPolicy): boolean {
  const probe = STORED_PROBES[policy.provider];
  return probe ? probe() : false;
}

// ─── AUTH-9: the uniform login door ──────────────────────────────────

export interface XaiDeviceAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly intervalS: number;
  readonly expiresInS: number;
  readonly deviceCode: string;
}

function httpsOrRaise(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && u.host) return raw;
    } catch {
      // fall through
    }
  }
  throw new AuthError("xAI device authorization returned an untrusted verification URI.", { provider: "xai" });
}

export async function startXaiDeviceLogin(): Promise<XaiDeviceAuthorization> {
  const { ok, data } = await postForm(XAI_DEVICE_CODE_URL, { client_id: XAI_CLIENT_ID, scope: XAI_OAUTH_SCOPE, referrer: "lm15" });
  if (!ok) throw new AuthError(`xAI device authorization failed: ${String(data["error_description"] ?? data["error"] ?? "request failed")}`, { provider: "xai" });
  const deviceCode = data["device_code"];
  const userCode = data["user_code"];
  const expiresIn = data["expires_in"];
  if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode) {
    throw new AuthError("xAI device authorization response is missing required fields.", { provider: "xai" });
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) throw new AuthError("xAI device authorization response is missing expires_in.", { provider: "xai" });
  const interval = data["interval"];
  const complete = data["verification_uri_complete"];
  return {
    userCode,
    verificationUri: httpsOrRaise(data["verification_uri"]),
    ...(typeof complete === "string" && complete ? { verificationUriComplete: httpsOrRaise(complete) } : {}),
    intervalS: typeof interval === "number" && interval > 0 ? interval : 5,
    expiresInS: expiresIn,
    deviceCode,
  };
}

export class DeviceCodeExpiredError extends AuthError {}

/** RFC 8628 polling: `slow_down` grows the interval by 5 s unless the server names one; expiry is a typed error distinct from denial. */
export async function pollXaiDeviceLogin(device: XaiDeviceAuthorization, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<LocalOAuthCredential> {
  const wait = opts.sleep ?? sleep;
  let interval = device.intervalS;
  const deadline = Date.now() + device.expiresInS * 1000;
  for (;;) {
    await wait(interval * 1000);
    if (Date.now() >= deadline) throw new DeviceCodeExpiredError("xAI device code expired before it was approved.", { provider: "xai" });
    const { ok, data } = await postForm(XAI_TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_CLIENT_ID,
      device_code: device.deviceCode,
    });
    if (ok) return xaiCredentialFromTokenResponse(data);
    const error = data["error"];
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const named = data["interval"];
      interval = typeof named === "number" && named > 0 ? named : interval + 5;
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") throw new AuthError("xAI device authorization was denied.", { provider: "xai" });
    if (error === "expired_token") throw new DeviceCodeExpiredError("xAI device code expired before it was approved.", { provider: "xai" });
    throw new AuthError(`xAI device token polling failed: ${String(data["error_description"] ?? error ?? "request failed")}`, { provider: "xai" });
  }
}

/** Interactive device-code login; persists the credential and returns it. */
export async function loginXai(opts: { credentialsPath?: string; echo?: (line: string) => void } = {}): Promise<LocalOAuthCredential> {
  const device = await startXaiDeviceLogin();
  (opts.echo ?? console.log)(`Open ${device.verificationUriComplete ?? device.verificationUri} and enter code: ${device.userCode}`);
  const credential = await pollXaiDeviceLogin(device);
  await writeXaiCredential(credential, opts.credentialsPath);
  return credential;
}

const KEY_CONSOLE_URLS: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://platform.openai.com/api-keys",
  "openai-chat": "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com",
  gemini: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys",
  xai: "https://console.x.ai",
});
const CLI_LOGIN_HINTS: Readonly<Record<string, string>> = Object.freeze({ "claude-code": CLAUDE_CODE_LOGIN_HINT, "openai-codex": OPENAI_CODEX_LOGIN_HINT });
const KEYLESS_LOCAL_SERVERS = new Set(["ollama", "vllm", "sglang"]);

/** The uniform login door (AUTH-9): runs the flow lm15 owns (xai); fails typed, naming the real path, otherwise. */
export async function login(provider: string, opts: { credentialsPath?: string; echo?: (line: string) => void } = {}): Promise<LocalOAuthCredential> {
  const canonical = provider.replace(/_/g, "-");
  if (canonical === "xai") return loginXai(opts);
  if (canonical in CLI_LOGIN_HINTS) {
    throw new UnsupportedFeatureError(`lm15 does not own the '${canonical}' login flow — the provider CLI does. ${CLI_LOGIN_HINTS[canonical]}`, { provider: canonical });
  }
  if (KEYLESS_LOCAL_SERVERS.has(canonical)) {
    throw new UnsupportedFeatureError(`'${canonical}' is a keyless local server — there is nothing to log into. The router sends the placeholder key the server expects.`, {
      provider: canonical,
    });
  }
  if (canonical in KEY_CONSOLE_URLS) {
    throw new UnsupportedFeatureError(
      `'${canonical}' offers no OAuth login flow — only manually created API keys. Create one at ${KEY_CONSOLE_URLS[canonical]} and set it in the environment or RouterConfig.apiKeys.`,
      { provider: canonical },
    );
  }
  throw new UnsupportedFeatureError(`lm15 has no login flow for '${provider}'. Supply an API key via the environment or RouterConfig.apiKeys.`, { provider: canonical });
}

export { ApiKey, BearerToken };
export type { CredentialValue };
