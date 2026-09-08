/**
 * OpenAI Responses dialect (`OpenAILM`), bound to an access policy: the
 * public API (`OPENAI_API`), the ChatGPT Codex backend (`OPENAI_CODEX`),
 * Azure OpenAI v1, Meta, Moonshot's Responses wire.
 */

import { ProviderLM, batchEntryHttp, type LMOptions } from "../adapter.ts";
import { OPENAI_API, OPENAI_CODEX, authHeader, type AccessPolicy } from "../auth/policy.ts";
import { extractChatgptAccountId } from "../auth/stores.ts";
import {
  OPENAI_RESPONSES_PRESET_BASE_URLS,
  mergeOpenAIResponsesCompat,
  openaiResponsesPreset,
  presetKey,
  resolveOpenAIResponsesCompat,
  type OpenAIResponsesCompat,
  type ResolvedOpenAIResponsesCompat,
} from "../compat.ts";
import {
  AuthError,
  BillingError,
  ContextLengthError,
  NotConfiguredError,
  ProviderError,
  RateLimitError,
  ServerError,
  UnsupportedFeatureError,
  UnsupportedModelError,
  canonicalErrorCode,
  mapHttpError,
} from "../errors.ts";
import { float, isJsonObject, parseJson, stringifyJson, type JsonObject, type RawNumber } from "../json.ts";
import { materializeResponseAsync, type SSEEvent } from "../stream.ts";
import { Message } from "../types/parts.ts";
import type { BuiltinTool, Request } from "../types/config.ts";
import { Request as RequestNs } from "../types/config.ts";
import {
  BatchEntry,
  BatchJobInfo,
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
import type { LiveClientEvent, LiveConfig, LiveServerEvent, AudioFormat } from "../types/live.ts";
import { LiveServerEvent as LiveServerEventNs } from "../types/live.ts";
import type { ModelInfo } from "../types/model_info.ts";
import { continuationData, normalizePart, type CitationPart, type Part, type VideoPart } from "../types/parts.ts";
import { ErrorDetail, Response, Usage, type TokenLogprob } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import type { CitationDelta } from "../types/stream.ts";
import { encodeBase64 } from "../types/validate.ts";
import {
  HttpResponse,
  isoUtc,
  mediaBase64,
  modelInfosFromEntries,
  multipartFormBody,
  openaiFileReadiness,
  openaiTokenLogprobs,
  parseJsonObjectLenient,
  partsToText,
  pathId,
  toolResultErrorText,
  unnamedToolCallError,
  readFileBytes,
  type TransportRequest,
} from "../wire.ts";
import { decodeBase64 } from "../types/validate.ts";
import {
  CODEX_BACKEND,
  MODEL_ERROR_CODES,
  MODEL_LIST_HINT,
  RESPONSE_ERROR_CODE_MAP,
  attachUnmapped,
  breakpointUnsupported,
  cacheBreakpointIndex,
  cacheCommonPayload,
  cacheStablePrefix,
  errorDetail,
  int,
  isModelError,
  list,
  obj,
  openaiBatchStatus,
  partToOpenAIInput,
  recordUnmapped,
  responseFormatToOpenAIText,
  str,
  toolResultOutputOpenAI,
  typeName,
  usageFromResponses,
  type Unmapped,
} from "./openai_shared.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const OPENAI_BUILTIN_MAP: Readonly<Record<string, string>> = Object.freeze({
  web_search: "web_search_preview",
  code_execution: "code_interpreter",
  file_search: "file_search",
  computer_use: "computer_use_preview",
});
const BUILTIN_MAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({ openai: OPENAI_BUILTIN_MAP, verbatim: {} });

const PROVIDER_EXECUTED_ITEMS = new Set(["web_search_call", "file_search_call", "code_interpreter_call", "computer_call", "computer_use_call"]);

const VIDEO_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({
  queued: "queued",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
});

function builtinType(tool: BuiltinTool, compat: ResolvedOpenAIResponsesCompat): string {
  return BUILTIN_MAPS[compat.builtinTools]?.[tool.name] ?? tool.name;
}

function finishFromStatus(data: JsonObject, hasToolCall: boolean): "stop" | "length" | "tool_call" | "content_filter" {
  if (hasToolCall) return "tool_call";
  const status = str(data["status"]).toLowerCase();
  const incomplete = obj(data["incomplete_details"]);
  const reason = str(incomplete["reason"]).toLowerCase();
  if (status === "incomplete" && reason.includes("token")) return "length";
  if (reason.includes("content_filter") || reason.includes("safety")) return "content_filter";
  return "stop";
}

function strOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return str(value);
}

function annotationText(annotation: JsonObject, sourceText: string | undefined): string | undefined {
  for (const key of ["text", "snippet", "cited_text", "quote"]) {
    const t = strOrUndefined(annotation[key]);
    if (t !== undefined) return t;
  }
  const start = int(annotation["start_index"]);
  const end = int(annotation["end_index"]);
  if (sourceText !== undefined && start !== undefined && end !== undefined && 0 <= start && start < end && end <= sourceText.length) {
    return sourceText.slice(start, end);
  }
  return undefined;
}

function citationFromAnnotation(annotation: JsonObject, sourceText: string | undefined): CitationPart | undefined {
  const url = strOrUndefined(annotation["url"] ?? annotation["uri"]);
  const title = strOrUndefined(annotation["title"] ?? annotation["filename"] ?? annotation["file_id"]);
  const text = annotationText(annotation, sourceText);
  if (url === undefined && title === undefined && text === undefined) return undefined;
  return normalizePart({ type: "citation", url, title, text }) as CitationPart;
}

function citationDeltaFromAnnotation(annotation: JsonObject, partIndex: number): CitationDelta | undefined {
  const c = citationFromAnnotation(annotation, undefined);
  if (!c) return undefined;
  return { type: "citation", text: c.text, url: c.url, title: c.title, partIndex } as CitationDelta;
}

export interface OpenAILMOptions extends LMOptions {
  /** An `OpenAIResponsesCompat`, a preset name (`openai`, `meta`, `openrouter`, …), or absent. */
  readonly compat?: OpenAIResponsesCompat | string;
}

/** Codex backend facts: streaming-only, `store: false`, no max-token knob. */
export class OpenAILM extends ProviderLM {
  static override readonly manifest: AccessPolicy = OPENAI_API;
  protected readonly dialectBaseUrl = DEFAULT_BASE_URL;
  protected readonly compatBase: OpenAIResponsesCompat | undefined;

