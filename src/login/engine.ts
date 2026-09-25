/**
 * The machinery every provider login flow runs on (spec/auth-managed.md
 * AUTH-18, AUTH-20, AUTH-21, AUTH-22). Port of lm15-python
 * `lm15/login/engine.py`, with TypeScript mechanics: promises, AbortSignal,
 * fetch. Flows describe their protocol; this module supplies what must be
 * identical for all of them:
 *
 * - `LoginContext`: one attempt's deadline, cancellation and UI, plus the
 *   clock/sleep/fetch seams tests inject;
 * - `authRequest`: a bounded (30 s, 1 MiB), TLS-only, no-redirect exchange
 *   whose failures never carry a token or reflected provider text, routed per
 *   stage: directly, or through the relay the application configured
 *   (proposed AUTH-21 promotion, changes/2026-09-24);
 * - `runDeviceFlow`: RFC 8628 pacing (interval or 5 s; slow_down adds 5 s;
 *   never shorter; the deadline is never extended);
 * - `parseManualReturn`: a pasted or page-received return, checked against
 *   the attempt's registered return context before anything is exchanged.
 *
 * Nothing here knows a provider's URL, client id or token shape.
 */

import { base64UrlEncode } from "../bytes.ts";
import { AuthOperationError, ServerError, TransportError, type AuthResponseFormat } from "../errors.ts";
import { isJsonObject, parseJsonStrict, RawNumber, type JsonObject } from "../json.ts";
import { VERSION } from "../version.ts";
import { getDefaultPlatform } from "../platform.ts";
import type { RequestProfile } from "./profiles.ts";
import type { TlsEngine } from "../tunnel/tls.ts";
import { tunnelFetch } from "../tunnel/tunnel.ts";
import type { AuthUI, LoginPlatform, ManualCodePrompt, Notice, Prompt, RelayStage } from "./types.ts";
import type { CallbackListener } from "../platform.ts";

export const ATTEMPT_LIFETIME_MS = 15 * 60 * 1000; // AUTH-18, R9
export const EXCHANGE_TIMEOUT_MS = 30_000; // AUTH-20.5, R9
export const DEVICE_DEFAULT_INTERVAL_S = 5; // RFC 8628 §3.2
export const DEVICE_SLOW_DOWN_STEP_S = 5; // RFC 8628 §3.5
export const AUTH_RESPONSE_LIMIT = 1024 * 1024; // AUTH-18
export const RETURN_TEXT_LIMIT = 8 * 1024; // AUTH-18 request-target limit, applied to a pasted return

/** Only these fixed protocol words can leave a private auth response (AUTH-24). */
export const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope",
  "access_denied", "server_error", "temporarily_unavailable", "authorization_pending", "slow_down", "expired_token",
]);

// ─── Outcomes flows raise; the runner maps them (AUTH-24) ─────────────

/** The caller, the UI or the page stopped the attempt. Not an LM15 error: the conformance outcome is `cancelled`. */
export class LoginCancelled extends Error {
  override readonly name = "LoginCancelled";
}

/** A validated provider denial. The message is ours; provider text is never copied into it. */
export class LoginDenied extends Error {
  override readonly name = "LoginDenied";
  readonly status: number | null;
  readonly providerCode: string | null;
  readonly stage: "authorization" | "exchange" | "renewal" | "polling";
  readonly responseFormat: AuthResponseFormat | null;
  readonly securityChallenge: boolean;
  /** AUTH-24 diagnostics of the reply that caused it, when there was one. */
  readonly summary: string | null;

  constructor(message: string, meta: { status?: number | null; providerCode?: string | null; stage?: LoginDenied["stage"]; reply?: HttpReply } = {}) {
    super(message);
    this.summary = meta.reply ? failureSummary(meta.reply) : null;
    this.status = meta.status ?? meta.reply?.status ?? null;
    this.providerCode = meta.providerCode ?? meta.reply?.oauthError ?? null;
    this.stage = meta.stage ?? "authorization";
    this.responseFormat = meta.reply?.responseFormat ?? null;
    this.securityChallenge = meta.reply?.securityChallenge ?? false;
  }
}

