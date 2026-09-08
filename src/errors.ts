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
}

export class LM15Error extends Error {
  static readonly defaultCode: ErrorCode = "provider";

  readonly code: ErrorCode;
  readonly provider: string | null;
  readonly providerCode: string | null;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(message = "", meta: ErrorMetadata = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = new.target.name;
    this.code = meta.code ?? (new.target as typeof LM15Error).defaultCode;
    this.provider = meta.provider ?? null;
    this.providerCode = meta.providerCode ?? null;
    this.status = meta.status ?? null;
    this.requestId = meta.requestId ?? null;
    this.retryAfter = meta.retryAfter ?? null;
  }

  /** `RETRYABLE_ERRORS` membership: data for the caller's own retry policy. */
  get retryable(): boolean {
    return RETRYABLE_ERRORS.some((cls) => this instanceof cls);
  }
}

export class TransportError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "transport";
}

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
        guidance += `    - Set the provider API key in your environment: ${envKeys.map((k) => `${k}=...`).join(" or ")}\n`;
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

export class CapabilityError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "unsupported_feature";
}

export class UnsupportedFeatureError extends CapabilityError {
  static override readonly defaultCode: ErrorCode = "unsupported_feature";
}

export class ProviderError extends LM15Error {
  static override readonly defaultCode: ErrorCode = "provider";

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
    if (!context) return `${this.name}: ${base}`;
    const idx = base.indexOf("\n\n");
    const suffix = ` (${context})`;
    if (idx >= 0) return `${this.name}: ${base.slice(0, idx)}${suffix}${base.slice(idx)}`;
    return `${this.name}: ${base}${suffix}`;
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
          ? `    - Set the provider API key in your environment: ${envKeys.map((k) => `${k}=...`).join(" or ")}\n`
          : "    - Set the provider API key in your environment\n";
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
        "\n\n  To fix:\n    - Wait a moment and retry\n    - Retry with backoff in your application layer (lm15 never retries for you)\n    - Reduce request rate or upgrade your API plan\n",
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
  });
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
  [StreamAssemblyError, "stream_assembly"],
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
