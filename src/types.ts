/**
 * lm15 canonical types — TypeScript implementation.
 *
 * Conforms to https://github.com/lm15-dev/spec/blob/main/types.md
 * All types are immutable (readonly). Constructors enforce constraints.
 */

// ── Scalars & Aliases ──────────────────────────────────────────────

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

// ── Enums ──────────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "tool";

export type PartType =
  | "text" | "image" | "audio" | "video" | "document"
  | "tool_call" | "tool_result" | "thinking" | "refusal" | "citation";

export type ToolType = "function" | "builtin";
export type ReasoningEffort = "low" | "medium" | "high";
export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "error";
export type DataSourceType = "base64" | "url" | "file";
export type StreamEventType = "start" | "delta" | "part_start" | "part_end" | "end" | "error";
export type PartDeltaType = "text" | "tool_call" | "thinking" | "audio";
export type ErrorCode =
  | "auth" | "billing" | "rate_limit" | "invalid_request"
  | "context_length" | "timeout" | "server" | "provider";
export type AudioEncoding = "pcm16" | "opus" | "mp3" | "aac";

// ── DataSource ─────────────────────────────────────────────────────

export interface DataSource {
  readonly type: DataSourceType;
  readonly media_type?: string;
  readonly data?: string;
  readonly url?: string;
  readonly file_id?: string;
  readonly detail?: "low" | "high" | "auto";
}

export function createDataSource(ds: DataSource): DataSource {
  if (ds.type === "base64") {
    if (!ds.data) throw new Error("DataSource(type='base64') requires data");
    if (!ds.media_type) throw new Error("DataSource(type='base64') requires media_type");
  } else if (ds.type === "url") {
    if (!ds.url) throw new Error("DataSource(type='url') requires url");
  } else if (ds.type === "file") {
    if (!ds.file_id) throw new Error("DataSource(type='file') requires file_id");
  }
  return Object.freeze({ ...ds });
}

export function dataSourceBytes(ds: DataSource): Uint8Array {
  if (ds.type !== "base64" || !ds.data) {
    throw new Error(`DataSource(type='${ds.type}') has no inline bytes`);
  }
  return Uint8Array.from(atob(ds.data), c => c.charCodeAt(0));
}

// ── Parts ──────────────────────────────────────────────────────────

export interface TextPart {
  readonly type: "text";
  readonly text: string;
  readonly metadata?: JsonObject;
}

export interface ThinkingPart {
  readonly type: "thinking";
  readonly text: string;
  readonly redacted?: boolean;
  readonly summary?: string;
  readonly metadata?: JsonObject;
}

export interface RefusalPart {
  readonly type: "refusal";
  readonly text: string;
}

export interface CitationPart {
  readonly type: "citation";
  readonly text?: string;
  readonly url?: string;
  readonly title?: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly source: DataSource;
  readonly metadata?: JsonObject;
}

export interface AudioPart {
  readonly type: "audio";
  readonly source: DataSource;
  readonly metadata?: JsonObject;
}

export interface VideoPart {
  readonly type: "video";
  readonly source: DataSource;
  readonly metadata?: JsonObject;
}

export interface DocumentPart {
  readonly type: "document";
  readonly source: DataSource;
  readonly metadata?: JsonObject;
}

export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ToolResultPart {
  readonly type: "tool_result";
  readonly id: string;
  readonly name?: string;
  readonly content: readonly Part[];
  readonly is_error?: boolean;
}

export type Part =
  | TextPart | ThinkingPart | RefusalPart | CitationPart
  | ImagePart | AudioPart | VideoPart | DocumentPart
  | ToolCallPart | ToolResultPart;

// ── Part Factories ─────────────────────────────────────────────────

function makeMediaPart<T extends "image" | "audio" | "video" | "document">(
  type: T,
  opts: {
    url?: string;
    data?: string | Uint8Array;
    file_id?: string;
    media_type?: string;
    detail?: "low" | "high" | "auto";
    cache?: boolean | JsonObject;
  },
  defaultMediaType: string,
): Extract<Part, { type: T }> {
  const provided = [opts.url, opts.data, opts.file_id].filter(x => x != null).length;
  if (provided !== 1) throw new Error(`Part.${type} requires exactly one of url, data, file_id`);

  let source: DataSource;
  if (opts.url != null) {
    source = createDataSource({ type: "url", url: opts.url, media_type: opts.media_type, detail: opts.detail });
  } else if (opts.file_id != null) {
    source = createDataSource({ type: "file", file_id: opts.file_id, media_type: opts.media_type, detail: opts.detail });
  } else {
    let payload: string;
    if (opts.data instanceof Uint8Array) {
      payload = btoa(String.fromCharCode(...opts.data));
    } else {
      payload = opts.data ?? "";
    }
    source = createDataSource({
      type: "base64",
      data: payload,
      media_type: opts.media_type ?? defaultMediaType,
      detail: opts.detail,
    });
  }

  const metadata = opts.cache === true ? { cache: true } as JsonObject
    : typeof opts.cache === "object" ? { cache: opts.cache } as JsonObject
    : undefined;

  return Object.freeze({ type, source, metadata }) as Extract<Part, { type: T }>;
}

