/**
 * A credential is a closed sum, not a string (spec/auth.md AUTH-2).
 *
 * Secrecy (AUTH-5): `toString`, `util.inspect`, and `JSON.stringify` never
 * show the material; `Credential.toJSON` is the one deliberate way out.
 */

import type { JsonObject } from "../json.ts";
import { ValueError, absent } from "./validate.ts";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** AUTH-3: a token inside the five-minute skew window counts as expired. */
export const EXPIRY_SKEW_SECONDS = 300;

/** `2026-09-03T12:00:00Z` (or an offset) → a Date. */
export function parseRfc3339(value: string): Date {
  const text = value.trim();
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(text) ? text : text + "Z");
  if (Number.isNaN(d.getTime())) throw new ValueError(`invalid RFC 3339 timestamp: ${value}`);
  return d;
}

/** Date → `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, UTC). */
export function formatRfc3339(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isExpired(expiresAt: Date | undefined, now?: Date): boolean {
  if (expiresAt === undefined) return false;
  const current = now ?? new Date();
  return (expiresAt.getTime() - current.getTime()) / 1000 <= EXPIRY_SKEW_SECONDS;
}

function nonEmpty(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "") throw new ValueError(message);
  return value;
}

export class ApiKey {
  readonly kind = "api_key" as const;
  readonly #value: string;

  constructor(value: string) {
    this.#value = nonEmpty(value, "ApiKey.value must be a non-empty string");
    Object.freeze(this);
  }

  get value(): string {
    return this.#value;
  }

  isExpired(_now?: Date): boolean {
    return false;
  }

  toString(): string {
    return "ApiKey(<redacted>)";
  }
  [INSPECT](): string {
    return this.toString();
  }
  toJSON(): string {
    return this.toString();
  }
}

export class BearerToken {
  readonly kind = "bearer_token" as const;
  readonly #value: string;
  readonly expiresAt: Date | undefined;

  constructor(value: string, expiresAt?: Date) {
    this.#value = nonEmpty(value, "BearerToken.value must be a non-empty string");
    if (expiresAt !== undefined && !(expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()))) {
      throw new ValueError("BearerToken.expires_at must be a valid Date");
    }
    this.expiresAt = expiresAt;
    Object.freeze(this);
  }

  get value(): string {
    return this.#value;
  }

  isExpired(now?: Date): boolean {
    return isExpired(this.expiresAt, now);
  }

  toString(): string {
    return `BearerToken(<redacted>${this.expiresAt ? `, expires_at=${formatRfc3339(this.expiresAt)}` : ""})`;
  }
  [INSPECT](): string {
    return this.toString();
  }
  toJSON(): string {
    return this.toString();
  }
}

export class AwsCredentials {
  readonly kind = "aws" as const;
  /** Not secret. */
  readonly accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken: string | undefined;
  readonly expiresAt: Date | undefined;

  constructor(fields: { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined; expiresAt?: Date | undefined }) {
    if (
      typeof fields.accessKeyId !== "string" ||
      fields.accessKeyId === "" ||
      typeof fields.secretAccessKey !== "string" ||
      fields.secretAccessKey === ""
    ) {
      throw new ValueError("AwsCredentials needs non-empty string access_key_id and secret_access_key");
    }
    if (fields.sessionToken !== undefined && (typeof fields.sessionToken !== "string" || fields.sessionToken === "")) {
      throw new ValueError("AwsCredentials.session_token must be a non-empty string");
    }
    this.accessKeyId = fields.accessKeyId;
    this.#secretAccessKey = fields.secretAccessKey;
    this.#sessionToken = fields.sessionToken;
    this.expiresAt = fields.expiresAt;
    Object.freeze(this);
  }

  get secretAccessKey(): string {
    return this.#secretAccessKey;
  }
  get sessionToken(): string | undefined {
    return this.#sessionToken;
  }

  isExpired(now?: Date): boolean {
    return isExpired(this.expiresAt, now);
  }

  toString(): string {
    return `AwsCredentials(access_key_id=${JSON.stringify(this.accessKeyId)}, <redacted>${
      this.expiresAt ? `, expires_at=${formatRfc3339(this.expiresAt)}` : ""
    })`;
  }
  [INSPECT](): string {
    return this.toString();
  }
  toJSON(): string {
    return this.toString();
  }
}

export type CredentialValue = ApiKey | BearerToken | AwsCredentials;

/** The AUTH-2 zero-arg provider: invoked at request-build time, never cached by the adapter. */
export type CredentialProvider = () => string | CredentialValue | Promise<string | CredentialValue>;

/** What every `apiKey` option accepts: a string, a value, or a provider. */
export type CredentialLike = string | CredentialValue | CredentialProvider;

export function isCredentialValue(value: unknown): value is CredentialValue {
  return value instanceof ApiKey || value instanceof BearerToken || value instanceof AwsCredentials;
}

/** A string reads as an `ApiKey`; a value passes through. */
export function coerceCredential(value: string | CredentialValue): CredentialValue {
  if (isCredentialValue(value)) return value;
  if (typeof value === "string") return new ApiKey(value);
  throw new TypeError(`not a credential: ${typeof value}`);
}

export const Credential = {
  fromJSON(d: JsonObject): CredentialValue {
    const expires = absent(d["expires_at"]) ? undefined : parseRfc3339(String(d["expires_at"]));
    switch (d["kind"]) {
      case "api_key":
        return new ApiKey(d["value"] as string);
      case "bearer_token":
        return new BearerToken(d["value"] as string, expires);
      case "aws":
        return new AwsCredentials({
          accessKeyId: d["access_key_id"] as string,
          secretAccessKey: d["secret_access_key"] as string,
          sessionToken: absent(d["session_token"]) ? undefined : (d["session_token"] as string),
          expiresAt: expires,
        });
      default:
        throw new ValueError("unknown credential kind");
    }
  },
  /** Canonical JSON (AUTH-2). The one deliberate way the material leaves a credential. */
  toJSON(value: CredentialValue): JsonObject {
    if (value instanceof ApiKey) return { kind: "api_key", value: value.value };
    if (value instanceof BearerToken) {
      const out: JsonObject = { kind: "bearer_token", value: value.value };
      if (value.expiresAt) out["expires_at"] = formatRfc3339(value.expiresAt);
      return out;
    }
    const out: JsonObject = { kind: "aws", access_key_id: value.accessKeyId, secret_access_key: value.secretAccessKey };
    if (value.sessionToken !== undefined) out["session_token"] = value.sessionToken;
    if (value.expiresAt) out["expires_at"] = formatRfc3339(value.expiresAt);
    return out;
  },
};
