/**
 * Canonical JSON parsing and emission.
 *
 * The canonical wire format distinguishes JSON ints from JSON floats
 * (`1 != 1.0` — serde-rules.md "Number rule"), which JavaScript's number
 * type cannot represent. This module provides:
 *
 * - `CFloat`: a wrapper marking a number as a JSON float. The parser wraps
 *   every number token spelled with a fraction or exponent; the stringifier
 *   always emits a `CFloat` in float form (`1.0`, never `1`).
 * - `parseCanonicalJson` / `stringifyCanonicalJson`: a JSON codec that
 *   round-trips int-vs-float exactly, so opaque payloads are never mutated.
 *
 * There is exactly ONE stringifier in this package; everything that writes
 * canonical JSON goes through it.
 */

/** Marker for a number whose declared (or source) JSON type is float. */
export class CFloat {
  constructor(readonly value: number) {}
}

export type JsonValue =
  | null
  | boolean
  | number
  | CFloat
  | string
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof CFloat)
  );
}

// ─── Parser ──────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): JsonValue {
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.text.length) {
      throw new SyntaxError(`trailing characters at position ${this.pos}`);
    }
    return value;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && " \t\n\r".includes(this.text[this.pos]!)) {
      this.pos += 1;
    }
  }

  private parseValue(): JsonValue {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new SyntaxError("unexpected end of input");
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === "t") return this.parseLiteral("true", true);
    if (ch === "f") return this.parseLiteral("false", false);
    if (ch === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseLiteral<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    throw new SyntaxError(`invalid literal at position ${this.pos}`);
  }

  private parseNumber(): number | CFloat {
    const re = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m || m[0].length === 0) {
      throw new SyntaxError(`invalid number at position ${this.pos}`);
    }
    this.pos += m[0].length;
    const num = Number(m[0]);
    if (m[1] !== undefined || m[2] !== undefined) return new CFloat(num);
    return num;
  }

  private parseString(): string {
    // this.text[this.pos] === '"'
    this.pos += 1;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new SyntaxError("unterminated string");
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === "\\") {
        const esc = this.text[this.pos + 1];
        this.pos += 2;
        switch (esc) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SyntaxError(`invalid \\u escape at position ${this.pos}`);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw new SyntaxError(`invalid escape at position ${this.pos - 1}`);
        }
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) throw new SyntaxError("unescaped control character");
      out += ch;
      this.pos += 1;
    }
  }

  private parseArray(): JsonValue[] {
    this.pos += 1; // [
    const out: JsonValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        continue;
      }
      if (ch === "]") {
        this.pos += 1;
        return out;
      }
      throw new SyntaxError(`expected ',' or ']' at position ${this.pos}`);
    }
  }

  private parseObject(): JsonObject {
    this.pos += 1; // {
    const out: JsonObject = {};
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') {
        throw new SyntaxError(`expected string key at position ${this.pos}`);
      }
      const key = this.parseString();
      this.skipWs();
      if (this.text[this.pos] !== ":") {
        throw new SyntaxError(`expected ':' at position ${this.pos}`);
      }
      this.pos += 1;
      out[key] = this.parseValue();
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos += 1;
        continue;
      }
      if (ch === "}") {
        this.pos += 1;
        return out;
      }
      throw new SyntaxError(`expected ',' or '}' at position ${this.pos}`);
    }
  }
}

export function parseCanonicalJson(text: string): JsonValue {
  return new Parser(text).parse();
}

// ─── Stringifier (the ONE canonical JSON emitter) ────────────────────

function emitNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError("non-finite number has no JSON form");
  return String(n);
}

function emitFloat(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError("non-finite number has no JSON form");
  const s = String(n);
  // Integral floats must keep their float spelling: 1 -> "1.0".
  if (/^-?\d+$/.test(s)) return `${s}.0`;
  return s;
}

export function stringifyCanonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return emitNumber(value);
  if (value instanceof CFloat) return emitFloat(value.value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).map(
    ([k, v]) => `${JSON.stringify(k)}:${stringifyCanonicalJson(v)}`,
  );
  return `{${entries.join(",")}}`;
}