export const Part = {
  text(text: string): TextPart {
    return Object.freeze({ type: "text" as const, text });
  },

  thinking(text: string, opts?: { redacted?: boolean; summary?: string; metadata?: JsonObject }): ThinkingPart {
    return Object.freeze({ type: "thinking" as const, text, ...opts });
  },

  refusal(text: string): RefusalPart {
    return Object.freeze({ type: "refusal" as const, text });
  },

  citation(opts?: { text?: string; url?: string; title?: string }): CitationPart {
    return Object.freeze({ type: "citation" as const, ...opts });
  },

  image(opts: Parameters<typeof makeMediaPart>[1]): ImagePart {
    return makeMediaPart("image", opts, "image/png");
  },

  audio(opts: Parameters<typeof makeMediaPart>[1]): AudioPart {
    return makeMediaPart("audio", opts, "audio/wav");
  },

  video(opts: Parameters<typeof makeMediaPart>[1]): VideoPart {
    return makeMediaPart("video", opts, "video/mp4");
  },

  document(opts: Parameters<typeof makeMediaPart>[1]): DocumentPart {
    return makeMediaPart("document", opts, "application/pdf");
  },

  toolCall(id: string, name: string, input: JsonObject): ToolCallPart {
    return Object.freeze({ type: "tool_call" as const, id, name, input });
  },

  toolResult(id: string, content: Part[], opts?: { is_error?: boolean; name?: string }): ToolResultPart {
    return Object.freeze({ type: "tool_result" as const, id, content: Object.freeze([...content]), ...opts });
  },
} as const;

// ── Tools ──────────────────────────────────────────────────────────

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonObject;
  readonly fn?: (...args: unknown[]) => unknown;
}

export interface BuiltinTool {
  readonly type: "builtin";
  readonly name: string;
  readonly description?: string;
  readonly builtin_config?: JsonObject;
}

export type Tool = FunctionTool | BuiltinTool;

export interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ToolConfig {
  readonly mode: "auto" | "required" | "none";
  readonly allowed: readonly string[];
  readonly parallel?: boolean;
}

// ── Configuration ──────────────────────────────────────────────────

export interface ReasoningConfig {
  readonly enabled: boolean;
  readonly budget?: number;
  readonly effort?: ReasoningEffort;
}

export interface Config {
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop?: readonly string[];
  readonly response_format?: JsonObject;
  readonly tool_config?: ToolConfig;
  readonly reasoning?: ReasoningConfig;
  readonly provider?: JsonObject;
}

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sample_rate: number;
  readonly channels: number;
}

// ── Messages ───────────────────────────────────────────────────────

export interface Message {
  readonly role: Role;
  readonly parts: readonly Part[];
  readonly name?: string;
}

export const Message = {
  user(text: string): Message {
    return Object.freeze({ role: "user" as const, parts: Object.freeze([Part.text(text)]) });
  },

  assistant(text: string): Message {
    return Object.freeze({ role: "assistant" as const, parts: Object.freeze([Part.text(text)]) });
  },

  toolResults(results: Record<string, string | Part | Part[]>): Message {
    const parts: ToolResultPart[] = [];
    for (const [callId, value] of Object.entries(results)) {
      let content: Part[];
      if (typeof value === "string") {
        content = [Part.text(value)];
      } else if (Array.isArray(value)) {
        content = value;
      } else {
        content = [value];
      }
      parts.push(Part.toolResult(callId, content));
    }
    return Object.freeze({ role: "tool" as const, parts: Object.freeze(parts) });
  },
} as const;

// ── Canonical message JSON serialization ───────────────────────────

