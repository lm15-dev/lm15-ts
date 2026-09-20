/** Native Node HTTP/1.1. Not imported by the browser entrypoint. */
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import { createInflate, createInflateRaw, type Inflate, type InflateRaw } from "node:zlib";
import { abortable, checkAborted, positiveTimeout } from "./async.ts";
import { ProtocolError, TransportError } from "./errors.ts";
import { collectBytes, contentCodings, Timeouts, TransportSlots, transportFailure, type Transport, type TransportBudgetOptions, type TransportResponse } from "./transport.ts";
import type { TransportRequest } from "./wire.ts";

/** No implicit redirects, retries, proxy environment lookup, or automatic decoding. */
export class NodeTransport implements Transport {
  readonly timeouts: Timeouts;
  readonly maxConnections: number;
  private readonly slots: TransportSlots;
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(opts: TransportBudgetOptions = {}) {
    this.timeouts = new Timeouts(opts.timeouts);
    this.slots = new TransportSlots(opts.maxConnections);
    this.maxConnections = this.slots.maximum;
    // The shared semaphore caps active connections ACROSS origins/protocols.
    // Do not add maxTotalSockets: an agent could then queue behind idle sockets
    // at a different origin, outside the explicit admission timeout.
    const settings = { keepAlive: true, maxSockets: this.maxConnections, maxFreeSockets: this.maxConnections };
    this.httpAgent = new http.Agent(settings);
    this.httpsAgent = new https.Agent(settings);
    const trim = () => this.trimIdle();
    this.httpAgent.on("free", trim);
    this.httpsAgent.on("free", trim);
  }

  /** Bound retained idle sockets across origins as well as active concurrency. */
  private trimIdle(): void {
    const agents = [this.httpAgent, this.httpsAgent];
    const active = agents.reduce((n, agent) => n + Object.values(agent.sockets).reduce((m, list) => m + (list?.length ?? 0), 0), 0);
    const idle = agents.flatMap(agent => Object.values(agent.freeSockets).flatMap(list => list ?? []));
    let excess = active + idle.length - this.maxConnections;
    for (const socket of idle) if (excess-- > 0) socket.destroy();
  }

