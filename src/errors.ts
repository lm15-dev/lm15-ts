/**
 * The canonical error taxonomy (spec/vocabularies.md § ErrorCode).
 *
 * The class hierarchy SHAPE is the contract; the mechanism is the
 * language's. Here each class is a real subclass of `LM15Error`, so
 * `instanceof` works across the family, `err.code` is the ErrorCode, and
 * `err.name` is the canonical class name the vet protocol reports.
 *
 * ```
 * LM15Error
 * ├── TransportError
 * ├── LockTimeoutError
 * ├── StreamAssemblyError
 * ├── CollectionLimitError
 * ├── ConfigurationError
 * │   ├── NotConfiguredError
 * │   ├── UnknownModelError
 * │   └── AmbiguousModelError
 * ├── CapabilityError
 * │   └── UnsupportedFeatureError
 * └── ProviderError
 *     ├── AuthError
 *     ├── BillingError
 *     ├── RateLimitError
 *     ├── InvalidRequestError
 *     │   ├── ContextLengthError
 *     │   └── UnsupportedModelError
 *     ├── TimeoutError
 *     └── ServerError
 * ```
 *
 * Messages are never pinned by the contract; class and code are.
 */

import type { ErrorCode } from "./vocab.ts";
import { captureRateLimits, diagnosticsText, freezeRateLimits, millisecondsSeconds, type RateLimitHeaders } from "./rate_limits.ts";
export type { RateLimitHeaders } from "./rate_limits.ts";
import type { Response } from "./types/response.ts";

export interface ErrorMetadata {
  readonly code?: ErrorCode | undefined;
  readonly provider?: string | null | undefined;
  readonly providerCode?: string | null | undefined;
  readonly status?: number | null | undefined;
  readonly requestId?: string | null | undefined;
  /** Float-typed (Number rule); an integer input is the same value. */
  readonly retryAfter?: number | null | undefined;
  readonly cause?: unknown;
  readonly rateLimitHeaders?: RateLimitHeaders | undefined;
  readonly contentType?: string | null | undefined;
  /** Decoded text from at most the first 200 response bytes. */
  readonly bodyExcerpt?: string | null | undefined;
}

export class LM15Error extends Error {
  static readonly defaultCode: ErrorCode = "provider";

  readonly code: ErrorCode;
  readonly provider: string | null;
  readonly providerCode: string | null;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly rateLimitHeaders: RateLimitHeaders;

  constructor(message = "", meta: ErrorMetadata = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = new.target.name;
    this.code = meta.code ?? (new.target as typeof LM15Error).defaultCode;
    this.provider = meta.provider ?? null;
    this.providerCode = meta.providerCode ?? null;
    this.status = meta.status ?? null;
    this.requestId = meta.requestId ?? null;
    this.retryAfter = meta.retryAfter ?? null;
    this.rateLimitHeaders = freezeRateLimits(meta.rateLimitHeaders);
  }

  /** `RETRYABLE_ERRORS` membership: data for the caller's own retry policy. */
  get retryable(): boolean {
    return RETRYABLE_ERRORS.some((cls) => this instanceof cls);
  }
}

export class TransportError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "transport";
}

/** An invalid HTTP message or unsupported/malformed response content coding (INV-053). */
export class ProtocolError extends TransportError {}

export interface LockTimeoutMetadata extends ErrorMetadata {
  readonly path?: string;
  readonly lockPath?: string;
}

/** AUTH-4/AUTH-6: the credential-file lock could not be taken. Local, transient, retryable. */
export class LockTimeoutError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "lock_timeout";
  readonly path: string;
  readonly lockPath: string;

  constructor(message = "", meta: LockTimeoutMetadata = {}) {
    super(message, meta);
    this.path = meta.path ?? "";
    this.lockPath = meta.lockPath ?? "";
  }
}

// ─── Managed authentication (AUTH-24) ───────────────────────────────

