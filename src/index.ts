/**
 * lm15 — One interface for OpenAI, Anthropic, and Gemini. Zero dependencies.
 *
 * TypeScript implementation.
 */

// ── Types ──────────────────────────────────────────────────────────

export {
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

// ── Errors ─────────────────────────────────────────────────────────

export {
  ULMError, TransportError, ProviderError,
  AuthError, BillingError, RateLimitError,
  InvalidRequestError, ContextLengthError,
  TimeoutError, ServerError,
  UnsupportedModelError, UnsupportedFeatureError, NotConfiguredError,
  mapHttpError, canonicalErrorCode, errorClassForCode,
} from "./errors.js";

// ── Transport ──────────────────────────────────────────────────────

export {
  type TransportPolicy, DEFAULT_POLICY,
  type HttpRequest, type HttpResponse,
  httpResponseText, httpResponseJson,
  type Transport, FetchTransport,
} from "./transport.js";

export { type SSEEvent, parseSSE } from "./sse.js";

// ── Capabilities ───────────────────────────────────────────────────

export { type Capabilities, resolveProvider, resolveCapabilities, CapabilityResolver } from "./capabilities.js";

// ── Providers ──────────────────────────────────────────────────────

export {
  type LMAdapter, type EndpointSupport, type ProviderManifest, type LiveSession,
  BaseProviderAdapter,
} from "./providers/base.js";
export { OpenAIAdapter } from "./providers/openai.js";
export { AnthropicAdapter } from "./providers/anthropic.js";
export { GeminiAdapter } from "./providers/gemini.js";

// ── Client ─────────────────────────────────────────────────────────

export { UniversalLM } from "./client.js";

// ── Middleware ─────────────────────────────────────────────────────

export {
  MiddlewarePipeline,
  withRetries, withCache, withHistory,
  type CompleteMiddleware, type StreamMiddleware,
  type HistoryEntry as MiddlewareHistoryEntry,
} from "./middleware.js";

// ── Result ─────────────────────────────────────────────────────────

export { Result, type StreamChunk, type ResultOpts, type StartStreamFn, type OnFinishedFn } from "./result.js";

// ── Model ──────────────────────────────────────────────────────────

export { Model, type ModelOpts, type CallOpts, type HistoryEntry } from "./model.js";

// ── Conversation ───────────────────────────────────────────────────

export { Conversation } from "./conversation.js";

// ── Factory ────────────────────────────────────────────────────────

export { buildDefault, type BuildDefaultOpts } from "./factory.js";

// ── Model Catalog ──────────────────────────────────────────────────

export { type ModelSpec, fetchModelsDev, buildProviderModelIndex } from "./model_catalog.js";

// ── Cost Estimation ────────────────────────────────────────────────

export { type CostBreakdown, estimateCost } from "./cost.js";

// ── Discovery ──────────────────────────────────────────────────────

export { type ModelsOpts } from "./discovery.js";

// ── Live Sessions ──────────────────────────────────────────────────

export { WebSocketLiveSession, type EncodeEventFn, type DecodeEventFn } from "./live.js";

// ── Serde ──────────────────────────────────────────────────────────

export {
  dataSourceToDict, partToDict, messageToDict, toolToDict, usageToDict,
  configToDict, requestToDict, responseToDict, errorInfoToDict,
  partDeltaToDict, streamEventToDict, liveConfigToDict,
  liveClientEventToDict, liveServerEventToDict,
  dataSourceFromDict, partFromDict, messageFromDict, toolFromDict,
  usageFromDict, configFromDict, requestFromDict, responseFromDict,
  errorInfoFromDict, streamEventFromDict,
} from "./serde.js";

// ── High-level API ─────────────────────────────────────────────────

export {
  configure,
  call,
  stream,
  model,
  prepare,
  send,
  upload,
  models,
  providersInfo,
  providers,
  type CallOptions,
  type ModelOptions,
} from "./api.js";
