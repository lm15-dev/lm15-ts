/**
 * Google Gemini dialect (`GeminiLM`): generateContent, the Live codec,
 * models, Files, cachedContents (the stored cache tier of MAP-6), Batch
 * Mode, Veo video jobs, and image/speech generation through the same call.
 */

import { ProviderLM, batchEntryHttp, type LMOptions } from "../adapter.ts";
import { GEMINI_API, type AccessPolicy } from "../auth/policy.ts";
import { EFFORT_THINKING_BUDGETS } from "../compat.ts";
import {
  AuthError,
  BillingError,
  ContextLengthError,
  InvalidRequestError,
  ProviderError,
  RateLimitError,
  ServerError,
  TimeoutError,
  UnsupportedFeatureError,
  UnsupportedModelError,
  canonicalErrorCode,
  mapHttpError,
} from "../errors.ts";
import { isJsonObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../json.ts";
import type { SSEEvent } from "../stream.ts";
import { Request, type BuiltinTool, type ResponseFormat } from "../types/config.ts";
import {
  BatchEntry,
  BatchJobInfo,
  CacheInfo,
  CachePage,
  FileInfo,
  FilePage,
  ImageGenerationResponse,
  SpeechGenerationResponse,
  VideoJobInfo,
  type BatchRequest,
  type FileUploadRequest,
  type ImageGenerationRequest,
  type SpeechGenerationRequest,
  type VideoGenerationRequest,
} from "../types/endpoints.ts";
import type { LiveClientEvent, LiveConfig, LiveServerEvent } from "../types/live.ts";
import type { ModelInfo } from "../types/model_info.ts";
import { Message, continuationData, normalizePart, type CitationPart, type Part, type ToolResultPart, type VideoPart } from "../types/parts.ts";
import { ErrorDetail, Response, Usage, normalizeTokenLogprob, type TokenLogprob } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import { ValueError, encodeBase64 } from "../types/validate.ts";
import type { FinishReason } from "../vocab.ts";
import {
  HttpResponse,
  MEDIA_KINDS,
  buildUrl,
  isoUtc,
  mediaBase64,
  modelInfosFromEntries,
  multipartRelatedBody,
  partsToText,
  pathId,
  percentEncode,
  readFileBytes,
  unnamedToolCallError,
  type TransportRequest,
} from "../wire.ts";
import { batchEntryRequest } from "./openai_responses.ts";
import { attachUnmapped, int, list, obj, recordUnmapped, str, typeName, type Unmapped } from "./openai_shared.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_UPLOAD_BASE_URL = "https://generativelanguage.googleapis.com/upload/v1beta";

const GEMINI_BUILTIN_MAP: Readonly<Record<string, string>> = Object.freeze({ web_search: "googleSearch", code_execution: "codeExecution" });
const PROVIDER_EXECUTED_PART_KEYS = ["executableCode", "codeExecutionResult"];

const ERROR_STATUS_MAP: Readonly<Record<string, typeof ProviderError>> = Object.freeze({
  INVALID_ARGUMENT: InvalidRequestError,
  FAILED_PRECONDITION: BillingError,
  PERMISSION_DENIED: AuthError,
  UNAUTHENTICATED: AuthError,
  NOT_FOUND: InvalidRequestError,
  RESOURCE_EXHAUSTED: RateLimitError,
  INTERNAL: ServerError,
  UNAVAILABLE: ServerError,
  DEADLINE_EXCEEDED: TimeoutError,
});

const CANDIDATE_FINISH_ERRORS = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_OTHER",
  "NO_IMAGE",
  "IMAGE_RECITATION",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "MISSING_THOUGHT_SIGNATURE",
  "MALFORMED_RESPONSE",
]);

/** MAP-7 rule 10: the Gemini 3.x class (`thinkingLevel`, no full off). A table that rots. */
export function geminiLevelClass(model: string): boolean {
  const l = model.toLowerCase();
  return l.startsWith("models/gemini-3") || l.startsWith("gemini-3");
}

function isContextLengthMessage(msg: string): boolean {
  const l = msg.toLowerCase();
  return (l.includes("token") && (l.includes("limit") || l.includes("exceed"))) || l.includes("too long") || l.includes("context is too long") || l.includes("context length");
}

function isModelError(message: string): boolean {
  const l = message.toLowerCase();
  return l.includes("model") && ["not found", "does not exist", "not exist", "not supported", "unsupported", "not available", "unknown"].some((m) => l.includes(m));
}

function finishReason(reason: unknown, hasToolCall = false): FinishReason {
  if (hasToolCall) return "tool_call";
  const r = str(reason).toUpperCase();
  if (r === "MAX_TOKENS") return "length";
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(r)) return "content_filter";
  return "stop";
}

function geminiTokenLogprobs(result: unknown): TokenLogprob[] {
  if (!isJsonObject(result)) return [];
  const chosen = list(result["chosenCandidates"]);
  const topSteps = list(result["topCandidates"]);
  const out: TokenLogprob[] = [];
  chosen.forEach((cand, i) => {
    if (!isJsonObject(cand)) return;
    const step = isJsonObject(topSteps[i]) ? (topSteps[i] as JsonObject) : {};
    const top = list(step["candidates"])
      .filter(isJsonObject)
      .map((alt) => ({ token: str(alt["token"]), logprob: alt["logProbability"] ?? 0, tokenId: alt["tokenId"] }));
    out.push(normalizeTokenLogprob({ token: str(cand["token"]), logprob: cand["logProbability"] ?? 0, tokenId: cand["tokenId"], top }));
  });
  return out;
}

function containsKey(value: JsonValue, key: string): boolean {
  if (isJsonObject(value)) return key in value || Object.values(value).some((v) => containsKey(v, key));
  if (Array.isArray(value)) return value.some((v) => containsKey(v, key));
  return false;
}

function responseFormatToGeminiConfig(format: ResponseFormat): JsonObject {
  if (format.type === "json_object") return { responseMimeType: "application/json" };
  const field = containsKey(format.schema, "additionalProperties") ? "responseJsonSchema" : "responseSchema";
  return { responseMimeType: "application/json", [field]: format.schema };
}

function modalityTokens(details: unknown, modality: string): number | undefined {
  if (!Array.isArray(details)) return undefined;
  const counts = details.filter((e) => isJsonObject(e) && e["modality"] === modality).map((e) => int((e as JsonObject)["tokenCount"]) ?? 0);
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : undefined;
}

/** `usageMetadata` → Usage: inside a present object an absent primary counter is a reported 0 (proto3-JSON). */
function geminiUsage(usage: unknown, outputKeys: readonly string[]): Usage {
  if (!isJsonObject(usage) || Object.keys(usage).length === 0) return Usage.empty;
  let outputTokens: JsonValue = 0;
  for (const key of outputKeys) {
    if (key in usage) {
      outputTokens = usage[key]!;
      break;
    }
  }
  return Usage.create({
    inputTokens: usage["promptTokenCount"] ?? 0,
    outputTokens,
    totalTokens: usage["totalTokenCount"],
    cacheReadTokens: usage["cachedContentTokenCount"],
    reasoningTokens: usage["thoughtsTokenCount"],
    inputAudioTokens: modalityTokens(usage["promptTokensDetails"], "AUDIO"),
    outputAudioTokens: modalityTokens(usage["candidatesTokensDetails"] ?? usage["responseTokensDetails"], "AUDIO"),
  });
}