/** The attempt's deadline or the provider's device-code expiry passed. */
export class LoginExpired extends Error {
  override readonly name = "LoginExpired";
}

// ─── Routing (AUTH-22, proposed AUTH-21) ─────────────────────────────

/**
 * A relay the application configured, for the stages a person consented to.
 * `rewrite` maps a provider URL to the relay's; `origin` names the relay in
 * diagnostics. The SDK never reroutes on its own: a stage not listed here
 * goes direct, and a request whose evidence says a page cannot reach it
 * directly is refused before it is sent.
 */
export interface RelayConfig {
  readonly origin: string;
  readonly stages: readonly RelayStage[];
  rewrite(url: URL): URL;
  /**
   * An encrypted tunnel (`tunnelRelay`): requests keep the provider's URL and
   * go through this fetch, which runs TLS in the page. The relay then sees
   * only ciphertext, plus which host, when and how much.
   */
  readonly fetch?: typeof fetch;
  /** True for a tunnel: the relay cannot read what it carries. */
  readonly encrypted?: boolean;
  /**
   * Header the relay turns into the upstream `User-Agent` (pages cannot send
   * one). Omit if the relay has no such feature; the provider then sees the
   * browser's own.
   */
  readonly userAgentHeader?: string;
}

/** `https://<relay>/<host>/<path>?<query>`: the lm15 playground relay's shape (website/relay/worker.js). */
export function pathRelay(relayBase: string, options: { stages: readonly RelayStage[]; userAgentHeader?: string }): RelayConfig {
  const base = new URL(relayBase);
  const root = base.href.replace(/\/$/, "");
  return Object.freeze({
    origin: base.origin,
    stages: Object.freeze([...options.stages]),
    ...(options.userAgentHeader ? { userAgentHeader: options.userAgentHeader } : {}),
    rewrite(url: URL): URL {
      return new URL(`${root}/${url.host}${url.pathname}${url.search}`);
    },
  });
}

/**
 * An encrypted tunnel relay: TLS runs in the page (rustls in WebAssembly,
 * `TlsEngine`), the tunnel at `url` copies ciphertext to the provider's port
 * 443. Same stages and consent as a forwarding relay; what the relay can see
 * differs, and the consent text must say which.
 */
export function tunnelRelay(url: string | URL, options: { stages: readonly RelayStage[]; tls: TlsEngine | Promise<TlsEngine>; WebSocket?: typeof WebSocket }): RelayConfig {
  const base = new URL(String(url));
  return Object.freeze({
    origin: base.origin.replace(/^ws/, "http"),
    stages: Object.freeze([...options.stages]),
    rewrite: (u: URL) => u,
    fetch: tunnelFetch({ url: base, tls: options.tls, ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}) }),
    encrypted: true,
  });
}

export interface LoginRouting {
  readonly platform: LoginPlatform;
  readonly relay?: RelayConfig;
}

export function relayCovers(routing: LoginRouting, stage: RelayStage): boolean {
  return routing.relay !== undefined && routing.relay.stages.includes(stage);
}

// ─── The attempt context ─────────────────────────────────────────────

/**
 * One auth exchange as a diagnostic record: where it went, which way, and what
 * came back, in AUTH-24's words only. No URL query, no body, no header value:
 * safe to show, log or paste into a receipt.
 */
export interface ExchangeRecord {
  readonly provider: string;
  readonly stage: "authorization" | "polling" | "exchange" | "renewal";
  readonly method: "GET" | "POST";
  readonly host: string;
  readonly path: string;
  /** `direct`, or the relay's origin. */
  readonly via: string;
  readonly status: number | null;
  readonly responseFormat: AuthResponseFormat | null;
  readonly oauthError: string | null;
  /** Set when no readable reply came back: the AuthOperationError reason, or `server_error`. */
  readonly failure: string | null;
  readonly ms: number;
}

