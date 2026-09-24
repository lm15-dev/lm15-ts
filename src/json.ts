/**
 * JSON values with number fidelity.
 *
 * The contract treats `1` and `1.0` as two different values (harness
 * PROTOCOL.md: strict typed deep-equality; docs/serde-rules.md: the Number
 * rule) and requires opaque payloads to round-trip byte for byte. JavaScript
 * has one number type, and `JSON.parse` forgets the lexeme it read. This
 * module closes that gap once, for the whole library:
 *
 * - {@link RawNumber} carries a JSON number lexeme that a plain JS `number`
 *   could not reproduce: an integral float (`1.0`, `2e3`) or an integer
 *   outside the safe range. It appears only where fidelity demands it —
 *   inside opaque payloads parsed from the wire — never in typed fields.
 * - {@link parseJson} reads JSON producing plain values, wrapping only the
 *   lexemes that need it.
 * - {@link stringifyJson} writes JSON, emitting a `RawNumber` verbatim.
 * - {@link float} marks a typed float field for emission (`1` → `1.0`).
 *
 * Stated deviation (lm15-ts README): a JS literal written by the user inside
 * an opaque payload (`extensions: { x: 1.0 }`) is indistinguishable from
 * `1` and is emitted as the integer `1`. Wire-originated payloads keep their
 * form. Use `new RawNumber("1.0")` to force a float lexeme by hand.
 */

import { malformedJsonError, type ReplyMetadataSource } from "./errors.ts";

export class RawNumber {
  readonly raw: string;

  constructor(raw: string) {
    if (!NUMBER_LEXEME.test(raw)) {
      throw new TypeError(`RawNumber: not a JSON number lexeme: ${JSON.stringify(raw)}`);
    }
    this.raw = raw;
  }

  /** The numeric value (lossy for integers beyond 2^53). */
  valueOf(): number {
    return Number(this.raw);
  }

  /** True when the lexeme is a JSON float (has a fraction or exponent). */
  get isFloat(): boolean {
    return /[.eE]/.test(this.raw);
  }

  toJSON(): never {
    // Native JSON.stringify would stringify this as an object; the library
    // never uses it on canonical values. Fail loudly rather than emit `{}`.
    throw new TypeError("RawNumber cannot be serialized by JSON.stringify; use stringifyJson");
  }

  toString(): string {
    return this.raw;
  }
}

const NUMBER_LEXEME = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export type JsonPrimitive = null | boolean | number | string | RawNumber;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** True for a plain object (not an array, not null, not a class instance). */
export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A JS `number` or a `RawNumber`. */
export function isNumeric(value: unknown): value is number | RawNumber {
  return typeof value === "number" || value instanceof RawNumber;
}

/**
 * INV-001: strict JSON values only. Iterative (no recursion), non-copying.
 * Rejects `undefined`, non-finite numbers, functions, class instances, Dates,
 * Maps, symbols and symbol keys.
 */
