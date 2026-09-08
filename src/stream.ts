/**
 * Stream machinery: the SSE parser, the MAP-3/MAP-4 coalescer, the MAP-9
 * accumulator, `ResponseStream`, and `materializeResponse`.
 *
 * One engine (`StreamAccumulator`) and the sugar around it; all speak the
 * canonical StreamEvent vocabulary. Nothing here executes tool calls.
 */

import { LM15Error, StreamAssemblyError, TransportError, errorClassForCode } from "./errors.ts";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import type { Request } from "./types/config.ts";
import {
  audio,
  normalizePart,
  type CitationPart,
  type ContinuationState,
  type ImagePart,
  type Part,
  type ToolCallPart,
} from "./types/parts.ts";
import { Response, Usage, type TokenLogprob } from "./types/response.ts";
import { continuationDeltaToState, type StreamEndEvent, type StreamEvent } from "./types/stream.ts";
import { decodeBase64, encodeBase64 } from "./types/validate.ts";
import type { FinishReason } from "./vocab.ts";

// ─── SSE ─────────────────────────────────────────────────────────────

export interface SSEEvent {
  readonly event?: string;
  readonly data: string;
}

const UTF8 = new TextDecoder("utf-8", { fatal: false });

/** Parse SSE lines (bytes or text, newline-terminated or not) into events. */
export function* parseSse(lines: Iterable<Uint8Array | string>, opts: { maxLineBytes?: number; maxEventBytes?: number } = {}): Generator<SSEEvent> {
  const maxLine = opts.maxLineBytes ?? 64 * 1024;
  const maxEvent = opts.maxEventBytes ?? 1024 * 1024;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let eventBytes = 0;
  for (const raw of lines) {
    const size = typeof raw === "string" ? raw.length : raw.length;
    if (size > maxLine) throw new TransportError(`SSE line exceeds limit (${size} > ${maxLine})`);
    const line = (typeof raw === "string" ? raw : UTF8.decode(raw)).replace(/[\r\n]+$/, "");
    eventBytes += size;
    if (eventBytes > maxEvent) throw new TransportError(`SSE event exceeds limit (${eventBytes} > ${maxEvent})`);
    if (line === "") {
      if (dataLines.length > 0) yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
      eventName = undefined;
      dataLines = [];
      eventBytes = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s+/, ""));
  }
  if (dataLines.length > 0) yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
}

/** Async mirror of {@link parseSse}. */
export async function* parseSseAsync(lines: AsyncIterable<Uint8Array | string>): AsyncGenerator<SSEEvent> {
  const maxLine = 64 * 1024;
  const maxEvent = 1024 * 1024;
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let eventBytes = 0;
  for await (const raw of lines) {
    const size = raw.length;
    if (size > maxLine) throw new TransportError(`SSE line exceeds limit (${size} > ${maxLine})`);
    const line = (typeof raw === "string" ? raw : UTF8.decode(raw)).replace(/[\r\n]+$/, "");
    eventBytes += size;
    if (eventBytes > maxEvent) throw new TransportError(`SSE event exceeds limit (${eventBytes} > ${maxEvent})`);
    if (line === "") {
      if (dataLines.length > 0) yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
      eventName = undefined;
      dataLines = [];
      eventBytes = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s+/, ""));
  }
  if (dataLines.length > 0) yield eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
}

/** Split a byte body into newline-terminated lines (keeping the terminator). */
export function* splitLines(body: Uint8Array): Generator<Uint8Array> {
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      yield body.subarray(start, i + 1);
      start = i + 1;
    }
  }
  if (start < body.length) yield body.subarray(start);
}

/** Split an async byte stream into newline-terminated lines. */
export async function* splitLinesAsync(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);
  for await (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) {
        yield buffer.slice(start, i + 1);
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  }
  if (buffer.length > 0) yield buffer;
}

// ─── Coalescer (MAP-3 / MAP-4) ───────────────────────────────────────

/** MAP-3 D9: rank 2 a frame that supplied usage, 1 finish_reason, 0 anything else; a later frame replaces at >= rank. */
class EndProviderData {
  value: JsonObject | undefined;
  rank = -1;

  absorb(event: StreamEndEvent): void {
    if (event.providerData === undefined) return;
    const rank = event.usage !== undefined ? 2 : event.finishReason !== undefined ? 1 : 0;
    if (rank >= this.rank) {
      this.value = event.providerData;
      this.rank = rank;
    }
  }
}

class Coalescer {
  started = false;
  sawEnd = false;
  finishReason: FinishReason | undefined;
  usage: Usage | undefined;
  readonly endData = new EndProviderData();
  private readonly model: string | undefined;