export interface LoginContextOptions {
  readonly ui: AuthUI;
  /** Called once per auth exchange with a secret-free record (receipts, diagnostics). */
  readonly onExchange?: (record: ExchangeRecord) => void;
  readonly provider: string;
  readonly routing: LoginRouting;
  readonly signal?: AbortSignal;
  /** Attempt budget in milliseconds (default 15 minutes). */
  readonly lifetimeMs?: number;
  readonly fetch?: typeof fetch;
  /** Monotonic milliseconds (tests). */
  readonly clock?: () => number;
  /** Epoch milliseconds (tests). */
  readonly wallClock?: () => number;
  /** Wait that honors the signal (tests). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LoginCancelled("login cancelled"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LoginCancelled("login cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class LoginContext {
  readonly ui: AuthUI;
  readonly provider: string;
  readonly routing: LoginRouting;
  readonly signal: AbortSignal;
  readonly clock: () => number;
  readonly wallClock: () => number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onExchange: ((record: ExchangeRecord) => void) | undefined;
  deadline: number;

  constructor(opts: LoginContextOptions) {
    this.ui = opts.ui;
    this.provider = opts.provider;
    this.routing = opts.routing;
    this.signal = opts.signal ?? new AbortController().signal;
    this.clock = opts.clock ?? (() => performance.now());
    this.wallClock = opts.wallClock ?? (() => Date.now());
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.onExchange = opts.onExchange;
    this.deadline = this.clock() + (opts.lifetimeMs ?? ATTEMPT_LIFETIME_MS);
  }

  get fetch(): typeof fetch {
    return this.#fetch;
  }

  remainingMs(): number {
    return this.deadline - this.clock();
  }

  /** Throw if the attempt should stop. Called before every external step and every wait. */
  check(): void {
    if (this.signal.aborted) throw new LoginCancelled("login cancelled");
    if (this.remainingMs() <= 0) throw new LoginExpired("login attempt deadline reached");
  }

  async wait(ms: number): Promise<void> {
    this.check();
    const bounded = Math.min(Math.max(ms, 0), Math.max(this.remainingMs(), 0));
    if (bounded > 0) await this.#sleep(bounded, this.signal);
    this.check();
  }

  notify(notice: Notice): void {
    this.ui.notify(notice);
  }

  /** Ask the person; the prompt is abandoned when the attempt is cancelled or its deadline passes. */
  async prompt(prompt: Prompt, opts: { readonly signal?: AbortSignal } = {}): Promise<string> {
    this.check();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.remainingMs(), 0));
    const onAbort = (): void => controller.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const answer = await this.ui.prompt(prompt, { signal: controller.signal });
      if (typeof answer !== "string") throw new TypeError("AuthUI.prompt must resolve with a string");
      this.check();
      return answer;
    } catch (error) {
      this.check();
      if (controller.signal.aborted) throw new LoginCancelled("login cancelled at the prompt");
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
      opts.signal?.removeEventListener("abort", onAbort);
      this.ui.dismiss?.(prompt);
    }
  }

  budgetMs(): number {
    return Math.max(100, Math.min(EXCHANGE_TIMEOUT_MS, this.remainingMs()));
  }
}

// ─── Bounded HTTP ────────────────────────────────────────────────────

export interface HttpReply {
  readonly status: number;
  /** May hold tokens: never rendered, never attached to an error. */
  readonly body: JsonObject;
  readonly ok: boolean;
  readonly responseFormat: AuthResponseFormat;
  readonly oauthError: string | null;
  readonly securityChallenge: boolean;
  /** `direct` or the relay origin: which way the request travelled (diagnostics, receipts). */
  readonly via: string;
}

/** AUTH-24: status, format category, recognized OAuth code, explicit challenge; nothing else. */
export function failureSummary(reply: HttpReply): string {
  const parts = [`HTTP ${reply.status}`, `response=${reply.responseFormat}`];
  parts.push(reply.oauthError ? `OAuth error=${reply.oauthError}` : "no recognized OAuth error code; cause not established");
  if (reply.securityChallenge) parts.push("response explicitly marked as a security challenge");
  else if (reply.responseFormat === "html") parts.push("HTML alone does not establish a security block");
  if (reply.via !== "direct") parts.push(`via relay ${reply.via}`);
  return parts.join("; ");
}

export interface AuthRequestOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The request may spend something one-use (an authorization code, a device
   * approval, a rotating refresh token). A failure whose delivery is unknown
   * is then `indeterminate`, never quietly retryable (AUTH-20.6).
   */
  readonly consumes?: boolean;
  /** The AUTH-24 stage an error names. */
  readonly stage?: "authorization" | "polling" | "exchange" | "renewal";
}

