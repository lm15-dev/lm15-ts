/**
 * Anthropic Messages dialect (`AnthropicLM`), bound to an access policy:
 * the API-key door, the Claude Code login (`CLAUDE_CODE`), Azure Foundry,
 * AWS, Vertex, and the DeepSeek / Meta / Moonshot Anthropic-format wires.
 */

import { AdaptationScope, adapt, collecting, nearestEffort } from "../adaptation.ts";
import { ProviderLM, batchEntryHttp, type LMOptions, type EmitOptions } from "../adapter.ts";
import { anthropicSchema, noteUnmeasurableProbabilities, replaceTextWithData, requestJudgments } from "../judgments.ts";
import { ANTHROPIC_API, CLAUDE_CODE, DEFAULT_CLAUDE_CODE_VERSION, withHeaders, type AccessPolicy } from "../auth/policy.ts";
import {
  ANTHROPIC_PRESET_BASE_URLS,
  EFFORT_THINKING_BUDGETS,
  anthropicPreset,
  presetBaseUrl,
  resolveAnthropicCompat,
  type AnthropicCompat,
  type ResolvedAnthropicCompat,
} from "../compat.ts";
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
import { isJsonObject, parseJson, stringifyJson, type JsonObject } from "../json.ts";
import type { SSEEvent } from "../stream.ts";
import { Request, type BuiltinTool, type ResponseFormat } from "../types/config.ts";
import { BatchEntry, BatchJobInfo, FileInfo, FilePage, type BatchRequest, type FileUploadRequest } from "../types/endpoints.ts";
import type { ModelInfo } from "../types/model_info.ts";
import { continuationData, normalizePart, type CitationPart, type MediaPart, type Message, type Part } from "../types/parts.ts";
import { ErrorDetail, Response, Usage } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import type { FinishReason, ReasoningEffort } from "../vocab.ts";
import {
  HttpResponse,
  MEDIA_KINDS,
  checkToolResultMedia,
  isoUtc,
  dataPartText,
  mediaBase64,
  modelInfosFromEntries,
  multipartFormBody,
  partsToText,
  pathId,
  readFileBytes,
  unnamedToolCallError,
  type TransportRequest,
} from "../wire.ts";
import { batchEntryRequest, optionalWireFloat, wireFloat } from "./openai_responses.ts";
import { attachUnmapped, int, list, obj, recordUnmapped, str, typeName, type Unmapped } from "./openai_shared.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

const ANTHROPIC_BUILTIN_MAP: Readonly<Record<string, string>> = Object.freeze({ web_search: "web_search_20250305", code_execution: "code_execution_20250522" });
const PROVIDER_EXECUTED_BLOCKS = new Set(["server_tool_use", "web_search_tool_result", "code_execution_tool_result"]);
// Output ceilings by model class, for the `max_tokens` the Messages API
// requires and the caller did not set (MAP-13 `defaulted`, decision
// 2026-09-14 §4.8). Until then the default was 1024, which cut ordinary
// answers off with nothing said. The 3.x classes have documented lower
// ceilings and a value above them is a 400; everything else (4.x and later,
// and any name this table does not know) gets 16384 — loud and actionable
// if a model's ceiling is lower ("max_tokens: 16384 > N"), never a silent
// truncation. A table that rots; `Config.maxTokens` overrides.
const DEFAULT_MAX_TOKENS_BY_CLASS: ReadonlyArray<readonly [string, number]> = [
  ["claude-3-haiku", 4096],
  ["claude-3-opus", 4096],
  ["claude-3-sonnet", 4096],
  ["claude-3-5-", 8192],
  ["claude-3.5-", 8192],
];
const DEFAULT_MAX_TOKENS = 16384;

function defaultMaxTokens(model: string): number {
  const lowered = model.toLowerCase();
  for (const [marker, ceiling] of DEFAULT_MAX_TOKENS_BY_CLASS) if (lowered.includes(marker)) return ceiling;
  return DEFAULT_MAX_TOKENS;
}

const ERROR_TYPE_MAP: Readonly<Record<string, typeof ProviderError>> = Object.freeze({
  authentication_error: AuthError,
  permission_error: AuthError,
  billing_error: BillingError,
  rate_limit_error: RateLimitError,
  request_too_large: InvalidRequestError,
  not_found_error: InvalidRequestError,
  resource_not_found_error: InvalidRequestError,
  DeploymentNotFound: UnsupportedModelError,
  invalid_authentication_error: AuthError,
  invalid_request_error: InvalidRequestError,
  api_error: ServerError,
  overloaded_error: ServerError,
  timeout_error: TimeoutError,
});

const ADAPTIVE_CLASS_MARKERS = ["sonnet-5", "opus-5", "sonnet-4-6", "opus-4-6", "opus-4-7", "opus-4-8", "fable", "mythos", "haiku-5"];

/** MAP-7 rule 10: models that take `thinking: {type: adaptive}` + `output_config.effort`. A table that rots; the server 400s loudly. */
export function anthropicAdaptiveClass(model: string): boolean {
  const lowered = model.toLowerCase();
  return ADAPTIVE_CLASS_MARKERS.some((m) => lowered.includes(m));
}

function isContextLengthMessage(msg: string): boolean {
  const l = msg.toLowerCase();
  return (
    l.includes("prompt is too long") ||
    l.includes("too many tokens") ||
    l.includes("context window") ||
    l.includes("context length") ||
    (l.includes("token") && (l.includes("limit") || l.includes("exceed")))
  );
}

function isModelError(message: string): boolean {
  const l = message.toLowerCase();
  return l.includes("model") && ["not found", "does not exist", "not exist", "not supported", "unsupported", "not available", "unknown"].some((m) => l.includes(m));
}

