/**
 * OpenAI Chat Completions dialect (`OpenAIChatLM`): OpenAI's legacy
 * endpoint and the de-facto standard other servers speak (Groq, DeepSeek,
 * xAI, ollama, vLLM, …). Server quirks are `OpenAIChatCompat` presets.
 */

import { AdaptationScope, adapt, collecting, nearestEffort, type Adaptation } from "../adaptation.ts";
import { ProviderLM, attachErrorMetadata, type LMOptions, type EmitOptions } from "../adapter.ts";
import { noteUnmeasurableProbabilities, replaceTextWithData, requestJudgments, type Judgment } from "../judgments.ts";
import { JUDGMENT_PREFILL, foldJudgment, judgmentAsk, keyPaths, scorePayload, scoresFromBody, tokenizePayload, tokensFromBody, trieNodes } from "./token_trie.ts";
import { OPENAI_CHAT_API, type AccessPolicy } from "../auth/policy.ts";
import {
  OPENAI_CHAT_PRESET_BASE_URLS,
  chatCompatForModel,
  openaiChatPreset,
  presetBaseUrl,
  resolveOpenAIChatCompat,
  type OpenAIChatCompat,
  type ResolvedOpenAIChatCompat,
} from "../compat.ts";
import {
  AuthError,
  BillingError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  ServerError,
  UnsupportedFeatureError,
  UnsupportedModelError,
  mapHttpError,
} from "../errors.ts";
import { isJsonObject, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../json.ts";
import type { SSEEvent } from "../stream.ts";
import {
  Request,
  builtinTool,
  normalizeCacheConfig,
  normalizeConfig,
  normalizeReasoning,
  normalizeToolChoice,
  tool,
  type BuiltinTool,
  type CacheConfig,
  type Config,
  type Reasoning,
  type ResponseFormat,
  type Tool,
  type ToolChoice,
} from "../types/config.ts";
import { ValueError } from "../types/validate.ts";
import type { ModelInfo } from "../types/model_info.ts";
import {
  Message,
  audio,
  citation,
  document,
  guessMediaType,
  image,
  normalizePart,
  refusal,
  text,
  thinking,
  toolCall,
  toolResult,
  type AssistantPart,
  type CitationPart,
  type ImagePart,
  type Part,
  type PromptPart,
  type TextPart,
  type ToolCallPart,
  type ToolResultContentPart,
  type ToolResultPart,
} from "../types/parts.ts";
import { Response, Usage } from "../types/response.ts";
import type { CacheRetention, FinishReason, ImageDetail, ReasoningEffort, ReasoningSummary, ToolChoiceMode } from "../vocab.ts";
import type { StreamEvent } from "../types/stream.ts";
import {
  HttpResponse,
  MEDIA_KINDS,
  checkToolResultMedia,
  mediaDataUri,
  modelInfosFromEntries,
  openaiTokenLogprobs,
  parseJsonObjectLenient,
  partsToText,
  toolResultErrorText,
  unnamedToolCallError,
  type TransportRequest,
} from "../wire.ts";
import { wireFloat } from "./openai_responses.ts";
import {
  MODEL_ERROR_CODES,
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
  recordUnmapped,
  responseFormatToChat,
  str,
  typeName,
  usageFromChat,
  type Unmapped,
} from "./openai_shared.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const GROQ_BUILTIN_MAP: Readonly<Record<string, string>> = Object.freeze({ web_search: "browser_search", code_execution: "code_interpreter" });

const FINISH_REASON_MAP: Readonly<Record<string, FinishReason>> = Object.freeze({
  stop: "stop",
  length: "length",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
});

function chatImageBlock(part: ImagePart, provider: string): JsonObject {
  if (part.fileId !== undefined) {
    throw new UnsupportedFeatureError(
      `${provider}: an image addressed by file_id cannot be sent on the Chat Completions wire (no file reference form); pass a URL or inline data`,
      { provider },
    );
  }
  const payload: JsonObject = { url: part.url ?? mediaDataUri(part) };
  if (part.detail) payload["detail"] = part.detail;
  return { type: "image_url", image_url: payload };
}

/** Non-assistant message parts → chat content: a string for one text part, else an array (MAP-10 raises for no-slot parts). */
function chatContentParts(msg: Message, provider: string, forceArray: boolean): string | JsonObject[] {
  const parts = msg.parts.filter((p) => p.type !== "tool_call" && p.type !== "tool_result");
  if (parts.length === 1 && parts[0]!.type === "text" && !forceArray) return (parts[0] as { text: string }).text;
  const out: JsonObject[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
    else if (part.type === "image") out.push(chatImageBlock(part, provider));
    else if (part.type === "thinking") continue;
    else if (MEDIA_KINDS.has(part.type)) {
      throw new UnsupportedFeatureError(
        `${provider}: a ${part.type} part in a ${msg.role} message has no slot on the Chat Completions wire (text and image_url only); the OpenAI Responses, Anthropic and Gemini dialects carry it (MAP-10)`,
        { provider, feature: `messages[*].parts[${part.type}]` },
      );
    } else out.push({ type: "text", text: partsToText([part], { provider }) });
  }
  return out;
}

/** A `role: tool` row's content (MAP-10). */
function toolRowContent(provider: string, part: ToolResultPart, policy: string): string | JsonObject[] {
  checkToolResultMedia(provider, part, policy, "a Chat Completions tool row");
  if (part.content.every((p) => !MEDIA_KINDS.has(p.type))) {
    return toolResultErrorText(part, partsToText(part.content, { provider, where: "a Chat Completions tool row" }));
  }
  const blocks: JsonObject[] = part.content.map((p) => (p.type === "image" ? chatImageBlock(p, provider) : { type: "text", text: partsToText([p], { provider }) }));
  if (part.isError) {
    const first = blocks.find((b) => b["type"] === "text");
    if (!first) blocks.unshift({ type: "text", text: "[error]" });
    else first["text"] = "[error] " + str(first["text"]);
  }
  return blocks;
}

export interface OpenAIChatLMOptions extends LMOptions {
  /** An `OpenAIChatCompat`, a preset name (`groq`, `ollama`, `deepseek`, …), or absent (plain OpenAI). */
  readonly compat?: OpenAIChatCompat | string;
}

export class OpenAIChatLM extends ProviderLM {
  static override readonly manifest: AccessPolicy = OPENAI_CHAT_API;
  protected readonly dialectBaseUrl = DEFAULT_BASE_URL;
  protected readonly compatPartial: OpenAIChatCompat;
  protected readonly resolvedCompat: ResolvedOpenAIChatCompat;

  constructor(opts: OpenAIChatLMOptions = {}, manifest: AccessPolicy = OPENAI_CHAT_API) {
    super(manifest, DEFAULT_BASE_URL, opts);
    const compat = opts.compat ?? this.registryCompat();
    if (typeof compat === "string") {
      this.compatPartial = openaiChatPreset(compat);
      if (this.baseUrl === DEFAULT_BASE_URL) this.baseUrl = presetBaseUrl(OPENAI_CHAT_PRESET_BASE_URLS, compat, "Chat Completions", "openai");
    } else this.compatPartial = compat ?? {};
    this.resolvedCompat = resolveOpenAIChatCompat(this.compatPartial);
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [k, v] of this.access.headers) headers[k] = v;
    return headers;
  }

  // ─── Errors (the OpenAI envelope family, shared with the Responses wire) ─

  protected responseError(code: string, message: string): ProviderError {
    const cls = RESPONSE_ERROR_CODE_MAP[code] ?? ServerError;
    return this.providerError(cls, message || code || "provider error", { providerCode: code || null });
  }

  override normalizeError(status: number, body: string): ProviderError {
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

  // ─── Models ──────────────────────────────────────────────────────

  override modelsRequest(): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/models`, headers: this.headers() });
  }

  override modelsFromBody(body: string): ModelInfo[] {
    const data = obj(parseJson(body));
    return modelInfosFromEntries(data["data"], { provider: this.provider, apiFamily: "openai_chat", idOf: (e) => e["id"] });
  }

  // ─── Request ─────────────────────────────────────────────────────

  /** The inverse of `buildRequest`'s body under this adapter's compat (MAP-12); see `requestFromOpenAIChat`. */
  requestFromOpenAIChat(body: unknown): Request {
    const model = isJsonObject(body) && typeof body["model"] === "string" ? body["model"] : undefined;
    return ingestOpenAIChat(this.provider, body, model !== undefined ? this.compatFor(model) : this.resolvedCompat);
  }

  protected compatFor(model: string): ResolvedOpenAIChatCompat {
    if (!this.compatPartial.modelOverrides || this.compatPartial.modelOverrides.length === 0) return this.resolvedCompat;
    return resolveOpenAIChatCompat(chatCompatForModel(this.compatPartial, model));
  }

  protected buildMessages(request: Request, compat: ResolvedOpenAIChatCompat): JsonObject[] {
    const messages: JsonObject[] = [];
    if (request.system) {
      const systemText = typeof request.system === "string" ? request.system : partsToText(request.system);
      if (cacheStablePrefix(request, compat.cacheControl)) {
        messages.push({ role: compat.instructionRole, content: [{ type: "text", text: systemText, prompt_cache_breakpoint: { mode: "explicit" } }] });
      } else messages.push({ role: compat.instructionRole, content: systemText });
    }
    const breakpointIndex = cacheBreakpointIndex(request, compat.cacheControl);
    request.messages.forEach((msg, msgIndex) => {
      if (msgIndex === breakpointIndex && (msg.role === "assistant" || msg.role === "tool")) throw breakpointUnsupported(this.provider, msgIndex, msg.role);
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type !== "tool_result") continue;
          const item: JsonObject = { role: "tool", tool_call_id: part.id, content: toolRowContent(this.provider, part, compat.toolResultMedia) };
          if (compat.toolResultName === "include" && part.name) item["name"] = part.name;
          messages.push(item);
        }
        return;
      }
      if (msg.role === "assistant") {
        const textBits: string[] = [];
        for (const part of msg.parts) {
          if (part.type === "text") textBits.push(part.text);
          else if (part.type === "refusal" && part.text) textBits.push(part.text);
          else if (part.type === "thinking" && compat.thinkingReplay === "as_text" && part.text) textBits.push(part.text);
        }
        const toolCalls = msg.parts
          .filter((p) => p.type === "tool_call")
          .map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: stringifyJson(p.input) } }));
        const item: JsonObject = { role: "assistant", content: textBits.length > 0 ? textBits.join("\n") : null };
        if (compat.thinkingReplay === "native") {
          const thinking = msg.parts
            .filter((p) => p.type === "thinking" && p.text)
            .map((p) => (p as { text: string }).text)
            .join("\n");
          if (thinking || compat.assistantReasoningContent === "include_empty") item["reasoning_content"] = thinking;
        }
        if (toolCalls.length > 0) item["tool_calls"] = toolCalls;
        messages.push(item);
        return;
      }
      const role = msg.role === "developer" ? compat.instructionRole : msg.role;
      const atBreakpoint = msgIndex === breakpointIndex;
      const content = chatContentParts(msg, this.provider, atBreakpoint);
      if (atBreakpoint) {
        const last = Array.isArray(content) ? content[content.length - 1] : undefined;
        if (!last || last["type"] !== "text") throw breakpointUnsupported(this.provider, msgIndex, msg.role);
        last["prompt_cache_breakpoint"] = { mode: "explicit" };
      }
      if (content === "" || (typeof content === "string" ? content.length > 0 : content.length > 0)) messages.push({ role, content });
    });
    return messages;
  }

  protected builtinToolPayload(tool: BuiltinTool, compat: ResolvedOpenAIChatCompat): JsonObject {
    if (compat.builtinTools === "groq") {
      const wireType = GROQ_BUILTIN_MAP[tool.name];
      if (!wireType) {
        throw new UnsupportedFeatureError(
          `${this.provider}: builtin tool ${JSON.stringify(tool.name)} has no Groq wire mapping — supported: ${JSON.stringify(Object.keys(GROQ_BUILTIN_MAP).sort())}`,
          { provider: this.provider, feature: `tools[${tool.name}]` },
        );
      }
      const entry: JsonObject = { type: wireType };
      if (tool.config) Object.assign(entry, tool.config);
      return entry;
    }
    throw new UnsupportedFeatureError(
      `${this.provider}: builtin tool ${JSON.stringify(tool.name)} is not supported on this server — the Chat Completions wire carries function tools only, and unproven servers may silently ignore unknown tool types. Use compat='groq' for Groq's server-executed tools, or the OpenAI Responses / Anthropic / Gemini providers`,
      { provider: this.provider, feature: `tools[${tool.name}]` },
    );
  }

  protected toolChoicePayload(request: Request): unknown {
    const tc = request.config?.toolChoice;
    if (!tc) return undefined;
    const mode = tc.mode ?? "auto";
    if (mode === "none") return "none";
    if (tc.allowed && tc.allowed.length > 0) {
      const byName = new Map((request.tools ?? []).map((t) => [t.name, t]));
      const entries = tc.allowed.map((n) => byName.get(n)!);
      const builtins = entries.filter((t) => t.type === "builtin").map((t) => t.name);
      if (builtins.length > 0) {
        throw new UnsupportedFeatureError(
          `${this.provider}: cannot force builtin tools ${JSON.stringify(builtins)} — the Chat Completions wire has no hosted-tool tool_choice form (OpenAI Responses and Anthropic carry it)`,
          { provider: this.provider, feature: "config.tool_choice.allowed" },
        );
      }
      if (entries.length === 1 && mode === "required") return { type: "function", function: { name: entries[0]!.name } };
      return { type: "allowed_tools", allowed_tools: { mode, tools: entries.map((t) => ({ type: "function", function: { name: t.name } })) } };
    }
    return mode === "required" ? "required" : "auto";
  }

  /** MAP-14 §4: this server scores named tokens (the token-trie driver delivers probabilities). */
  protected scoresNamedTokens(compat: ResolvedOpenAIChatCompat): boolean {
    return compat.tokenScoring === "logprob_token_ids";
  }

  payload(request: Request, stream: boolean): JsonObject {
    const compat = this.compatFor(request.model);
    const config = request.config ?? {};
    const payload: JsonObject = { model: request.model, messages: this.buildMessages(request, compat) };
    if (stream) {
      payload["stream"] = true;
      if (compat.streamUsage === "include") payload["stream_options"] = { include_usage: true };
    }
    if (config.maxTokens !== undefined) payload[compat.maxTokensField] = config.maxTokens;
    if (config.temperature !== undefined) payload["temperature"] = wireFloat(config.temperature);
    if (config.topP !== undefined) payload["top_p"] = wireFloat(config.topP);
    if (config.topK !== undefined) {
      // MAP-13: a sampling hint with no field on this wire; servers that take one do so through extensions.
      adapt("config.top_k", "dropped", "the Chat Completions wire has no top_k (Anthropic and Gemini carry it; servers that accept it take it through extensions)", {
        asked: config.topK,
        provider: this.provider,
      });
    }
    if (config.seed !== undefined) payload["seed"] = config.seed;
    if (config.frequencyPenalty !== undefined) payload["frequency_penalty"] = wireFloat(config.frequencyPenalty);
    if (config.presencePenalty !== undefined) payload["presence_penalty"] = wireFloat(config.presencePenalty);
    if (config.stop && config.stop.length > 0) payload["stop"] = [...config.stop];
    if (config.logprobs !== undefined) {
      payload["logprobs"] = true;
      if (config.logprobs > 0) payload["top_logprobs"] = config.logprobs;
    }
    if (request.tools && request.tools.length > 0) {
      const wire: JsonObject[] = [];
      for (const tool of request.tools) {
        if (tool.type === "function") {
          const fn: JsonObject = { name: tool.name, description: tool.description ?? null, parameters: tool.parameters ?? { type: "object", properties: {} } };
          if (compat.strictTools === "include") fn["strict"] = false;
          wire.push({ type: "function", function: fn });
        } else wire.push(this.builtinToolPayload(tool, compat));
      }
      if (wire.length > 0) payload["tools"] = wire;
    }
    let toolChoice = this.toolChoicePayload(request);
    if (toolChoice !== undefined) {
      const tc = config.toolChoice!;
      const mode = tc.mode ?? "auto";
      if (compat.forcedToolChoice === "reject" && (mode !== "auto" || (tc.allowed && tc.allowed.length > 0))) {
        // The server documents tool_choice=auto only and ignores every other
        // form without an error (Z.AI, live 2026-09-03: required → text
        // answer, none → a tool call). MAP-13: "none" and an allowlist have a
        // client-side form — send no tools / only those tools — and are
        // recorded; "required" cannot be forced and the program depends on
        // the call (rule 4b): refused.
        if (mode === "required") {
          throw new UnsupportedFeatureError(
            `${this.provider}: tool_choice mode='required' is silently ignored by this server (only 'auto' is honoured) and a forced call cannot be reproduced client-side`,
            { provider: this.provider, feature: "config.tool_choice.mode" },
          );
        }
        if (mode === "none") {
          adapt("config.tool_choice.mode", "client_side", "this server ignores tool_choice='none'; no tools were sent, which is the same outcome", {
            asked: "none",
            applied: "no tools sent",
            provider: this.provider,
          });
          delete payload["tools"];
        } else {
          const allowed = tc.allowed ?? [];
          const kept = ((payload["tools"] as JsonObject[] | undefined) ?? []).filter((t) => allowed.includes(str((t["function"] as JsonObject | undefined)?.["name"])));
          adapt("config.tool_choice.allowed", "client_side", "this server ignores tool_choice allowlists; only the allowed tools were sent, which is what the allowlist means", {
            asked: [...allowed],
            applied: kept.map((t) => str((t["function"] as JsonObject)["name"])),
            provider: this.provider,
          });
          payload["tools"] = kept;
        }
        toolChoice = "auto";
      }
      payload["tool_choice"] = toolChoice as JsonObject;
    }
    if (config.toolChoice?.parallel !== undefined) payload["parallel_tool_calls"] = config.toolChoice.parallel;
    if (config.responseFormat) {
      if (compat.jsonSchema === "reject" && config.responseFormat.type !== "json_object") {
        // The server accepts response_format.type=json_schema and ignores it
        // (Z.AI, live 2026-09-03: HTTP 200, fenced JSON with keys the schema
        // never named). json_object is honoured. MAP-13: omit and record.
        adapt(
          "config.response_format",
          "dropped",
          `this server accepts response_format type ${JSON.stringify(config.responseFormat.type)} and does not apply it; use {'type': 'json_object'} and describe the shape in the prompt`,
          { asked: config.responseFormat as unknown as JsonObject, provider: this.provider },
        );
      } else {
        // MAP-14: the judgment convention goes verbatim on the chat dialect
        // (api.openai.com strict honours it, receipted 2026-09-17); a server
        // that scores named tokens delivers probabilities through the trie
        // driver, every other one answers with the pick only.
        if (!this.scoresNamedTokens(compat)) noteUnmeasurableProbabilities(request, this.provider);
        payload["response_format"] = responseFormatToChat(config.responseFormat);
      }
    }
    if (config.reasoning) {
      let reasoning: Reasoning | undefined = config.reasoning;
      if (compat.thinkingFormat === "none") {
        // No reasoning dial on this server. MAP-13: the dial is dropped and
        // recorded — the model may reason at its own default and the tokens
        // show in usage. (The 2026-09-11 refusal rested on an ollama preset
        // written without a receipt; Ollama maps reasoning_effort to `think`
        // — THEORY.md §3.17.)
        adapt(
          "config.reasoning",
          "dropped",
          "this server has no reasoning dial on its wire (compat thinking_format='none'); the model reasons at its own default; pass the server's own knob through extensions",
          { asked: { effort: reasoning.effort }, provider: this.provider },
        );
        reasoning = undefined;
      }
      if (reasoning !== undefined && reasoning.effort !== "off") {
        // MAP-7: verbatim effort; no budget on this wire; summary is a
        // visibility knob where one exists (Groq include_reasoning).
        if (reasoning.thinkingBudget !== undefined) {
          adapt("config.reasoning.thinking_budget", "dropped", "the Chat Completions wire has no thinking token budget; effort carries the intent", {
            asked: reasoning.thinkingBudget,
            provider: this.provider,
          });
        }
        if (reasoning.summary === "concise" || reasoning.summary === "detailed") {
          adapt("config.reasoning.summary", "substituted", "the Chat Completions wire has no summary detail levels; 'auto' is what it shows", {
            asked: reasoning.summary,
            applied: "auto",
            provider: this.provider,
          });
          reasoning = { ...reasoning, summary: "auto" };
        }
        let effort: string = reasoning.effort;
        if (compat.reasoningEfforts !== undefined && !compat.reasoningEfforts.includes(effort)) {
          // MAP-13: clamp to the nearest declared level; the server would have
          // accepted the word silently (Moonshot answered 200 to `medium` and to `bogus`, live 2026-09-03).
          const nearest = nearestEffort(effort, compat.reasoningEfforts);
          adapt(
            "config.reasoning.effort",
            "clamped",
            `this server has no ${JSON.stringify(effort)} level (it accepts ${compat.reasoningEfforts.join(", ")}) and would have accepted the word silently`,
            { asked: effort, applied: nearest, provider: this.provider },
          );
          effort = nearest;
        }
        if (compat.builtinTools === "groq" && reasoning.summary === "auto") payload["reasoning_format"] = "parsed";
        switch (compat.thinkingFormat) {
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
          case "kimi":
            payload["reasoning_effort"] = effort;
            break;
          case "qwen":
            payload["enable_thinking"] = true;
            break;
          case "qwen_chat_template":
            payload["chat_template_kwargs"] = { enable_thinking: true, preserve_thinking: true };
            break;
        }
      } else if (reasoning !== undefined) {
        switch (compat.thinkingFormat) {
          case "reasoning_effort":
            payload["reasoning_effort"] = "none";
            break;
          case "openrouter":
            payload["reasoning"] = { enabled: false };
            break;
          case "deepseek":
          case "kimi":
            payload["thinking"] = { type: "disabled" };
            break;
          case "qwen":
            payload["enable_thinking"] = false;
            break;
          case "qwen_chat_template":
            payload["chat_template_kwargs"] = { enable_thinking: false };
            break;
        }
      }
    }
    cacheCommonPayload(request, payload, compat.cacheControl, this.provider);
    if (compat.routing !== undefined) payload["provider"] = compat.routing;
    if (config.serviceTier !== undefined) payload["service_tier"] = config.serviceTier;
    if (config.userId !== undefined) payload[compat.userField] = config.userId;
    if (config.store !== undefined) payload["store"] = config.store;
    if (config.extensions) {
      const reserved = new Set(["prompt_caching", "cache", "compat", "openai_compat", "openai_chat_compat"]);
      for (const [k, v] of Object.entries(config.extensions)) if (!reserved.has(k)) payload[k] = v;
    }
    return payload;
  }

  wireRequest(request: Request, stream: boolean): EmitOptions {
    request = Request.create(request);
    return {
      method: "POST",
      url: `${this.base()}/chat/completions`,
      endpoint: "chat/completions",
      stream,
      model: request.model,
      headers: this.headers(),
      payload: this.payload(request, stream),
    };
  }

  // ─── Judgments by candidate-sequence likelihood (MAP-14 §4) ───────
  // The pure hooks live in token_trie.ts; this is the driver, sequenced
  // like files and batch: tokenize calls, ONE scoring call, the fold.

  private judgmentsViaTokenScoring(request: Request): boolean {
    const policy = request.config?.probabilities;
    return this.scoresNamedTokens(this.compatFor(request.model)) && (policy === "if_available" || policy === "required") && requestJudgments(request).size > 0;
  }

  /** The conversation, the judgment's question as a final user turn, and the assistant's answer so far (prefill + key). */
  protected judgmentMessages(request: Request, j: Judgment, answer: string): JsonObject[] {
    const messages = this.buildMessages(request, this.compatFor(request.model));
    messages.push({ role: "user", content: judgmentAsk(j) });
    messages.push({ role: "assistant", content: answer });
    return messages;
  }

  protected judgmentTokenizeRequest(request: Request, j: Judgment, answer: string, continueFinal: boolean): Promise<TransportRequest> {
    const root = this.base().replace(/\/v1$/, "");
    return this.emit({
      method: "POST",
      url: `${root}/tokenize`,
      endpoint: "tokenize",
      model: request.model,
      headers: this.headers(),
      payload: tokenizePayload(request.model, this.judgmentMessages(request, j, answer), continueFinal),
    });
  }

  protected judgmentScoreRequest(model: string, prompts: number[][], tokenIds: number[]): Promise<TransportRequest> {
    return this.emit({ method: "POST", url: `${this.base()}/completions`, endpoint: "completions", model, headers: this.headers(), payload: scorePayload(model, prompts, tokenIds) });
  }

  private judgmentAdaptations(): readonly Adaptation[] {
    const scope = new AdaptationScope(this.adaptations, this.provider);
    collecting(scope, () =>
      adapt(
        "config.response_format",
        "client_side",
        "each judgment is asked as a final user turn and every declared key is scored as a token path (candidate-sequence likelihood, MAP-14 §4) instead of a generated JSON object; questions are scored independently",
        { provider: this.provider },
      ),
    );
    return scope.records;
  }

  override async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    request = Request.create(request);
    if (!this.judgmentsViaTokenScoring(request)) return super.complete(request, opts);
    const adaptations = this.judgmentAdaptations();
    const found = requestJudgments(request);
    const tokenized: Array<{ j: Judgment; prefix: number[]; paths: Map<string, number[]> }> = [];
    let calls = 0;
    const tokens = async (j: Judgment, answer: string, continueFinal: boolean): Promise<number[]> => {
      calls++;
      return tokensFromBody((await this.sendOk(await this.judgmentTokenizeRequest(request, j, answer, continueFinal))).text());
    };
    for (const j of found.values()) {
      const prefix = await tokens(j, JUDGMENT_PREFILL, true);
      const keys = new Map<string, readonly [number[], number[]]>();
      for (const k of j.keys) keys.set(k, [await tokens(j, `${JUDGMENT_PREFILL} ${k}`, true), await tokens(j, `${JUDGMENT_PREFILL} ${k}`, false)]);
      tokenized.push({ j, prefix, paths: keyPaths(prefix, keys) });
    }
    // One batched scoring call over every trie node of every judgment.
    const prompts: number[][] = [];
    const meta: Array<{ index: number; key: string }> = [];
    const union = new Set<number>();
    const nodesPer = tokenized.map(({ paths }) => trieNodes(paths));
    tokenized.forEach(({ prefix }, index) => {
      for (const [key, node] of nodesPer[index]!) {
        prompts.push([...prefix, ...node.prefix]);
        meta.push({ index, key });
        for (const t of node.children) union.add(t);
      }
    });
    const { scores, usage, model } = scoresFromBody((await this.sendOk(await this.judgmentScoreRequest(request.model, prompts, [...union]))).text(), prompts.length);
    const tables: Array<Map<string, Map<number, number>>> = tokenized.map(() => new Map());
    for (const [i, { index, key }] of meta.entries()) {
      const got = scores[i]!;
      const children = nodesPer[index]!.get(key)!.children;
      for (const t of children) if (!got.has(t)) return this.judgmentUnmeasured(request, opts);
      tables[index]!.set(key, new Map([...children].map((t) => [t, got.get(t)!])));
    }
    const value: JsonObject = {};
    const probabilities: Record<string, Record<string, number>> = {};
    const coverage: Record<string, number> = {};
    tokenized.forEach(({ j, paths }, index) => {
      const folded = foldJudgment(paths, tables[index]!);
      probabilities[j.name] = folded.distribution;
      coverage[j.name] = folded.coverage;
      let best = j.keys[0]!;
      for (const k of j.keys) if (folded.distribution[k]! > folded.distribution[best]!) best = k;
      value[j.name] = j.kind === "boolean" ? best === "true" : j.kind === "ordered" ? Number(best) : best;
    });
    const part = normalizePart({ type: "data", value, probabilities, method: "candidate_sequence_likelihood" });
    const response = new Response({
      model: model ?? request.model,
      message: { role: "assistant", parts: [part] },
      finishReason: "stop",
      usage: Usage.create({ inputTokens: Number(usage["prompt_tokens"] ?? 0) || 0, outputTokens: Number(usage["completion_tokens"] ?? 0) || 0 }),
      providerData: { coverage, judgments: { nodes: prompts.length, tokenize_calls: calls, method: "candidate_sequence_likelihood" } },
    });
    return this.finishResponse(request, response, adaptations);
  }

  /**
   * The server answered 200 without the requested token ids: it dropped
   * `logprob_token_ids` (receipted on vLLM 0.25.1). `required` refuses;
   * `if_available` answers by structured output instead and records it.
   */
  private async judgmentUnmeasured(request: Request, opts: { signal?: AbortSignal }): Promise<Response> {
    if (request.config?.probabilities === "required") {
      throw new UnsupportedFeatureError(`${this.provider}: config.probabilities='required' but this server ignored logprob_token_ids (vLLM < 0.29?); no distribution can be measured here`, {
        provider: this.provider,
        feature: "config.probabilities",
      });
    }
    const scope = new AdaptationScope(this.adaptations, this.provider);
    collecting(scope, () =>
      adapt("config.probabilities", "dropped", "the server accepted the request and returned no log-probs for the requested token ids (logprob_token_ids ignored); answered by structured output instead", {
        asked: request.config?.probabilities,
        provider: this.provider,
      }),
    );
    const built = await this.build(request, false);
    const resp = await this.send(built.request, opts.signal);
    if (resp.status >= 400) throw attachErrorMetadata(this.normalizeError(resp.status, resp.text()), resp);
    return this.finishResponse(request, this.parseResponse(request, resp), [...scope.records, ...built.adaptations.filter((a) => a.field !== "config.probabilities")]);
  }

  // ─── Response ────────────────────────────────────────────────────

  /** @internal shared with the module-level reader */
  static finishReasonOf(raw: unknown, hasToolCall: boolean, unmapped: Unmapped, path = "choices[0]"): FinishReason {
    return OpenAIChatLM.finishReason(raw, hasToolCall, unmapped, path);
  }

  protected static finishReason(raw: unknown, hasToolCall: boolean, unmapped: Unmapped, path = "choices[0]"): FinishReason {
    if (hasToolCall) return "tool_call";
    if (raw === null || raw === undefined || raw === "") return "stop";
    const mapped = FINISH_REASON_MAP[str(raw)];
    if (mapped === undefined) {
      recordUnmapped(unmapped, `${path}.finish_reason`, raw);
      return "stop";
    }
    return mapped;
  }

  parseResponse(request: Request, response: HttpResponse): Response {
    return foldJudgments(responseFromChatBody(this.provider, response.json(), { model: request.model }, (code, message) => this.responseError(code, message)), request);
  }

  /**
   * A Chat Completions response body → canonical `Response` under this
   * adapter's provider name and error mapping (MAP-12 rule 9); see
   * `responseFromOpenAIChat`.
   */
  responseFromOpenAIChat(body: unknown, opts: { model?: string; choice?: number } = {}): Response {
    return responseFromChatBody(this.provider, body, opts, (code, message) => this.responseError(code, message));
  }

  // ─── Stream ──────────────────────────────────────────────────────

  parseStreamEvents(_request: Request, raw: SSEEvent): StreamEvent[] {
    if (!raw.data) return [];
    if (raw.data === "[DONE]") return [{ type: "end" }];
    const payload = parseJson(raw.data);
    if (!isJsonObject(payload)) return [];
    const err = payload["error"];
    if (isJsonObject(err)) {
      return [{ type: "error", error: errorDetail(str(err["code"] ?? err["type"]) || "provider", str(err["message"])) }];
    }
    const events: StreamEvent[] = [];
    const choices = list(payload["choices"]);
    const choice = choices.length > 0 && isJsonObject(choices[0]) ? choices[0] : {};
    const delta = obj(choice["delta"]);

    const reasoningText = delta["reasoning_content"] || delta["reasoning"];
    if (reasoningText) events.push({ type: "delta", delta: { type: "thinking", text: str(reasoningText), partIndex: 0 } });

    const content = delta["content"];
    if (typeof content === "string" && content) {
      const logprobs = openaiTokenLogprobs(obj(choice["logprobs"])["content"]);
      events.push({ type: "delta", delta: { type: "text", text: content, partIndex: 0, ...(logprobs.length > 0 ? { logprobs } : {}) } });
    }
    for (const call of list(delta["tool_calls"])) {
      if (!isJsonObject(call)) continue;
      const fn = obj(call["function"]);
      const id = str(call["id"]);
      const name = str(fn["name"]);
      events.push({
        type: "delta",
        delta: { type: "tool_call", input: str(fn["arguments"]), partIndex: int(call["index"]) ?? 0, ...(id ? { id } : {}), ...(name ? { name } : {}) },
      });
    }
    const finishRaw = choice["finish_reason"];
    const usageData = payload["usage"];
    if (finishRaw) {
      events.push({
        type: "end",
        finishReason: FINISH_REASON_MAP[str(finishRaw)] ?? "stop",
        ...(isJsonObject(usageData) ? { usage: usageFromChat(usageData) } : {}),
        providerData: payload,
      });
    } else if (isJsonObject(usageData)) {
      events.push({ type: "end", usage: usageFromChat(usageData), providerData: payload });
    }
    return events;
  }
}

