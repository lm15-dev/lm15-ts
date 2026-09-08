/**
 * Closed vocabularies (spec/vocabularies.md). Each is a `const` tuple plus
 * the derived union type; `surface_dump` reflects the tuples, so this file
 * is the runtime mirror the spec names.
 */

export const ROLES = ["user", "assistant", "tool", "developer"] as const;
export type Role = (typeof ROLES)[number];

export const PART_TYPES = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "binary",
  "tool_call",
  "tool_result",
  "thinking",
  "refusal",
  "citation",
] as const;
export type PartType = (typeof PART_TYPES)[number];

/** INV-035: streamable ∪ non-streamable = Part, no overlap. */
export const STREAMABLE_PART_TYPES = ["text", "thinking", "image", "audio", "tool_call", "citation"] as const;
export const NON_STREAMABLE_PART_TYPES = ["video", "document", "binary", "tool_result", "refusal"] as const;

export const DELTA_TYPES = ["text", "thinking", "audio", "image", "tool_call", "citation", "continuation"] as const;
export type DeltaType = (typeof DELTA_TYPES)[number];

export const FINISH_REASONS = ["stop", "length", "tool_call", "content_filter", "error"] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_SUMMARIES = ["auto", "concise", "detailed"] as const;
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

export const ERROR_CODES = [
  "auth",
  "billing",
  "rate_limit",
  "invalid_request",
  "context_length",
  "timeout",
  "server",
  "unsupported_model",
  "unsupported_feature",
  "not_configured",
  "unknown_model",
  "ambiguous_model",
  "transport",
  "lock_timeout",
  "stream_assembly",
  "provider",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const STREAM_EVENT_TYPES = ["start", "delta", "end", "error"] as const;
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

export const BATCH_STATUSES = ["queued", "running", "cancelling", "completed", "failed", "cancelled", "expired"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BATCH_TERMINAL_STATUSES = ["completed", "failed", "cancelled", "expired"] as const;

export const BATCH_OUTCOMES = ["succeeded", "errored", "cancelled", "expired"] as const;
export type BatchOutcome = (typeof BATCH_OUTCOMES)[number];

export const VIDEO_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];
export const VIDEO_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export const FILE_READINESS_VALUES = ["pending", "ready", "failed"] as const;
export type FileReadiness = (typeof FILE_READINESS_VALUES)[number];

export const AUDIO_ENCODINGS = ["pcm16", "opus", "mp3", "aac"] as const;
export type AudioEncoding = (typeof AUDIO_ENCODINGS)[number];

export const TOOL_CHOICE_MODES = ["auto", "required", "none"] as const;
export type ToolChoiceMode = (typeof TOOL_CHOICE_MODES)[number];

export const CACHE_MODES = ["auto", "off"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

export const CACHE_RETENTIONS = ["short", "long"] as const;
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];

export const CACHE_PREFIXES = ["stable", "history"] as const;
export type CachePrefix = (typeof CACHE_PREFIXES)[number];

export const LIVE_CLIENT_EVENT_TYPES = ["turn", "audio", "image", "text", "tool_result", "interrupt", "end_audio"] as const;
export type LiveClientEventType = (typeof LIVE_CLIENT_EVENT_TYPES)[number];

export const LIVE_SERVER_EVENT_TYPES = [
  "audio",
  "text",
  "tool_call",
  "tool_call_delta",
  "interrupted",
  "turn_end",
  "usage",
  "error",
] as const;
export type LiveServerEventType = (typeof LIVE_SERVER_EVENT_TYPES)[number];

export const AUTH_SCHEMES = ["bearer", "x-api-key", "api-key", "query-key", "sigv4"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const CREDENTIAL_KINDS = ["api_key", "bearer_token", "aws"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_POLICIES = ["key", "oauth", "oauth-unless-explicit", "aws-chain", "azure-chain", "gcp-chain"] as const;
export type CredentialPolicy = (typeof CREDENTIAL_POLICIES)[number];

export const RUNG_KINDS = [
  "env",
  "ini-profile",
  "json-file",
  "subprocess",
  "http-metadata",
  "http-token-exchange",
  "sigv4-sts",
  "unsigned-sts",
  "jwt-rs256",
  "file-cache",
] as const;
export type RungKind = (typeof RUNG_KINDS)[number];

export const AUTH_STEP_STATES = ["selected", "shadowed", "absent", "unprobed"] as const;
export type AuthStepState = (typeof AUTH_STEP_STATES)[number];

export const STREAM_FRAMINGS = ["sse", "aws-event-stream"] as const;
export type StreamFraming = (typeof STREAM_FRAMINGS)[number];

export const MODEL_PLACEMENTS = ["body", "path"] as const;
export type ModelPlacement = (typeof MODEL_PLACEMENTS)[number];

export const IMAGE_DETAILS = ["low", "high", "auto"] as const;
export type ImageDetail = (typeof IMAGE_DETAILS)[number];

/** Every vocabulary by its spec name, for `surface_dump` and drift checks. */
export const VOCABULARIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Role: ROLES,
  PartType: PART_TYPES,
  DeltaType: DELTA_TYPES,
  FinishReason: FINISH_REASONS,
  ReasoningEffort: REASONING_EFFORTS,
  ReasoningSummary: REASONING_SUMMARIES,
  ErrorCode: ERROR_CODES,
  StreamEventType: STREAM_EVENT_TYPES,
  BatchStatus: BATCH_STATUSES,
  BATCH_TERMINAL_STATUSES,
  BatchOutcome: BATCH_OUTCOMES,
  VideoStatus: VIDEO_STATUSES,
  VIDEO_TERMINAL_STATUSES,
  FileReadiness: FILE_READINESS_VALUES,
  AudioEncoding: AUDIO_ENCODINGS,
  ToolChoiceMode: TOOL_CHOICE_MODES,
  CacheMode: CACHE_MODES,
  CacheRetention: CACHE_RETENTIONS,
  CachePrefix: CACHE_PREFIXES,
  LiveClientEventType: LIVE_CLIENT_EVENT_TYPES,
  LiveServerEventType: LIVE_SERVER_EVENT_TYPES,
  AuthScheme: AUTH_SCHEMES,
  CredentialKind: CREDENTIAL_KINDS,
  CredentialPolicy: CREDENTIAL_POLICIES,
  RungKind: RUNG_KINDS,
  AuthStepState: AUTH_STEP_STATES,
  StreamFraming: STREAM_FRAMINGS,
  ModelPlacement: MODEL_PLACEMENTS,
});

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
