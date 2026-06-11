/**
 * lm15 client layer — the provider LM classes (the reference's
 * `OpenAILM` / `OpenAIChatLM` / `AnthropicLM` / `GeminiLM`).
 *
 * Transport: Node's global `fetch` (undici), which keep-alives and pools
 * connections per origin by default and exposes response bodies as async
 * iterables — strictly cleaner than hand-rolling node:https, and still zero
 * runtime dependencies (undici ships inside Node).
 *
 * Wire bodies are rendered by the canonical stringifier so the
 * int-vs-declared-float Number rule survives the live path (a plain
 * JSON.stringify would collapse CFloat markers).
 *
 * Non-chat endpoints (embeddings/files/batch/image/audio) and live sessions
 * are provisional in the contract (SCOPE.md) and deliberately absent here.
 */

import {
  parseCanonicalJson,
  stringifyCanonicalJson,
  type JsonValue,
} from "./canonical-json.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import type { ProviderAdapter, WireRequest } from "./adapters/common.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { OpenAIChatAdapter } from "./adapters/openai-chat.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { LM15Error, RequestTimeoutError, TransportError, ValueError } from "./errors.js";
import { normalizeError } from "./normalize-error.js";
import type { SSEEvent } from "./sse.js";
import type { Request, Response, StreamEvent, Usage } from "./types.js";
import { streamEndEvent } from "./types.js";

// ─── Options ─────────────────────────────────────────────────────────

/** Minimal fetch shape the client needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  readonly body: AsyncIterable<Uint8Array> | null;
}>;

export interface LMOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds (default: no timeout). */
  readonly timeoutMs?: number;
  /** Transport override, mainly for tests. Defaults to global fetch. */
  readonly fetch?: FetchLike;
}

export interface OpenAIChatLMOptions extends LMOptions {
  /**
   * Compat preset name ("ollama", "groq", "openrouter", "vllm", "sglang",
   * ...). Bundles that server's wire-format quirks and its default
   * `baseUrl`; an explicit `baseUrl` points the preset anywhere.
   */
  readonly compat?: string;
}

// ─── Incremental SSE parsing (same grammar as sse.ts, but push-based) ─

class SseFeed {
  private buffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];

  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null) break;
      // A lone "\r" at the very end of the buffer might be half of "\r\n".
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line, events);
    }
    return events;
  }

  end(): SSEEvent[] {
    const events: SSEEvent[] = [];
    if (this.buffer !== "") {
      this.line(this.buffer.replace(/\r$/, ""), events);
      this.buffer = "";
    }
    this.flush(events);
    return events;
  }

  private line(line: string, events: SSEEvent[]): void {
    if (line === "") {
      this.flush(events);
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      this.eventName = line.slice("event:".length).trim();
      return;
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice("data:".length).replace(/^\s+/, ""));
    }
  }

  private flush(events: SSEEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({ event: this.eventName, data: this.dataLines.join("\n") });
    }
    this.eventName = null;
    this.dataLines = [];
  }
}

// ─── Base client ─────────────────────────────────────────────────────

function wireUrl(wire: WireRequest): string {
  const params = Object.entries(wire.params);
  if (params.length === 0) return wire.url;
  const qs = new URLSearchParams(params).toString();
  return `${wire.url}?${qs}`;
}

function transportFailure(err: unknown, timeoutMs: number | undefined): Error {
  if (
    timeoutMs !== undefined &&
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return new RequestTimeoutError(`request timed out after ${timeoutMs}ms`);
  }
  const cause = err instanceof Error ? (err.cause ?? err) : err;
  return new TransportError(`transport failure: ${String(cause)}`);
}

abstract class BaseLM {
  abstract readonly provider: "openai" | "openai_chat" | "anthropic" | "gemini";
  protected abstract readonly adapter: ProviderAdapter;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: FetchLike;

  protected constructor(options: LMOptions) {
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
  }