export function partToDict(part: Part): JsonObject {
  const d: JsonObject = { type: part.type };
  if (part.type === "text") {
    d.text = part.text ?? "";
  } else if (part.type === "thinking") {
    d.text = part.text ?? "";
    if (part.redacted != null) d.redacted = part.redacted;
    if (part.summary != null) d.summary = part.summary;
  } else if (part.type === "refusal") {
    d.text = part.text ?? "";
  } else if (part.type === "citation") {
    if (part.text != null) d.text = part.text;
    if (part.url != null) d.url = part.url;
    if (part.title != null) d.title = part.title;
  } else if (part.type === "image" || part.type === "audio" || part.type === "video" || part.type === "document") {
    if (part.source) {
      const src: JsonObject = { type: part.source.type };
      if (part.source.url != null) src.url = part.source.url;
      if (part.source.data != null) src.data = part.source.data;
      if (part.source.media_type != null) src.media_type = part.source.media_type;
      if (part.source.file_id != null) src.file_id = part.source.file_id;
      if (part.source.detail != null) src.detail = part.source.detail;
      d.source = src;
    }
  } else if (part.type === "tool_call") {
    d.id = part.id;
    d.name = part.name;
    d.arguments = part.input ?? {};
  } else if (part.type === "tool_result") {
    d.id = part.id;
    if (part.name != null) d.name = part.name;
    d.content = part.content.length
      ? (part.content.map(p => partToDict(p)) as JsonObject[])
      : "";
    if (part.is_error != null) d.is_error = part.is_error;
  }
  if ("metadata" in part && part.metadata != null) d.metadata = part.metadata;
  return d;
}

export function partFromDict(d: JsonObject): Part {
  const t = d.type as string;
  if (t === "text") return Part.text((d.text as string) ?? "");
  if (t === "thinking") return Part.thinking((d.text as string) ?? "", {
    redacted: d.redacted as boolean | undefined,
    summary: d.summary as string | undefined,
  });
  if (t === "refusal") return Part.refusal((d.text as string) ?? "");
  if (t === "citation") return Part.citation({
    text: d.text as string | undefined,
    url: d.url as string | undefined,
    title: d.title as string | undefined,
  });
  if (t === "image" || t === "audio" || t === "video" || t === "document") {
    const src = (d.source ?? {}) as JsonObject;
    const source = createDataSource({
      type: (src.type as DataSourceType) ?? "url",
      url: src.url as string | undefined,
      data: src.data as string | undefined,
      media_type: src.media_type as string | undefined,
      file_id: src.file_id as string | undefined,
      detail: src.detail as "low" | "high" | "auto" | undefined,
    });
    const metadata = d.metadata as JsonObject | undefined;
    if (t === "image") return Object.freeze({ type: "image" as const, source, metadata });
    if (t === "audio") return Object.freeze({ type: "audio" as const, source, metadata });
    if (t === "video") return Object.freeze({ type: "video" as const, source, metadata });
    return Object.freeze({ type: "document" as const, source, metadata });
  }
  if (t === "tool_call") return Part.toolCall(
    d.id as string, d.name as string, (d.arguments ?? {}) as JsonObject,
  );
  if (t === "tool_result") {
    const rawContent = d.content;
    let content: Part[];
    if (typeof rawContent === "string") {
      content = rawContent ? [Part.text(rawContent)] : [];
    } else if (Array.isArray(rawContent)) {
      content = rawContent.map(c => typeof c === "object" ? partFromDict(c as JsonObject) : Part.text(String(c)));
    } else {
      content = [];
    }
    return Part.toolResult(d.id as string, content, {
      is_error: d.is_error as boolean | undefined,
      name: d.name as string | undefined,
    });
  }
  throw new Error(`unsupported part type: ${t}`);
}

export function messageToDict(msg: Message): JsonObject {
  const d: JsonObject = { role: msg.role, parts: msg.parts.map(p => partToDict(p)) as JsonObject[] };
  if (msg.name != null) d.name = msg.name;
  return d;
}

export function messageFromDict(d: JsonObject): Message {
  const role = d.role as Role;
  const partsRaw = (d.parts ?? []) as JsonObject[];
  const parts = partsRaw.map(p => typeof p === "object" ? partFromDict(p) : Part.text(String(p)));
  if (!parts.length) throw new Error(`message for role '${role}' has no parts`);
  return Object.freeze({ role, parts: Object.freeze(parts), name: d.name as string | undefined });
}

export function messagesToJson(messages: readonly Message[]): JsonObject[] {
  return messages.map(m => messageToDict(m));
}

export function messagesFromJson(data: JsonObject[]): Message[] {
  return data.map(d => messageFromDict(d));
}

// ── Request / Response ─────────────────────────────────────────────

