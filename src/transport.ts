/** HTTP over platform fetch. A response owns its body until consumed or cancelled. */
import { abortable, checkAborted, positiveTimeout } from "./async.ts";
import { TransportError, UnsupportedFeatureError } from "./errors.ts";
import { HttpResponse, type TransportRequest } from "./wire.ts";

export interface TransportResponse {
  readonly status: number;
  readonly reason: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  bytes(): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
  /** Release a response whose body will not be consumed. */
  cancel?(reason?: unknown): Promise<void>;
}

export interface Transport {
  send(request: TransportRequest, opts?: { signal?: AbortSignal | undefined }): Promise<TransportResponse>;
}

export interface FetchTransportOptions {
  readonly fetch?: typeof fetch;
  /** Optional total deadline, including the body. Not an idle timeout. */
  readonly timeoutMs?: number;
  /** Wait for response headers (includes connect and request write); default 60s.
   * Platform fetch does not expose a separate connect timer; inject a configured
   * fetch for connection-specific controls, custom TLS roots or proxy support.
   */
  readonly headersTimeoutMs?: number;
  /** Maximum wait for each body chunk, not total generation time; default 60s. */
  readonly readTimeoutMs?: number;
}

export class FetchTransport implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly headersTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(opts: FetchTransportOptions = {}) {
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TransportError("no fetch implementation available; pass one to FetchTransport");
    this.fetchImpl = f;
    this.timeoutMs = positiveTimeout(opts.timeoutMs, "timeoutMs");
    this.headersTimeoutMs = positiveTimeout(opts.headersTimeoutMs, "headersTimeoutMs") ?? 60_000;
    this.readTimeoutMs = positiveTimeout(opts.readTimeoutMs, "readTimeoutMs") ?? 60_000;
  }

  async send(request: TransportRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<TransportResponse> {
    checkAborted(opts.signal);
    if (request.connectTimeout !== undefined) throw new UnsupportedFeatureError("platform fetch cannot set a separate connect timeout; inject a configured Transport");
    const readTimeoutMs = positiveTimeout(request.readTimeout === undefined ? undefined : request.readTimeout * 1000, "readTimeout") ?? this.readTimeoutMs;
    const headers = new Headers();
    for (const [k, v] of request.headers) headers.append(k, v);
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = this.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new TransportError("request timed out")), this.timeoutMs);
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const headTimer = setTimeout(() => controller.abort(new TransportError("response headers timed out")), this.headersTimeoutMs);
    let res: globalThis.Response;
    try {
      // `(0, f)(...)` calls with an undefined receiver: a browser's fetch is a
      // Window method and throws "Illegal invocation" when called on anything
      // else (this transport, for one); WebIDL maps undefined to the global.
      const pending = (0, this.fetchImpl)(request.url, {
        method: request.method,
        headers,
        body: request.body.length > 0 ? (request.body as unknown as BodyInit) : null,
        signal: controller.signal,
        redirect: "follow",
      });
      // A custom fetch might return after cancellation; do not leak that body.
      void pending.then((late) => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      res = await abortable(pending, controller.signal);
      checkAborted(controller.signal);
    } catch (e) {
      clear();
      throw new TransportError(`${request.method} ${stripQuery(request.url)}: request failed`, { cause: e });
    } finally {
      clearTimeout(headTimer);
    }
    const pairs: Array<[string, string]> = [];
    res.headers.forEach((v, k) => pairs.push([k, v]));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let consumed = false;
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const cancelBody = (reason?: unknown): Promise<void> => {
      cancellation ??= (reader ? reader.cancel(reason) : res.body?.cancel(reason)) ?? Promise.resolve();
      return cancellation;
    };
    const abortBody = () => { void cancelBody(controller.signal.reason).catch(() => {}); clear(); };
    controller.signal.addEventListener("abort", abortBody, { once: true });
    if (controller.signal.aborted) abortBody();
    const cleanup = () => { clear(); controller.signal.removeEventListener("abort", abortBody); };
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (consumed) throw new TypeError("response body has already been consumed");
      consumed = true;
      let ended = false;
      try {
        checkAborted(controller.signal);
        if (!res.body) { ended = true; return; }
        reader = res.body.getReader();
        for (;;) {
          const idle = setTimeout(() => controller.abort(new TransportError("response body read timed out")), readTimeoutMs);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await abortable(reader.read(), controller.signal);
            checkAborted(controller.signal);
          } finally { clearTimeout(idle); }
          if (chunk.done) { ended = true; break; }
          yield chunk.value;
        }
      } catch (e) {
        throw e instanceof TransportError ? e : new TransportError("reading response body failed", { cause: e });
      } finally {
        finished = true;
        cleanup();
        if (!ended) {
          controller.abort(new TransportError("response body abandoned"));
          try { await cancelBody(controller.signal.reason); } catch { /* cleanup must not mask a read failure */ }
        }
        reader?.releaseLock();
      }
    }
    return {
      status: res.status,
      reason: res.statusText,
      headers: pairs,
      chunks,
      async bytes() {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of chunks()) { parts.push(chunk); size += chunk.length; }
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { out.set(part, offset); offset += part.length; }
        return out;
      },
      async cancel(reason?: unknown) {
        if (finished) return;
        controller.abort(reason ?? new TransportError("response body cancelled"));
        cleanup();
        await cancelBody(controller.signal.reason);
      },
    };
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : url.slice(0, i);
}

export async function bufferResponse(res: TransportResponse): Promise<HttpResponse> {
  return new HttpResponse({ status: res.status, reason: res.reason, headers: res.headers, body: await res.bytes() });
}

let defaultTransport: Transport | undefined;
export function getDefaultTransport(): Transport {
  defaultTransport ??= new FetchTransport();
  return defaultTransport;
}
