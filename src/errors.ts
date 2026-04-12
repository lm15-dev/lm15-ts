/**
 * lm15 error hierarchy.
 *
 * Conforms to https://github.com/lm15-dev/spec/blob/main/types.md#error-hierarchy
 */

export class ULMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ULMError";
  }
}

export class TransportError extends ULMError {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class ProviderError extends ULMError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export class AuthError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class BillingError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class InvalidRequestError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class ContextLengthError extends InvalidRequestError {
  constructor(message: string) {
    super(message);
    this.name = "ContextLengthError";
  }
}

export class TimeoutError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ServerError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

export class UnsupportedModelError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedModelError";
  }
}

export class UnsupportedFeatureError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFeatureError";
  }
}

export class NotConfiguredError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** Map an HTTP status code to a typed ProviderError. */
export function mapHttpError(status: number, message: string): ProviderError {
  if (status === 401 || status === 403) return new AuthError(message);
  if (status === 402) return new BillingError(message);
  if (status === 408 || status === 504) return new TimeoutError(message);
  if (status === 429) return new RateLimitError(message);
  if ([400, 404, 409, 413, 422].includes(status)) return new InvalidRequestError(message);
  if (status >= 500 && status <= 599) return new ServerError(message);
  return new ProviderError(message);
}

/** Map an error class to its canonical lm15 error code. */
export function canonicalErrorCode(error: Error): string {
  if (error instanceof ContextLengthError) return "context_length";
  if (error instanceof AuthError) return "auth";
  if (error instanceof BillingError) return "billing";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof InvalidRequestError) return "invalid_request";
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof ServerError) return "server";
  return "provider";
}
