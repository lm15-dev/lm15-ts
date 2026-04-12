/**
 * Live sessions — WebSocket-based real-time audio/video/text.
 */

import type {
  JsonObject, LiveClientEvent, LiveServerEvent, Part, Tool, ToolCallInfo,
} from "./types.js";
import { Part as PartFactory } from "./types.js";

export type EncodeEventFn = (event: LiveClientEvent) => JsonObject[];
export type DecodeEventFn = (raw: string | Uint8Array) => LiveServerEvent[];

function toBase64(data: Uint8Array | string): string {
  if (typeof data === "string") return data;
  return Buffer.from(data).toString("base64");
}

function toolResultParts(value: unknown): Part[] {
  if (typeof value === "object" && value !== null && "type" in value) return [value as Part];
  if (Array.isArray(value) && value.every(x => typeof x === "object" && x !== null && "type" in x)) return value as Part[];
  return [PartFactory.text(String(value))];
}

function invokeTool(fn: (...args: unknown[]) => unknown, payload: JsonObject): unknown {
  try {
    return (fn as (arg: JsonObject) => unknown)(payload);
  } catch {
    return fn(...Object.values(payload));
  }
}

/**
 * Provider-agnostic WebSocket live session.
 */
export class WebSocketLiveSession {
  private _ws: WebSocket;
  private _encodeEvent: EncodeEventFn;
  private _decodeEvent: DecodeEventFn;
  private _callableRegistry: Record<string, (...args: unknown[]) => unknown>;
  private _onToolCall?: (info: ToolCallInfo) => unknown;
  private _closed = false;
  private _pending: LiveServerEvent[] = [];
  private _resolveNext?: (value: LiveServerEvent) => void;
  private _rejectNext?: (err: Error) => void;
  private _buffer: LiveServerEvent[] = [];
  private _wsError?: Error;

  constructor(opts: {
    ws: WebSocket;
    encodeEvent: EncodeEventFn;
    decodeEvent: DecodeEventFn;
    callableRegistry?: Record<string, (...args: unknown[]) => unknown>;
    onToolCall?: (info: ToolCallInfo) => unknown;
  }) {
    this._ws = opts.ws;
    this._encodeEvent = opts.encodeEvent;
    this._decodeEvent = opts.decodeEvent;
    this._callableRegistry = opts.callableRegistry ?? {};
    this._onToolCall = opts.onToolCall;

    this._ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const decoded = this._decodeEvent(raw);
      for (const evt of decoded) {
        this._maybeAutoExecuteTool(evt);
        if (this._resolveNext) {
          const resolve = this._resolveNext;
          this._resolveNext = undefined;
          this._rejectNext = undefined;
          resolve(evt);
        } else {
          this._buffer.push(evt);
        }
      }
    });

    this._ws.addEventListener("error", () => {
      this._wsError = new Error("WebSocket error");
      if (this._rejectNext) {
        const reject = this._rejectNext;
        this._resolveNext = undefined;
        this._rejectNext = undefined;
        reject(this._wsError);
      }
    });

    this._ws.addEventListener("close", () => {
      this._closed = true;
      if (this._rejectNext) {
        const reject = this._rejectNext;
        this._resolveNext = undefined;
        this._rejectNext = undefined;
        reject(new Error("WebSocket closed"));
      }
    });
  }

  setOnToolCall(callback?: (info: ToolCallInfo) => unknown): void {
    this._onToolCall = callback;
  }

  send(
    event?: LiveClientEvent,
    opts?: {
      audio?: Uint8Array | string;
      video?: Uint8Array | string;
      text?: string;
      tool_result?: Record<string, unknown>;
      interrupt?: boolean;
      end_audio?: boolean;
    },
  ): void {
    if (this._closed) throw new Error("live session is closed");

    let events: LiveClientEvent[];
    if (event) {
      events = [event];
    } else {
      events = this._eventsFromOpts(opts ?? {});
    }

    for (const evt of events) {
      const payloads = this._encodeEvent(evt);
      for (const payload of payloads) {
        this._ws.send(JSON.stringify(payload));
      }
    }
  }

  async recv(): Promise<LiveServerEvent> {
    if (this._closed) throw new Error("live session is closed");
    if (this._buffer.length > 0) return this._buffer.shift()!;
    return new Promise<LiveServerEvent>((resolve, reject) => {
      this._resolveNext = resolve;
      this._rejectNext = reject;
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try { this._ws.close(); } catch { /* ignore */ }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<LiveServerEvent> {
    while (!this._closed) {
      try {
        yield await this.recv();
      } catch {
        break;
      }
    }
  }

  private _eventsFromOpts(opts: {
    audio?: Uint8Array | string;
    video?: Uint8Array | string;
    text?: string;
    tool_result?: Record<string, unknown>;
    interrupt?: boolean;
    end_audio?: boolean;
  }): LiveClientEvent[] {
    const events: LiveClientEvent[] = [];

    if (opts.audio != null) {
      events.push({ type: "audio", data: toBase64(opts.audio) });
    }
    if (opts.video != null) {
      events.push({ type: "video", data: toBase64(opts.video) });
    }
    if (opts.text != null) {
      events.push({ type: "text", text: opts.text });
    }
    if (opts.tool_result) {
      for (const [callId, value] of Object.entries(opts.tool_result)) {
        const content = toolResultParts(value);
        events.push({ type: "tool_result", id: callId, content });
      }
    }
    if (opts.interrupt) {
      events.push({ type: "interrupt" });
    }
    if (opts.end_audio) {
      events.push({ type: "end_audio" });
    }

    if (!events.length) throw new Error("nothing to send");
    return events;
  }

  private _maybeAutoExecuteTool(event: LiveServerEvent): void {
    if (event.type !== "tool_call" || !event.id) return;

    const info: ToolCallInfo = {
      id: event.id,
      name: event.name ?? "tool",
      input: event.input ?? {},
    };

    let result: unknown = undefined;

    if (this._onToolCall) {
      const override = this._onToolCall(info);
      if (override != null) result = override;
    }

    if (result == null) {
      const fn = this._callableRegistry[info.name];
      if (fn) result = invokeTool(fn, info.input);
    }

    if (result != null) {
      this.send(undefined, { tool_result: { [info.id]: result } });
    }
  }
}