  constructor(model: string | undefined) {
    this.model = model;
  }

  /** Events to emit for one adapter event. */
  push(event: StreamEvent): StreamEvent[] {
    if (event.type === "start") {
      if (this.started) return [];
      this.started = true;
      return [event];
    }
    if (event.type === "end") {
      this.sawEnd = true;
      if (event.finishReason !== undefined) this.finishReason = event.finishReason;
      if (event.usage !== undefined) this.usage = event.usage;
      this.endData.absorb(event);
      return [];
    }
    const out: StreamEvent[] = [];
    if (!this.started && event.type === "delta") {
      this.started = true;
      out.push(this.syntheticStart());
    }
    out.push(event);
    return out;
  }

  /** Events to emit once the source is exhausted. */
  finish(): StreamEvent[] {
    if (!this.sawEnd) return [];
    const out: StreamEvent[] = [];
    if (!this.started) out.push(this.syntheticStart());
    const fields: Record<string, unknown> = { type: "end" };
    if (this.finishReason !== undefined) fields["finishReason"] = this.finishReason;
    if (this.usage !== undefined) fields["usage"] = this.usage;
    if (this.endData.value !== undefined) fields["providerData"] = this.endData.value;
    out.push(Object.freeze(fields) as unknown as StreamEndEvent);
    return out;
  }

  private syntheticStart(): StreamEvent {
    return this.model !== undefined ? Object.freeze({ type: "start" as const, model: this.model }) : Object.freeze({ type: "start" as const });
  }
}

/**
 * Enforce MAP-3 and MAP-4: exactly one final `end`, exactly one leading
 * `start` (synthesized with the request's model for dialects without a
 * start frame). No end is fabricated when none was seen.
 */
export function* coalesceStream(events: Iterable<StreamEvent>, opts: { model?: string } = {}): Generator<StreamEvent> {
  const c = new Coalescer(opts.model);
  for (const event of events) yield* c.push(event);
  yield* c.finish();
}

export async function* coalesceStreamAsync(events: AsyncIterable<StreamEvent>, opts: { model?: string } = {}): AsyncGenerator<StreamEvent> {
  const c = new Coalescer(opts.model);
  for await (const event of events) yield* c.push(event);
  yield* c.finish();
}

// ─── Accumulator (MAP-9) ─────────────────────────────────────────────

interface ToolCallMeta {
  id?: string;
  name?: string;
  input?: JsonObject;
}

/**
 * Accumulates canonical stream events into a complete Response. Push-based
 * so iteration and one-shot materialization share one engine.
 */
export class StreamAccumulator {
  startedId: string | undefined;
  startedModel: string | undefined;
  finishReason: FinishReason | undefined;
  usage: Usage | undefined;
  providerData: JsonObject | undefined;
  readonly textParts = new Map<number, string[]>();
  readonly thinkingParts = new Map<number, string[]>();
  readonly audioChunks = new Map<number, string[]>();
  readonly audioMediaTypes = new Map<number, string | undefined>();
  readonly imageParts = new Map<number, ImagePart>();
  readonly citationParts = new Map<number, CitationPart[]>();
  readonly toolCallRaw = new Map<number, string>();
  readonly toolCallMeta = new Map<number, ToolCallMeta>();
  readonly messageContinuation: ContinuationState[] = [];
  readonly partContinuation = new Map<number, ContinuationState[]>();
  readonly logprobSeq: TokenLogprob[] = [];
  readonly request: Request;

  constructor(request: Request) {
    this.request = request;
  }