/** The closed reasons a managed-auth lifecycle operation fails with (AUTH-24). None is a provider 401; none is automatically retryable. */
export const AUTH_OPERATION_REASONS = [
  "interaction_required", "method_unavailable", "connection_exists", "login_in_progress", "login_required",
  "connection_changed", "login_denied", "login_expired", "invalid_login_state", "attempt_unavailable",
  "indeterminate", "storage_unavailable", "unsupported_store_version", "selection_mismatch", "credential_rejected",
] as const;
export type AuthOperationReason = (typeof AUTH_OPERATION_REASONS)[number];

export const AUTH_OPERATION_STAGES = [
  "discovery", "reservation", "interaction", "authorization", "polling", "exchange",
  "persistence", "resolution", "renewal", "verification", "catalog", "dispatch",
] as const;
export type AuthOperationStage = (typeof AUTH_OPERATION_STAGES)[number];

export const AUTH_OPERATION_RECOVERIES = [
  "provide_input", "choose_method", "resume_attempt", "inspect_attempt", "restart_login",
  "select_connection", "repair_storage", "operator_action", "none",
] as const;
export type AuthOperationRecovery = (typeof AUTH_OPERATION_RECOVERIES)[number];

export const AUTH_COMMIT_STATES = ["not_committed", "committed", "unknown"] as const;
export type AuthCommitState = (typeof AUTH_COMMIT_STATES)[number];

/** AUTH-24 diagnostics: the response-format category of a failed auth exchange; never its text. */
export type AuthResponseFormat = "json" | "invalid_json" | "html" | "text_or_binary" | "empty" | "unknown";

export interface AuthOperationMetadata extends ErrorMetadata {
  readonly reason: AuthOperationReason;
  readonly stage?: AuthOperationStage;
  readonly commitState?: AuthCommitState;
  readonly recovery?: AuthOperationRecovery;
  readonly operation?: string | null;
  readonly connectionId?: string | null;
  readonly attemptId?: string | null;
  readonly methodId?: string | null;
  readonly responseFormat?: AuthResponseFormat | null;
  readonly securityChallenge?: boolean;
  /**
   * Whether the failed request reached the provider: `not_sent` only when the
   * SDK refused before sending; `unknown` when a network failure hid it (a
   * page cannot tell a CORS refusal from a dropped connection).
   */
  readonly delivery?: "not_sent" | "unknown" | null;
  /** The host a transport failure was addressed to; never a URL with a query. */
  readonly host?: string | null;
}

/**
 * A managed-auth lifecycle operation failed locally (AUTH-24). Root-level,
 * beside TransportError: nothing here is a provider HTTP reply, and nothing
 * here is safe to retry blindly. Programs match on `reason`; `commitState`
 * says whether the store changed; `recovery` is guidance, never an
 * instruction to retry. Provider text is never copied into it (AUTH-21).
 */
export class AuthOperationError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "auth_operation";
  readonly reason: AuthOperationReason;
  readonly stage: AuthOperationStage;
  readonly commitState: AuthCommitState;
  readonly recovery: AuthOperationRecovery;
  readonly operation: string | null;
  readonly connectionId: string | null;
  readonly attemptId: string | null;
  readonly methodId: string | null;
  readonly responseFormat: AuthResponseFormat | null;
  readonly securityChallenge: boolean;
  readonly delivery: "not_sent" | "unknown" | null;
  readonly host: string | null;

  constructor(message: string, meta: AuthOperationMetadata) {
    if (!(AUTH_OPERATION_REASONS as readonly string[]).includes(meta.reason)) throw new TypeError(`AuthOperationError: unknown reason ${JSON.stringify(meta.reason)}`);
    super(message, meta);
    this.reason = meta.reason;
    this.stage = meta.stage ?? "resolution";
    this.commitState = meta.commitState ?? "not_committed";
    this.recovery = meta.recovery ?? "none";
    this.operation = meta.operation ?? null;
    this.connectionId = meta.connectionId ?? null;
    this.attemptId = meta.attemptId ?? null;
    this.methodId = meta.methodId ?? null;
    this.responseFormat = meta.responseFormat ?? null;
    this.securityChallenge = meta.securityChallenge ?? false;
    this.delivery = meta.delivery ?? null;
    this.host = meta.host ?? null;
  }
}

