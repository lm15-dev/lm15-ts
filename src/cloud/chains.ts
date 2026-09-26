/**
 * The three cloud credential chains (spec/auth.md AUTH-1 `aws-chain`,
 * `azure-chain`, `gcp-chain`) as data over the ten rung kinds (AUTH-11).
 * Every order, variable, path and endpoint is copied from the reference,
 * which cites the cloud SDKs' own resolver sources.
 *
 * - `explain(policy, ctx)` — the offline doctor walk (AUTH-7).
 * - `credentialProvider(policy, ctx)` — the AUTH-2 provider: resolves
 *   once, caches until the AUTH-3 skew window, re-resolves after.
 * - `tokenExchangeBuild` / `tokenExchangeParse` — the harness ops.
 *
 * Rungs declared but not implemented raise `NotConfiguredError` naming the
 * gap; they never fall through silently.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, NotConfiguredError } from "../errors.ts";
import { isJsonObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../json.ts";
import { ApiKey, AwsCredentials, BearerToken, CredentialSource, parseRfc3339, type CredentialValue, type NamedCredential, type SourcedCredentialProvider } from "../types/credential.ts";
import type { AccessPolicy } from "../auth/policy.ts";
import type { RungKind } from "../vocab.ts";
import { ValueError } from "../types/validate.ts";
import * as rs256 from "./rs256.ts";
import { sign as sigv4Sign } from "./sigv4.ts";
import { NAMED_RUNGS, namedMeaning, validateNamedCredential } from "./identity.ts";
import type { SettingFound } from "./hosts.ts";
export { NAMED_RUNGS, namedMeaning } from "./identity.ts";
export { CredentialSource } from "../types/credential.ts";

const SKEW_MS = 300_000;
const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GCP_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCP_STS_URL = "https://sts.googleapis.com/v1/token";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export type HttpFn = (method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined, timeoutS: number) => Promise<[number, Record<string, string>, Uint8Array]>;
export type RunFn = (argv: string[], timeoutS: number) => Promise<string>;

async function defaultHttp(method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined, timeoutS: number): Promise<[number, Record<string, string>, Uint8Array]> {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? (body as unknown as BodyInit) : null,
      redirect: "manual", // never forward credential headers or token bodies elsewhere
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
    return [res.status, out, new Uint8Array(await res.arrayBuffer())];
  } catch {
    throw new AuthError("credential HTTP request failed");
  }
}

async function defaultRun(argv: string[], timeoutS: number, env: Record<string, string>): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutS * 1000, env, encoding: "utf-8" }, (err, stdout) => {
      if (err) {
        const code = (err as { code?: number | string }).code;
        reject(typeof code === "number" ? new AuthError(`credential command exited ${code}`) : new AuthError("credential command failed"));
      } else resolve(stdout);
    });
  });
}

/** What a chain reads. `http`/`run` absent = offline (the doctor). `files` overrides the filesystem for the harness. */
export class ChainContext {
  env: Record<string, string>;
  home: string;
  files: Record<string, string> | undefined;
  http: HttpFn | undefined;
  run: RunFn | undefined;
  now: () => Date;
  settings: Record<string, string>;

  constructor(fields: {
    env: Record<string, string>;
    home?: string | undefined;
    files?: Record<string, string> | undefined;
    http?: HttpFn | undefined;
    run?: RunFn | undefined;
    now?: (() => Date) | undefined;
    settings?: Record<string, string> | undefined;
  }) {
    this.env = fields.env;
    this.home = fields.home ?? (fields.env["HOME"] || os.homedir());
    this.files = fields.files;
    this.http = fields.http;
    this.run = fields.run;
    this.now = fields.now ?? (() => new Date());
    this.settings = fields.settings ?? {};
  }

  static online(env?: Readonly<Record<string, string | undefined>>, extra: { now?: () => Date; home?: string } = {}): ChainContext {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(env ?? process.env)) if (v !== undefined) values[k] = v;
    return new ChainContext({ env: values, http: defaultHttp, run: (argv, t) => defaultRun(argv, t, values), ...extra });
  }

  path(text: string): string {
    if (text.startsWith("~")) return path.join(this.home, text.slice(1).replace(/^[/\\]+/, ""));
    return text;
  }

  read(text: string): string | undefined {
    if (this.files !== undefined) {
      const target = this.path(text);
      for (const [key, content] of Object.entries(this.files)) if (this.path(key) === target) return content;
      return undefined;
    }
    try {
      return readFileSync(this.path(text), "utf-8");
    } catch {
      return undefined;
    }
  }

  exists(text: string): boolean {
    return this.read(text) !== undefined;
  }

  /** Where `command` would run from, from the context's PATH only — an offline check. */
  onPath(command: string): string | undefined {
    if (command.includes("/") || command.includes("\\")) return this.exists(command) ? command : undefined;
    const p = this.env["PATH"] ?? "";
    for (const dir of p.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = `${dir.replace(/\/+$/, "")}/${command}`;
      if (this.files !== undefined ? this.exists(candidate) : existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  get offline(): boolean {
    return this.http === undefined;
  }
}

export interface Rung {
  /** The fixture kind: `env:AWS_REGION`, `assume-role`, `imds`, … */
  readonly name: string;
  readonly kind: RungKind;
  readonly source: string;
  readonly needs: "" | "network" | "subprocess";
  readonly probe: (ctx: ChainContext) => [Verdict, string];
  readonly acquire: (ctx: ChainContext) => Promise<CredentialValue | undefined>;
}

type Verdict = "usable" | "configured" | "absent";

export interface Step {
  readonly kind: string;
  readonly source: string;
  readonly detail: string;
  readonly state: "selected" | "shadowed" | "absent" | "unprobed";
}

// ─── Helpers ─────────────────────────────────────────────────────────

function expiresFrom(now: Date, seconds: unknown): Date | undefined {
  const n = Number(typeof seconds === "object" && seconds !== null && "raw" in seconds ? (seconds as { raw: string }).raw : seconds);
  if (!Number.isFinite(n)) return undefined;
  return new Date(now.getTime() + Math.trunc(n) * 1000);
}

function jsonBody(body: Uint8Array | string): JsonObject {
  try {
    const data = parseJson(typeof body === "string" ? body : new TextDecoder().decode(body));
    return isJsonObject(data) ? data : {};
  } catch {
    return {};
  }
}

function form(pairs: Array<[string, string]>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(pairs).toString());
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "raw" in (v as object)) return (v as { raw: string }).raw;
  return String(v);
}

// AUTH-21 (clarified 2026-09-24): from a failed auth-endpoint exchange only
// the status and, when the reply's `error` (or `error.code`/`error.type`) is
// one of these fixed words, that word. An error description can reflect the
// request (a refresh token, a signed assertion); a fixed word cannot.
const OAUTH_ERROR_WORDS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
  "invalid_scope", "access_denied", "server_error", "temporarily_unavailable", "authorization_pending",
  "slow_down", "expired_token",
]);

function oauthErrorWord(data: JsonObject): string | undefined {
  const err = data["error"];
  const candidates = isJsonObject(err) ? [err["code"], err["type"]] : [err];
  for (const value of candidates) if (typeof value === "string" && OAUTH_ERROR_WORDS.has(value)) return value;
  return undefined;
}

/**
 * One token-endpoint round trip. A refusal carries the status, a fixed OAuth
 * word (AUTH-21), and, when the caller knows it, the one action that fixes it.
 */
async function exchange(ctx: ChainContext, method: string, url: string, headers: Record<string, string>, body: Uint8Array | undefined, what: string, hint?: string): Promise<JsonObject> {
  const [status, , raw] = await ctx.http!(method, url, headers, body, 30);
  const data = jsonBody(raw);
  if (!(status >= 200 && status < 300)) {
    const word = oauthErrorWord(data);
    throw new AuthError(`${what}: HTTP ${status}${word ? ` (${word})` : ""}`, { credentialHint: hint ?? null, providerCode: word ?? null });
  }
  return data;
}

function bearerFromOauth(data: JsonObject, now: Date, what: string): BearerToken {
  const token = data["access_token"];
  if (typeof token !== "string" || !token) throw new AuthError(`${what}: no valid access_token in response`);
  let expires: Date | undefined;
  const on = data["expires_on"];
  if (on !== null && on !== undefined && on !== "") {
    const n = Number(str(on));
    if (Number.isFinite(n)) expires = new Date(Math.trunc(n) * 1000);
  }
  const inS = data["expires_in"];
  if (expires === undefined && inS !== null && inS !== undefined && inS !== "") expires = expiresFrom(now, inS);
  return new BearerToken(token, expires);
}

// ─── INI (configparser semantics: lowercase keys, no interpolation) ─────

type Ini = Map<string, Map<string, string>>;

function parseIni(text: string): Ini {
  const out: Ini = new Map();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const section = /^\[(.+)\]\s*$/.exec(line);
    if (section) {
      current = new Map();
      out.set(section[1]!.trim(), current);
      continue;
    }
    if (current === undefined) throw new NotConfiguredError("malformed AWS profile configuration; check the AWS config and credentials files");
    if (/^\s/.test(rawLine)) continue; // continuation / nested (sso-session bodies are flat; nested s3 blocks are ignored)
    const m = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) throw new NotConfiguredError("malformed AWS profile configuration; check the AWS config and credentials files");
    current.set(m[1]!.trim().toLowerCase(), m[2]!.trim());
  }
  return out;
}

