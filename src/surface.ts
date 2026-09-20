/**
 * The public type surface, by reflection over the TypeScript declarations
 * (`tools/gen_surface.ts` regenerates this file at build time from the
 * compiler's view of `src/types/*.ts`). Never edited by hand.
 */
export const SURFACE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  {
    "Adaptation": [
      "field",
      "action",
      "reason",
      "asked",
      "applied"
    ],
    "ApiKey": [
      "kind"
    ],
    "AudioDelta": [
      "type",
      "data",
      "url",
      "file_id",
      "media_type",
      "part_index"
    ],
    "AudioFormat": [
      "encoding",
      "sample_rate",
      "channels"
    ],
    "AudioPart": [
      "type",
      "media_type",
      "data",
      "url",
      "file_id",
      "path",
      "continuation"
    ],
    "AwsCredentials": [
      "kind",
      "access_key_id",
      "expires_at"
    ],
    "BatchEntry": [
      "index",
      "outcome",
      "response",
      "error"
    ],
    "BatchJobInfo": [
      "id",
      "status",
      "label",
      "created_at",
      "provider_data"
    ],
    "BatchRequest": [
      "model",
      "requests",
      "label",
      "extensions"
    ],
    "BearerToken": [
      "kind",
      "expires_at"
    ],
    "BinaryPart": [
      "type",
      "media_type",
      "data",
      "url",
      "file_id",
      "path",
      "continuation"
    ],
    "BuiltinTool": [
      "type",
      "name",
      "config"
    ],
    "CacheConfig": [
      "mode",
      "retention",
      "key",
      "prefix_until_index",
      "prefix",
      "resource"
    ],
    "CacheInfo": [
      "id",
      "model",
      "tokens",
      "created_at",
      "expires_at",
      "label",
      "provider_data"
    ],
    "CachePage": [
      "items",
      "next_cursor"
    ],
    "CachedPrefix": [
      "prefix",
      "resource",
      "provider"
    ],
    "CitationDelta": [
      "type",
      "text",
      "url",
      "title",
      "part_index"
    ],
    "CitationPart": [
      "type",
      "url",
      "title",
      "text",
      "continuation"
    ],
    "Config": [
      "max_tokens",
      "temperature",
      "top_p",
      "top_k",
      "stop",
      "seed",
      "frequency_penalty",
      "presence_penalty",
      "response_format",
      "tool_choice",
      "reasoning",
      "cache",
      "service_tier",
      "user_id",
      "store",
      "logprobs",
      "probabilities",
      "extensions"
    ],
    "ContinuationDelta": [
      "type",
      "provider",
      "kind",
      "data",
      "part_index"
    ],
    "ContinuationOption": [
      "continuation"
    ],
    "ContinuationState": [
      "provider",
      "kind",
      "data"
    ],
    "CredentialSource": [
      "rung",
      "label",
      "named",
      "expires_at"
    ],
    "DataPart": [
      "type",
      "value",
      "probabilities",
      "method",
      "continuation"
    ],
    "DocumentPart": [
      "type",
      "media_type",
      "data",
      "url",
      "file_id",
      "path",
      "continuation"
    ],
    "ErrorDetail": [
      "code",
      "message",
      "provider_code",
      "http_response"
    ],
    "FileInfo": [
      "id",
      "filename",
      "media_type",
      "size_bytes",
      "created_at",
      "expires_at",
      "readiness",
      "downloadable",
      "provider_data"
    ],
    "FilePage": [
      "items",
      "next_cursor"
    ],
    "FileUploadRequest": [
      "filename",
      "bytes",
      "media_type",
      "extensions",
      "path"
    ],
    "FunctionTool": [
      "type",
      "name",
      "description",
      "parameters"
    ],
    "ImageDelta": [
      "type",
      "data",
      "url",
      "file_id",
      "media_type",
      "part_index"
    ],
    "ImageGenerationRequest": [
      "model",
      "prompt",
      "size",
      "images",
      "extensions"
    ],
    "ImageGenerationResponse": [
      "images",
      "text",
      "id",
      "model",
      "usage",
      "provider_data"
    ],
    "ImagePart": [
      "type",
      "detail",
      "media_type",
      "data",
      "url",
      "file_id",
      "path",
      "continuation"
    ],
    "InferenceModelInfo": [
      "input_modalities",
      "output_modalities",
      "context_window",
      "max_output_tokens",
      "supports_reasoning",
      "reasoning_efforts",
      "pricing",
      "extensions"
    ],
    "InferencePricing": [
      "input_per_million",
      "output_per_million",
      "cache_read_per_million",
      "cache_write_per_million",
      "currency",
      "dimensions"
    ],
    "LiveClientAudioEvent": [
      "type",
      "data",
      "media_type"
    ],
    "LiveClientEndAudioEvent": [
      "type"
    ],
    "LiveClientImageEvent": [
      "type",
      "data",
      "media_type"
    ],
    "LiveClientInterruptEvent": [
      "type"
    ],
    "LiveClientTextEvent": [
      "type",
      "text"
    ],
    "LiveClientToolResultEvent": [
      "type",
      "id",
      "content"
    ],
    "LiveClientTurnEvent": [
      "type",
      "parts",
      "turn_complete"
    ],
    "LiveConfig": [
      "model",
      "system",
      "tools",
      "voice",
      "input_format",
      "output_format",
      "extensions"
    ],
    "LiveServerAudioEvent": [
      "type",
      "data",
      "media_type"
    ],
    "LiveServerErrorEvent": [
      "type",
      "error"
    ],
    "LiveServerInterruptedEvent": [
      "type"
    ],
    "LiveServerTextEvent": [
      "type",
      "text"
    ],
    "LiveServerToolCallDeltaEvent": [
      "type",
      "input_delta",
      "id",
      "name"
    ],
    "LiveServerToolCallEvent": [
      "type",
      "id",
      "name",
      "input"
    ],
    "LiveServerTurnEndEvent": [
      "type",
      "usage"
    ],
    "LiveServerUsageEvent": [
      "type",
      "usage"
    ],
    "Message": [
      "role",
      "parts",
      "continuation"
    ],
    "ModelInfo": [
      "id",
      "provider",
      "api_family",
      "aliases",
      "origin",
      "inference",
      "extensions"
    ],
    "ModelOrigin": [
      "type",
      "id",
      "base_model",
      "provider_data"
    ],
    "Reasoning": [
      "effort",
      "thinking_budget",
      "summary"
    ],
    "RefusalPart": [
      "type",
      "text",
      "continuation"
    ],
    "Request": [
      "model",
      "messages",
      "system",
      "tools",
      "config"
    ],
    "Response": [
      "id",
      "model",
      "message",
      "finish_reason",
      "usage",
      "logprobs",
      "logprobs_complete",
      "provider_data",
      "adaptations"
    ],
    "SourcedCredentialProvider": [
      "source",
      "named"
    ],
    "SpeechGenerationRequest": [
      "model",
      "prompt",
      "voice",
      "format",
      "extensions"
    ],
    "SpeechGenerationResponse": [
      "audio",
      "id",
      "model",
      "usage",
      "provider_data"
    ],
    "StreamDeltaEvent": [
      "type",
      "delta"
    ],
    "StreamEndEvent": [
      "type",
      "finish_reason",
      "usage",
      "provider_data"
    ],
    "StreamErrorEvent": [
      "type",
      "error"
    ],
    "StreamStartEvent": [
      "type",
      "id",
      "model",
      "adaptations"
    ],
    "TextDelta": [
      "type",
      "text",
      "logprobs",
      "logprobs_complete",
      "part_index"
    ],
    "TextPart": [
      "type",
      "text",
      "continuation"
    ],
    "ThinkingDelta": [
      "type",
      "text",
      "part_index"
    ],
    "ThinkingPart": [
      "type",
      "text",
      "continuation"
    ],
    "TokenLogprob": [
      "top",
      "token",
      "logprob",
      "bytes",
      "token_id"
    ],
    "ToolCallDelta": [
      "type",
      "input",
      "id",
      "name",
      "part_index"
    ],
    "ToolCallPart": [
      "type",
      "id",
      "name",
      "input",
      "continuation"
    ],
    "ToolChoice": [
      "mode",
      "allowed",
      "parallel"
    ],
    "ToolResultPart": [
      "type",
      "id",
      "content",
      "name",
      "is_error",
      "continuation"
    ],
    "TopLogprob": [
      "token",
      "logprob",
      "bytes",
      "token_id"
    ],
    "Usage": [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
      "input_audio_tokens",
      "output_audio_tokens"
    ],
    "VideoGenerationRequest": [
      "model",
      "prompt",
      "seconds",
      "images",
      "extensions"
    ],
    "VideoJobInfo": [
      "id",
      "status",
      "progress",
      "created_at",
      "model",
      "provider_data"
    ],
    "VideoPart": [
      "type",
      "media_type",
      "data",
      "url",
      "file_id",
      "path",
      "continuation"
    ]
  } as Record<string, readonly string[]>,
);
