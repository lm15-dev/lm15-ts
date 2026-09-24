/**
 * Shared pieces of the two OpenAI wires (Responses and Chat Completions):
 * the error envelope, the MAP-6 cache fields, the unmapped recorder, the
 * Responses input blocks, and the usage/logprob mappings.
 */

import { adapt } from "../adaptation.ts";
import { isJsonObject, stringifyJson, type JsonObject, type JsonValue } from "../json.ts";
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
  isPinnedModelNotFound,
} from "../errors.ts";
import type { Request, ResponseFormat } from "../types/config.ts";
import type { Message, Part, ToolResultPart } from "../types/parts.ts";
import { ErrorDetail, Usage } from "../types/response.ts";
import { MEDIA_KINDS, checkToolResultMedia, dataPartText, mediaBase64, mediaDataUri, partsToText, toolResultErrorText } from "../wire.ts";

export type ProviderErrorClass = new (message: string, meta?: never) => ProviderError;

export const RESPONSE_ERROR_CODE_MAP: Readonly<Record<string, typeof ProviderError>> = Object.freeze({
  server_error: ServerError,
  rate_limit_exceeded: RateLimitError,
  // Azure Responses error frames can carry these under HTTP 200.
  no_capacity: RateLimitError,
  too_many_requests: RateLimitError,
  invalid_prompt: InvalidRequestError,
  vector_store_timeout: TimeoutError,
  invalid_image: InvalidRequestError,
  invalid_image_format: InvalidRequestError,
  invalid_base64_image: InvalidRequestError,
  invalid_image_url: InvalidRequestError,
  image_too_large: InvalidRequestError,
  image_too_small: InvalidRequestError,
  image_parse_error: InvalidRequestError,
  image_content_policy_violation: InvalidRequestError,
  invalid_image_mode: InvalidRequestError,
  image_file_too_large: InvalidRequestError,
  unsupported_image_media_type: InvalidRequestError,
  empty_image_file: InvalidRequestError,
  failed_to_download_image: InvalidRequestError,
  image_file_not_found: InvalidRequestError,
  model_not_found: UnsupportedModelError,
  model_not_available: UnsupportedModelError,
  unsupported_model: UnsupportedModelError,
  DeploymentNotFound: UnsupportedModelError,
});

export const MODEL_ERROR_CODES: ReadonlySet<string> = new Set(["model_not_found", "model_not_available", "unsupported_model", "DeploymentNotFound"]);

export const STREAM_ERROR_CODE_MAP: Readonly<Record<string, typeof ProviderError>> = Object.freeze({
  ...RESPONSE_ERROR_CODE_MAP,
  context_length_exceeded: ContextLengthError,
  invalid_api_key: AuthError,
  insufficient_quota: BillingError,
  "1113": BillingError,
  exceeded_current_quota_error: BillingError,
  authentication_error: AuthError,
  rate_limit_error: RateLimitError,
});

export function isModelError(message: string, ...codes: string[]): boolean {
  const lowered = [message, ...codes].filter(Boolean).join(" ").toLowerCase();
  return (
    lowered.includes("model") &&
    ["not found", "does not exist", "not exist", "not supported", "unsupported", "not available", "unknown"].some((m) => lowered.includes(m))
  );
}

export function errorDetail(providerCode: string, message: string): ErrorDetail {
  const cls = isPinnedModelNotFound(providerCode, message) ? UnsupportedModelError : STREAM_ERROR_CODE_MAP[providerCode] ?? ProviderError; // MAP-15
  return ErrorDetail.create({
    code: canonicalErrorCode(cls),
    message: message || providerCode || "provider error",
    providerCode: providerCode || "provider",
  });
}

export function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && "raw" in (value as object)) return (value as { raw: string }).raw;
  if (typeof value === "object") return stringifyJson(value);
  return String(value);
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "raw" in value) return Number((value as { raw: string }).raw);
  return undefined;
}

export function int(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

export function obj(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function list(value: unknown): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

// ─── Unmapped recorder ───────────────────────────────────────────────

export type Unmapped = Array<{ path: string; type: string }>;

export function recordUnmapped(unmapped: Unmapped, path: string, type: unknown): void {
  const t = type === null || type === undefined || type === "" || type === false || type === 0 ? "<missing>" : str(type);
  unmapped.push({ path, type: t });
}

export function attachUnmapped(providerData: JsonObject, unmapped: Unmapped): JsonObject {
  if (unmapped.length === 0) return providerData;
  return { ...providerData, _lm15_unmapped: unmapped.map((u) => ({ path: u.path, type: u.type })) };
}

export function typeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "boolean":
      return "bool";
    case "object":
      return "raw" in (value as object) ? ((value as { isFloat: boolean }).isFloat ? "float" : "int") : "dict";
    default:
      return typeof value;
  }
}

// ─── MAP-6 cache fields ──────────────────────────────────────────────

const GPT_VERSION_RE = /^gpt-(\d+)\.(\d+)/;