function section(ini: Ini, name: string): Map<string, string> {
  return ini.get(name) ?? new Map();
}

// ─── AWS ─────────────────────────────────────────────────────────────

function awsConfig(ctx: ChainContext): [Ini, Ini, string] {
  const profile = ctx.env["AWS_PROFILE"] || "default";
  const credsText = ctx.read(ctx.env["AWS_SHARED_CREDENTIALS_FILE"] || "~/.aws/credentials");
  const confText = ctx.read(ctx.env["AWS_CONFIG_FILE"] || "~/.aws/config");
  return [credsText ? parseIni(credsText) : new Map(), confText ? parseIni(confText) : new Map(), profile];
}

function awsProfileSection(conf: Ini, profile: string): Map<string, string> {
  const name = profile === "default" ? "default" : `profile ${profile}`;
  if (conf.has(name)) return conf.get(name)!;
  if (conf.has(profile)) return conf.get(profile)!;
  return new Map();
}

function awsStatic(sec: Map<string, string>): AwsCredentials | undefined {
  const key = sec.get("aws_access_key_id");
  const secret = sec.get("aws_secret_access_key");
  if (!key || !secret) return undefined;
  return new AwsCredentials({ accessKeyId: key, secretAccessKey: secret, sessionToken: sec.get("aws_session_token") || undefined });
}

function awsFromResponse(d: JsonObject): AwsCredentials {
  let expires: Date | undefined;
  const raw = d["Expiration"] ?? d["expiration"];
  if (typeof raw === "string") expires = parseRfc3339(raw);
  else if (typeof raw === "number") expires = new Date(raw > 1e11 ? raw : raw * 1000);
  const key = d["AccessKeyId"] ?? d["accessKeyId"];
  const secret = d["SecretAccessKey"] ?? d["secretAccessKey"];
  if (typeof key !== "string" || !key || typeof secret !== "string" || !secret) throw new AuthError("AWS credential response lacks access key id or secret access key");
  const token = d["SessionToken"] ?? d["Token"] ?? d["sessionToken"];
  return new AwsCredentials({ accessKeyId: key, secretAccessKey: secret, sessionToken: typeof token === "string" && token ? token : undefined, expiresAt: expires });
}

function stsXmlCredentials(raw: Uint8Array): AwsCredentials {
  const text = new TextDecoder().decode(raw);
  const get = (tag: string) => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text);
    return m ? m[1]!.trim() : "";
  };
  if (!text.includes("<Credentials>")) throw new AuthError("STS: no Credentials in response");
  const expiration = get("Expiration");
  return new AwsCredentials({
    accessKeyId: get("AccessKeyId"),
    secretAccessKey: get("SecretAccessKey"),
    sessionToken: get("SessionToken") || undefined,
    expiresAt: expiration ? parseRfc3339(expiration) : undefined,
  });
}

function envAws(ctx: ChainContext): AwsCredentials | undefined {
  const key = ctx.env["AWS_ACCESS_KEY_ID"];
  const secret = ctx.env["AWS_SECRET_ACCESS_KEY"];
  if (key && secret) return new AwsCredentials({ accessKeyId: key, secretAccessKey: secret, sessionToken: ctx.env["AWS_SESSION_TOKEN"] || undefined });
  return undefined;
}

async function awsSourceCredentials(ctx: ChainContext, sec: Map<string, string>, depth = 0): Promise<AwsCredentials> {
  if (depth > 5) throw new AuthError("assume-role: source_profile chain too deep");
  const sourceProfile = sec.get("source_profile");
  if (sourceProfile) {
    const [creds, conf] = awsConfig(ctx);
    const sub = new Map(awsProfileSection(conf, sourceProfile));
    for (const [k, v] of creds.get(sourceProfile) ?? []) sub.set(k, v);
    if (sub.get("role_arn")) return assumeRole(ctx, sub, depth + 1);
    const st = awsStatic(sub);
    if (!st) throw new NotConfiguredError(`assume-role: source_profile '${sourceProfile}' has no keys`);
    return st;
  }
  const source = sec.get("credential_source");
  if (source === "Environment") {
    const st = envAws(ctx);
    if (!st) throw new NotConfiguredError("assume-role: credential_source=Environment but AWS_ACCESS_KEY_ID is not set");
    return st;
  }
  if (source === "EcsContainer") {
    const got = await containerAcquire(ctx);
    if (!got) throw new NotConfiguredError("assume-role: credential_source=EcsContainer but no container endpoint is configured");
    return got;
  }
  if (source === "Ec2InstanceMetadata") {
    const got = await imdsAcquire(ctx);
    if (!got) throw new NotConfiguredError("assume-role: credential_source=Ec2InstanceMetadata but IMDS answered nothing");
    return got;
  }
  throw new NotConfiguredError("assume-role: profile needs source_profile or credential_source");
}

async function assumeRole(ctx: ChainContext, sec: Map<string, string>, depth = 0): Promise<AwsCredentials> {
  const source = await awsSourceCredentials(ctx, sec, depth);
  const region = ctx.settings["region"] || ctx.env["AWS_REGION"] || ctx.env["AWS_DEFAULT_REGION"] || sec.get("region") || "us-east-1";
  const url = `https://sts.${region}.amazonaws.com/`;
  const pairs: Array<[string, string]> = [
    ["Action", "AssumeRole"],
    ["Version", "2011-06-15"],
    ["RoleArn", sec.get("role_arn")!],
    ["RoleSessionName", sec.get("role_session_name") || `lm15-${randomUUID().replace(/-/g, "").slice(0, 12)}`],
  ];
  if (sec.get("external_id")) pairs.push(["ExternalId", sec.get("external_id")!]);
  if (sec.get("duration_seconds")) pairs.push(["DurationSeconds", sec.get("duration_seconds")!]);
  const body = form(pairs);
  const signed = sigv4Sign({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: body, credentials: source, region, service: "sts", now: ctx.now() });
  const [status, , raw] = await ctx.http!("POST", url, { ...signed.headers }, body, 30);
  if (status >= 400) throw new AuthError(`STS AssumeRole: HTTP ${status}`);
  return stsXmlCredentials(raw);
}

function webIdentityConfig(ctx: ChainContext): [string, string, string] | undefined {
  let tokenFile = ctx.env["AWS_WEB_IDENTITY_TOKEN_FILE"];
  let role = ctx.env["AWS_ROLE_ARN"];
  let session = ctx.env["AWS_ROLE_SESSION_NAME"] || "";
  if (!(tokenFile && role)) {
    const [, conf, profile] = awsConfig(ctx);
    const sec = awsProfileSection(conf, profile);
    tokenFile = sec.get("web_identity_token_file");
    role = sec.get("role_arn");
    session = sec.get("role_session_name") || "";
    if (!(tokenFile && role && !sec.get("source_profile") && !sec.get("credential_source"))) return undefined;
  }
  return [tokenFile, role, session];
}

async function webIdentityAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  const cfg = webIdentityConfig(ctx);
  if (!cfg) return undefined;
  const [tokenFile, role, session] = cfg;
  const token = ctx.read(tokenFile);
  if (token === undefined) throw new NotConfiguredError(`web identity token file ${tokenFile} is unreadable`);
  const region = ctx.settings["region"] || ctx.env["AWS_REGION"] || ctx.env["AWS_DEFAULT_REGION"] || "us-east-1";
  const body = form([
    ["Action", "AssumeRoleWithWebIdentity"],
    ["Version", "2011-06-15"],
    ["RoleArn", role],
    ["RoleSessionName", session || `lm15-${randomUUID().replace(/-/g, "").slice(0, 12)}`],
    ["WebIdentityToken", token.trim()],
  ]);
  const [status, , raw] = await ctx.http!("POST", `https://sts.${region}.amazonaws.com/`, { "content-type": "application/x-www-form-urlencoded" }, body, 30);
  if (status >= 400) throw new AuthError(`STS AssumeRoleWithWebIdentity: HTTP ${status}`);
  return stsXmlCredentials(raw);
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf-8").digest("hex");
}

function ssoConfig(ctx: ChainContext): Map<string, string> | undefined {
  const [, conf, profile] = awsConfig(ctx);
  const sec = new Map(awsProfileSection(conf, profile));
  if (sec.get("sso_session")) {
    const name = sec.get("sso_session")!;
    const sess = conf.get(`sso-session ${name}`) ?? new Map();
    if (!sess.get("sso_start_url")) return undefined;
    const merged = new Map([...sess, ...sec]);
    merged.set("cache_key", sha1Hex(name));
    merged.set("session_name", name);
    return merged;
  }
  if (sec.get("sso_start_url")) {
    sec.set("cache_key", sha1Hex(sec.get("sso_start_url")!));
    return sec;
  }
  return undefined;
}

