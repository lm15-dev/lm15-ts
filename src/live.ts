/** Realtime session lifecycle over the provider-owned websocket codecs. */
import { abortable, checkAborted, positiveTimeout } from "./async.ts";
import { TransportError, UnsupportedFeatureError } from "./errors.ts";
import { stringifyJson, type JsonObject } from "./json.ts";
import { getDefaultPlatform } from "./platform.ts";
import { LiveConfig, LiveClientEvent as LiveClientEventNs, LiveServerEvent as LiveServerEventNs, type LiveClientEvent, type LiveServerEvent } from "./types/live.ts";
import { normalizeParts, type PartInput, type PromptPart, type ToolResultContentPart } from "./types/parts.ts";
import { decodeBase64, encodeBase64 } from "./types/validate.ts";
import { Usage, type ErrorDetail } from "./types/response.ts";
import { GeminiLM } from "./dialects/gemini.ts";
import { OpenAILM } from "./dialects/openai_responses.ts";
import type { ProviderLM } from "./adapter.ts";

export interface LiveSessionOptions {
  /**
   * The constructor to open with. A header-capable one (Node's, the `ws`
   * package's) may carry the OpenAI Realtime bearer header; a browser's
   * cannot, and the session says so instead of letting the page's
   * constructor reject an object where it expects subprotocols.
   */
  readonly WebSocket?: typeof WebSocket;
  /** Cancel connection establishment and the lifetime of the session. */
  readonly signal?: AbortSignal;
  /** Credential resolution, connection and setup deadline; default 30s. */
  readonly timeoutMs?: number;
  /** Maximum wait for a close acknowledgement; default 5s. */
  readonly closeTimeoutMs?: number;
}

type Waiter = { resolve: (v: IteratorResult<LiveServerEvent>) => void; reject: (e: unknown) => void };

export class LiveSession implements AsyncIterable<LiveServerEvent> {
  private readonly queue: LiveServerEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private failure: unknown;
  private closePromise: Promise<void> | undefined;
  private notifyClosed: (() => void) | undefined;
  private cleanup: () => void = () => {};
  private readonly ws: WebSocket;
  private readonly encode: (event: LiveClientEvent) => JsonObject[];
  private readonly decode: (raw: Uint8Array | string) => LiveServerEvent[];
  private readonly closeTimeoutMs: number;

  private constructor(ws: WebSocket, encode: (event: LiveClientEvent) => JsonObject[], decode: (raw: Uint8Array | string) => LiveServerEvent[], closeTimeoutMs: number) {
    this.ws = ws;
    this.encode = encode;
    this.decode = decode;
    this.closeTimeoutMs = closeTimeoutMs;
  }