/** True for the GPT-5.6-and-later model class (`prompt_cache_options`). */
export function openaiModelHasCacheOptions(model: string): boolean {
  const m = GPT_VERSION_RE.exec(model.toLowerCase());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

/** Message index carrying the explicit prompt-cache breakpoint, clamped to the last message. */
export function cacheBreakpointIndex(request: Request, cacheControl: string): number | undefined {
  const cache = request.config?.cache;
  if (!cache || cache.mode === "off" || cache.prefixUntilIndex === undefined) return undefined;
  if (cacheControl !== "openai") return undefined;
  const asked = Math.min(cache.prefixUntilIndex, request.messages.length - 1);
  // MAP-13: the wire carries the mark on a text block of a user/developer
  // message only. A mark asked for elsewhere walks back to the nearest
  // eligible message ("cache up to here" — the nearest boundary before
  // "here" is the obvious answer); with none, the mark is dropped and
  // implicit caching still applies. Called ONCE per build: it may record.
  for (let index = asked; index >= 0; index--) {
    const msg = request.messages[index]!;
    const last = msg.parts[msg.parts.length - 1];
    if (msg.role === "assistant" || msg.role === "tool" || !last || last.type !== "text") continue;
    if (index !== asked) {
      adapt(
        "config.cache.prefix_until_index",
        "substituted",
        `message ${asked} is a ${request.messages[asked]!.role} message or does not end with text; the Responses wire marks text blocks of user/developer messages only, so the mark moved to the nearest eligible message before it`,
        { asked, applied: index },
      );
    }
    return index;
  }
  adapt(
    "config.cache.prefix_until_index",
    "dropped",
    `no user/developer message ending with text at or before message ${asked}; the Responses wire marks text blocks only (implicit caching still applies)`,
    { asked },
  );
  return undefined;
}

export function cacheStablePrefix(request: Request, cacheControl: string): boolean {
  const cache = request.config?.cache;
  return cache !== undefined && cache.mode !== "off" && cache.prefix === "stable" && cacheControl === "openai";
}

function hasExplicitBreakpoint(request: Request, cacheControl: string): boolean {
  return cacheBreakpointIndex(request, cacheControl) !== undefined || (cacheStablePrefix(request, cacheControl) && Boolean(request.system));
}

/** Shared MAP-6 fields for both OpenAI dialects: off switch, key, retention. */
export function cacheCommonPayload(request: Request, payload: JsonObject, cacheControl: string, provider: string): void {
  const cache = request.config?.cache;
  if (!cache || (cacheControl !== "openai" && cacheControl !== "openai_implicit")) return;
  if (cacheControl === "openai_implicit") {
    if (cache.mode !== "off") {
      if (cache.key) payload["prompt_cache_key"] = cache.key;
      if (cache.retention === "long") payload["prompt_cache_retention"] = "24h";
    }
    if (cache.resource !== undefined) {
      throw new UnsupportedFeatureError(
        `${provider}: cache.resource is not supported — this provider has no stored-cache tier; it caches every prompt prefix automatically`,
        { provider, feature: "config.cache.resource" },
      );
    }
    return;
  }
  if (cache.mode === "off") {
    if (openaiModelHasCacheOptions(request.model)) payload["prompt_cache_options"] = { mode: "explicit" };
    return;
  }
  if (cache.key) payload["prompt_cache_key"] = cache.key;
  if (cache.retention === "long") payload["prompt_cache_retention"] = "24h";
  if (openaiModelHasCacheOptions(request.model) && hasExplicitBreakpoint(request, cacheControl)) {
    payload["prompt_cache_options"] = { mode: "explicit" };
  }
  if (cache.resource !== undefined) {
    throw new UnsupportedFeatureError(
      `${provider}: cache.resource is not supported — this provider has no stored-cache tier; it caches by marks on blocks (prefix / prefix_until_index) and automatically`,
      { provider, feature: "config.cache.resource" },
    );
  }
}

export function breakpointUnsupported(provider: string, index: number, role: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    `${provider}: cache.prefix_until_index=${index} points at a ${role} message whose last block is not text — the wire carries prompt_cache_breakpoint on text input blocks only. Point the prefix at a user/developer message that ends with text, or omit prefix_until_index (implicit caching still applies).`,
    { provider, feature: "config.cache.prefix_until_index" },
  );
}

// ─── Responses input blocks (MAP-10) ─────────────────────────────────