async function ssoAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  const cfg = ssoConfig(ctx);
  if (!cfg) return undefined;
  const raw = ctx.read(`~/.aws/sso/cache/${cfg.get("cache_key")}.json`);
  if (raw === undefined) throw new NotConfiguredError("IAM Identity Center: no cached token; run `aws sso login`", { credentialHint: "aws sso login" });
  const token = jsonBody(raw);
  const now = ctx.now();
  const expires = token["expiresAt"] ? parseRfc3339(str(token["expiresAt"])) : undefined;
  let access = token["accessToken"];
  const ssoRegion = cfg.get("sso_region") || "us-east-1";
  if (!access || (expires !== undefined && expires.getTime() - now.getTime() <= SKEW_MS)) {
    if (!(token["refreshToken"] && token["clientId"] && token["clientSecret"])) {
      throw new NotConfiguredError("IAM Identity Center: token expired and not refreshable; run `aws sso login`", { credentialHint: "aws sso login" });
    }
    const data = await exchange(
      ctx,
      "POST",
      `https://oidc.${ssoRegion}.amazonaws.com/token`,
      { "content-type": "application/json" },
      new TextEncoder().encode(stringifyJson({ clientId: token["clientId"], clientSecret: token["clientSecret"], grantType: "refresh_token", refreshToken: token["refreshToken"] })),
      "sso-oidc CreateToken",
    );
    access = data["accessToken"];
    if (!access) throw new AuthError("sso-oidc CreateToken: no accessToken");
  }
  const account = cfg.get("sso_account_id");
  const role = cfg.get("sso_role_name");
  if (!(account && role)) throw new NotConfiguredError("IAM Identity Center: profile needs sso_account_id and sso_role_name");
  const query = new URLSearchParams({ role_name: role, account_id: account }).toString();
  const [status, , rawCreds] = await ctx.http!("GET", `https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials?${query}`, { "x-amz-sso_bearer_token": str(access) }, undefined, 30);
  if (status >= 400) throw new AuthError(`sso GetRoleCredentials: HTTP ${status}`);
  const creds = jsonBody(rawCreds)["roleCredentials"];
  return awsFromResponse(isJsonObject(creds) ? creds : {});
}

function loginConfig(ctx: ChainContext): string | undefined {
  const [, conf, profile] = awsConfig(ctx);
  return awsProfileSection(conf, profile).get("login_session") || undefined;
}

function loginCached(ctx: ChainContext): AwsCredentials | undefined {
  const session = loginConfig(ctx);
  if (!session) return undefined;
  const directory = ctx.env["AWS_LOGIN_CACHE_DIRECTORY"] || "~/.aws/login/cache";
  const raw = ctx.read(`${directory}/${createHash("sha256").update(session, "utf-8").digest("hex")}.json`);
  if (raw === undefined) return undefined;
  const token = jsonBody(raw)["accessToken"];
  if (!isJsonObject(token) || !token["accessKeyId"]) return undefined;
  return awsFromResponse({ AccessKeyId: token["accessKeyId"]!, SecretAccessKey: token["secretAccessKey"] ?? null, SessionToken: token["sessionToken"] ?? null, Expiration: token["expiresAt"] ?? null });
}

async function loginAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  if (loginConfig(ctx) === undefined) return undefined;
  const cached = loginCached(ctx);
  if (cached && !cached.isExpired(ctx.now())) return cached;
  throw new NotConfiguredError("AWS login session expired; run `aws login`", { credentialHint: "aws login" });
}

function shellSplit(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

async function processAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  const [, conf, profile] = awsConfig(ctx);
  const command = awsProfileSection(conf, profile).get("credential_process");
  if (!command || !ctx.run) return undefined;
  const data = jsonBody(await ctx.run(shellSplit(command), 60));
  if (data["Version"] !== 1) throw new AuthError("credential_process: output Version must be 1");
  return awsFromResponse(data);
}

const CONTAINER_ALLOWED = new Set(["169.254.170.2", "169.254.170.23", "fd00:ec2::23", "localhost"]);

