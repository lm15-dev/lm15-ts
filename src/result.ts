/**
 * Result — lazy stream-backed response.
 *
 * Supports blocking (.text, .response), streaming (for await...of),
 * and event-level access (.events()).
 */

import {
  RateLimitError, ServerError, TimeoutError, TransportError,
  ProviderError,
} from "./errors.js";
import { errorClassForCode } from "./errors.js";
import type {
  AudioPart, CitationPart, ImagePart, JsonObject, LMRequest, LMResponse,
  Message, Part, PartDelta, StreamEvent, ToolCallInfo, ToolCallPart, Usage,
} from "./types.js";
import { EMPTY_USAGE, Part as PartFactory } from "./types.js";

// ── StreamChunk ────────────────────────────────────────────────────

export interface StreamChunk {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: JsonObject;
  readonly image?: ImagePart;
  readonly audio?: AudioPart;
  readonly response?: LMResponse;
}

// ── Internal helpers ───────────────────────────────────────────────

const TRANSIENT = [RateLimitError, TimeoutError, ServerError, TransportError];
function isTransient(e: unknown): boolean {
  return TRANSIENT.some(cls => e instanceof cls);
}

function parseJsonBestEffort(raw: string | undefined): JsonObject {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { partial_json: raw };
  }
}

function normalizeToolOutput(value: unknown): Part[] {
  if (typeof value === "object" && value !== null && "type" in value) return [value as Part];
  if (Array.isArray(value) && value.every(x => typeof x === "object" && x !== null && "type" in x)) return value as Part[];
  return [PartFactory.text(String(value))];
}

function invokeToolFn(fn: (...args: unknown[]) => unknown, payload: JsonObject): unknown {
  try {
    return fn(payload);
  } catch {
    return fn(...Object.values(payload));
  }
}

function previewParts(parts: Part[]): string | undefined {
  const text = parts
    .filter(p => p.type === "text" && "text" in p)
    .map(p => (p as { text: string }).text)
    .join("\n");
  return text || undefined;
}

// ── RoundState (accumulates stream events into a response) ─────────

class RoundState {
  request: LMRequest;
  startedId?: string;
  startedModel?: string;
  finishReason?: string;
  usage?: Usage;
  textParts: string[] = [];
  thinkingParts: string[] = [];
  audioChunks: string[] = [];
  toolCallRaw = new Map<number, string>();
  toolCallMeta = new Map<number, { id?: string; name?: string; input?: JsonObject }>();

  constructor(request: LMRequest) {
    this.request = request;
  }

  apply(event: StreamEvent): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    if (event.type === "start") {
      this.startedId = event.id ?? this.startedId;
      this.startedModel = event.model ?? this.startedModel;
      return chunks;
    }

    if (event.type === "end") {
      this.finishReason = event.finish_reason ?? this.finishReason;
      this.usage = event.usage ?? this.usage;
      return chunks;
    }

    if (event.type !== "delta" || !event.delta) return chunks;

    const delta = event.delta;

    // PartDelta (has .type as a PartDeltaType string)
    if ("type" in delta) {
      const dt = delta.type as string;
      if (dt === "text") {
        const text = (delta as PartDelta).text ?? (delta as JsonObject).text as string ?? "";
        this.textParts.push(text);
        chunks.push({ type: "text", text });
      } else if (dt === "thinking") {
        const text = (delta as PartDelta).text ?? (delta as JsonObject).text as string ?? "";
        this.thinkingParts.push(text);
        chunks.push({ type: "thinking", text });
      } else if (dt === "audio") {
        const data = (delta as PartDelta).data ?? (delta as JsonObject).data as string ?? "";
        this.audioChunks.push(data);
        chunks.push({ type: "audio", audio: PartFactory.audio({ data }) });
      } else if (dt === "tool_call") {
        const idx = event.part_index ?? 0;
        const meta = this.toolCallMeta.get(idx) ?? {};
        const d = delta as JsonObject;
        if (d.id != null) meta.id = String(d.id);
        if (d.name != null) meta.name = String(d.name);
        this.toolCallMeta.set(idx, meta);

        const rawInput = d.input ?? (delta as PartDelta).input ?? "";
        if (typeof rawInput === "object") {
          meta.input = rawInput as JsonObject;
        } else {
          const prev = this.toolCallRaw.get(idx) ?? "";
          const agg = prev + String(rawInput);
          this.toolCallRaw.set(idx, agg);
          meta.input = parseJsonBestEffort(agg);
        }
        this.toolCallMeta.set(idx, meta);
      }
    }