function finishReason(stopReason: unknown, hasToolCall = false): FinishReason {
  if (hasToolCall) return "tool_call";
  const reason = str(stopReason).toLowerCase();
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use" || reason === "pause_turn") return "tool_call";
  if (reason === "refusal" || reason === "safety" || reason === "content_filter") return "content_filter";
  return "stop";
}

function reasoningTokens(usage: JsonObject): number | undefined {
  const details = usage["output_tokens_details"];
  if (isJsonObject(details) && details["thinking_tokens"] !== null && details["thinking_tokens"] !== undefined) return int(details["thinking_tokens"]);
  return undefined;
}

function usageFromAnthropic(u: JsonObject): Usage {
  return Usage.create({
    inputTokens: u["input_tokens"],
    outputTokens: u["output_tokens"],
    cacheReadTokens: u["cache_read_input_tokens"],
    cacheWriteTokens: u["cache_creation_input_tokens"],
    reasoningTokens: reasoningTokens(u),
  });
}

function anthropicBatchStatus(data: JsonObject): string {
  const status = str(data["processing_status"]).toLowerCase();
  if (status === "in_progress") return "running";
  if (status === "canceling") return "cancelling";
  if (status === "ended") {
    const counts = obj(data["request_counts"]);
    const n = (key: string) => int(counts[key]) ?? 0;
    if (n("canceled") && !(n("succeeded") || n("errored") || n("expired"))) return "cancelled";
    if (n("expired") && !(n("succeeded") || n("errored") || n("canceled"))) return "expired";
    return "completed";
  }
  return "queued";
}

function citationFromAnthropic(c: JsonObject): CitationPart | undefined {
  const url = c["url"] || c["uri"];
  const title = c["title"] || c["document_title"] || c["source_title"];
  const text = c["cited_text"] || c["text"] || c["quote"];
  const u = url ? str(url) : undefined;
  const t = title ? str(title) : undefined;
  const x = text ? str(text) : undefined;
  if (u === undefined && t === undefined && x === undefined) return undefined;
  return normalizePart({ type: "citation", url: u, title: t, text: x }) as CitationPart;
}

export function anthropicSource(part: MediaPart): JsonObject {
  if (part.url !== undefined) return { type: "url", url: part.url };
  if (part.fileId !== undefined) return { type: "file", file_id: part.fileId };
  if (part.data !== undefined || part.path !== undefined) return { type: "base64", media_type: part.mediaType ?? "application/octet-stream", data: mediaBase64(part) };
  throw new ProviderError(`${part.type} part has no usable source`);
}

function builtinToAnthropic(tool: BuiltinTool): JsonObject {
  const out: JsonObject = { type: ANTHROPIC_BUILTIN_MAP[tool.name] ?? tool.name, name: tool.name };
  if (tool.config) Object.assign(out, tool.config);
  return out;
}

function responseFormatToOutputConfig(format: ResponseFormat): JsonObject {
  if (format.type === "json_object") {
    throw new UnsupportedFeatureError(
      "anthropic: response_format json_object is not supported — the Messages API has no any-JSON mode; give a json_schema (objects need additionalProperties: false)",
      { provider: "anthropic", feature: "config.response_format" },
    );
  }
  return { format: { type: "json_schema", schema: format.schema } };
}

export interface AnthropicLMOptions extends LMOptions {
  readonly apiVersion?: string;
  /** An `AnthropicCompat`, a preset name (`deepseek`, `meta`, `moonshotai`), or absent. */
  readonly compat?: AnthropicCompat | string;
}

export class AnthropicLM extends ProviderLM {
  static override readonly manifest: AccessPolicy = ANTHROPIC_API;
  protected readonly dialectBaseUrl = DEFAULT_BASE_URL;
  readonly apiVersion: string;
  protected readonly resolvedCompat: ResolvedAnthropicCompat;

  constructor(opts: AnthropicLMOptions = {}, manifest: AccessPolicy = ANTHROPIC_API) {
    super(manifest, DEFAULT_BASE_URL, opts);
    this.apiVersion = opts.apiVersion ?? "2023-06-01";
    const compat = opts.compat ?? this.registryCompat();
    if (typeof compat === "string") {
      this.resolvedCompat = resolveAnthropicCompat(anthropicPreset(compat));
      if (this.baseUrl === DEFAULT_BASE_URL) this.baseUrl = presetBaseUrl(ANTHROPIC_PRESET_BASE_URLS, compat, "Messages", "anthropic");
    } else this.resolvedCompat = resolveAnthropicCompat(compat ?? {});
  }

  // ─── Errors ──────────────────────────────────────────────────────

  protected errorDetail(providerCode: string, message: string): ErrorDetail {
    let cls: typeof ProviderError = ERROR_TYPE_MAP[providerCode] ?? ProviderError;
    if (isContextLengthMessage(message)) cls = ContextLengthError;
    else if (providerCode === "not_found_error" && isModelError(message)) cls = UnsupportedModelError;
    return ErrorDetail.create({ code: canonicalErrorCode(cls), message: message || providerCode || "provider error", providerCode: providerCode || "provider" });
  }