  push(event: StreamEvent): void {
    if (event.type === "start") {
      this.startedId = event.id ?? this.startedId;
      this.startedModel = event.model ?? this.startedModel;
      return;
    }
    if (event.type === "end") {
      this.finishReason = event.finishReason ?? this.finishReason;
      this.usage = event.usage ?? this.usage;
      if (event.providerData !== undefined) this.providerData = event.providerData;
      return;
    }
    if (event.type !== "delta") return;
    const delta = event.delta;
    const idx = delta.type === "continuation" ? delta.partIndex : (delta.partIndex ?? 0);
    switch (delta.type) {
      case "text":
        push(this.textParts, idx!, delta.text);
        if (delta.logprobs) this.logprobSeq.push(...delta.logprobs);
        break;
      case "thinking":
        push(this.thinkingParts, idx!, delta.text);
        break;
      case "audio":
        push(this.audioChunks, idx!, delta.data ?? "");
        if (!this.audioMediaTypes.has(idx!)) this.audioMediaTypes.set(idx!, delta.mediaType);
        break;
      case "tool_call": {
        const meta = this.toolCallMeta.get(idx!) ?? {};
        this.toolCallMeta.set(idx!, meta);
        if (delta.id !== undefined) meta.id = delta.id;
        if (delta.name !== undefined) meta.name = delta.name;
        const aggregate = (this.toolCallRaw.get(idx!) ?? "") + delta.input;
        this.toolCallRaw.set(idx!, aggregate);
        meta.input = parseJsonBestEffort(aggregate);
        break;
      }
      case "image": {
        const mediaType = delta.mediaType ?? "image/png";
        let part: ImagePart;
        if (delta.data !== undefined) part = normalizePart({ type: "image", mediaType, data: delta.data }) as ImagePart;
        else if (delta.url !== undefined) part = normalizePart({ type: "image", mediaType, url: delta.url }) as ImagePart;
        else if (delta.fileId !== undefined) part = normalizePart({ type: "image", mediaType, fileId: delta.fileId }) as ImagePart;
        else return;
        this.imageParts.set(idx!, part);
        break;
      }
      case "citation":
        push(this.citationParts, idx!, normalizePart({ type: "citation", text: delta.text, url: delta.url, title: delta.title }) as CitationPart);
        break;
      case "continuation": {
        const state = continuationDeltaToState(delta);
        if (delta.partIndex === undefined) this.messageContinuation.push(state);
        else push(this.partContinuation, delta.partIndex, state);
        break;
      }
    }
  }

  /** The complete Response; raises `StreamAssemblyError` on an unnamed tool call (MAP-9). */
  response(): Response {
    const unnamed = [...this.toolCallMeta.entries()].filter(([, meta]) => !meta.name).map(([idx]) => idx).sort((a, b) => a - b);
    if (unnamed.length > 0) {
      const partial = this.assemble(new Set(unnamed));
      throw new StreamAssemblyError(
        `tool call at part ${unnamed[0]} arrived without a name; the adapter that produced this stream must set ToolCallDelta.name on the call's first fragment (MAP-9: lm15 does not guess which tool the model meant)`,
        { partial, partIndex: unnamed[0]! },
      );
    }
    return this.assemble(new Set());
  }

  private assemble(skip: ReadonlySet<number>): Response {
    const parts: Part[] = [];
    const indexes = [
      ...new Set([
        ...this.thinkingParts.keys(),
        ...this.textParts.keys(),
        ...this.imageParts.keys(),
        ...this.audioChunks.keys(),
        ...this.citationParts.keys(),
        ...this.toolCallMeta.keys(),
        ...this.partContinuation.keys(),
      ]),
    ].sort((a, b) => a - b);

    for (const idx of indexes) {
      const continuation = this.partContinuation.get(idx) ?? [];
      const cont = continuation.length > 0 ? { continuation } : {};
      const hasTool = this.toolCallMeta.has(idx) && !skip.has(idx);
      let emitted = false;
      if (this.thinkingParts.has(idx)) {
        parts.push(normalizePart({ type: "thinking", text: this.thinkingParts.get(idx)!.join(""), ...cont }));
        emitted = true;
      }
      if (this.textParts.has(idx)) {
        parts.push(normalizePart({ type: "text", text: this.textParts.get(idx)!.join(""), ...cont }));
        emitted = true;
      }
      if (this.imageParts.has(idx)) {
        parts.push(normalizePart({ ...this.imageParts.get(idx)!, ...cont }));
        emitted = true;
      }
      if (this.audioChunks.has(idx)) {
        const raw = concatB64Chunks(this.audioChunks.get(idx)!);
        const mediaType = this.audioMediaTypes.get(idx);
        if (mediaType === undefined || mediaType === "audio/pcm" || mediaType === "audio/pcm16") {
          parts.push(audio({ data: pcmToWav(raw), mediaType: "audio/wav", ...cont }));
        } else parts.push(audio({ data: raw, mediaType, ...cont }));
        emitted = true;
      }
      if (this.citationParts.has(idx)) {
        for (const c of this.citationParts.get(idx)!) parts.push(normalizePart({ ...c, ...cont }));
        emitted = true;
      }
      if (hasTool) {
        const meta = this.toolCallMeta.get(idx)!;
        const payload = isJsonObject(meta.input) ? meta.input : parseJsonBestEffort(this.toolCallRaw.get(idx) ?? "");
        parts.push(normalizePart({ type: "tool_call", id: meta.id || `tool_call_${idx}`, name: meta.name!, input: payload, ...cont }));
      } else if (!skip.has(idx) && !emitted) {
        parts.push(normalizePart({ type: "text", text: "", ...cont }));
      }
    }
    if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));

    const hasToolCalls = parts.some((p) => p.type === "tool_call");
    let finish = this.finishReason;
    if (finish === undefined) finish = hasToolCalls ? "tool_call" : "stop";
    else if (finish === "stop" && hasToolCalls) finish = "tool_call";

    return new Response({
      id: this.startedId,
      model: this.startedModel ?? this.request.model,
      message: {
        role: "assistant",
        parts,
        ...(this.messageContinuation.length > 0 ? { continuation: this.messageContinuation } : {}),
      },
      finishReason: finish,
      usage: this.usage ?? Usage.empty,
      logprobs: this.logprobSeq.length > 0 ? this.logprobSeq : undefined,
      providerData: this.providerData,
    });
  }
}

