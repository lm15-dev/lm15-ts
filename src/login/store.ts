/**
 * The managed credential store (spec/auth-managed.md AUTH-25): the document
 * contract every store implements. Port of lm15-python `lm15/login/store.py`;
 * the layout is lm15-contract `auth/managed/store-layout.md`, so a file one
 * SDK writes is the other's.
 *
 * One JSON object per scope: provider entries (secret, provider-private
 * shape) plus one non-secret `_lm15` block (version, per-slot generations,
 * revisions, renewal and logout markers, display metadata).
 *
 * Browser-safe: nothing here imports a Node module. The file store lives in
 * `file_store.ts` and reaches `Auth.local()` through the Node platform.
 *
 * An unreadable or unrecognised document is a typed `AuthOperationError`
 * (`storage_unavailable` / `unsupported_store_version`), never an empty
 * store and never overwritten.
 */

import { AuthOperationError } from "../errors.ts";
import { isJsonObject, parseJsonStrict, RawNumber, type JsonObject, type JsonValue } from "../json.ts";

export const META_KEY = "_lm15";
export const STORE_VERSION = 1;

export function storageError(message: string, opts: { reason?: "storage_unavailable" | "unsupported_store_version"; stage?: "persistence" | "reservation" } = {}): AuthOperationError {
  return new AuthOperationError(message, {
    reason: opts.reason ?? "storage_unavailable", stage: opts.stage ?? "persistence", commitState: "not_committed",
    recovery: "repair_storage", operation: "store",
  });
}

function sameNumber(value: JsonValue | undefined, expected: number): boolean {
  if (typeof value === "number") return value === expected;
  return value instanceof RawNumber && Number(value.raw) === expected && !value.isFloat;
}

/** Reject anything that is not the document shape; never return a guess. */
export function validateDocument(data: unknown, where: string): JsonObject {
  if (!isJsonObject(data)) throw storageError(`Credential store at ${where} is not a JSON object; not touching it.`);
  const meta = data[META_KEY];
  if (meta !== undefined) {
    if (!isJsonObject(meta)) throw storageError(`Credential store at ${where} has a malformed "${META_KEY}" block; not touching it.`);
    const version = meta["version"];
    if (!sameNumber(version, STORE_VERSION)) {
      throw storageError(
        `Credential store at ${where} is managed-store version ${JSON.stringify(version instanceof RawNumber ? version.raw : version ?? null)}; this lm15 reads version ${STORE_VERSION}. Upgrade lm15 or point LM15_CREDENTIALS_PATH at another file.`,
        { reason: "unsupported_store_version" },
      );
    }
    const slots = meta["slots"] ?? {};
    if (!isJsonObject(slots) || Object.values(slots).some((v) => !isJsonObject(v))) {
      throw storageError(`Credential store at ${where} has malformed slot metadata; not touching it.`);
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (key !== META_KEY && !isJsonObject(value)) throw storageError(`Credential store at ${where}: entry ${JSON.stringify(key)} is not an object; not touching it.`);
  }
  return data;
}

/** Strict JSON (no duplicate members, AUTH-25), then the document shape. */
export function parseStoreText(text: string, where: string): JsonObject {
  let data: JsonValue;
  try {
    data = parseJsonStrict(text);
  } catch {
    throw storageError(`Credential store at ${where} is not valid JSON; not touching it.`);
  }
  return validateDocument(data, where);
}

/** A deep, private copy (the document is plain JSON; `RawNumber`s are immutable and shared). */
export function copyDocument<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => copyDocument(v)) as T;
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = copyDocument(v);
    return out as T;
  }
  return value;
}

/** The store, locked: `read` is the document now; `write` replaces it durably. A transaction may write more than once (AUTH-20.4). */
export interface Transaction {
  read(): Promise<JsonObject>;
  write(document: JsonObject): Promise<void>;
}

/** The document contract every store implements (file, memory, an application's own). */
export abstract class Store {
  /** Where it lives, for people ("memory", a path). Never contents. */
  abstract readonly description: string;

  /** A private copy of the whole document, unlocked: for status and selection. */
  abstract read(): Promise<JsonObject>;

  /**
   * The same, synchronously, for stores that can (a file, memory). A router's
   * `lm()` and the doctor are synchronous; with a store that cannot read
   * synchronously they learn the connection at the first request instead.
   */
  readSync?(): JsonObject;

  /** Run `fn` holding the store exclusively (cross-process where the backend can). */
  abstract transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T>;

  /** AUTH-17: prove the store can be written before any external authorization starts. */
  abstract reserve(): Promise<void>;

  /**
   * Serialized read-modify-write. `fn` gets a private copy and returns the
   * new document, or `undefined` to leave the store untouched. Resolves with
   * the document afterwards (a copy).
   */
  async mutate(fn: (document: JsonObject) => JsonObject | undefined | Promise<JsonObject | undefined>): Promise<JsonObject> {
    return this.transaction(async (txn) => {
      const current = await txn.read();
      const next = await fn(copyDocument(current));
      if (next === undefined) return current;
      await txn.write(next);
      return copyDocument(next);
    });
  }

  toString(): string {
    return `${this.constructor.name}(${this.description})`;
  }
}

/** One exclusive holder at a time within this process, in arrival order. */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Process-lifetime document: `Auth.memory()`, tests, short-lived tools. */
export class MemoryStore extends Store {
  readonly description = "memory";
  #data: JsonObject = {};
  readonly #mutex = new AsyncMutex();

  async read(): Promise<JsonObject> {
    return copyDocument(this.#data);
  }

  override readSync(): JsonObject {
    return copyDocument(this.#data);
  }

  transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T> {
    return this.#mutex.run(() => fn({
      read: async () => copyDocument(this.#data),
      write: async (document) => {
        this.#data = validateDocument(copyDocument(document), "memory");
      },
    }));
  }

  async reserve(): Promise<void> {}
}