async function readLimited(response: globalThis.Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AUTH_RESPONSE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("auth response larger than 1 MiB");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function classify(bytes: Uint8Array, contentType: string): { body: JsonObject; format: AuthResponseFormat; oauthError: string | null } {
  if (bytes.byteLength === 0) return { body: {}, format: "empty", oauthError: null };
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  let format: AuthResponseFormat = type === "text/html" || type === "application/xhtml+xml" ? "html" : type === "application/json" || type.endsWith("+json") ? "invalid_json" : "text_or_binary";
  let body: JsonObject = {};
  try {
    const parsed = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    format = "json";
    if (isJsonObject(parsed)) body = parsed;
  } catch {
    // Not JSON (or not strict JSON): the format category says so; the text is never kept.
  }
  let candidate: unknown = body["error"];
  if (isJsonObject(candidate)) candidate = candidate["code"] ?? candidate["type"];
  const oauthError = typeof candidate === "string" && OAUTH_ERROR_CODES.has(candidate) ? candidate : null;
  return { body, format, oauthError };
}

/**
 * One auth exchange. `profile.url` is the provider's address; routing decides
 * whether the bytes go there directly or through the configured relay.
 */
export async function authRequest(ctx: LoginContext, profile: RequestProfile, opts: AuthRequestOptions = {}): Promise<HttpReply> {
  if (!ctx.onExchange) return sendAuthRequest(ctx, profile, opts);
  const started = ctx.clock();
  const target = new URL(profile.url);
  const base = { provider: ctx.provider, stage: opts.stage ?? "exchange", method: profile.method, host: target.host, path: target.pathname } as const;
  const report = (record: Omit<ExchangeRecord, keyof typeof base | "ms">): void => {
    try {
      ctx.onExchange!(Object.freeze({ ...base, ...record, ms: Math.round(ctx.clock() - started) }));
    } catch {
      // An observer's failure is not the login's.
    }
  };
  const relayed = ctx.routing.platform === "browser" && profile.browser === "relay" && ctx.routing.relay ? ctx.routing.relay.origin : "direct";
  try {
    const reply = await sendAuthRequest(ctx, profile, opts);
    report({ via: reply.via, status: reply.status, responseFormat: reply.responseFormat, oauthError: reply.oauthError, failure: null });
    return reply;
  } catch (error) {
    if (!(error instanceof LoginCancelled)) {
      const failure = error instanceof AuthOperationError ? error.reason : error instanceof ServerError ? "server_error" : "error";
      const status = error instanceof AuthOperationError || error instanceof ServerError ? error.status : null;
      report({ via: relayed, status, responseFormat: null, oauthError: null, failure });
    }
    throw error;
  }
}

async function sendAuthRequest(ctx: LoginContext, profile: RequestProfile, opts: AuthRequestOptions): Promise<HttpReply> {
  ctx.check();
  const target = new URL(profile.url);
  if (target.protocol !== "https:") throw new AuthOperationError(`${ctx.provider}: refusing a non-TLS auth endpoint (${target.host})`, { reason: "method_unavailable", stage: "discovery", recovery: "operator_action", provider: ctx.provider });
  const stage = opts.stage ?? "exchange";
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}), ...(profile.headers ?? {}) };
  let body: string | undefined;
  if (profile.method === "POST") {
    if (profile.encoding === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.params ?? {});
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.params ?? {}).toString();
    }
  }
  // Identification (AUTH-18): lm15/<version> unless the profile names another.
  const userAgent = Object.entries(headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1] ?? `lm15/${VERSION}`;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "user-agent") delete headers[k];

  let url = target;
  let via = "direct";
  const browser = ctx.routing.platform === "browser";
  if (browser && profile.browser === "relay") {
    if (!relayCovers(ctx.routing, "auth")) {
      throw new AuthOperationError(
        `${ctx.provider}: ${target.host} does not let a web page read its replies (lm15-contract auth/managed/browser.json); ` +
          "this step needs a relay the person agreed to for sign-in traffic. Nothing was sent.",
        { reason: "method_unavailable", stage, recovery: "choose_method", provider: ctx.provider, delivery: "not_sent", host: target.host },
      );
    }
    url = ctx.routing.relay!.rewrite(target);
    via = ctx.routing.relay!.origin;
    if (ctx.routing.relay!.fetch) headers["User-Agent"] = userAgent; // a tunnel writes the request itself
    else if (ctx.routing.relay!.userAgentHeader) headers[ctx.routing.relay!.userAgentHeader] = userAgent;
  } else if (!browser) {
    headers["User-Agent"] = userAgent;
  }
  // A page cannot set User-Agent directly; the browser sends its own (browser.json platform_limits).

  const timeout = AbortSignal.timeout(ctx.budgetMs());
  const signal = AbortSignal.any([ctx.signal, timeout]);
  let response: globalThis.Response;
  try {
    const send = via !== "direct" && ctx.routing.relay?.fetch ? ctx.routing.relay.fetch : ctx.fetch;
    response = await send(url.toString(), {
      method: profile.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal,
      ...(browser ? { credentials: "omit" as const, referrerPolicy: "no-referrer" as const, cache: "no-store" as const } : {}),
    });
  } catch (cause) {
    ctx.check();
    const timedOut = timeout.aborted;
    if (!browser) {
      // AUTH-20.6, as the reference: a refused connection or a failed name
      // lookup never reached the provider (safe, the credential is kept); a
      // timeout or a connection lost after sending may have (uncertain: a
      // one-use value may be spent). Only the error's class is named.
      const code = networkErrorCode(cause);
      const error = new TransportError(
        `${ctx.provider || "auth"}: network failure during an authentication exchange (${timedOut ? "TimeoutError" : code ?? (cause instanceof Error ? cause.name : "Error")}) to ${url.origin}${url.pathname}`,
        { provider: ctx.provider || null },
      ) as TransportError & { exchangeUncertain: boolean };
      error.exchangeUncertain = timedOut || code === undefined || !NOT_SENT_CODES.has(code);
      throw error;
    }
    // A page cannot tell a refused CORS exchange from a connection dropped after
    // sending, and a form POST is sent before its reply is checked. So delivery
    // is unknown, and a request that may spend a one-use value is indeterminate.
    const reason = opts.consumes ? "indeterminate" : "method_unavailable";
    throw new AuthOperationError(
      `${ctx.provider}: the ${profile.method} to ${url.host} failed ${timedOut ? "(timed out)" : "before a reply was readable"}` +
        (browser && via === "direct" ? " (a browser refusing a cross-origin reply looks exactly like this)" : "") +
        (reason === "indeterminate" ? "; it may have reached the provider and spent a one-use value, so sign in again rather than retry" : ""),
      {
        reason, stage, recovery: reason === "indeterminate" ? "restart_login" : "choose_method",
        commitState: "not_committed", provider: ctx.provider, host: url.host, delivery: "unknown",
        cause: cause instanceof Error ? new Error(cause.name) : undefined,
      },
    );
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthOperationError(`${ctx.provider}: ${url.host} answered with a redirect; auth exchanges never follow one`, { reason: "method_unavailable", stage, recovery: "operator_action", provider: ctx.provider, status: response.status || null, host: url.host });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(response);
  } catch (cause) {
    ctx.check();
    throw new AuthOperationError(`${ctx.provider}: the reply from ${url.host} could not be read in full`, {
      reason: opts.consumes ? "indeterminate" : "method_unavailable", stage, recovery: "restart_login", provider: ctx.provider, status: response.status, host: url.host,
      cause: cause instanceof Error ? new Error(cause.name) : undefined,
    });
  }
  const { body: parsed, format, oauthError } = classify(bytes, response.headers.get("content-type") ?? "");
  const securityChallenge = (response.headers.get("cf-mitigated") ?? "").trim().toLowerCase() === "challenge";
  if (response.status >= 500) {
    throw new ServerError(`${ctx.provider}: the authentication server answered HTTP ${response.status}`, { provider: ctx.provider, status: response.status });
  }
  return Object.freeze({ status: response.status, body: parsed, ok: response.status >= 200 && response.status < 300, responseFormat: format, oauthError, securityChallenge, via });
}

