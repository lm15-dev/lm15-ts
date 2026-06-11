/**
 * surface_dump registry.
 *
 * DEVIATION NOTE (PROTOCOL.md asks for reflection): TypeScript types are
 * erased at runtime, so there is no dataclass reflection to harvest. This
 * module is the explicit type-metadata registry for the canonical model —
 * one entry per canonical type with its field list in declaration order,
 * plus every string vocabulary (Literal-alias order AND sorted runtime
 * mirrors, matching the reference shim's reflected output). It is the
 * single source the coverage ratchet sees; tests pin it against types.ts.
 */

import * as t from "./types.js";

const MEDIA_FIELDS = ["media_type", "data", "url", "file_id", "path", "continuation", "type"];

export const TYPE_FIELDS: Record<string, readonly string[]> = {
  AudioDelta: ["data", "url", "file_id", "part_index", "media_type", "type"],
  AudioFormat: ["encoding", "sample_rate", "channels"],
  AudioGenerationRequest: ["model", "prompt", "voice", "format", "extensions"],
  AudioGenerationResponse: ["audio", "id", "model", "usage", "provider_data"],
  AudioPart: MEDIA_FIELDS,
  BatchRequest: ["model", "requests", "extensions"],
  BatchResponse: ["id", "status", "provider_data"],
  BinaryPart: MEDIA_FIELDS,
  BuiltinTool: ["name", "config", "type"],
  CacheConfig: ["mode", "retention", "key", "prefix_until_index"],
  CitationDelta: ["text", "url", "title", "part_index", "type"],
  CitationPart: ["url", "title", "text", "continuation", "type"],
  Config: [
    "max_tokens", "temperature", "top_p", "top_k", "stop",
    "response_format", "tool_choice", "reasoning", "cache", "extensions",
  ],
  ContinuationDelta: ["provider", "kind", "data", "part_index", "type"],
  ContinuationState: ["provider", "kind", "data"],
  DocumentPart: MEDIA_FIELDS,
  EmbeddingRequest: ["model", "inputs", "extensions"],
  EmbeddingResponse: ["model", "vectors", "usage", "provider_data"],
  ErrorDetail: ["code", "message", "provider_code"],
  FileUploadRequest: ["filename", "bytes_data", "media_type", "model", "extensions", "path"],
  FileUploadResponse: ["id", "provider_data"],
  FunctionTool: ["name", "description", "parameters", "type"],
  ImageDelta: ["data", "url", "file_id", "part_index", "media_type", "type"],
  ImageGenerationRequest: ["model", "prompt", "size", "extensions"],
  ImageGenerationResponse: ["images", "id", "model", "usage", "provider_data"],
  ImagePart: ["media_type", "data", "url", "file_id", "path", "continuation", "detail", "type"],
  LiveClientAudioEvent: ["data", "media_type", "type"],
  LiveClientEndAudioEvent: ["type"],
  LiveClientImageEvent: ["data", "media_type", "type"],
  LiveClientInterruptEvent: ["type"],
  LiveClientTextEvent: ["text", "type"],
  LiveClientToolResultEvent: ["id", "content", "type"],
  LiveClientTurnEvent: ["parts", "turn_complete", "type"],
  LiveConfig: ["model", "system", "tools", "voice", "input_format", "output_format", "extensions"],
  LiveServerAudioEvent: ["data", "media_type", "type"],
  LiveServerErrorEvent: ["error", "type"],
  LiveServerInterruptedEvent: ["type"],
  LiveServerTextEvent: ["text", "type"],
  LiveServerToolCallDeltaEvent: ["input_delta", "id", "name", "type"],
  LiveServerToolCallEvent: ["id", "name", "input", "type"],
  LiveServerTurnEndEvent: ["usage", "type"],
  Message: ["role", "parts", "continuation"],
  Reasoning: ["effort", "thinking_budget", "total_budget", "summary"],
  RefusalPart: ["text", "continuation", "type"],
  Request: ["model", "messages", "system", "tools", "config"],
  Response: ["id", "model", "message", "finish_reason", "usage", "provider_data"],
  StreamDeltaEvent: ["delta", "type"],
  StreamEndEvent: ["finish_reason", "usage", "provider_data", "type"],
  StreamErrorEvent: ["error", "type"],
  StreamStartEvent: ["id", "model", "type"],
  TextDelta: ["text", "part_index", "type"],
  TextPart: ["text", "continuation", "type"],
  ThinkingDelta: ["text", "part_index", "type"],
  ThinkingPart: ["text", "redacted", "continuation", "type"],
  ToolCallDelta: ["input", "part_index", "id", "name", "type"],
  ToolCallInfo: ["id", "name", "input"],
  ToolCallPart: ["id", "name", "input", "continuation", "type"],
  ToolChoice: ["mode", "allowed", "parallel"],
  ToolResultPart: ["id", "content", "name", "is_error", "continuation", "type"],
  Usage: [
    "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "input_audio_tokens", "output_audio_tokens",
  ],
  VideoPart: MEDIA_FIELDS,
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

export const ENUMS: Record<string, readonly string[]> = {
  // Literal-alias names: declaration order (spec/vocabularies.md tables).
  Role: t.ROLE_VALUES,
  PartType: t.PART_TYPES,
  DeltaType: t.DELTA_TYPES,
  FinishReason: t.FINISH_REASONS,
  ReasoningEffort: t.REASONING_EFFORTS,
  ReasoningSummary: t.REASONING_SUMMARIES,
  ErrorCode: t.ERROR_CODES,
  StreamEventType: t.STREAM_EVENT_TYPES,
  BatchStatus: t.BATCH_STATUSES,
  AudioEncoding: t.AUDIO_ENCODINGS,
  ToolChoiceMode: t.TOOL_CHOICE_MODES,
  CacheMode: t.CACHE_MODES,
  CacheRetention: t.CACHE_RETENTIONS,
  LiveClientEventType: t.LIVE_CLIENT_EVENT_TYPES,
  LiveServerEventType: t.LIVE_SERVER_EVENT_TYPES,
  // Runtime-mirror names: sorted (matching the reference's reflection).
  ROLE_VALUES: sorted(t.ROLE_VALUES),
  PART_TYPES: sorted(t.PART_TYPES),
  DELTA_TYPES: sorted(t.DELTA_TYPES),
  FINISH_REASONS: sorted(t.FINISH_REASONS),
  REASONING_EFFORTS: sorted(t.REASONING_EFFORTS),
  REASONING_SUMMARIES: sorted(t.REASONING_SUMMARIES),
  ERROR_CODES: sorted(t.ERROR_CODES),
  BATCH_STATUSES: sorted(t.BATCH_STATUSES),
  AUDIO_ENCODINGS: sorted(t.AUDIO_ENCODINGS),
  TOOL_CHOICE_MODES: sorted(t.TOOL_CHOICE_MODES),
};

export function surfaceDump(): {
  types: Record<string, { fields: string[] }>;
  enums: Record<string, string[]>;
} {
  const types: Record<string, { fields: string[] }> = {};
  for (const name of Object.keys(TYPE_FIELDS).sort()) {
    types[name] = { fields: [...TYPE_FIELDS[name]!] };
  }
  const enums: Record<string, string[]> = {};
  for (const name of Object.keys(ENUMS).sort()) {
    enums[name] = [...ENUMS[name]!];
  }
  return { types, enums };
}
