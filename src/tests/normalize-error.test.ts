import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeError, normalizedErrorToDict } from "../normalize-error.js";
import {
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  UnsupportedModelError,
  ValueError,
} from "../errors.js";

function dict(provider: string, status: number, body: unknown) {
  return normalizedErrorToDict(
    normalizeError(provider, status, typeof body === "string" ? body : JSON.stringify(body)),
  );
}

test("openai auth via code", () => {
  const d = dict("openai", 401, {
    error: { message: "Incorrect API key provided", type: "authentication_error", code: "invalid_api_key" },
  });
  assert.deepEqual(d, {
    class: "AuthError",
    code: "auth",
    provider_code: "invalid_api_key",
    message: "Incorrect API key provided",
  });
});

test("openai billing quota beats 429 rate limit", () => {
  const d = dict("openai", 429, {
    error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
  });
  assert.equal(d.class, "BillingError");
  assert.equal(d.code, "billing");
});

test("openai context length", () => {
  const err = normalizeError(
    "openai",
    400,
    JSON.stringify({ error: { message: "max context length", type: "invalid_request_error", code: "context_length_exceeded" } }),
  );
  assert.ok(err instanceof ContextLengthError);
  assert.equal(err.providerCode, "context_length_exceeded");
});

test("openai model not found at 404", () => {
  const err = normalizeError(
    "openai",
    404,
    JSON.stringify({ error: { message: "The model `gpt-missing` does not exist", type: "invalid_request_error", code: "model_not_found" } }),
  );
  assert.ok(err instanceof UnsupportedModelError);
});

test("openai_chat shares the openai normalizer", () => {
  const d = dict("openai_chat", 429, {
    error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" },
  });
  assert.equal(d.class, "RateLimitError");
  assert.equal(d.provider_code, "rate_limit_exceeded");
});

test("anthropic carries request_id and maps types", () => {
  const err = normalizeError(
    "anthropic",
    429,
    JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit exceeded" }, request_id: "req_rl" }),
  );
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.requestId, "req_rl");
});

test("anthropic context-length sniff beats invalid_request_error", () => {
  const err = normalizeError(
    "anthropic",
    400,
    JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long: token limit exceeded" } }),
  );
  assert.ok(err instanceof ContextLengthError);
});

test("anthropic 529 overloaded is ServerError", () => {
  const err = normalizeError(
    "anthropic",
    529,
    JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }),
  );
  assert.ok(err instanceof ServerError);
});

test("gemini status map and model sniff", () => {
  assert.ok(
    normalizeError("gemini", 403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "API key not valid" } })) instanceof AuthError,
  );
  assert.ok(
    normalizeError("gemini", 404, JSON.stringify({ error: { status: "NOT_FOUND", message: "models/x is not found" } })) instanceof UnsupportedModelError,
  );
  assert.ok(
    normalizeError("gemini", 400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "input token count exceeds the model limit" } })) instanceof ContextLengthError,
  );
});

test("gemini DEADLINE_EXCEEDED reports class TimeoutError", () => {
  const err = normalizeError(
    "gemini",
    504,
    JSON.stringify({ error: { status: "DEADLINE_EXCEEDED", message: "deadline" } }),
  );
  assert.ok(err instanceof RequestTimeoutError);
  assert.equal(normalizedErrorToDict(err).class, "TimeoutError");
  assert.equal(normalizedErrorToDict(err).code, "timeout");
});

test("non-JSON body falls back to HTTP status mapping", () => {
  const err = normalizeError("anthropic", 500, "<html>boom</html>");
  assert.ok(err instanceof ServerError);
  assert.equal(err.message, "<html>boom</html>");
  assert.equal(err.providerCode, null);
});

test("unmatched status is ProviderError, empty body gets HTTP message", () => {
  const err = normalizeError("openai", 418, "");
  assert.equal(err.constructor, ProviderError);
  assert.equal(err.message, "HTTP 418");
});

test("unknown provider raises ValueError", () => {
  assert.throws(() => normalizeError("mystery", 500, "{}"), ValueError);
});
