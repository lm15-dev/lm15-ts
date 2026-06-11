/**
 * lm15 canonical error hierarchy (spec/vocabularies.md "ErrorCode").
 *
 * The class SHAPE is contract; the mechanism (JS Error subclasses) is
 * idiomatic. `error.name` is the canonical class name reported on the vet
 * protocol. Validation failures raised by constructors/serde use
 * `ValueError` / `TypeErrorEx` whose names mirror the reference's native
 * exception names (`ValueError`, `TypeError`) per PROTOCOL.md.
 */

export type ErrorCode =
  | "auth"
  | "billing"
  | "rate_limit"
  | "invalid_request"
  | "context_length"
  | "timeout"
  | "server"
  | "unsupported_model"
  | "unsupported_feature"
  | "not_configured"
  | "transport"
  | "provider";

export interface LM15ErrorOptions {
  code?: ErrorCode | null;
  provider?: string | null;
  providerCode?: string | null;
  status?: number | null;
  requestId?: string | null;
  retryAfter?: number | null;
}

export class LM15Error extends Error {
  readonly code: ErrorCode | null;
  readonly provider: string | null;
  readonly providerCode: string | null;
  readonly status: number | null;
  readonly requestId: string | null;
  /** Float-typed per the Number rule. */
  readonly retryAfter: number | null;

  constructor(message: string, options: LM15ErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? null;
    this.provider = options.provider ?? null;
    this.providerCode = options.providerCode ?? null;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
}

export class TransportError extends LM15Error {}
export class ConfigurationError extends LM15Error {}
export class NotConfiguredError extends ConfigurationError {}
export class CapabilityError extends LM15Error {}
export class UnsupportedFeatureError extends CapabilityError {}
export class ProviderError extends LM15Error {}
export class AuthError extends ProviderError {}
export class BillingError extends ProviderError {}
export class RateLimitError extends ProviderError {}
export class InvalidRequestError extends ProviderError {}
export class ContextLengthError extends InvalidRequestError {}
export class UnsupportedModelError extends InvalidRequestError {}
/** Canonical class name on the wire is `TimeoutError` (vocabularies.md). */
export class RequestTimeoutError extends ProviderError {
  constructor(message: string, options: LM15ErrorOptions = {}) {
    super(message, options);
    this.name = "TimeoutError";
  }
}
export class ServerError extends ProviderError {}

/** ErrorCode -> canonical class, most specific first (vocabularies.md). */
export const ERROR_CODE_CLASSES: Record<ErrorCode, typeof LM15Error> = {
  auth: AuthError,
  billing: BillingError,
  rate_limit: RateLimitError,
  invalid_request: InvalidRequestError,
  context_length: ContextLengthError,
  timeout: RequestTimeoutError,
  server: ServerError,
  unsupported_model: UnsupportedModelError,
  unsupported_feature: UnsupportedFeatureError,
  not_configured: NotConfiguredError,
  transport: TransportError,
  provider: ProviderError,
};

export const ERROR_CODES: readonly ErrorCode[] = Object.keys(
  ERROR_CODE_CLASSES,
) as ErrorCode[];

export function canonicalErrorCode(err: LM15Error): ErrorCode {
  if (err.code !== null) return err.code;
  if (err instanceof ContextLengthError) return "context_length";
  if (err instanceof UnsupportedModelError) return "unsupported_model";
  if (err instanceof AuthError) return "auth";
  if (err instanceof BillingError) return "billing";
  if (err instanceof RateLimitError) return "rate_limit";
  if (err instanceof InvalidRequestError) return "invalid_request";
  if (err instanceof RequestTimeoutError) return "timeout";
  if (err instanceof ServerError) return "server";
  if (err instanceof UnsupportedFeatureError) return "unsupported_feature";
  if (err instanceof NotConfiguredError) return "not_configured";
  if (err instanceof TransportError) return "transport";
  return "provider";
}

// ─── Validation errors (native-exception analogues) ─────────────────

/** Mirrors Python's ValueError on the vet protocol (`error.type`). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Mirrors Python's TypeError on the vet protocol (`error.type`). */
export class TypeErrorEx extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}