function push<T>(map: Map<number, T[]>, key: number, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ─── ResponseStream / materialize ────────────────────────────────────

/** Convert a stream error event into the typed exception it stands for. */
export function exceptionFromErrorEvent(event: StreamEvent & { type: "error" }): LM15Error {
  const err = event.error;
  const cls = errorClassForCode(err.code);
  return new cls(err.message, { providerCode: err.providerCode ?? null });
}

/**
 * Lazy stream-backed response assembler:
 *
 * ```ts
 * const rs = new ResponseStream(router.stream(req), req);
 * for await (const text of rs) process.stdout.write(text);
 * const response = await rs.response();
 * ```
 */
export class ResponseStream implements AsyncIterable<string> {
  private readonly accumulator: StreamAccumulator;
  private readonly source: AsyncIterator<StreamEvent>;
  private result: Response | undefined;
  private failure: unknown;
  private done = false;

  constructor(events: AsyncIterable<StreamEvent> | Iterable<StreamEvent>, request: Request) {
    this.accumulator = new StreamAccumulator(request);
    this.source = Symbol.asyncIterator in events ? (events as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]() : toAsync(events as Iterable<StreamEvent>);
  }

  /** Text as it arrives. */
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for await (const event of this.events()) {
      if (event.type === "delta" && event.delta.type === "text") yield event.delta.text;
    }
  }

  /** The canonical stream events, teed through the accumulator. */
  async *events(): AsyncGenerator<StreamEvent> {
    if (this.done) return;
    try {
      for (;;) {
        const next = await this.source.next();
        if (next.done) break;
        const event = next.value;
        if (event.type === "error") {
          this.failure = exceptionFromErrorEvent(event);
          throw this.failure;
        }
        this.accumulator.push(event);
        yield event;
        if (event.type === "end") break;
      }
      this.result = this.accumulator.response();
    } catch (e) {
      this.failure = e;
      throw e;
    } finally {
      this.done = true;
    }
  }

  /** The same Response a `complete` call returns; consumes the stream if needed. */
  async response(): Promise<Response> {
    if (this.failure !== undefined) throw this.failure;
    if (!this.done) for await (const _ of this.events()) void _;
    if (this.failure !== undefined) throw this.failure;
    return this.result!;
  }
}

async function* toAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** One-shot: consume events and build the Response. */
export function materializeResponse(events: Iterable<StreamEvent>, request: Request): Response {
  const acc = new StreamAccumulator(request);
  for (const event of events) {
    if (event.type === "error") throw exceptionFromErrorEvent(event);
    acc.push(event);
    if (event.type === "end") break;
  }
  return acc.response();
}

export async function materializeResponseAsync(events: AsyncIterable<StreamEvent>, request: Request): Promise<Response> {
  const acc = new StreamAccumulator(request);
  for await (const event of events) {
    if (event.type === "error") throw exceptionFromErrorEvent(event);
    acc.push(event);
    if (event.type === "end") break;
  }
  return acc.response();
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function parseJsonBestEffort(raw: string | undefined): JsonObject {
  if (!raw) return {};
  let value: JsonValue;
  try {
    value = parseJson(raw);
  } catch {
    return { partial_json: raw };
  }
  return isJsonObject(value) ? value : { value };
}

function concatB64Chunks(chunks: readonly string[]): Uint8Array {
  const buffers: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    try {
      buffers.push(decodeBase64("audio", chunk));
    } catch {
      try {
        buffers.push(decodeBase64("audio", chunk + "=".repeat((4 - (chunk.length % 4)) % 4)));
      } catch {
        // skip an undecodable chunk
      }
    }
  }
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bits = 16): string {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header));
  out.set(pcm, 44);
  return encodeBase64(out);
}

export type { ToolCallPart };