  close(): void {
    this.closed = true;
    this.slots.close();
    for (const controller of this.controllers) controller.abort(new TransportError("transport is closed"));
    this.controllers.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  async send(request: TransportRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<TransportResponse> {
    checkAborted(opts.signal);
    if (this.closed) throw new TransportError("transport is closed");
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProtocolError(`unsupported HTTP URL scheme: ${url.protocol}`);
    if (url.username || url.password) throw new ProtocolError("URL credentials are not supported; use explicit authorization headers");
    const tls = url.protocol === "https:";
    const connectMs = positiveTimeout(request.connectTimeout === undefined ? undefined : request.connectTimeout * 1000, "connectTimeout") ?? this.timeouts.connect * 1000;
    const readMs = positiveTimeout(request.readTimeout === undefined ? undefined : request.readTimeout * 1000, "readTimeout") ?? this.timeouts.read * 1000;
    const writeMs = this.timeouts.write * 1000;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abortParent = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abortParent, { once: true });
    if (opts.signal?.aborted) abortParent();
    let release: (() => void) | undefined;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    let socket: Socket | undefined;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let headerReceived = false;
    let writeFinished = false;
    let cleaned = false;
    const clearPhase = () => { if (phaseTimer !== undefined) clearTimeout(phaseTimer); phaseTimer = undefined; };
    const arm = (ms: number, phase: string) => {
      clearPhase();
      phaseTimer = setTimeout(() => controller.abort(new TransportError(`lm15's ${phase} timeout expired; raise Timeouts.${phase === "response headers/read" ? "read" : phase} if the operation needs longer`)), ms);
    };
    const headerProgress = () => { if (writeFinished && !headerReceived) arm(readMs, "response headers/read"); };
    const destroy = () => {
      const cause = controller.signal.reason;
      const error = cause instanceof Error ? cause : new TransportError("request aborted", { cause });
      // Once the framed response has ended the agent may already have lent
      // this socket to another request. A later checksum/parser cancellation
      // owns only decoded buffers, never that newly borrowed connection.
      if (!(res?.complete && res.readableEnded)) {
        req?.destroy(error);
        res?.destroy(error);
      }
      cleanup();
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearPhase();
      socket?.removeListener("data", headerProgress);
      controller.signal.removeEventListener("abort", destroy);
      opts.signal?.removeEventListener("abort", abortParent);
      this.controllers.delete(controller);
      release?.();
    };
    controller.signal.addEventListener("abort", destroy, { once: true });
    try {
      release = await this.slots.acquire(this.timeouts.pool * 1000, controller.signal);
      // A permit can transfer just before cancellation's microtask is resumed.
      if (cleaned) release();
      checkAborted(controller.signal);
      const headers: string[] = [];
      for (const [k, v] of request.headers) headers.push(k, v);
      if (!request.headers.some(([k]) => k.toLowerCase() === "host")) headers.push("Host", url.host);
      if (!request.headers.some(([k]) => k.toLowerCase() === "accept-encoding")) headers.push("Accept-Encoding", "identity");
      if (!request.headers.some(([k]) => ["content-length", "transfer-encoding"].includes(k.toLowerCase()))) headers.push("Content-Length", String(request.body.length));
      arm(connectMs, "connect");
      const pending = new Promise<http.IncomingMessage>((resolve, reject) => {
        req = (tls ? https.request : http.request)(url, { method: request.method, headers, agent: tls ? this.httpsAgent : this.httpAgent });
        req.on("error", reject); // stays attached: cancellation after headers must not emit an unhandled error
        req.once("response", response => {
          res = response;
          // Error handling remains attached even when the caller never reads.
          response.on("error", error => { if (!controller.signal.aborted) controller.abort(new TransportError("response body failed", { cause: error })); });
          headerReceived = true;
          clearPhase();
          socket?.removeListener("data", headerProgress);
          resolve(response);
        });
        req.once("socket", assigned => {
          socket = assigned;
          this.trimIdle();
          const ready = () => {
            if (controller.signal.aborted) return;
            clearPhase();
            socket?.on("data", headerProgress);
            void writeBody().catch(error => controller.abort(error));
          };
          if (req!.reusedSocket || (!tls && !assigned.connecting)) ready();
          else assigned.once(tls ? "secureConnect" : "connect", ready);
        });
      });
      const writeBody = async () => {
        // Each callback means this write has flushed to the socket, not merely
        // entered ClientRequest's queue. The deadline resets for each block.
        for (let offset = 0; offset < request.body.length; offset += 64 * 1024) {
          if (headerReceived) break; // provider rejected an upload early
          checkAborted(controller.signal);
          arm(writeMs, "write");
          await abortable(new Promise<void>((resolve, reject) => req!.write(request.body.subarray(offset, offset + 64 * 1024), error => error ? reject(error) : resolve())), controller.signal);
        }
        checkAborted(controller.signal);
        if (!headerReceived) arm(writeMs, "write");
        await abortable(new Promise<void>(resolve => req!.end(resolve)), controller.signal);
        writeFinished = true;
        if (!headerReceived) arm(readMs, "response headers/read");
      };
      res = await abortable(pending, controller.signal);
      checkAborted(controller.signal);
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
      const noBody = request.method.toUpperCase() === "HEAD" || res.statusCode === 204 || res.statusCode === 304;
      const codings = noBody ? [] : contentCodings(pairs);
      const response = res;
      let consumed = false;
      let finished = false;
      async function* rawChunks(): AsyncGenerator<Uint8Array> {
        const it = response[Symbol.asyncIterator]();
        try {
          for (;;) {
            checkAborted(controller.signal);
            const timer = setTimeout(() => controller.abort(new TransportError("lm15's read timeout expired; raise Timeouts.read if the model needs longer")), readMs);
            let item: IteratorResult<Buffer>;
            try { item = await abortable(it.next(), controller.signal); checkAborted(controller.signal); }
            finally { clearTimeout(timer); }
            if (item.done) break;
            yield item.value;
          }
          if (!response.complete) throw new ProtocolError("HTTP response body is truncated");
        } finally {
          if (!response.complete) response.destroy();
          await it.return?.();
        }
      }
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (consumed) throw new TypeError("response body has already been consumed");
        consumed = true;
        let ended = false;
        try {
          checkAborted(controller.signal);
          let source: AsyncIterable<Uint8Array> = rawChunks();
          for (const coding of [...codings].reverse()) source = decodeCoding(source, coding, controller);
          yield* source;
          ended = true;
        } catch (cause) {
          throw transportFailure(controller.signal, cause, "reading response body failed");
        } finally {
          finished = true;
          if (!ended) controller.abort(new TransportError("response body abandoned"));
          cleanup();
        }
      }
      return {
        status: response.statusCode ?? 0, reason: response.statusMessage ?? "", headers: pairs, chunks,
        bytes: () => collectBytes(chunks()),
        async cancel(reason?: unknown) {
          if (finished) return;
          finished = true;
          controller.abort(reason ?? new TransportError("response body cancelled"));
          cleanup();
        },
      };
    } catch (cause) {
      if (!controller.signal.aborted) controller.abort(cause);
      cleanup();
      throw transportFailure(controller.signal, cause, "HTTP request failed");
    }
  }
}