  /** Install receivers before sending setup so immediate replies cannot be lost. */
  static async open(lm: ProviderLM, config: LiveConfig, opts: LiveSessionOptions = {}): Promise<LiveSession> {
    config = LiveConfig.create(config);
    checkAborted(opts.signal);
    const timeoutMs = positiveTimeout(opts.timeoutMs, "timeoutMs") ?? 30_000;
    const closeTimeoutMs = positiveTimeout(opts.closeTimeoutMs, "closeTimeoutMs") ?? 5000;
    const WS = opts.WebSocket ?? globalThis.WebSocket;
    if (typeof WS !== "function") throw new TransportError("no WebSocket implementation available; pass one in LiveSessionOptions");
    if (!lm.supports.live) throw new UnsupportedFeatureError(`${lm.provider}: live not supported`, { provider: lm.provider });
    const encode = lm.liveEncoder(config);
    const setupFrames = lm.liveSetupFrames(config);
    const controller = new AbortController();
    const abort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new TransportError("websocket connection/setup timed out")), timeoutMs);
    let session: LiveSession | undefined;
    try {
      let url: string;
      let headers: Record<string, string> = {};
      if (lm instanceof OpenAILM) {
        url = lm.liveUrl(config.model);
        headers = await abortable(lm.liveHeaders(), controller.signal);
      } else if (lm instanceof GeminiLM) {
        url = await abortable(lm.liveUrl(), controller.signal);
      } else throw new UnsupportedFeatureError(`${lm.provider}: live not supported`, { provider: lm.provider });
      checkAborted(controller.signal);
      // `{ headers }` is the Node constructor's extension. A host whose WebSocket
      // cannot carry headers (a page's) is refused by name, unless the caller
      // supplied a constructor of their own and so vouches for it.
      const platform = getDefaultPlatform();
      if (Object.keys(headers).length > 0 && !platform.webSocketHeaders && opts.WebSocket === undefined) {
        throw new UnsupportedFeatureError(
          `${lm.provider}: live sessions need request headers on the websocket, which the ${platform.name} platform's WebSocket cannot send; use a short-lived client token where the provider offers one, or pass a header-capable WebSocket in LiveSessionOptions`,
          { provider: lm.provider },
        );
      }
      const ws = new (WS as unknown as new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket)(url, Object.keys(headers).length > 0 ? { headers } : undefined);
      ws.binaryType = "arraybuffer";
      session = new LiveSession(ws, encode, (raw) => lm.decodeLiveServerEvent(raw), closeTimeoutMs);
      session.listen(opts.signal);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
          controller.signal.removeEventListener("abort", onAbort);
        };
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error !== undefined) reject(error); else resolve();
        };
        const onClose = () => finish(new TransportError("websocket closed during connection/setup"));
        const onError = () => finish(new TransportError("websocket failed during connection/setup"));
        const onAbort = () => finish(new TransportError("websocket connection/setup aborted", { cause: controller.signal.reason }));
        const onMessage = (event: MessageEvent) => {
          try {
            if (session?.failure !== undefined) finish(session.failure);
            else if (lm instanceof GeminiLM && lm.liveSetupStatus(frameBytes(event.data))) finish();
          }
          catch (e) { finish(e); }
        };
        const onOpen = () => {
          try {
            for (const frame of setupFrames) ws.send(stringifyJson(frame));
            if (!(lm instanceof GeminiLM)) finish();
          } catch (e) { finish(new TransportError("sending websocket setup failed", { cause: e })); }
        };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      checkAborted(opts.signal);
      return session;
    } catch (e) {
      session?.fail(e);
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  private listen(signal?: AbortSignal): void {
    const message = (event: MessageEvent) => {
      try { for (const decoded of this.decode(frameBytes(event.data))) this.push(decoded); }
      catch (e) { this.fail(new TransportError("decoding websocket message failed", { cause: e })); }
    };
    const close = (event: CloseEvent) => {
      this.finish(event.code !== undefined && event.code !== 1000 && event.code !== 1005
        ? new TransportError(`websocket closed abnormally (${event.code})`) : undefined);
    };
    const error = () => this.fail(new TransportError("websocket error"));
    const abort = () => this.fail(new TransportError("live session aborted", { cause: signal?.reason }));
    this.ws.addEventListener("message", message);
    this.ws.addEventListener("close", close);
    this.ws.addEventListener("error", error);
    signal?.addEventListener("abort", abort, { once: true });
    this.cleanup = () => {
      this.ws.removeEventListener("message", message);
      this.ws.removeEventListener("close", close);
      this.ws.removeEventListener("error", error);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) abort();
  }

  private push(event: LiveServerEvent): void {
    if (this.closed) return;
    event = LiveServerEventNs.create(event);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false }); else this.queue.push(event);
  }

  private finish(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.cleanup();
    for (const w of this.waiters.splice(0)) {
      if (error !== undefined) w.reject(error); else w.resolve({ value: undefined, done: true });
    }
    this.notifyClosed?.();
  }

  private fail(error: unknown): void {
    this.finish(error);
    try { this.ws.close(); } catch { /* state and pending readers are already settled */ }
  }

  async send(event: LiveClientEvent): Promise<void> {
    if (this.closed || this.closePromise) throw new TransportError("live session is closed");
    const frames = this.encode(LiveClientEventNs.create(event));
    try { for (const frame of frames) this.ws.send(stringifyJson(frame)); }
    catch (e) {
      const error = new TransportError("websocket send failed", { cause: e });
      this.fail(error);
      throw error;
    }
  }

  sendText(text: string): Promise<void> { return this.send({ type: "text", text }); }
  sendTurn(content: PartInput<PromptPart>, opts: { turnComplete?: boolean } = {}): Promise<void> {
    return this.send({ type: "turn", parts: normalizeParts(content) as PromptPart[], turnComplete: opts.turnComplete ?? true });
  }
  sendAudio(data: string | Uint8Array, mediaType?: string): Promise<void> {
    return this.send({ type: "audio", data: typeof data === "string" ? data : encodeBase64(data), ...(mediaType !== undefined ? { mediaType } : {}) });
  }
  sendImage(data: string | Uint8Array, mediaType?: string): Promise<void> {
    return this.send({ type: "image", data: typeof data === "string" ? data : encodeBase64(data), ...(mediaType !== undefined ? { mediaType } : {}) });
  }
  sendToolResult(id: string, content: PartInput<ToolResultContentPart>): Promise<void> {
    return this.send({ type: "tool_result", id, content: normalizeParts(content) as ToolResultContentPart[] });
  }
  interrupt(): Promise<void> { return this.send({ type: "interrupt" }); }
  endAudio(): Promise<void> { return this.send({ type: "end_audio" }); }
  recv(): Promise<LiveServerEvent | undefined> { return this.next().then((r) => r.done ? undefined : r.value); }

  private next(): Promise<IteratorResult<LiveServerEvent>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.closed) return this.failure !== undefined ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Breaking a turn's iteration leaves the full-duplex session open. Close explicitly. */
  [Symbol.asyncIterator](): AsyncIterator<LiveServerEvent> { return { next: () => this.next() }; }

  /**
   * One turn (LIVE-1, LIVE-2; api-family § Beyond chat): iterate its
   * events until `turn_end` / `interrupted` / `error`, or `await
   * turn.result()` for the materialized `Turn`. A `tool_call` is yielded
   * mid-turn and does not end iteration; `result()` returns at it (you
   * must answer with `sendToolResult`). The session itself stays open.
   */
  turn(): TurnView { return new TurnView(this); }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finish(new TransportError("websocket close timed out")), this.closeTimeoutMs);
      this.notifyClosed = () => { clearTimeout(timer); resolve(); };
      try { this.ws.close(); } catch (e) { this.finish(new TransportError("websocket close failed", { cause: e })); }
    }).then(() => { if (this.failure !== undefined) throw this.failure; });
    return this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

