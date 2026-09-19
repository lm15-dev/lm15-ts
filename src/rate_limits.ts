/** Bounded raw evidence, not a quota model. Contract: docs/error-diagnostics.md. */
import type { JsonObject } from "./json.ts";
import { requireFloat } from "./types/validate.ts";

export type RateLimitHeaders = Readonly<Record<string, readonly string[]>>;
const names = new Set([
  "retry-after", "retry-after-ms", "x-ms-retry-after-ms",
  "x-ratelimit-type", "x-ratelimit-abusepenalty-active",
]);
for (const field of ["limit", "remaining", "reset", "renewalperiod"])
  for (const unit of ["requests", "tokens"]) names.add(`x-ratelimit-${field}-${unit}`);
for (const unit of ["requests", "tokens", "input-tokens", "output-tokens"])
  for (const field of ["limit", "remaining", "reset"]) names.add(`anthropic-ratelimit-${unit}-${field}`);

export function captureRateLimits(headers: ReadonlyArray<readonly [string, string]>): RateLimitHeaders {
  const out: Record<string, string[]> = {};
  for (const [rawName, value] of headers) {
    if (typeof rawName !== "string" || typeof value !== "string") continue;
    const name = rawName.toLowerCase();
    if (!names.has(name) || !/^[\x20-\x7e]{1,256}$/.test(value)) continue;
    const values = out[name] ?? (out[name] = []);
    if (values.length < 4) values.push(value);
  }
  for (const values of Object.values(out)) Object.freeze(values);
  return Object.freeze(out);
}

export function freezeRateLimits(value: unknown): RateLimitHeaders {
  if (!value || typeof value !== "object" || Array.isArray(value)) return captureRateLimits([]);
  const pairs: [string, string][] = [];
  for (const [name, values] of Object.entries(value))
    if (Array.isArray(values)) for (const v of values) if (typeof v === "string") pairs.push([name, v]);
  return captureRateLimits(pairs);
}

export function millisecondsSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n / 1000 : undefined;
}

export function normalizeHttpResponse(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ErrorDetail.http_response must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["request_id", "retry_after", "rate_limit_headers"].includes(k))) throw new TypeError("unknown ErrorDetail.http_response field");
  const out: JsonObject = {};
  if (input["request_id"] != null) {
    if (typeof input["request_id"] !== "string" || !input["request_id"]) throw new TypeError("http_response.request_id must be a non-empty string");
    out["request_id"] = input["request_id"];
  }
  if (input["retry_after"] != null) {
    const wait = requireFloat(input["retry_after"], "http_response.retry_after");
    if (!Number.isFinite(wait) || wait < 0) throw new TypeError("http_response.retry_after must be finite nonnegative seconds");
    out["retry_after"] = wait;
  }
  if ("rate_limit_headers" in input) {
    const headers = input["rate_limit_headers"];
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some(v => !Array.isArray(v) || v.some(s => typeof s !== "string"))) throw new TypeError("http_response.rate_limit_headers must map names to string arrays");
    const snapshot = freezeRateLimits(headers);
    if (Object.keys(snapshot).length) out["rate_limit_headers"] = Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, [...v]]));
  }
  return out;
}

export function diagnosticsText(snapshot: RateLimitHeaders, retryAfter: number | null): string {
  const pieces: string[] = [];
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0)
    pieces.push(`Retry advice: ${retryAfter} seconds (not a guarantee).`);
  if (Object.keys(snapshot).length) {
    let raw = JSON.stringify(Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))));
    if (raw.length > 2048) raw = raw.slice(0, 2048) + "... [full retained values in rateLimitHeaders]";
    pieces.push("Provider rate-limit headers (raw; advisory): " + raw);
  }
  return pieces.length ? "\n\n  " + pieces.join("\n  ") : "";
}