function thoughtSignatureState(part: JsonObject): Array<{ provider: string; kind: string; data: JsonObject }> {
  const signature = part["thoughtSignature"];
  if (signature === null || signature === undefined) return [];
  return [{ provider: "gemini", kind: "thought_signature", data: { value: str(signature) } }];
}

function geminiBatchStatus(data: JsonObject): string {
  const state = str(obj(data["metadata"])["state"]).toUpperCase();
  const mapping: Record<string, string> = {
    BATCH_STATE_PENDING: "queued",
    BATCH_STATE_RUNNING: "running",
    BATCH_STATE_CANCELLING: "cancelling",
    BATCH_STATE_SUCCEEDED: "completed",
    BATCH_STATE_FAILED: "failed",
    BATCH_STATE_CANCELLED: "cancelled",
    BATCH_STATE_EXPIRED: "expired",
  };
  return mapping[state] ?? (data["done"] ? "completed" : "queued");
}

function segmentText(segment: JsonObject, fullText: string): string | undefined {
  const text = segment["text"];
  if (typeof text === "string" && text) return text;
  const start = int(segment["startIndex"]);
  const end = int(segment["endIndex"]);
  if (start !== undefined && end !== undefined && 0 <= start && start < end && end <= fullText.length) return fullText.slice(start, end);
  return undefined;
}

function geminiCitations(candidate: JsonObject, fullText: string): CitationPart[] {
  const grounding = candidate["groundingMetadata"];
  if (!isJsonObject(grounding)) return [];
  const chunks = list(grounding["groundingChunks"]);
  const supports = grounding["groundingSupports"];
  if (!Array.isArray(supports)) return [];
  const citations: CitationPart[] = [];
  const seen = new Set<string>();
  for (const support of supports) {
    if (!isJsonObject(support)) continue;
    const segment = obj(support["segment"]);
    const citedText = segmentText(segment, fullText);
    const indices = support["groundingChunkIndices"];
    if (!Array.isArray(indices)) continue;
    for (const index of indices) {
      const idx = int(index);
      const chunk = idx !== undefined && idx >= 0 && idx < chunks.length && isJsonObject(chunks[idx]) ? (chunks[idx] as JsonObject) : {};
      const source = obj(chunk["web"] ?? chunk["retrievedContext"] ?? chunk["googleSearch"]);
      const url = source["uri"] || source["url"];
      const title = source["title"] || source["name"];
      const u = url ? str(url) : undefined;
      const t = title ? str(title) : undefined;
      const key = JSON.stringify([u, t, citedText]);
      if (seen.has(key) || (u === undefined && t === undefined && citedText === undefined)) continue;
      seen.add(key);
      citations.push(normalizePart({ type: "citation", url: u, title: t, text: citedText }) as CitationPart);
    }
  }
  return citations;
}

export interface GeminiLMOptions extends LMOptions {
  readonly uploadBaseUrl?: string;
}

export class GeminiLM extends ProviderLM {
  static override readonly manifest: AccessPolicy = GEMINI_API;
  protected readonly dialectBaseUrl = DEFAULT_BASE_URL;
  protected override readonly apiKeyHeader = "x-goog-api-key";
  readonly uploadBaseUrl: string;

  constructor(opts: GeminiLMOptions = {}) {
    super(GEMINI_API, DEFAULT_BASE_URL, opts);
    this.uploadBaseUrl = opts.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE_URL;
  }

  // ─── Errors ──────────────────────────────────────────────────────

  protected errorDetail(providerCode: string, message: string): ErrorDetail {
    let cls: typeof ProviderError = ERROR_STATUS_MAP[providerCode] ?? ProviderError;
    if (isContextLengthMessage(message)) cls = ContextLengthError;
    else if (providerCode === "NOT_FOUND" && isModelError(message)) cls = UnsupportedModelError;
    return ErrorDetail.create({ code: canonicalErrorCode(cls), message: message || providerCode || "provider error", providerCode: providerCode || "provider" });
  }

