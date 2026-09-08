/**
 * Validation helpers shared by every canonical type (spec/invariants.md).
 * One validation surface: factories, `fromJSON`, and adapters all go through
 * the same normalizers, so wire input gets the same checks as in-memory
 * construction (INV-046).
 */

import { RawNumber, isJsonObject, isStrictJson, type JsonObject } from "../json.ts";

/** The Python reference raises ValueError for bad values; the shim reports the class name. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export function absent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function requireString(value: unknown, field: string, allowEmpty = true): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (!allowEmpty && value === "") throw new ValueError(`${field} cannot be empty`);
  return value;
}

export function optionalString(value: unknown, field: string, allowEmpty = true): string | undefined {
  if (absent(value)) return undefined;
  return requireString(value, field, allowEmpty);
}

export function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a bool`);
  return value;
}

export function optionalBool(value: unknown, field: string): boolean | undefined {
  if (absent(value)) return undefined;
  return requireBool(value, field);
}

/**
 * Number rule, int side (INV-003, INV-006, INV-007): a JS number that is an
 * integer, or a `RawNumber` whose value is integral (`2.0` → 2). Bools and
 * non-integral values are rejected, never rounded.
 */
export function requireInt(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (value instanceof RawNumber) n = value.valueOf();
  else throw new TypeError(`${field} must be an int`);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new TypeError(`${field} must be an int`);
  if (opts.min !== undefined && n < opts.min) {
    throw new ValueError(opts.min === 1 ? `${field} must be > 0` : `${field} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) throw new ValueError(`${field} must be <= ${opts.max}`);
  return n;
}

export function optionalInt(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (absent(value)) return undefined;
  return requireInt(value, field, opts);
}

/** Number rule, float side (INV-008): any finite number; `RawNumber` unwrapped. */
export function requireFloat(value: unknown, field: string): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (value instanceof RawNumber) n = value.valueOf();
  else throw new TypeError(`${field} must be numeric`);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a finite number`);
  return n;
}

export function optionalFloat(value: unknown, field: string): number | undefined {
  if (absent(value)) return undefined;
  return requireFloat(value, field);
}

/** INV-001/INV-002: a strict JSON object, validated, never copied. */
export function requireJsonObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${field} must be a JSON object`);
  if (!isStrictJson(value)) throw new TypeError(`${field} must contain only JSON-compatible values`);
  return value;
}

export function optionalJsonObject(value: unknown, field: string): JsonObject | undefined {
  if (absent(value)) return undefined;
  return requireJsonObject(value, field);
}

/** INV-004: `{}` extensions normalize to absent. */
export function extensionsField(value: unknown, field = "extensions"): JsonObject | undefined {
  const obj = optionalJsonObject(value, field);
  if (obj !== undefined && Object.keys(obj).length === 0) return undefined;
  return obj;
}

export function requireOneOf<T extends string>(vocab: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !(vocab as readonly string[]).includes(value)) {
    throw new ValueError(`unsupported ${field}: ${String(value)}`);
  }
  return value as T;
}

export function optionalOneOf<T extends string>(vocab: readonly T[], value: unknown, field: string): T | undefined {
  if (absent(value)) return undefined;
  return requireOneOf(vocab, value, field);
}

/** INV-020: a bare element coerces to a one-element array; arrays copy. */
export function bareOrArray<T>(value: T | readonly T[] | null | undefined, isBare: (v: unknown) => v is T): T[] {
  if (absent(value)) return [];
  if (isBare(value)) return [value];
  if (Array.isArray(value)) return [...(value as readonly T[])];
  throw new TypeError("expected a value or an array of values");
}

export function stringArray(value: unknown, field: string, allowEmptyItems = false): string[] {
  const items = typeof value === "string" ? [value] : absent(value) ? [] : value;
  if (!Array.isArray(items)) throw new TypeError(`${field} must be a list of strings`);
  for (const item of items) {
    if (typeof item !== "string" || (!allowEmptyItems && item === "")) {
      throw new ValueError(`${field} must contain non-empty strings`);
    }
  }
  return [...(items as string[])];
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** INV-012: the base64 payload of a raw base64 string or a data URI, whitespace collapsed. */
export function base64Payload(partType: string, data: unknown): string {
  if (absent(data)) throw new ValueError(`${partType} has no inline data; fetch url/file_id-addressed media before decoding`);
  if (typeof data !== "string") throw new TypeError(`${partType}.data must be a base64 string`);
  if (data === "") throw new ValueError(`${partType}.data cannot be empty`);
  let payload = data;
  if (payload.startsWith("data:") && payload.includes(";base64,")) {
    payload = payload.slice(payload.indexOf(";base64,") + 8);
  }
  if (/\s/.test(payload)) payload = payload.replace(/\s+/g, "");
  return payload;
}

export function validateBase64(partType: string, data: unknown): void {
  const payload = base64Payload(partType, data);
  if (payload.length % 4 !== 0 || !BASE64_RE.test(payload)) {
    throw new ValueError(`${partType}.data must be a valid base64 string`);
  }
}

export function decodeBase64(partType: string, data: unknown): Uint8Array {
  validateBase64(partType, data);
  return new Uint8Array(Buffer.from(base64Payload(partType, data), "base64"));
}

export function encodeBase64(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

/** Freeze the typed object (its own level; opaque payloads stay the caller's). */
export function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** `{ a: string | undefined }` → `{ a?: string }`: the type of a compacted object. */
export type Compacted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop `undefined` members so normalized objects carry only present fields. */
export function compact<T extends object>(value: T): Compacted<T> {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  }
  return value as unknown as Compacted<T>;
}
