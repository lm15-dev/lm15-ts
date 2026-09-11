/**
 * Wire-level building blocks shared by every dialect: the transport request
 * and response values, JSON request building, URL/path encoding (MAP-11),
 * multipart bodies, timestamps, and the MAP-10 tool-result media policy.
 */

import { UnsupportedFeatureError, ProviderError } from "./errors.ts";
import { isJsonObject, parseJsonBytes, stringifyJson, type JsonObject, type JsonValue } from "./json.ts";
import { getDefaultPlatform, noFilesystem } from "./platform.ts";
import type { FileReadiness } from "./vocab.ts";
import { ModelInfo } from "./types/model_info.ts";
import type { MediaPart, Message, Part, ToolResultPart } from "./types/parts.ts";
import { type TokenLogprob, normalizeTokenLogprob } from "./types/response.ts";
import { ValueError, encodeBase64 } from "./types/validate.ts";

const UTF8 = new TextEncoder();
const UTF8_DECODE = new TextDecoder("utf-8", { fatal: false });

/** The request a dialect built: what goes on the wire, before the transport. */
export interface TransportRequest {
  readonly method: string;
  /** Full URL including the query string. */
  readonly url: string;
  /** Ordered header pairs; names as the dialect spelled them. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  /** Seconds. Requires a custom transport; platform fetch has no separate connect timer. */
  readonly connectTimeout?: number;
  /** Per-chunk idle timeout in seconds, overriding the transport default. */
  readonly readTimeout?: number;
}

/** A buffered provider-level HTTP response. */
export class HttpResponse {
  readonly status: number;
  readonly reason: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;

  constructor(fields: { status: number; reason?: string; headers?: ReadonlyArray<readonly [string, string]>; body: Uint8Array }) {
    this.status = fields.status;
    this.reason = fields.reason ?? (fields.status < 400 ? "OK" : "Error");
    this.headers = fields.headers ?? [["content-type", "application/json"]];
    this.body = fields.body;
  }

  header(name: string): string | undefined {
    const lname = name.toLowerCase();
    for (const [k, v] of this.headers) if (k.toLowerCase() === lname) return v;
    return undefined;
  }

  text(): string {
    return UTF8_DECODE.decode(this.body);
  }

  json(): JsonValue {
    return parseJsonBytes(this.body);
  }
}

export function jsonBytes(value: unknown): Uint8Array {
  return UTF8.encode(stringifyJson(value));
}

export function textBytes(text: string): Uint8Array {
  return UTF8.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return UTF8_DECODE.decode(bytes);
}

