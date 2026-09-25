/**
 * The managed store as a private file (AUTH-8 path, AUTH-4 lock and atomic
 * write, AUTH-25 strictness). Node only: the Node platform hands it to
 * `Auth.local()`; the web entry never loads this module.
 *
 * Same file, same lock and same layout as lm15-python's `FileStore`
 * (lm15-contract auth/managed/store-layout.md): a login made by one SDK is
 * used, renewed and signed out by the other.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCredentialsPath, expandHome, withFileLock, writePrivateJsonAtomic } from "../auth/stores.ts";
import type { JsonObject } from "../json.ts";
import { parseStoreText, Store, storageError, validateDocument, type Transaction } from "./store.ts";

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return defaultCredentialsPath(env);
}

export class FileStore extends Store {
  readonly path: string;
  readonly description: string;
  readonly lockTimeoutMs: number;

  /** Anchors the absolute path now (a later chdir must not move the store); reads and creates nothing. */
  constructor(file?: string, opts: { lockTimeoutMs?: number } = {}) {
    super();
    const chosen = file !== undefined ? expandHome(file) : defaultStorePath();
    this.path = path.resolve(chosen);
    this.description = this.path;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 30_000;
  }

  #load(): JsonObject {
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw storageError(`Could not read credential store at ${this.path}: ${(error as NodeJS.ErrnoException).code ?? "read failed"}`);
    }
    return parseStoreText(text, this.path);
  }

  async read(): Promise<JsonObject> {
    return this.#load();
  }

  override readSync(): JsonObject {
    return this.#load();
  }

  transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T> {
    return withFileLock(this.path, () => fn({
      read: async () => this.#load(),
      write: async (document) => {
        validateDocument(document, this.path);
        try {
          writePrivateJsonAtomic(this.path, document);
        } catch (error) {
          throw storageError(`Could not write credential store at ${this.path}: ${(error as NodeJS.ErrnoException).code ?? "write failed"}`);
        }
      },
    }), { timeoutMs: this.lockTimeoutMs });
  }

  /** Take the lock once and touch nothing: the directory and lock directory are writable before a browser opens. */
  async reserve(): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw storageError(`Cannot create ${path.dirname(this.path)} for the credential store: ${(error as NodeJS.ErrnoException).code ?? "failed"}`, { stage: "reservation" });
    }
    if (fs.existsSync(this.path)) {
      try {
        fs.accessSync(this.path, fs.constants.W_OK);
      } catch {
        throw storageError(`Credential store at ${this.path} is not writable.`, { stage: "reservation" });
      }
    }
    await withFileLock(this.path, async () => {
      this.#load();
    }, { timeoutMs: this.lockTimeoutMs });
  }
}
