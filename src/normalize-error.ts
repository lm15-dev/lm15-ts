/**
 * Provider error normalization (PROTOCOL.md `normalize_error`).
 *
 * Maps a provider's HTTP error response (status + body text) onto the
 * canonical error hierarchy (spec/vocabularies.md ErrorCode table).
 * Classification heuristics (context-length / model-not-found message
 * sniffing, provider code maps) follow the Python reference
 * (lm15-python2/lm15/providers/{openai,anthropic,gemini,openai_chat}.py)
 * where the spec is silent.
 */

import {
  AuthError,
  BillingError,
  ContextLengthError,
  InvalidRequestError,
  LM15Error,
  ProviderError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  UnsupportedModelError,
  ValueError,
  canonicalErrorCode,
} from "./errors.js";

export type ErrorProvider = "openai" | "openai_chat" | "anthropic" | "gemini";

export type ErrorClass = new (message: string, options?: ConstructorParameters<typeof LM15Error>[1]) => ProviderError;

interface ParsedBody {
  readonly message: string;
  readonly code: string; // provider code/type/status discriminator
  readonly requestId: string | null;
}

// ─── Shared helpers ──────────────────────────────────────────────────

const MODEL_ERROR_MARKERS = [
  "not found",
  "does not exist",
  "not exist",
  "not supported",
  "unsupported",
  "not available",
  "unknown",
] as const;

export function isModelError(...values: string[]): boolean {
  const lowered = values.filter((v) => v).join(" ").toLowerCase();
  return lowered.includes("model") && MODEL_ERROR_MARKERS.some((m) => lowered.includes(m));
}

/** anthropic/openai variant of the context-length sniff. */
export function isContextLengthMessage(msg: string): boolean {
  const lowered = msg.toLowerCase();
  return (
    lowered.includes("prompt is too long") ||
    lowered.includes("too many tokens") ||
    lowered.includes("context window") ||
    lowered.includes("context length") ||
    (lowered.includes("token") && (lowered.includes("limit") || lowered.includes("exceed")))
  );
}

/** gemini variant. */
export function isGeminiContextLengthMessage(msg: string): boolean {
  const lowered = msg.toLowerCase();
  return (
    (lowered.includes("token") && (lowered.includes("limit") || lowered.includes("exceed"))) ||
    lowered.includes("too long") ||
    lowered.includes("context is too long") ||
    lowered.includes("context length")
  );
}

function mapHttpError(
  status: number,
  message: string,
  provider: ErrorProvider,
  providerCode: string | null,
  requestId: string | null,
): ProviderError {
  const opts = { provider, providerCode, status, requestId } as const;
  if (status === 401 || status === 403) return new AuthError(message, opts);
  if (status === 402) return new BillingError(message, opts);
  if (status === 408 || status === 504) return new RequestTimeoutError(message, opts);
  if (status === 429) return new RateLimitError(message, opts);
  if ([400, 404, 409, 413, 422].includes(status)) return new InvalidRequestError(message, opts);
  if (status >= 500 && status <= 599) return new ServerError(message, opts);
  return new ProviderError(message, opts);
}

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function fallbackMessage(body: string, status: number): string {
  const trimmed = body.trim().slice(0, 500);
  return trimmed || `HTTP ${status}`;
}

function build(
  cls: ErrorClass,
  message: string,
  provider: ErrorProvider,
  status: number,
  providerCode: string | null,
  requestId: string | null,
): ProviderError {
  return new cls(message || providerCode || "provider error", {
    provider,
    providerCode,
    status,
    requestId,
  });
}

// ─── openai / openai_chat ────────────────────────────────────────────

function normalizeOpenAI(provider: ErrorProvider, status: number, body: string): ProviderError {
  const data = asObject(tryParse(body));
  if (data === null) {
    return mapHttpError(status, fallbackMessage(body, status), provider, null, null);
  }
  const errRaw = data["error"];
  const err = asObject(errRaw);
  let msg = err !== null ? str(err["message"]) : str(errRaw ?? "");
  const code = err !== null ? str(err["code"] ?? "") : "";
  const errType = err !== null ? str(err["type"] ?? "") : "";
  const providerCode = code || errType || null;

  if (code === "context_length_exceeded") {
    return build(ContextLengthError, msg, provider, status, providerCode, null);
  }
  const modelCodes = ["model_not_found", "model_not_available", "unsupported_model"];
  if (modelCodes.includes(code) || (status === 404 && isModelError(msg, code, errType))) {
    return build(UnsupportedModelError, msg, provider, status, providerCode, null);
  }
  if (code === "insufficient_quota" || errType === "insufficient_quota") {
    return build(BillingError, msg, provider, status, providerCode, null);
  }
  if (code === "invalid_api_key" || errType === "authentication_error") {
    return build(AuthError, msg, provider, status, providerCode, null);
  }
  if (code === "rate_limit_exceeded" || errType === "rate_limit_error") {
    return build(RateLimitError, msg, provider, status, providerCode, null);
  }
  if (code && !msg.includes(code)) msg = `${msg} (${code})`;
  return mapHttpError(status, msg, provider, providerCode, null);
}

