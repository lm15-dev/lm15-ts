/**
 * Where the key lives, and for how long. In memory for the tab by default;
 * on this device (`localStorage`) only when the user asks, and only until
 * they click Forget. Nothing here ever logs, displays or transmits the key:
 * it hands it to the lm15 client and to `keyHash` and that is all.
 *
 * Stated plainly: `localStorage` is readable by any script on this origin.
 * "Remember on this device" trades that exposure for not signing in every
 * visit; the user makes the trade, not the page.
 */

const KEY = "lm15-example.openrouter-key";

export class KeyStore {
  #memory: string | undefined;
  readonly #storage: Storage | undefined;

  constructor(storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage) {
    this.#storage = storage;
  }

  /** The key in effect: the tab's, else the device's. */
  load(): string | undefined {
    if (this.#memory !== undefined) return this.#memory;
    const stored = this.#storage?.getItem(KEY) ?? undefined;
    if (stored) this.#memory = stored;
    return stored || undefined;
  }

  set(key: string, remember: boolean): void {
    if (!key) throw new TypeError("an empty key is not a key");
    this.#memory = key;
    if (remember) this.#storage?.setItem(KEY, key);
    else this.#storage?.removeItem(KEY);
  }

  get remembered(): boolean {
    return (this.#storage?.getItem(KEY) ?? "") !== "";
  }

  forget(): void {
    this.#memory = undefined;
    this.#storage?.removeItem(KEY);
  }
}