    return chunks;
  }

  materialize(): LMResponse {
    const parts: Part[] = [];

    if (this.thinkingParts.length) {
      parts.push(PartFactory.thinking(this.thinkingParts.join("")));
    }
    if (this.textParts.length) {
      parts.push(PartFactory.text(this.textParts.join("")));
    }
    if (this.audioChunks.length) {
      parts.push(PartFactory.audio({ data: this.audioChunks.join("") }));
    }

    const toolNames = (this.request.tools ?? [])
      .filter(t => t.type === "function")
      .map(t => t.name);

    const sortedIndices = [...this.toolCallMeta.keys()].sort((a, b) => a - b);
    for (let pos = 0; pos < sortedIndices.length; pos++) {
      const idx = sortedIndices[pos];
      const meta = this.toolCallMeta.get(idx)!;
      let payload = meta.input;
      if (!payload || typeof payload !== "object") {
        payload = parseJsonBestEffort(this.toolCallRaw.get(idx));
      }
      let name = meta.name;
      if (!name) {
        name = toolNames.length === 1 ? toolNames[0] : (toolNames[pos] ?? "tool");
      }
      parts.push(PartFactory.toolCall(meta.id ?? `tool_call_${idx}`, name, payload));
    }

    if (!parts.length) parts.push(PartFactory.text(""));

    let finish = this.finishReason;
    if (!finish) {
      finish = parts.some(p => p.type === "tool_call") ? "tool_call" : "stop";
    } else if (finish === "stop" && parts.some(p => p.type === "tool_call")) {
      finish = "tool_call";
    }

    return {
      id: this.startedId ?? "",
      model: this.startedModel ?? this.request.model,
      message: { role: "assistant", parts },
      finish_reason: finish as LMResponse["finish_reason"],
      usage: this.usage ?? EMPTY_USAGE,
    };
  }
}

// ── Result ─────────────────────────────────────────────────────────

export type StartStreamFn = (req: LMRequest) => AsyncIterable<StreamEvent>;
export type OnFinishedFn = (req: LMRequest, resp: LMResponse) => void;

export interface ResultOpts {
  request: LMRequest;
  startStream: StartStreamFn;
  onFinished?: OnFinishedFn;
  callableRegistry?: Record<string, (...args: unknown[]) => unknown>;
  onToolCall?: (info: ToolCallInfo) => unknown;
  maxToolRounds?: number;
  retries?: number;
}

export class Result {
  private _request: LMRequest;
  private _startStream: StartStreamFn;
  private _onFinished?: OnFinishedFn;
  private _callableRegistry: Record<string, (...args: unknown[]) => unknown>;
  private _onToolCall?: (info: ToolCallInfo) => unknown;
  private _maxToolRounds: number;
  private _retries: number;

  private _response: LMResponse | undefined;
  private _finalRequest: LMRequest;
  private _done = false;
  private _failure: Error | undefined;
  private _callbackCalled = false;
  private _chunkBuffer: StreamChunk[] = [];
  private _chunkIterStarted = false;
  private _consumed = false;

  constructor(opts: ResultOpts) {
    this._request = opts.request;
    this._startStream = opts.startStream;
    this._onFinished = opts.onFinished;
    this._callableRegistry = opts.callableRegistry ?? {};
    this._onToolCall = opts.onToolCall;
    this._maxToolRounds = opts.maxToolRounds ?? 8;
    this._retries = Math.max(opts.retries ?? 0, 0);
    this._finalRequest = opts.request;
  }

  /** Consume the full response (blocking-style, awaitable). */
  get response(): Promise<LMResponse> {
    return this._consume();
  }

  get text(): Promise<string | undefined> {
    return this._consume().then(r => {
      const texts = r.message.parts
        .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
        .map(p => p.text);
      return texts.length ? texts.join("\n") : undefined;
    });
  }

  get thinking(): Promise<string | undefined> {
    return this._consume().then(r => {
      const texts = r.message.parts
        .filter((p): p is Extract<Part, { type: "thinking" }> => p.type === "thinking")
        .map(p => p.text);
      return texts.length ? texts.join("\n") : undefined;
    });
  }

  get toolCalls(): Promise<ToolCallPart[]> {
    return this._consume().then(r =>
      r.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"),
    );
  }

  get usage(): Promise<Usage> {
    return this._consume().then(r => r.usage);
  }

  get finishReason(): Promise<string> {
    return this._consume().then(r => r.finish_reason);
  }

  get model(): Promise<string> {
    return this._consume().then(r => r.model);
  }

  get json(): Promise<unknown> {
    return this.text.then(t => {
      if (t == null) throw new Error("Response contains no text");
      return JSON.parse(t);
    });
  }