export interface StreamAssemblyMetadata extends ErrorMetadata {
  readonly partial?: Response | null;
  readonly partIndex?: number | null;
}

/** MAP-9: a stream cannot become a Response without inventing a fact. */
export class StreamAssemblyError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "stream_assembly";
  /** Everything that did assemble, with the offending call(s) left out. */
  readonly partial: Response | null;
  /** The first offending part index. */
  readonly partIndex: number | null;

  constructor(message = "", meta: StreamAssemblyMetadata = {}) {
    super(message, meta);
    this.partial = meta.partial ?? null;
    this.partIndex = meta.partIndex ?? null;
  }
}

export class ConfigurationError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "not_configured";
}

export interface CredentialMetadata extends ErrorMetadata {
  readonly envKeys?: readonly string[];
  readonly credentialHint?: string | null;
}

export class NotConfiguredError extends ConfigurationError {
  static override readonly defaultCode: ErrorCode = "not_configured";
  readonly envKeys: readonly string[];
  readonly credentialHint: string | null;

  constructor(message = "", meta: CredentialMetadata = {}) {
    const envKeys = meta.envKeys ?? [];
    const hint = meta.credentialHint ?? null;
    let guidance = "";
    if (hint) {
      guidance = `\n\n  To fix:\n    - ${hint}\n`;
    } else if (envKeys.length > 0 || meta.provider) {
      guidance = "\n\n  To fix:\n";
      if (envKeys.length > 0) {
        guidance += `    - Pass the key explicitly (apiKey, or RouterConfig apiKeys), or on a host with an environment set ${envKeys.map((k) => `${k}=...`).join(" or ")}\n`;
      }
      if (meta.provider) guidance += `    - Configure credentials for ${meta.provider}\n`;
    }
    super(guidance ? appendGuidance(message, guidance) : message, meta);
    this.envKeys = Object.freeze([...envKeys]);
    this.credentialHint = hint;
  }
}

export interface UnknownModelMetadata extends ErrorMetadata {
  readonly model?: string;
}

/** The router: a model string that routes nowhere. Local and pre-network. */
export class UnknownModelError extends ConfigurationError {
  static override readonly defaultCode: ErrorCode = "unknown_model";
  readonly model: string;

  constructor(message = "", meta: UnknownModelMetadata = {}) {
    super(message, meta);
    this.model = meta.model ?? "";
  }
}

export interface AmbiguousModelMetadata extends ErrorMetadata {
  readonly model?: string;
  readonly providers?: readonly string[];
}

/** The router: the catalog matched under more than one provider. */
export class AmbiguousModelError extends ConfigurationError {
  static override readonly defaultCode: ErrorCode = "ambiguous_model";
  readonly model: string;
  readonly providers: readonly string[];

  constructor(message = "", meta: AmbiguousModelMetadata = {}) {
    super(message, meta);
    this.model = meta.model ?? "";
    this.providers = Object.freeze([...(meta.providers ?? [])]);
  }
}

export interface CollectionLimitMetadata extends ErrorMetadata {
  readonly limit?: string;
  readonly maximum?: number;
  readonly retainedBytes?: number;
  readonly retainedEvents?: number;
  readonly partialEvents?: readonly unknown[];
  readonly rejectedEvent?: unknown;
}

/**
 * A local collector's byte or event budget was reached
 * (changes/2026-09-15-live-collection-limits.md). Not a provider failure,
 * not retryable. Accepted events and the received-but-rejected event stay
 * available here; the underlying session is left open.
 */