/** `?a=b&c=d` appended (or `&`-joined) to `url`; `undefined` values skipped. */
export function buildUrl(url: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  if (!params) return url;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeQuery(k)}=${encodeQuery(String(v))}`);
  }
  if (parts.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/** `urllib.parse.urlencode` spelling: spaces as `+`, `-_.~` and alphanumerics unescaped. */
function encodeQuery(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** RFC 3986 percent-encoding over UTF-8 with `safe` characters kept (Python's `quote`). */
export function percentEncode(text: string, safe = ""): string {
  let out = "";
  for (const byte of UTF8.encode(text)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (safe.length > 0 && safe.includes(c))) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * MAP-11: a provider id placed in a URL path. `resourceName` keeps `/`
 * literal for wires whose ids are resource names (Gemini); flat-id wires
 * encode `/` too. Never decoded first.
 */
export function pathId(value: string, opts: { resourceName?: boolean } = {}): string {
  return percentEncode(value, opts.resourceName ? "/" : "");
}

export interface JsonRequestOptions {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string> | ReadonlyArray<readonly [string, string]> | undefined;
  readonly params?: Record<string, string | number | boolean | null | undefined> | undefined;
  readonly payload?: unknown;
  readonly body?: Uint8Array | undefined;
}

export function makeJsonRequest(opts: JsonRequestOptions): TransportRequest {
  const headers: Array<readonly [string, string]> = Array.isArray(opts.headers)
    ? [...(opts.headers as ReadonlyArray<readonly [string, string]>)]
    : Object.entries((opts.headers as Record<string, string> | undefined) ?? {});
  let body = opts.body ?? new Uint8Array(0);
  if (opts.payload !== undefined && opts.payload !== null) {
    body = jsonBytes(opts.payload);
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
  }
  return { method: opts.method, url: buildUrl(opts.url, opts.params), headers, body };
}

// ─── File readiness fold (OpenAI-shaped file objects) ────────────────

const OPENAI_FILE_READINESS: Readonly<Record<string, FileReadiness>> = Object.freeze({
  uploaded: "pending",
  pending: "pending",
  error: "failed",
  failed: "failed",
  processed: "ready",
});

export function openaiFileReadiness(status: unknown): FileReadiness {
  if (typeof status !== "string") return "ready";
  return OPENAI_FILE_READINESS[status] ?? "ready";
}

// ─── Parts → text, media, MAP-10 ─────────────────────────────────────

export const MEDIA_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "document", "binary"]);

/**
 * Text rendering for wire fields that take text only. A media part RAISES
 * (MAP-10 rule 2): no caption, no type name, no placeholder.
 */
export function partsToText(parts: readonly Part[], opts: { provider?: string; where?: string } = {}): string {
  const out: string[] = [];
  for (const part of parts) {
    if (MEDIA_KINDS.has(part.type)) {
      const head = opts.provider ? `${opts.provider}: ` : "";
      throw new UnsupportedFeatureError(
        `${head}a ${part.type} part cannot reach ${opts.where ?? "a text-only wire field"}, which takes text only; no text rendering of a media part is made (MAP-10)`,
        { provider: opts.provider ?? null },
      );
    }
    if (part.type === "text") out.push(part.text);
    else if (part.type === "thinking" && part.text) out.push(part.text);
    else if (part.type === "citation") {
      const bits = [part.title, part.url, part.text].filter((x): x is string => Boolean(x));
      if (bits.length > 0) out.push(bits.join(" — "));
    }
  }
  return out.join("\n");
}

export function messageText(msg: Message): string {
  return partsToText(msg.parts);
}

/** The bytes of a path-addressed part or upload, through the host (`Platform.readFile`); a host without a filesystem refuses. */
export function readFileBytes(path: string): Uint8Array {
  const platform = getDefaultPlatform();
  if (!platform.readFile) throw noFilesystem(platform, `path ${JSON.stringify(path)}`);
  return platform.readFile(path);
}

/** The part's bytes as base64: inline `data`, or the `path` read now. */
export function mediaBase64(part: MediaPart): string {
  if (part.data !== undefined) return part.data;
  if (part.path !== undefined) return encodeBase64(readFileBytes(part.path));
  throw new ValueError(`${part.type} part has no inline data or path`);
}

export function mediaDataUri(part: MediaPart): string {
  return `data:${part.mediaType};base64,${mediaBase64(part)}`;
}

const TOOL_RESULT_MEDIA_ADMITS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  native: new Set(["image", "document"]),
  images: new Set(["image"]),
  reject: new Set<string>(),
});

const MEDIA_DOORS: Readonly<Record<string, string>> = Object.freeze({
  image: "the OpenAI Responses, Anthropic Messages and Gemini dialects (and the xai/moonshotai/zai chat presets)",
  document: "the OpenAI Responses, Anthropic Messages and Gemini dialects",
});

/** MAP-10 rules 1–3: raise before any wire when the preset's `tool_result_media` does not admit a part kind. */
export function checkToolResultMedia(provider: string, part: ToolResultPart, policy: string, wire: string): void {
  const admits = TOOL_RESULT_MEDIA_ADMITS[policy] ?? new Set<string>();
  for (const p of part.content) {
    if (MEDIA_KINDS.has(p.type) && !admits.has(p.type)) {
      const why = policy === "reject" ? "this server takes text-only tool results" : `this server carries images but not ${p.type} parts in a tool result`;
      throw new UnsupportedFeatureError(
        `${provider}: a ${p.type} part in tool_result ${JSON.stringify(part.id)} cannot reach ${wire} — ${why} (compat tool_result_media=${JSON.stringify(policy)}, measured: lm15-contract/research/tool-result-content/). Carried natively by ${MEDIA_DOORS[p.type] ?? "no lm15 door yet"}; or render the part to text yourself before building the tool result (MAP-10)`,
        { provider },
      );
    }
  }
}

/** MAP-10 rule 5 on wires with no error flag: the text carries it. */
export function toolResultErrorText(part: ToolResultPart, text: string): string {
  return part.isError ? `[error] ${text}` : text;
}

/** MAP-9 on the complete path: a tool call the provider sent without a name. */
export function unnamedToolCallError(provider: string, path: string): ProviderError {
  return new ProviderError(`${provider}: ${path} is a tool call with no name; lm15 does not guess which tool the model meant (MAP-9)`, {
    provider,
  });
}

/** Best-effort JSON object from a value that may be a JSON-text fragment. */
export function parseJsonObjectLenient(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonObject;
  if (typeof value === "string" && value) {
    let parsed: JsonValue;
    try {
      parsed = parseJsonBytes(UTF8.encode(value));
    } catch {
      return { partial_json: value };
    }
    if (isJsonObject(parsed)) return parsed;
    return { value: parsed };
  }
  return {};
}

/** A provider timestamp (unix epoch or ISO-8601) → canonical `YYYY-MM-DDTHH:MM:SSZ`, or `undefined`. */
export function isoUtc(value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  let d: Date;
  if (typeof value === "number") d = new Date(value * 1000);
  else if (typeof value === "object" && "raw" in (value as object)) d = new Date(Number((value as { raw: string }).raw) * 1000);
  else if (typeof value === "string" && value) {
    let text = value.trim().replace(/\.(\d{6})\d+/, ".$1");
    if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) text += "Z";
    d = new Date(text);
  } else return undefined;
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function modelInfosFromEntries(
  entries: unknown,
  opts: { provider: string; apiFamily: string; idOf: (entry: JsonObject) => unknown },
): ModelInfo[] {
  if (!Array.isArray(entries)) return [];
  const out: ModelInfo[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = opts.idOf(entry as JsonObject);
    if (typeof id !== "string" || id === "") continue;
    out.push(
      ModelInfo.create({
        id,
        provider: opts.provider,
        apiFamily: opts.apiFamily,
        origin: { type: "provider", providerData: entry as JsonObject },
      }),
    );
  }
  return out;
}

/** OpenAI-style logprob entries → canonical TokenLogprob (both OpenAI dialects share the shape). */
export function openaiTokenLogprobs(entries: unknown): TokenLogprob[] {
  if (!Array.isArray(entries)) return [];
  const out: TokenLogprob[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("token" in entry) || !("logprob" in entry)) continue;
    const e = entry as JsonObject;
    const top: unknown[] = [];
    for (const alt of Array.isArray(e["top_logprobs"]) ? e["top_logprobs"] : []) {
      if (typeof alt !== "object" || alt === null || !("token" in alt) || !("logprob" in alt)) continue;
      const a = alt as JsonObject;
      top.push({ token: String(a["token"]), logprob: a["logprob"], bytes: Array.isArray(a["bytes"]) ? a["bytes"] : undefined });
    }
    out.push(
      normalizeTokenLogprob({
        token: String(e["token"]),
        logprob: e["logprob"],
        bytes: Array.isArray(e["bytes"]) ? e["bytes"] : undefined,
        top,
      }),
    );
  }
  return out;
}

// ─── Multipart ───────────────────────────────────────────────────────

function randomBoundary(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `lm15-${hex}`;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export interface MultipartFile {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** `multipart/form-data` (OpenAI and Anthropic uploads). Returns `[contentType, body]`. */
export function multipartFormBody(fields: ReadonlyArray<readonly [string, string]>, files: readonly MultipartFile[]): [string, Uint8Array] {
  const boundary = randomBoundary();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of fields) {
    chunks.push(UTF8.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    const safe = f.filename.replace(/"/g, "%22");
    chunks.push(UTF8.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${safe}"\r\nContent-Type: ${f.contentType}\r\n\r\n`));
    chunks.push(f.data);
    chunks.push(UTF8.encode("\r\n"));
  }
  chunks.push(UTF8.encode(`--${boundary}--\r\n`));
  return [`multipart/form-data; boundary=${boundary}`, concat(chunks)];
}

/** `multipart/related` (Gemini media upload): a JSON metadata part then one media part. */
export function multipartRelatedBody(metadata: unknown, mediaType: string, data: Uint8Array): [string, Uint8Array] {
  const boundary = randomBoundary();
  const chunks: Uint8Array[] = [
    UTF8.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    jsonBytes(metadata),
    UTF8.encode(`\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`),
    data,
    UTF8.encode(`\r\n--${boundary}--\r\n`),
  ];
  return [`multipart/related; boundary=${boundary}`, concat(chunks)];
}

/** Split a URL into `[urlWithoutQuery, decodedParams]` the way the vet protocol wants it. */
export function splitUrl(url: string): [string, Record<string, string>] {
  const idx = url.indexOf("?");
  if (idx < 0) return [url, {}];
  const base = url.slice(0, idx);
  const params: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    params[decodeQuery(k)] = decodeQuery(v);
  }
  return [base, params];
}

function decodeQuery(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

/** Filter/copy a JsonObject dropping `undefined` members. */
export function obj(fields: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v as JsonValue;
  return out;
}
