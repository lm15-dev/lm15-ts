/**
 * Where the keys live. In memory for the tab by default. On the device
 * only when the user asks, and then encrypted: AES-GCM under a key the
 * browser generates as non-extractable and keeps in IndexedDB — it never
 * exists as bytes any script can read, and neither does the plaintext on
 * disk or in a backup. Forget deletes the record.
 *
 * Stated plainly, in the settings text too: a script running on this
 * origin can still ask this class for a key. No browser storage prevents
 * that; the page's Content Security Policy (no third-party script) and
 * the user's own Forget are the protections that exist.
 */

const DB = "lm15-playground";
const STORE = "keys";
const KEY_ID = "device-key";

interface Record_ {
  readonly provider: string;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

function idb(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb()!.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "provider" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Credentials {
  readonly #memory = new Map<string, string>();
  readonly #remembered = new Set<string>();

  /** Whether "remember on this device" is possible here (IndexedDB + Web Crypto). */
  static available(): boolean {
    return idb() !== undefined && typeof crypto !== "undefined" && crypto.subtle !== undefined;
  }

  get(provider: string): string | undefined {
    return this.#memory.get(provider);
  }

  providers(): string[] {
    return [...this.#memory.keys()];
  }

  remembered(provider: string): boolean {
    return this.#remembered.has(provider);
  }

  /** Decrypt every remembered key into memory. Silent when nothing is stored or storage is unavailable. */
  async load(): Promise<void> {
    if (!Credentials.available()) return;
    try {
      const db = await open();
      const aes = (await tx<CryptoKey | undefined>(db, "meta", "readonly", (s) => s.get(KEY_ID))) ?? undefined;
      if (!aes) return;
      const records = await tx<Record_[]>(db, STORE, "readonly", (s) => s.getAll());
      for (const record of records) {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, aes, record.ciphertext);
        this.#memory.set(record.provider, new TextDecoder().decode(plain));
        this.#remembered.add(record.provider);
      }
    } catch {
      // A broken store is not a reason to fail the page; the user re-enters the key.
    }
  }

  async set(provider: string, key: string, remember: boolean): Promise<void> {
    if (!key) throw new TypeError("an empty key is not a key");
    this.#memory.set(provider, key);
    if (!Credentials.available()) return;
    const db = await open();
    if (!remember) {
      await tx(db, STORE, "readwrite", (s) => s.delete(provider));
      this.#remembered.delete(provider);
      return;
    }
    let aes = (await tx<CryptoKey | undefined>(db, "meta", "readonly", (s) => s.get(KEY_ID))) ?? undefined;
    if (!aes) {
      aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await tx(db, "meta", "readwrite", (s) => s.put(aes, KEY_ID));
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(key));
    await tx(db, STORE, "readwrite", (s) => s.put({ provider, iv, ciphertext } satisfies Record_));
    this.#remembered.add(provider);
  }

  async forget(provider: string): Promise<void> {
    this.#memory.delete(provider);
    this.#remembered.delete(provider);
    if (Credentials.available()) await tx(await open(), STORE, "readwrite", (s) => s.delete(provider));
  }

  async forgetAll(): Promise<void> {
    this.#memory.clear();
    this.#remembered.clear();
    if (Credentials.available()) await tx(await open(), STORE, "readwrite", (s) => s.clear());
  }
}
