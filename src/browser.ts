/**
 * lm15/browser — the universal entry point: the whole wire — canonical
 * types, serde, every dialect and compat preset, the router, streaming,
 * live sessions, the fetch transport, the test doubles — with no host
 * service behind it. It imports nothing from `node:*`; it runs in a page,
 * a worker, a PWA, an Electron renderer, and in Node itself.
 *
 * What it does not do, by design (the host boundary, `platform.ts`):
 * discover a credential (no environment, no CLI login files), read a path
 * (bring bytes: a File, a Blob, an IndexedDB or OPFS read), run a cloud
 * credential chain, or sign SigV4. Each of those refuses by name; none is
 * silently skipped. An application that has those services (an Electron
 * preload bridge, a host extension) installs a `Platform` of its own.
 *
 * ```ts
 * import { OpenAIChatLM, Message } from "lm15/browser";
 *
 * const lm = new OpenAIChatLM({ apiKey: userKey, baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
 * const response = await lm.complete({ model: "your-model-id", messages: [Message.user("hi")] });
 * ```
 */

// The core loop (playbooks/api-family.md)
export { LMRouter, DEFAULT_RULES, LITELLM_PROVIDER_PREFIXES, MissingCredentialError, apiKeysSource, describeResolution, openaiChatModelString, resolveModel } from "./router.ts";
export type { Resolution, ResolutionSource, RouteRule, RouterConfig } from "./router.ts";
export { ResponseStream, STREAM_CLEANUP_WARNING, StreamAccumulator, coalesceStream, coalesceStreamAsync, materializeResponse, materializeResponseAsync, responseToEvents, parseSse, parseSseAsync, splitLines, splitLinesAsync } from "./stream.ts";
export type { SSEEvent, CoalesceOptions } from "./stream.ts";
export { applyClientSideStop, truncateStreamAtStop, truncateStreamAtStopAsync, scoresBeforeCut } from "./stop.ts";

// MAP-13: adapt freely, never invisibly
export { Adaptation } from "./types/adaptation.ts";
export { DEVIATIONS, EFFORT_LADDER, checkPolicy, nearestEffort } from "./adaptation.ts";
export type { AdaptationAction, AdaptationPolicy } from "./adaptation.ts";

// MAP-14: judgments
export { choice, yesNo, score, judgments, judgmentsInSchema, requestJudgments, expectedLevel, MAX_ORDERED_LEVELS, MAX_CHOICE_KEYS } from "./judgments.ts";
export type { Judgment, JudgmentKind, JudgmentsFormat } from "./judgments.ts";

// Canonical types
export {
  Message,
  Part,
  ContinuationState,
  continuationState,
  continuationData,
  text,
  thinking,
  refusal,
  citation,
  image,
  audio,
  video,
  document,
  binary,
  toolCall,
  toolResult,
  isPart,
  isMediaPart,
  guessMediaType,
  DEFAULT_MEDIA_TYPES,
} from "./types/parts.ts";
export type {
  TextPart,
  ThinkingPart,
  RefusalPart,
  CitationPart,
  ImagePart,
  AudioPart,
  VideoPart,
  DocumentPart,
  BinaryPart,
  ToolCallPart,
  ToolResultPart,
  MediaPart,
  ToolResultContentPart,
  PromptPart,
  AssistantPart,
  PartInput,
  PromptContent,
  AssistantContent,
  MediaOptions,
  ToolResultOptions,
} from "./types/parts.ts";
export { Request, Config, Tool, ToolChoice, Reasoning, CacheConfig, tool, builtinTool, isReasoningOff, isDefaultConfig } from "./types/config.ts";
export type { FunctionTool, BuiltinTool, ResponseFormat, RequestInput } from "./types/config.ts";
export { Response, Usage, ErrorDetail, TokenLogprob } from "./types/response.ts";
export type { TopLogprob, ResponseFields } from "./types/response.ts";
export { Delta, StreamEvent, streamStart, streamDelta, streamEnd, streamError } from "./types/stream.ts";
export type {
  TextDelta,
  ThinkingDelta,
  AudioDelta,
  ImageDelta,
  ToolCallDelta,
  CitationDelta,
  ContinuationDelta,
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamErrorEvent,
} from "./types/stream.ts";
export {
  FileUploadRequest,
  FileInfo,
  FilePage,
  CacheInfo,
  CachePage,
  CachedPrefix,
  BatchRequest,
  BatchJobInfo,
  BatchEntry,
  ImageGenerationRequest,
  ImageGenerationResponse,
  SpeechGenerationRequest,
  SpeechGenerationResponse,
  VideoGenerationRequest,
  VideoJobInfo,
} from "./types/endpoints.ts";
export {
  AudioFormat,
  LiveConfig,
  LiveClientEvent,
  LiveServerEvent,
  DEFAULT_LIVE_AUDIO_MEDIA_TYPE,
  DEFAULT_LIVE_IMAGE_MEDIA_TYPE,
} from "./types/live.ts";
export type {
  LiveClientTurnEvent,
  LiveClientAudioEvent,
  LiveClientImageEvent,
  LiveClientTextEvent,
  LiveClientToolResultEvent,
  LiveClientInterruptEvent,
  LiveClientEndAudioEvent,
  LiveServerAudioEvent,
  LiveServerTextEvent,
  LiveServerToolCallEvent,
  LiveServerToolCallDeltaEvent,
  LiveServerInterruptedEvent,
  LiveServerTurnEndEvent,
  LiveServerUsageEvent,
  LiveServerErrorEvent,
} from "./types/live.ts";
export { ModelInfo, ModelOrigin, InferenceModelInfo, InferencePricing, ModelRegistry } from "./types/model_info.ts";
export { ApiKey, BearerToken, AwsCredentials, Credential, coerceCredential, isCredentialValue, parseRfc3339, formatRfc3339 } from "./types/credential.ts";
export type { CredentialValue, CredentialProvider, CredentialLike } from "./types/credential.ts";
export { ValueError } from "./types/validate.ts";

