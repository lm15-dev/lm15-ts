/**
 * lm15 — One interface for OpenAI, Anthropic, and Gemini. Zero dependencies.
 *
 * TypeScript implementation.
 */

export {
  // Types
  type JsonPrimitive, type JsonValue, type JsonArray, type JsonObject,
  type Role, type PartType, type ToolType, type ReasoningEffort, type FinishReason,
  type DataSourceType, type StreamEventType, type PartDeltaType, type ErrorCode,
  type AudioEncoding,
  type DataSource, createDataSource, dataSourceBytes,
  type TextPart, type ThinkingPart, type RefusalPart, type CitationPart,
  type ImagePart, type AudioPart, type VideoPart, type DocumentPart,
  type ToolCallPart, type ToolResultPart,
  type Part as PartUnion,
  Part,
  type FunctionTool, type BuiltinTool, type Tool, type ToolCallInfo, type ToolConfig,
  type ReasoningConfig, type Config, type AudioFormat,
  type Message as MessageType,
  Message,
  type LMRequest, type Usage, EMPTY_USAGE, type LMResponse,
  responseText, responseThinking, responseToolCalls, responseImage, responseAudio, responseCitations, responseJson,
  type ErrorInfo, type PartDelta, type StreamEvent,
  type LiveConfig, type LiveClientEvent, type LiveServerEvent,
  type EmbeddingRequest, type EmbeddingResponse,
  type FileUploadRequest, type FileUploadResponse,
  type BatchRequest, type BatchResponse,
  type ImageGenerationRequest, type ImageGenerationResponse,
  type AudioGenerationRequest, type AudioGenerationResponse,
} from "./types.js";

export {
  ULMError, TransportError, ProviderError,
  AuthError, BillingError, RateLimitError,
  InvalidRequestError, ContextLengthError,
  TimeoutError, ServerError,
  UnsupportedModelError, UnsupportedFeatureError, NotConfiguredError,
  mapHttpError, canonicalErrorCode,
} from "./errors.js";

export {
  type TransportPolicy, DEFAULT_POLICY,
  type HttpRequest, type HttpResponse,
  httpResponseText, httpResponseJson,
  type Transport, FetchTransport,
} from "./transport.js";

export { type SSEEvent, parseSSE } from "./sse.js";