// ─── anthropic ───────────────────────────────────────────────────────

export const ANTHROPIC_TYPE_MAP: Record<string, ErrorClass> = {
  authentication_error: AuthError,
  permission_error: AuthError,
  billing_error: BillingError,
  rate_limit_error: RateLimitError,
  request_too_large: InvalidRequestError,
  not_found_error: InvalidRequestError,
  invalid_request_error: InvalidRequestError,
  api_error: ServerError,
  overloaded_error: ServerError,
  timeout_error: RequestTimeoutError,
};

function normalizeAnthropic(status: number, body: string): ProviderError {
  const data = asObject(tryParse(body));
  if (data === null) {
    return mapHttpError(status, fallbackMessage(body, status), "anthropic", null, null);
  }
  const errRaw = data["error"];
  const err = asObject(errRaw);
  let msg = err !== null ? str(err["message"]) : str(errRaw ?? "");
  const errType = err !== null ? str(err["type"] ?? "") : "";
  const requestId = str(data["request_id"] ?? "") || null;
  const providerCode = errType || null;

  if (isContextLengthMessage(msg)) {
    return build(ContextLengthError, msg, "anthropic", status, providerCode, requestId);
  }
  if (errType === "not_found_error" && isModelError(msg)) {
    return build(UnsupportedModelError, msg, "anthropic", status, errType, requestId);
  }
  const cls = ANTHROPIC_TYPE_MAP[errType];
  if (cls !== undefined) {
    return build(cls, msg, "anthropic", status, providerCode, requestId);
  }
  if (errType && !msg.includes(errType)) msg = `${msg} (${errType})`;
  return mapHttpError(status, msg, "anthropic", providerCode, requestId);
}

// ─── gemini ──────────────────────────────────────────────────────────

export const GEMINI_STATUS_MAP: Record<string, ErrorClass> = {
  INVALID_ARGUMENT: InvalidRequestError,
  FAILED_PRECONDITION: BillingError,
  PERMISSION_DENIED: AuthError,
  UNAUTHENTICATED: AuthError,
  NOT_FOUND: InvalidRequestError,
  RESOURCE_EXHAUSTED: RateLimitError,
  INTERNAL: ServerError,
  UNAVAILABLE: ServerError,
  DEADLINE_EXCEEDED: RequestTimeoutError,
};

function normalizeGemini(status: number, body: string): ProviderError {
  const data = asObject(tryParse(body));
  if (data === null) {
    return mapHttpError(status, fallbackMessage(body, status), "gemini", null, null);
  }
  const errRaw = data["error"];
  const err = asObject(errRaw);
  let msg = err !== null ? str(err["message"]) : str(errRaw ?? "");
  const errStatus = err !== null ? str(err["status"] ?? "") : "";
  const providerCode = errStatus || null;

  if (isGeminiContextLengthMessage(msg)) {
    return build(ContextLengthError, msg, "gemini", status, providerCode, null);
  }
  if (errStatus === "NOT_FOUND" && isModelError(msg)) {
    return build(UnsupportedModelError, msg, "gemini", status, errStatus, null);
  }
  const cls = GEMINI_STATUS_MAP[errStatus];
  if (cls !== undefined) {
    return build(cls, msg, "gemini", status, providerCode, null);
  }
  if (errStatus && !msg.includes(errStatus)) msg = `${msg} (${errStatus})`;
  return mapHttpError(status, msg, "gemini", providerCode, null);
}

// ─── Entry point ─────────────────────────────────────────────────────

export function normalizeError(provider: string, status: number, body: string): ProviderError {
  switch (provider) {
    case "openai":
    case "openai_chat":
      return normalizeOpenAI(provider, status, body);
    case "anthropic":
      return normalizeAnthropic(status, body);
    case "gemini":
      return normalizeGemini(status, body);
    default:
      throw new ValueError(`unknown provider: ${provider}`);
  }
}

/** Shape returned on the vet protocol for `normalize_error`. */
export function normalizedErrorToDict(err: ProviderError): {
  class: string;
  code: string;
  provider_code: string | null;
  message: string;
} {
  return {
    class: err.name,
    code: err.code ?? canonicalErrorCode(err),
    provider_code: err.providerCode,
    message: err.message,
  };
}