// ─── Ingest: a Chat Completions request body → canonical Request (MAP-12) ─
//
// The decoder for chatContentParts / responseFormatToChat above and for
// OpenAIChatLM.buildMessages / payload. It reads ONE preset's spellings
// (the same ResolvedOpenAIChatCompat the builder writes with), so for every
// canonical Request r the builder can carry losslessly,
// requestFromOpenAIChat(build(r)) equals r; the lossy cells are enumerated
// in docs/mapping-rules.md MAP-12 and pinned per case by the contract's
// `ingest` direction. Every wire key has exactly one verdict
// (lm15-contract/tools/openai-chat-ingest-verdicts.json, copied here as
// data): map, extensions, refuse, call-mode (stream, stream_options: read
// and dropped) or default (equal to the wire default, reads as absent). A
// key with no verdict is refused. Malformed input is ValueError / TypeError,
// like the type system's own validators (MAP-12 rule 6).

// Top-level keys forwarded verbatim into config.extensions: generation knobs
// OpenAI documents that no canonical field expresses and that the builder
// re-emits verbatim, so they round-trip. prediction: a latency hint
// (predicted outputs); harmless verbatim on OpenAI (decision 2026-09-14 §4.9).
const INGEST_EXTENSIONS_KEYS = new Set(["logit_bias", "metadata", "verbosity", "moderation", "provider", "prediction"]);