/** Wrapped/raw deflate selection needs two bytes, independent of read boundaries. */
async function* decodeCoding(source: AsyncIterable<Uint8Array>, coding: string, controller: AbortController): AsyncGenerator<Uint8Array> {
  if (coding !== "deflate") { yield* decodeGzip(source, controller); return; }
  const it = source[Symbol.asyncIterator]();
  let decoder: Inflate | InflateRaw | undefined;
  let completed = false;
  let failure: unknown;
  let pump: Promise<void> | undefined;
  let pumpFailure: unknown;
  let inputBytes = 0;
  try {
    const prefix: Uint8Array[] = [];
    let prefixSize = 0;
    if (coding === "deflate") {
      while (prefixSize < 2) {
        const item = await it.next();
        if (item.done) break;
        prefix.push(item.value); prefixSize += item.value.length;
      }
      const first = new Uint8Array(prefixSize);
      let offset = 0;
      for (const part of prefix) { first.set(part, offset); offset += part.length; }
      const cmf = first[0] ?? 0;
      const flg = first[1] ?? 0;
      const wrapped = first.length >= 2 && (cmf & 15) === 8 && (cmf >> 4) <= 7 && ((cmf << 8) + flg) % 31 === 0;
      decoder = wrapped ? createInflate() : createInflateRaw();
    }
    const stream = decoder!;
    // The consumer installs its stream iterator before writes begin.
    pump = Promise.resolve().then(async () => {
      const write = (bytes: Uint8Array) => new Promise<void>((resolve, reject) => {
        inputBytes += bytes.length;
        stream.write(bytes, error => {
          if (error) reject(error);
          else if (stream.bytesWritten !== inputBytes) reject(new ProtocolError("trailing bytes after deflate response"));
          else resolve();
        });
      });
      for (const bytes of prefix) await write(bytes);
      for (;;) {
        const item = await it.next();
        if (item.done) break;
        await write(item.value);
      }
      stream.end();
    }).catch(error => { pumpFailure = error; stream.destroy(error instanceof Error ? error : new Error("content decoding failed", { cause: error })); });
    for await (const chunk of stream) yield chunk as Uint8Array;
    await pump;
    if (pumpFailure !== undefined) throw pumpFailure;
    // zlib otherwise silently ignores bytes following a deflate stream.
    if (stream.bytesWritten !== inputBytes) throw new ProtocolError("trailing bytes after deflate response");
    completed = true;
  } catch (cause) {
    failure = cause instanceof TransportError ? cause : new ProtocolError(`invalid ${coding} response body (corrupt, truncated, or invalid trailing bytes)`, { cause });
    throw failure;
  } finally {
    if (!completed && !controller.signal.aborted) controller.abort(failure ?? new TransportError("response body abandoned"));
    decoder?.destroy();
    // Closing the upstream iterator propagates early consumer abandonment.
    await it.return?.();
    if (pump) void pump.catch(() => {});
  }
}