export class CollectionLimitError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "collection_limit";
  /** `max_bytes` or `max_events`. */
  readonly limit: string;
  readonly maximum: number;
  readonly retainedBytes: number;
  readonly retainedEvents: number;
  /** Every accepted event, in order. */
  readonly partialEvents: readonly unknown[];
  /** A byte overflow: the event that could not fit (neither yielded nor retained). */
  readonly rejectedEvent: unknown;

  /**
   * Installed by the live module (the only producer of this error) so
   * `partial` can materialize without this module importing it. Lazy: the
   * combined text/audio is built only when asked for.
   */
  static materializePartial: ((events: readonly unknown[]) => unknown) | undefined;

  constructor(message = "", meta: CollectionLimitMetadata = {}) {
    super(message, meta);
    this.limit = meta.limit ?? "";
    this.maximum = meta.maximum ?? 0;
    this.retainedBytes = meta.retainedBytes ?? 0;
    this.retainedEvents = meta.retainedEvents ?? 0;
    this.partialEvents = Object.freeze([...(meta.partialEvents ?? [])]);
    this.rejectedEvent = meta.rejectedEvent;
  }

  /** The accepted events as an incomplete `Turn` (`endedBy: "incomplete"`, `ok: false`), materialized on demand. */
  get partial(): unknown {
    const materialize = CollectionLimitError.materializePartial;
    if (!materialize) throw new TypeError("CollectionLimitError.partial needs the live module loaded");
    return materialize(this.partialEvents);
  }
}

export interface CapabilityMetadata extends ErrorMetadata {
  /** MAP-13: the config path the refusal is about (`config.top_k`, `messages[0].parts[1]`); absent when not one addressable field. */
  readonly feature?: string | null | undefined;
}

export class CapabilityError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "unsupported_feature";
  readonly feature: string | null;

  constructor(message = "", meta: CapabilityMetadata = {}) {
    super(message, meta);
    this.feature = meta.feature ?? null;
  }
}

export class UnsupportedFeatureError extends CapabilityError {
  static override readonly defaultCode: ErrorCode = "unsupported_feature";
}

export class ProviderError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "provider";
  readonly contentType: string | null;
  readonly bodyExcerpt: string | null;

  constructor(message = "", meta: ErrorMetadata = {}) {
    super(message, meta);
    this.contentType = meta.contentType ?? null;
    this.bodyExcerpt = meta.bodyExcerpt ?? null;
  }

  /** The displayed form carries provider / HTTP status / request id. `message` stays as pinned. */
  override toString(): string {
    const context = [
      this.provider,
      this.status !== null ? `HTTP ${this.status}` : null,
      this.requestId ? `request ${this.requestId}` : null,
    ]
      .filter((x): x is string => Boolean(x))
      .join(", ");
    const base = this.message || this.code;
    const idx = base.indexOf("\n\n");
    const suffix = context ? ` (${context})` : "";
    const details = diagnosticsText(this.rateLimitHeaders, this.retryAfter);
    if (idx >= 0) return `${this.name}: ${base.slice(0, idx)}${suffix}${details}${base.slice(idx)}`;
    return `${this.name}: ${base}${suffix}${details}`;
  }
}

export class AuthError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "auth";
  readonly envKeys: readonly string[];
  readonly credentialHint: string | null;

  constructor(message = "", meta: CredentialMetadata = {}) {
    const envKeys = meta.envKeys ?? [];
    const hint = meta.credentialHint ?? null;
    let guidance: string;
    if (hint) {
      guidance = `\n\n  To fix:\n    - ${hint}\n`;
    } else {
      guidance = "\n\n  To fix:\n    - Check that your API key is correct and not expired\n";
      guidance +=
        envKeys.length > 0
          ? `    - Pass the key explicitly (apiKey, or RouterConfig apiKeys), or on a host with an environment set ${envKeys.map((k) => `${k}=...`).join(" or ")}\n`
          : "    - Pass the key explicitly (apiKey, or RouterConfig apiKeys)\n";
      if (meta.provider) guidance += `    - Verify your ${meta.provider} account/project has access\n`;
    }
    super(appendGuidance(message, guidance), meta);
    this.envKeys = Object.freeze([...envKeys]);
    this.credentialHint = hint;
  }
}

export class BillingError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "billing";
}

export class RateLimitError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "rate_limit";

  constructor(message = "", meta: ErrorMetadata = {}) {
    super(
      appendGuidance(
        message,
        "\n\n  To fix:\n    - Wait a moment and retry\n    - Retry with backoff in your application layer (lm15 never retries for you)\n    - Check the reported limits and deployment capacity; a 429 does not prove the endpoint is unsupported\n",
      ),
      meta,
    );
  }
}