const INGEST_REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  n: "lm15 reads one choice per response; n>1 would silently lose choices — fan out in the caller",
  audio: "audio output parameters have no canonical slot on the chat surface",
  modalities: "output modality selection has no canonical slot on the chat surface",
  web_search_options: "a server-executed search the chat dialect cannot map to parts (MAP-1); the Responses dialect carries web_search as a BuiltinTool",
});

const INGEST_CALL_MODE_KEYS = new Set(["stream", "stream_options"]);

const INGEST_CONFIG_KEYS = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls",
  // functions / function_call: the deprecated function-calling shape, translated to tools / tool_choice (MAP-13: a pure spelling change).
  "functions", "function_call",
  "max_completion_tokens", "max_tokens", "temperature", "top_p", "top_k", "stop",
  "seed", "frequency_penalty", "presence_penalty",
  "logprobs", "top_logprobs", "response_format", "service_tier", "store",
  "user", "safety_identifier", "user_id",
  "reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "reasoning_format",
  "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options",
]);

const INGEST_GROQ_BUILTIN_INVERSE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(GROQ_BUILTIN_MAP).map(([name, wire]) => [wire, name])),
);

const INGEST_AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({ wav: "audio/wav", mp3: "audio/mpeg" });

function ingestRefuse(provider: string, what: string, why: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(`${provider}: ${what} cannot be carried by a canonical Request — ${why}`, { provider });
}