function containerConfig(ctx: ChainContext): string | undefined {
  const rel = ctx.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  const full = ctx.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  if (rel) {
    if (!rel.startsWith("/") || rel.startsWith("//") || /[\\\r\n\t#]/.test(rel)) throw new NotConfiguredError("container credentials relative URI must be an absolute path");
    return `http://169.254.170.2${rel}`;
  }
  if (full) {
    let parsed: URL;
    try {
      parsed = new URL(full);
    } catch {
      throw new NotConfiguredError("container credentials URI must be HTTP(S), without userinfo or fragment");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(parsed.protocol) || !host || parsed.username || parsed.hash) {
      throw new NotConfiguredError("container credentials URI must be HTTP(S), without userinfo or fragment");
    }
    const loopback = host === "127.0.0.1" || host === "::1" || /^127\./.test(host);
    if (parsed.protocol !== "https:" && !loopback && !CONTAINER_ALLOWED.has(host)) {
      throw new NotConfiguredError(`Unsupported host '${host}'. Can only retrieve metadata from a loopback address or one of these hosts: ${[...CONTAINER_ALLOWED].sort().join(", ")}`);
    }
    return full;
  }
  return undefined;
}

async function containerAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  const url = containerConfig(ctx);
  if (!url || !ctx.http) return undefined;
  const headers: Record<string, string> = {};
  let token = ctx.env["AWS_CONTAINER_AUTHORIZATION_TOKEN"];
  const tokenFile = ctx.env["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"];
  if (tokenFile && !token) token = (ctx.read(tokenFile) ?? "").trim();
  if (token) headers["Authorization"] = token;
  const [status, , raw] = await ctx.http("GET", url, headers, undefined, 5);
  if (status >= 400) throw new AuthError(`container credentials: HTTP ${status}`);
  return awsFromResponse(jsonBody(raw));
}

function imdsDisabled(ctx: ChainContext): boolean {
  return (ctx.env["AWS_EC2_METADATA_DISABLED"] ?? "").trim().toLowerCase() === "true";
}

async function imdsAcquire(ctx: ChainContext): Promise<AwsCredentials | undefined> {
  if (imdsDisabled(ctx) || !ctx.http) return undefined;
  const base = (ctx.env["AWS_EC2_METADATA_SERVICE_ENDPOINT"] || ((ctx.env["AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE"] ?? "").toLowerCase() === "ipv6" ? "http://[fd00:ec2::254]" : "http://169.254.169.254")).replace(/\/+$/, "");
  let tokenStatus: number;
  let tok: Uint8Array;
  try {
    [tokenStatus, , tok] = await ctx.http("PUT", `${base}/latest/api/token`, { "X-aws-ec2-metadata-token-ttl-seconds": "21600" }, undefined, 1);
  } catch {
    return undefined; // not on EC2: absent, not an error
  }
  if (tokenStatus !== 200) return undefined;
  const headers = { "X-aws-ec2-metadata-token": new TextDecoder().decode(tok) };
  const [roleStatus, , role] = await ctx.http("GET", `${base}/latest/meta-data/iam/security-credentials/`, headers, undefined, 1);
  const roleName = new TextDecoder().decode(role).trim().split(/\r?\n/)[0] ?? "";
  if (roleStatus !== 200 || !roleName) return undefined;
  const [status, , raw] = await ctx.http("GET", `${base}/latest/meta-data/iam/security-credentials/${roleName}`, headers, undefined, 1);
  if (status !== 200) return undefined;
  const data = jsonBody(raw);
  if (data["Code"] !== undefined && data["Code"] !== null && data["Code"] !== "Success") throw new AuthError("IMDS rejected the credential request");
  return awsFromResponse(data);
}

const rung = (name: string, kind: RungKind, source: string, needs: Rung["needs"], probe: Rung["probe"], acquire: Rung["acquire"]): Rung => ({ name, kind, source, needs, probe, acquire });

function envRung(door: string, cls: typeof ApiKey | typeof BearerToken): Rung {
  return rung(
    `env:${door}`,
    "env",
    `env $${door}`,
    "",
    (ctx) => (ctx.env[door] ? ["usable", "set (value never shown)"] : ["absent", "not set"]),
    async (ctx) => (ctx.env[door] ? new cls(ctx.env[door]!) : undefined),
  );
}

function awsChain(policy: AccessPolicy): Rung[] {
  const door = policy.envKeys[0];
  const rungs: Rung[] = [];
  if (door) rungs.push(envRung(door, door === "AWS_BEARER_TOKEN_BEDROCK" ? BearerToken : ApiKey));
  rungs.push(
    rung("env:AWS_ACCESS_KEY_ID", "env", "env $AWS_ACCESS_KEY_ID (+SECRET, +SESSION_TOKEN)", "", (ctx) => (envAws(ctx) ? ["usable", "set (values never shown)"] : ["absent", "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set"]), async (ctx) => envAws(ctx)),
    rung(
      "assume-role",
      "sigv4-sts",
      "profile assume-role via STS",
      "network",
      (ctx) => {
        const [, conf, profile] = awsConfig(ctx);
        const sec = awsProfileSection(conf, profile);
        if (sec.get("role_arn") && (sec.get("source_profile") || sec.get("credential_source"))) return ["configured", `profile '${profile}' assumes ${sec.get("role_arn")} (STS call at request time)`];
        return ["absent", `profile '${profile}' has no role_arn with a source`];
      },
      async (ctx) => {
        const [, conf, profile] = awsConfig(ctx);
        const sec = awsProfileSection(conf, profile);
        if (sec.get("role_arn") && (sec.get("source_profile") || sec.get("credential_source"))) return assumeRole(ctx, sec);
        return undefined;
      },
    ),
    rung(
      "web-identity",
      "unsigned-sts",
      "web identity via STS",
      "network",
      (ctx) => {
        const cfg = webIdentityConfig(ctx);
        return cfg ? ["configured", `token file ${cfg[0]} → ${cfg[1]} (STS call at request time)`] : ["absent", "AWS_WEB_IDENTITY_TOKEN_FILE / AWS_ROLE_ARN not set"];
      },
      webIdentityAcquire,
    ),
    rung(
      "sso",
      "file-cache",
      "IAM Identity Center (~/.aws/sso/cache)",
      "network",
      (ctx) => {
        const cfg = ssoConfig(ctx);
        if (!cfg) return ["absent", "no sso_session / sso_start_url in the profile"];
        const cached = ctx.exists(`~/.aws/sso/cache/${cfg.get("cache_key")}.json`);
        return ["configured", cached ? "cached token present (GetRoleCredentials at request time)" : "no cached token; run `aws sso login`"];
      },
      ssoAcquire,
    ),
    rung(
      "shared-credentials-file",
      "ini-profile",
      "~/.aws/credentials",
      "",
      (ctx) => {
        const [creds, , profile] = awsConfig(ctx);
        return awsStatic(section(creds, profile)) ? ["usable", `profile '${profile}' (values never shown)`] : ["absent", `no keys for profile '${profile}'`];
      },
      async (ctx) => {
        const [creds, , profile] = awsConfig(ctx);
        return creds.has(profile) ? awsStatic(creds.get(profile)!) : undefined;
      },
    ),
    rung(
      "login",
      "file-cache",
      "aws login session (~/.aws/login/cache)",
      "",
      (ctx) => {
        if (loginConfig(ctx) === undefined) return ["absent", "no login_session in the profile"];
        const cached = loginCached(ctx);
        if (cached && !cached.isExpired(ctx.now())) return ["usable", "cached short-term credentials are fresh"];
        return ["configured", "cached credentials missing or expired; refresh needs `aws login`"];
      },
      loginAcquire,
    ),
    rung(
      "credential_process",
      "subprocess",
      "profile credential_process",
      "subprocess",
      (ctx) => {
        const [, conf, profile] = awsConfig(ctx);
        const cmd = awsProfileSection(conf, profile).get("credential_process");
        if (!cmd) return ["absent", "no credential_process in the profile"];
        const executable = shellSplit(cmd)[0] ?? "";
        if (ctx.onPath(executable) === undefined) return ["absent", `credential_process '${executable}' is not on PATH`];
        return ["configured", "credential_process configured (run at request time)"];
      },
      processAcquire,
    ),
    rung(
      "config-file",
      "ini-profile",
      "~/.aws/config static keys",
      "",
      (ctx) => {
        const [, conf, profile] = awsConfig(ctx);
        return awsStatic(awsProfileSection(conf, profile)) ? ["usable", `static keys in config for profile '${profile}'`] : ["absent", "no static keys in config"];
      },
      async (ctx) => {
        const [, conf, profile] = awsConfig(ctx);
        return awsStatic(awsProfileSection(conf, profile));
      },
    ),
    rung(
      "container",
      "http-metadata",
      "container credentials endpoint",
      "network",
      (ctx) => {
        let url: string | undefined;
        try {
          url = containerConfig(ctx);
        } catch (e) {
          return ["absent", String((e as Error).message).split("\n")[0]!];
        }
        return url ? ["configured", "container endpoint configured (HTTP at request time)"] : ["absent", "no AWS_CONTAINER_CREDENTIALS_* URI"];
      },
      containerAcquire,
    ),
    rung("imds", "http-metadata", "EC2 instance metadata (IMDSv2)", "network", (ctx) => (imdsDisabled(ctx) ? ["absent", "AWS_EC2_METADATA_DISABLED=true"] : ["configured", "instance metadata probed at request time"]), imdsAcquire),
  );
  return rungs;
}

// ─── Azure ───────────────────────────────────────────────────────────

function azureAuthority(ctx: ChainContext): string {
  return (ctx.settings["authority_host"] || ctx.env["AZURE_AUTHORITY_HOST"] || "https://login.microsoftonline.com").replace(/\/+$/, "");
}
function azureScope(ctx: ChainContext): string {
  return ctx.settings["scope"] || "https://ai.azure.com/.default";
}
function azureTokenUrl(ctx: ChainContext, tenant: string): string {
  return `${azureAuthority(ctx)}/${tenant}/oauth2/v2.0/token`;
}

/** The Entra client assertion: RS256, `x5t` = base64url SHA-1 of the DER cert, MSAL's claim order, 600 s lifetime. */
export function azureCertificateAssertion(ctx: ChainContext, tenant: string, clientId: string, pem: string, opts: { jti?: string | undefined; sendChain?: boolean | undefined } = {}): string {
  const key = rs256.loadPrivateKey(pem);
  const der = rs256.certificateDer(pem);
  const now = Math.floor(ctx.now().getTime() / 1000);
  const header: JsonObject = { alg: "RS256", typ: "JWT", x5t: rs256.b64url(createHash("sha1").update(der).digest()) };
  if (opts.sendChain) header["x5c"] = [der.toString("base64")];
  const payload: JsonObject = { aud: azureTokenUrl(ctx, tenant), iss: clientId, sub: clientId, exp: now + 600, iat: now, jti: opts.jti ?? randomUUID() };
  return rs256.jwtEncode(header, payload, key);
}

function azureEnvironmentKind(ctx: ChainContext): "secret" | "certificate" | undefined {
  const e = ctx.env;
  if (!(e["AZURE_TENANT_ID"] && e["AZURE_CLIENT_ID"])) return undefined;
  if (e["AZURE_CLIENT_SECRET"]) return "secret";
  if (e["AZURE_CLIENT_CERTIFICATE_PATH"]) return "certificate";
  return undefined;
}

/** `[token URL, form pairs]` for the environment service principal. */
export function azureEnvironmentRequest(ctx: ChainContext, opts: { jti?: string | undefined } = {}): [string, Array<[string, string]>] {
  const e = ctx.env;
  const kind = azureEnvironmentKind(ctx);
  const tenant = e["AZURE_TENANT_ID"]!;
  const client = e["AZURE_CLIENT_ID"]!;
  const url = azureTokenUrl(ctx, tenant);
  const scope = azureScope(ctx);
  if (kind === "secret") return [url, [["client_id", client], ["scope", scope], ["client_secret", e["AZURE_CLIENT_SECRET"]!], ["grant_type", "client_credentials"]]];
  if (kind === "certificate") {
    const pem = ctx.read(e["AZURE_CLIENT_CERTIFICATE_PATH"]!);
    if (pem === undefined) throw new NotConfiguredError(`AZURE_CLIENT_CERTIFICATE_PATH ${e["AZURE_CLIENT_CERTIFICATE_PATH"]} is unreadable`);
    if (e["AZURE_CLIENT_CERTIFICATE_PASSWORD"]) {
      throw new NotConfiguredError("password-protected certificates are not supported; decrypt with `openssl pkey`", { credentialHint: "openssl pkey -in cert.pem -out cert-plain.pem" });
    }
    const sendChain = ["1", "true"].includes((e["AZURE_CLIENT_SEND_CERTIFICATE_CHAIN"] ?? "").toLowerCase());
    const assertion = azureCertificateAssertion(ctx, tenant, client, pem, { jti: opts.jti, sendChain });
    return [url, [["client_id", client], ["scope", scope], ["client_assertion_type", CLIENT_ASSERTION_TYPE], ["client_assertion", assertion], ["grant_type", "client_credentials"]]];
  }
  throw new NotConfiguredError("Azure environment credential needs AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH");
}

async function azureEnvironmentAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (azureEnvironmentKind(ctx) === undefined) return undefined;
  const [url, pairs] = azureEnvironmentRequest(ctx);
  const data = await exchange(ctx, "POST", url, { "content-type": "application/x-www-form-urlencoded" }, form(pairs), "Entra client credentials");
  return bearerFromOauth(data, ctx.now(), "Entra");
}

function azureWorkloadConfig(ctx: ChainContext): boolean {
  const e = ctx.env;
  return Boolean(e["AZURE_FEDERATED_TOKEN_FILE"] && e["AZURE_CLIENT_ID"] && e["AZURE_TENANT_ID"]);
}

async function azureWorkloadAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!azureWorkloadConfig(ctx)) return undefined;
  const e = ctx.env;
  const token = ctx.read(e["AZURE_FEDERATED_TOKEN_FILE"]!);
  if (token === undefined) throw new NotConfiguredError(`AZURE_FEDERATED_TOKEN_FILE ${e["AZURE_FEDERATED_TOKEN_FILE"]} is unreadable`);
  const pairs: Array<[string, string]> = [
    ["client_id", e["AZURE_CLIENT_ID"]!],
    ["scope", azureScope(ctx)],
    ["client_assertion_type", CLIENT_ASSERTION_TYPE],
    ["client_assertion", token.trim()],
    ["grant_type", "client_credentials"],
  ];
  const data = await exchange(ctx, "POST", azureTokenUrl(ctx, e["AZURE_TENANT_ID"]!), { "content-type": "application/x-www-form-urlencoded" }, form(pairs), "Entra workload identity");
  return bearerFromOauth(data, ctx.now(), "Entra");
}

