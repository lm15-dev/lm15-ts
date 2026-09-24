/**
 * `fetch` through an encrypted tunnel. The page opens a WebSocket to a tunnel
 * (website/relay/tunnel-local.mjs), which connects it to `host:443` and copies
 * bytes. TLS runs here, in the page (./tls.ts), so the tunnel carries only
 * ciphertext; HTTP/1.1 is spoken over that TLS by this module.
 *
 * Why it exists: some provider endpoints refuse web pages (no CORS, or a
 * provider refusing any request carrying Origin). A forwarding relay fixes that
 * by reading the request; this fixes it without the relay reading anything. It
 * also sends exactly the headers asked for: no Origin, no browser
 * Accept-Encoding (identity is requested and gzip/deflate replies are decoded,
 * honoring Fetch's decoded-body contract), and a real User-Agent.
 *
 * What the tunnel still sees: the page's origin and IP, the provider host,
 * timing and sizes. One connection per request (`Connection: close`): simple,
 * and each request pays a fresh TLS handshake (no session resumption in the
 * module).
 */

import { TlsEngine, TlsError, type TlsSession } from "./tls.ts";

export interface TunnelOptions {
  /** The tunnel endpoint, e.g. `wss://relay.example/tunnel`. The provider host is added as `?host=`. */
  readonly url: string | URL;
  /** The TLS module, loaded once and shared. */
  readonly tls: TlsEngine | Promise<TlsEngine>;
  /** Injectable for tests and non-browser hosts. */
  readonly WebSocket?: typeof WebSocket;
}

const CRLF = new Uint8Array([13, 10]);
const MAX_HEAD = 64 * 1024;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("the tunnel sends string, bytes, URLSearchParams or Blob bodies");
}

/** Incremental HTTP/1.1 response reader: head, then a body framed by length, chunks or close. */
class ResponseReader {
  #buf: Uint8Array = new Uint8Array(0);
  #mode: "head" | "length" | "chunked-size" | "chunked-data" | "chunked-crlf" | "trailers" | "close" | "done" = "head";
  #remaining = 0;
  readonly #head: boolean;
  onHead?: (status: number, statusText: string, headers: Headers) => void;
  onData?: (chunk: Uint8Array) => void;
  onEnd?: () => void;

  constructor(isHead: boolean) {
    this.#head = isHead;
  }

  get done(): boolean {
    return this.#mode === "done";
  }