  protected inbandError(data: JsonObject): ProviderError | undefined {
    const feedback = data["promptFeedback"];
    if (isJsonObject(feedback)) {
      const blockReason = str(feedback["blockReason"]);
      if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
        return this.providerError(InvalidRequestError, `Prompt blocked: ${blockReason}`, { providerCode: "promptFeedback" });
      }
    }
    const candidate = list(data["candidates"])[0];
    if (isJsonObject(candidate)) {
      const finish = str(candidate["finishReason"]);
      if (CANDIDATE_FINISH_ERRORS.has(finish)) {
        return this.providerError(InvalidRequestError, str(candidate["finishMessage"]) || `Candidate blocked: ${finish}`, { providerCode: finish || "finishReason" });
      }
    }
    return undefined;
  }

  override normalizeError(status: number, body: string): ProviderError {
    let msg: string;
    let errStatus = "";
    try {
      const data = parseJson(body);
      const err = isJsonObject(data) ? data["error"] : undefined;
      msg = isJsonObject(err) ? str(err["message"]) : err === undefined ? "" : str(err);
      errStatus = isJsonObject(err) ? str(err["status"]) : "";
      if (isContextLengthMessage(msg)) return this.providerError(ContextLengthError, msg, { status, providerCode: errStatus || null });
      if (errStatus === "NOT_FOUND" && isModelError(msg)) return this.providerError(UnsupportedModelError, msg, { status, providerCode: errStatus });
      const cls = ERROR_STATUS_MAP[errStatus];
      if (cls) return this.providerError(cls, msg, { status, providerCode: errStatus || null });
      if (errStatus && !msg.includes(errStatus)) msg = `${msg} (${errStatus})`;
    } catch {
      msg = body.trim().slice(0, 500) || `HTTP ${status}`;
      errStatus = "";
    }
    return mapHttpError(status, msg, { provider: this.provider, envKeys: this.access.envKeys, providerCode: errStatus || null });
  }

  // ─── Request ─────────────────────────────────────────────────────

  protected modelPath(model: string): string {
    const encoded = percentEncode(model, "/:@");
    return encoded.startsWith("models/") ? encoded : `models/${encoded}`;
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra };
  }

  /** `functionResponse` (MAP-10): text in `response.result`, media under `parts[]`, the name resolved from the transcript. */
  protected functionResponse(part: ToolResultPart, names: ReadonlyMap<string, string>): JsonObject {
    const textParts = part.content.filter((p) => !MEDIA_KINDS.has(p.type));
    const mediaParts = part.content.filter((p) => MEDIA_KINDS.has(p.type));
    for (const p of mediaParts) {
      if (p.type !== "image" && p.type !== "document") {
        throw new UnsupportedFeatureError(
          `${this.provider}: a ${p.type} part in tool_result ${JSON.stringify(part.id)} cannot reach a functionResponse — multimodal function responses take images (png/jpeg/webp) and documents (pdf, text/plain) only (MAP-10)`,
          { provider: this.provider },
        );
      }
    }
    const name = part.name ?? names.get(part.id);
    if (!name) {
      throw new UnsupportedFeatureError(
        `${this.provider}: tool_result ${JSON.stringify(part.id)} needs a function name on the Gemini wire and no preceding assistant tool_call with that id is in the transcript; set ToolResultPart.name (MAP-10 rule 6)`,
        { provider: this.provider },
      );
    }
    const text = partsToText(textParts, { provider: this.provider, where: "functionResponse.response" });
    const response: JsonObject = part.isError ? { error: text } : mediaParts.length > 0 && textParts.length === 0 ? {} : { result: text };
    const fr: JsonObject = { name, response };
    if (part.id) fr["id"] = part.id;
    if (mediaParts.length > 0) fr["parts"] = mediaParts.map((p) => this.part(p, names));
    return { functionResponse: fr };
  }

  protected part(part: Part, names: ReadonlyMap<string, string> = new Map()): JsonObject {
    switch (part.type) {
      case "text": {
        const out: JsonObject = { text: part.text };
        const thought = continuationData(part, "gemini", "thought_signature");
        if (thought && thought["value"]) out["thoughtSignature"] = thought["value"];
        return out;
      }
      case "image":
      case "audio":
      case "video":
      case "document":
      case "binary": {
        const mime = part.mediaType ?? "application/octet-stream";
        if (part.url !== undefined) return { fileData: { mimeType: mime, fileUri: part.url } };
        if (part.fileId !== undefined) return { fileData: { mimeType: mime, fileUri: part.fileId } };
        return { inlineData: { mimeType: mime, data: mediaBase64(part) } };
      }
      case "tool_call": {
        const fc: JsonObject = { name: part.name, args: part.input };
        if (part.id) fc["id"] = part.id;
        const out: JsonObject = { functionCall: fc };
        const thought = continuationData(part, "gemini", "thought_signature");
        if (thought && thought["value"]) out["thoughtSignature"] = thought["value"];
        return out;
      }
      case "tool_result":
        return this.functionResponse(part, names);
      case "thinking": {
        const out: JsonObject = { text: part.text };
        const thought = continuationData(part, "gemini", "thought_signature");
        if (thought && thought["value"]) {
          out["thought"] = true;
          out["thoughtSignature"] = thought["value"];
        }
        return out;
      }
      default:
        return { text: (part as { text?: string }).text ?? "" };
    }
  }

  protected message(msg: Message, names: ReadonlyMap<string, string> = new Map()): JsonObject {
    if (msg.role === "developer") return { role: "user", parts: [{ text: `[developer]\n${partsToText(msg.parts, { provider: this.provider, where: "a developer turn" })}` }] };
    return { role: msg.role === "assistant" ? "model" : "user", parts: msg.parts.map((p) => this.part(p, names)) };
  }

  /** tool_call id → function name over the transcript (MAP-10 rule 6). */
  protected static callNames(messages: readonly Message[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const m of messages) for (const p of m.parts) if (p.type === "tool_call" && p.id) names.set(p.id, p.name);
    return names;
  }

  protected toolConfigPayload(request: Request): JsonObject | undefined {
    const tc = request.config?.toolChoice;
    if (!tc) return undefined;
    if (tc.parallel === false) {
      throw new UnsupportedFeatureError(
        "gemini: tool_choice.parallel=False is not supported — GenerateContent has no parallel-tool-calls knob and returns several calls regardless (OpenAI and Anthropic carry it)",
        { provider: this.provider },
      );
    }
    const mode = tc.mode ?? "auto";
    const cfg: JsonObject = { mode: { none: "NONE", required: "ANY", auto: "AUTO" }[mode] };
    if (tc.allowed && tc.allowed.length > 0) {
      const byName = new Map((request.tools ?? []).map((t) => [t.name, t]));
      const builtins = tc.allowed.filter((n) => byName.get(n)?.type === "builtin");
      if (builtins.length > 0) {
        throw new UnsupportedFeatureError(
          `gemini: cannot force builtin tools ${JSON.stringify(builtins)} — functionCallingConfig addresses function declarations only; googleSearch/codeExecution have no tool_choice form (OpenAI Responses and Anthropic carry builtin forcing)`,
          { provider: this.provider },
        );
      }
      cfg["allowedFunctionNames"] = [...tc.allowed];
      if (mode === "auto") cfg["mode"] = "VALIDATED";
    }
    return { functionCallingConfig: cfg };
  }

  protected static cacheResource(cacheId: string): string {
    return cacheId.startsWith("cachedContents/") ? cacheId : `cachedContents/${cacheId}`;
  }

  payload(request: Request): JsonObject {
    const config = request.config ?? {};
    const extensions: JsonObject = { ...(config.extensions ?? {}) };
    const cache = config.cache;
    let resource: string | undefined;
    let suffixFrom = 0;
    if (cache && cache.mode !== "off") {
      if (cache.key !== undefined) {
        throw new UnsupportedFeatureError("gemini: cache.key is not supported — GenerateContent has no cache affinity key; use cache.resource with a stored cache (lm.cache(prefix))", {
          provider: this.provider,
        });
      }
      if (cache.retention !== undefined && cache.retention !== "short") {
        throw new UnsupportedFeatureError(
          "gemini: cache.retention is not supported in-request — lifetime belongs to the stored cache (cache_create(..., ttl_seconds=...) / cache_update)",
          { provider: this.provider },
        );
      }
      if (cache.resource !== undefined) {
        resource = cache.resource;
        if (cache.prefixUntilIndex !== undefined) suffixFrom = Math.min(cache.prefixUntilIndex, request.messages.length - 1) + 1;
      }
    }
    const wireMessages = request.messages.slice(suffixFrom);
    if (resource !== undefined && wireMessages.length === 0) throw new ValueError("gemini: a request against a stored cache needs at least one message after the prefix");

    const names = GeminiLM.callNames(request.messages);
    const payload: JsonObject = { contents: wireMessages.map((m) => this.message(m, names)) };
    if (resource !== undefined) payload["cachedContent"] = GeminiLM.cacheResource(resource);
    if (request.system && resource === undefined) {
      payload["systemInstruction"] = { parts: [{ text: typeof request.system === "string" ? request.system : partsToText(request.system) }] };
    }

    const gen: JsonObject = {};
    if (config.temperature !== undefined) gen["temperature"] = config.temperature; // proto3-JSON: integral doubles as integer digits
    if (config.maxTokens !== undefined) gen["maxOutputTokens"] = config.maxTokens;
    if (config.topP !== undefined) gen["topP"] = config.topP;
    if (config.topK !== undefined) gen["topK"] = config.topK;
    if (config.stop && config.stop.length > 0) gen["stopSequences"] = [...config.stop];
    if (config.logprobs !== undefined) {
      gen["responseLogprobs"] = true;
      if (config.logprobs > 0) gen["logprobs"] = config.logprobs;
    }
    if (config.responseFormat) Object.assign(gen, responseFormatToGeminiConfig(config.responseFormat));
    if (config.reasoning) {
      const reasoning = config.reasoning;
      const levelClass = geminiLevelClass(request.model);
      if (reasoning.effort === "off") {
        if (levelClass) {
          throw new UnsupportedFeatureError(
            `gemini: reasoning cannot be disabled on ${request.model} — the Gemini 3 class has no full off switch (thinkingBudget 0 is accepted but not honoured); use effort='low' or a 2.5 model`,
            { provider: this.provider },
          );
        }
        gen["thinkingConfig"] = { thinkingBudget: 0 };
      } else {
        if (reasoning.summary === "concise" || reasoning.summary === "detailed") {
          throw new UnsupportedFeatureError(`gemini: reasoning.summary=${JSON.stringify(reasoning.summary)} is an OpenAI detail level; GenerateContent has includeThoughts only (use 'auto')`, {
            provider: this.provider,
          });
        }
        const thinking: JsonObject = {};
        if (reasoning.summary !== undefined) thinking["includeThoughts"] = true;
        if (reasoning.thinkingBudget !== undefined) thinking["thinkingBudget"] = reasoning.thinkingBudget;
        else if (levelClass) {
          if (reasoning.effort === "xhigh" || reasoning.effort === "max") {
            throw new UnsupportedFeatureError(
              `gemini: reasoning.effort=${JSON.stringify(reasoning.effort)} has no thinkingLevel on the Gemini 3 class (minimal|low|medium|high); 'high' is the ceiling`,
              { provider: this.provider },
            );
          }
          thinking["thinkingLevel"] = reasoning.effort;
        } else thinking["thinkingBudget"] = EFFORT_THINKING_BUDGETS[reasoning.effort]!;
        gen["thinkingConfig"] = thinking;
      }
    }
    if (Object.keys(gen).length > 0) payload["generationConfig"] = gen;

    if (request.tools && request.tools.length > 0 && resource === undefined) {
      const declarations = request.tools
        .filter((t) => t.type === "function")
        .map((t) => ({ name: t.name, description: t.type === "function" ? (t.description ?? null) : null, parameters: t.type === "function" ? (t.parameters ?? { type: "object", properties: {} }) : {} }));
      const tools: JsonObject[] = [];
      if (declarations.length > 0) tools.push({ functionDeclarations: declarations });
      for (const tool of request.tools) if (tool.type === "builtin") tools.push(builtinToGemini(tool));
      payload["tools"] = tools;
    }
    const toolConfig = resource === undefined ? this.toolConfigPayload(request) : undefined;
    if (toolConfig !== undefined) payload["toolConfig"] = toolConfig;

    const output = extensions["output"];
    if (output === "image" || output === "audio") {
      const g = obj(payload["generationConfig"]);
      g["responseModalities"] = [output === "image" ? "IMAGE" : "AUDIO"];
      payload["generationConfig"] = g;
    }
    if (config.store !== undefined) payload["store"] = config.store;
    if (config.serviceTier !== undefined) payload["serviceTier"] = config.serviceTier;
    if (config.userId !== undefined) {
      throw new UnsupportedFeatureError("gemini: config.user_id is not supported — GenerateContent has no end-user attribution field (OpenAI and Anthropic carry it)", {
        provider: this.provider,
      });
    }
    for (const [k, v] of Object.entries(extensions)) if (k !== "prompt_caching" && k !== "output") payload[k] = v;
    return payload;
  }

  async buildRequest(request: Request, stream: boolean): Promise<TransportRequest> {
    const endpoint = stream ? "streamGenerateContent" : "generateContent";
    return this.emit({
      method: "POST",
      url: `${this.base()}/${this.modelPath(request.model)}:${endpoint}`,
      endpoint: "generateContent",
      stream,
      model: request.model,
      headers: this.headers({ "Content-Type": "application/json" }),
      params: stream ? { alt: "sse" } : undefined,
      payload: this.payload(request),
    });
  }

  // ─── Response ────────────────────────────────────────────────────

  protected parseCandidateParts(partsPayload: JsonValue[], unmapped: Unmapped | undefined, pathPrefix: string): Part[] {
    const parts: Part[] = [];
    partsPayload.forEach((part, partIndex) => {
      if (!isJsonObject(part)) {
        if (unmapped) recordUnmapped(unmapped, `${pathPrefix}[${partIndex}]`, typeName(part));
        return;
      }
      if (part["thought"] && "text" in part) {
        parts.push(normalizePart({ type: "thinking", text: str(part["text"]), continuation: thoughtSignatureState(part) }));
      } else if ("text" in part) {
        parts.push(normalizePart({ type: "text", text: str(part["text"]), continuation: thoughtSignatureState(part) }));
      } else if (isJsonObject(part["functionCall"])) {
        const fc = part["functionCall"];
        const signature = part["thoughtSignature"] ?? fc["thoughtSignature"];
        const continuation = signature !== null && signature !== undefined ? [{ provider: "gemini", kind: "thought_signature", data: { value: str(signature) } }] : [];
        if (!fc["name"]) throw unnamedToolCallError(this.provider, `${pathPrefix}[${partIndex}]`);
        parts.push(
          normalizePart({ type: "tool_call", id: str(fc["id"]) || `tool_call_${parts.length}`, name: str(fc["name"]), input: isJsonObject(fc["args"]) ? fc["args"] : {}, continuation }),
        );
      } else if (isJsonObject(part["inlineData"])) {
        const inline = part["inlineData"];
        const mime = str(inline["mimeType"]) || "application/octet-stream";
        const data = str(inline["data"]);
        if (!data) return;
        parts.push(normalizePart({ type: mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "document", mediaType: mime, data }));
      } else if (isJsonObject(part["fileData"])) {
        const fd = part["fileData"];
        const uri = str(fd["fileUri"]);
        const mime = str(fd["mimeType"]) || "application/octet-stream";
        if (!uri) return;
        parts.push(normalizePart({ type: mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "document", mediaType: mime, url: uri }));
      } else if (PROVIDER_EXECUTED_PART_KEYS.some((k) => k in part)) {
        // MAP-1
      } else if (unmapped) recordUnmapped(unmapped, `${pathPrefix}[${partIndex}]`, Object.keys(part).sort().join("+") || "<empty>");
    });
    return parts;
  }

  parseResponse(request: Request, response: HttpResponse): Response {
    const data = obj(response.json());
    const inband = this.inbandError(data);
    if (inband) throw inband;
    const candidate = obj(list(data["candidates"])[0]);
    const content = obj(candidate["content"]);
    const unmapped: Unmapped = [];
    const parts = this.parseCandidateParts(list(content["parts"]), unmapped, "candidates[0].content.parts");
    const fullText = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    parts.push(...geminiCitations(candidate, fullText));
    if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));
    const hasTool = parts.some((p) => p.type === "tool_call");
    const logprobs = geminiTokenLogprobs(candidate["logprobsResult"]);
    return new Response({
      id: data["responseId"] ? str(data["responseId"]) : undefined,
      model: request.model,
      message: { role: "assistant", parts },
      finishReason: finishReason(candidate["finishReason"], hasTool),
      usage: geminiUsage(data["usageMetadata"], ["candidatesTokenCount", "responseTokenCount"]),
      logprobs: logprobs.length > 0 ? logprobs : undefined,
      providerData: attachUnmapped(data, unmapped),
    });
  }

  // ─── Stream ──────────────────────────────────────────────────────

  parseStreamEvents(_request: Request, raw: SSEEvent): StreamEvent[] {
    if (!raw.data) return [];
    const payload = parseJson(raw.data);
    if (!isJsonObject(payload)) return [];
    if ("error" in payload) {
      const err = payload["error"];
      const code = isJsonObject(err) ? str(err["status"] || err["code"]) || "provider" : "provider";
      return [{ type: "error", error: this.errorDetail(code, isJsonObject(err) ? str(err["message"]) : "") }];
    }
    const inband = this.inbandError(payload);
    if (inband) {
      return [{ type: "error", error: ErrorDetail.create({ code: canonicalErrorCode(inband), providerCode: "inband_finish_reason", message: inband.message }) }];
    }
    const events: StreamEvent[] = [];
    const candidate = list(payload["candidates"])[0];
    let yieldedDelta = false;
    let sawTool = false;
    let finish: unknown;
    if (isJsonObject(candidate)) {
      const content = obj(candidate["content"]);
      let chunkLogprobs = geminiTokenLogprobs(candidate["logprobsResult"]);
      const continuation = (idx: number, value: unknown): StreamEvent => ({
        type: "delta",
        delta: { type: "continuation", provider: "gemini", kind: "thought_signature", data: { value: str(value) }, partIndex: idx },
      });
      list(content["parts"]).forEach((part, idx) => {
        if (!isJsonObject(part)) return;
        if (part["thought"] && "text" in part) {
          yieldedDelta = true;
          events.push({ type: "delta", delta: { type: "thinking", text: str(part["text"]), partIndex: idx } });
          if (part["thoughtSignature"] !== null && part["thoughtSignature"] !== undefined) events.push(continuation(idx, part["thoughtSignature"]));
        } else if ("text" in part) {
          yieldedDelta = true;
          events.push({ type: "delta", delta: { type: "text", text: str(part["text"]), partIndex: idx, ...(chunkLogprobs.length > 0 ? { logprobs: chunkLogprobs } : {}) } });
          chunkLogprobs = [];
          if (part["thoughtSignature"] !== null && part["thoughtSignature"] !== undefined) events.push(continuation(idx, part["thoughtSignature"]));
        } else if (isJsonObject(part["functionCall"])) {
          const fc = part["functionCall"];
          sawTool = true;
          yieldedDelta = true;
          const id = str(fc["id"]);
          const name = str(fc["name"]);
          events.push({ type: "delta", delta: { type: "tool_call", input: stringifyJson(fc["args"] ?? {}), partIndex: idx, ...(id ? { id } : {}), ...(name ? { name } : {}) } });
          const signature = part["thoughtSignature"] ?? fc["thoughtSignature"];
          if (signature !== null && signature !== undefined) events.push(continuation(idx, signature));
        } else if (isJsonObject(part["inlineData"])) {
          const inline = part["inlineData"];
          const mime = str(inline["mimeType"]) || "application/octet-stream";
          const data = str(inline["data"]);
          if (mime.startsWith("audio/")) {
            yieldedDelta = true;
            events.push({ type: "delta", delta: { type: "audio", data, partIndex: idx, mediaType: mime } });
          } else if (mime.startsWith("image/")) {
            yieldedDelta = true;
            events.push({ type: "delta", delta: { type: "image", data, partIndex: idx, mediaType: mime } });
          }
        }
      });
      finish = candidate["finishReason"];
    }
    const usage = () => geminiUsage(payload["usageMetadata"], ["candidatesTokenCount", "responseTokenCount"]);
    if (finish) events.push({ type: "end", finishReason: finishReason(finish, sawTool), usage: usage(), providerData: payload });
    else if (!yieldedDelta && "usageMetadata" in payload) events.push({ type: "end", finishReason: "stop", usage: usage(), providerData: payload });
    return events;
  }

  // ─── Live codec (Gemini Live) ────────────────────────────────────

  static isAudioNativeLiveModel(model: string): boolean {
    const l = model.toLowerCase();
    return l.includes("live-preview") || l.includes("native-audio");
  }

  async liveUrl(): Promise<string> {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const credential = await this.resolveCredential();
    if (!credential || credential.kind === "aws") throw new ProviderError("gemini: live needs an API key");
    u.search = new URLSearchParams({ key: credential.value }).toString();
    return u.toString();
  }

  liveSetupPayload(config: LiveConfig): JsonObject {
    const setup: JsonObject = { model: this.modelPath(config.model) };
    if (config.system) setup["systemInstruction"] = { parts: [{ text: typeof config.system === "string" ? config.system : partsToText(config.system) }] };
    const functionTools = (config.tools ?? [])
      .filter((t) => t.type === "function")
      .map((t) => ({ name: t.name, description: t.type === "function" ? (t.description ?? null) : null, parameters: t.type === "function" ? (t.parameters ?? { type: "object", properties: {} }) : {} }));
    if (functionTools.length > 0) setup["tools"] = [{ functionDeclarations: functionTools }];
    const gen: JsonObject = {};
    if (config.outputFormat !== undefined || GeminiLM.isAudioNativeLiveModel(config.model)) gen["responseModalities"] = ["AUDIO"];
    if (config.voice) gen["speechConfig"] = { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };
    if (Object.keys(gen).length > 0) setup["generationConfig"] = gen;
    if (config.extensions) Object.assign(setup, config.extensions);
    return { setup };
  }

  override liveSetupFrames(config: LiveConfig): JsonObject[] {
    const payload = this.liveSetupPayload(config);
    if (GeminiLM.isAudioNativeLiveModel(config.model)) (payload["setup"] as JsonObject)["outputAudioTranscription"] = {};
    return [payload];
  }

  override liveEncoder(config: LiveConfig): (event: LiveClientEvent) => JsonObject[] {
    const audioNative = GeminiLM.isAudioNativeLiveModel(config.model);
    return (event) => {
      if (audioNative && event.type === "text") return [{ realtimeInput: { text: event.text } }];
      return this.encodeLiveClientEvent(event);
    };
  }

  encodeLiveClientEvent(event: LiveClientEvent): JsonObject[] {
    switch (event.type) {
      case "turn":
        return [{ clientContent: { turns: [{ role: "user", parts: event.parts.map((p) => this.part(p)) }], turnComplete: event.turnComplete ?? true } }];
      case "audio":
        return [{ realtimeInput: { audio: { mimeType: event.mediaType ?? "audio/pcm;rate=16000", data: event.data } } }];
      case "image":
        return [{ realtimeInput: { video: { mimeType: event.mediaType ?? "image/jpeg", data: event.data } } }];
      case "interrupt":
        return [{ clientContent: { turnComplete: true } }];
      case "end_audio":
        return [{ realtimeInput: { audioStreamEnd: true } }];
      case "text":
        return [{ clientContent: { turns: [{ role: "user", parts: [{ text: event.text }] }], turnComplete: true } }];
      case "tool_result":
        return [{ toolResponse: { functionResponses: [{ id: event.id, response: { output: [{ text: partsToText(event.content) }] } }] } }];
    }
  }

  /** True = setupComplete, false = keep waiting; throws typed on error. */
  liveSetupStatus(raw: Uint8Array | string): boolean {
    let payload: unknown;
    try {
      payload = parseJson(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return false;
    }
    if (!isJsonObject(payload)) return false;
    if ("setupComplete" in payload) return true;
    if ("error" in payload) {
      const err = payload["error"];
      const msg = isJsonObject(err) ? str(err["message"]) : str(err);
      throw this.providerError(InvalidRequestError, `Live setup failed: ${msg}`, { providerCode: isJsonObject(err) ? str(err["status"]) || "live_setup" : "live_setup" });
    }
    return false;
  }

  protected liveUsage(payload: JsonObject, server: JsonObject | undefined): Usage {
    const usage = isJsonObject(payload["usageMetadata"]) ? payload["usageMetadata"] : server?.["usageMetadata"];
    return geminiUsage(usage, ["responseTokenCount", "candidatesTokenCount"]);
  }

  override decodeLiveServerEvent(raw: Uint8Array | string): LiveServerEvent[] {
    let payload: unknown;
    try {
      payload = parseJson(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return [];
    }
    if (!isJsonObject(payload)) return [];
    if ("error" in payload) {
      const err = payload["error"];
      const code = isJsonObject(err) ? str(err["status"] || err["code"]) || "provider" : "provider";
      return [{ type: "error", error: this.errorDetail(code, isJsonObject(err) ? str(err["message"]) : "") }];
    }
    const events: LiveServerEvent[] = [];
    const toolCall = payload["toolCall"];
    if (isJsonObject(toolCall)) {
      for (const fc of list(toolCall["functionCalls"])) {
        if (isJsonObject(fc)) events.push({ type: "tool_call", id: str(fc["id"]) || "fc_0", name: str(fc["name"]) || "tool", input: isJsonObject(fc["args"]) ? fc["args"] : {} });
      }
    }
    const server = payload["serverContent"];
    if (!isJsonObject(server)) return events;
    const modelTurn = server["modelTurn"];
    if (isJsonObject(modelTurn)) {
      for (const part of list(modelTurn["parts"])) {
        if (!isJsonObject(part)) continue;
        if ("text" in part) events.push({ type: "text", text: str(part["text"]) });
        else if (isJsonObject(part["inlineData"])) {
          const inline = part["inlineData"];
          const mime = str(inline["mimeType"]);
          if (mime.startsWith("audio/")) events.push({ type: "audio", data: str(inline["data"]), ...(mime ? { mediaType: mime } : {}) });
        } else if (isJsonObject(part["functionCall"])) {
          const fc = part["functionCall"];
          events.push({ type: "tool_call", id: str(fc["id"]) || "fc_0", name: str(fc["name"]) || "tool", input: isJsonObject(fc["args"]) ? fc["args"] : {} });
        }
      }
    }
    const outTx = server["outputTranscription"];
    if (isJsonObject(outTx) && outTx["text"]) events.push({ type: "text", text: str(outTx["text"]) });
    const hasUsage = isJsonObject(payload["usageMetadata"]) || isJsonObject(server["usageMetadata"]);
    if (hasUsage && !server["turnComplete"]) events.push({ type: "usage", usage: this.liveUsage(payload, server) });
    if (server["interrupted"]) events.push({ type: "interrupted" });
    if (server["turnComplete"]) events.push({ type: "turn_end", usage: this.liveUsage(payload, server) });
    return events;
  }

  // ─── Models ──────────────────────────────────────────────────────

  override modelsRequest(): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/models`, params: { pageSize: 1000 }, headers: this.headers() });
  }
  override modelsFromBody(body: string): ModelInfo[] {
    return modelInfosFromEntries(obj(parseJson(body))["models"], {
      provider: this.provider,
      apiFamily: "gemini_generate_content",
      idOf: (e) => {
        const name = e["name"];
        return typeof name === "string" && name.startsWith("models/") ? name.slice("models/".length) : name;
      },
    });
  }

  // ─── Files ───────────────────────────────────────────────────────

  /** `files/<id>` resource path from a canonical id (URI or name). */
  static fileResource(fileId: string): string {
    if (fileId.includes("://")) {
      const idx = fileId.replace(/\/+$/, "").lastIndexOf("/files/");
      if (idx >= 0) {
        const tail = fileId.replace(/\/+$/, "").slice(idx + "/files/".length);
        if (tail) return `files/${tail}`;
      }
    }
    return fileId.startsWith("files/") ? fileId : `files/${fileId}`;
  }

  override fileUploadRequest(request: FileUploadRequest): Promise<TransportRequest> {
    const url = buildUrl(`${this.uploadBaseUrl.replace(/\/+$/, "")}/files`, request.extensions as Record<string, string> | undefined);
    const bytes = request.bytes ?? (request.path ? readFileBytes(request.path) : new Uint8Array(0));
    const [contentType, body] = multipartRelatedBody({ file: { display_name: request.filename } }, request.mediaType ?? "application/octet-stream", bytes);
    return this.emit({ method: "POST", url, headers: this.headers({ "X-Goog-Upload-Protocol": "multipart", "Content-Type": contentType }), body });
  }

  override fileInfoFromBody(body: string): FileInfo {
    const data = obj(parseJson(body));
    return this.fileInfo(isJsonObject(data["file"]) ? data["file"] : data);
  }

  protected fileInfo(data: JsonObject): FileInfo {
    const uri = data["uri"];
    const name = data["name"];
    const id = typeof uri === "string" && uri ? uri : name;
    if (typeof id !== "string" || !id) throw new ProviderError("gemini: file object carries no uri or name", { provider: this.provider });
    const state = str(data["state"]);
    const readiness = state.endsWith("PROCESSING") ? "pending" : state.endsWith("FAILED") ? "failed" : "ready";
    const downloadable = typeof data["downloadUri"] === "string" && data["downloadUri"] ? true : data["source"] === "UPLOADED" ? false : undefined;
    const sizeRaw = data["sizeBytes"];
    const sizeNum = typeof sizeRaw === "string" ? Number(sizeRaw) : int(sizeRaw);
    return FileInfo.create({
      id,
      filename: typeof data["displayName"] === "string" && data["displayName"] ? data["displayName"] : undefined,
      mediaType: typeof data["mimeType"] === "string" && data["mimeType"] ? data["mimeType"] : undefined,
      sizeBytes: sizeNum !== undefined && Number.isInteger(sizeNum) ? sizeNum : undefined,
      createdAt: isoUtc(data["createTime"]),
      expiresAt: isoUtc(data["expirationTime"]),
      readiness,
      downloadable,
      providerData: data,
    });
  }

  override fileGetRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/${pathId(GeminiLM.fileResource(fileId), { resourceName: true })}`, headers: this.headers() });
  }
  override fileListRequest(limit: number, cursor?: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/files`, params: { pageSize: limit, ...(cursor !== undefined ? { pageToken: cursor } : {}) }, headers: this.headers() });
  }
  override filePageFromListBody(body: string): FilePage {
    const data = obj(parseJson(body));
    const items = list(data["files"]).filter(isJsonObject).map((e) => this.fileInfo(e));
    const cursor = data["nextPageToken"];
    return FilePage.create({ items, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined });
  }
  override fileDeleteRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "DELETE", url: `${this.base()}/${pathId(GeminiLM.fileResource(fileId), { resourceName: true })}`, headers: this.headers() });
  }
  override fileDownloadRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/${pathId(GeminiLM.fileResource(fileId), { resourceName: true })}:download?alt=media`, headers: this.headers() });
  }

  // ─── Caches (cachedContents) ─────────────────────────────────────

  override cacheCreateRequest(prefix: Request, ttlSeconds?: number, label?: string): Promise<TransportRequest> {
    const names = GeminiLM.callNames(prefix.messages);
    const body: JsonObject = { model: this.modelPath(prefix.model), contents: prefix.messages.map((m) => this.message(m, names)) };
    if (prefix.system) body["systemInstruction"] = { parts: [{ text: typeof prefix.system === "string" ? prefix.system : partsToText(prefix.system) }] };
    if (prefix.tools && prefix.tools.length > 0) {
      const declarations = prefix.tools
        .filter((t) => t.type === "function")
        .map((t) => ({ name: t.name, description: t.type === "function" ? (t.description ?? null) : null, parameters: t.type === "function" ? (t.parameters ?? { type: "object", properties: {} }) : {} }));
      const tools: JsonObject[] = [];
      if (declarations.length > 0) tools.push({ functionDeclarations: declarations });
      for (const t of prefix.tools) if (t.type === "builtin") tools.push(builtinToGemini(t));
      body["tools"] = tools;
    }
    if (ttlSeconds !== undefined) body["ttl"] = `${ttlSeconds}s`;
    if (label !== undefined) body["displayName"] = label;
    return this.emit({ method: "POST", url: `${this.base()}/cachedContents`, headers: this.headers({ "Content-Type": "application/json" }), payload: body });
  }

  protected cacheInfo(data: JsonObject): CacheInfo {
    const name = data["name"];
    if (typeof name !== "string" || !name) throw new ProviderError("gemini: cache object carries no name", { provider: this.provider });
    let model = str(data["model"]);
    if (model.startsWith("models/")) model = model.slice("models/".length);
    if (!model) throw new ProviderError("gemini: cache object carries no model", { provider: this.provider });
    const tokensRaw = obj(data["usageMetadata"])["totalTokenCount"];
    const tokens = typeof tokensRaw === "string" ? (/^\d+$/.test(tokensRaw) ? Number(tokensRaw) : undefined) : int(tokensRaw);
    return CacheInfo.create({
      id: name,
      model,
      tokens,
      createdAt: isoUtc(data["createTime"]),
      expiresAt: isoUtc(data["expireTime"]),
      label: typeof data["displayName"] === "string" && data["displayName"] ? data["displayName"] : undefined,
      providerData: data,
    });
  }
  override cacheInfoFromBody(body: string): CacheInfo {
    return this.cacheInfo(obj(parseJson(body)));
  }
  override cacheGetRequest(cacheId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/${pathId(GeminiLM.cacheResource(cacheId), { resourceName: true })}`, headers: this.headers() });
  }
  override cacheListRequest(limit: number, cursor?: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/cachedContents`, params: { pageSize: limit, ...(cursor !== undefined ? { pageToken: cursor } : {}) }, headers: this.headers() });
  }
  override cachePageFromListBody(body: string): CachePage {
    const data = obj(parseJson(body));
    const items = list(data["cachedContents"]).filter(isJsonObject).map((e) => this.cacheInfo(e));
    const cursor = data["nextPageToken"];
    return CachePage.create({ items, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined });
  }
  override cacheDeleteRequest(cacheId: string): Promise<TransportRequest> {
    return this.emit({ method: "DELETE", url: `${this.base()}/${pathId(GeminiLM.cacheResource(cacheId), { resourceName: true })}`, headers: this.headers() });
  }
  override cacheUpdateRequest(cacheId: string, ttlSeconds: number): Promise<TransportRequest> {
    return this.emit({
      method: "PATCH",
      url: `${this.base()}/${pathId(GeminiLM.cacheResource(cacheId), { resourceName: true })}`,
      headers: this.headers({ "Content-Type": "application/json" }),
      payload: { ttl: `${ttlSeconds}s` },
    });
  }

  // ─── Batches (Batch Mode, inline) ────────────────────────────────

  override batchSubmitRequest(request: BatchRequest): Promise<TransportRequest> {
    const model = request.model ?? request.requests[0]!.model;
    const batch: JsonObject = {
      inputConfig: { requests: { requests: request.requests.map((nested, i) => ({ request: this.payload(nested), metadata: { key: String(i) } })) } },
    };
    if (request.label !== undefined) batch["displayName"] = request.label;
    const payload: JsonObject = { batch, ...(request.extensions ?? {}) };
    return this.emit({ method: "POST", url: `${this.base()}/${this.modelPath(model)}:batchGenerateContent`, headers: this.headers({ "Content-Type": "application/json" }), payload });
  }

  protected batchJobInfo(data: JsonObject): BatchJobInfo {
    const name = data["name"];
    if (typeof name !== "string" || !name) throw new ProviderError("gemini: batch operation carries no name", { provider: this.provider });
    const metadata = obj(data["metadata"]);
    return BatchJobInfo.create({
      id: name,
      status: geminiBatchStatus(data),
      label: typeof metadata["displayName"] === "string" && metadata["displayName"] ? metadata["displayName"] : undefined,
      createdAt: isoUtc(metadata["createTime"]),
      providerData: data,
    });
  }
  override batchJobFromBody(body: string): BatchJobInfo {
    return this.batchJobInfo(obj(parseJson(body)));
  }
  override batchStatusRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/${pathId(batchId, { resourceName: true })}`, headers: this.headers() });
  }
  override batchCancelRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "POST", url: `${this.base()}/${pathId(batchId, { resourceName: true })}:cancel`, headers: this.headers({ "Content-Type": "application/json" }), payload: {} });
  }
  override async batchResultFetches(): Promise<TransportRequest[]> {
    return []; // inline submissions carry their results in the operation body
  }
  override batchEntries(statusBody: JsonObject): BatchEntry[] {
    const responseObj = obj(statusBody["response"]);
    let inlined: unknown = responseObj["inlinedResponses"];
    if (isJsonObject(inlined)) inlined = inlined["inlinedResponses"];
    const entries: BatchEntry[] = [];
    list(inlined).forEach((item, position) => {
      if (!isJsonObject(item)) return;
      const key = Number(str(obj(item["metadata"])["key"]));
      const index = Number.isInteger(key) ? key : position;
      if (isJsonObject(item["response"])) {
        const bodyObj = item["response"];
        const response = this.parseResponse(batchEntryRequest(bodyObj["modelVersion"]), batchEntryHttp(bodyObj));
        entries.push(BatchEntry.create({ index, outcome: "succeeded", response }));
      } else {
        const err = obj(item["error"]);
        const code = err["status"] ?? err["code"];
        entries.push(
          BatchEntry.create({
            index,
            outcome: "errored",
            error: ErrorDetail.create({ code: "provider", message: str(err["message"]) || "batch entry errored", providerCode: code !== null && code !== undefined ? str(code) : undefined }),
          }),
        );
      }
    });
    return entries.sort((a, b) => a.index - b.index);
  }
  override batchListRequest(limit: number): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/batches`, params: { pageSize: limit }, headers: this.headers() });
  }
  override batchJobsFromListBody(body: string): BatchJobInfo[] {
    return list(obj(parseJson(body))["operations"]).filter(isJsonObject).map((d) => this.batchJobInfo(d));
  }

  // ─── Video (Veo) ─────────────────────────────────────────────────

  override videoSubmitRequest(request: VideoGenerationRequest): Promise<TransportRequest> {
    if (request.images && request.images.length > 0) {
      throw new UnsupportedFeatureError("gemini: video input images are not mapped yet; use extensions until the mapping is live-receipted", { provider: this.provider });
    }
    const payload: JsonObject = { instances: [{ prompt: request.prompt }], ...(request.extensions ?? {}) };
    if (request.seconds !== undefined && payload["parameters"] === undefined) payload["parameters"] = { durationSeconds: request.seconds };
    return this.emit({ method: "POST", url: `${this.base()}/${this.modelPath(request.model)}:predictLongRunning`, headers: this.headers({ "Content-Type": "application/json" }), payload });
  }

  protected videoJobInfo(data: JsonObject): VideoJobInfo {
    const name = data["name"];
    if (typeof name !== "string" || !name) throw new ProviderError("gemini: video operation carries no name", { provider: this.provider });
    const status = data["done"] === true ? (isJsonObject(data["error"]) ? "failed" : "completed") : "running";
    return VideoJobInfo.create({ id: name, status, providerData: data });
  }
  override videoJobFromBody(body: string): VideoJobInfo {
    return this.videoJobInfo(obj(parseJson(body)));
  }
  override videoStatusRequest(videoId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/${pathId(videoId, { resourceName: true })}`, headers: this.headers() });
  }
  protected videoResultUri(statusBody: JsonObject): string {
    const gvr = obj(obj(statusBody["response"])["generateVideoResponse"]);
    const samples = list(gvr["generatedSamples"]);
    const uri = isJsonObject(samples[0]) ? obj((samples[0] as JsonObject)["video"])["uri"] : undefined;
    if (typeof uri === "string" && uri) return uri;
    throw new ProviderError("gemini: terminal video operation carries no video uri", { provider: this.provider });
  }
  override async videoResultFetch(statusBody: JsonObject): Promise<TransportRequest | undefined> {
    return this.emit({ method: "GET", url: this.videoResultUri(statusBody), headers: this.headers() });
  }
  override videoPart(_statusBody: JsonObject, fetched?: HttpResponse): VideoPart {
    if (!fetched) throw new ProviderError("gemini: video content fetch is required", { provider: this.provider });
    const contentType = (fetched.header("content-type") ?? "").split(";", 1)[0]!.trim();
    if (!contentType) throw new ProviderError("gemini: video download carries no content-type", { provider: this.provider });
    return normalizePart({ type: "video", mediaType: contentType, data: encodeBase64(fetched.body) }) as VideoPart;
  }
  override videoListRequest(limit: number, model?: string): Promise<TransportRequest> {
    if (!model) throw new UnsupportedFeatureError("gemini: video jobs list per model — pass model= (operations live under models/<model>/operations)", { provider: this.provider });
    return this.emit({ method: "GET", url: `${this.base()}/${this.modelPath(model)}/operations`, params: { pageSize: limit }, headers: this.headers() });
  }
  override videoJobsFromListBody(body: string): VideoJobInfo[] {
    return list(obj(parseJson(body))["operations"]).filter(isJsonObject).map((d) => this.videoJobInfo(d));
  }

  // ─── Generation (through generateContent) ────────────────────────

  protected imageGenerationLmRequest(request: ImageGenerationRequest): Request {
    const extensions: JsonObject = { ...(request.extensions ?? {}) };
    if (request.size !== undefined) {
      const gen = { ...obj(extensions["generationConfig"]) };
      const imageConfig = { ...obj(gen["imageConfig"]) };
      if (imageConfig["aspectRatio"] === undefined) imageConfig["aspectRatio"] = request.size;
      gen["imageConfig"] = imageConfig;
      extensions["generationConfig"] = gen;
    }
    return Request.create({
      model: request.model,
      messages: [{ role: "user", parts: [{ type: "text", text: request.prompt }, ...(request.images ?? [])] }],
      config: Object.keys(extensions).length > 0 ? { extensions } : {},
    });
  }
  override imageGenerateRequest(request: ImageGenerationRequest): Promise<TransportRequest> {
    return this.buildRequest(this.imageGenerationLmRequest(request), false);
  }
  override imageGenerationFromResponse(request: ImageGenerationRequest, resp: HttpResponse): ImageGenerationResponse {
    const chat = this.parseResponse(this.imageGenerationLmRequest(request), resp);
    const images = Message.partsOf(chat.message, "image");
    if (images.length === 0) throw new ProviderError("gemini: model returned no image parts", { provider: this.provider });
    const texts = Message.partsOf(chat.message, "text").map((p) => p.text).filter(Boolean);
    return ImageGenerationResponse.create({ images, text: texts.join("") || undefined, id: chat.id, model: chat.model, usage: chat.usage, providerData: chat.providerData });
  }

  protected speechGenerationLmRequest(request: SpeechGenerationRequest): Request {
    if (request.format !== undefined) throw new UnsupportedFeatureError("gemini: speech format cannot be chosen; the wire always returns PCM", { provider: this.provider });
    const gen: JsonObject = { responseModalities: ["AUDIO"] };
    if (request.voice !== undefined) gen["speechConfig"] = { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice } } };
    return Request.create({ model: request.model, messages: [Message.user(request.prompt)], config: { extensions: { generationConfig: gen, ...(request.extensions ?? {}) } } });
  }
  override speechGenerateRequest(request: SpeechGenerationRequest): Promise<TransportRequest> {
    return this.buildRequest(this.speechGenerationLmRequest(request), false);
  }
  override speechGenerationFromResponse(request: SpeechGenerationRequest, resp: HttpResponse): SpeechGenerationResponse {
    const chat = this.parseResponse(this.speechGenerationLmRequest(request), resp);
    const audio = Message.first(chat.message, "audio");
    if (!audio) throw new ProviderError("gemini: model returned no audio part", { provider: this.provider });
    return SpeechGenerationResponse.create({ audio, id: chat.id, model: chat.model, usage: chat.usage, providerData: chat.providerData });
  }
}

function builtinToGemini(tool: BuiltinTool): JsonObject {
  return { [GEMINI_BUILTIN_MAP[tool.name] ?? tool.name]: tool.config ?? {} };
}