// Vocabularies
export * from "./vocab.ts";

// Serde
export { toJSON, KIND_SERDE, serdeForKind } from "./serde.ts";
export type { KindSerde } from "./serde.ts";
export { RawNumber, parseJson, parseJsonObject, stringifyJson, jsonEquals, isJsonObject, float } from "./json.ts";
export type { JsonValue, JsonObject, JsonPrimitive } from "./json.ts";

// Errors
export {
  LM15Error,
  TransportError,
  LockTimeoutError,
  StreamAssemblyError,
  CollectionLimitError,
  ConfigurationError,
  NotConfiguredError,
  UnknownModelError,
  AmbiguousModelError,
  CapabilityError,
  UnsupportedFeatureError,
  ProviderError,
  AuthError,
  BillingError,
  RateLimitError,
  InvalidRequestError,
  ContextLengthError,
  UnsupportedModelError,
  TimeoutError,
  RequestTimeoutError,
  ServerError,
  RETRYABLE_ERRORS,
  canonicalErrorCode,
  errorClassForCode,
  mapHttpError,
} from "./errors.ts";
export type { ErrorMetadata, CapabilityMetadata, CollectionLimitMetadata } from "./errors.ts";

// Providers, direct
export { OpenAILM, OpenAICodexLM } from "./dialects/openai_responses.ts";
export type { OpenAILMOptions } from "./dialects/openai_responses.ts";
export { OpenAIChatLM, requestFromOpenAIChat, responseFromOpenAIChat } from "./dialects/openai_chat.ts";
export type { OpenAIChatLMOptions } from "./dialects/openai_chat.ts";
export { AnthropicLM, ClaudeCodeLM } from "./dialects/anthropic.ts";
export type { AnthropicLMOptions, ClaudeCodeLMOptions } from "./dialects/anthropic.ts";
export { GeminiLM } from "./dialects/gemini.ts";
export type { GeminiLMOptions } from "./dialects/gemini.ts";
export { XaiLM } from "./dialects/xai.ts";
export { TypeSafeLM } from "./dialects/typesafe.ts";
export { ProviderLM } from "./adapter.ts";
export type { LMOptions, BuiltRequest, EmitOptions } from "./adapter.ts";
export { adapterFor } from "./providers.ts";
export { PROVIDERS, lookup, canonicalProvider, DIALECT_API_FAMILY } from "./registry.ts";
export type { ProviderDefinition, Dialect } from "./registry.ts";
export { LiveSession, TurnView, materializeTurn, incompleteTurn, liveEventSize, sumUsage, DEFAULT_TURN_MAX_BYTES, DEFAULT_TURN_MAX_EVENTS } from "./live.ts";
export type { Turn, ToolCallInfo, TurnViewOptions } from "./live.ts";
export type { LiveSessionOptions } from "./live.ts";

// Compat presets
export {
  OPENAI_CHAT_PRESETS,
  OPENAI_RESPONSES_PRESETS,
  ANTHROPIC_PRESETS,
  OPENAI_CHAT_PRESET_BASE_URLS,
  OPENAI_RESPONSES_PRESET_BASE_URLS,
  ANTHROPIC_PRESET_BASE_URLS,
  resolveOpenAIChatCompat,
  resolveOpenAIResponsesCompat,
  resolveAnthropicCompat,
  EFFORT_THINKING_BUDGETS,
} from "./compat.ts";
export type { OpenAIChatCompat, OpenAIResponsesCompat, AnthropicCompat, ToolResultMedia } from "./compat.ts";

// Access policies (AUTH-10) and auth
export * as access from "./auth/policy.ts";
export type { AccessPolicy, EndpointSupport, HostSpec, HostSetting } from "./auth/policy.ts";
export { explainAuth, describeReport } from "./auth/doctor.ts";
export type { AuthReport, AuthStep, ExplainAuthOptions } from "./auth/doctor.ts";

// Transport
export { FetchTransport } from "./transport.ts";
export type { Transport, TransportResponse, FetchTransportOptions } from "./transport.ts";
export { HttpResponse } from "./wire.ts";
export type { TransportRequest } from "./wire.ts";

export { VERSION } from "./version.ts";

// The host boundary
export { getDefaultPlatform, setDefaultPlatform, webPlatform } from "./platform.ts";
export type { Platform, StoredCredentials, CloudChain, CloudChainOptions, ChainStep, SigV4Input, LoadedCredential, Env } from "./platform.ts";
export { loadCredential } from "./adapter.ts";
export { base64Encode, base64Decode, base64UrlEncode, utf8Encode, utf8Decode } from "./bytes.ts";
export { decodeJwtPayload, looksLikeJwt } from "./auth/jwt.ts";
export { generatePkce, pkceChallenge } from "./auth/pkce.ts";
export type { PkcePair } from "./auth/pkce.ts";
