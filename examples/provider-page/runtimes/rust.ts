/**
 * The lm15-rs wire codec in a page: the crate built for wasm32 with its
 * `wasm` feature (see lm15-rs/src/wasm.rs), instantiated with plain
 * `WebAssembly.instantiate` — no glue library. JSON in, JSON out over
 * linear memory; this module is the whole host side of that ABI.
 *
 * The codec does the wire — build a request, parse a body, decode a
 * stream — and the page does the network with `fetch`, exactly as the
 * TypeScript port's own transport does. What runs is the Rust in the
 * repository, not a translation of it.
 */

export interface RustFailure {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export class RustCodecError extends Error {
  override readonly name: string;
  readonly code: string;
  constructor(failure: RustFailure) {
    super(failure.message);
    this.name = failure.name;
    this.code = failure.code;
  }
}

interface Exports {
  memory: WebAssembly.Memory;
  lm15_alloc(len: number): number;
  lm15_free(ptr: number, len: number): void;
  lm15_call(op: number, opLen: number, input: number, inLen: number): number;
}

export interface WireRequest {
  readonly method: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly body_b64?: string;
}

export interface CodecConnection {
  readonly provider: string;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly settings?: Record<string, string> | undefined;
}

export class RustCodec {
  readonly #exports: Exports;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();

  private constructor(exports: Exports) {
    this.#exports = exports;
  }

  /** Instantiate from bytes, a `Response`, or a URL to fetch. */
  static async load(source: ArrayBuffer | Uint8Array | Response | string): Promise<RustCodec> {
    let result: WebAssembly.WebAssemblyInstantiatedSource;
    if (typeof source === "string") result = await WebAssembly.instantiateStreaming(fetch(source), {});
    else if (source instanceof Response) result = await WebAssembly.instantiateStreaming(source, {});
    else result = await WebAssembly.instantiate(source as BufferSource, {});
    return new RustCodec(result.instance.exports as unknown as Exports);
  }

  #write(text: string): [number, number] {
    const bytes = this.#encoder.encode(text);
    const ptr = this.#exports.lm15_alloc(bytes.length);
    new Uint8Array(this.#exports.memory.buffer).set(bytes, ptr); // a fresh view: alloc may have grown memory
    return [ptr, bytes.length];
  }

  /** One op. Throws `RustCodecError` for the codec's typed failures. */
  call<T = unknown>(op: string, input: unknown = {}): T {
    const [opPtr, opLen] = this.#write(op);
    const [inPtr, inLen] = this.#write(JSON.stringify(input));
    const out = this.#exports.lm15_call(opPtr, opLen, inPtr, inLen);
    const memory = this.#exports.memory.buffer;
    const len = new DataView(memory).getUint32(out, true);
    const text = this.#decoder.decode(new Uint8Array(memory, out + 4, len));
    this.#exports.lm15_free(out, len + 4);
    this.#exports.lm15_free(opPtr, opLen);
    this.#exports.lm15_free(inPtr, inLen);
    const reply = JSON.parse(text) as { error?: RustFailure };
    if (reply.error) throw new RustCodecError(reply.error);
    return reply as T;
  }

  version(): { version: string; language: string } {
    return this.call("version");
  }

  buildRequest(connection: CodecConnection, canonicalRequest: unknown, stream: boolean): WireRequest {
    return this.call("build_request", { provider: connection.provider, api_key: connection.apiKey, base_url: connection.baseUrl, settings: connection.settings, canonical_request: canonicalRequest, stream });
  }

  parseResponse(connection: CodecConnection, canonicalRequest: unknown, status: number, body: string): { canonical_response: unknown } {
    return this.call("parse_response", { provider: connection.provider, base_url: connection.baseUrl, settings: connection.settings, canonical_request: canonicalRequest, status, body });
  }

  /** An incremental decoder: feed SSE bytes as they arrive, take canonical events; close for the materialized response. */
  openStream(connection: CodecConnection, canonicalRequest: unknown): RustStream {
    const { handle } = this.call<{ handle: number }>("stream_open", { provider: connection.provider, base_url: connection.baseUrl, settings: connection.settings, canonical_request: canonicalRequest });
    return new RustStream(this, handle);
  }
}

export interface CanonicalEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class RustStream {
  #open = true;
  readonly #codec: RustCodec;
  readonly #handle: number;
  constructor(codec: RustCodec, handle: number) {
    this.#codec = codec;
    this.#handle = handle;
  }