  override normalizeError(status: number, body: string): ProviderError {
    let msg: string;
    let errType = "";
    let requestId = "";
    try {
      const data = parseJson(body);
      const inner = isJsonObject(data) ? data["error"] : undefined;
      const err = isJsonObject(inner) || typeof inner === "string" ? inner : isJsonObject(data) ? data : {};
      msg = isJsonObject(err) ? str(err["message"]) : str(err);
      errType = isJsonObject(err) ? str(err["type"] || err["code"]) : "";
      requestId = isJsonObject(data) ? str(data["request_id"]) : "";
      const meta = { status, providerCode: errType || null, requestId: requestId || null };
      if (isContextLengthMessage(msg)) return this.providerError(ContextLengthError, msg, meta);
      if (errType === "DeploymentNotFound" || ((errType === "not_found_error" || errType === "resource_not_found_error") && isModelError(msg))) {
        return this.providerError(UnsupportedModelError, msg, { ...meta, providerCode: errType });
      }
      const cls = ERROR_TYPE_MAP[errType];
      if (cls) return this.providerError(cls, msg, meta);
      if (errType && !msg.includes(errType)) msg = `${msg} (${errType})`;
    } catch {
      msg = body.trim().slice(0, 500) || `HTTP ${status}`;
      errType = "";
      requestId = "";
    }
    return this.withLoginHint(
      mapHttpError(status, msg, { provider: this.provider, envKeys: this.access.envKeys, providerCode: errType || null, requestId: requestId || null }),
    );
  }

  protected headers(request?: Request): Record<string, string> {
    const headers: Record<string, string> = { "anthropic-version": this.apiVersion, "content-type": "application/json" };
    const betas: string[] = [];
    for (const [k, v] of this.access.headers) {
      if (k.toLowerCase() === "anthropic-beta") betas.push(...v.split(",").filter(Boolean));
      else headers[k] = v;
    }
    if (request?.tools?.some((t) => t.type === "builtin" && t.name === "code_execution")) betas.push("code-execution-2025-05-22");
    if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
    return headers;
  }

  // ─── Request ─────────────────────────────────────────────────────

