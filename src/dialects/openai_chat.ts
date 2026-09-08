/**
 * OpenAI Chat Completions dialect (`OpenAIChatLM`): OpenAI's legacy
 * endpoint and the de-facto standard other servers speak (Groq, DeepSeek,
 * xAI, ollama, vLLM, …). Server quirks are `OpenAIChatCompat` presets.
 */

import { ProviderLM, type LMOptions } from "../adapter.ts";
import { OPENAI_CHAT_API, type AccessPolicy } from "../auth/policy.ts";
import {
  OPENAI_CHAT_PRESET_BASE_URLS,
  chatCompatForModel,
  openaiChatPreset,
  presetKey,
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
import { isJsonObject, parseJson, stringifyJson, type JsonObject } from "../json.ts";
import type { SSEEvent } from "../stream.ts";
import type { BuiltinTool, Request } from "../types/config.ts";
import type { ModelInfo } from "../types/model_info.ts";
import { normalizePart, type ImagePart, type Message, type Part, type ToolResultPart } from "../types/parts.ts";
import { Response } from "../types/response.ts";
import type { FinishReason } from "../vocab.ts";
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
        { provider },
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
      if (this.baseUrl === DEFAULT_BASE_URL) this.baseUrl = OPENAI_CHAT_PRESET_BASE_URLS[presetKey(compat)] ?? DEFAULT_BASE_URL;
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
          { provider: this.provider },
        );
      }
      const entry: JsonObject = { type: wireType };
      if (tool.config) Object.assign(entry, tool.config);
      return entry;
    }
    throw new UnsupportedFeatureError(
      `${this.provider}: builtin tool ${JSON.stringify(tool.name)} is not supported on this server — the Chat Completions wire carries function tools only, and unproven servers may silently ignore unknown tool types. Use compat='groq' for Groq's server-executed tools, or the OpenAI Responses / Anthropic / Gemini providers`,
      { provider: this.provider },
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
          { provider: this.provider },
        );
      }
      if (entries.length === 1 && mode === "required") return { type: "function", function: { name: entries[0]!.name } };
      return { type: "allowed_tools", allowed_tools: { mode, tools: entries.map((t) => ({ type: "function", function: { name: t.name } })) } };
    }
    return mode === "required" ? "required" : "auto";
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
      throw new UnsupportedFeatureError(`${this.provider}: config.top_k has no field on the Chat Completions wire; servers that accept top_k take it through extensions`, {
        provider: this.provider,
      });
    }
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
    const toolChoice = this.toolChoicePayload(request);
    if (toolChoice !== undefined) {
      const tc = config.toolChoice!;
      const mode = tc.mode ?? "auto";
      if (compat.forcedToolChoice === "reject" && (mode !== "auto" || (tc.allowed && tc.allowed.length > 0))) {
        throw new UnsupportedFeatureError(
          `${this.provider}: tool_choice mode=${JSON.stringify(mode)}${tc.allowed && tc.allowed.length > 0 ? ` allowed=${JSON.stringify([...tc.allowed])}` : ""} is silently ignored by this server (only 'auto' is honoured); omit tool_choice, or send only the tools you want callable`,
          { provider: this.provider },
        );
      }
      payload["tool_choice"] = toolChoice as JsonObject;
    }
    if (config.toolChoice?.parallel !== undefined) payload["parallel_tool_calls"] = config.toolChoice.parallel;
    if (config.responseFormat) {
      if (compat.jsonSchema === "reject" && config.responseFormat.type !== "json_object") {
        throw new UnsupportedFeatureError(
          `${this.provider}: response_format type ${JSON.stringify(config.responseFormat.type)} is silently ignored by this server; use {'type': 'json_object'} and describe the shape in the prompt`,
          { provider: this.provider },
        );
      }
      payload["response_format"] = responseFormatToChat(config.responseFormat);
    }
    if (config.reasoning) {
      const reasoning = config.reasoning;
      if (reasoning.effort !== "off") {
        if (reasoning.thinkingBudget !== undefined) {
          throw new UnsupportedFeatureError(`${this.provider}: reasoning.thinking_budget is not supported — the Chat Completions wire has no thinking token budget; use effort`, {
            provider: this.provider,
          });
        }
        if (reasoning.summary === "concise" || reasoning.summary === "detailed") {
          throw new UnsupportedFeatureError(
            `${this.provider}: reasoning.summary=${JSON.stringify(reasoning.summary)} is an OpenAI Responses detail level; the Chat Completions wire has none (use 'auto')`,
            { provider: this.provider },
          );
        }
        const effort = reasoning.effort;
        if (compat.reasoningEfforts !== undefined && !compat.reasoningEfforts.includes(effort)) {
          throw new UnsupportedFeatureError(
            `${this.provider}: reasoning.effort=${JSON.stringify(effort)} has no level on this server (it accepts ${compat.reasoningEfforts.join(", ")}) and would be accepted silently`,
            { provider: this.provider },
          );
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
          case "none":
            break;
        }
      } else {
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
          case "none":
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

  buildRequest(request: Request, stream: boolean): Promise<TransportRequest> {
    return this.emit({
      method: "POST",
      url: `${this.base()}/chat/completions`,
      endpoint: "chat/completions",
      stream,
      model: request.model,
      headers: this.headers(),
      payload: this.payload(request, stream),
    });
  }

  // ─── Response ────────────────────────────────────────────────────

  protected static finishReason(raw: unknown, hasToolCall: boolean, unmapped: Unmapped): FinishReason {
    if (hasToolCall) return "tool_call";
    if (raw === null || raw === undefined || raw === "") return "stop";
    const mapped = FINISH_REASON_MAP[str(raw)];
    if (mapped === undefined) {
      recordUnmapped(unmapped, "choices[0].finish_reason", raw);
      return "stop";
    }
    return mapped;
  }

  parseResponse(request: Request, response: HttpResponse): Response {
    const data = obj(response.json());
    const respError = data["error"];
    if (isJsonObject(respError)) throw this.responseError(str(respError["code"]), str(respError["message"]) || stringifyJson(respError));

    const parts: Part[] = [];
    const unmapped: Unmapped = [];
    const choices = list(data["choices"]);
    const choice = choices.length > 0 && isJsonObject(choices[0]) ? choices[0] : {};
    if (choices.length > 0 && !isJsonObject(choices[0])) recordUnmapped(unmapped, "choices[0]", typeName(choices[0]));
    const message = obj(choice["message"]);

    const reasoningText = message["reasoning_content"] || message["reasoning"];
    if (reasoningText) parts.push(normalizePart({ type: "thinking", text: str(reasoningText) }));

    const content = message["content"];
    if (typeof content === "string") {
      if (content) parts.push(normalizePart({ type: "text", text: content }));
    } else if (Array.isArray(content)) {
      content.forEach((item, contentIndex) => {
        if (isJsonObject(item) && item["type"] === "text") parts.push(normalizePart({ type: "text", text: str(item["text"]) }));
        else recordUnmapped(unmapped, `choices[0].message.content[${contentIndex}]`, isJsonObject(item) ? item["type"] : typeName(item));
      });
    } else if (content !== null && content !== undefined) recordUnmapped(unmapped, "choices[0].message.content", typeName(content));

    if (message["refusal"]) parts.push(normalizePart({ type: "refusal", text: str(message["refusal"]) }));

    list(message["tool_calls"]).forEach((call, callIndex) => {
      if (!isJsonObject(call)) {
        recordUnmapped(unmapped, `choices[0].message.tool_calls[${callIndex}]`, typeName(call));
        return;
      }
      const callType = call["type"] || "function";
      if (callType !== "function") {
        recordUnmapped(unmapped, `choices[0].message.tool_calls[${callIndex}]`, callType);
        return;
      }
      const fn = obj(call["function"]);
      if (!fn["name"]) throw unnamedToolCallError(this.provider, `choices[0].message.tool_calls[${callIndex}]`);
      parts.push(normalizePart({ type: "tool_call", id: str(call["id"]) || `call_${parts.length}`, name: str(fn["name"]), input: parseJsonObjectLenient(fn["arguments"]) }));
    });

    if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));
    const hasTool = parts.some((p) => p.type === "tool_call");
    const logprobs = openaiTokenLogprobs(obj(choice["logprobs"])["content"]);
    return new Response({
      id: data["id"] ? str(data["id"]) : undefined,
      model: str(data["model"]) || request.model,
      message: { role: "assistant", parts },
      finishReason: OpenAIChatLM.finishReason(choice["finish_reason"], hasTool, unmapped),
      usage: usageFromChat(data["usage"]),
      logprobs: logprobs.length > 0 ? logprobs : undefined,
      providerData: attachUnmapped(data, unmapped),
    });
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