/** One prompt part → one Responses input block; a part with no slot RAISES. */
export function partToOpenAIInput(part: Part, provider?: string): JsonObject {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "data":
      return { type: "input_text", text: dataPartText(part) }; // D3: a data part is its JSON on a text slot
    case "image": {
      if (part.fileId !== undefined) return { type: "input_image", file_id: part.fileId };
      const payload: JsonObject = { type: "input_image", image_url: part.url ?? mediaDataUri(part) };
      if (part.detail) payload["detail"] = part.detail;
      return payload;
    }
    case "audio": {
      if (part.url !== undefined) return { type: "input_audio", audio_url: part.url };
      if (part.fileId !== undefined) return { type: "input_audio", file_id: part.fileId };
      let media = (part.mediaType ?? "audio/wav").split("/", 2)[1] ?? "wav";
      if (media === "mpeg" || media === "mp3") media = "mp3";
      return { type: "input_audio", audio: mediaBase64(part), format: media };
    }
    case "document":
    case "binary": {
      if (part.url !== undefined) return { type: "input_file", file_url: part.url };
      if (part.fileId !== undefined) return { type: "input_file", file_id: part.fileId };
      const ext = ((part.mediaType ?? "application/octet-stream").split("/", 2)[1] ?? "bin").split("+", 1)[0] || "bin";
      return { type: "input_file", filename: `file.${ext}`, file_data: mediaDataUri(part) };
    }
    case "video":
      if (part.url !== undefined) return { type: "input_video", video_url: part.url };
      if (part.fileId !== undefined) return { type: "input_video", file_id: part.fileId };
      return { type: "input_video", video_data: mediaDataUri(part) };
    case "citation":
    case "thinking":
      return { type: "input_text", text: partsToText([part]) };
    default: {
      const head = provider ? `${provider}: ` : "";
      throw new UnsupportedFeatureError(`${head}a ${part.type} part has no input block on the Responses wire (MAP-10)`, { provider: provider ?? null });
    }
  }
}

/** `function_call_output.output`: a string when text-only, the block array otherwise (MAP-10). */
export function toolResultOutputOpenAI(provider: string, part: ToolResultPart, policy: string): string | JsonObject[] {
  checkToolResultMedia(provider, part, policy, "function_call_output");
  if (part.content.every((p) => !MEDIA_KINDS.has(p.type))) {
    return toolResultErrorText(part, partsToText(part.content, { provider, where: "function_call_output" }));
  }
  const blocks = part.content.map((p) => partToOpenAIInput(p, provider));
  if (part.isError) {
    const first = blocks.find((b) => b["type"] === "input_text");
    if (!first) blocks.unshift({ type: "input_text", text: "[error]" });
    else first["text"] = "[error] " + str(first["text"]);
  }
  return blocks;
}

export function messageToOpenAIInput(msg: Message): JsonObject {
  return { role: msg.role, content: msg.parts.map((p) => partToOpenAIInput(p)) };
}

export function responseFormatToOpenAIText(format: ResponseFormat): JsonObject {
  if (format.type === "json_object") return { format: { type: "json_object" } };
  const fmt: JsonObject = { type: "json_schema", name: format.name || "response", schema: format.schema };
  if ("strict" in format && format.strict !== undefined) fmt["strict"] = format.strict;
  return { format: fmt };
}

export function responseFormatToChat(format: ResponseFormat): JsonObject {
  if (format.type === "json_object") return { type: "json_object" };
  const inner: JsonObject = { name: format.name || "response", schema: format.schema };
  if ("strict" in format && format.strict !== undefined) inner["strict"] = format.strict;
  return { type: "json_schema", json_schema: inner };
}

// ─── Usage ───────────────────────────────────────────────────────────

/** Responses / Realtime usage: `input_tokens`, `output_tokens`, `*_tokens_details`. */
export function usageFromResponses(usageData: unknown): Usage {
  const u = obj(usageData);
  const input = obj(u["input_tokens_details"] ?? u["input_token_details"]);
  const output = obj(u["output_tokens_details"] ?? u["output_token_details"]);
  return Usage.create({
    inputTokens: u["input_tokens"],
    outputTokens: u["output_tokens"],
    totalTokens: u["total_tokens"],
    reasoningTokens: output["reasoning_tokens"],
    cacheReadTokens: input["cached_tokens"],
    cacheWriteTokens: input["cache_write_tokens"],
    inputAudioTokens: input["audio_tokens"],
    outputAudioTokens: output["audio_tokens"],
  });
}

/** Chat Completions usage: `prompt_tokens`, `completion_tokens`, `*_tokens_details`. */
export function usageFromChat(usageData: unknown): Usage {
  const u = obj(usageData);
  const prompt = obj(u["prompt_tokens_details"]);
  const completion = obj(u["completion_tokens_details"]);
  return Usage.create({
    inputTokens: u["prompt_tokens"],
    outputTokens: u["completion_tokens"],
    totalTokens: u["total_tokens"],
    reasoningTokens: completion["reasoning_tokens"],
    cacheReadTokens: prompt["cached_tokens"],
    cacheWriteTokens: prompt["cache_write_tokens"],
    inputAudioTokens: prompt["audio_tokens"],
    outputAudioTokens: completion["audio_tokens"],
  });
}

export function openaiBatchStatus(status: string): string {
  const s = status.toLowerCase();
  if (["completed", "failed", "cancelled", "expired"].includes(s)) return s;
  if (s === "cancelling" || s === "canceling") return "cancelling";
  if (s === "in_progress" || s === "finalizing") return "running";
  return "queued";
}

export const MODEL_LIST_HINT = "List the models your subscription accepts: call .listModels() on this client.";
export const CODEX_BACKEND = "chatgpt-codex";