/** Node network error codes that prove nothing reached the server. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

function networkErrorCode(cause: unknown): string | undefined {
  for (let e: unknown = cause, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when a failed auth exchange may have reached the provider (AUTH-20.6). */
export function exchangeUncertain(error: unknown): boolean {
  return error instanceof TransportError && (error as TransportError & { exchangeUncertain?: boolean }).exchangeUncertain === true;
}

// ─── Device flow (RFC 8628) ──────────────────────────────────────────

export type DeviceStep<T> =
  | { readonly status: "pending" }
  | { readonly status: "slow_down"; readonly intervalS?: number | undefined }
  | { readonly status: "complete"; readonly value: T }
  | { readonly status: "denied" }
  | { readonly status: "expired" };

export async function runDeviceFlow<T>(
  ctx: LoginContext,
  poll: () => Promise<DeviceStep<T>>,
  opts: { intervalS?: number | undefined; expiresInS?: number | undefined; waitBeforeFirstPoll?: boolean } = {},
): Promise<T> {
  let interval = opts.intervalS && opts.intervalS > 0 ? opts.intervalS : DEVICE_DEFAULT_INTERVAL_S;
  interval = Math.max(interval, 1);
  if (opts.expiresInS && opts.expiresInS > 0) ctx.deadline = Math.min(ctx.deadline, ctx.clock() + opts.expiresInS * 1000);
  if (opts.waitBeforeFirstPoll ?? true) await ctx.wait(interval * 1000);
  for (;;) {
    ctx.check();
    const step = await poll();
    if (step.status === "complete") return step.value;
    if (step.status === "denied") throw new LoginDenied("the provider reported that authorization was denied", { stage: "polling" });
    if (step.status === "expired") throw new LoginExpired("the provider reported that the device code expired");
    if (step.status === "slow_down") interval = Math.max(interval + DEVICE_SLOW_DOWN_STEP_S, step.intervalS && step.intervalS > 0 ? step.intervalS : 0);
    await ctx.wait(interval * 1000);
  }
}