function azureMsiFlavor(ctx: ChainContext): string {
  const e = ctx.env;
  if (e["IDENTITY_ENDPOINT"]) {
    if (e["IDENTITY_HEADER"]) return e["IDENTITY_SERVER_THUMBPRINT"] ? "service-fabric" : "app-service";
    if (e["IMDS_ENDPOINT"]) return "azure-arc";
  }
  if (e["MSI_ENDPOINT"]) return e["MSI_SECRET"] ? "azure-ml" : "cloud-shell";
  return "imds";
}

async function azureMsiAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.http) return undefined;
  const e = ctx.env;
  const flavor = azureMsiFlavor(ctx);
  const resource = azureScope(ctx).replace(/\/\.default$/, "");
  const clientId = e["AZURE_CLIENT_ID"];
  const now = ctx.now();
  const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
  switch (flavor) {
    case "imds": {
      const query: Record<string, string> = { "api-version": "2018-02-01", resource };
      if (clientId) query["client_id"] = clientId;
      let status: number;
      let raw: Uint8Array;
      try {
        [status, , raw] = await ctx.http("GET", `http://169.254.169.254/metadata/identity/oauth2/token?${qs(query)}`, { Metadata: "true" }, undefined, 1);
      } catch {
        return undefined;
      }
      if (status !== 200) return undefined;
      return bearerFromOauth(jsonBody(raw), now, "managed identity");
    }
    case "app-service": {
      const query: Record<string, string> = { "api-version": "2019-08-01", resource };
      if (clientId) query["client_id"] = clientId;
      return bearerFromOauth(await exchange(ctx, "GET", `${e["IDENTITY_ENDPOINT"]}?${qs(query)}`, { "X-IDENTITY-HEADER": e["IDENTITY_HEADER"]! }, undefined, "App Service managed identity"), now, "managed identity");
    }
    case "cloud-shell":
      return bearerFromOauth(await exchange(ctx, "POST", e["MSI_ENDPOINT"]!, { Metadata: "true", "content-type": "application/x-www-form-urlencoded" }, form([["resource", resource]]), "Cloud Shell managed identity"), now, "managed identity");
    case "azure-ml": {
      const query: Record<string, string> = { "api-version": "2017-09-01", resource };
      if (clientId) query["clientid"] = clientId;
      return bearerFromOauth(await exchange(ctx, "GET", `${e["MSI_ENDPOINT"]}?${qs(query)}`, { secret: e["MSI_SECRET"]! }, undefined, "Azure ML managed identity"), now, "managed identity");
    }
    case "azure-arc": {
      const url = `${e["IDENTITY_ENDPOINT"]}?${qs({ "api-version": "2019-11-01", resource })}`;
      const [status, headers] = await ctx.http("GET", url, { Metadata: "true" }, undefined, 5);
      const challenge = headers["www-authenticate"] ?? "";
      if (status !== 401 || !challenge.includes("realm=")) throw new AuthError(`Azure Arc managed identity: expected a 401 challenge, got ${status}`);
      const keyPath = challenge.split("realm=", 2)[1]!.trim().replace(/^"|"$/g, "");
      const directory = process.platform === "win32" ? path.join(ctx.env["PROGRAMDATA"] ?? "C:/ProgramData", "AzureConnectedMachineAgent", "Tokens") : "/var/opt/azcmagent/tokens";
      if (path.dirname(keyPath) !== directory || path.extname(keyPath) !== ".key") throw new AuthError("Azure Arc managed identity: invalid challenge file location");
      const secret = ctx.read(keyPath);
      if (secret === undefined || secret.length > 4096) throw new AuthError("Azure Arc managed identity: challenge file missing or too large");
      return bearerFromOauth(await exchange(ctx, "GET", url, { Metadata: "true", Authorization: `Basic ${secret.trim()}` }, undefined, "Azure Arc managed identity"), now, "managed identity");
    }
    default:
      throw new NotConfiguredError("Service Fabric managed identity (TLS thumbprint pinning) is not supported; use a certificate or secret");
  }
}

async function azCliAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.run || ctx.onPath("az") === undefined) return undefined;
  const argv = ["az", "account", "get-access-token", "--output", "json", "--scope", azureScope(ctx)];
  if (ctx.env["AZURE_TENANT_ID"]) argv.push("--tenant", ctx.env["AZURE_TENANT_ID"]);
  const data = jsonBody(await ctx.run(argv, 30));
  const token = data["accessToken"];
  if (token === null || token === undefined) return undefined;
  const parsed = bearerFromOauth({ access_token: token, expires_on: data["expires_on"] ?? null }, ctx.now(), "Azure CLI");
  let expires = parsed.expiresAt;
  if (expires === undefined && data["expiresOn"]) {
    const d = new Date(str(data["expiresOn"]));
    if (!Number.isNaN(d.getTime())) expires = d;
  }
  return new BearerToken(parsed.value, expires);
}

async function pwshAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.run || ctx.onPath("pwsh") === undefined) return undefined;
  const resource = azureScope(ctx).replace(/\/\.default$/, "").replace(/'/g, "''");
  const script = `Get-AzAccessToken -ResourceUrl '${resource}' -AsSecureString:$false | ConvertTo-Json -Compress`;
  const data = jsonBody(await ctx.run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", script], 30));
  const token = data["Token"];
  return token === null || token === undefined ? undefined : bearerFromOauth({ access_token: token }, ctx.now(), "Azure PowerShell");
}

async function azdAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.run || ctx.onPath("azd") === undefined) return undefined;
  const data = jsonBody(await ctx.run(["azd", "auth", "token", "--output", "json", "--scope", azureScope(ctx)], 30));
  const token = data["token"];
  if (token === null || token === undefined) return undefined;
  const parsed = bearerFromOauth({ access_token: token }, ctx.now(), "Azure Developer CLI");
  let expires: Date | undefined;
  if (data["expiresOn"]) {
    try {
      expires = parseRfc3339(str(data["expiresOn"]));
    } catch {
      expires = undefined;
    }
  }
  return new BearerToken(parsed.value, expires);
}

function azureChain(policy: AccessPolicy): Rung[] {
  const narrowed = (ctx: ChainContext, name: string, developer: boolean): boolean => {
    const value = (ctx.env["AZURE_TOKEN_CREDENTIALS"] ?? "").trim().toLowerCase();
    if (!value) return false;
    if (value === "prod") return developer;
    if (value === "dev") return !developer;
    return value !== name.toLowerCase();
  };
  const guard = (fn: Rung["acquire"], name: string, developer: boolean): Rung["acquire"] => async (ctx) => (narrowed(ctx, name, developer) ? undefined : fn(ctx));
  const cliProbe = (name: string, label: string, command: string): Rung["probe"] => (ctx) => {
    if (narrowed(ctx, name, true)) return ["absent", "excluded by AZURE_TOKEN_CREDENTIALS"];
    if (ctx.onPath(command) === undefined) return ["absent", `${command} is not on PATH`];
    return ["configured", `${label} run at request time`];
  };
  const door = policy.envKeys[0];
  const rungs: Rung[] = [];
  if (door) rungs.push(envRung(door, ApiKey));
  rungs.push(
    rung(
      "environment",
      "http-token-exchange",
      "Entra service principal from AZURE_* env",
      "network",
      (ctx) => {
        if (narrowed(ctx, "EnvironmentCredential", false)) return ["absent", "excluded by AZURE_TOKEN_CREDENTIALS"];
        const kind = azureEnvironmentKind(ctx);
        return kind ? ["configured", `service principal by ${kind} (token exchange at request time)`] : ["absent", "AZURE_TENANT_ID/AZURE_CLIENT_ID + secret or certificate not set"];
      },
      guard(azureEnvironmentAcquire, "EnvironmentCredential", false),
    ),
    rung(
      "workload-identity",
      "http-token-exchange",
      "Entra workload identity",
      "network",
      (ctx) => {
        if (narrowed(ctx, "WorkloadIdentityCredential", false)) return ["absent", "excluded by AZURE_TOKEN_CREDENTIALS"];
        return azureWorkloadConfig(ctx) ? ["configured", "federated token file present (exchange at request time)"] : ["absent", "AZURE_FEDERATED_TOKEN_FILE not set"];
      },
      guard(azureWorkloadAcquire, "WorkloadIdentityCredential", false),
    ),
    rung(
      "managed-identity",
      "http-metadata",
      "Azure managed identity",
      "network",
      (ctx) => (narrowed(ctx, "ManagedIdentityCredential", false) ? ["absent", "excluded by AZURE_TOKEN_CREDENTIALS"] : ["configured", `managed identity (${azureMsiFlavor(ctx)}) probed at request time`]),
      guard(azureMsiAcquire, "ManagedIdentityCredential", false),
    ),
    rung("az", "subprocess", "az account get-access-token", "subprocess", cliProbe("AzureCliCredential", "`az`", "az"), guard(azCliAcquire, "AzureCliCredential", true)),
    rung("pwsh", "subprocess", "Azure PowerShell Get-AzAccessToken", "subprocess", cliProbe("AzurePowerShellCredential", "`pwsh`", "pwsh"), guard(pwshAcquire, "AzurePowerShellCredential", true)),
    rung("azd", "subprocess", "azd auth token", "subprocess", cliProbe("AzureDeveloperCliCredential", "`azd`", "azd"), guard(azdAcquire, "AzureDeveloperCliCredential", true)),
  );
  return rungs;
}