  private async send(
    wire: WireRequest,
    accept: string,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const headers = { accept, ...wire.headers };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(wireUrl(wire), {
        method: wire.method,
        headers,
        ...(wire.body !== null ? { body: stringifyCanonicalJson(wire.body) } : {}),
        ...(this.timeoutMs !== undefined ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
      });
    } catch (err) {
      throw transportFailure(err, this.timeoutMs);
    }
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        // normalize from status alone
      }
      throw normalizeError(this.provider, res.status, body);
    }
    return res;
  }

  /** One canonical Request → one canonical Response. */
  async complete(request: Request): Promise<Response> {
    const wire = this.adapter.buildRequest(request, false);
    const res = await this.send(wire, "application/json");
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw transportFailure(err, this.timeoutMs);
    }
    let body: JsonValue;
    try {
      body = parseCanonicalJson(text);
    } catch {
      throw new TransportError(
        `provider returned non-JSON body (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    return this.adapter.parseResponse(request, res.status, body);
  }

  /**
   * One canonical Request → canonical stream events, MAP-3 coalesced:
   * exactly one StreamEndEvent (carrying finish_reason/usage) ends the
   * stream, emitted as the final event.
   */
  async *stream(request: Request): AsyncIterable<StreamEvent> {
    const wire = this.adapter.buildRequest(request, true);
    const res = await this.send(wire, "text/event-stream");
    if (res.body === null) {
      throw new TransportError("provider response has no body to stream");
    }

    // Incremental MAP-3 coalescer (mirror of coalesceStream in stream.ts):
    // adapters may emit one end event per provider terminal frame; absorb
    // every end event — later non-null fields replace, null never erases —
    // and emit exactly one merged end event when the stream closes.
    let sawEnd = false;
    let finishReason: ReturnType<typeof streamEndEvent>["finish_reason"] = null;
    let usage: Usage | null = null;
    let providerData: ReturnType<typeof streamEndEvent>["provider_data"] = null;

    const feed = new SseFeed();
    const decoder = new TextDecoder("utf-8");

    const handle = function* (
      raw: SSEEvent,
      adapter: ProviderAdapter,
    ): Generator<StreamEvent> {
      for (const event of adapter.parseStreamEvents(request, raw)) {
        if (event.type === "end") {
          sawEnd = true;
          if (event.finish_reason !== null) finishReason = event.finish_reason;
          if (event.usage !== null) usage = event.usage;
          if (event.provider_data !== null) providerData = event.provider_data;
          continue;
        }
        yield event;
      }
    };

    try {
      for await (const chunk of res.body) {
        for (const raw of feed.feed(decoder.decode(chunk, { stream: true }))) {
          yield* handle(raw, this.adapter);
        }
      }
      const tail = decoder.decode();
      for (const raw of feed.feed(tail).concat(feed.end())) {
        yield* handle(raw, this.adapter);
      }
    } catch (err) {
      if (err instanceof LM15Error || err instanceof ValueError) throw err;
      throw transportFailure(err, this.timeoutMs);
    }

    if (sawEnd) {
      yield streamEndEvent({
        finish_reason: finishReason,
        usage,
        provider_data: providerData,
      });
    }
  }
}

// ─── Provider clients ────────────────────────────────────────────────

/** OpenAI Responses API client. */
export class OpenAILM extends BaseLM {
  readonly provider = "openai" as const;
  protected readonly adapter: ProviderAdapter;

  constructor(options: LMOptions) {
    super(options);
    this.adapter =
      options.baseUrl !== undefined
        ? new OpenAIAdapter(options.apiKey, options.baseUrl)
        : new OpenAIAdapter(options.apiKey);
  }
}

/**
 * OpenAI Chat Completions dialect client — OpenAI's legacy endpoint and
 * most compatible servers (ollama, Groq, OpenRouter, vLLM, SGLang, ...).
 */
export class OpenAIChatLM extends BaseLM {
  readonly provider = "openai_chat" as const;
  protected readonly adapter: ProviderAdapter;

  constructor(options: OpenAIChatLMOptions) {
    super(options);
    if (options.compat !== undefined) {
      this.adapter =
        options.baseUrl !== undefined
          ? new OpenAIChatAdapter(options.apiKey, options.baseUrl, options.compat)
          : new OpenAIChatAdapter(options.apiKey, undefined, options.compat);
    } else {
      this.adapter =
        options.baseUrl !== undefined
          ? new OpenAIChatAdapter(options.apiKey, options.baseUrl)
          : new OpenAIChatAdapter(options.apiKey);
    }
  }
}

/** Anthropic Messages API client. */
export class AnthropicLM extends BaseLM {
  readonly provider = "anthropic" as const;
  protected readonly adapter: ProviderAdapter;

  constructor(options: LMOptions) {
    super(options);
    this.adapter =
      options.baseUrl !== undefined
        ? new AnthropicAdapter(options.apiKey, options.baseUrl)
        : new AnthropicAdapter(options.apiKey);
  }
}

/** Google Gemini generateContent client. */
export class GeminiLM extends BaseLM {
  readonly provider = "gemini" as const;
  protected readonly adapter: ProviderAdapter;

  constructor(options: LMOptions) {
    super(options);
    this.adapter =
      options.baseUrl !== undefined
        ? new GeminiAdapter(options.apiKey, options.baseUrl)
        : new GeminiAdapter(options.apiKey);
  }
}