/** A cursor over framed bytes; only the current network chunk is retained. */
class CodingCursor {
  private pending: Uint8Array = new Uint8Array(0);
  readonly iterator: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterable<Uint8Array>) { this.iterator = source[Symbol.asyncIterator](); }
  unread(bytes: Uint8Array): void { this.pending = bytes; }
  async chunk(): Promise<Uint8Array | undefined> {
    if (this.pending.length) { const bytes = this.pending; this.pending = new Uint8Array(0); return bytes; }
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) return undefined;
      if (next.value.length) return next.value;
    }
  }
  async byte(): Promise<number | undefined> {
    const bytes = await this.chunk();
    if (!bytes) return undefined;
    this.unread(bytes.subarray(1));
    return bytes[0]!;
  }
  async required(): Promise<number> {
    const value = await this.byte();
    if (value === undefined) throw new ProtocolError("truncated gzip header or trailer");
    return value;
  }
  async uint32(): Promise<number> {
    const a = await this.required(), b = await this.required(), c = await this.required(), d = await this.required();
    return (a | b << 8 | c << 16 | d << 24) >>> 0;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crcByte(crc: number, byte: number): number { return (CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8)) >>> 0; }

/**
 * Explicit member framing is needed: Node's Gunzip accepts zero padding but
 * stops there, hiding a later member (including a corrupt/truncated one).
 * zlib still does all DEFLATE work; we check RFC1952 header/trailer integrity,
 * restart for EVERY member, and permit padding only between/after members.
 */
async function* decodeGzip(source: AsyncIterable<Uint8Array>, controller: AbortController): AsyncGenerator<Uint8Array> {
  const cursor = new CodingCursor(source);
  let stream: InflateRaw | undefined;
  let completed = false;
  let failure: unknown;
  let members = 0;
  try {
    for (;;) {
      let first = await cursor.byte();
      if (members > 0) while (first === 0) first = await cursor.byte();
      if (first === undefined) {
        if (!members) throw new ProtocolError("empty gzip response has no member");
        completed = true;
        return;
      }
      let headerCrc = 0xffffffff;
      headerCrc = crcByte(headerCrc, first);
      const byte = async () => { const b = await cursor.required(); headerCrc = crcByte(headerCrc, b); return b; };
      if (first !== 0x1f || await byte() !== 0x8b || await byte() !== 8) throw new ProtocolError("invalid gzip member header or trailing bytes");
      const flags = await byte();
      if (flags & 0xe0) throw new ProtocolError("gzip header has reserved flags");
      for (let i = 0; i < 6; i++) await byte(); // MTIME, XFL, OS
      if (flags & 4) {
        const length = (await byte()) | (await byte()) << 8;
        for (let i = 0; i < length; i++) await byte();
      }
      if (flags & 8) while (await byte() !== 0) { /* filename */ }
      if (flags & 16) while (await byte() !== 0) { /* comment */ }
      if (flags & 2) {
        const expected = (await cursor.required()) | (await cursor.required()) << 8;
        if (((headerCrc ^ 0xffffffff) & 0xffff) !== expected) throw new ProtocolError("gzip header checksum mismatch");
      }
      stream = createInflateRaw();
      const inflater = stream;
      let pumpFailure: unknown;
      const pump = Promise.resolve().then(async () => {
        for (;;) {
          const bytes = await cursor.chunk();
          if (!bytes) { inflater.end(); return; }
          const before = inflater.bytesWritten;
          await new Promise<void>((resolve, reject) => inflater.write(bytes, error => error ? reject(error) : resolve()));
          const used = inflater.bytesWritten - before;
          if (used < bytes.length) {
            cursor.unread(bytes.subarray(used));
            inflater.end();
            return;
          }
        }
      }).catch(error => { pumpFailure = error; inflater.destroy(error instanceof Error ? error : new Error("gzip decode failed", { cause: error })); });
      let crc = 0xffffffff;
      let size = 0;
      for await (const output of inflater) {
        const bytes = output as Uint8Array;
        for (const b of bytes) crc = crcByte(crc, b);
        size = (size + bytes.length) >>> 0;
        yield bytes;
      }
      await pump;
      if (pumpFailure !== undefined) throw pumpFailure;
      const expectedCrc = await cursor.uint32();
      const expectedSize = await cursor.uint32();
      if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new ProtocolError("gzip member checksum mismatch");
      if (size !== expectedSize) throw new ProtocolError("gzip member size mismatch");
      stream.destroy();
      stream = undefined;
      members++;
    }
  } catch (cause) {
    failure = cause instanceof TransportError ? cause : new ProtocolError("invalid gzip response body (corrupt or truncated member)", { cause });
    throw failure;
  } finally {
    if (!completed && !controller.signal.aborted) controller.abort(failure ?? new TransportError("response body abandoned"));
    stream?.destroy();
    await cursor.iterator.return?.();
  }
}
