/**
 * Shared request-building helpers for the provider adapters.
 *
 * Everything here is a pure transformation from canonical values to wire
 * JSON trees (JsonValue, with CFloat marking declared-float wire numbers);
 * the single canonical stringifier renders them.
 */

import {
  CFloat,
  isJsonObject,
  parseCanonicalJson,
  type JsonObject,
  type JsonValue,
} from "../canonical-json.js";
import { ValueError } from "../errors.js";
import type {
  ContinuationState,
  ImagePart,
  DocumentPart,
  BinaryPart,
  MediaPart,
  Part,
  Request,
  Response,
  StreamEvent,
} from "../types.js";
import type { SSEEvent } from "../sse.js";

/** The build_request wire shape from harness/PROTOCOL.md. */
export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: JsonObject | null;
}

/** Provider adapter surface: build_request (Stage C), parse_response (Stage D), stream mapping (Stage E). */
export interface ProviderAdapter {
  buildRequest(request: Request, stream: boolean): WireRequest;
  parseResponse(request: Request, status: number, body: JsonValue): Response;
  /** Map ONE provider SSE frame to canonical events, statelessly (pre-coalesce). */
  parseStreamEvents(request: Request, raw: SSEEvent): StreamEvent[];
}

/** Lossy text rendering for provider fields that only accept text. */
export function partsToText(parts: readonly Part[]): string {
  const out: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        out.push(part.text);
        break;
      case "thinking":
        if (part.text) out.push(part.text);
        break;
      case "citation": {
        const bits = [part.title, part.url, part.text].filter((x): x is string => Boolean(x));
        if (bits.length > 0) out.push(bits.join(" — "));
        break;
      }
      default:
        break;
    }
  }
  return out.join("\n");
}

export function systemText(system: string | readonly Part[]): string {
  return typeof system === "string" ? system : partsToText(system);
}

export function mediaDataUri(part: MediaPart): string {
  if (part.data === null) {
    throw new ValueError(`${part.type} part has no inline data`);
  }
  return `data:${part.media_type};base64,${part.data}`;
}

/** Anthropic media source object (url / file / base64 precedence). */
export function anthropicSource(part: ImagePart | DocumentPart | BinaryPart): JsonObject {
  if (part.url !== null) return { type: "url", url: part.url };
  if (part.file_id !== null) return { type: "file", file_id: part.file_id };
  if (part.data !== null) {
    return { type: "base64", media_type: part.media_type, data: part.data };
  }
  throw new ValueError(`${part.type} part has no usable source`);
}

/**
 * Compact JSON for embedded tool-call arguments, matching the reference's
 * json.dumps(value, separators=(",", ":")) — including ensure_ascii.
 */