// ─── Turn: half-duplex ergonomics over the event stream ───────────────
//
// A live session is FULL-duplex; plain iteration is the primary surface.
// `turn()` serves the half-duplex idiom (send, then listen until the turn
// ends). The boundary and the bill are contract rules LIVE-1 and LIVE-2
// (changes/2026-09-11-job-handles-live-turns-profiles.md), not this
// port's habit.

const TURN_TERMINAL = new Set(["turn_end", "interrupted", "error"]);

export interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

/**
 * One materialized turn. `endedBy` is `turn_end` / `interrupted` / `error`
 * / `tool_call`; `usage` is the field-wise sum of every `usage` and
 * `turn_end` event the turn saw (a counter absent on either side stays
 * absent, INV-029). Materializing buffers text and audio in memory until
 * the turn ends; for latency-sensitive playback iterate events instead.
 */
export interface Turn {
  readonly endedBy: "turn_end" | "interrupted" | "error" | "tool_call";
  readonly ok: boolean;
  readonly text: string;
  readonly audio: Uint8Array;
  readonly audioMediaType?: string;
  readonly toolCalls: readonly ToolCallInfo[];
  readonly usage?: Usage;
  readonly error?: ErrorDetail;
  readonly events: readonly LiveServerEvent[];
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "inputAudioTokens", "outputAudioTokens"] as const;

/** Field-wise sum of two Usage values from one session; absent on either side is unknown in the sum, never zero (INV-029). */
export function sumUsage(acc: Usage | undefined, more: Usage): Usage {
  if (acc === undefined) return more;
  const out: Record<string, number> = {};
  for (const name of USAGE_FIELDS) {
    const a = acc[name], b = more[name];
    if (a !== undefined && b !== undefined) out[name] = a + b;
  }
  return Usage.create(out);
}

export function materializeTurn(events: readonly LiveServerEvent[]): Turn {
  const text: string[] = [];
  const audio: Uint8Array[] = [];
  let audioMediaType: string | undefined;
  const toolCalls: ToolCallInfo[] = [];
  let usage: Usage | undefined;
  let error: ErrorDetail | undefined;
  for (const event of events) {
    switch (event.type) {
      case "text": text.push(event.text); break;
      case "audio":
        audio.push(decodeBase64("audio", event.data));
        if (audioMediaType === undefined && event.mediaType !== undefined) audioMediaType = event.mediaType;
        break;
      case "tool_call": toolCalls.push({ id: event.id, name: event.name, input: event.input }); break;
      case "turn_end":
      case "usage":
        // A turn's bill is every usage-bearing event it saw (LIVE-2).
        usage = sumUsage(usage, event.usage);
        break;
      case "error": error = event.error; break;
      default: break;
    }
  }
  const last = events[events.length - 1];
  const endedBy = last !== undefined && (TURN_TERMINAL.has(last.type) || last.type === "tool_call") ? (last.type as Turn["endedBy"]) : "error";
  const total = audio.reduce((n, a) => n + a.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of audio) { bytes.set(chunk, offset); offset += chunk.length; }
  return Object.freeze({
    endedBy,
    ok: endedBy === "turn_end",
    text: text.join(""),
    audio: bytes,
    ...(audioMediaType !== undefined ? { audioMediaType } : {}),
    toolCalls: Object.freeze(toolCalls),
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    events: Object.freeze([...events]),
  });
}

/**
 * Iterator over one turn's server events. Ends itself after yielding the
 * terminal event (`turn_end` / `interrupted` / `error`) — the same
 * self-ending idiom as `stream()`. A `tool_call` is yielded mid-iteration
 * (you hold the session, so you can answer and keep iterating);
 * `result()` cannot answer for you, so it returns at a `tool_call` instead
 * of deadlocking against a model that is waiting for your result.
 */
export class TurnView implements AsyncIterable<LiveServerEvent> {
  private readonly session: LiveSession;
  private done = false;

  constructor(session: LiveSession) {
    this.session = session;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<LiveServerEvent> {
    while (!this.done) {
      const event = await this.session.recv();
      if (event === undefined) { this.done = true; return; } // the socket closed: nothing more to yield
      if (TURN_TERMINAL.has(event.type)) this.done = true;
      yield event;
    }
  }

  async result(): Promise<Turn> {
    const events: LiveServerEvent[] = [];
    for await (const event of this) {
      events.push(event);
      if (event.type === "tool_call") break;
    }
    return materializeTurn(events);
  }
}

function frameBytes(data: unknown): Uint8Array | string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new TransportError("unsupported websocket frame type");
}