  push(data: Uint8Array): void {
    this.#buf = concat(this.#buf, data);
    for (;;) {
      switch (this.#mode) {
        case "head": {
          const end = indexOf(this.#buf, new Uint8Array([13, 10, 13, 10]));
          if (end < 0) {
            if (this.#buf.length > MAX_HEAD) throw new TypeError("response head too large");
            return;
          }
          const text = new TextDecoder("latin1").decode(this.#buf.subarray(0, end));
          this.#buf = this.#buf.subarray(end + 4);
          const [statusLine, ...lines] = text.split("\r\n");
          const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine ?? "");
          if (!m) throw new TypeError("malformed HTTP status line");
          const status = Number(m[1]);
          const headers = new Headers();
          for (const line of lines) {
            const at = line.indexOf(":");
            if (at <= 0) throw new TypeError("malformed HTTP header");
            headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
          }
          if (status >= 100 && status < 200) continue; // 100 Continue and friends: the real head follows
          this.onHead?.(status, m[2] ?? "", headers);
          const te = headers.get("transfer-encoding")?.toLowerCase() ?? "";
          const length = headers.get("content-length");
          if (this.#head || status === 204 || status === 304) this.#finish();
          else if (te.split(",").map((s) => s.trim()).includes("chunked")) this.#mode = "chunked-size";
          else if (length !== null) {
            if (!/^\d+$/.test(length.trim())) throw new TypeError("malformed Content-Length");
            this.#remaining = Number(length.trim());
            this.#mode = "length";
            if (this.#remaining === 0) this.#finish();
          } else this.#mode = "close";
          continue;
        }
        case "length": {
          if (this.#buf.length === 0) return;
          const take = this.#buf.subarray(0, this.#remaining);
          this.#buf = this.#buf.subarray(take.length);
          this.#remaining -= take.length;
          this.onData?.(take.slice());
          if (this.#remaining === 0) this.#finish();
          continue;
        }
        case "chunked-size": {
          const end = indexOf(this.#buf, CRLF);
          if (end < 0) return;
          const size = parseInt(new TextDecoder().decode(this.#buf.subarray(0, end)).split(";")[0]!.trim(), 16);
          if (!Number.isFinite(size) || size < 0) throw new TypeError("malformed chunk size");
          this.#buf = this.#buf.subarray(end + 2);
          this.#remaining = size;
          this.#mode = size === 0 ? "trailers" : "chunked-data";
          continue;
        }
        case "chunked-data": {
          if (this.#buf.length === 0) return;
          const take = this.#buf.subarray(0, this.#remaining);
          this.#buf = this.#buf.subarray(take.length);
          this.#remaining -= take.length;
          this.onData?.(take.slice());
          if (this.#remaining === 0) this.#mode = "chunked-crlf";
          continue;
        }
        case "chunked-crlf": {
          if (this.#buf.length < 2) return;
          this.#buf = this.#buf.subarray(2);
          this.#mode = "chunked-size";
          continue;
        }
        case "trailers": {
          const end = indexOf(this.#buf, CRLF);
          if (end < 0) return;
          this.#buf = this.#buf.subarray(end + 2);
          if (end === 0) this.#finish();
          continue;
        }
        case "close": {
          if (this.#buf.length === 0) return;
          this.onData?.(this.#buf.slice());
          this.#buf = new Uint8Array(0);
          return;
        }
        case "done":
          return;
      }
    }
  }

  /** The connection ended. Only a close-delimited body may end this way. */
  eof(): void {
    if (this.#mode === "close") return this.#finish();
    if (this.#mode !== "done") throw new TypeError(this.#mode === "head" ? "the connection closed before a response" : "the connection closed mid-body");
  }

  #finish(): void {
    this.#mode = "done";
    this.onEnd?.();
  }
}

/** A `fetch` that reaches `https://` URLs through the tunnel. Rejects like fetch (TypeError) on network failure. */
export function tunnelFetch(options: TunnelOptions): typeof fetch {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    if (url.protocol !== "https:") throw new TypeError("the tunnel carries https:// requests only");
    if (url.port && url.port !== "443") throw new TypeError("the tunnel reaches port 443 only");
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);
    const body = await bodyBytes(init.body ?? null);
    const signal = init.signal ?? request?.signal ?? undefined;
    signal?.throwIfAborted();
    const engine = await options.tls;

    let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n`;
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
    for (const [name, value] of headers) {
      if (["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(name)) continue;
      if (/[\r\n]/.test(value)) throw new TypeError(`header ${name} contains a line break`);
      head += `${name}: ${value}\r\n`;
    }
    if (body !== undefined || ["POST", "PUT", "PATCH"].includes(method)) head += `Content-Length: ${body?.length ?? 0}\r\n`;
    head += "Connection: close\r\n\r\n";
    const requestBytes = body ? concat(new TextEncoder().encode(head), body) : new TextEncoder().encode(head);

    const tunnel = new URL(String(options.url));
    tunnel.searchParams.set("host", url.hostname);
    const tls: TlsSession = engine.open(url.hostname);
    const ws = new WS(tunnel.toString());
    ws.binaryType = "arraybuffer";
    const reader = new ResponseReader(method === "HEAD");

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let sent = false;
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended = false;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
        try { tls.free(); } catch { /* already freed */ }
        if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close();
      };
      const fail = (error: unknown): void => {
        if (ended) return;
        ended = true;
        cleanup();
        if (!settled) {
          settled = true;
          reject(error instanceof DOMException || error instanceof TlsError ? error : new TypeError("tunnel request failed", { cause: error }));
        } else stream?.error(error);
      };
      const onAbort = (): void => fail(signal?.reason ?? new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });

      const flush = (): void => {
        const out = tls.pullTls();
        if (out.length > 0) ws.send(out);
      };
      reader.onHead = (status, statusText, h) => {
        const encoding = (h.get("content-encoding") ?? "").toLowerCase().trim();
        const raw = new ReadableStream<Uint8Array>({
          start: (c) => { stream = c; },
          cancel: () => { ended = true; cleanup(); },
        });
        let bodyStream: ReadableStream<Uint8Array> = raw;
        // Fetch hands out decoded bodies; the tunnel asked for identity, but decodes what the web can.
        if (encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate") {
          bodyStream = raw.pipeThrough(new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
          h.delete("content-encoding");
          h.delete("content-length");
        }
        settled = true;
        resolve(new Response(status === 204 || status === 304 || method === "HEAD" ? null : bodyStream, { status, statusText, headers: h }));
      };
      reader.onData = (chunk) => stream?.enqueue(chunk);
      reader.onEnd = () => {
        if (ended) return;
        ended = true;
        stream?.close();
        cleanup();
      };

      ws.onopen = () => {
        try { flush(); } catch (e) { fail(e); }
      };
      ws.onmessage = (event: MessageEvent) => {
        try {
          tls.pushTls(new Uint8Array(event.data as ArrayBuffer));
          if (!sent && !tls.handshaking()) {
            tls.pushPlain(requestBytes);
            sent = true;
          }
          flush();
          for (;;) {
            const plain = tls.pullPlain();
            if (plain === null) { reader.eof(); break; }
            if (plain.length === 0) break;
            reader.push(plain);
            if (reader.done) break;
          }
        } catch (e) {
          fail(e);
        }
      };
      ws.onerror = () => fail(new TypeError("the tunnel connection failed"));
      ws.onclose = () => {
        if (ended) return;
        try {
          reader.eof();
        } catch (e) {
          fail(e);
        }
      };
    });
  }) as typeof fetch;
}