// ─── Returns (AUTH-18 browser and OAuth protections) ────────────────

export interface CallbackReturn {
  readonly code: string;
  readonly state: string | null;
}

export interface ReturnContext {
  readonly expectedState: string | null;
  readonly allowBareCode: boolean;
  /** A full URL must match this exactly in scheme, host, effective port and path. */
  readonly registeredUri?: string;
  /**
   * The provider is observed to drop a trailing `/` from the return path
   * (OpenRouter, 2026-09-24), so `/app` and `/app/` are the same return.
   * Scheme, host and port still match exactly.
   */
  readonly trailingSlashOptional?: boolean;
}

function invalid(message: string, provider: string): AuthOperationError {
  return new AuthOperationError(message, { reason: "invalid_login_state", stage: "interaction", recovery: "provide_input", provider });
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
}

/**
 * Read a pasted or page-received return: a URL, `code=…&state=…`, `code#state`,
 * or (only where the profile allows it) a bare code. Nothing pasted is ever
 * quoted in an error. A wrong-state *error* return is rejected as invalid and
 * never ends the legitimate attempt as denied.
 */
export function parseManualReturn(text: string, context: ReturnContext, provider: string): CallbackReturn {
  const value = (text ?? "").trim();
  if (!value) throw invalid("nothing was pasted", provider);
  if (value.length > RETURN_TEXT_LIMIT) throw invalid("the pasted return is too long", provider);
  let params: URLSearchParams | null = null;
  let code: string | null = null;
  let state: string | null = null;
  let bare = false;
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid("the pasted URL is not this sign-in's registered return URL", provider);
    }
    if (url.username || url.password) throw invalid("the pasted URL is not this sign-in's registered return URL", provider);
    if (context.registeredUri !== undefined) {
      const expected = new URL(context.registeredUri);
      const path = (p: string): string => (context.trailingSlashOptional ? p.replace(/\/+$/, "") || "/" : p);
      if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || effectivePort(url) !== effectivePort(expected) || path(url.pathname) !== path(expected.pathname)) {
        throw invalid("the pasted URL is not this sign-in's registered return URL", provider);
      }
    }
    if (url.hash) throw invalid("the pasted URL is not this sign-in's registered return URL", provider);
    params = new URLSearchParams(url.search);
  } else if (/^(code|state|error)=/.test(value)) {
    params = new URLSearchParams(value);
  } else if (value.includes("#")) {
    const at = value.indexOf("#");
    code = value.slice(0, at);
    state = value.slice(at + 1);
  } else {
    code = value;
    bare = true;
  }

  let denied = false;
  if (params !== null) {
    const names = [...params.keys()];
    if (new Set(names).size !== names.length) throw invalid("the pasted return repeats a parameter", provider);
    if (params.has("code") && params.has("error")) throw invalid("the pasted return contains both a code and an error", provider);
    denied = params.has("error");
    code = params.get("code");
    state = params.get("state");
  }
  if (bare && !context.allowBareCode) throw invalid("paste the complete code#state or return URL, not the code alone", provider);
  if (context.expectedState !== null) {
    if (state === null) {
      if (!(bare && context.allowBareCode)) throw invalid("this provider's return must carry its state value", provider);
    } else if (!constantTimeEqual(state, context.expectedState)) {
      throw invalid("the pasted return does not belong to this sign-in attempt", provider);
    }
  }
  if (denied) throw new LoginDenied("the validated return carries a provider error");
  if (!code) throw invalid("no authorization code in the pasted text", provider);
  return { code, state };
}