export function isStrictJson(value: unknown): value is JsonValue {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null) continue;
    switch (typeof item) {
      case "boolean":
      case "string":
        continue;
      case "number":
        if (!Number.isFinite(item)) return false;
        continue;
      case "object":
        if (item instanceof RawNumber) continue;
        if (Array.isArray(item)) {
          for (const child of item) stack.push(child);
          continue;
        }
        if (!isJsonObject(item)) return false;
        for (const key of Reflect.ownKeys(item)) {
          if (typeof key !== "string") return false;
          stack.push((item as Record<string, unknown>)[key]);
        }
        continue;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Mark a typed float field for emission. `1` becomes the lexeme `1.0`;
 * `0.5` stays a plain number (its JS form already reads as a float).
 * Returns `null`/`undefined` unchanged so serializers can call it blindly.
 */
export function float(value: number): RawNumber | number;
export function float(value: number | null): RawNumber | number | null;
export function float(value: number | null | undefined): RawNumber | number | null | undefined;
export function float(value: number | null | undefined): RawNumber | number | null | undefined {
  if (value === null || value === undefined) return value;
  if (!Number.isFinite(value)) throw new TypeError("float: value must be finite");
  if (!Number.isInteger(value)) return value;
  const text = String(value);
  if (/[.eE]/.test(text)) return new RawNumber(text);
  return new RawNumber(`${text}.0`);
}

/** The numeric value of a JSON number, `RawNumber` or plain. */
export function numberValue(value: number | RawNumber): number {
  return value instanceof RawNumber ? value.valueOf() : value;
}

/**
 * Whether a JSON number value reads as a float. A plain JS number is a
 * float when non-integral; a `RawNumber` says so itself.
 */
export function isFloatLexeme(value: number | RawNumber): boolean {
  return value instanceof RawNumber ? value.isFloat : !Number.isInteger(value);
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse JSON text into JSON values, preserving number lexemes that a JS
 * number cannot (integral floats, big integers) as `RawNumber`.
 */
export function parseJson(text: string): JsonValue {
  if (HAS_SOURCE_ACCESS) {
    return JSON.parse(text, reviver) as JsonValue;
  }
  return new Parser(text).parseDocument();
}

/**
 * Parse JSON the strict way AUTH-25 asks of private-store and auth-response
 * JSON: a duplicate member name is an error (JSON.parse silently keeps the
 * last one, which a later check can no longer see). Numbers keep their
 * lexemes as in `parseJson`; JSON has no non-finite numbers to refuse.
 */
export function parseJsonStrict(text: string): JsonValue {
  return new Parser(text, true).parseDocument();
}

/** Parse JSON text that must be an object. */
export function parseJsonObject(text: string): JsonObject {
  const value = parseJson(text);
  if (!isJsonObject(value)) throw new TypeError("expected a JSON object");
  return value;
}

/** Parse UTF-8 bytes as JSON. */
export function parseJsonBytes(bytes: Uint8Array): JsonValue {
  return parseJson(UTF8.decode(bytes));
}

/** Parse a provider reply, keeping HTTP evidence when the JSON is malformed. */
export function parseProviderJson(response: ReplyMetadataSource, provider?: string): JsonValue {
  try {
    // Invalid UTF-8 must not quietly turn into replacement characters in JSON.
    return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch (cause) {
    throw malformedJsonError(response, cause, provider);
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: false });

const HAS_SOURCE_ACCESS: boolean = (() => {
  try {
    let seen = false;
    JSON.parse("1", (_k: string, v: unknown, ctx?: { source?: string }) => {
      seen = ctx !== undefined && typeof ctx.source === "string";
      return v;
    });
    return seen;
  } catch {
    return false;
  }
})();

function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && context && typeof context.source === "string") {
    return wrapLexeme(context.source, value);
  }
  return value;
}

function wrapLexeme(lexeme: string, value: number): number | RawNumber {
  if (/[.eE]/.test(lexeme)) {
    // A float lexeme. Non-integral floats read back as themselves from a JS
    // number; integral ones (1.0, 2e3) would not, so keep the lexeme.
    return Number.isInteger(value) ? new RawNumber(lexeme) : value;
  }
  return Number.isSafeInteger(value) ? value : new RawNumber(lexeme);
}

/** Fallback parser for runtimes without reviver source access. */
class Parser {
  private pos = 0;

  private readonly text: string;

  private readonly rejectDuplicates: boolean;

  constructor(text: string, rejectDuplicates = false) {
    this.text = text;
    this.rejectDuplicates = rejectDuplicates;
  }

  parseDocument(): JsonValue {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.text.length) this.fail("unexpected trailing characters");
    return value;
  }

  private fail(message: string): never {
    throw new SyntaxError(`JSON parse error at ${this.pos}: ${message}`);
  }

  private skipWs(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(): JsonValue {
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return this.parseString();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
        return this.fail(`unexpected character ${JSON.stringify(c ?? "<eof>")}`);
    }
  }

  private literal<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return this.fail(`expected ${word}`);
  }

  private parseNumber(): number | RawNumber {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos, this.pos + 400));
    if (!match) this.fail("invalid number");
    const lexeme = match[0];
    this.pos += lexeme.length;
    return wrapLexeme(lexeme, Number(lexeme));
  }

  private parseString(): string {
    // Find the closing quote honoring escapes, then let JSON.parse decode it.
    const start = this.pos;
    let i = start + 1;
    const t = this.text;
    while (i < t.length) {
      const c = t.charCodeAt(i);
      if (c === 0x5c) {
        i += 2;
        continue;
      }
      if (c === 0x22) break;
      if (c < 0x20) this.fail("control character in string");
      i++;
    }
    if (i >= t.length) this.fail("unterminated string");
    const raw = t.slice(start, i + 1);
    this.pos = i + 1;
    return JSON.parse(raw) as string;
  }

  private parseArray(): JsonValue[] {
    this.pos++; // [
    const out: JsonValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWs();
      out.push(this.parseValue());
      this.skipWs();
      const c = this.text[this.pos++];
      if (c === ",") continue;
      if (c === "]") return out;
      this.fail("expected , or ]");
    }
  }

  private parseObject(): JsonObject {
    this.pos++; // {
    const out: JsonObject = {};
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.fail("expected string key");
      const key = this.parseString();
      this.skipWs();
      if (this.text[this.pos++] !== ":") this.fail("expected :");
      this.skipWs();
      const value = this.parseValue();
      if (this.rejectDuplicates && Object.prototype.hasOwnProperty.call(out, key)) this.fail("duplicate member name");
      if (key === "__proto__") {
        Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
      } else {
        out[key] = value;
      }
      this.skipWs();
      const c = this.text[this.pos++];
      if (c === ",") continue;
      if (c === "}") return out;
      this.fail("expected , or }");
    }
  }
}