// ─── Google Cloud ────────────────────────────────────────────────────

/** `[token_uri, JWT]` for a `service_account` file (google-auth's header/claim order). */
export function gcpServiceAccountAssertion(ctx: ChainContext, info: JsonObject, scope = GCP_SCOPE): [string, string] {
  const key = rs256.loadPrivateKey(str(info["private_key"]));
  const now = Math.floor(ctx.now().getTime() / 1000);
  const tokenUri = str(info["token_uri"]) || GCP_TOKEN_URL;
  const header: JsonObject = { alg: "RS256", typ: "JWT" };
  if (info["private_key_id"]) header["kid"] = str(info["private_key_id"]);
  const payload: JsonObject = { iat: now, exp: now + 3600, iss: str(info["client_email"]), aud: tokenUri, scope };
  return [tokenUri, rs256.jwtEncode(header, payload, key)];
}

function gcpCredentialFile(ctx: ChainContext, file: string): JsonObject | undefined {
  const raw = ctx.read(file);
  if (raw === undefined) return undefined;
  let data: JsonValue;
  try {
    data = parseJson(raw);
  } catch {
    throw new NotConfiguredError(`${file}: not valid JSON`);
  }
  return isJsonObject(data) ? data : undefined;
}

async function gcpFromInfo(ctx: ChainContext, info: JsonObject, where: string): Promise<BearerToken> {
  const kind = info["type"];
  const now = ctx.now();
  if (kind === "authorized_user") {
    for (const k of ["refresh_token", "client_id", "client_secret"]) if (!info[k]) throw new NotConfiguredError(`${where}: authorized_user file lacks ${k}`);
    const pairs: Array<[string, string]> = [["grant_type", "refresh_token"], ["client_id", str(info["client_id"])], ["client_secret", str(info["client_secret"])], ["refresh_token", str(info["refresh_token"])]];
    return bearerFromOauth(await exchange(ctx, "POST", str(info["token_uri"]) || GCP_TOKEN_URL, { "content-type": "application/x-www-form-urlencoded" }, form(pairs), `Google OAuth refresh (${where})`, gcpUserLoginHint(where)), now, "Google OAuth");
  }
  if (kind === "service_account") {
    const [tokenUri, assertion] = gcpServiceAccountAssertion(ctx, info);
    return bearerFromOauth(await exchange(ctx, "POST", tokenUri, { "content-type": "application/x-www-form-urlencoded" }, form([["grant_type", JWT_BEARER], ["assertion", assertion]]), `Google service account key (${where})`,
      `the key in ${where} may have been deleted or disabled, or this machine's clock is off; create a new key (Cloud console: IAM & Admin > Service accounts > Keys) or use another identity`), now, "Google service account");
  }
  if (kind === "external_account") return gcpExternalAccount(ctx, info, where);
  if (kind === "impersonated_service_account") {
    const source = info["source_credentials"];
    if (!isJsonObject(source)) throw new NotConfiguredError(`${where}: impersonated_service_account lacks source_credentials`);
    const base = await gcpFromInfo(ctx, source, `${where}.source_credentials`);
    return gcpImpersonate(ctx, base, str(info["service_account_impersonation_url"]), Array.isArray(info["delegates"]) ? info["delegates"] : [], where);
  }
  throw new NotConfiguredError(`${where}: credential type ${JSON.stringify(kind)} is not supported by lm15 (external_account_authorized_user and gdch_service_account are stated gaps)`);
}

async function gcpImpersonate(ctx: ChainContext, source: BearerToken, url: string, delegates: JsonValue[], where: string): Promise<BearerToken> {
  const body = new TextEncoder().encode(stringifyJson({ delegates, scope: [GCP_SCOPE], lifetime: "3600s" }));
  const data = await exchange(ctx, "POST", url, { "content-type": "application/json", authorization: `Bearer ${source.value}` }, body, `service account impersonation (${where}; generateAccessToken)`,
    `the service account named in ${where} must exist, and the source identity needs roles/iam.serviceAccountTokenCreator on it (roles/iam.workloadIdentityUser for a workload identity pool), and the IAM Credentials API (iamcredentials.googleapis.com) enabled; a new grant can take several minutes to apply`);
  const token = data["accessToken"];
  if (!token) throw new AuthError("generateAccessToken: no accessToken");
  return new BearerToken(str(token), data["expireTime"] ? parseRfc3339(str(data["expireTime"])) : undefined);
}

async function gcpExternalAccount(ctx: ChainContext, info: JsonObject, where: string): Promise<BearerToken> {
  const source = isJsonObject(info["credential_source"]) ? info["credential_source"] : {};
  if ("environment_id" in source) throw new NotConfiguredError(`${where}: external_account with an AWS credential_source is a stated gap in lm15; use a file/url/executable source or a service account`);
  let subject: string | undefined;
  let fmt: JsonObject = isJsonObject(source["format"]) ? source["format"] : {};
  if (source["file"]) {
    const raw = ctx.read(str(source["file"]));
    if (raw === undefined) throw new NotConfiguredError(`${where}: subject token file ${str(source["file"])} is unreadable`);
    subject = raw.trim();
  } else if (source["url"]) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(isJsonObject(source["headers"]) ? source["headers"] : {})) headers[k] = str(v);
    const [status, , raw] = await ctx.http!("GET", str(source["url"]), headers, undefined, 30);
    if (status >= 400) throw new AuthError(`${where}: subject token url HTTP ${status}`);
    subject = new TextDecoder().decode(raw).trim();
  } else if (isJsonObject(source["executable"])) {
    if (!ctx.run) throw new NotConfiguredError(`${where}: executable credential source needs subprocess access`);
    if ((ctx.env["GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES"] ?? "") !== "1") throw new NotConfiguredError(`${where}: set GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1 to allow the executable source`);
    const exe = source["executable"];
    const out = await ctx.run(shellSplit(str(exe["command"])), Number(str(exe["timeout_millis"]) || 30000) / 1000);
    const data = jsonBody(out);
    if (data["success"] === false) throw new AuthError("external account executable reported failure");
    subject = str(data["id_token"] ?? data["saml_response"]);
    fmt = { type: "text" };
  }
  if (subject === undefined) throw new NotConfiguredError(`${where}: external_account credential_source is not file/url/executable`);
  if (fmt["type"] === "json") subject = str(jsonBody(subject)[str(fmt["subject_token_field_name"])]);
  const body = new TextEncoder().encode(
    stringifyJson({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: str(info["audience"]),
      scope: GCP_SCOPE,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: subject,
      subjectTokenType: str(info["subject_token_type"]),
    }),
  );
  const token = bearerFromOauth(await exchange(ctx, "POST", str(info["token_url"]) || GCP_STS_URL, { "content-type": "application/json" }, body, `Google STS exchange (${where})`,
    "the workload identity pool refused the external token: check the provider's issuer, allowed audience and attribute condition, and that the subject token is fresh"), ctx.now(), "Google STS");
  if (info["service_account_impersonation_url"]) return gcpImpersonate(ctx, token, str(info["service_account_impersonation_url"]), [], where);
  return token;
}

