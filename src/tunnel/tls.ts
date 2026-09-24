/**
 * TLS in the page: the rustls module (lm15-ts/tls, built for wasm32v1-none)
 * loaded over Web APIs only. The module verifies certificates against its
 * bundled webpki-roots and the host asked for, using the page's clock
 * (`Date.now`) and randomness (`crypto.getRandomValues`). It is sans I/O: this
 * class hands it received TLS bytes and takes the bytes to send.
 */

interface TlsExports {
  readonly memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  conn_new(ptr: number, len: number): number;
  conn_push_plain(h: number, ptr: number, len: number): number;
  conn_push_tls(h: number, ptr: number, len: number): number;
  conn_pull_tls(h: number): number;
  conn_pull_plain(h: number): number;
  conn_handshaking(h: number): number;
  conn_close(h: number): void;
  conn_free(h: number): void;
}

/** A TLS failure: bad certificate, wrong host, protocol error. The message is rustls's own. */
export class TlsError extends Error {
  override readonly name = "TlsError";
}

export class TlsEngine {
  readonly #x: TlsExports;

  private constructor(exports: TlsExports) {
    this.#x = exports;
  }

  /** Instantiate the module from its bytes, a Response, or a URL to fetch. */
  static async load(source: BufferSource | Response | URL | string): Promise<TlsEngine> {
    let memory: WebAssembly.Memory | undefined;
    const imports = {
      env: {
        now_ms: (): number => Date.now(),
        random: (ptr: number, len: number): void => {
          // getRandomValues takes at most 65536 bytes per call.
          for (let off = 0; off < len; off += 65536) crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr + off, Math.min(65536, len - off)));
        },
      },
    };
    let instance: WebAssembly.Instance;
    if (typeof source === "string" || source instanceof URL) source = await fetch(source);
    if (source instanceof Response) {
      if (!source.ok) throw new TlsError(`could not load the TLS module (HTTP ${source.status})`);
      instance = (await WebAssembly.instantiate(await source.arrayBuffer(), imports)).instance;
    } else {
      instance = (await WebAssembly.instantiate(source, imports)).instance;
    }
    const exports = instance.exports as unknown as TlsExports;
    memory = exports.memory;
    return new TlsEngine(exports);
  }

  #out(): Uint8Array {
    return new Uint8Array(this.#x.memory.buffer, this.#x.out_ptr(), this.#x.out_len()).slice();
  }

  #error(): TlsError {
    return new TlsError(new TextDecoder().decode(this.#out()));
  }

  #with<T>(data: Uint8Array, f: (ptr: number, len: number) => T): T {
    const ptr = this.#x.alloc(data.length);
    new Uint8Array(this.#x.memory.buffer, ptr, data.length).set(data);
    try {
      return f(ptr, data.length);
    } finally {
      this.#x.dealloc(ptr, data.length);
    }
  }

  /** A client session for `host` (SNI and certificate name). */
  open(host: string): TlsSession {
    const h = this.#with(new TextEncoder().encode(host), (p, n) => this.#x.conn_new(p, n));
    if (!h) throw this.#error();
    const x = this.#x;
    const engine = this;
    return {
      pushTls: (data) => {
        if (engine.#with(data, (p, n) => x.conn_push_tls(h, p, n)) < 0) throw engine.#error();
      },
      pushPlain: (data) => {
        if (engine.#with(data, (p, n) => x.conn_push_plain(h, p, n)) < 0) throw engine.#error();
      },
      pullTls: () => {
        const n = x.conn_pull_tls(h);
        if (n < 0) throw engine.#error();
        return n > 0 ? engine.#out() : new Uint8Array(0);
      },
      pullPlain: () => {
        const n = x.conn_pull_plain(h);
        if (n === -2) return null;
        if (n < 0) throw engine.#error();
        return n > 0 ? engine.#out() : new Uint8Array(0);
      },
      handshaking: () => x.conn_handshaking(h) === 1,
      close: () => x.conn_close(h),
      free: () => x.conn_free(h),
    };
  }
}

export interface TlsSession {
  pushTls(data: Uint8Array): void;
  pushPlain(data: Uint8Array): void;
  /** Bytes to send to the peer (possibly empty). */
  pullTls(): Uint8Array;
  /** Decrypted bytes (possibly empty), or `null` once the peer closed cleanly and nothing is left. */
  pullPlain(): Uint8Array | null;
  handshaking(): boolean;
  /** Queue close_notify; pull and send it. */
  close(): void;
  free(): void;
}
