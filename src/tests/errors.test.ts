import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError, BillingError, RateLimitError, ServerError,
  InvalidRequestError, ContextLengthError, TimeoutError,
  mapHttpError, canonicalErrorCode,
} from "../errors.js";

describe("mapHttpError", () => {
  it("maps 401 to AuthError", () => {
    assert.ok(mapHttpError(401, "bad key") instanceof AuthError);
  });

  it("maps 402 to BillingError", () => {
    assert.ok(mapHttpError(402, "no funds") instanceof BillingError);
  });

  it("maps 429 to RateLimitError", () => {
    assert.ok(mapHttpError(429, "slow down") instanceof RateLimitError);
  });

  it("maps 500 to ServerError", () => {
    assert.ok(mapHttpError(500, "oops") instanceof ServerError);
  });

  it("maps 400 to InvalidRequestError", () => {
    assert.ok(mapHttpError(400, "bad") instanceof InvalidRequestError);
  });

  it("maps 408 to TimeoutError", () => {
    assert.ok(mapHttpError(408, "timeout") instanceof TimeoutError);
  });
});

describe("canonicalErrorCode", () => {
  it("returns correct codes", () => {
    assert.equal(canonicalErrorCode(new AuthError("")), "auth");
    assert.equal(canonicalErrorCode(new BillingError("")), "billing");
    assert.equal(canonicalErrorCode(new RateLimitError("")), "rate_limit");
    assert.equal(canonicalErrorCode(new ContextLengthError("")), "context_length");
    assert.equal(canonicalErrorCode(new InvalidRequestError("")), "invalid_request");
    assert.equal(canonicalErrorCode(new TimeoutError("")), "timeout");
    assert.equal(canonicalErrorCode(new ServerError("")), "server");
  });
});