/** The deprecated `function_call` spelling → the `tool_choice` shape. */
function toolChoiceFromFunctionCall(raw: unknown): unknown {
  if (raw === "none" || raw === "auto") return raw;
  if (isJsonObject(raw) && "name" in raw) return { type: "function", function: { name: raw["name"] } };
  throw new ValueError(`function_call must be 'none', 'auto', or {name}; got ${JSON.stringify(raw)}`);
}

function ingestObject(value: unknown, where: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${where} must be a JSON object, got ${typeName(value)}`);
  return value;
}

function ingestStr(value: unknown, where: string): string {
  if (typeof value !== "string") throw new TypeError(`${where} must be a string, got ${typeName(value)}`);
  return value;
}

/** `null` reads as absent everywhere a caller might write it. */
function present(obj: JsonObject, key: string): unknown {
  const v = obj[key];
  return v === null ? undefined : v;
}

/**
 * Assistant-row keys that are a client library's object model, not the
 * wire (litellm's ChatCompletionMessage dumped back into history; MAP-12
 * addendum 2026-09-08). Their null or empty form carries nothing and reads
 * as absent; a non-empty one is refused with the key named.
 */
const INGEST_CLIENT_OBJECT_KEYS: readonly string[] = Object.freeze(["provider_specific_fields", "thinking_blocks", "images"]);

function ingestIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isJsonObject(value)) {
    const values = Object.values(value);
    // A dict whose every value is null/empty (litellm: {"refusal": null}).
    return values.length === 0 || values.every((v) => v === null || (Array.isArray(v) && v.length === 0) || (isJsonObject(v) && Object.keys(v).length === 0));
  }
  return false;
}

/**
 * OpenAI's assistant `annotations` (url_citation entries with a span into
 * the content) → CitationParts; an empty list is nothing (MAP-12 addendum).
 */
function ingestAnnotations(provider: string, raw: unknown, contentText: string | undefined, where: string): CitationPart[] {
  if (!Array.isArray(raw)) throw new TypeError(`${where}.annotations must be an array`);
  return raw.map((entryRaw, index) => {
    const entryWhere = `${where}.annotations[${index}]`;
    const entry = ingestObject(entryRaw, entryWhere);
    if (entry["type"] !== "url_citation") {
      throw ingestRefuse(provider, `${entryWhere} of type ${JSON.stringify(entry["type"] ?? null)}`, "only url_citation annotations have a canonical part (CitationPart)");
    }
    ingestOnlyKeys(provider, entry, ["type", "url_citation"], entryWhere);
    const spec = ingestObject(entry["url_citation"], `${entryWhere}.url_citation`);
    ingestOnlyKeys(provider, spec, ["url", "title", "start_index", "end_index"], `${entryWhere}.url_citation`);
    let span: string | undefined;
    const start = spec["start_index"];
    const end = spec["end_index"];
    if (contentText !== undefined && Number.isInteger(start) && Number.isInteger(end)
        && (start as number) >= 0 && (start as number) <= (end as number) && (end as number) <= contentText.length) {
      span = contentText.slice(start as number, end as number) || undefined;
    }
    const title = present(spec, "title");
    return citation({
      url: ingestStr(present(spec, "url"), `${entryWhere}.url_citation.url`),
      ...(title === undefined ? {} : { title: ingestStr(title, `${entryWhere}.url_citation.title`) }),
      ...(span === undefined ? {} : { text: span }),
    });
  });
}

/** An unlisted key inside a block or object is a refusal, never a drop. */
function ingestOnlyKeys(provider: string, obj: JsonObject, allowed: readonly string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k)).sort();
  if (extra.length > 0) throw ingestRefuse(provider, `${where} key ${JSON.stringify(extra[0])}`, "no canonical slot for it");
}

/** `data:<media_type>;base64,<payload>` → [media_type, payload]; the inverse of mediaDataUri. */
function ingestDataUri(value: string, where: string): [string, string] {
  if (!value.startsWith("data:")) throw new ValueError(`${where} must be a base64 data URI`);
  const comma = value.indexOf(",");
  const head = comma < 0 ? "" : value.slice(5, comma);
  const payload = comma < 0 ? "" : value.slice(comma + 1);
  if (comma < 0 || !head.endsWith(";base64") || payload === "") {
    throw new ValueError(`${where} must be a base64 data URI (data:<media-type>;base64,<payload>)`);
  }
  const mediaType = head.slice(0, -";base64".length);
  if (mediaType === "") throw new ValueError(`${where} data URI has no media type`);
  return [mediaType, payload];
}

function ingestImageBlock(provider: string, block: JsonObject, where: string): ImagePart {
  ingestOnlyKeys(provider, block, ["type", "image_url", "prompt_cache_breakpoint"], where);
  const spec = ingestObject(present(block, "image_url"), `${where}.image_url`);
  ingestOnlyKeys(provider, spec, ["url", "detail"], `${where}.image_url`);
  const url = ingestStr(present(spec, "url"), `${where}.image_url.url`);
  const detail = present(spec, "detail") as ImageDetail | undefined;
  if (url.startsWith("data:")) {
    const [mediaType, payload] = ingestDataUri(url, `${where}.image_url.url`);
    return image({ data: payload, mediaType, ...(detail !== undefined ? { detail } : {}) });
  }
  // The wire carries no media type for a URL: guessed from the path, else the default.
  const guessed = guessMediaType(url.split(/[?#]/, 1)[0] ?? url);
  return image({ url, ...(guessed?.startsWith("image/") ? { mediaType: guessed } : {}), ...(detail !== undefined ? { detail } : {}) });
}

function ingestHasBreakpoint(block: JsonObject, where: string): boolean {
  const mark = present(block, "prompt_cache_breakpoint");
  if (mark === undefined) return false;
  const m = ingestObject(mark, `${where}.prompt_cache_breakpoint`);
  if (Object.keys(m).length !== 1 || m["mode"] !== "explicit") {
    throw new ValueError(`${where}.prompt_cache_breakpoint must be {"mode": "explicit"}`);
  }
  if (block["type"] !== "text") throw new ValueError(`${where}: a prompt_cache_breakpoint rides on a text block, not ${JSON.stringify(block["type"])}`);
  return true;
}

/** A row's `content` → parts, plus whether its LAST block carries the breakpoint. */
function ingestContentBlocks(provider: string, content: unknown, role: string, where: string): [Part[], boolean] {
  if (typeof content === "string") return [[text(content)], false];
  if (!Array.isArray(content)) throw new TypeError(`${where}.content must be a string or an array of content parts`);
  const parts: Part[] = [];
  let breakpointAtEnd = false;
  content.forEach((raw, index) => {
    const blockWhere = `${where}.content[${index}]`;
    const block = ingestObject(raw, blockWhere);
    const kind = block["type"];
    const marked = ingestHasBreakpoint(block, blockWhere);
    if (marked && index !== content.length - 1) {
      throw new ValueError(`${blockWhere}: a prompt_cache_breakpoint marks the end of a message; it must be on the last block`);
    }
    breakpointAtEnd ||= marked;
    if (kind === "text") {
      ingestOnlyKeys(provider, block, ["type", "text", "prompt_cache_breakpoint"], blockWhere);
      parts.push(text(ingestStr(present(block, "text"), `${blockWhere}.text`)));
    } else if (kind === "image_url" && (role === "user" || role === "tool")) {
      parts.push(ingestImageBlock(provider, block, blockWhere));
    } else if (kind === "input_audio" && role === "user") {
      ingestOnlyKeys(provider, block, ["type", "input_audio", "prompt_cache_breakpoint"], blockWhere);
      const spec = ingestObject(present(block, "input_audio"), `${blockWhere}.input_audio`);
      ingestOnlyKeys(provider, spec, ["data", "format"], `${blockWhere}.input_audio`);
      const fmt = ingestStr(present(spec, "format"), `${blockWhere}.input_audio.format`);
      const mediaType = INGEST_AUDIO_MEDIA_TYPES[fmt];
      if (!mediaType) throw new ValueError(`${blockWhere}.input_audio.format must be one of ["mp3", "wav"]`);
      parts.push(audio({ data: ingestStr(present(spec, "data"), `${blockWhere}.input_audio.data`), mediaType }));
    } else if (kind === "file" && role === "user") {
      ingestOnlyKeys(provider, block, ["type", "file", "prompt_cache_breakpoint"], blockWhere);
      const spec = ingestObject(present(block, "file"), `${blockWhere}.file`);
      ingestOnlyKeys(provider, spec, ["file_data", "file_id", "filename"], `${blockWhere}.file`);
      if (present(spec, "filename") !== undefined) throw ingestRefuse(provider, `${blockWhere}.file.filename`, "DocumentPart has no filename slot");
      const fileId = present(spec, "file_id");
      const fileData = present(spec, "file_data");
      if (fileId !== undefined && fileData === undefined) parts.push(document({ fileId: ingestStr(fileId, `${blockWhere}.file.file_id`) }));
      else if (fileData !== undefined && fileId === undefined) {
        const [mediaType, payload] = ingestDataUri(ingestStr(fileData, `${blockWhere}.file.file_data`), `${blockWhere}.file.file_data`);
        parts.push(document({ data: payload, mediaType }));
      } else throw new ValueError(`${blockWhere}.file needs exactly one of file_data / file_id`);
    } else if (kind === "refusal" && role === "assistant") {
      ingestOnlyKeys(provider, block, ["type", "refusal"], blockWhere);
      parts.push(refusal(ingestStr(present(block, "refusal"), `${blockWhere}.refusal`)));
    } else {
      throw ingestRefuse(
        provider,
        `${blockWhere} of type ${JSON.stringify(kind)} in a ${role} message`,
        "no canonical part for that block on this wire (a part is not a knob: there is no extensions door for content)",
      );
    }
  });
  return [parts, breakpointAtEnd];
}

function ingestToolCalls(provider: string, calls: unknown, where: string): ToolCallPart[] {
  if (!Array.isArray(calls)) throw new TypeError(`${where}.tool_calls must be an array`);
  return calls.map((raw, index) => {
    const callWhere = `${where}.tool_calls[${index}]`;
    const call = ingestObject(raw, callWhere);
    const kind = call["type"] ?? "function";
    if (kind !== "function") throw ingestRefuse(provider, `${callWhere} of type ${JSON.stringify(kind)}`, "only function tool calls have a canonical part");
    ingestOnlyKeys(provider, call, ["id", "type", "function"], callWhere);
    const fn = ingestObject(present(call, "function"), `${callWhere}.function`);
    ingestOnlyKeys(provider, fn, ["name", "arguments"], `${callWhere}.function`);
    const args = present(fn, "arguments");
    // The builder writes JSON.stringify(input); the inverse is exact (the
    // lenient provider-output parse is not used on caller input).
    let input: unknown;
    if (args === undefined || args === "") input = {};
    else if (typeof args === "string") {
      try {
        input = parseJson(args);
      } catch (e) {
        throw new ValueError(`${callWhere}.function.arguments is not JSON: ${(e as Error).message}`);
      }
    } else input = args;
    if (!isJsonObject(input)) throw new ValueError(`${callWhere}.function.arguments must encode a JSON object`);
    return toolCall(ingestStr(present(call, "id"), `${callWhere}.id`), ingestStr(present(fn, "name"), `${callWhere}.function.name`), input);
  });
}

interface IngestRows {
  system: string | Part[] | undefined;
  messages: Message[];
  systemBreakpoint: boolean;
  breakpointIndex: number | undefined;
}

function ingestRows(provider: string, rows: unknown): IngestRows {
  if (!Array.isArray(rows)) throw new TypeError("messages must be an array");
  const out: IngestRows = { system: undefined, messages: [], systemBreakpoint: false, breakpointIndex: undefined };
  let pending: ToolResultPart[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      out.messages.push(Message.tool(pending));
      pending = [];
    }
  };
  rows.forEach((raw, index) => {
    const where = `messages[${index}]`;
    const row = ingestObject(raw, where);
    const role = row["role"];
    if (present(row, "name") !== undefined && role !== "tool") {
      throw ingestRefuse(provider, `${where}.name`, "a per-message participant name has no canonical slot");
    }
    if (role === "system" || role === "developer") {
      flush();
      ingestOnlyKeys(provider, row, ["role", "content"], where);
      const [parts, marked] = ingestContentBlocks(provider, row["content"], "system", where);
      if (index === 0) {
        out.systemBreakpoint ||= marked;
        out.system = parts.length === 1 && parts[0]!.type === "text" ? (parts[0] as TextPart).text : parts;
      } else {
        if (marked) out.breakpointIndex = out.messages.length;
        out.messages.push(Message.developer(parts as PromptPart[]));
      }
    } else if (role === "user") {
      flush();
      ingestOnlyKeys(provider, row, ["role", "content", "name"], where);
      const [parts, marked] = ingestContentBlocks(provider, row["content"], "user", where);
      if (marked) {
        if (out.breakpointIndex !== undefined || out.systemBreakpoint) throw new ValueError(`${where}: a request carries at most one prompt_cache_breakpoint`);
        out.breakpointIndex = out.messages.length;
      }
      out.messages.push(Message.user(parts as PromptPart[]));
    } else if (role === "assistant") {
      flush();
      ingestOnlyKeys(provider, row, ["role", "content", "tool_calls", "refusal", "reasoning_content", "name", "audio", "function_call", "annotations", ...INGEST_CLIENT_OBJECT_KEYS], where);
      if (present(row, "audio") !== undefined) throw ingestRefuse(provider, `${where}.audio`, "an assistant audio reference has no canonical part");
      if (present(row, "function_call") !== undefined) throw ingestRefuse(provider, `${where}.function_call`, "the deprecated function-calling shape; use tool_calls");
      for (const key of INGEST_CLIENT_OBJECT_KEYS) {
        // A client library's object model (litellm) dumped into history:
        // null or empty carries nothing; anything else has no mapping.
        if (!ingestIsEmpty(row[key])) throw ingestRefuse(provider, `${where}.${key}`, "a client library's own field with no canonical part; only its empty form reads as absent");
      }
      const parts: Part[] = [];
      const reasoningText = present(row, "reasoning_content");
      if (reasoningText !== undefined) parts.push(thinking(ingestStr(reasoningText, `${where}.reasoning_content`)));
      const content = present(row, "content");
      if (content !== undefined) {
        const [textParts, marked] = ingestContentBlocks(provider, content, "assistant", where);
        if (marked) throw new ValueError(`${where}: a prompt_cache_breakpoint cannot mark an assistant message (the builder refuses the same cell)`);
        parts.push(...textParts);
      }
      const refusalText = present(row, "refusal");
      if (refusalText !== undefined) parts.push(refusal(ingestStr(refusalText, `${where}.refusal`)));
      const calls = present(row, "tool_calls");
      if (calls !== undefined) parts.push(...ingestToolCalls(provider, calls, where));
      const annotations = present(row, "annotations");
      if (annotations !== undefined) parts.push(...ingestAnnotations(provider, annotations, typeof content === "string" ? content : undefined, where));
      if (parts.length === 0) parts.push(text("")); // MAP-2, applied to history
      out.messages.push(Message.assistant(parts as AssistantPart[]));
    } else if (role === "tool") {
      ingestOnlyKeys(provider, row, ["role", "content", "tool_call_id", "name"], where);
      const [parts, marked] = ingestContentBlocks(provider, row["content"], "tool", where);
      if (marked) throw new ValueError(`${where}: a prompt_cache_breakpoint cannot mark a tool message (the builder refuses the same cell)`);
      const name = present(row, "name");
      pending.push(
        toolResult(
          ingestStr(present(row, "tool_call_id"), `${where}.tool_call_id`),
          parts as ToolResultContentPart[],
          name === undefined ? {} : { name: ingestStr(name, `${where}.name`) },
        ),
      );
    } else if (role === "function") {
      throw ingestRefuse(provider, `${where} with role 'function'`, "the deprecated function-calling shape; use a tool row with tool_call_id");
    } else {
      throw new ValueError(`${where}.role must be one of system, developer, user, assistant, tool; got ${JSON.stringify(role)}`);
    }
  });
  flush();
  return out;
}

function ingestTools(provider: string, raw: unknown, compat: ResolvedOpenAIChatCompat): Tool[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TypeError("tools must be an array");
  return raw.map((entryRaw, index) => {
    const where = `tools[${index}]`;
    const entry = ingestObject(entryRaw, where);
    const kind = entry["type"];
    if (kind === "function") {
      ingestOnlyKeys(provider, entry, ["type", "function"], where);
      const fn = ingestObject(present(entry, "function"), `${where}.function`);
      ingestOnlyKeys(provider, fn, ["name", "description", "parameters", "strict"], `${where}.function`);
      if (fn["strict"] === true) {
        throw ingestRefuse(provider, `${where}.function.strict = true`, "no per-tool strict slot (compat.strict_tools is a preset policy)");
      }
      const description = present(fn, "description");
      const parameters = present(fn, "parameters");
      return tool(ingestStr(present(fn, "name"), `${where}.function.name`), {
        ...(description === undefined ? {} : { description: ingestStr(description, `${where}.function.description`) }),
        ...(parameters === undefined ? {} : { parameters: ingestObject(parameters, `${where}.function.parameters`) }),
      });
    }
    if (typeof kind === "string" && kind in INGEST_GROQ_BUILTIN_INVERSE && compat.builtinTools === "groq") {
      const config: JsonObject = {};
      for (const [k, v] of Object.entries(entry)) if (k !== "type") config[k] = v;
      return builtinTool(INGEST_GROQ_BUILTIN_INVERSE[kind]!, Object.keys(config).length > 0 ? config : undefined);
    }
    throw ingestRefuse(provider, `${where} of type ${JSON.stringify(kind)}`, "only function tools (and, on the groq preset, its server-executed tools) have a canonical form");
  });
}

function ingestToolChoice(provider: string, raw: unknown, parallel: unknown): ToolChoice | undefined {
  let mode: ToolChoiceMode | undefined;
  let allowed: string[] = [];
  if (raw !== undefined) {
    if (raw === "none" || raw === "auto" || raw === "required") mode = raw;
    else if (isJsonObject(raw)) {
      const kind = raw["type"];
      if (kind === "function") {
        ingestOnlyKeys(provider, raw, ["type", "function"], "tool_choice");
        const fn = ingestObject(present(raw, "function"), "tool_choice.function");
        ingestOnlyKeys(provider, fn, ["name"], "tool_choice.function");
        mode = "required";
        allowed = [ingestStr(present(fn, "name"), "tool_choice.function.name")];
      } else if (kind === "allowed_tools") {
        ingestOnlyKeys(provider, raw, ["type", "allowed_tools"], "tool_choice");
        const spec = ingestObject(present(raw, "allowed_tools"), "tool_choice.allowed_tools");
        ingestOnlyKeys(provider, spec, ["mode", "tools"], "tool_choice.allowed_tools");
        mode = ingestStr(present(spec, "mode"), "tool_choice.allowed_tools.mode") as ToolChoiceMode;
        const entries = present(spec, "tools");
        if (!Array.isArray(entries) || entries.length === 0) throw new ValueError("tool_choice.allowed_tools.tools must be a non-empty array");
        allowed = entries.map((entryRaw, index) => {
          const where = `tool_choice.allowed_tools.tools[${index}]`;
          const entry = ingestObject(entryRaw, where);
          if (entry["type"] !== "function") throw ingestRefuse(provider, `${where} of type ${JSON.stringify(entry["type"])}`, "only function tools can be allowed on this wire");
          return ingestStr(present(ingestObject(present(entry, "function"), `${where}.function`), "name"), `${where}.function.name`);
        });
      } else if (kind === "custom") throw ingestRefuse(provider, "tool_choice of type 'custom'", "custom tools have no canonical form");
      else throw new ValueError(`tool_choice.type must be function or allowed_tools; got ${JSON.stringify(kind)}`);
    } else throw new ValueError("tool_choice must be none, auto, required, or an object");
  }
  if (parallel !== undefined && typeof parallel !== "boolean") throw new TypeError("parallel_tool_calls must be a boolean");
  if (mode === undefined && parallel === undefined) return undefined;
  return normalizeToolChoice({ mode: mode ?? "auto", allowed, parallel });
}

function ingestResponseFormat(provider: string, raw: unknown): ResponseFormat | undefined {
  const fmt = ingestObject(raw, "response_format");
  const kind = fmt["type"];
  if (kind === "text") {
    ingestOnlyKeys(provider, fmt, ["type"], "response_format");
    return undefined;
  }
  if (kind === "json_object") {
    ingestOnlyKeys(provider, fmt, ["type"], "response_format");
    return { type: "json_object" };
  }
  if (kind === "json_schema") {
    ingestOnlyKeys(provider, fmt, ["type", "json_schema"], "response_format");
    const inner = ingestObject(present(fmt, "json_schema"), "response_format.json_schema");
    ingestOnlyKeys(provider, inner, ["name", "schema", "strict", "description"], "response_format.json_schema");
    if (present(inner, "description") !== undefined) throw ingestRefuse(provider, "response_format.json_schema.description", "the canonical response_format has no description slot (INV-050)");
    const out: JsonObject = { type: "json_schema", schema: ingestObject(present(inner, "schema"), "response_format.json_schema.schema") };
    const name = present(inner, "name");
    if (name !== undefined && name !== "response") out["name"] = ingestStr(name, "response_format.json_schema.name");
    const strict = present(inner, "strict");
    if (strict !== undefined) {
      if (typeof strict !== "boolean") throw new TypeError("response_format.json_schema.strict must be a boolean");
      out["strict"] = strict;
    }
    return out as unknown as ResponseFormat;
  }
  throw new ValueError(`response_format.type must be text, json_object or json_schema; got ${JSON.stringify(kind)}`);
}

function ingestReasoning(provider: string, body: JsonObject, compat: ResolvedOpenAIChatCompat, extensions: JsonObject): Reasoning | undefined {
  const spellings = ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "reasoning_format"];
  const presentKeys = spellings.filter((k) => k in body);
  if (presentKeys.length === 0) return undefined;
  const spelledBy: string[] = {
    reasoning_effort: ["reasoning_effort"],
    openrouter: ["reasoning"],
    deepseek: ["thinking", "reasoning_effort"],
    kimi: ["thinking", "reasoning_effort"],
    qwen: ["enable_thinking"],
    qwen_chat_template: ["chat_template_kwargs"],
    none: [],
  }[compat.thinkingFormat]!.slice();
  if (compat.builtinTools === "groq") spelledBy.push("reasoning_format");
  const foreign = presentKeys.find((k) => !spelledBy.includes(k));
  if (foreign !== undefined) {
    const where = spelledBy.length === 0 ? "nowhere (no dial)" : JSON.stringify([...spelledBy].sort());
    throw ingestRefuse(provider, JSON.stringify(foreign), `this server's reasoning dial is spelled ${where}; another server's spelling would be sent and ignored`);
  }
  let effort: ReasoningEffort | undefined;
  let off = false;
  if ("reasoning_effort" in body) {
    const word = ingestStr(body["reasoning_effort"], "reasoning_effort");
    if (word === "none") off = true;
    else effort = word as ReasoningEffort;
  }
  if ("thinking" in body) {
    const spec = ingestObject(body["thinking"], "thinking");
    ingestOnlyKeys(provider, spec, ["type"], "thinking");
    if (spec["type"] === "disabled") {
      if (effort !== undefined) throw new ValueError("thinking.type=disabled next to a reasoning_effort level is contradictory");
      off = true;
    } else if (spec["type"] === "enabled") {
      if (effort === undefined && !off) throw ingestRefuse(provider, "thinking.type=enabled without reasoning_effort", "lm15's dial is a level (MAP-7); set config.reasoning with an effort word");
    } else throw new ValueError(`thinking.type must be enabled or disabled; got ${JSON.stringify(spec["type"])}`);
  }
  if ("reasoning" in body) {
    const spec = ingestObject(body["reasoning"], "reasoning");
    ingestOnlyKeys(provider, spec, ["effort", "enabled"], "reasoning");
    if (spec["enabled"] === false) off = true;
    else if (present(spec, "effort") !== undefined) effort = ingestStr(spec["effort"], "reasoning.effort") as ReasoningEffort;
    else throw new ValueError("reasoning must carry effort or enabled: false");
  }
  if ("enable_thinking" in body) {
    const flag = body["enable_thinking"];
    if (flag === false) off = true;
    else if (flag === true) throw ingestRefuse(provider, "enable_thinking = true", "this wire has no effort level; lm15's dial is a level (MAP-7) — set config.reasoning yourself");
    else throw new TypeError("enable_thinking must be a boolean");
  }
  if ("chat_template_kwargs" in body) {
    const spec = ingestObject(body["chat_template_kwargs"], "chat_template_kwargs");
    ingestOnlyKeys(provider, spec, ["enable_thinking", "preserve_thinking"], "chat_template_kwargs");
    if (spec["enable_thinking"] === false) off = true;
    else if (spec["enable_thinking"] === true) throw ingestRefuse(provider, "chat_template_kwargs.enable_thinking = true", "this wire has no effort level; lm15's dial is a level (MAP-7) — set config.reasoning yourself");
    else throw new TypeError("chat_template_kwargs.enable_thinking must be a boolean");
  }
  let summary: ReasoningSummary | undefined;
  if ("reasoning_format" in body) {
    const value = body["reasoning_format"];
    if (value !== "parsed") throw ingestRefuse(provider, `reasoning_format = ${JSON.stringify(value)}`, "only 'parsed' maps (Reasoning.summary='auto', MAP-7 rule 7)");
    if (effort === undefined) extensions["reasoning_format"] = value; // the documented door
    else summary = "auto";
  }
  if (off) return normalizeReasoning({ effort: "off" });
  if (effort === undefined) return undefined;
  return normalizeReasoning({ effort, summary });
}

function ingestCache(provider: string, body: JsonObject, compat: ResolvedOpenAIChatCompat, systemBreakpoint: boolean, breakpointIndex: number | undefined): CacheConfig | undefined {
  const keys = ["prompt_cache_key", "prompt_cache_options", "prompt_cache_retention"].filter((k) => k in body);
  const marked = systemBreakpoint || breakpointIndex !== undefined;
  if (keys.length === 0 && !marked) return undefined;
  if (compat.cacheControl !== "openai" && compat.cacheControl !== "openai_implicit") {
    throw ingestRefuse(provider, JSON.stringify(keys[0] ?? "prompt_cache_breakpoint"), "this server has no OpenAI prompt-cache control (compat.cache_control)");
  }
  if (marked && compat.cacheControl !== "openai") {
    throw ingestRefuse(provider, "prompt_cache_breakpoint", "this server swallows an explicit breakpoint silently (compat.cache_control=openai_implicit)");
  }
  const keyRaw = present(body, "prompt_cache_key");
  const key = keyRaw === undefined ? undefined : ingestStr(keyRaw, "prompt_cache_key");
  let retention: CacheRetention | undefined;
  if ("prompt_cache_retention" in body) {
    if (body["prompt_cache_retention"] !== "24h") throw ingestRefuse(provider, `prompt_cache_retention = ${JSON.stringify(body["prompt_cache_retention"])}`, "only '24h' has a canonical value (CacheConfig.retention='long')");
    retention = "long";
  }
  let explicit = false;
  if ("prompt_cache_options" in body) {
    const spec = ingestObject(body["prompt_cache_options"], "prompt_cache_options");
    ingestOnlyKeys(provider, spec, ["mode", "ttl"], "prompt_cache_options");
    if (present(spec, "ttl") !== undefined) throw ingestRefuse(provider, "prompt_cache_options.ttl", "CacheConfig.retention names 24h only");
    if (spec["mode"] === "explicit") explicit = true;
    else if (spec["mode"] === "implicit") throw ingestRefuse(provider, "prompt_cache_options.mode = 'implicit'", "the server default; a canonical CacheConfig names auto or off");
    else throw new ValueError(`prompt_cache_options.mode must be explicit or implicit; got ${JSON.stringify(spec["mode"])}`);
  }
  if (explicit && !marked) {
    if (key !== undefined || retention !== undefined) throw new ValueError("prompt_cache_options.mode=explicit with no breakpoint is the off switch; it cannot carry a key or retention (INV-027)");
    return normalizeCacheConfig({ mode: "off" });
  }
  if (systemBreakpoint) return normalizeCacheConfig({ prefix: "stable", key, retention });
  if (breakpointIndex !== undefined) return normalizeCacheConfig({ prefixUntilIndex: breakpointIndex, key, retention });
  return normalizeCacheConfig({ key, retention });
}

function ingestConfig(provider: string, body: JsonObject, compat: ResolvedOpenAIChatCompat, rows: IngestRows): Config {
  const cfg: Record<string, unknown> = {};
  const limits = ["max_completion_tokens", "max_tokens"].map((k) => present(body, k)).filter((v) => v !== undefined);
  if (limits.length > 0) {
    if (new Set(limits.map((v) => JSON.stringify(v))).size > 1) throw new ValueError(`max_tokens and max_completion_tokens disagree: ${JSON.stringify(limits)}`);
    cfg["maxTokens"] = limits[0];
  }
  if (present(body, "temperature") !== undefined) cfg["temperature"] = body["temperature"];
  if (present(body, "top_p") !== undefined) cfg["topP"] = body["top_p"];
  if (present(body, "top_k") !== undefined) cfg["topK"] = body["top_k"];
  if (present(body, "seed") !== undefined) cfg["seed"] = body["seed"];
  if (present(body, "frequency_penalty") !== undefined) cfg["frequencyPenalty"] = body["frequency_penalty"];
  if (present(body, "presence_penalty") !== undefined) cfg["presencePenalty"] = body["presence_penalty"];
  if (present(body, "service_tier") !== undefined) cfg["serviceTier"] = body["service_tier"];
  if (present(body, "store") !== undefined) cfg["store"] = body["store"];
  if (present(body, "stop") !== undefined) cfg["stop"] = body["stop"];
  const logprobs = present(body, "logprobs");
  if (logprobs === true) cfg["logprobs"] = present(body, "top_logprobs") ?? 0;
  else if (logprobs !== undefined && logprobs !== false) throw new TypeError("logprobs must be a boolean");
  else if (present(body, "top_logprobs") !== undefined) throw new ValueError("top_logprobs requires logprobs: true");
  if (present(body, "response_format") !== undefined) cfg["responseFormat"] = ingestResponseFormat(provider, body["response_format"]);
  if ("function_call" in body && "tool_choice" in body) throw new ValueError("function_call and tool_choice cannot both be given");
  cfg["toolChoice"] = ingestToolChoice(
    provider,
    "function_call" in body ? toolChoiceFromFunctionCall(body["function_call"]) : present(body, "tool_choice"),
    present(body, "parallel_tool_calls"),
  );
  const userKeys = ["user", "safety_identifier", "user_id"].filter((k) => k in body);
  if (userKeys.includes("user_id") && compat.userField !== "user_id") {
    throw ingestRefuse(provider, "'user_id'", `this server spells the end-user field ${JSON.stringify(compat.userField)}`);
  }
  if (userKeys.length > 1) throw new ValueError(`one end-user identifier only; got ${JSON.stringify(userKeys)}`);
  if (userKeys.length === 1) cfg["userId"] = body[userKeys[0]!] as unknown;
  const extensions: JsonObject = {};
  cfg["reasoning"] = ingestReasoning(provider, body, compat, extensions);
  cfg["cache"] = ingestCache(provider, body, compat, rows.systemBreakpoint, rows.breakpointIndex);
  for (const key of Object.keys(body)) if (INGEST_EXTENSIONS_KEYS.has(key)) extensions[key] = body[key]!;
  cfg["extensions"] = Object.keys(extensions).length > 0 ? extensions : undefined;
  return normalizeConfig(cfg);
}

function ingestOpenAIChat(provider: string, body: unknown, compat: ResolvedOpenAIChatCompat): Request {
  if (!isJsonObject(body)) throw new TypeError(`a Chat Completions request body is a JSON object, got ${typeName(body)}`);
  for (const key of Object.keys(body)) {
    if (key in INGEST_REFUSED_KEYS) throw ingestRefuse(provider, JSON.stringify(key), INGEST_REFUSED_KEYS[key]!);
    if (!INGEST_CONFIG_KEYS.has(key) && !INGEST_EXTENSIONS_KEYS.has(key) && !INGEST_CALL_MODE_KEYS.has(key)) {
      throw ingestRefuse(provider, JSON.stringify(key), "no verdict for this key (lm15-contract/tools/openai-chat-ingest-verdicts.json); lm15 never drops a key silently");
    }
  }
  const model = body["model"];
  if (typeof model !== "string" || model === "") throw new ValueError("model must be a non-empty string");
  if (!("messages" in body)) throw new ValueError("messages is required");
  const rows = ingestRows(provider, body["messages"]);
  if ("functions" in body && "tools" in body) throw new ValueError("functions and tools cannot both be given");
  let rawTools = present(body, "tools");
  if ("functions" in body) {
    if (!Array.isArray(body["functions"])) throw new TypeError("functions must be an array");
    rawTools = body["functions"].map((fn) => ({ type: "function", function: fn }));
  }
  const tools = ingestTools(provider, rawTools, compat);
  const config = ingestConfig(provider, body, compat, rows);
  return Request.create({
    model,
    messages: rows.messages,
    ...(rows.system === undefined ? {} : { system: rows.system as string | PromptPart[] }),
    tools,
    config,
  });
}

/**
 * The one Chat Completions response reader: `parseResponse` for provider
 * traffic and `responseFromOpenAIChat` for a foreign body share it (MAP-12
 * rule 9: ports expose their existing reader, never a second one).
 * `choice` names the choice to read; unset means "the only one", and a body
 * with several choices is then refused rather than silently reduced to its
 * first (the reading-side twin of MAP-12's refusal of `n`).
 */
function responseFromChatBody(
  provider: string,
  data: unknown,
  opts: { model?: string; choice?: number },
  onError: (code: string, message: string) => ProviderError,
): Response {
  if (!isJsonObject(data)) throw new TypeError(`a Chat Completions response body is a JSON object, got ${typeName(data)}`);
  const respError = data["error"];
  if (isJsonObject(respError)) throw onError(str(respError["code"]), str(respError["message"]) || stringifyJson(respError));

  const parts: Part[] = [];
  const unmapped: Unmapped = [];
  const choicesRaw = data["choices"] ?? [];
  if (!Array.isArray(choicesRaw)) throw new TypeError("choices must be an array");
  const choices: JsonValue[] = choicesRaw;
  let index: number;
  if (opts.choice === undefined) {
    if (choices.length > 1) {
      throw new UnsupportedFeatureError(
        `${provider}: the body carries ${choices.length} choices; a canonical Response is one message — ` +
        "name the choice to read (choice: i) and read each one, or send no n",
        { provider, feature: "n" },
      );
    }
    index = 0;
  } else {
    if (!Number.isInteger(opts.choice) || opts.choice < 0 || opts.choice >= choices.length) {
      throw new ValueError(`choice=${opts.choice} but the body carries ${choices.length} choice(s)`);
    }
    index = opts.choice;
  }
  const path = `choices[${index}]`;
  const picked = choices[index];
  const chosen: JsonObject = isJsonObject(picked) ? picked : {};
  if (choices.length > 0 && !isJsonObject(picked)) recordUnmapped(unmapped, path, typeName(picked));
  const message = obj(chosen["message"]);

  const reasoningText = message["reasoning_content"] || message["reasoning"];
  if (reasoningText) parts.push(normalizePart({ type: "thinking", text: str(reasoningText) }));

  const content = message["content"];
  if (typeof content === "string") {
    if (content) parts.push(normalizePart({ type: "text", text: content }));
  } else if (Array.isArray(content)) {
    content.forEach((item, contentIndex) => {
      if (isJsonObject(item) && item["type"] === "text") parts.push(normalizePart({ type: "text", text: str(item["text"]) }));
      else recordUnmapped(unmapped, `${path}.message.content[${contentIndex}]`, isJsonObject(item) ? item["type"] : typeName(item));
    });
  } else if (content !== null && content !== undefined) recordUnmapped(unmapped, `${path}.message.content`, typeName(content));

  if (message["refusal"]) parts.push(normalizePart({ type: "refusal", text: str(message["refusal"]) }));

  list(message["tool_calls"]).forEach((call, callIndex) => {
    if (!isJsonObject(call)) {
      recordUnmapped(unmapped, `${path}.message.tool_calls[${callIndex}]`, typeName(call));
      return;
    }
    const callType = call["type"] || "function";
    if (callType !== "function") {
      recordUnmapped(unmapped, `${path}.message.tool_calls[${callIndex}]`, callType);
      return;
    }
    const fn = obj(call["function"]);
    if (!fn["name"]) throw unnamedToolCallError(provider, `${path}.message.tool_calls[${callIndex}]`);
    parts.push(normalizePart({ type: "tool_call", id: str(call["id"]) || `call_${parts.length}`, name: str(fn["name"]), input: parseJsonObjectLenient(fn["arguments"]) }));
  });

  if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));
  const hasTool = parts.some((p) => p.type === "tool_call");
  const logprobs = openaiTokenLogprobs(obj(chosen["logprobs"])["content"]);
  const resolvedModel = str(data["model"]) || opts.model;
  if (!resolvedModel) throw new ValueError("the body carries no model; pass model");
  return new Response({
    id: data["id"] ? str(data["id"]) : undefined,
    model: resolvedModel,
    message: { role: "assistant", parts },
    finishReason: OpenAIChatLM.finishReasonOf(chosen["finish_reason"], hasTool, unmapped, path),
    usage: usageFromChat(data["usage"]),
    logprobs: logprobs.length > 0 ? logprobs : undefined,
    providerData: attachUnmapped(data, unmapped),
  });
}

/**
 * A Chat Completions response body → the canonical `Response` (MAP-12
 * rule 9). The reading-side twin of `requestFromOpenAIChat`: `body` is the
 * JSON object a Chat Completions server (or a client library imitating one —
 * litellm's `ModelResponse.model_dump()`) returned. It is the same reader
 * `OpenAIChatLM.parseResponse` runs on provider traffic. `model` fills
 * `Response.model` when the body carries none; `choice` names the choice to
 * read — unset, a body with several choices is refused. Keys the reader does
 * not know are neither refused nor lost: the whole body is `providerData`.
 * No compat is taken: the response shape does not vary by server.
 */
export function responseFromOpenAIChat(body: unknown, opts: { model?: string; choice?: number; responseFormat?: ResponseFormat } = {}): Response {
  const resp = responseFromChatBody("openai-chat", body, opts, (code, message) => {
    const cls = RESPONSE_ERROR_CODE_MAP[code] ?? ServerError;
    return new cls(message || code || "provider error", { provider: "openai-chat", providerCode: code || null });
  });
  return opts.responseFormat ? foldJudgments(resp, { model: resp.model, messages: [], config: { responseFormat: opts.responseFormat } }) : resp;
}

/** MAP-14 §3: the single text part of a judgment answer becomes a DataPart. */
function foldJudgments(resp: Response, request: Request): Response {
  const found = requestJudgments(request);
  if (found.size === 0) return resp;
  const parts = replaceTextWithData(resp.message.parts, found);
  if (parts === resp.message.parts) return resp;
  return resp.with({ message: { ...resp.message, parts } });
}

/**
 * A Chat Completions request body → the canonical `Request` (MAP-12).
 *
 * `body` is the JSON object a client would POST to `/chat/completions`.
 * `compat` names the server dialect whose spellings are read — a preset name
 * (`"groq"`, `"deepseek"`, …), an `OpenAIChatCompat`, or absent for OpenAI's
 * own — the same policy `OpenAIChatLM` writes with, so what that adapter
 * emits for a Request reads back as that Request wherever the wire can carry
 * it. Every key has one verdict: it maps to a canonical field, passes
 * verbatim through `config.extensions`, or is refused with
 * `UnsupportedFeatureError` naming the key; `stream` / `stream_options` are
 * read and dropped. Malformed input throws `ValueError` / `TypeError`.
 * On an adapter, `lm.requestFromOpenAIChat(body)` uses that adapter's compat.
 */
export function requestFromOpenAIChat(body: unknown, opts: { compat?: OpenAIChatCompat | string } = {}): Request {
  const partial = typeof opts.compat === "string" ? openaiChatPreset(opts.compat) : (opts.compat ?? {});
  const model = isJsonObject(body) && typeof body["model"] === "string" ? body["model"] : undefined;
  const resolved = resolveOpenAIChatCompat(model !== undefined ? chatCompatForModel(partial, model) : partial);
  return ingestOpenAIChat("openai-chat", body, resolved);
}