/**
 * Ask for the return until a valid one arrives. An invalid paste (wrong
 * state, wrong URL) is reported to the person and the legitimate wait goes
 * on (AUTH-18); cancellation and the deadline still end it.
 */
export async function awaitReturn(ctx: LoginContext, prompt: ManualCodePrompt, context: ReturnContext, listener?: CallbackListener | null): Promise<CallbackReturn> {
  for (;;) {
    let answer: string;
    if (listener && !listener.done) {
      // The loopback return raced against a paste (AUTH-16): the loser is dismissed.
      const stop = new AbortController();
      const person = ctx.prompt(prompt, { signal: stop.signal }).then((text) => ({ text }));
      person.catch(() => undefined);
      const winner = await Promise.race([listener.wait().then((returned) => ({ returned })), person]).finally(() => undefined);
      if ("returned" in winner) {
        stop.abort();
        if (winner.returned) return winner.returned;
        continue; // stopped from outside: ask for a paste
      }
      answer = winner.text;
    } else {
      answer = await ctx.prompt(prompt);
    }
    try {
      return parseManualReturn(answer, context, ctx.provider);
    } catch (error) {
      if (error instanceof AuthOperationError && error.reason === "invalid_login_state") {
        ctx.notify({ type: "info", message: `${error.message}. Try again.` });
        continue;
      }
      throw error;
    }
  }
}

/**
 * Open the host's loopback listener for a registered return, when this is a
 * native host that has one. A busy registered port is reported to the person
 * and the flow falls back to a paste (AUTH-18: never a wider bind or another
 * redirect); `required` flows (the return URI is the listener's own) fail.
 */
export async function openListener(ctx: LoginContext, opts: import("../platform.ts").CallbackListenerOptions, required = false): Promise<CallbackListener | null> {
  const open = ctx.routing.platform === "native" ? getDefaultPlatform().openCallbackListener : undefined;
  if (!open) {
    if (required) throw new AuthOperationError(`${ctx.provider}: this sign-in needs a local callback listener, which this host does not provide`, { reason: "method_unavailable", stage: "reservation", recovery: "choose_method", provider: ctx.provider });
    return null;
  }
  try {
    return await open(opts);
  } catch (error) {
    if (required || !(error instanceof AuthOperationError) || error.reason !== "method_unavailable") throw error;
    ctx.notify({ type: "info", message: `Could not listen on port ${opts.port}; paste the full redirect URL when the browser finishes.` });
    return null;
  }
}

// ─── Randomness ──────────────────────────────────────────────────────

export function randomBase64Url(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function positiveNumber(value: unknown): number | undefined {
  const n = value instanceof RawNumber ? Number(value.raw) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function httpsUrl(value: unknown, provider: string, allowHttp = false): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return url.toString();
    } catch {
      // fall through
    }
  }
  throw new LoginDenied(`${provider} returned an untrusted verification URL`);
}