  /** Stream text chunks. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for await (const chunk of this.events()) {
      if (chunk.type === "text" && chunk.text != null) yield chunk.text;
    }
  }

  /** Stream all events including tool calls, thinking, etc. */
  async *events(): AsyncGenerator<StreamChunk> {
    if (this._consumed) {
      if (this._response) {
        yield { type: "finished", response: this._response };
      }
      return;
    }
    this._consumed = true;

    let currentRequest = this._request;
    let rounds = 0;

    try {
      while (true) {
        let state: RoundState | undefined;
        let emittedVisible = false;
        let roundResponse: LMResponse | undefined;
        let attempt = 0;

        while (true) {
          state = new RoundState(currentRequest);
          emittedVisible = false;
          roundResponse = undefined;

          try {
            const events = this._startStream(currentRequest);
            for await (const event of events) {
              if (event.type === "error") {
                throw exceptionFromStreamError(event);
              }
              for (const chunk of state.apply(event)) {
                if (["text", "thinking", "audio", "image"].includes(chunk.type)) {
                  emittedVisible = true;
                }
                yield chunk;
              }
              if (event.type === "end") break;
            }
            roundResponse = state.materialize();
            break;
          } catch (e) {
            if (!isTransient(e) || emittedVisible || attempt >= this._retries) {
              this._capturePartial(currentRequest, state);
              this._failure = e as Error;
              throw e;
            }
            await sleep(200 * (2 ** attempt));
            attempt++;
          }
        }

        this._finalRequest = currentRequest;
        this._response = roundResponse!;

        // Yield tool_call chunks
        const pendingToolCalls = roundResponse!.message.parts.filter(
          (p): p is ToolCallPart => p.type === "tool_call",
        );
        for (const tc of pendingToolCalls) {
          yield { type: "tool_call", name: tc.name, input: tc.input };
        }

        // Auto-execute tools if applicable
        if (
          roundResponse!.finish_reason === "tool_call"
          && pendingToolCalls.length
          && rounds < this._maxToolRounds
        ) {
          const executed = this._executeTools(pendingToolCalls);
          if (executed.length === pendingToolCalls.length) {
            for (const outcome of executed) {
              yield { type: "tool_result", text: outcome.preview, name: outcome.name };
            }
            const toolMessage: Message = {
              role: "tool",
              parts: executed.map(e => e.part),
            };
            currentRequest = {
              ...currentRequest,
              messages: [...currentRequest.messages, roundResponse!.message, toolMessage],
            };
            rounds++;
            continue;
          }
        }

        // Finalize
        this._finalize(this._finalRequest, roundResponse!);
        yield { type: "finished", response: roundResponse! };
        return;
      }
    } finally {
      this._done = true;
    }
  }

  private async _consume(): Promise<LMResponse> {
    if (this._done && this._failure) throw this._failure;
    if (this._response && this._done) return this._response;
    // Consume all events
    for await (const _ of this.events()) { /* drain */ }
    return this._response!;
  }

  private _capturePartial(request: LMRequest, state?: RoundState): void {
    this._finalRequest = request;
    if (state) {
      try { this._response = state.materialize(); } catch { /* ignore */ }
    }
  }

  private _finalize(request: LMRequest, response: LMResponse): void {
    this._finalRequest = request;
    this._response = response;
    this._failure = undefined;
    if (!this._callbackCalled && this._onFinished) {
      this._callbackCalled = true;
      this._onFinished(request, response);
    }
  }

  private _executeTools(toolCalls: ToolCallPart[]): { name: string; part: Part; preview?: string }[] {
    const results: { name: string; part: Part; preview?: string }[] = [];

    for (const tc of toolCalls) {
      const info: ToolCallInfo = { id: tc.id, name: tc.name, input: tc.input };

      // Check on_tool_call callback first
      if (this._onToolCall) {
        const override = this._onToolCall(info);
        if (override != null) {
          const content = normalizeToolOutput(override);
          results.push({
            name: info.name,
            part: PartFactory.toolResult(info.id, content, { name: info.name }),
            preview: previewParts(content),
          });
          continue;
        }
      }

      // Check callable registry
      const fn = this._callableRegistry[info.name];
      if (!fn) return results; // Stop — can't execute, return partial

      const output = invokeToolFn(fn, info.input);
      const content = normalizeToolOutput(output);
      results.push({
        name: info.name,
        part: PartFactory.toolResult(info.id, content, { name: info.name }),
        preview: previewParts(content),
      });
    }

    return results;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function exceptionFromStreamError(event: StreamEvent): Error {
  const err = event.error;
  if (!err) return new ProviderError("stream error");
  const code = String("code" in err ? err.code : "provider");
  const message = String("message" in err ? err.message : "stream error");
  return errorClassForCode(code, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
