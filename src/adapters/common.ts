/**
 * Shared request-building helpers for the provider adapters.
 *
 * Everything here is a pure transformation from canonical values to wire
 * JSON trees (JsonValue, with CFloat marking declared-float wire numbers);
 * the single canonical stringifier renders them.
 */

import { CFloat, isJsonObject, type JsonObject, type JsonValue } from "../canonical-json.js";
import { ValueError } from "../errors.js";
import type {
  ContinuationState,
  ImagePart,
  DocumentPart,
  BinaryPart,
  MediaPart,
  Part,
  Request,
} from "../types.js";

/** The build_request wire shape from harness/PROTOCOL.md. */
export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: JsonObject | null;
}

/** Provider adapter surface for build_request (Stage C). */
export interface ProviderAdapter {
  buildRequest(request: Request, stream: boolean): WireRequest;
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