export class InvalidRequestError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "invalid_request";
}

export class ContextLengthError extends InvalidRequestError {
  static override readonly defaultCode: ErrorCode = "context_length";

  constructor(message = "", meta: ErrorMetadata = {}) {
    super(
      appendGuidance(
        message,
        "\n\n  To fix:\n    - Reduce the prompt or system prompt length\n    - Clear conversation history\n    - Use a model with a larger context window\n    - Lower max_tokens to leave more room for input\n",
      ),
      meta,
    );
  }
}

export class UnsupportedModelError extends InvalidRequestError {
  static override readonly defaultCode: ErrorCode = "unsupported_model";
}

/** Provider request timed out (408/504). Named `TimeoutError` in the family; exported also as `RequestTimeoutError`. */
export class TimeoutError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "timeout";
}
export { TimeoutError as RequestTimeoutError };

export class ServerError extends ProviderError {
  static override readonly defaultCode: ErrorCode = "server";
}

/** Errors a caller's own retry policy may retry. lm15 never retries for you. */
export const RETRYABLE_ERRORS: readonly (typeof LM15Error)[] = Object.freeze([
  RateLimitError,
  TimeoutError,
  ServerError,
  TransportError,
  LockTimeoutError,
]);

const GUIDANCE_MARKER = "\n\n  To fix:";

function appendGuidance(message: string, guidance: string): string {
  if (message.includes(guidance.trim())) return message;
  return message.trimEnd() + guidance;
}

/** Rewrite an AuthError's guidance for subscription (OAuth) adapters; other errors pass through. */
export function withCredentialHint<E extends ProviderError>(error: E, hint: string): E | AuthError {
  if (!(error instanceof AuthError)) return error;
  const base = error.message.split(GUIDANCE_MARKER, 1)[0] ?? "";
  return new AuthError(base, {
    provider: error.provider,
    credentialHint: hint,
    providerCode: error.providerCode,
    status: error.status,
    requestId: error.requestId,
    retryAfter: error.retryAfter,
    rateLimitHeaders: error.rateLimitHeaders,
    contentType: error.contentType,
    bodyExcerpt: error.bodyExcerpt,
    cause: error.cause,
  });
}

export interface ReplyMetadataSource {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

/** Header-only diagnostics, shared by malformed JSON and auxiliary endpoints. */
export function responseErrorMetadata(response: ReplyMetadataSource, provider?: string): ErrorMetadata {
  const header = (name: string) => response.headers.find(([k]) => k.toLowerCase() === name)?.[1];
  let requestId: string | undefined;
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "x-amz-request-id", "x-ms-request-id", "apim-request-id", "x-typesafe-request-id"]) {
    requestId = header(name);
    if (requestId) break;
  }
  let retryAfter: number | undefined;
  const raw = header("retry-after");
  if (raw?.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) { if (n >= 0) retryAfter = n; }
    else {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) retryAfter = Math.max(0, (date - Date.now()) / 1000);
    }
  }
  retryAfter ??= millisecondsSeconds(header("retry-after-ms")) ?? millisecondsSeconds(header("x-ms-retry-after-ms"));
  return { status: response.status, provider, requestId, retryAfter, rateLimitHeaders: captureRateLimits(response.headers), contentType: header("content-type") };
}

/** INV-054: preserve evidence without claiming a 2xx was a server error. */
export function malformedJsonError(response: ReplyMetadataSource, cause?: unknown, provider?: string): ProviderError {
  const meta = responseErrorMetadata(response, provider);
  const bodyExcerpt = new TextDecoder().decode(response.body.subarray(0, 200));
  return new ProviderError(
    `HTTP ${response.status} reply is not valid JSON (content-type ${JSON.stringify(meta.contentType ?? "<absent>")}; first 200 bytes: ${JSON.stringify(bodyExcerpt)})`,
    { ...meta, bodyExcerpt, cause },
  );
}

export interface HttpErrorMetadata {
  readonly provider?: string | null;
  readonly envKeys?: readonly string[];
  readonly providerCode?: string | null;
  readonly requestId?: string | null;
  readonly retryAfter?: number | null;
}

