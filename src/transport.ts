/** Portable transport contracts and the browser Fetch implementation. */
import { abortable, checkAborted, positiveTimeout } from "./async.ts";
import { ProtocolError, TransportError, UnsupportedFeatureError } from "./errors.ts";
import { HttpResponse, type TransportRequest } from "./wire.ts";

/** A decoded HTTP entity. Custom transports must enforce INV-053 before yielding
 * bytes: identity/gzip/x-gzip/deflate only, decoding each coding exactly once.
 * Headers retain the provider's original metadata even after content decoding.
 */
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
  close?(): void | Promise<void>;
}

export interface TimeoutValues {
  readonly connect: number;
  readonly read: number;
  readonly write: number;
  readonly pool: number;
}

/** Seconds, per operation rather than a total generation deadline. */
export class Timeouts implements TimeoutValues {
  readonly connect: number;
  readonly read: number;
  readonly write: number;
  readonly pool: number;
  constructor(values: Partial<TimeoutValues> = {}) {
    if (values === null || typeof values !== "object" || Array.isArray(values)) throw new TypeError("Timeouts must be an object of phase budgets in seconds");
    for (const key of Object.keys(values)) if (!["connect", "read", "write", "pool"].includes(key)) throw new TypeError(`unknown timeout phase: ${key}`);
    this.connect = seconds(values.connect === undefined ? 10 : values.connect, "connect");
    this.read = seconds(values.read === undefined ? 600 : values.read, "read");
    this.write = seconds(values.write === undefined ? 600 : values.write, "write");
    this.pool = seconds(values.pool === undefined ? 600 : values.pool, "pool");
    Object.freeze(this);
  }
}

function seconds(value: number, name: string): number {
  if (typeof value !== "number") throw new TypeError(`Timeouts.${name} must be a number of seconds`);
  positiveTimeout(value * 1000, `Timeouts.${name} (converted to milliseconds)`);
  return value;
}

export interface TransportBudgetOptions {
  readonly timeouts?: Partial<TimeoutValues> | undefined;
  readonly maxConnections?: number | undefined;
}

export const DEFAULT_MAX_CONNECTIONS = 100;

/** A bounded FIFO admission queue; permits stay owned until body release. */
export class TransportSlots {
  private active = 0;
  private closed = false;
  private readonly queue: Array<{ grant(): void; fail(reason: unknown): void }> = [];
  readonly maximum: number;
  constructor(maximum = DEFAULT_MAX_CONNECTIONS) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("maxConnections must be a positive integer");
    this.maximum = maximum;
  }
  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    checkAborted(signal);
    if (this.closed) throw new TransportError("transport is closed");
    if (this.active < this.maximum) { this.active++; return this.releaseOnce(); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const waiter = {
        grant: () => {
          if (settled) return;
          settled = true; cleanup();
          // The preceding owner transfers its permit without a decrement.
          resolve(this.releaseOnce());
        },
        fail: (reason: unknown) => {
          if (settled) return;
          settled = true; cleanup();
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(reason);
        },
      };
      const abort = () => waiter.fail(new TransportError("pool wait aborted", { cause: signal?.reason }));
      const timer = setTimeout(() => waiter.fail(new TransportError(`lm15's pool timeout: all ${this.maximum} slots busy; raise maxConnections or Timeouts.pool`)), timeoutMs);
      this.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active--;
    };
  }
  close(): void {
    this.closed = true;
    for (const waiter of [...this.queue]) waiter.fail(new TransportError("transport is closed"));
  }
}

/** Validate before a parser sees any body. Decode in reverse order on raw transports. */
export function contentCodings(headers: ReadonlyArray<readonly [string, string]>): string[] {
  const codings = headers.filter(([k]) => k.toLowerCase() === "content-encoding").flatMap(([, v]) => v.split(",").map(s => s.trim().toLowerCase())).filter(Boolean);
  for (const coding of codings) {
    if (!["identity", "gzip", "x-gzip", "deflate"].includes(coding)) throw new ProtocolError(`unsupported Content-Encoding: ${JSON.stringify(coding)}`);
  }
  return codings.filter(c => c !== "identity");
}

