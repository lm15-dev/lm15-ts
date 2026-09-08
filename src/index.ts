/**
 * lm15 — one canonical request/response model over every provider the
 * lm15-contract names, byte-exact against its corpus.
 *
 * ```ts
 * import { LMRouter, Message } from "lm15";
 *
 * const router = new LMRouter(); // keys from the environment (AUTH-1)
 * const response = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("hi")] });
 * console.log(response.text);
 * ```
 */

// The core loop (playbooks/api-family.md)
export { LMRouter, DEFAULT_RULES, MissingCredentialError, describeResolution, resolveModel } from "./router.ts";
export type { Resolution, ResolutionSource, RouteRule, RouterConfig } from "./router.ts";
export { ResponseStream, StreamAccumulator, coalesceStream, coalesceStreamAsync, materializeResponse, materializeResponseAsync, parseSse, parseSseAsync } from "./stream.ts";
export type { SSEEvent } from "./stream.ts";

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
export type { ErrorMetadata } from "./errors.ts";

// Providers, direct
export { OpenAILM, OpenAICodexLM } from "./dialects/openai_responses.ts";
export type { OpenAILMOptions } from "./dialects/openai_responses.ts";
export { OpenAIChatLM, requestFromOpenAIChat } from "./dialects/openai_chat.ts";
export type { OpenAIChatLMOptions } from "./dialects/openai_chat.ts";
export { AnthropicLM, ClaudeCodeLM } from "./dialects/anthropic.ts";
export type { AnthropicLMOptions, ClaudeCodeLMOptions } from "./dialects/anthropic.ts";
export { GeminiLM } from "./dialects/gemini.ts";
export type { GeminiLMOptions } from "./dialects/gemini.ts";
export { XaiLM } from "./dialects/xai.ts";
export { ProviderLM } from "./adapter.ts";
export type { LMOptions } from "./adapter.ts";
export { adapterFor } from "./providers.ts";
export { PROVIDERS, lookup, canonicalProvider, DIALECT_API_FAMILY } from "./registry.ts";
export type { ProviderDefinition, Dialect } from "./registry.ts";
export { LiveSession } from "./live.ts";
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
export { login, loginXai, LocalOAuthCredential, CredentialFileStore, defaultCredentialsPath, withFileLock } from "./auth/stores.ts";
export { ChainContext, explain as explainChain, credentialProvider } from "./cloud/chains.ts";

// Transport
export { FetchTransport } from "./transport.ts";
export type { Transport, TransportResponse } from "./transport.ts";
export { HttpResponse } from "./wire.ts";
export type { TransportRequest } from "./wire.ts";

export { VERSION } from "./version.ts";