// ─── Serialization ───────────────────────────────────────────────────

export interface StringifyOptions {
  /** Pretty-print with this indent (spaces). Default: compact. */
  readonly indent?: number;
}

/**
 * Serialize a JSON value. `RawNumber` is emitted verbatim; `undefined`
 * object members are skipped (as `JSON.stringify` does); anything that is
 * not a JSON value throws — the library validates at construction so this
 * never triggers on canonical data.
 */
export function stringifyJson(value: unknown, options: StringifyOptions = {}): string {
  const indent = options.indent ?? 0;
  const parts: string[] = [];
  write(value, parts, indent, 0);
  return parts.join("");
}

function write(value: unknown, out: string[], indent: number, depth: number): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "string":
      assertUnicodeScalars(value);
      out.push(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("stringifyJson: non-finite number");
      out.push(String(value));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`stringifyJson: cannot serialize a ${typeof value}`);
  }
  if (value instanceof RawNumber) {
    out.push(value.raw);
    return;
  }
  const nl = indent > 0 ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const close = indent > 0 ? "\n" + " ".repeat(indent * depth) : "";
  const sep = indent > 0 ? ": " : ":";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push("[]");
      return;
    }
    out.push("[");
    let first = true;
    for (const item of value) {
      out.push(first ? nl : "," + nl);
      first = false;
      write(item === undefined ? null : item, out, indent, depth + 1);
    }
    out.push(close, "]");
    return;
  }
  if (!isJsonObject(value)) {
    throw new TypeError("stringifyJson: cannot serialize a non-plain object");
  }
  const keys = Object.keys(value);
  let first = true;
  out.push("{");
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    assertUnicodeScalars(key);
    out.push(first ? nl : "," + nl);
    first = false;
    out.push(JSON.stringify(key), sep);
    write(item, out, indent, depth + 1);
  }
  if (first) {
    out.push("}");
    return;
  }
  out.push(close, "}");
}

/** INV-055: UTF-16 pairs are valid, isolated surrogate code units are not. */
export function assertUnicodeScalars(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0xd800 || cp > 0xdfff) continue;
    if (cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { i++; continue; }
    }
    throw new TypeError(`stringifyJson: unpaired surrogate U+${cp.toString(16).toUpperCase().padStart(4, "0")} has no UTF-8 representation`);
  }
}

// ─── Equality ────────────────────────────────────────────────────────

/**
 * Strict typed deep equality over JSON values, the harness's own standard:
 * `1 !== 1.0`, `true !== 1`, absent/null/""/[]/{} are five different values.
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof RawNumber || b instanceof RawNumber) {
    const fa = isNumeric(a) ? isFloatLexeme(a) : null;
    const fb = isNumeric(b) ? isFloatLexeme(b) : null;
    if (fa === null || fb === null || fa !== fb) return false;
    return numberValue(a as number | RawNumber) === numberValue(b as number | RawNumber);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEquals(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in bo)) return false;
    if (!jsonEquals(ao[k], bo[k])) return false;
  }
  return true;
}

/** `[]`, `{}`, `""`, `null`, `undefined` — the omission rule's "empty". */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isJsonObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * The omission rule (docs/serde-rules.md): drop this object's own empty
 * optional fields. Applied by each typed serializer at its own level only;
 * nested values are embedded as their own serializer produced them.
 */
export function omitEmpty<T extends Record<string, unknown>>(fields: T): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isEmptyValue(value)) continue;
    out[key] = value as JsonValue;
  }
  return out;
}

/** Deep-freeze a JSON value in place (used for the default tables). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof RawNumber)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