export interface LMRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string | readonly Part[];
  readonly tools?: readonly Tool[];
  readonly config?: Config;
}

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly input_audio_tokens?: number;
  readonly output_audio_tokens?: number;
}

export const EMPTY_USAGE: Usage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
});

export interface LMResponse {
  readonly id: string;
  readonly model: string;
  readonly message: Message;
  readonly finish_reason: FinishReason;
  readonly usage: Usage;
  readonly provider?: JsonObject;
}

/** Extract text from an LMResponse */
export function responseText(resp: LMResponse): string | undefined {
  const texts = resp.message.parts
    .filter((p): p is TextPart => p.type === "text" && p.text != null)
    .map(p => p.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Extract thinking from an LMResponse */
export function responseThinking(resp: LMResponse): string | undefined {
  const texts = resp.message.parts
    .filter((p): p is ThinkingPart => p.type === "thinking" && p.text != null)
    .map(p => p.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Extract tool calls from an LMResponse */
export function responseToolCalls(resp: LMResponse): ToolCallPart[] {
  return resp.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
}

/** Extract first image from an LMResponse */
export function responseImage(resp: LMResponse): ImagePart | undefined {
  return resp.message.parts.find((p): p is ImagePart => p.type === "image");
}

/** Extract first audio from an LMResponse */
export function responseAudio(resp: LMResponse): AudioPart | undefined {
  return resp.message.parts.find((p): p is AudioPart => p.type === "audio");
}

/** Extract citations from an LMResponse */
export function responseCitations(resp: LMResponse): CitationPart[] {
  return resp.message.parts.filter((p): p is CitationPart => p.type === "citation");
}

/** Parse response text as JSON */
export function responseJson(resp: LMResponse): unknown {
  const text = responseText(resp);
  if (text == null) throw new Error("Response contains no text");
  return JSON.parse(text);
}

// ── Streaming ──────────────────────────────────────────────────────

export interface ErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  readonly provider_code?: string;
}

export interface PartDelta {
  readonly type: PartDeltaType;
  readonly text?: string;
  readonly data?: string;
  readonly input?: string;
}

export interface StreamEvent {
  readonly type: StreamEventType;
  readonly id?: string;
  readonly model?: string;
  readonly part_index?: number;
  readonly delta?: PartDelta | JsonObject;
  readonly part_type?: string;
  readonly finish_reason?: FinishReason;
  readonly usage?: Usage;
  readonly error?: ErrorInfo;
}

// ── Live Sessions ──────────────────────────────────────────────────

export interface LiveConfig {
  readonly model: string;
  readonly system?: string | readonly Part[];
  readonly tools?: readonly Tool[];
  readonly voice?: string;
  readonly input_format?: AudioFormat;
  readonly output_format?: AudioFormat;
  readonly provider?: JsonObject;
}

export interface LiveClientEvent {
  readonly type: "audio" | "video" | "text" | "tool_result" | "interrupt" | "end_audio";
  readonly data?: string;
  readonly text?: string;
  readonly id?: string;
  readonly content?: readonly Part[];
}

export interface LiveServerEvent {
  readonly type: "audio" | "text" | "tool_call" | "interrupted" | "turn_end" | "error";
  readonly data?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: JsonObject;
  readonly usage?: Usage;
  readonly error?: ErrorInfo;
}

// ── Auxiliary Request/Response ──────────────────────────────────────

export interface EmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly string[];
  readonly provider?: JsonObject;
}

export interface EmbeddingResponse {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly usage?: Usage;
  readonly provider?: JsonObject;
}

export interface FileUploadRequest {
  readonly model?: string;
  readonly filename: string;
  readonly bytes_data: Uint8Array;
  readonly media_type: string;
  readonly provider?: JsonObject;
}

export interface FileUploadResponse {
  readonly id: string;
  readonly provider?: JsonObject;
}

export interface BatchRequest {
  readonly model: string;
  readonly requests: readonly LMRequest[];
  readonly provider?: JsonObject;
}

export interface BatchResponse {
  readonly id: string;
  readonly status: string;
  readonly provider?: JsonObject;
}

export interface ImageGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly size?: string;
  readonly provider?: JsonObject;
}

export interface ImageGenerationResponse {
  readonly images: readonly DataSource[];
  readonly provider?: JsonObject;
}

export interface AudioGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly voice?: string;
  readonly format?: string;
  readonly provider?: JsonObject;
}

export interface AudioGenerationResponse {
  readonly audio: DataSource;
  readonly provider?: JsonObject;
}