  feed(chunk: Uint8Array): CanonicalEvent[] {
    return this.#codec.call<{ events: CanonicalEvent[] }>("stream_feed", { handle: this.#handle, body_b64: base64(chunk) }).events;
  }

  close(): { events: CanonicalEvent[]; canonical_response: unknown } {
    this.#open = false;
    return this.#codec.call("stream_close", { handle: this.#handle });
  }

  abort(): void {
    if (this.#open) {
      this.#open = false;
      this.#codec.call("stream_abort", { handle: this.#handle });
    }
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ─── The runtime ──────────────────────────────────────────────────────

import { Request as RequestNs, Response as CanonicalResponse, type Request } from "lm15/browser";
import { ANTHROPIC_BROWSER_HEADER, keyless, type Connection, type Wire } from "../experience.ts";
import type { Runtime } from "./index.ts";

const WASM_URL = "/vendor/rust/lm15.wasm";
let codec: RustCodec | undefined;
let loading: Promise<RustCodec> | undefined;

async function boot(report: (status: string) => void): Promise<RustCodec> {
  if (codec) return codec;
  loading ??= (async () => {
    report("Loading the lm15-rs codec (1 MB)…");
    const loaded = await RustCodec.load(WASM_URL);
    report(`Rust ready: lm15-rs ${loaded.version().version} (wasm32)`);
    codec = loaded;
    return loaded;
  })();
  return loading;
}

function connectionOf(connection: Connection, key: string | undefined): CodecConnection {
  const apiKey = keyless(connection.provider) ? "unused" : key;
  if (!apiKey) throw new Error("Add this provider's API key in Settings first.");
  return connection.provider === "custom" ? { provider: "openai-chat", apiKey, baseUrl: connection.endpoint } : { provider: connection.provider, apiKey };
}

function wireOf(built: WireRequest): Wire {
  const url = new URL(built.url);
  for (const [k, v] of Object.entries(built.params)) url.searchParams.set(k, v);
  const body = built.body_b64 !== undefined ? atob(built.body_b64) : built.body === null ? "" : JSON.stringify(built.body);
  return { method: built.method, url: url.href, headers: Object.entries(built.headers), body };
}

export const rustRuntime: Runtime = {
  id: "rust",
  label: "Rust",
  claim: "The lm15-rs crate compiled to WebAssembly builds the request and decodes the stream; this page does the fetch.",
  loaded: () => codec !== undefined,
  load: async (report) => void (await boot(report)),

  async wire(connection, key, request): Promise<Wire> {
    const rust = await boot(() => {});
    return wireOf(rust.buildRequest(connectionOf(connection, key), RequestNs.toJSON(request), true));
  },

  async stream(connection, key, request, signal, onText): Promise<CanonicalResponse> {
    const rust = await boot(() => {});
    const codecConnection = connectionOf(connection, key);
    const canonical = RequestNs.toJSON(request);
    const wire = wireOf(rust.buildRequest(codecConnection, canonical, true));
    const headers = new Headers(wire.headers);
    // The codec built a native client's headers; a page adds the one Anthropic asks of a browser.
    if (connection.provider === "anthropic") headers.set(ANTHROPIC_BROWSER_HEADER[0], ANTHROPIC_BROWSER_HEADER[1]);
    const response = await fetch(wire.url, { method: wire.method, headers, body: wire.body, signal });
    if (!response.ok) {
      const text = await response.text();
      rust.parseResponse(codecConnection, canonical, response.status, text); // throws the typed error for this status
      throw new Error(`HTTP ${response.status}`);
    }
    const stream = rust.openStream(codecConnection, canonical);
    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of stream.feed(value)) {
          const delta = event["delta"] as { type?: string; text?: string } | undefined;
          if (event.type === "delta" && delta?.type === "text" && delta.text) onText(delta.text);
        }
      }
      return CanonicalResponse.fromJSON(stream.close().canonical_response as Parameters<typeof CanonicalResponse.fromJSON>[0]);
    } catch (error) {
      stream.abort();
      throw error;
    }
  },
};