  constructor(opts: OpenAILMOptions = {}) {
    super(OPENAI_API, DEFAULT_BASE_URL, opts);
    const compat = opts.compat ?? this.registryCompat();
    if (typeof compat === "string") {
      this.compatBase = openaiResponsesPreset(compat);
      if (this.baseUrl === DEFAULT_BASE_URL) this.baseUrl = OPENAI_RESPONSES_PRESET_BASE_URLS[presetKey(compat)] ?? DEFAULT_BASE_URL;
    } else this.compatBase = compat;
    if (this.access.backend === CODEX_BACKEND) {
      if (!this.accountId && typeof this.credential === "string") this.accountId = extractChatgptAccountId(this.credential);
      if (!this.accountId) {
        throw new NotConfiguredError("No ChatGPT account id found in the Codex OAuth token.", {
          provider: this.provider,
          credentialHint: this.access.loginHint ?? null,
        });
      }
    }
  }

  protected get codex(): boolean {
    return this.access.backend === CODEX_BACKEND;
  }

  protected headers(contentType = "application/json"): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (this.codex && this.accountId) headers["chatgpt-account-id"] = this.accountId;
    for (const [k, v] of this.access.headers) headers[k] = v;
    return headers;
  }

  // ─── Errors ──────────────────────────────────────────────────────

  protected responseError(code: string, message: string): ProviderError {
    const cls = RESPONSE_ERROR_CODE_MAP[code] ?? ServerError;
    return this.providerError(cls, message || code || "provider error", { providerCode: code || null });
  }

  override normalizeError(status: number, body: string): ProviderError {
    if (this.codex) {
      const detail = this.normalizeDetailError(status, body);
      if (detail) return detail;
    }
    let msg: string;
    let providerCode: string | null = null;
    try {
      const data = parseJson(body);
      const err = isJsonObject(data) ? data["error"] : undefined;
      const e = isJsonObject(err) ? err : {};
      msg = isJsonObject(err) ? str(e["message"]) : err === undefined ? "" : str(err);
      const code = isJsonObject(err) ? str(e["code"]) : "";
      const errType = isJsonObject(err) ? str(e["type"]) : "";
      providerCode = code || errType || null;
      if (code === "context_length_exceeded") return this.providerError(ContextLengthError, msg, { status, providerCode });
      if (MODEL_ERROR_CODES.has(code) || (status === 404 && isModelError(msg, code, errType))) {
        return this.providerError(UnsupportedModelError, msg, { status, providerCode });
      }
      if (code === "insufficient_quota" || code === "1113" || errType === "insufficient_quota" || errType === "exceeded_current_quota_error") {
        return this.providerError(BillingError, msg, { status, providerCode });
      }
      if (code === "invalid_api_key" || errType === "authentication_error") return this.providerError(AuthError, msg, { status, providerCode });
      if (code === "rate_limit_exceeded" || errType === "rate_limit_error") return this.providerError(RateLimitError, msg, { status, providerCode });
      if (code && !msg.includes(code)) msg = `${msg} (${code})`;
    } catch {
      msg = body.trim().slice(0, 500) || `HTTP ${status}`;
      providerCode = null;
    }
    return this.withLoginHint(mapHttpError(status, msg, { provider: this.provider, envKeys: this.access.envKeys, providerCode }));
  }

  private normalizeDetailError(status: number, body: string): ProviderError | undefined {
    let data: unknown;
    try {
      data = parseJson(body);
    } catch {
      return undefined;
    }
    if (!isJsonObject(data)) return undefined;
    const detail = data["detail"];
    if (typeof detail !== "string" || !detail.trim()) return undefined;
    const text = detail.trim();
    if (isModelError(text)) return this.providerError(UnsupportedModelError, `${text}\n${MODEL_LIST_HINT}`, { status });
    return this.withLoginHint(mapHttpError(status, text, { provider: this.provider }));
  }

  // ─── Request ─────────────────────────────────────────────────────

  protected compat(request: Request): ResolvedOpenAIResponsesCompat {
    let partial = this.compatBase ?? defaultCompatForBaseUrl(this.baseUrl);
    partial = mergeOpenAIResponsesCompat(partial, compatFromExtensions(request.config?.extensions));
    return resolveOpenAIResponsesCompat(partial);
  }

  protected buildInput(messages: readonly Message[], compat: ResolvedOpenAIResponsesCompat, breakpointIndex: number | undefined): JsonObject[] {
    const items: JsonObject[] = [];
    messages.forEach((msg, msgIndex) => {
      if (msgIndex === breakpointIndex && (msg.role === "assistant" || msg.role === "tool")) throw breakpointUnsupported(this.provider, msgIndex, msg.role);
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type !== "tool_result") continue;
          const item: JsonObject = { type: "function_call_output", call_id: part.id, output: toolResultOutputOpenAI(this.provider, part, compat.toolResultMedia) };
          if (compat.toolResultName === "include" && part.name) item["name"] = part.name;
          items.push(item);
        }
        return;
      }
      let contentParts: JsonObject[] = [];
      if (msg.role === "assistant") {
        for (const part of msg.parts) {
          if (part.type === "text") contentParts.push({ type: "output_text", text: part.text });
          else if (part.type === "refusal") contentParts.push({ type: "refusal", refusal: part.text });
          else if (part.type === "thinking") {
            const state = continuationData(part, "openai", "reasoning_item");
            if (state) {
              const item: JsonObject = { type: "reasoning" };
              if (state["id"] !== undefined) item["id"] = state["id"];
              if (state["encrypted_content"] !== undefined) item["encrypted_content"] = state["encrypted_content"];
              item["summary"] = part.text ? [{ type: "summary_text", text: part.text }] : [];
              items.push(item);
            } else if (part.text) contentParts.push({ type: "output_text", text: part.text });
          }
        }
      } else {
        contentParts = msg.parts.filter((p) => p.type !== "tool_call" && p.type !== "tool_result").map((p) => partToOpenAIInput(p, this.provider));
      }
      if (msgIndex === breakpointIndex) {
        const last = contentParts[contentParts.length - 1];
        if (!last || last["type"] !== "input_text") throw breakpointUnsupported(this.provider, msgIndex, msg.role);
        last["prompt_cache_breakpoint"] = { mode: "explicit" };
      }
      if (contentParts.length > 0) {
        const role = msg.role === "developer" ? compat.developerRole : msg.role;
        const item: JsonObject = { role, content: contentParts };
        if (compat.commentaryPhase === "tag" && msg.role === "assistant" && msg.parts.some((p) => p.type === "tool_call")) item["phase"] = "commentary";
        items.push(item);
      }
      for (const part of msg.parts) {
        if (part.type === "tool_call") {
          items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: stringifyJson(part.input) });
        }
      }
    });
    return items;
  }

  protected toolChoicePayload(request: Request, compat: ResolvedOpenAIResponsesCompat): unknown {
    const tc = request.config?.toolChoice;
    if (!tc) return undefined;
    const mode = tc.mode ?? "auto";
    if (mode === "none") return "none";
    if (tc.allowed && tc.allowed.length > 0) {
      const byName = new Map((request.tools ?? []).map((t) => [t.name, t]));
      const entries = tc.allowed.map((n) => byName.get(n)!);
      if (entries.length === 1 && mode === "required") {
        const tool = entries[0]!;
        return tool.type === "builtin" ? { type: builtinType(tool, compat) } : { type: "function", name: tool.name };
      }
      return {
        type: "allowed_tools",
        mode,
        tools: entries.map((t) => (t.type === "builtin" ? { type: builtinType(t, compat) } : { type: "function", name: t.name })),
      };
    }
    return mode === "required" ? "required" : "auto";
  }

  payload(request: Request, stream: boolean): JsonObject {
    const compat = this.compat(request);
    const config = request.config ?? {};
    const input = this.buildInput(request.messages, compat, cacheBreakpointIndex(request, compat.cacheControl));
    const payload: JsonObject = { model: request.model, input, stream };
    if (request.system) {
      const systemText = typeof request.system === "string" ? request.system : partsToText(request.system);
      if (cacheStablePrefix(request, compat.cacheControl)) {
        input.unshift({ role: compat.developerRole, content: [{ type: "input_text", text: systemText, prompt_cache_breakpoint: { mode: "explicit" } }] });
      } else payload["instructions"] = systemText;
    }
    if (config.maxTokens !== undefined) payload[compat.maxOutputTokensField] = config.maxTokens;
    if (config.temperature !== undefined) payload["temperature"] = wireFloat(config.temperature);
    if (config.topP !== undefined) payload["top_p"] = wireFloat(config.topP);
    if (config.stop && config.stop.length > 0) {
      throw new UnsupportedFeatureError(
        `${this.provider}: config.stop has no field on the Responses wire (the Chat Completions dialect carries \`stop\`); a silent omission would run the model past the sequence`,
        { provider: this.provider },
      );
    }
    if (config.topK !== undefined) {
      throw new UnsupportedFeatureError(`${this.provider}: config.top_k has no field on the Responses wire (Anthropic and Gemini carry it)`, { provider: this.provider });
    }
    if (config.logprobs !== undefined) {
      payload["top_logprobs"] = config.logprobs;
      payload["include"] = ["message.output_text.logprobs"];
    }
    if (request.tools && request.tools.length > 0) {
      payload["tools"] = request.tools.map((tool) => {
        if (tool.type === "function") {
          const t: JsonObject = { type: "function", name: tool.name, description: tool.description ?? null, parameters: tool.parameters ?? { type: "object", properties: {} } };
          if (compat.strictTools === "include") t["strict"] = false;
          return t;
        }
        const out: JsonObject = { type: builtinType(tool, compat) };
        if (tool.config) Object.assign(out, tool.config);
        return out;
      });
    }
    const toolChoice = this.toolChoicePayload(request, compat);
    if (toolChoice !== undefined) payload["tool_choice"] = toolChoice as JsonObject;
    if (config.toolChoice?.parallel !== undefined) payload["parallel_tool_calls"] = config.toolChoice.parallel;
    if (config.responseFormat) payload["text"] = responseFormatToOpenAIText(config.responseFormat);
    if (config.reasoning) {
      const reasoning = config.reasoning;
      if (reasoning.effort !== "off") {
        if (reasoning.thinkingBudget !== undefined) {
          throw new UnsupportedFeatureError(
            `${this.provider}: reasoning.thinking_budget is not supported — this wire has no thinking token budget; use effort (Anthropic's manual class and Gemini take a budget)`,
            { provider: this.provider },
          );
        }
        if ((reasoning.summary === "concise" || reasoning.summary === "detailed") && compat.reasoningFormat !== "responses_reasoning") {
          throw new UnsupportedFeatureError(
            `${this.provider}: reasoning.summary=${JSON.stringify(reasoning.summary)} is an OpenAI Responses detail level; this wire has no summary levels (use 'auto')`,
            { provider: this.provider },
          );
        }
        const effort = reasoning.effort;
        switch (compat.reasoningFormat) {
          case "responses_reasoning": {
            const r: JsonObject = { effort };
            if (reasoning.summary !== undefined) r["summary"] = reasoning.summary;
            payload["reasoning"] = r;
            break;
          }
          case "reasoning_effort":
            payload["reasoning_effort"] = effort;
            break;
          case "openrouter":
            payload["reasoning"] = { effort };
            break;
          case "deepseek":
            payload["thinking"] = { type: "enabled" };
            payload["reasoning_effort"] = effort;
            break;
          case "qwen":
          case "zai":
            payload["enable_thinking"] = true;
            break;
          case "qwen_chat_template":
            payload["chat_template_kwargs"] = { enable_thinking: true, preserve_thinking: true };
            break;
          case "none":
            break;
        }
      } else {
        switch (compat.reasoningFormat) {
          case "responses_reasoning":
            payload["reasoning"] = { effort: "none" };
            break;
          case "reasoning_effort":
            payload["reasoning_effort"] = "none";
            break;
          case "openrouter":
            payload["reasoning"] = { enabled: false };
            break;
          case "deepseek":
            payload["thinking"] = { type: "disabled" };
            break;
          case "qwen":
          case "zai":
            payload["enable_thinking"] = false;
            break;
          case "qwen_chat_template":
            payload["chat_template_kwargs"] = { enable_thinking: false };
            break;
          case "none":
            break;
        }
      }
    }
    cacheCommonPayload(request, payload, compat.cacheControl, this.provider);
    if (compat.routing !== undefined) payload["provider"] = compat.routing;
    if (config.serviceTier !== undefined) payload["service_tier"] = config.serviceTier;
    if (config.userId !== undefined) payload["safety_identifier"] = config.userId;
    if (config.store !== undefined) payload["store"] = config.store;
    if (config.extensions) {
      const reserved = new Set(["prompt_caching", "cache", "compat", "openai_compat", "openai_responses_compat"]);
      for (const [k, v] of Object.entries(config.extensions)) if (!reserved.has(k)) payload[k] = v;
    }
    if (this.codex) {
      if (this.access.systemPrefix && payload["instructions"] === undefined) payload["instructions"] = this.access.systemPrefix;
      payload["store"] = false;
      payload["stream"] = true;
      delete payload["max_output_tokens"];
      delete payload["max_completion_tokens"];
      delete payload["max_tokens"];
    }
    return payload;
  }

  async buildRequest(request: Request, stream: boolean): Promise<TransportRequest> {
    return this.emit({
      method: "POST",
      url: `${this.base()}/responses`,
      endpoint: "responses",
      stream,
      model: request.model,
      headers: this.headers(),
      payload: this.payload(request, stream),
    });
  }

  // ─── Response ────────────────────────────────────────────────────

  parseResponse(request: Request, response: HttpResponse): Response {
    const data = obj(response.json());
    const respError = data["error"];
    if (isJsonObject(respError)) throw this.responseError(str(respError["code"]), str(respError["message"]) || stringifyJson(respError));

    const parts: Part[] = [];
    const unmapped: Unmapped = [];
    const logprobSeq: TokenLogprob[] = [];
    list(data["output"]).forEach((item, itemIndex) => {
      if (!isJsonObject(item)) {
        recordUnmapped(unmapped, `output[${itemIndex}]`, typeName(item));
        return;
      }
      const itemType = item["type"];
      if (itemType === "message") {
        list(item["content"]).forEach((content, contentIndex) => {
          if (!isJsonObject(content)) {
            recordUnmapped(unmapped, `output[${itemIndex}].content[${contentIndex}]`, typeName(content));
            return;
          }
          const ctype = content["type"];
          if (ctype === "output_text" || ctype === "text") {
            const text = str(content["text"]);
            parts.push(normalizePart({ type: "text", text }));
            logprobSeq.push(...openaiTokenLogprobs(content["logprobs"]));
            for (const annotation of list(content["annotations"])) {
              if (!isJsonObject(annotation)) continue;
              const c = citationFromAnnotation(annotation, text);
              if (c) parts.push(c);
            }
          } else if (ctype === "refusal") {
            const text = str(content["refusal"] ?? content["text"]);
            parts.push(text ? normalizePart({ type: "refusal", text }) : normalizePart({ type: "text", text: "" }));
          } else if (ctype === "output_image") {
            const b64 = str(content["b64_json"] ?? content["image_base64"]);
            if (b64) parts.push(normalizePart({ type: "image", mediaType: "image/png", data: b64 }));
          } else if (ctype === "output_audio") {
            const audio = obj(content["audio"]);
            const b64 = str(audio["data"] ?? content["b64_json"]);
            if (b64) parts.push(normalizePart({ type: "audio", mediaType: "audio/wav", data: b64 }));
          } else recordUnmapped(unmapped, `output[${itemIndex}].content[${contentIndex}]`, ctype);
        });
      } else if (itemType === "function_call") {
        if (!item["name"]) throw unnamedToolCallError(this.provider, `output[${itemIndex}]`);
        parts.push(
          normalizePart({
            type: "tool_call",
            id: str(item["call_id"] ?? item["id"]) || `call_${parts.length}`,
            name: str(item["name"]),
            input: parseJsonObjectLenient(item["arguments"]),
          }),
        );
      } else if (itemType === "reasoning") {
        const summary = item["summary"];
        const text = Array.isArray(summary) ? summary.map((x) => (isJsonObject(x) ? str(x["text"]) : str(x))).join("\n") : str(summary ?? item["text"]);
        const state: JsonObject = {};
        if (item["id"]) state["id"] = str(item["id"]);
        if (item["encrypted_content"]) state["encrypted_content"] = str(item["encrypted_content"]);
        const continuation = Object.keys(state).length > 0 ? [{ provider: "openai", kind: "reasoning_item", data: state }] : [];
        if (text || continuation.length > 0) parts.push(normalizePart({ type: "thinking", text, continuation }));
      } else if (typeof itemType === "string" && PROVIDER_EXECUTED_ITEMS.has(itemType)) {
        // MAP-1: provider-executed tool activity is not a part
      } else recordUnmapped(unmapped, `output[${itemIndex}]`, itemType);
    });
    if (parts.length === 0) parts.push(normalizePart({ type: "text", text: str(data["output_text"]) }));

    const hasTool = parts.some((p) => p.type === "tool_call");
    return new Response({
      id: data["id"] ? str(data["id"]) : undefined,
      model: str(data["model"]) || request.model,
      message: { role: "assistant", parts },
      finishReason: finishFromStatus(data, hasTool),
      usage: usageFromResponses(data["usage"]),
      logprobs: logprobSeq.length > 0 ? logprobSeq : undefined,
      providerData: attachUnmapped(data, unmapped),
    });
  }

  // ─── Stream ──────────────────────────────────────────────────────

  parseStreamEvents(request: Request, raw: SSEEvent): StreamEvent[] {
    if (!raw.data) return [];
    if (raw.data === "[DONE]") return [{ type: "end" }];
    const payload = parseJson(raw.data);
    if (!isJsonObject(payload)) return [];
    const et = str(payload["type"]);
    const outputIndex = int(payload["output_index"]) ?? 0;

    if (et === "response.output_item.added" || et === "response.output_item.done") {
      const item = obj(payload["item"]);
      if (item["type"] === "reasoning") {
        if (et === "response.output_item.added") return [{ type: "delta", delta: { type: "thinking", text: "", partIndex: outputIndex } }];
        const state: JsonObject = {};
        for (const key of ["id", "encrypted_content"]) if (item[key]) state[key] = item[key]!;
        if (Object.keys(state).length === 0) return [];
        return [{ type: "delta", delta: { type: "continuation", provider: "openai", kind: "reasoning_item", data: state, partIndex: outputIndex } }];
      }
    }
    switch (et) {
      case "response.created": {
        const response = obj(payload["response"]);
        const id = response["id"] ? str(response["id"]) : undefined;
        return [{ type: "start", ...(id ? { id } : {}), model: str(response["model"]) || request.model }];
      }
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const logprobs = openaiTokenLogprobs(payload["logprobs"]);
        return [{ type: "delta", delta: { type: "text", text: str(payload["delta"]), partIndex: outputIndex, ...(logprobs.length > 0 ? { logprobs } : {}) } }];
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return [{ type: "delta", delta: { type: "thinking", text: str(payload["delta"]), partIndex: outputIndex } }];
      case "response.output_text.annotation.added": {
        const annotation = payload["annotation"];
        if (!isJsonObject(annotation)) return [];
        const d = citationDeltaFromAnnotation(annotation, outputIndex);
        return d ? [{ type: "delta", delta: d }] : [];
      }
      case "response.output_audio.delta":
        return [{ type: "delta", delta: { type: "audio", data: str(payload["delta"]), partIndex: outputIndex, mediaType: "audio/wav" } }];
      case "response.output_image.delta":
      case "response.image.delta":
        return [{ type: "delta", delta: { type: "image", data: str(payload["delta"]), partIndex: outputIndex, mediaType: "image/png" } }];
      case "response.output_item.added": {
        const item = obj(payload["item"]);
        if (item["type"] !== "function_call") return [];
        const id = str(item["call_id"] ?? item["id"]);
        const name = str(item["name"]);
        return [{ type: "delta", delta: { type: "tool_call", input: str(item["arguments"]), partIndex: outputIndex, ...(id ? { id } : {}), ...(name ? { name } : {}) } }];
      }
      case "response.function_call_arguments.delta": {
        const id = str(payload["call_id"] ?? payload["id"]);
        const name = str(payload["name"]);
        return [{ type: "delta", delta: { type: "tool_call", input: str(payload["delta"]), partIndex: outputIndex, ...(id ? { id } : {}), ...(name ? { name } : {}) } }];
      }
      case "response.completed": {
        const response = obj(payload["response"]);
        const hasTool = list(response["output"]).some((i) => isJsonObject(i) && i["type"] === "function_call");
        return [{ type: "end", finishReason: hasTool ? "tool_call" : "stop", usage: usageFromResponses(response["usage"]), providerData: response }];
      }
      case "response.error":
      case "error":
        return [{ type: "error", error: this.streamErrorDetail(payload) }];
      default:
        return [];
    }
  }

  protected streamErrorDetail(payload: JsonObject): ErrorDetail {
    const err = payload["error"];
    if (isJsonObject(err)) return errorDetail(str(err["code"] ?? err["type"] ?? payload["code"]) || "provider", str(err["message"] ?? payload["message"]));
    return errorDetail(str(payload["code"] ?? payload["error_type"]) || "provider", str(payload["message"]));
  }

  override async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    if (this.codex) return materializeResponseAsync(this.stream(request, opts), request);
    return super.complete(request, opts);
  }

  // ─── Live codec (OpenAI Realtime, GA) ────────────────────────────

  liveUrl(model: string): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    const basePath = u.pathname.replace(/\/+$/, "");
    u.pathname = basePath ? `${basePath}/realtime` : "/realtime";
    u.search = new URLSearchParams({ model }).toString();
    return u.toString();
  }

  async liveHeaders(): Promise<Record<string, string>> {
    const value = await this.resolveCredential();
    const headers: Record<string, string> = Object.fromEntries(this.access.headers);
    if (value) {
      const pair = authHeader(this.access, value, this.apiKeyHeader);
      if (pair) headers[pair[0]] = pair[1];
    }
    return headers;
  }

  private static liveAudioFormat(fmt: AudioFormat): JsonObject {
    if (fmt.encoding === "pcm16") return { type: "audio/pcm", rate: fmt.sampleRate };
    return { type: `audio/${fmt.encoding}` };
  }

  liveSessionUpdatePayload(config: LiveConfig): JsonObject {
    const session: JsonObject = { type: "realtime" };
    if (config.system) session["instructions"] = typeof config.system === "string" ? config.system : partsToText(config.system);
    const audio: JsonObject = {};
    if (config.outputFormat !== undefined || config.voice) {
      session["output_modalities"] = ["audio"];
      const output: JsonObject = {};
      if (config.outputFormat !== undefined) output["format"] = OpenAILM.liveAudioFormat(config.outputFormat);
      if (config.voice) output["voice"] = config.voice;
      audio["output"] = output;
    } else session["output_modalities"] = ["text"];
    if (config.inputFormat !== undefined) audio["input"] = { format: OpenAILM.liveAudioFormat(config.inputFormat), turn_detection: null };
    if (Object.keys(audio).length > 0) session["audio"] = audio;
    if (config.tools && config.tools.length > 0) {
      session["tools"] = config.tools
        .filter((t) => t.type === "function")
        .map((t) => ({ type: "function", name: t.name, description: t.type === "function" ? (t.description ?? null) : null, parameters: t.type === "function" ? (t.parameters ?? { type: "object", properties: {} }) : {} }));
    }
    if (config.extensions) Object.assign(session, config.extensions);
    return { type: "session.update", session };
  }

  override liveSetupFrames(config: LiveConfig): JsonObject[] {
    return [this.liveSessionUpdatePayload(config)];
  }

  override liveEncoder(_config: LiveConfig): (event: LiveClientEvent) => JsonObject[] {
    return (event) => this.encodeLiveClientEvent(event);
  }

  encodeLiveClientEvent(event: LiveClientEvent): JsonObject[] {
    const userMessage = (content: JsonObject[]): JsonObject => ({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
    switch (event.type) {
      case "audio":
        return [{ type: "input_audio_buffer.append", audio: event.data }];
      case "end_audio":
        return [{ type: "input_audio_buffer.commit" }, { type: "response.create" }];
      case "interrupt":
        return [{ type: "response.cancel" }];
      case "text":
        return [userMessage([{ type: "input_text", text: event.text }]), { type: "response.create" }];
      case "turn": {
        const frame = userMessage(event.parts.map((p) => partToOpenAIInput(p)));
        return event.turnComplete === false ? [frame] : [frame, { type: "response.create" }];
      }
      case "image":
        return [userMessage([{ type: "input_image", image_url: `data:${event.mediaType ?? "image/jpeg"};base64,${event.data}` }]), { type: "response.create" }];
      case "tool_result": {
        const output = partsToText(event.content, { provider: this.provider, where: "a Realtime function_call_output" });
        return [{ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.id, output } }, { type: "response.create" }];
      }
    }
  }

  override decodeLiveServerEvent(raw: Uint8Array | string): LiveServerEvent[] {
    let payload: unknown;
    try {
      payload = parseJson(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return [];
    }
    if (!isJsonObject(payload)) return [];
    const et = str(payload["type"]);
    const events: LiveServerEvent[] = [];
    if (["response.output_text.delta", "response.text.delta", "response.output_audio_transcript.delta", "response.audio_transcript.delta"].includes(et)) {
      const delta = str(payload["delta"] ?? payload["text"]);
      if (delta) events.push({ type: "text", text: delta });
    } else if (et === "response.output_audio.delta") {
      const delta = str(payload["delta"]);
      if (delta) events.push(LiveServerEventNs.create({ type: "audio", data: delta }));
    } else if (et === "response.function_call_arguments.delta") {
      const delta = str(payload["delta"]);
      if (delta) {
        const id = str(payload["call_id"] ?? payload["id"]);
        const name = str(payload["name"]);
        events.push(LiveServerEventNs.create({ type: "tool_call_delta", inputDelta: delta, id: id || undefined, name: name || undefined }));
      }
    } else if (et === "response.output_item.done") {
      const item = obj(payload["item"]);
      if (item["type"] === "function_call") {
        const callId = str(item["call_id"] ?? item["id"]);
        if (callId) events.push(LiveServerEventNs.create({ type: "tool_call", id: callId, name: str(item["name"]) || "tool", input: parseJsonObjectLenient(item["arguments"]) }));
      }
    } else if (et === "response.done" || et === "response.completed") {
      const response = obj(payload["response"]);
      const output = list(response["output"]);
      const usage = isJsonObject(response["usage"]) ? usageFromResponses(response["usage"]) : undefined;
      if (str(response["status"]) === "cancelled") {
        if (usage) events.push({ type: "usage", usage });
        events.push({ type: "interrupted" });
      } else if (output.some((i) => isJsonObject(i) && i["type"] === "function_call")) {
        if (usage) events.push({ type: "usage", usage });
      } else events.push({ type: "turn_end", usage: usage ?? Usage.empty });
    } else if (et === "response.cancelled" || et === "response.canceled") {
      events.push({ type: "interrupted" });
    } else if (et === "error" || et === "response.error") {
      const detail = this.streamErrorDetail(payload);
      if (detail.providerCode === "response_cancel_not_active") return events;
      events.push({ type: "error", error: detail });
    }
    return events;
  }

  // ─── Models ──────────────────────────────────────────────────────

  override modelsRequest(): Promise<TransportRequest> {
    const params = this.codex ? { client_version: this.access.backendOptions["client_version"] ?? "" } : undefined;
    return this.emit({ method: "GET", url: `${this.base()}/models`, params, headers: this.headers() });
  }

  override modelsFromBody(body: string): ModelInfo[] {
    const data = obj(parseJson(body));
    if (this.codex) return modelInfosFromEntries(data["models"], { provider: this.provider, apiFamily: "openai_responses", idOf: (e) => e["slug"] });
    return modelInfosFromEntries(data["data"], { provider: this.provider, apiFamily: "openai_responses", idOf: (e) => e["id"] });
  }

  // ─── Files ───────────────────────────────────────────────────────

  override fileUploadRequest(request: FileUploadRequest): Promise<TransportRequest> {
    const extensions: JsonObject = { ...(request.extensions ?? {}) };
    const purpose = str(extensions["purpose"] ?? "user_data");
    delete extensions["purpose"];
    const fields: Array<[string, string]> = [["purpose", purpose], ...Object.entries(extensions).map(([k, v]): [string, string] => [k, str(v)])];
    const [contentType, body] = multipartFormBody(fields, [
      { field: "file", filename: request.filename, contentType: request.mediaType ?? "application/octet-stream", data: fileBytes(request) },
    ]);
    return this.emit({ method: "POST", url: `${this.base()}/files`, headers: this.headers(contentType), body });
  }

  protected fileInfo(data: JsonObject): FileInfo {
    const id = data["id"];
    if (typeof id !== "string" || !id) throw new ProviderError("openai: file object carries no id", { provider: this.provider });
    return FileInfo.create({
      id,
      filename: typeof data["filename"] === "string" && data["filename"] ? data["filename"] : undefined,
      sizeBytes: int(data["bytes"]),
      createdAt: isoUtc(data["created_at"]),
      expiresAt: isoUtc(data["expires_at"]),
      readiness: openaiFileReadiness(data["status"]),
      providerData: data,
    });
  }

  override fileInfoFromBody(body: string): FileInfo {
    return this.fileInfo(obj(parseJson(body)));
  }
  override fileGetRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/files/${pathId(fileId)}`, headers: this.headers() });
  }
  override fileListRequest(limit: number, cursor?: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/files`, params: { limit, ...(cursor !== undefined ? { after: cursor } : {}) }, headers: this.headers() });
  }
  override filePageFromListBody(body: string): FilePage {
    const data = obj(parseJson(body));
    const items = list(data["data"]).filter(isJsonObject).map((e) => this.fileInfo(e));
    const cursor = data["has_more"] && items.length > 0 ? data["last_id"] : undefined;
    return FilePage.create({ items, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined });
  }
  override fileDeleteRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "DELETE", url: `${this.base()}/files/${pathId(fileId)}`, headers: this.headers() });
  }
  override fileDownloadRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/files/${pathId(fileId)}/content`, headers: this.headers() });
  }

  // ─── Batches ─────────────────────────────────────────────────────

  override async batchUploadRequest(request: BatchRequest): Promise<TransportRequest | undefined> {
    const lines = request.requests.map((nested, i) =>
      stringifyJson({ custom_id: String(i), method: "POST", url: "/v1/responses", body: this.payload(nested, false) }),
    );
    const data = new TextEncoder().encode(lines.join("\n") + "\n");
    const [contentType, body] = multipartFormBody([["purpose", "batch"]], [{ field: "file", filename: "lm15-batch.jsonl", contentType: "application/jsonl", data }]);
    return this.emit({ method: "POST", url: `${this.base()}/files`, headers: this.headers(contentType), body });
  }

  override batchSubmitRequest(request: BatchRequest, uploadBody?: JsonObject): Promise<TransportRequest> {
    const inputFileId = uploadBody?.["id"];
    if (typeof inputFileId !== "string" || !inputFileId) throw new ProviderError("openai: batch input file upload returned no id", { provider: this.provider });
    const extensions: JsonObject = { ...(request.extensions ?? {}) };
    const payload: JsonObject = {
      input_file_id: inputFileId,
      endpoint: extensions["endpoint"] ?? "/v1/responses",
      completion_window: extensions["completion_window"] ?? "24h",
    };
    delete extensions["endpoint"];
    delete extensions["completion_window"];
    if (request.label !== undefined) payload["metadata"] = { label: request.label };
    Object.assign(payload, extensions);
    return this.emit({ method: "POST", url: `${this.base()}/batches`, headers: this.headers(), payload });
  }

  protected batchJobInfo(data: JsonObject): BatchJobInfo {
    const id = data["id"];
    if (typeof id !== "string" || !id) throw new ProviderError("openai: batch object carries no id", { provider: this.provider });
    const metadata = obj(data["metadata"]);
    const label = metadata["label"];
    return BatchJobInfo.create({
      id,
      status: openaiBatchStatus(str(data["status"])),
      label: typeof label === "string" && label ? label : undefined,
      createdAt: isoUtc(data["created_at"]),
      providerData: data,
    });
  }

  override batchJobFromBody(body: string): BatchJobInfo {
    return this.batchJobInfo(obj(parseJson(body)));
  }
  override batchStatusRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/batches/${pathId(batchId)}`, headers: this.headers() });
  }
  override batchCancelRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "POST", url: `${this.base()}/batches/${pathId(batchId)}/cancel`, headers: this.headers() });
  }
  override async batchResultFetches(statusBody: JsonObject): Promise<TransportRequest[]> {
    const out: TransportRequest[] = [];
    for (const key of ["output_file_id", "error_file_id"]) {
      const fileId = statusBody[key];
      if (typeof fileId === "string" && fileId) out.push(await this.emit({ method: "GET", url: `${this.base()}/files/${pathId(fileId)}/content`, headers: this.headers() }));
    }
    return out;
  }

  override batchEntries(statusBody: JsonObject, fetched: readonly string[]): BatchEntry[] {
    const jobStatus = openaiBatchStatus(str(statusBody["status"]));
    const found = new Map<number, BatchEntry>();
    for (const text of fetched) {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const item = obj(parseJson(line));
        const index = Number(str(item["custom_id"]));
        const responseObj = obj(item["response"]);
        const statusCode = int(responseObj["status_code"]) ?? 0;
        const bodyObj = obj(responseObj["body"]);
        if (statusCode === 200 && Object.keys(bodyObj).length > 0) {
          const response = this.parseResponse(batchEntryRequest(bodyObj["model"]), batchEntryHttp(bodyObj));
          found.set(index, BatchEntry.create({ index, outcome: "succeeded", response }));
        } else {
          const errSource = Object.keys(bodyObj).length > 0 ? bodyObj : obj(item["error"]);
          const err = this.normalizeError(statusCode || 400, stringifyJson(errSource));
          found.set(
            index,
            BatchEntry.create({
              index,
              outcome: "errored",
              error: ErrorDetail.create({ code: canonicalErrorCode(err), message: err.message || "batch entry errored", providerCode: err.providerCode ?? undefined }),
            }),
          );
        }
      }
    }
    const counts = obj(statusBody["request_counts"]);
    const total = int(counts["total"]) || (found.size > 0 ? Math.max(...found.keys()) + 1 : 0);
    const fill = jobStatus === "expired" ? "expired" : jobStatus === "cancelled" ? "cancelled" : "errored";
    const entries: BatchEntry[] = [];
    for (let index = 0; index < total; index++) {
      const hit = found.get(index);
      if (hit) entries.push(hit);
      else if (fill === "errored") {
        entries.push(BatchEntry.create({ index, outcome: "errored", error: ErrorDetail.create({ code: "provider", message: "entry missing from batch output files" }) }));
      } else entries.push(BatchEntry.create({ index, outcome: fill }));
    }
    return entries;
  }

  override batchListRequest(limit: number): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/batches`, params: { limit }, headers: this.headers() });
  }
  override batchJobsFromListBody(body: string): BatchJobInfo[] {
    return list(obj(parseJson(body))["data"]).filter(isJsonObject).map((d) => this.batchJobInfo(d));
  }

  // ─── Video (Sora) ────────────────────────────────────────────────

  override videoSubmitRequest(request: VideoGenerationRequest): Promise<TransportRequest> {
    if (request.images && request.images.length > 0) {
      throw new UnsupportedFeatureError("openai: video input images (input_reference) are not mapped yet; use the provider door until the mapping is live-receipted", {
        provider: this.provider,
      });
    }
    const payload: JsonObject = { model: request.model, prompt: request.prompt, ...(request.extensions ?? {}) };
    if (request.seconds !== undefined) payload["seconds"] = String(request.seconds);
    return this.emit({ method: "POST", url: `${this.base()}/videos`, headers: this.headers(), payload });
  }

  protected videoJobInfo(data: JsonObject): VideoJobInfo {
    const id = data["id"];
    if (typeof id !== "string" || !id) throw new ProviderError("openai: video object carries no id", { provider: this.provider });
    const wireStatus = str(data["status"]);
    const status = VIDEO_STATUS_MAP[wireStatus];
    if (!status) throw new ProviderError(`openai: unknown video status ${JSON.stringify(wireStatus)}`, { provider: this.provider });
    const progress = int(data["progress"]);
    return VideoJobInfo.create({
      id,
      status,
      progress,
      createdAt: isoUtc(data["created_at"]),
      model: typeof data["model"] === "string" ? data["model"] : undefined,
      providerData: data,
    });
  }

  override videoJobFromBody(body: string): VideoJobInfo {
    return this.videoJobInfo(obj(parseJson(body)));
  }
  override videoStatusRequest(videoId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/videos/${pathId(videoId)}`, headers: this.headers() });
  }
  override async videoResultFetch(statusBody: JsonObject): Promise<TransportRequest | undefined> {
    return this.emit({ method: "GET", url: `${this.base()}/videos/${pathId(str(statusBody["id"]))}/content`, headers: this.headers() });
  }
  override videoPart(_statusBody: JsonObject, fetched?: HttpResponse): VideoPart {
    if (!fetched) throw new ProviderError("openai: video content fetch is required", { provider: this.provider });
    const contentType = (fetched.header("content-type") ?? "").split(";", 1)[0]!.trim();
    if (!contentType) throw new ProviderError("openai: video content carries no content-type", { provider: this.provider });
    return normalizePart({ type: "video", mediaType: contentType, data: encodeBase64(fetched.body) }) as VideoPart;
  }
  override videoListRequest(limit: number): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/videos`, params: { limit }, headers: this.headers() });
  }
  override videoJobsFromListBody(body: string): VideoJobInfo[] {
    return list(obj(parseJson(body))["data"]).filter(isJsonObject).map((d) => this.videoJobInfo(d));
  }

  // ─── Generation ──────────────────────────────────────────────────

  override imageGenerateRequest(request: ImageGenerationRequest): Promise<TransportRequest> {
    const compat = resolveOpenAIResponsesCompat(this.compatBase ?? defaultCompatForBaseUrl(this.baseUrl));
    if (!request.images || request.images.length === 0) {
      const payload: JsonObject = { model: request.model, prompt: request.prompt };
      if (request.size !== undefined) payload["size"] = request.size;
      Object.assign(payload, request.extensions ?? {});
      return this.emit({ method: "POST", url: `${this.base()}/images/generations`, headers: this.headers(), payload });
    }
    for (const part of request.images) {
      if (part.data === undefined && part.path === undefined) {
        throw new UnsupportedFeatureError("openai: image edits take inline data or a local path; url/file_id-addressed input images have no wire slot", { provider: this.provider });
      }
    }
    const fields: Array<[string, string]> = [["model", request.model], ["prompt", request.prompt]];
    if (request.size !== undefined) fields.push(["size", request.size]);
    for (const [k, v] of Object.entries(request.extensions ?? {})) fields.push([k, str(v)]);
    const files = request.images.map((part, i) => ({
      field: compat.editImageField === "indexed" ? `image[${i}]` : "image[]",
      filename: `image-${i}`,
      contentType: part.mediaType ?? "image/png",
      data: decodeBase64("ImagePart", mediaBase64(part)),
    }));
    const [contentType, body] = multipartFormBody(fields, files);
    return this.emit({ method: "POST", url: `${this.base()}/images/edits`, headers: this.headers(contentType), body });
  }

  override imageGenerationFromResponse(_request: ImageGenerationRequest, resp: HttpResponse): ImageGenerationResponse {
    const data = obj(resp.json());
    const outputFormat = data["output_format"];
    const mediaType = typeof outputFormat === "string" && outputFormat ? `image/${outputFormat}` : undefined;
    const images = [];
    for (const item of list(data["data"])) {
      if (!isJsonObject(item)) continue;
      if (item["b64_json"]) images.push(normalizePart({ type: "image", mediaType: mediaType ?? "application/octet-stream", data: str(item["b64_json"]) }));
      else if (item["url"]) images.push(normalizePart({ type: "image", mediaType: mediaType ?? "application/octet-stream", url: str(item["url"]) }));
    }
    const u = obj(data["usage"]);
    return ImageGenerationResponse.create({
      images,
      usage: Usage.create({ inputTokens: u["input_tokens"], outputTokens: u["output_tokens"], totalTokens: u["total_tokens"] }),
      providerData: data,
    });
  }

  override speechGenerateRequest(request: SpeechGenerationRequest): Promise<TransportRequest> {
    const payload: JsonObject = { model: request.model, input: request.prompt, ...(request.extensions ?? {}) };
    if (request.voice !== undefined) payload["voice"] = request.voice;
    if (request.format !== undefined) payload["response_format"] = request.format;
    return this.emit({ method: "POST", url: `${this.base()}/audio/speech`, headers: this.headers(), payload });
  }

  override speechGenerationFromResponse(_request: SpeechGenerationRequest, resp: HttpResponse): SpeechGenerationResponse {
    const contentType = (resp.header("content-type") ?? "").split(";", 1)[0]!.trim();
    if (!contentType) throw new ProviderError("openai: speech response carries no content-type", { provider: this.provider });
    return SpeechGenerationResponse.create({
      audio: normalizePart({ type: "audio", mediaType: contentType, data: encodeBase64(resp.body) }),
      providerData: { content_type: contentType },
    });
  }
}

/** The ChatGPT Codex subscription binding: `OpenAILM` with `OPENAI_CODEX` bound. */
export class OpenAICodexLM extends OpenAILM {
  static override readonly manifest: AccessPolicy = OPENAI_CODEX;
  constructor(opts: OpenAILMOptions = {}) {
    super({ ...opts, access: opts.access ?? OPENAI_CODEX });
  }
}

/** Synthetic Request for parsing a batch entry body (results outlive the submitting process). */
export function batchEntryRequest(model: unknown): Request {
  const name = typeof model === "string" && model ? model : "batch";
  return RequestNs.create({ model: name, messages: [Message.user("-")] });
}

function fileBytes(request: FileUploadRequest): Uint8Array {
  if (request.bytes) return request.bytes;
  if (request.path) return readFileBytes(request.path);
  throw new ProviderError("FileUploadRequest has neither bytes nor path");
}

/** A typed float field on the wire (Number rule: `1.0`, never `1`). */
export function wireFloat(value: number): number | RawNumber {
  return float(value);
}

/** Request-level compat override read from `Config.extensions` (an escape hatch). */
function compatFromExtensions(extensions: JsonObject | undefined): OpenAIResponsesCompat | undefined {
  if (!extensions) return undefined;
  let raw = extensions["openai_responses_compat"] ?? extensions["openai_compat"];
  if (raw === undefined) {
    const compat = extensions["compat"];
    if (isJsonObject(compat)) raw = compat["openai_responses"] ?? compat["openai"];
  }
  if (!isJsonObject(raw)) return undefined;
  const map: Record<string, keyof OpenAIResponsesCompat> = {
    developer_role: "developerRole",
    max_output_tokens_field: "maxOutputTokensField",
    reasoning_format: "reasoningFormat",
    tool_result_name: "toolResultName",
    strict_tools: "strictTools",
    cache_control: "cacheControl",
    commentary_phase: "commentaryPhase",
    edit_image_field: "editImageField",
    builtin_tools: "builtinTools",
    tool_result_media: "toolResultMedia",
    routing: "routing",
    extensions: "extensions",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = map[k];
    if (key) out[key] = v;
  }
  return out as OpenAIResponsesCompat;
}

function defaultCompatForBaseUrl(baseUrl: string): OpenAIResponsesCompat {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("openrouter.ai")) return openaiResponsesPreset("openrouter");
  if (lower.includes("api.openai.com")) return openaiResponsesPreset("openai");
  if (lower.includes("api.meta.ai")) return openaiResponsesPreset("meta");
  return openaiResponsesPreset("openai");
}