/** HTTP status → typed ProviderError. Providers extract message/code first. */
export function mapHttpError(status: number, message: string, meta: HttpErrorMetadata = {}): ProviderError {
  const m: CredentialMetadata = {
    provider: meta.provider || null,
    providerCode: meta.providerCode || null,
    status,
    requestId: meta.requestId || null,
    retryAfter: meta.retryAfter ?? null,
  };
  if (status === 401 || status === 403) return new AuthError(message, { ...m, envKeys: meta.envKeys ?? [] });
  if (status === 402) return new BillingError(message, m);
  if (status === 408 || status === 504) return new TimeoutError(message, m);
  if (status === 429) return new RateLimitError(message, m);
  if ([400, 404, 409, 413, 422].includes(status)) return new InvalidRequestError(message, m);
  if (status >= 500 && status <= 599) return new ServerError(message, m);
  return new ProviderError(message, m);
}

/** Most-specific-class-first: the code an error instance or class stands for. */
const CLASS_TO_CODE: ReadonlyArray<readonly [typeof LM15Error, ErrorCode]> = [
  [ContextLengthError, "context_length"],
  [UnsupportedModelError, "unsupported_model"],
  [AuthError, "auth"],
  [BillingError, "billing"],
  [RateLimitError, "rate_limit"],
  [InvalidRequestError, "invalid_request"],
  [TimeoutError, "timeout"],
  [ServerError, "server"],
  [UnsupportedFeatureError, "unsupported_feature"],
  [NotConfiguredError, "not_configured"],
  [UnknownModelError, "unknown_model"],
  [AmbiguousModelError, "ambiguous_model"],
  [TransportError, "transport"],
  [LockTimeoutError, "lock_timeout"],
  [AuthOperationError, "auth_operation"],
  [StreamAssemblyError, "stream_assembly"],
  [CollectionLimitError, "collection_limit"],
  [ProviderError, "provider"],
];

export function canonicalErrorCode(error: LM15Error | typeof LM15Error): ErrorCode {
  const isClass = typeof error === "function";
  for (const [cls, code] of CLASS_TO_CODE) {
    if (isClass ? error === cls || error.prototype instanceof cls : error instanceof cls) return code;
  }
  return isClass ? error.defaultCode : error.code;
}

export function errorClassForCode(code: string): typeof LM15Error {
  for (const [cls, c] of CLASS_TO_CODE) if (c === code) return cls;
  return ProviderError;
}

/**
 * MAP-15: the pinned forms of a provider's "no such model" answer that carry no
 * model-specific code and no not-found class (lm15-contract
 * spec/model-not-found.json, carried verbatim; each form has a live receipt).
 */
export const MODEL_NOT_FOUND_FORMS: readonly { code: string; prefix?: string; contains?: string; suffix?: string }[] = Object.freeze([
  { code: "not_found_error", prefix: "model: " }, // Anthropic, Claude Code
  { code: "invalid_request_error", contains: "The supported API model names are " }, // DeepSeek
  { code: "1211" }, // Z.AI: Unknown Model
  { code: "1214", prefix: "modelCode: " }, // Z.AI: the model field is invalid
  { code: "400", suffix: " is not a valid model ID" }, // OpenRouter
  { code: "invalid-argument", prefix: "Model not found: " }, // xAI (2026-09-01)
  { code: "validation_error", contains: "The provided model identifier is invalid" }, // Bedrock Chat
  { code: "invalid_request_error", prefix: "Deployment ", suffix: " doesn't exist or isn't accessible." }, // Parasail
]);

/** True when the error is one of the pinned MAP-15 forms: exact code, and every text test the form gives. */
export function isPinnedModelNotFound(providerCode: string | null | undefined, message: string | null | undefined): boolean {
  if (!providerCode) return false;
  const text = message ?? "";
  return MODEL_NOT_FOUND_FORMS.some((f) =>
    f.code === providerCode &&
    (f.prefix === undefined || text.startsWith(f.prefix)) &&
    (f.contains === undefined || text.includes(f.contains)) &&
    (f.suffix === undefined || text.endsWith(f.suffix)));
}
