/**
 * `LiveSession`: a realtime (websocket) session over a dialect's live
 * codec. The codec (config → setup frames, client event → wire frames,
 * server frame → canonical events) is the contract and lives in the
 * dialects; this class is the per-language session mechanics: the socket,
 * the send queue, the receive iterator. Uses the platform `WebSocket`
 * (Node 22+), no dependencies.
 */

import { TransportError, UnsupportedFeatureError } from "./errors.ts";
import { stringifyJson, type JsonObject } from "./json.ts";
import type { LiveClientEvent, LiveConfig, LiveServerEvent } from "./types/live.ts";
import { LiveClientEvent as LiveClientEventNs } from "./types/live.ts";
import { normalizeParts, type PartInput, type PromptPart, type ToolResultContentPart } from "./types/parts.ts";
import { GeminiLM } from "./dialects/gemini.ts";
import { OpenAILM } from "./dialects/openai_responses.ts";
import type { ProviderLM } from "./adapter.ts";

export interface LiveSessionOptions {
  /** A custom WebSocket constructor (tests, other runtimes). Default: `globalThis.WebSocket`. */
  readonly WebSocket?: typeof WebSocket;
}

type Waiter = { resolve: (v: IteratorResult<LiveServerEvent>) => void; reject: (e: unknown) => void };

/**
 * ```ts
 * const session = await LiveSession.open(new GeminiLM(), { model: "gemini-live-2.5-flash-preview" });
 * await session.sendText("hello");
 * for await (const event of session) {
 *   if (event.type === "text") process.stdout.write(event.text);
 *   if (event.type === "turn_end") break;
 * }
 * await session.close();
 * ```
 */
export class LiveSession implements AsyncIterable<LiveServerEvent> {
  private readonly queue: LiveServerEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private failure: unknown;

  private readonly ws: WebSocket;
  private readonly encode: (event: LiveClientEvent) => JsonObject[];
  private readonly decode: (raw: Uint8Array | string) => LiveServerEvent[];

  private constructor(ws: WebSocket, encode: (event: LiveClientEvent) => JsonObject[], decode: (raw: Uint8Array | string) => LiveServerEvent[]) {
    this.ws = ws;
    this.encode = encode;
    this.decode = decode;
  }

  /** Connect, send the setup frames, and (Gemini) wait for `setupComplete`. */
  static async open(lm: ProviderLM, config: LiveConfig, opts: LiveSessionOptions = {}): Promise<LiveSession> {
    const WS = opts.WebSocket ?? globalThis.WebSocket;
    if (typeof WS !== "function") throw new TransportError("no WebSocket implementation available; pass one in LiveSessionOptions");
    if (!lm.supports.live) throw new UnsupportedFeatureError(`${lm.provider}: live not supported`, { provider: lm.provider });
    let url: string;
    let headers: Record<string, string> = {};
    if (lm instanceof OpenAILM) {
      url = lm.liveUrl(config.model);
      headers = await lm.liveHeaders();
    } else if (lm instanceof GeminiLM) {
      url = await lm.liveUrl();
    } else throw new UnsupportedFeatureError(`${lm.provider}: live not supported`, { provider: lm.provider });

    // Node's WebSocket accepts headers through the (Node-only) `headers` init; browsers cannot set them.
    const ws = new (WS as unknown as new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket)(url, Object.keys(headers).length > 0 ? { headers } : undefined);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new TransportError(`websocket connect failed: ${stripQuery(url)}`)), { once: true });
    });
    const session = new LiveSession(ws, lm.liveEncoder(config), (raw) => lm.decodeLiveServerEvent(raw));
    const setupFrames = lm.liveSetupFrames(config);
    if (lm instanceof GeminiLM) {
      // Gemini answers the setup frame with setupComplete before any turn.
      const done = new Promise<void>((resolve, reject) => {
        const onMessage = (ev: MessageEvent) => {
          try {
            if (lm.liveSetupStatus(frameBytes(ev.data))) {
              ws.removeEventListener("message", onMessage);
              resolve();
            }
          } catch (e) {
            ws.removeEventListener("message", onMessage);
            reject(e);
          }
        };
        ws.addEventListener("message", onMessage);
      });
      for (const frame of setupFrames) ws.send(stringifyJson(frame));
      await done;
    } else for (const frame of setupFrames) ws.send(stringifyJson(frame));
    session.listen();
    return session;
  }

  private listen(): void {
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      for (const event of this.decode(frameBytes(ev.data))) this.push(event);
    });
    this.ws.addEventListener("close", () => this.finish(undefined));
    this.ws.addEventListener("error", () => this.finish(new TransportError("websocket error")));
  }

  private push(event: LiveServerEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  private finish(error: unknown): void {
    this.closed = true;
    this.failure ??= error;
    for (const w of this.waiters.splice(0)) {
      if (this.failure) w.reject(this.failure);
      else w.resolve({ value: undefined, done: true });
    }
  }

  /** Send one canonical client event (its wire frames, in order). */
  async send(event: LiveClientEvent): Promise<void> {
    if (this.closed) throw new TransportError("live session is closed");
    for (const frame of this.encode(LiveClientEventNs.create(event))) this.ws.send(stringifyJson(frame));
  }

  sendText(text: string): Promise<void> {
    return this.send({ type: "text", text });
  }
  sendTurn(content: PartInput<PromptPart>, opts: { turnComplete?: boolean } = {}): Promise<void> {
    return this.send({ type: "turn", parts: normalizeParts(content) as PromptPart[], turnComplete: opts.turnComplete ?? true });
  }
  sendAudio(data: string, mediaType?: string): Promise<void> {
    return this.send(mediaType !== undefined ? { type: "audio", data, mediaType } : { type: "audio", data });
  }
  sendImage(data: string, mediaType?: string): Promise<void> {
    return this.send(mediaType !== undefined ? { type: "image", data, mediaType } : { type: "image", data });
  }
  sendToolResult(id: string, content: PartInput<ToolResultContentPart>): Promise<void> {
    return this.send({ type: "tool_result", id, content: normalizeParts(content) as ToolResultContentPart[] });
  }
  interrupt(): Promise<void> {
    return this.send({ type: "interrupt" });
  }
  endAudio(): Promise<void> {
    return this.send({ type: "end_audio" });
  }

  /** The next canonical server event, or `undefined` when the socket closed. */
  recv(): Promise<LiveServerEvent | undefined> {
    return this.next().then((r) => (r.done ? undefined : r.value));
  }

  private next(): Promise<IteratorResult<LiveServerEvent>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.closed) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<LiveServerEvent> {
    return { next: () => this.next() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) => this.ws.addEventListener("close", () => resolve(), { once: true }));
    this.ws.close();
    await closed;
    this.finish(undefined);
  }
}

function frameBytes(data: unknown): Uint8Array | string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return String(data);
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : url.slice(0, i);
}