async function gcpMetadataAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.http || ["1", "true"].includes((ctx.env["NO_GCE_CHECK"] ?? "").toLowerCase())) return undefined;
  const host = ctx.env["GCE_METADATA_HOST"] || ctx.env["GCE_METADATA_ROOT"] || "metadata.google.internal";
  let status: number;
  let raw: Uint8Array;
  try {
    [status, , raw] = await ctx.http("GET", `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, { "Metadata-Flavor": "Google" }, undefined, 1);
  } catch {
    return undefined;
  }
  if (status !== 200) return undefined;
  return bearerFromOauth(jsonBody(raw), ctx.now(), "GCE metadata");
}

function gcpUserLoginHint(where: string): string {
  return `the saved Google login in ${where} has expired or was revoked; run \`gcloud auth application-default login\` (Google ends these sessions on its own schedule)`;
}

async function gcloudAcquire(ctx: ChainContext): Promise<BearerToken | undefined> {
  if (!ctx.run || ctx.onPath("gcloud") === undefined) return undefined;
  let token: string;
  try {
    token = (await ctx.run(["gcloud", "auth", "print-access-token"], 30)).trim();
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    // gcloud's own words stay unread (AUTH-5: a command's stderr is not shown).
    throw new AuthError(`\`gcloud auth print-access-token\` failed: ${e.message.split("\n\n  To fix:")[0]}`, {
      credentialHint: "run `gcloud auth print-access-token` yourself to see gcloud's reason; usually `gcloud auth login` fixes it (or `gcloud auth application-default login`, which lm15 reads first)",
    });
  }
  return token ? new BearerToken(token) : undefined;
}

function adcFilePath(ctx: ChainContext): string {
  const base = ctx.env["CLOUDSDK_CONFIG"] || "~/.config/gcloud";
  return `${base.replace(/\/+$/, "")}/application_default_credentials.json`;
}

function gcpChain(policy: AccessPolicy): Rung[] {
  const fileProbe = (label: string, pathFn: (ctx: ChainContext) => string | undefined): Rung["probe"] => (ctx) => {
    const p = pathFn(ctx);
    if (!p) return ["absent", `${label} not set`];
    const info = gcpCredentialFile(ctx, p);
    if (!info) return ["absent", `${p} missing or unreadable`];
    return ["configured", `${str(info["type"]) || "?"} credentials in ${p} (token exchange at request time)`];
  };
  const fileAcquire = (pathFn: (ctx: ChainContext) => string | undefined): Rung["acquire"] => async (ctx) => {
    const p = pathFn(ctx);
    if (!p) return undefined;
    const info = gcpCredentialFile(ctx, p);
    return info ? gcpFromInfo(ctx, info, p) : undefined;
  };
  const envPath = (ctx: ChainContext) => ctx.env["GOOGLE_APPLICATION_CREDENTIALS"];
  const door = policy.envKeys[0];
  const rungs: Rung[] = [];
  if (door) rungs.push(envRung(door, ApiKey));
  rungs.push(
    rung("adc-env", "json-file", "GOOGLE_APPLICATION_CREDENTIALS file", "network", fileProbe("GOOGLE_APPLICATION_CREDENTIALS", envPath), fileAcquire(envPath)),
    rung("adc-file", "json-file", "gcloud application default credentials file", "network", fileProbe("ADC file", adcFilePath), fileAcquire(adcFilePath)),
    rung(
      "metadata",
      "http-metadata",
      "GCE metadata server",
      "network",
      (ctx) => (["1", "true"].includes((ctx.env["NO_GCE_CHECK"] ?? "").toLowerCase()) ? ["absent", "NO_GCE_CHECK set"] : ["configured", "GCE metadata server probed at request time"]),
      gcpMetadataAcquire,
    ),
    rung("gcloud", "subprocess", "gcloud auth print-access-token", "subprocess", (ctx) => (ctx.onPath("gcloud") ? ["configured", "`gcloud` run at request time"] : ["absent", "gcloud is not on PATH"]), gcloudAcquire),
  );
  return rungs;
}

// ─── Settings from the cloud's own configuration (AUTH-10, after env) ──

const GCLOUD_CONFIG_NAME = /^[a-z][-a-z0-9]*$/; // gcloud's own rule (named_configs.py:37); keeps the name inside the directory

/**
 * The project `gcloud config get project` prints, read from the files gcloud
 * reads: `CLOUDSDK_CORE_PROJECT`, then `[core] project` in
 * `$CLOUDSDK_CONFIG/configurations/config_<name>` (`CLOUDSDK_ACTIVE_CONFIG_NAME`,
 * else the `active_config` file, else `default`). AUTH-10, amended 2026-09-26.
 */
export function gcloudConfigProject(ctx: ChainContext): SettingFound | undefined {
  const fromEnv = (ctx.env["CLOUDSDK_CORE_PROJECT"] ?? "").trim();
  if (fromEnv) return [fromEnv, "env:CLOUDSDK_CORE_PROJECT"];
  const base = (ctx.env["CLOUDSDK_CONFIG"] || "~/.config/gcloud").replace(/\/+$/, "");
  const name = (ctx.env["CLOUDSDK_ACTIVE_CONFIG_NAME"] ?? "").trim() || (ctx.read(`${base}/active_config`) ?? "").trim() || "default";
  if (!GCLOUD_CONFIG_NAME.test(name)) return undefined;
  const raw = ctx.read(`${base}/configurations/config_${name}`);
  if (!raw) return undefined;
  let ini: Ini;
  try {
    ini = parseIni(raw);
  } catch {
    return undefined;
  }
  const value = (ini.get("core")?.get("project") ?? "").trim();
  return value ? [value, "gcloud-config"] : undefined;
}

function gceCheckDisabled(ctx: ChainContext): boolean {
  return ["1", "true"].includes((ctx.env["NO_GCE_CHECK"] ?? "").toLowerCase());
}

/**
 * `project/project-id` from the metadata server: the project a Cloud Run
 * service, GKE pod or VM runs in. Asynchronous, so a TypeScript door asks it
 * before its first request, not at construction (AUTH-10 allows either).
 */
export async function metadataProject(ctx: ChainContext): Promise<string | undefined> {
  if (!ctx.http || gceCheckDisabled(ctx)) return undefined;
  const host = ctx.env["GCE_METADATA_HOST"] || ctx.env["GCE_METADATA_ROOT"] || "metadata.google.internal";
  try {
    const [status, , raw] = await ctx.http("GET", `http://${host}/computeMetadata/v1/project/project-id`, { "Metadata-Flavor": "Google" }, undefined, 1);
    const value = status === 200 ? new TextDecoder().decode(raw).trim() : "";
    return value && !/[\s/?#]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The setting values the cloud's own configuration carries, as `[value, from]`.
 * AWS `region`: the active profile. Google `project` (amended 2026-09-26, the
 * order google-auth and gcloud give it): the GOOGLE_APPLICATION_CREDENTIALS
 * file's `project_id` (then `quota_project_id`); gcloud's active configuration;
 * the ADC file's `quota_project_id`/`project_id`; then `[undefined, "metadata"]`
 * — the metadata server, asked before the first request.
 */
export function profileSettings(policy: AccessPolicy, ctx: ChainContext): (name: string) => SettingFound | undefined {
  return (name) => {
    if (policy.credentialPolicy === "aws-chain" && name === "region") {
      const [creds, conf, profile] = awsConfig(ctx);
      const value = awsProfileSection(conf, profile).get("region") || creds.get(profile)?.get("region");
      return value ? [value, "aws-profile"] : undefined;
    }
    if (policy.credentialPolicy === "gcp-chain" && name === "project") {
      const gac = ctx.env["GOOGLE_APPLICATION_CREDENTIALS"];
      if (gac) {
        const info = gcpCredentialFile(ctx, gac) ?? {};
        const value = str(info["project_id"]) || str(info["quota_project_id"]);
        if (value) return [value, "adc-env"];
      }
      const found = gcloudConfigProject(ctx);
      if (found) return found;
      const info = gcpCredentialFile(ctx, adcFilePath(ctx)) ?? {};
      const value = str(info["quota_project_id"]) || str(info["project_id"]);
      if (value) return [value, "adc-file"];
      return gceCheckDisabled(ctx) ? undefined : [undefined, "metadata"];
    }
    return undefined;
  };
}

// ─── Chains ──────────────────────────────────────────────────────────

const CHAINS: Record<string, (policy: AccessPolicy) => Rung[]> = { "aws-chain": awsChain, "azure-chain": azureChain, "gcp-chain": gcpChain };

export function chainFor(policy: AccessPolicy): Rung[] {
  const builder = CHAINS[policy.credentialPolicy];
  if (!builder) throw new ValueError(`${policy.provider}: not a cloud chain policy`);
  return builder(policy);
}

/** Exactly the selected identity's rungs, never the rest of the chain. */
export function namedRungs(policy: AccessPolicy, name: NamedCredential): Rung[] {
  validateNamedCredential(policy, name);
  const wanted = NAMED_RUNGS[policy.credentialPolicy]![name];
  const rungs = chainFor(policy).filter((r) => wanted.includes(r.name));
  if (policy.credentialPolicy !== "gcp-chain" || !["workload", "environment"].includes(name)) return rungs;
  const allowed = name === "workload" ? ["external_account"] : ["service_account", "impersonated_service_account"];
  const mismatch = (ctx: ChainContext): string | undefined => {
    const file = ctx.env["GOOGLE_APPLICATION_CREDENTIALS"];
    if (!file) return undefined;
    const info = gcpCredentialFile(ctx, file);
    if (!info || allowed.includes(str(info["type"]))) return undefined;
    const kind = info["type"];
    const other = kind === "external_account" ? "workload" : ["service_account", "impersonated_service_account"].includes(str(kind)) ? "environment" : kind === "authorized_user" ? "cli" : undefined;
    // A file's arbitrary type string is not trusted diagnostic text.
    return `${file}: credential file type is not accepted by named credential "${name}"; ${other ? `use named credential "${other}"` : "use an external_account or service_account configuration"}`;
  };
  return rungs.map((r) => ({ ...r,
    probe: (ctx: ChainContext): [Verdict, string] => { const reason = mismatch(ctx); return reason ? ["absent", reason] : r.probe(ctx); },
    acquire: async (ctx: ChainContext) => { const reason = mismatch(ctx); if (reason) throw new NotConfiguredError(reason, { provider: policy.provider }); return r.acquire(ctx); },
  }));
}

function walk(policy: AccessPolicy, named?: NamedCredential): Rung[] {
  return named === undefined ? chainFor(policy) : namedRungs(policy, named);
}

/** The AUTH-7 walk. `explicit` = an api_keys entry exists (rung 0). */
export function explain(policy: AccessPolicy, ctx: ChainContext, explicit: boolean, named?: NamedCredential): [Step[], boolean] {
  validateNamedCredential(policy, named, explicit);
  const steps: Step[] = [];
  let selected = false;
  if (explicit) {
    steps.push({ kind: "api_keys", source: "explicit api_keys entry", detail: "provided (value never shown)", state: "selected" });
    selected = true;
  } else steps.push({ kind: "api_keys", source: "explicit api_keys entry", detail: "not provided", state: "absent" });
  for (const r of walk(policy, named)) {
    let verdict: Verdict;
    let detail: string;
    try {
      [verdict, detail] = r.probe(ctx);
    } catch (e) {
      if (!(e instanceof NotConfiguredError)) throw e;
      verdict = "absent";
      detail = String(e.message).split("\n")[0]!;
    }
    let state: Step["state"];
    if (verdict === "absent") state = "absent";
    else if (verdict === "configured") state = selected ? "shadowed" : "unprobed";
    else {
      state = selected ? "shadowed" : "selected";
      selected = true;
    }
    steps.push({ kind: r.name, source: r.source, detail, state });
  }
  return [steps, selected || steps.some((s) => s.state === "unprobed")];
}

/** Walk the chain online; the first rung that yields wins. Azure developer commands are tried through errors. */
export async function resolve(policy: AccessPolicy, ctx: ChainContext, named?: NamedCredential): Promise<CredentialValue> {
  return (await resolveWithSource(policy, ctx, named))[0];
}

export async function resolveWithSource(policy: AccessPolicy, ctx: ChainContext, named?: NamedCredential): Promise<[CredentialValue, CredentialSource]> {
  let developerFailed = false;
  const rungs = walk(policy, named);
  for (const r of rungs) {
    let got: CredentialValue | undefined;
    try {
      got = await r.acquire(ctx);
    } catch (e) {
      if (e instanceof AuthError && policy.credentialPolicy === "azure-chain" && ["az", "pwsh", "azd"].includes(r.name)) {
        developerFailed = true;
        continue;
      }
      if (e instanceof AuthError || e instanceof NotConfiguredError) {
        const marker = "\nCredential source attempted: ";
        if (!e.message.includes(marker)) {
          const at = e.message.indexOf("\n\n  To fix:");
          const base = at < 0 ? e.message : e.message.slice(0, at);
          const guidance = at < 0 ? "" : e.message.slice(at);
          e.message = base + marker + new CredentialSource({ rung: r.name, label: r.source, named }).describe(ctx.now()) + guidance;
        }
      }
      throw e;
    }
    if (got !== undefined) return [got, new CredentialSource({ rung: r.name, label: r.source, named, expiresAt: got instanceof ApiKey ? undefined : got.expiresAt })];
  }
  if (developerFailed) throw new AuthError(`Azure developer credentials failed${named ? ` (named credential "${named}": ${namedMeaning(policy, named)}; probed ${rungs.map((r) => r.name).join(", ")}; no other identity tried)` : ""}; sign in with az, Azure PowerShell, or azd`, { provider: policy.provider });
  if (named) {
    const probes = rungs.map((r) => {
      try { return `${r.name}: ${r.probe(ctx)[1]}`; } catch { return `${r.name}: source unavailable`; }
    }).join("; ");
    throw new NotConfiguredError(`${policy.provider}: named credential "${named}" — ${namedMeaning(policy, named)} — answered nothing (${probes}). Only this identity was requested; the rest of the ${policy.credentialPolicy} chain is not tried.`, { provider: policy.provider });
  }
  const probed = rungs.map((r) => {
    try { return `${r.source}: ${r.probe(ctx)[1]}`; } catch { return `${r.source}: source unavailable`; }
  }).join("; ");
  throw new NotConfiguredError(
    `${policy.provider}: no credential found in the ${policy.credentialPolicy} chain (${probed})`,
    { provider: policy.provider, envKeys: policy.envKeys, credentialHint: nothingFoundHint(policy) ?? null },
  );
}

// What to do when a whole chain answers nothing: the command that creates a
// credential the chain reads, then the deployed alternatives.
const NOTHING_FOUND_HINTS: Record<string, string> = {
  "gcp-chain": "on a laptop: `gcloud auth application-default login`; elsewhere: set GOOGLE_APPLICATION_CREDENTIALS to a service-account or workload-identity file, run on Google Cloud with an attached service account, or pass apiKeys: { \"<provider>\": <token, key or callable> }",
  "azure-chain": "on a laptop: `az login`; elsewhere: a managed identity, AZURE_TENANT_ID + AZURE_CLIENT_ID with a secret or certificate, or apiKeys: { \"<provider>\": <token provider> }",
  "aws-chain": "on a laptop: `aws sso login` or `aws configure`; elsewhere: the instance or container role, AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or apiKeys: { \"<provider>\": <credentials callable> }",
};

function nothingFoundHint(policy: AccessPolicy): string | undefined {
  let hint = NOTHING_FOUND_HINTS[policy.credentialPolicy];
  if (hint && policy.envKeys.length > 0) hint = `set ${policy.envKeys[0]}, or ${hint}`;
  return hint?.replace("<provider>", policy.provider);
}


/** AUTH-2/AUTH-3: resolve once, hand out until the skew window, re-resolve after. In memory only. */
export function credentialProvider(policy: AccessPolicy, ctx: ChainContext, named?: NamedCredential): SourcedCredentialProvider {
  validateNamedCredential(policy, named);
  let cached: CredentialValue | undefined;
  let source: CredentialSource | undefined;
  let inflight: Promise<CredentialValue> | undefined;
  const provider = async () => {
    if (cached !== undefined && !cached.isExpired(ctx.now())) return cached;
    inflight ??= (async () => {
      try {
        const [value, origin] = await resolveWithSource(policy, ctx, named);
        source = origin;
        if (value.isExpired(ctx.now())) throw new AuthError(`cloud credential is expired; renew the configured credential source\nCredential came from: ${origin.describe(ctx.now())}`, { provider: policy.provider });
        // CLI output without an expiry cannot safely be cached forever.
        cached = value instanceof ApiKey || value instanceof AwsCredentials || value.expiresAt !== undefined ? value : undefined;
        return value;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
  Object.defineProperties(provider, { source: { get: () => source }, named: { value: named } });
  return provider as SourcedCredentialProvider;
}

/** Provider id + the identity-selecting settings (AUTH-3). */
export function cacheKey(policy: AccessPolicy, ctx: ChainContext): string {
  const e = ctx.env;
  const parts = [policy.provider, e["AWS_PROFILE"] ?? "", e["AZURE_TENANT_ID"] ?? "", e["AZURE_CLIENT_ID"] ?? "", e["GOOGLE_APPLICATION_CREDENTIALS"] ?? "", e["CLOUDSDK_CONFIG"] ?? "", ctx.home];
  for (const [k, v] of Object.entries(ctx.settings).sort()) parts.push(`${k}=${v}`);
  return createHash("sha256").update(parts.join("\u001f"), "utf-8").digest("hex");
}

// ─── Harness ops ─────────────────────────────────────────────────────

export function tokenExchangeBuild(policy: AccessPolicy, rungName: string, inputs: JsonObject, ctx: ChainContext): JsonObject {
  if (["adc-env", "adc-file", "service-account"].includes(rungName)) {
    const info = inputs["credential_file"];
    if (!isJsonObject(info)) throw new ValueError("token_exchange_build: credential_file must be an object");
    const scope = str(inputs["scope"]) || GCP_SCOPE;
    const [tokenUri, assertion] = gcpServiceAccountAssertion(ctx, info, scope);
    return { method: "POST", url: tokenUri, headers: { "content-type": "application/x-www-form-urlencoded" }, body_encoding: "form", body: { grant_type: JWT_BEARER, assertion } };
  }
  if (rungName === "environment") {
    const jti = inputs["jti"];
    const [url, pairs] = azureEnvironmentRequest(ctx, { jti: typeof jti === "string" ? jti : undefined });
    return { method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, body_encoding: "form", body: Object.fromEntries(pairs) };
  }
  throw new ValueError(`token_exchange_build: rung ${JSON.stringify(rungName)} has no deterministic request`);
}

export function tokenExchangeParse(_policy: AccessPolicy, rungName: string, status: number, body: JsonObject, ctx: ChainContext): CredentialValue {
  const now = ctx.now();
  if (["adc-env", "adc-file", "service-account", "environment", "workload-identity", "managed-identity", "metadata"].includes(rungName)) {
    if (!(status >= 200 && status < 300)) throw new AuthError(`${rungName}: HTTP ${status}`);
    return bearerFromOauth(body, now, rungName);
  }
  if (rungName === "credential_process") {
    if (status !== 0 || body["Version"] !== 1) throw new AuthError("credential_process failed or returned an unsupported Version");
    return awsFromResponse(body);
  }
  if (rungName === "imds" || rungName === "container") {
    if (!(status >= 200 && status < 300)) throw new AuthError(`${rungName}: HTTP ${status}`);
    return awsFromResponse(body);
  }
  throw new ValueError(`token_exchange_parse: rung ${JSON.stringify(rungName)} is not a parse vector`);
}
