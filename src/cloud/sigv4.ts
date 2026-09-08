/**
 * AWS Signature Version 4 (spec/auth.md AUTH-11), pinned by the AWS test
 * suite in `auth/sigv4-vectors.json`: canonical request, string to sign,
 * and the `Authorization` header byte for byte under a fixed clock.
 */

import { createHash, createHmac } from "node:crypto";
import type { AwsCredentials } from "../types/credential.ts";
import { percentEncode } from "../wire.ts";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SigV4Signature {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly authorization: string;
  /** Every header to send, lowercase names, including the new ones. */
  readonly headers: Readonly<Record<string, string>>;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 §5.2.4 as the AWS SDKs apply it to non-S3 paths. */
function removeDotSegments(path: string): string {
  const kept: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") kept.pop();
    else if (segment && segment !== ".") kept.push(segment);
  }
  const first = path.startsWith("/") ? "/" : "";
  const last = path.endsWith("/") && kept.length > 0 ? "/" : "";
  return first + kept.join("/") + last;
}

function canonicalPath(path: string): string {
  if (!path) return "/";
  const normalized = removeDotSegments(path) || "/";
  return normalized
    .split("/")
    .map((seg) => percentEncode(safeDecode(seg)))
    .join("/");
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function canonicalQuery(query: string): string {
  if (!query) return "";
  const pairs: Array<[string, string]> = [];
  for (const item of query.split("&")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    const k = eq < 0 ? item : item.slice(0, eq);
    const v = eq < 0 ? "" : item.slice(eq + 1);
    pairs.push([percentEncode(safeDecode(k.replace(/\+/g, " "))), percentEncode(safeDecode(v.replace(/\+/g, " ")))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function trim(value: string): string {
  return value.split(/\s+/).filter((x) => x !== "").join(" ");
}

function splitUrlParts(url: string): { netloc: string; path: string; query: string } {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url);
  if (!m) throw new Error(`sigv4: cannot parse URL ${url}`);
  return { netloc: m[1] ?? "", path: m[2] ?? "", query: m[3] ?? "" };
}

/** `[canonicalRequest, signedHeaders]` for already-complete headers. */
export function canonicalize(method: string, url: string, headers: Record<string, string>, payload: Uint8Array): [string, string] {
  const parts = splitUrlParts(url);
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = trim(v);
  const names = Object.keys(lowered).sort();
  const signed = names.join(";");
  const canonicalHeaders = names.map((k) => `${k}:${lowered[k]}\n`).join("");
  const canonical = [method.toUpperCase(), canonicalPath(parts.path), canonicalQuery(parts.query), canonicalHeaders, signed, sha256Hex(payload)].join("\n");
  return [canonical, signed];
}

function amzDate(now: Date): [string, string] {
  const iso = now.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return [`${date}T${time}Z`, date];
}

export interface SignOptions {
  readonly method: string;
  readonly url: string;
  /** The caller's headers (any case). */
  readonly headers: Record<string, string>;
  readonly payload: Uint8Array;
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  readonly now: Date;
}

export function sign(opts: SignOptions): SigV4Signature {
  const [xAmzDate, date] = amzDate(opts.now);
  const parts = splitUrlParts(opts.url);
  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) if (k.toLowerCase() !== "authorization") toSign[k.toLowerCase()] = v;
  toSign["host"] = parts.netloc;
  toSign["x-amz-date"] = xAmzDate;
  delete toSign["x-amz-security-token"];
  if (opts.credentials.sessionToken) toSign["x-amz-security-token"] = opts.credentials.sessionToken;

  const [canonical, signed] = canonicalize(opts.method, opts.url, toSign, opts.payload);
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [ALGORITHM, xAmzDate, scope, sha256Hex(canonical)].join("\n");

  let key: Uint8Array | string = `AWS4${opts.credentials.secretAccessKey}`;
  for (const piece of [date, opts.region, opts.service, "aws4_request"]) key = hmac(key, piece);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const authorization = `${ALGORITHM} Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(toSign)) headers[k] = trim(v);
  headers["authorization"] = authorization;
  return { canonicalRequest: canonical, stringToSign, authorization, headers };
}