export function compactJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value instanceof CFloat) {
    const s = String(value.value);
    return /^-?\d+$/.test(s) ? `${s}.0` : s;
  }
  if (typeof value === "string") return pyEscapeString(value);
  if (Array.isArray(value)) return `[${value.map(compactJson).join(",")}]`;
  const entries = Object.entries(value).map(([k, v]) => `${pyEscapeString(k)}:${compactJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** Python json.dumps default string escaping (ensure_ascii=True). */
function pyEscapeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code < 0x7f) out += ch;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else {
      // Surrogate pair, as Python emits for astral code points.
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    }
  }
  return out + '"';
}

/** Fallback rendering for empty tool-result text: Python json.dumps default separators. */
export function toolResultTypeListJson(content: readonly Part[]): string {
  return `[${content.map((p) => `{"type": "${p.type}"}`).join(", ")}]`;
}

/** Provider-owned continuation data lookup (first matching state). */
export function continuationData(
  states: readonly ContinuationState[],
  provider: string,
  kind: string,
): JsonObject | null {
  for (const state of states) {
    if (state.provider === provider && state.kind === kind) return state.data;
  }
  return null;
}

/** Wrap a declared-float canonical config knob for float wire emission. */
export function wireFloat(value: number): CFloat {
  return new CFloat(value);
}

/** Gemini proto3-JSON dialect: integral float knobs are sent in integer form. */
export function geminiNumber(value: number): number | CFloat {
  return Number.isInteger(value) ? value : new CFloat(value);
}

export function asJsonObject(value: JsonValue | null | undefined): JsonObject | null {
  return value !== null && value !== undefined && isJsonObject(value) ? value : null;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// ─── Response parsing helpers (Stage D) ──────────────────────────────

/** `_lm15_unmapped` recorder entries (PROTOCOL.md "Unmapped recorder"). */
export interface UnmappedEntry {
  readonly path: string;
  readonly type: string;
}

/** Mirror of the reference `_record_unmapped`: falsy types → "<missing>". */
export function recordUnmapped(unmapped: UnmappedEntry[], path: string, typ: unknown): void {
  const value = typ instanceof CFloat ? typ.value : typ;
  unmapped.push({ path, type: value ? String(value) : "<missing>" });
}

/** Python `type(x).__name__` for unmapped shape failures. */
export function jsonTypeName(v: JsonValue | undefined): string {
  if (v === null || v === undefined) return "NoneType";
  if (v instanceof CFloat) return "float";
  if (Array.isArray(v)) return "list";
  switch (typeof v) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "object":
      return "dict";
    default:
      return typeof v;
  }
}

/** Attach the unmapped canary to provider_data when non-empty. */
export function attachUnmapped(body: JsonObject, unmapped: UnmappedEntry[]): JsonObject {
  if (unmapped.length === 0) return body;
  return { ...body, _lm15_unmapped: unmapped.map((e) => ({ ...e })) };
}

/** Python truthiness over parsed JSON values. */
export function pyTruthy(v: JsonValue | undefined): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v instanceof CFloat) return v.value !== 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python `str(x)` over scalar JSON values (None → "None"). */
export function pyStr(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "None";
  if (v instanceof CFloat) return Number.isInteger(v.value) ? `${v.value}.0` : String(v.value);
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python `str(x or "")`. */
export function strOrEmpty(v: JsonValue | undefined): string {
  return pyTruthy(v) ? pyStr(v) : "";
}

/** Python `_str_or_none`: None or "" → null, else str. */
export function strOrNull(v: JsonValue | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  return pyStr(v);
}

/** Python `_int_or_none`: bools/None → null; numbers truncate; numeric strings parse. */
export function intOrNull(v: JsonValue | undefined): number | null {
  if (v === undefined || v === null || typeof v === "boolean") return null;
  const n = v instanceof CFloat ? v.value : v;
  if (typeof n === "number") return Math.trunc(n);
  if (typeof n === "string" && /^[+-]?\d+$/.test(n.trim())) return parseInt(n.trim(), 10);
  return null;
}

/** Python `int(x or 0)` for usage counters. */
export function intCount(v: JsonValue | undefined): number {
  const n = intOrNull(v);
  return n === null ? 0 : n;
}

/** Pass-through usage counter: unwrap CFloat, keep absent/null as undefined. */
export function counterOrUndefined(v: JsonValue | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof CFloat) return v.value;
  return typeof v === "number" ? v : undefined;
}

export function asArray(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Reference `parse_json_object`: dict verbatim; non-empty string parsed
 * (objects verbatim, scalars wrapped, parse failures preserved); else {}.
 */
export function parseJsonObjectValue(v: JsonValue | undefined): JsonObject {
  if (v !== undefined && v !== null && isJsonObject(v)) return v;
  if (typeof v === "string" && v !== "") {
    let parsed: JsonValue;
    try {
      parsed = parseCanonicalJson(v);
    } catch {
      return { partial_json: v };
    }
    if (isJsonObject(parsed)) return parsed;
    return { value: parsed };
  }
  return {};
}