export interface FetchTransportOptions extends TransportBudgetOptions {
  /** Must obey Fetch's decoded-body contract; a raw HTTP mock is not Fetch. */
  readonly fetch?: typeof fetch;
  /** Optional total deadline, including the local queue and body. Not an idle timeout. */
  readonly timeoutMs?: number;
  /** Combined connect/write/response-header deadline; default Timeouts.read (600s). */
  readonly headersTimeoutMs?: number;
  /** Maximum wait for each body chunk; default Timeouts.read (600s). */
  readonly readTimeoutMs?: number;
  /** LOCAL admission wait only, NOT the browser's hidden socket-pool timeout. */
  readonly poolTimeoutMs?: number;
}

/**
 * Fetch already inflates response bodies: never decompress them a second time.
 * Exposed Content-Encoding headers are checked, including br/zstd refusal.
 * CORS can hide that header; the browser may alter Accept-Encoding or reject
 * corrupt compression before exposing a response. Those runtime limitations
 * cannot be repaired by decoding already-decoded bytes. Native NodeTransport
 * provides raw HTTP coding and independent phase control instead.
 *
 * maxConnections here bounds outstanding operations, not browser sockets.
 * Explicit connect/write/pool settings are refused, never silently ignored.
 */
export class FetchTransport implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly headersTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly poolTimeoutMs: number;
  private readonly slots: TransportSlots;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(opts: FetchTransportOptions = {}) {
    for (const field of ["connect", "write", "pool"] as const) {
      if (opts.timeouts?.[field] !== undefined) throw new UnsupportedFeatureError(`platform fetch cannot set a separate ${field} timeout; use NodeTransport or a configured custom Transport`);
    }
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TransportError("no fetch implementation available; pass one to FetchTransport");
    const timeouts = new Timeouts(opts.timeouts);
    this.fetchImpl = f;
    this.timeoutMs = positiveTimeout(opts.timeoutMs, "timeoutMs");
    this.headersTimeoutMs = positiveTimeout(opts.headersTimeoutMs, "headersTimeoutMs") ?? timeouts.read * 1000;
    this.readTimeoutMs = positiveTimeout(opts.readTimeoutMs, "readTimeoutMs") ?? timeouts.read * 1000;
    this.poolTimeoutMs = positiveTimeout(opts.poolTimeoutMs, "poolTimeoutMs") ?? timeouts.pool * 1000;
    this.slots = new TransportSlots(opts.maxConnections);
  }

  close(): void {
    this.closed = true;
    this.slots.close();
    for (const controller of this.controllers) controller.abort(new TransportError("transport is closed"));
    this.controllers.clear();
  }

  async send(request: TransportRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<TransportResponse> {
    checkAborted(opts.signal);
    if (this.closed) throw new TransportError("transport is closed");
    if (request.connectTimeout !== undefined) throw new UnsupportedFeatureError("platform fetch cannot set a separate connect timeout; inject a configured Transport");
    const readTimeoutMs = positiveTimeout(request.readTimeout === undefined ? undefined : request.readTimeout * 1000, "readTimeout") ?? this.readTimeoutMs;
    const headers = new Headers();
    for (const [k, v] of request.headers) headers.append(k, v);
    if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const totalTimer = this.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new TransportError("lm15's total request timeout (timeoutMs) expired")), this.timeoutMs);
    let release: (() => void) | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
      release?.();
    };
    let res: globalThis.Response;
    try {
      release = await this.slots.acquire(this.poolTimeoutMs, controller.signal);
      checkAborted(controller.signal);
      const headTimer = setTimeout(() => controller.abort(new TransportError("lm15's response headers timeout expired; raise headersTimeoutMs or Timeouts.read (Fetch combines connect/write/headers)")), request.readTimeout === undefined ? this.headersTimeoutMs : readTimeoutMs);
      try {
        // An undefined receiver is required by browser WebIDL fetch.
        const pending = (0, this.fetchImpl)(request.url, {
          method: request.method, headers,
          body: request.body.length > 0 ? (request.body as unknown as BodyInit) : null,
          signal: controller.signal, redirect: "follow",
        });
        void pending.then(late => {
          if (controller.signal.aborted) void Promise.resolve().then(() => late.body?.cancel()).catch(() => {});
        }, () => {});
        res = await abortable(pending, controller.signal);
        checkAborted(controller.signal);
      } finally { clearTimeout(headTimer); }
    } catch (cause) {
      cleanup();
      throw transportFailure(controller.signal, cause, "fetch request failed (a browser may report CORS and network failures identically)");
    }
    const pairs: Array<[string, string]> = [];
    res.headers.forEach((v, k) => pairs.push([k, v]));
    try {
      if (request.method.toUpperCase() !== "HEAD" && res.status !== 204 && res.status !== 304) contentCodings(pairs);
    }
    catch (cause) {
      controller.abort(cause);
      void Promise.resolve().then(() => res.body?.cancel(cause)).catch(() => {});
      cleanup();
      throw cause;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let consumed = false;
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const cancelBody = (reason?: unknown): Promise<void> => {
      // Schedule even a throwing custom cancel as a rejected promise.
      cancellation ??= Promise.resolve().then(() => reader ? reader.cancel(reason) : res.body?.cancel(reason));
      return cancellation;
    };
    const abortBody = () => { void cancelBody(controller.signal.reason).catch(() => {}); cleanup(); };
    controller.signal.addEventListener("abort", abortBody, { once: true });
    if (controller.signal.aborted) abortBody();
    const finish = () => { finished = true; cleanup(); controller.signal.removeEventListener("abort", abortBody); };
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (consumed) throw new TypeError("response body has already been consumed");
      consumed = true;
      let ended = false;
      try {
        checkAborted(controller.signal);
        if (!res.body) { ended = true; return; }
        reader = res.body.getReader();
        for (;;) {
          const idle = setTimeout(() => controller.abort(new TransportError("lm15's response body read timeout expired; raise readTimeoutMs or Timeouts.read if the model needs longer")), readTimeoutMs);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await abortable(reader.read(), controller.signal); checkAborted(controller.signal); }
          finally { clearTimeout(idle); }
          if (chunk.done) { ended = true; break; }
          yield chunk.value;
        }
      } catch (cause) {
        throw transportFailure(controller.signal, cause, "reading response body failed");
      } finally {
        if (!ended) {
          controller.abort(new TransportError("response body abandoned"));
          // Do not let a custom Fetch cancel() that never settles trap cleanup.
          void cancelBody(controller.signal.reason).catch(() => {});
        }
        finish();
        try { reader?.releaseLock(); } catch { /* pending custom read */ }
      }
    }
    return {
      status: res.status, reason: res.statusText, headers: pairs, chunks,
      bytes: () => collectBytes(chunks()),
      async cancel(reason?: unknown) {
        if (finished) return;
        controller.abort(reason ?? new TransportError("response body cancelled"));
        void cancelBody(controller.signal.reason).catch(() => {});
        finish();
      },
    };
  }
}

/** Keep deadline messages visible; native/user cancellation still belongs to transport. */
export function transportFailure(signal: AbortSignal, cause: unknown, message: string): TransportError {
  if (signal.aborted && signal.reason instanceof TransportError) return signal.reason;
  return cause instanceof TransportError ? cause : new TransportError(message, { cause });
}

export async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) { parts.push(chunk); size += chunk.length; }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export async function bufferResponse(res: TransportResponse): Promise<HttpResponse> {
  return new HttpResponse({ status: res.status, reason: res.reason, headers: res.headers, body: await res.bytes() });
}

type TransportFactory = (opts: TransportBudgetOptions) => Transport;
let factory: TransportFactory = opts => new FetchTransport(opts);
let defaultTransport: Transport | undefined;
/** Node entrypoint installs its factory without putting Node imports in browsers. */
export function installTransportFactory(value: TransportFactory): void { factory = value; defaultTransport = undefined; }
export function createTransport(opts: TransportBudgetOptions = {}): Transport { return factory(opts); }
export function getDefaultTransport(): Transport { return defaultTransport ??= createTransport(); }