  protected part(part: Part): JsonObject {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "data":
        return { type: "text", text: dataPartText(part) }; // D3: a data part is its JSON on a text slot
      case "image":
        return { type: "image", source: anthropicSource(part) };
      case "document":
        return { type: "document", source: anthropicSource(part) };
      case "tool_call":
        return { type: "tool_use", id: part.id, name: part.name, input: part.input };
      case "tool_result": {
        checkToolResultMedia(this.provider, part, this.resolvedCompat.toolResultMedia, "a tool_result block");
        const blocks = part.content.map((p) => this.toolResultContent(p));
        const out: JsonObject = { type: "tool_result", tool_use_id: part.id };
        if (blocks.length > 0) out["content"] = blocks.length === 1 && blocks[0]!["type"] === "text" ? blocks[0]!["text"]! : blocks;
        if (part.isError) out["is_error"] = true;
        return out;
      }
      case "thinking": {
        const redacted = continuationData(part, "anthropic", "redacted_thinking");
        if (redacted !== undefined) return { type: "redacted_thinking", ...redacted };
        const signature = continuationData(part, "anthropic", "thinking_signature");
        if (signature && signature["signature"]) return { type: "thinking", thinking: part.text, signature: signature["signature"] };
        if (this.resolvedCompat.thinkingReplay === "unsigned" && part.text) return { type: "thinking", thinking: part.text };
        return { type: "text", text: part.text };
      }
      default:
        return { type: "text", text: (part as { text?: string }).text ?? "" };
    }
  }

  protected toolResultContent(part: Part): JsonObject {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "data") return { type: "text", text: dataPartText(part) };
    if (part.type === "image") return { type: "image", source: anthropicSource(part) };
    if (part.type === "document") return { type: "document", source: anthropicSource(part) };
    if (MEDIA_KINDS.has(part.type)) {
      throw new UnsupportedFeatureError(`${this.provider}: a ${part.type} part cannot reach a tool_result block (text, image and document only; MAP-10)`, {
        provider: this.provider,
        feature: `messages[*].tool_result.content[${part.type}]`,
      });
    }
    return { type: "text", text: partsToText([part], { provider: this.provider }) };
  }

  protected message(msg: Message): JsonObject {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let parts = msg.parts.map((p) => this.part(p));
    if (msg.role === "developer") parts = [{ type: "text", text: `[developer]\n${partsToText(msg.parts)}` }];
    return { role, content: parts };
  }

  protected toolChoicePayload(request: Request): JsonObject | undefined {
    const tc = request.config?.toolChoice;
    if (!tc) return undefined;
    const mode = tc.mode ?? "auto";
    const payload: JsonObject = {};
    if (mode === "none") payload["type"] = "none";
    else if (tc.allowed && tc.allowed.length > 0) {
      // {"type": "tool", "name": ...} forces client tools AND server tools
      // (verified live 2026-09-01 with web_search). Every declared tool, or
      // (MAP-13) a proper subset that payload() has already narrowed the
      // tools list to: either way the wire form is any/auto over the tools sent.
      if (tc.allowed.length === 1 && mode === "required") {
        payload["type"] = "tool";
        payload["name"] = tc.allowed[0]!;
      } else payload["type"] = mode === "required" ? "any" : "auto";
    } else payload["type"] = mode === "required" ? "any" : "auto";
    if (tc.parallel === false && payload["type"] !== "none") payload["disable_parallel_tool_use"] = true;
    return payload;
  }

  /**
   * The names of a proper-subset allowlist, else undefined. MAP-13: the
   * Messages API cannot restrict to a subset, so the adapter sends ONLY
   * those tools — that is what "may only call these" means — and records
   * it as client_side.
   */
  protected allowedSubset(request: Request): readonly string[] | undefined {
    const tc = request.config?.toolChoice;
    if (!tc || tc.mode === "none" || !tc.allowed || tc.allowed.length === 0) return undefined;
    if (tc.allowed.length === 1 && tc.mode === "required") return undefined;
    const declared = new Set((request.tools ?? []).map((t) => t.name));
    if (new Set(tc.allowed).size === declared.size && tc.allowed.every((n) => declared.has(n))) return undefined;
    return tc.allowed;
  }

  payload(request: Request, stream: boolean): JsonObject {
    const compat = this.resolvedCompat;
    const config = request.config ?? {};
    if (compat.modelPrefixes && !compat.modelPrefixes.some((p) => request.model.startsWith(p))) {
      throw new UnsupportedModelError(
        `${this.provider}: model ${JSON.stringify(request.model)} is not one this endpoint serves as typed (expected a prefix in ${JSON.stringify([...compat.modelPrefixes])}); it would be silently substituted by another model. Name the model you actually want.`,
        { provider: this.provider },
      );
    }
    const cache = config.cache;
    const useCache = cache !== undefined && cache.mode !== "off" && compat.cacheControl === "anthropic";
    const longCache = cache !== undefined && cache.retention === "long" && compat.cacheControl === "anthropic";
    const messages = request.messages.map((m) => this.message(m));

    if (useCache && cache) {
      if (cache.key !== undefined) {
        // MAP-13: a best-effort routing hint by definition; no home here.
        adapt("config.cache.key", "dropped", "the Messages API has no cache affinity key (OpenAI's prompt_cache_key); marks on blocks are its mechanism and were placed", {
          asked: cache.key,
          provider: this.provider,
        });
      }
      if (cache.resource !== undefined) {
        // MAP-13 rule 4(b): the program references a stored object that does not exist on this provider.
        throw new UnsupportedFeatureError("anthropic: cache.resource is not supported — the Messages API has no stored-cache tier; it caches by marks on blocks", {
          provider: this.provider,
          feature: "config.cache.resource",
        });
      }
      let idx: number | undefined;
      if (cache.prefixUntilIndex !== undefined) idx = Math.min(cache.prefixUntilIndex, messages.length - 1);
      else if (cache.prefix === "history") idx = messages.length - 1;
      if (idx !== undefined && idx >= 0) {
        const content = messages[idx]!["content"];
        if (Array.isArray(content) && content.length > 0) {
          const last = content[content.length - 1];
          if (isJsonObject(last) && last["cache_control"] === undefined) {
            const marker: JsonObject = { type: "ephemeral" };
            if (longCache) marker["ttl"] = "1h";
            last["cache_control"] = marker;
          }
        }
      }
    }

    let reasoning = config.reasoning;
    const deepseekThinking = compat.thinkingFormat === "deepseek";
    // "adaptive": every model on this server is the adaptive class (Meta Model API) — no model-name table.
    const alwaysAdaptive = compat.thinkingFormat === "adaptive";
    // "effort": no `thinking` object exists on this server; the dial is output_config.effort alone (Moonshot).
    const effortOnly = compat.thinkingFormat === "effort";
    const on = reasoning !== undefined && reasoning.effort !== "off";
    const adaptive = on && (deepseekThinking || alwaysAdaptive || effortOnly || anthropicAdaptiveClass(request.model));
    if (reasoning !== undefined && on) {
      if (compat.reasoningEfforts !== undefined && !compat.reasoningEfforts.includes(reasoning.effort)) {
        // MAP-13: an effort word with no level here is clamped to the nearest
        // declared level (the dial is ordinal); the server would have accepted
        // the word silently (Moonshot answered 200 to `medium` and `bogus`, live 2026-09-03).
        const nearest = nearestEffort(reasoning.effort, compat.reasoningEfforts) as ReasoningEffort;
        adapt(
          "config.reasoning.effort",
          "clamped",
          `this server has no ${JSON.stringify(reasoning.effort)} level (it accepts ${compat.reasoningEfforts.join(", ")}) and would have accepted the word silently`,
          { asked: reasoning.effort, applied: nearest, provider: this.provider },
        );
        reasoning = { ...reasoning, effort: nearest };
      }
      if (reasoning.summary === "concise" || reasoning.summary === "detailed") {
        // MAP-13: a visibility level the wire lacks; thinking blocks are returned whenever thinking runs, which is "auto".
        adapt("config.reasoning.summary", "substituted", "the Messages API has no summary detail levels; it returns thinking blocks whenever thinking runs, which is 'auto'", {
          asked: reasoning.summary,
          applied: "auto",
          provider: this.provider,
        });
        reasoning = { ...reasoning, summary: "auto" };
      }
      if (adaptive) {
        if (reasoning.thinkingBudget !== undefined) {
          // MAP-13: effort carries the intent (MAP-7 rule 5); the budget has no honoured field on this class.
          const why = deepseekThinking
            ? "this server ignores budget_tokens; effort is the dial"
            : alwaysAdaptive
              ? "this server accepts budget_tokens without translating it; effort is the dial (protocols--messages.md)"
              : `${request.model} takes thinking.type 'adaptive' with output_config.effort; budget_tokens is rejected by the API (live 2026-09-02)`;
          adapt("config.reasoning.thinking_budget", "dropped", why, { asked: reasoning.thinkingBudget, provider: this.provider });
          const { thinkingBudget: _drop, ...rest } = reasoning;
          reasoning = rest;
        }
        if (reasoning.effort === "minimal" && !(deepseekThinking || alwaysAdaptive || effortOnly)) {
          // MAP-13: the floor of an ordinal dial. Only the api.anthropic.com class: a compat server answers an unsupported level with a 400 of its own.
          adapt("config.reasoning.effort", "clamped", "this model class has no 'minimal' level (output_config.effort is low|medium|high|xhigh|max); 'low' is the floor", {
            asked: "minimal",
            applied: "low",
            provider: this.provider,
          });
          reasoning = { ...reasoning, effort: "low" };
        }
      }
    }
    const thinkingBudget = adaptive || !on || reasoning === undefined ? undefined : (reasoning.thinkingBudget ?? EFFORT_THINKING_BUDGETS[reasoning.effort]);
    // Manual class: max_tokens includes thinking, so the wire ceiling is the
    // budget plus the visible cap. Adaptive class: Config.maxTokens is the
    // total ceiling. The Messages API requires the field: when the caller
    // set none, the class default is used and recorded (MAP-13).
    let visible = config.maxTokens;
    if (visible === undefined) {
      visible = defaultMaxTokens(request.model);
      adapt("config.max_tokens", "defaulted", "the Messages API requires max_tokens and none was set; the class default was used", { applied: visible, provider: this.provider });
    }
    const payload: JsonObject = {
      model: request.model,
      messages,
      stream,
      max_tokens: thinkingBudget === undefined ? visible : thinkingBudget + visible,
    };

    if (request.system) {
      const systemText = typeof request.system === "string" ? request.system : partsToText(request.system);
      if (useCache) {
        const marker: JsonObject = { type: "ephemeral" };
        if (longCache) marker["ttl"] = "1h";
        payload["system"] = [{ type: "text", text: systemText, cache_control: marker }];
      } else payload["system"] = systemText;
    }
    const samplingFixed = compat.samplingParams === "reject";
    if (samplingFixed) {
      // A record's asked/applied keep the field's JSON type: float fields are floats (1.0, never 1).
      for (const [name, value] of [["temperature", optionalWireFloat(config.temperature)], ["top_p", optionalWireFloat(config.topP)], ["top_k", config.topK]] as const) {
        // The server documents none of these and swallows them silently
        // (Moonshot, live 2026-09-03). MAP-13: omit and record — the note supplies the visibility.
        if (value !== undefined) adapt(`config.${name}`, "dropped", "this server ignores sampling parameters (the model's sampling is fixed)", { asked: value, provider: this.provider });
      }
    }
    for (const [name, value] of [["seed", config.seed], ["frequency_penalty", optionalWireFloat(config.frequencyPenalty)], ["presence_penalty", optionalWireFloat(config.presencePenalty)]] as const) {
      // MAP-13: a sampling hint with no field on the Messages API.
      if (value !== undefined) adapt(`config.${name}`, "dropped", `the Messages API has no ${name} field`, { asked: value, provider: this.provider });
    }
    if (config.temperature !== undefined && !samplingFixed) {
      let temperature = config.temperature;
      if (temperature > 1.0) {
        // MAP-13: the canonical range is 0–2; this wire's ceiling is 1.0 and
        // both scales default to 1.0, so "hotter than allowed" becomes the hottest. Never rescaled.
        adapt("config.temperature", "clamped", "the Messages API accepts temperature in [0, 1]; the canonical range is [0, 2]", { asked: wireFloat(temperature), applied: wireFloat(1.0), provider: this.provider });
        temperature = 1.0;
      }
      payload["temperature"] = wireFloat(temperature);
    }
    if (config.topP !== undefined && !samplingFixed) payload["top_p"] = wireFloat(config.topP);
    if (config.topK !== undefined && !samplingFixed) payload["top_k"] = config.topK;
    if (config.stop && config.stop.length > 0) payload["stop_sequences"] = [...config.stop];
    if (request.tools && request.tools.length > 0) {
      const allowedSubset = this.allowedSubset(request);
      const wire = request.tools
        .filter((tool) => allowedSubset === undefined || allowedSubset.includes(tool.name))
        .map((tool) =>
          tool.type === "function"
            ? { name: tool.name, description: tool.description ?? null, input_schema: tool.parameters ?? { type: "object", properties: {} } }
            : builtinToAnthropic(tool),
        );
      if (allowedSubset !== undefined) {
        adapt("config.tool_choice.allowed", "client_side", "the Messages API cannot restrict to a subset of the declared tools; only the allowed tools were sent, which is what the allowlist means", {
          asked: [...allowedSubset],
          applied: wire.map((t) => str(t["name"])),
          provider: this.provider,
        });
      }
      payload["tools"] = wire;
    }
    const toolChoice = this.toolChoicePayload(request);
    if (toolChoice !== undefined) {
      const tc = config.toolChoice;
      if (compat.parallelToolCalls === "reject" && tc?.parallel !== undefined) {
        // disable_parallel_tool_use is documented as ignored (guide--anthropic-api.md). MAP-13: omit it and say so.
        adapt("config.tool_choice.parallel", "dropped", "this server accepts disable_parallel_tool_use and does not apply it (guide--anthropic-api.md); the model may return several calls", {
          asked: tc.parallel,
          provider: this.provider,
        });
        delete toolChoice["disable_parallel_tool_use"];
      }
      payload["tool_choice"] = toolChoice;
    }
    if (deepseekThinking) {
      if (reasoning?.effort === "off") payload["thinking"] = { type: "disabled" };
      else if (reasoning) {
        payload["thinking"] = { type: "enabled" };
        payload["output_config"] = { effort: reasoning.effort };
      }
    } else if (effortOnly) {
      if (reasoning?.effort === "off") payload["thinking"] = { type: "disabled" };
      else if (reasoning) payload["output_config"] = { effort: reasoning.effort };
    } else if (alwaysAdaptive && reasoning?.effort === "off") {
      payload["thinking"] = { type: "disabled" };
    } else if (adaptive && reasoning) {
      payload["thinking"] = { type: "adaptive" };
      payload["output_config"] = { effort: reasoning.effort };
    } else if (thinkingBudget !== undefined) {
      payload["thinking"] = { type: "enabled", budget_tokens: thinkingBudget };
    }
    if (config.responseFormat) {
      if (compat.structuredOutput === "reject") {
        // The server accepts output_config.format and ignores the schema
        // (DeepSeek, live 2026-09-03: 200 with keys the schema never named).
        // MAP-13: omit and record; the caller can describe the shape in the prompt.
        adapt("config.response_format", "dropped", "this server accepts output_config.format and does not apply it; describe the shape in the prompt", {
          asked: config.responseFormat as unknown as JsonObject,
          provider: this.provider,
        });
      } else {
        // MAP-14 §2: a judgment property carrying type+anyOf has its type moved
        // into every branch (the wire 400s otherwise, receipted 2026-09-17);
        // probabilities cannot be measured here.
        noteUnmeasurableProbabilities(request, this.provider);
        const found = requestJudgments(request);
        let fmt = config.responseFormat;
        if (found.size > 0 && fmt.type === "json_schema") fmt = { ...fmt, schema: anthropicSchema(fmt.schema, found) };
        payload["output_config"] = { ...obj(payload["output_config"]), ...responseFormatToOutputConfig(fmt) };
      }
    }
    if (config.serviceTier !== undefined) payload["service_tier"] = config.serviceTier;
    if (config.userId !== undefined) payload["metadata"] = { user_id: config.userId };
    if (config.store === false) {
      // MAP-13 "satisfied": the Messages API keeps no retrievable stored-response object, so an opt-out holds by construction.
      adapt("config.store", "satisfied", "the Messages API has no stored-response object to opt out of; nothing retrievable is kept", { asked: false, provider: this.provider });
    } else if (config.store === true) {
      adapt("config.store", "dropped", "the Messages API has no stored-response object to opt into (OpenAI and Gemini carry `store`)", { asked: true, provider: this.provider });
    }
    if (config.logprobs !== undefined) {
      // MAP-13 (decision 2026-09-14 §4.1): Response.logprobs is optional; the program sees absence, not a later crash.
      adapt("config.logprobs", "dropped", "the Messages API does not expose token log probabilities (OpenAI and Gemini carry them); Response.logprobs will be absent", {
        asked: config.logprobs,
        provider: this.provider,
      });
    }
    if (config.extensions) for (const [k, v] of Object.entries(config.extensions)) if (k !== "prompt_caching") payload[k] = v;
    if (this.access.systemPrefix) {
      const prefix: JsonObject = { type: "text", text: this.access.systemPrefix };
      const existing = payload["system"];
      if (existing === undefined || existing === null) payload["system"] = [prefix];
      else if (Array.isArray(existing)) payload["system"] = [prefix, ...existing];
      else payload["system"] = [prefix, { type: "text", text: str(existing) }];
    }
    return payload;
  }

  wireRequest(request: Request, stream: boolean): EmitOptions {
    request = this.wireModelRequest(request);
    return {
      method: "POST",
      url: `${this.base()}/messages`,
      headers: this.headers(request),
      payload: this.payload(request, stream),
      endpoint: "messages",
      stream,
      model: request.model,
    };
  }

  // ─── Response ────────────────────────────────────────────────────

  parseResponse(request: Request, response: HttpResponse): Response {
    request = this.wireModelRequest(request);
    const data = obj(response.json());
    const parts: Part[] = [];
    const unmapped: Unmapped = [];
    list(data["content"]).forEach((block, blockIndex) => {
      if (!isJsonObject(block)) {
        recordUnmapped(unmapped, `content[${blockIndex}]`, typeName(block));
        return;
      }
      const blockType = block["type"];
      if (blockType === "text") {
        parts.push(normalizePart({ type: "text", text: str(block["text"]) }));
        for (const c of list(block["citations"])) {
          if (!isJsonObject(c)) continue;
          const citation = citationFromAnthropic(c);
          if (citation) parts.push(citation);
        }
      } else if (blockType === "tool_use") {
        if (!block["name"]) throw unnamedToolCallError(this.provider, `content[${blockIndex}]`);
        parts.push(normalizePart({ type: "tool_call", id: str(block["id"]) || `tool_${parts.length}`, name: str(block["name"]), input: isJsonObject(block["input"]) ? block["input"] : {} }));
      } else if (blockType === "thinking") {
        const continuation = block["signature"] ? [{ provider: "anthropic", kind: "thinking_signature", data: { signature: str(block["signature"]) } }] : [];
        parts.push(normalizePart({ type: "thinking", text: str(block["thinking"] || block["text"]), continuation }));
      } else if (blockType === "redacted_thinking") {
        const continuation = block["data"] !== undefined && block["data"] !== null ? [{ provider: "anthropic", kind: "redacted_thinking", data: { data: block["data"] } }] : [];
        parts.push(normalizePart({ type: "thinking", text: "", continuation }));
      } else if (typeof blockType === "string" && PROVIDER_EXECUTED_BLOCKS.has(blockType)) {
        // MAP-1
      } else recordUnmapped(unmapped, `content[${blockIndex}]`, blockType);
    });
    if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));
    const hasTool = parts.some((p) => p.type === "tool_call");
    return new Response({
      id: data["id"] ? str(data["id"]) : undefined,
      model: str(data["model"]) || request.model,
      message: { role: "assistant", parts: replaceTextWithData(parts, requestJudgments(request)) },
      finishReason: finishReason(data["stop_reason"], hasTool),
      usage: usageFromAnthropic(obj(data["usage"])),
      providerData: attachUnmapped(data, unmapped),
    });
  }

  // ─── Stream ──────────────────────────────────────────────────────

  parseStreamEvents(request: Request, raw: SSEEvent): StreamEvent[] {
    request = this.wireModelRequest(request);
    if (!raw.data) return [];
    const payload = parseJson(raw.data);
    if (!isJsonObject(payload)) return [];
    const et = payload["type"];
    const idx = int(payload["index"]) ?? 0;
    switch (et) {
      case "message_start": {
        const msg = obj(payload["message"]);
        const id = msg["id"] ? str(msg["id"]) : undefined;
        return [{ type: "start", ...(id ? { id } : {}), model: str(msg["model"]) || request.model }];
      }
      case "content_block_start": {
        const block = obj(payload["content_block"]);
        if (block["type"] === "tool_use") {
          const startInput = block["input"];
          const input = isJsonObject(startInput) ? (Object.keys(startInput).length > 0 ? stringifyJson(startInput) : "") : str(startInput);
          const id = str(block["id"]);
          const name = str(block["name"]);
          return [{ type: "delta", delta: { type: "tool_call", input, partIndex: idx, ...(id ? { id } : {}), ...(name ? { name } : {}) } }];
        }
        if (block["type"] === "redacted_thinking" && block["data"] !== undefined && block["data"] !== null) {
          return [
            { type: "delta", delta: { type: "thinking", text: "", partIndex: idx } },
            { type: "delta", delta: { type: "continuation", provider: "anthropic", kind: "redacted_thinking", data: { data: block["data"] }, partIndex: idx } },
          ];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = obj(payload["delta"]);
        switch (delta["type"]) {
          case "text_delta":
            return [{ type: "delta", delta: { type: "text", text: str(delta["text"]), partIndex: idx } }];
          case "input_json_delta":
            return [{ type: "delta", delta: { type: "tool_call", input: str(delta["partial_json"]), partIndex: idx } }];
          case "thinking_delta":
            return [{ type: "delta", delta: { type: "thinking", text: str(delta["thinking"]), partIndex: idx } }];
          case "signature_delta":
            if (!delta["signature"]) return [];
            return [{ type: "delta", delta: { type: "continuation", provider: "anthropic", kind: "thinking_signature", data: { signature: str(delta["signature"]) }, partIndex: idx } }];
          case "citation_delta":
          case "citations_delta": {
            const c = isJsonObject(delta["citation"]) ? delta["citation"] : delta;
            const text = str(c["cited_text"] || c["text"]);
            const url = str(c["url"]);
            const title = str(c["title"]);
            return [{ type: "delta", delta: { type: "citation", partIndex: idx, ...(text ? { text } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) } }];
          }
          default:
            return [];
        }
      }
      case "message_delta": {
        const delta = obj(payload["delta"]);
        const usagePayload = obj(payload["usage"]);
        const usage = Object.keys(usagePayload).length > 0 ? usageFromAnthropic(usagePayload) : undefined;
        const stopReason = delta["stop_reason"];
        if ((stopReason === null || stopReason === undefined) && usage === undefined) return [];
        return [
          {
            type: "end",
            ...(stopReason !== null && stopReason !== undefined ? { finishReason: finishReason(stopReason) } : {}),
            ...(usage ? { usage } : {}),
            providerData: payload,
          },
        ];
      }
      case "message_stop":
        return [{ type: "end" }];
      case "error": {
        const err = payload["error"];
        if (isJsonObject(err)) return [{ type: "error", error: this.errorDetail(str(err["type"] || err["code"] || payload["code"]) || "provider", str(err["message"] || payload["message"])) }];
        return [{ type: "error", error: this.errorDetail(str(payload["code"] || payload["error_type"]) || "provider", str(payload["message"])) }];
      }
      default:
        return [];
    }
  }

  // ─── Models ──────────────────────────────────────────────────────

  override modelsRequest(): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/models`, params: { limit: 1000 }, headers: this.headers() });
  }
  override modelsFromBody(body: string): ModelInfo[] {
    return modelInfosFromEntries(obj(parseJson(body))["data"], { provider: this.provider, apiFamily: "anthropic_messages", idOf: (e) => e["id"] });
  }

  // ─── Files ───────────────────────────────────────────────────────

  override fileUploadRequest(request: FileUploadRequest): Promise<TransportRequest> {
    const fields = Object.entries(request.extensions ?? {}).map(([k, v]): [string, string] => [k, str(v)]);
    const bytes = request.bytes ?? (request.path ? readFileBytes(request.path) : new Uint8Array(0));
    const [contentType, body] = multipartFormBody(fields, [{ field: "file", filename: request.filename, contentType: request.mediaType ?? "application/octet-stream", data: bytes }]);
    const headers = this.headers();
    headers["content-type"] = contentType;
    return this.emit({ method: "POST", url: `${this.base()}/files`, headers, body });
  }

  protected fileInfo(data: JsonObject): FileInfo {
    const id = data["id"];
    if (typeof id !== "string" || !id) throw new ProviderError("anthropic: file object carries no id", { provider: this.provider });
    return FileInfo.create({
      id,
      filename: typeof data["filename"] === "string" && data["filename"] ? data["filename"] : undefined,
      mediaType: typeof data["mime_type"] === "string" && data["mime_type"] ? data["mime_type"] : undefined,
      sizeBytes: int(data["size_bytes"]),
      createdAt: isoUtc(data["created_at"]),
      expiresAt: isoUtc(data["expires_at"]),
      readiness: "ready",
      downloadable: typeof data["downloadable"] === "boolean" ? data["downloadable"] : undefined,
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
    return this.emit({ method: "GET", url: `${this.base()}/files`, params: { limit, ...(cursor !== undefined ? { page: cursor } : {}) }, headers: this.headers() });
  }
  override filePageFromListBody(body: string): FilePage {
    const data = obj(parseJson(body));
    const items = list(data["data"]).filter(isJsonObject).map((e) => this.fileInfo(e));
    const cursor = data["next_page"];
    return FilePage.create({ items, nextCursor: typeof cursor === "string" && cursor ? cursor : undefined });
  }
  override fileDeleteRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "DELETE", url: `${this.base()}/files/${pathId(fileId)}`, headers: this.headers() });
  }
  override fileDownloadRequest(fileId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/files/${pathId(fileId)}/content`, headers: this.headers() });
  }

  // ─── Batches ─────────────────────────────────────────────────────

  override batchSubmitRequest(request: BatchRequest): Promise<TransportRequest> {
    this.batchPreflight(request);
    // MAP-13: the batch builder runs under the adapter's policy so "refuse"
    // refuses here too; a batch ticket has no adaptations field (provisional
    // surface), so under "note" the record is not kept.
    const scope = new AdaptationScope(this.adaptations, this.provider);
    const payload = collecting(scope, (): JsonObject => {
      if (request.label !== undefined) {
        adapt("label", "dropped", "the Message Batches create body has no metadata field (verified live 2026-08-31); correlate by id", { asked: request.label, provider: this.provider });
      }
      return {
        requests: request.requests.map((nested, i) => ({ custom_id: String(i), params: this.payload(nested, false) })),
        ...(request.extensions ?? {}),
      };
    });
    return this.emit({ method: "POST", url: `${this.base()}/messages/batches`, headers: this.headers(), payload });
  }

  protected batchJobInfo(data: JsonObject): BatchJobInfo {
    const id = data["id"];
    if (typeof id !== "string" || !id) throw new ProviderError("anthropic: batch object carries no id", { provider: this.provider });
    return BatchJobInfo.create({ id, status: anthropicBatchStatus(data), createdAt: isoUtc(data["created_at"]), providerData: data });
  }
  override batchJobFromBody(body: string): BatchJobInfo {
    return this.batchJobInfo(obj(parseJson(body)));
  }
  override batchStatusRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/messages/batches/${pathId(batchId)}`, headers: this.headers() });
  }
  override batchCancelRequest(batchId: string): Promise<TransportRequest> {
    return this.emit({ method: "POST", url: `${this.base()}/messages/batches/${pathId(batchId)}/cancel`, headers: this.headers() });
  }
  override async batchResultFetches(statusBody: JsonObject): Promise<TransportRequest[]> {
    const url = statusBody["results_url"];
    if (typeof url !== "string" || !url) throw new ProviderError("anthropic: ended batch carries no results_url", { provider: this.provider });
    return [await this.emit({ method: "GET", url, headers: this.headers() })];
  }
  override batchEntries(_statusBody: JsonObject, fetched: readonly string[]): BatchEntry[] {
    const entries: BatchEntry[] = [];
    for (const line of (fetched[0] ?? "").split("\n")) {
      if (!line.trim()) continue;
      const item = obj(parseJson(line));
      const index = Number(str(item["custom_id"]));
      const result = obj(item["result"]);
      const rtype = str(result["type"]);
      if (rtype === "succeeded") {
        const message = obj(result["message"]);
        const response = this.parseResponse(batchEntryRequest(message["model"]), batchEntryHttp(message));
        entries.push(BatchEntry.create({ index, outcome: "succeeded", response }));
      } else if (rtype === "errored") {
        const raw = result["error"];
        const envelope = isJsonObject(raw) && "error" in raw ? raw : { error: raw ?? {} };
        const err = this.normalizeError(400, stringifyJson(envelope));
        entries.push(
          BatchEntry.create({
            index,
            outcome: "errored",
            error: ErrorDetail.create({ code: canonicalErrorCode(err), message: err.message || "batch entry errored", providerCode: err.providerCode ?? undefined }),
          }),
        );
      } else if (rtype === "canceled") entries.push(BatchEntry.create({ index, outcome: "cancelled" }));
      else if (rtype === "expired") entries.push(BatchEntry.create({ index, outcome: "expired" }));
      else {
        entries.push(BatchEntry.create({ index, outcome: "errored", error: ErrorDetail.create({ code: "provider", message: `unrecognized batch result type ${JSON.stringify(rtype)}` }) }));
      }
    }
    return entries.sort((a, b) => a.index - b.index);
  }
  override batchListRequest(limit: number): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/messages/batches`, params: { limit }, headers: this.headers() });
  }
  override batchJobsFromListBody(body: string): BatchJobInfo[] {
    return list(obj(parseJson(body))["data"]).filter(isJsonObject).map((d) => this.batchJobInfo(d));
  }
}

export interface ClaudeCodeLMOptions extends AnthropicLMOptions {
  readonly claudeCodeVersion?: string;
}

/** The Claude subscription binding: `AnthropicLM` with `CLAUDE_CODE` bound. */
export class ClaudeCodeLM extends AnthropicLM {
  static override readonly manifest: AccessPolicy = CLAUDE_CODE;

  constructor(opts: ClaudeCodeLMOptions = {}) {
    let policy = CLAUDE_CODE;
    if (opts.claudeCodeVersion !== undefined && opts.claudeCodeVersion !== DEFAULT_CLAUDE_CODE_VERSION) {
      policy = withHeaders(policy, { "user-agent": `claude-cli/${opts.claudeCodeVersion}` });
    }
    super({ ...opts, access: opts.access ?? policy }, CLAUDE_CODE);
  }
}
