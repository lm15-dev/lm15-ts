/**
 * parse_response for all four providers (Stage D).
 *
 * Pure transformations from a parsed provider response body to the
 * canonical Response. Mapping behavior follows docs/mapping-rules.md:
 * MAP-1 (provider-executed tool activity never becomes parts), MAP-2
 * (never-empty message), plus the `_lm15_unmapped` recorder from
 * harness/PROTOCOL.md — every content element the reference consumes is
 * consumed here, and anything unrecognized is recorded.
 */

import { isJsonObject, type JsonObject, type JsonValue } from "../canonical-json.js";
import {
  InvalidRequestError,
  ProviderError,
  RateLimitError,
  ServerError,
  RequestTimeoutError,
  UnsupportedModelError,
  type LM15ErrorOptions,
} from "../errors.js";
import * as t from "../types.js";
import {
  asArray,
  attachUnmapped,
  counterOrUndefined,
  intCount,
  intOrNull,
  jsonTypeName,
  parseJsonObjectValue,
  pyTruthy,
  pyStr,
  recordUnmapped,
  strOrEmpty,
  strOrNull,
  type UnmappedEntry,
} from "./common.js";

type ProviderErrorCtor = new (message: string, options?: LM15ErrorOptions) => ProviderError;

function obj(v: JsonValue | undefined): JsonObject {
  return v !== undefined && v !== null && isJsonObject(v) ? v : {};
}

function hasToolCall(parts: readonly t.Part[]): boolean {
  return parts.some((p) => p.type === "tool_call");
}

// ─── OpenAI (Responses API) ──────────────────────────────────────────

const OPENAI_PROVIDER_EXECUTED_ITEMS: ReadonlySet<string> = new Set([
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "computer_call",
  "computer_use_call",
]);

/** Reference `_response_error_code_map` (openai.py). */
const OPENAI_RESPONSE_ERROR_CODE_MAP: Record<string, ProviderErrorCtor> = {
  server_error: ServerError,
  rate_limit_exceeded: RateLimitError,
  invalid_prompt: InvalidRequestError,
  vector_store_timeout: RequestTimeoutError,
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
};

function openaiResponseError(provider: string, code: string, message: string): ProviderError {
  const Cls = OPENAI_RESPONSE_ERROR_CODE_MAP[code] ?? ServerError;
  return new Cls(message || code || "provider error", {
    provider,
    providerCode: code || null,
  });
}

function annotationText(annotation: JsonObject, sourceText: string | null): string | null {
  for (const key of ["text", "snippet", "cited_text", "quote"]) {
    const text = strOrNull(annotation[key]);
    if (text !== null) return text;
  }
  const start = intOrNull(annotation["start_index"]);
  const end = intOrNull(annotation["end_index"]);
  if (sourceText !== null && start !== null && end !== null) {
    if (start >= 0 && start < end && end <= sourceText.length) {
      return sourceText.slice(start, end);
    }
  }
  return null;
}

function citationFromOpenAIAnnotation(
  annotation: JsonObject,
  sourceText: string | null,
): t.CitationPart | null {
  const url = strOrNull(pyTruthy(annotation["url"]) ? annotation["url"] : annotation["uri"]);
  const title = strOrNull(
    pyTruthy(annotation["title"])
      ? annotation["title"]
      : pyTruthy(annotation["filename"])
        ? annotation["filename"]
        : annotation["file_id"],
  );
  const text = annotationText(annotation, sourceText);
  if (url === null && title === null && text === null) return null;
  return t.citationPart({ url, title, text });
}

/** Reference `_finish_from_status` (openai.py). */
function openaiFinishFromStatus(data: JsonObject, hasTool: boolean): string {
  if (hasTool) return "tool_call";
  const status = strOrEmpty(data["status"]).toLowerCase();
  const incomplete = obj(data["incomplete_details"]);
  const reason = strOrEmpty(incomplete["reason"]).toLowerCase();
  if (status === "incomplete" && reason.includes("token")) return "length";
  if (reason.includes("content_filter") || reason.includes("safety")) return "content_filter";
  return "stop";
}

export function parseOpenAIResponse(request: t.Request, body: JsonValue): t.Response {
  const data = obj(body);

  const respError = data["error"];
  if (respError !== undefined && respError !== null && isJsonObject(respError)) {
    throw openaiResponseError(
      "openai",
      strOrEmpty(respError["code"]),
      pyTruthy(respError["message"]) ? pyStr(respError["message"]) : pyStr(respError),
    );
  }

  let parts: t.Part[] = [];
  const unmapped: UnmappedEntry[] = [];
  asArray(data["output"]).forEach((item, itemIndex) => {
    if (!isJsonObject(item)) {
      recordUnmapped(unmapped, `output[${itemIndex}]`, jsonTypeName(item));
      return;
    }
    const itemType = item["type"];
    if (itemType === "message") {
      asArray(item["content"]).forEach((content, contentIndex) => {
        if (!isJsonObject(content)) {
          recordUnmapped(
            unmapped,
            `output[${itemIndex}].content[${contentIndex}]`,
            jsonTypeName(content),
          );
          return;
        }
        const ctype = content["type"];
        if (ctype === "output_text" || ctype === "text") {
          const text = strOrEmpty(content["text"]);
          parts.push(t.textPart({ text }));
          for (const annotation of asArray(content["annotations"])) {
            if (!isJsonObject(annotation)) continue;
            const citation = citationFromOpenAIAnnotation(annotation, text);
            if (citation !== null) parts.push(citation);
          }
        } else if (ctype === "refusal") {
          const text = strOrEmpty(
            pyTruthy(content["refusal"]) ? content["refusal"] : content["text"],
          );
          parts.push(text ? t.refusalPart({ text }) : t.textPart({ text: "" }));
        } else if (ctype === "output_image") {
          const b64 = strOrEmpty(
            pyTruthy(content["b64_json"]) ? content["b64_json"] : content["image_base64"],
          );
          if (b64) parts.push(t.mediaPart("image", { media_type: "image/png", data: b64 }));
        } else if (ctype === "output_audio") {
          const audioPayload = obj(content["audio"]);
          const b64 = strOrEmpty(
            pyTruthy(audioPayload["data"]) ? audioPayload["data"] : content["b64_json"],
          );
          if (b64) parts.push(t.mediaPart("audio", { media_type: "audio/wav", data: b64 }));
        } else {
          recordUnmapped(unmapped, `output[${itemIndex}].content[${contentIndex}]`, ctype);
        }
      });
    } else if (itemType === "function_call") {
      parts.push(
        t.toolCallPart({
          id: pyTruthy(item["call_id"])
            ? pyStr(item["call_id"])
            : pyTruthy(item["id"])
              ? pyStr(item["id"])
              : `call_${parts.length}`,
          name: pyTruthy(item["name"]) ? pyStr(item["name"]) : "tool",
          input: parseJsonObjectValue(item["arguments"]),
        }),
      );
    } else if (itemType === "reasoning") {
      const summary = item["summary"];
      let text: string;
      if (Array.isArray(summary)) {
        text = summary
          .map((x) => (isJsonObject(x) ? pyStr(x["text"]) : pyStr(x)))
          .join("\n");
      } else {
        text = strOrEmpty(pyTruthy(summary) ? summary : item["text"]);
      }
      if (text) parts.push(t.thinkingPart({ text }));
    } else if (typeof itemType === "string" && OPENAI_PROVIDER_EXECUTED_ITEMS.has(itemType)) {
      // MAP-1: provider-executed builtin tool activity never becomes parts.
    } else {
      recordUnmapped(unmapped, `output[${itemIndex}]`, itemType);
    }
  });

  if (parts.length === 0) {
    // MAP-2: a response message is never empty.
    parts = [t.textPart({ text: strOrEmpty(data["output_text"]) })];
  }

  const usageData = obj(data["usage"]);
  const inputDetails = obj(usageData["input_tokens_details"]);
  const outputDetails = obj(usageData["output_tokens_details"]);
  const usage = t.usage({
    input_tokens: intCount(usageData["input_tokens"]),
    output_tokens: intCount(usageData["output_tokens"]),
    total_tokens: counterOrUndefined(usageData["total_tokens"]),
    reasoning_tokens: counterOrUndefined(outputDetails["reasoning_tokens"]),
    cache_read_tokens: counterOrUndefined(inputDetails["cached_tokens"]),
    input_audio_tokens: counterOrUndefined(inputDetails["audio_tokens"]),
    output_audio_tokens: counterOrUndefined(outputDetails["audio_tokens"]),
  });

  const continuation: t.ContinuationState[] = [];
  if (pyTruthy(data["id"])) {
    continuation.push(
      t.continuationState({
        provider: "openai",
        kind: "response_id",
        data: { id: pyStr(data["id"]) },
      }),
    );
  }
  return t.response({
    id: pyTruthy(data["id"]) ? pyStr(data["id"]) : null,
    model: pyTruthy(data["model"]) ? pyStr(data["model"]) : request.model,
    message: t.message({ role: "assistant", parts, continuation }),
    finish_reason: openaiFinishFromStatus(data, hasToolCall(parts)),
    usage,
    provider_data: attachUnmapped(data, unmapped),
  });
}

// ─── Anthropic ───────────────────────────────────────────────────────

const ANTHROPIC_PROVIDER_EXECUTED_BLOCKS: ReadonlySet<string> = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
]);

/** Reference `_finish_reason` (anthropic.py). */
function anthropicFinishReason(stopReason: JsonValue | undefined, hasTool: boolean): string {
  if (hasTool) return "tool_call";
  const reason = strOrEmpty(stopReason).toLowerCase();
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "tool_use" || reason === "pause_turn") return "tool_call";
  if (reason === "refusal" || reason === "safety" || reason === "content_filter") {
    return "content_filter";
  }
  return "stop";
}

function citationFromAnthropic(citation: JsonObject): t.CitationPart | null {
  const url = strOrNull(pyTruthy(citation["url"]) ? citation["url"] : citation["uri"]);
  const title = strOrNull(
    pyTruthy(citation["title"])
      ? citation["title"]
      : pyTruthy(citation["document_title"])
        ? citation["document_title"]
        : citation["source_title"],
  );
  const text = strOrNull(
    pyTruthy(citation["cited_text"])
      ? citation["cited_text"]
      : pyTruthy(citation["text"])
        ? citation["text"]
        : citation["quote"],
  );
  if (url === null && title === null && text === null) return null;
  return t.citationPart({ url, title, text });
}

export function parseAnthropicResponse(request: t.Request, body: JsonValue): t.Response {
  const data = obj(body);
  let parts: t.Part[] = [];
  const unmapped: UnmappedEntry[] = [];
  asArray(data["content"]).forEach((block, blockIndex) => {
    if (!isJsonObject(block)) {
      recordUnmapped(unmapped, `content[${blockIndex}]`, jsonTypeName(block));
      return;
    }
    const blockType = block["type"];
    if (blockType === "text") {
      parts.push(t.textPart({ text: strOrEmpty(block["text"]) }));
      for (const citationPayload of asArray(block["citations"])) {
        if (!isJsonObject(citationPayload)) continue;
        const citation = citationFromAnthropic(citationPayload);
        if (citation !== null) parts.push(citation);
      }
    } else if (blockType === "tool_use") {
      parts.push(
        t.toolCallPart({
          id: pyTruthy(block["id"]) ? pyStr(block["id"]) : `tool_${parts.length}`,
          name: pyTruthy(block["name"]) ? pyStr(block["name"]) : "tool",
          input: isJsonObject(block["input"] as JsonValue) ? block["input"] : {},
        }),
      );
    } else if (blockType === "thinking") {
      const continuation: t.ContinuationState[] = [];
      if (pyTruthy(block["signature"])) {
        continuation.push(
          t.continuationState({
            provider: "anthropic",
            kind: "thinking_signature",
            data: { signature: pyStr(block["signature"]) },
          }),
        );
      }
      parts.push(
        t.thinkingPart({
          text: strOrEmpty(pyTruthy(block["thinking"]) ? block["thinking"] : block["text"]),
          redacted: false,
          continuation,
        }),
      );
    } else if (blockType === "redacted_thinking") {
      const continuation: t.ContinuationState[] = [];
      const redactedPayload = block["data"];
      if (redactedPayload !== undefined && redactedPayload !== null) {
        continuation.push(
          t.continuationState({
            provider: "anthropic",
            kind: "redacted_thinking",
            data: { data: redactedPayload },
          }),
        );
      }
      parts.push(t.thinkingPart({ text: "[redacted]", redacted: true, continuation }));
    } else if (typeof blockType === "string" && ANTHROPIC_PROVIDER_EXECUTED_BLOCKS.has(blockType)) {
      // MAP-1: provider-executed builtin tool activity never becomes parts.
    } else {
      recordUnmapped(unmapped, `content[${blockIndex}]`, blockType);
    }
  });

  if (parts.length === 0) {
    parts = [t.textPart({ text: "" })]; // MAP-2
  }

  const usagePayload = obj(data["usage"]);
  const inputTokens = intCount(usagePayload["input_tokens"]);
  const outputTokens = intCount(usagePayload["output_tokens"]);
  const usage = t.usage({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cache_read_tokens: counterOrUndefined(usagePayload["cache_read_input_tokens"]),
    cache_write_tokens: counterOrUndefined(usagePayload["cache_creation_input_tokens"]),
  });

  const continuation: t.ContinuationState[] = [];
  if (pyTruthy(data["id"])) {
    continuation.push(
      t.continuationState({
        provider: "anthropic",
        kind: "message_id",
        data: { id: pyStr(data["id"]) },
      }),
    );
  }
  return t.response({
    id: pyTruthy(data["id"]) ? pyStr(data["id"]) : null,
    model: pyTruthy(data["model"]) ? pyStr(data["model"]) : request.model,
    message: t.message({ role: "assistant", parts, continuation }),
    finish_reason: anthropicFinishReason(data["stop_reason"], hasToolCall(parts)),
    usage,
    provider_data: attachUnmapped(data, unmapped),
  });
}

// ─── Gemini ──────────────────────────────────────────────────────────

const GEMINI_PROVIDER_EXECUTED_PART_KEYS = ["executableCode", "codeExecutionResult"] as const;

const GEMINI_CANDIDATE_FINISH_ERRORS: ReadonlySet<string> = new Set([
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

/** Reference `_finish_reason` (gemini.py). */
function geminiFinishReason(reason: JsonValue | undefined, hasTool: boolean): string {
  if (hasTool) return "tool_call";
  const r = strOrEmpty(reason).toUpperCase();
  if (r === "MAX_TOKENS") return "length";
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(r)) {
    return "content_filter";
  }
  return "stop";
}

/** Reference `_inband_error` (gemini.py). */
function geminiInbandError(data: JsonObject): ProviderError | null {
  const promptFeedback = data["promptFeedback"];
  if (promptFeedback !== undefined && promptFeedback !== null && isJsonObject(promptFeedback)) {
    const blockReason = strOrEmpty(promptFeedback["blockReason"]);
    if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
      return new InvalidRequestError(`Prompt blocked: ${blockReason}`, {
        provider: "gemini",
        providerCode: "promptFeedback",
      });
    }
  }
  const candidates = asArray(data["candidates"]);
  const candidate = candidates.length > 0 ? candidates[0] : {};
  if (candidate !== undefined && candidate !== null && isJsonObject(candidate)) {
    const finishReason = strOrEmpty(candidate["finishReason"]);
    if (GEMINI_CANDIDATE_FINISH_ERRORS.has(finishReason)) {
      const finishMessage = strOrEmpty(candidate["finishMessage"]);
      return new InvalidRequestError(finishMessage || `Candidate blocked: ${finishReason}`, {
        provider: "gemini",
        providerCode: finishReason || "finishReason",
      });
    }
  }
  return null;
}

function geminiSegmentText(segment: JsonObject, fullText: string): string | null {
  const text = segment["text"];
  if (typeof text === "string" && text) return text;
  const start = intOrNull(segment["startIndex"]);
  const end = intOrNull(segment["endIndex"]);
  if (start !== null && end !== null && start >= 0 && start < end && end <= fullText.length) {
    return fullText.slice(start, end);
  }
  return null;
}

function geminiGroundingChunk(chunks: JsonValue[], index: JsonValue | undefined): JsonObject {
  const idx = intOrNull(index);
  if (idx === null || idx < 0 || idx >= chunks.length) return {};
  const chunk = chunks[idx];
  return chunk !== undefined && chunk !== null && isJsonObject(chunk) ? chunk : {};
}

function geminiCitations(candidate: JsonObject, fullText: string): t.CitationPart[] {
  const grounding = candidate["groundingMetadata"];
  if (grounding === undefined || grounding === null || !isJsonObject(grounding)) return [];
  const rawChunks = grounding["groundingChunks"];
  const chunks = Array.isArray(rawChunks) ? rawChunks : [];
  const rawSupports = grounding["groundingSupports"];
  if (rawSupports !== undefined && rawSupports !== null && !Array.isArray(rawSupports)) return [];
  const supports = Array.isArray(rawSupports) ? rawSupports : [];

  const citations: t.CitationPart[] = [];
  const seen = new Set<string>();
  for (const support of supports) {
    if (!isJsonObject(support)) continue;
    const segment = obj(support["segment"]);
    const citedText = geminiSegmentText(segment, fullText);
    const indices = support["groundingChunkIndices"];
    const indexList = pyTruthy(indices) ? indices : [];
    if (!Array.isArray(indexList)) continue;
    for (const index of indexList) {
      const chunk = geminiGroundingChunk(chunks, index);
      const rawSource = pyTruthy(chunk["web"])
        ? chunk["web"]
        : pyTruthy(chunk["retrievedContext"])
          ? chunk["retrievedContext"]
          : pyTruthy(chunk["googleSearch"])
            ? chunk["googleSearch"]
            : {};
      const source = obj(rawSource as JsonValue);
      const url = strOrNull(pyTruthy(source["uri"]) ? source["uri"] : source["url"]);
      const title = strOrNull(pyTruthy(source["title"]) ? source["title"] : source["name"]);
      const key = JSON.stringify([url, title, citedText]);
      if (seen.has(key) || (url === null && title === null && citedText === null)) continue;
      seen.add(key);
      citations.push(t.citationPart({ url, title, text: citedText }));
    }
  }
  return citations;
}

function geminiThoughtContinuation(signature: JsonValue | undefined): t.ContinuationState[] {
  if (signature === undefined || signature === null) return [];
  return [
    t.continuationState({
      provider: "gemini",
      kind: "thought_signature",
      data: { value: pyStr(signature) },
    }),
  ];
}

function parseGeminiCandidateParts(
  partsPayload: JsonValue[],
  unmapped: UnmappedEntry[],
  pathPrefix: string,
): t.Part[] {
  const parts: t.Part[] = [];
  partsPayload.forEach((part, partIndex) => {
    if (!isJsonObject(part)) {
      recordUnmapped(unmapped, `${pathPrefix}[${partIndex}]`, jsonTypeName(part));
      return;
    }
    if ("thought" in part && pyTruthy(part["thought"]) && pyTruthy(part["text"])) {
      parts.push(
        t.thinkingPart({
          text: strOrEmpty(part["text"]),
          continuation: geminiThoughtContinuation(part["thoughtSignature"]),
        }),
      );
    } else if ("text" in part) {
      parts.push(t.textPart({ text: strOrEmpty(part["text"]) }));
    } else if ("functionCall" in part && isJsonObject(part["functionCall"] as JsonValue)) {
      const fc = part["functionCall"] as JsonObject;
      const signature = pyTruthy(part["thoughtSignature"])
        ? part["thoughtSignature"]
        : fc["thoughtSignature"];
      parts.push(
        t.toolCallPart({
          id: pyTruthy(fc["id"]) ? pyStr(fc["id"]) : `fc_${parts.length}`,
          name: pyTruthy(fc["name"]) ? pyStr(fc["name"]) : "tool",
          input: isJsonObject(fc["args"] as JsonValue) ? fc["args"] : {},
          continuation: geminiThoughtContinuation(signature),
        }),
      );
    } else if ("inlineData" in part && isJsonObject(part["inlineData"] as JsonValue)) {
      const inline = part["inlineData"] as JsonObject;
      const mime = pyTruthy(inline["mimeType"])
        ? pyStr(inline["mimeType"])
        : "application/octet-stream";
      const data = strOrEmpty(inline["data"]);
      if (!data) return;
      if (mime.startsWith("image/")) {
        parts.push(t.mediaPart("image", { media_type: mime, data }));
      } else if (mime.startsWith("audio/")) {
        parts.push(t.mediaPart("audio", { media_type: mime, data }));
      } else {
        parts.push(t.mediaPart("document", { media_type: mime, data }));
      }
    } else if ("fileData" in part && isJsonObject(part["fileData"] as JsonValue)) {
      const fd = part["fileData"] as JsonObject;
      const uri = strOrEmpty(fd["fileUri"]);
      const mime = pyTruthy(fd["mimeType"])
        ? pyStr(fd["mimeType"])
        : "application/octet-stream";
      if (!uri) return;
      if (mime.startsWith("image/")) {
        parts.push(t.mediaPart("image", { media_type: mime, url: uri }));
      } else if (mime.startsWith("audio/")) {
        parts.push(t.mediaPart("audio", { media_type: mime, url: uri }));
      } else {
        parts.push(t.mediaPart("document", { media_type: mime, url: uri }));
      }
    } else if (GEMINI_PROVIDER_EXECUTED_PART_KEYS.some((key) => key in part)) {
      // MAP-1: provider-executed builtin tool activity never becomes parts.
    } else {
      recordUnmapped(
        unmapped,
        `${pathPrefix}[${partIndex}]`,
        Object.keys(part).sort().join("+") || "<empty>",
      );
    }
  });
  return parts;
}

export function parseGeminiResponse(request: t.Request, body: JsonValue): t.Response {
  const data = obj(body);
  const inband = geminiInbandError(data);
  if (inband !== null) throw inband;

  const candidates = asArray(data["candidates"]);
  const candidate = obj(candidates.length > 0 ? candidates[0] : {});
  const content = obj(candidate["content"]);
  const unmapped: UnmappedEntry[] = [];
  let parts: t.Part[] = parseGeminiCandidateParts(
    asArray(content["parts"]),
    unmapped,
    "candidates[0].content.parts",
  );
  const fullText = parts
    .filter((p): p is t.TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
  parts = parts.concat(geminiCitations(candidate, fullText));
  if (parts.length === 0) {
    parts = [t.textPart({ text: "" })]; // MAP-2
  }
  const usagePayload = obj(data["usageMetadata"]);
  const outputCount =
    usagePayload["candidatesTokenCount"] !== undefined
      ? usagePayload["candidatesTokenCount"]
      : usagePayload["responseTokenCount"];
  const usage = t.usage({
    input_tokens: intCount(usagePayload["promptTokenCount"]),
    output_tokens: intCount(outputCount),
    total_tokens: counterOrUndefined(usagePayload["totalTokenCount"]),
    cache_read_tokens: counterOrUndefined(usagePayload["cachedContentTokenCount"]),
    reasoning_tokens: counterOrUndefined(usagePayload["thoughtsTokenCount"]),
  });
  const continuation: t.ContinuationState[] = [];
  if (pyTruthy(data["responseId"])) {
    continuation.push(
      t.continuationState({
        provider: "gemini",
        kind: "response_id",
        data: { id: pyStr(data["responseId"]) },
      }),
    );
  }
  return t.response({
    id: pyTruthy(data["responseId"]) ? pyStr(data["responseId"]) : null,
    model: request.model,
    message: t.message({ role: "assistant", parts, continuation }),
    finish_reason: geminiFinishReason(candidate["finishReason"], hasToolCall(parts)),
    usage,
    provider_data: attachUnmapped(data, unmapped),
  });
}

// ─── OpenAI Chat Completions dialect ─────────────────────────────────

const CHAT_FINISH_REASON_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
};

function chatFinishReason(
  raw: JsonValue | undefined,
  hasTool: boolean,
  unmapped: UnmappedEntry[],
): string {
  if (hasTool) return "tool_call";
  if (raw === undefined || raw === null || raw === "") return "stop";
  const mapped = CHAT_FINISH_REASON_MAP[pyStr(raw)];
  if (mapped === undefined) {
    recordUnmapped(unmapped, "choices[0].finish_reason", raw);
    return "stop";
  }
  return mapped;
}

function usageFromChat(usageData: JsonObject): t.Usage {
  const promptDetails = obj(usageData["prompt_tokens_details"]);
  const completionDetails = obj(usageData["completion_tokens_details"]);
  return t.usage({
    input_tokens: intCount(usageData["prompt_tokens"]),
    output_tokens: intCount(usageData["completion_tokens"]),
    total_tokens: counterOrUndefined(usageData["total_tokens"]),
    reasoning_tokens: counterOrUndefined(completionDetails["reasoning_tokens"]),
    cache_read_tokens: counterOrUndefined(promptDetails["cached_tokens"]),
    input_audio_tokens: counterOrUndefined(promptDetails["audio_tokens"]),
    output_audio_tokens: counterOrUndefined(completionDetails["audio_tokens"]),
  });
}

export function parseOpenAIChatResponse(request: t.Request, body: JsonValue): t.Response {
  const data = obj(body);

  const respError = data["error"];
  if (respError !== undefined && respError !== null && isJsonObject(respError)) {
    throw openaiResponseError(
      "openai_chat",
      strOrEmpty(respError["code"]),
      pyTruthy(respError["message"]) ? pyStr(respError["message"]) : pyStr(respError),
    );
  }

  let parts: t.Part[] = [];
  const unmapped: UnmappedEntry[] = [];
  const choices = asArray(data["choices"]);
  const first = choices.length > 0 ? choices[0] : undefined;
  const choice = first !== undefined && first !== null && isJsonObject(first) ? first : {};
  if (choices.length > 0 && !(first !== null && first !== undefined && isJsonObject(first))) {
    recordUnmapped(unmapped, "choices[0]", jsonTypeName(first));
  }
  const message = obj(choice["message"]);

  const reasoningText = pyTruthy(message["reasoning_content"])
    ? message["reasoning_content"]
    : message["reasoning"];
  if (pyTruthy(reasoningText)) {
    parts.push(t.thinkingPart({ text: pyStr(reasoningText) }));
  }

  const content = message["content"];
  if (typeof content === "string") {
    if (content) parts.push(t.textPart({ text: content }));
  } else if (Array.isArray(content)) {
    content.forEach((item, contentIndex) => {
      if (isJsonObject(item) && item["type"] === "text") {
        parts.push(t.textPart({ text: strOrEmpty(item["text"]) }));
      } else {
        recordUnmapped(
          unmapped,
          `choices[0].message.content[${contentIndex}]`,
          isJsonObject(item as JsonValue) ? (item as JsonObject)["type"] : jsonTypeName(item),
        );
      }
    });
  } else if (content !== null && content !== undefined) {
    recordUnmapped(unmapped, "choices[0].message.content", jsonTypeName(content));
  }

  const refusal = message["refusal"];
  if (pyTruthy(refusal)) {
    parts.push(t.refusalPart({ text: pyStr(refusal) }));
  }

  asArray(message["tool_calls"]).forEach((call, callIndex) => {
    if (!isJsonObject(call)) {
      recordUnmapped(unmapped, `choices[0].message.tool_calls[${callIndex}]`, jsonTypeName(call));
      return;
    }
    const callType = pyTruthy(call["type"]) ? call["type"] : "function";
    if (callType !== "function") {
      recordUnmapped(unmapped, `choices[0].message.tool_calls[${callIndex}]`, callType);
      return;
    }
    const fn = obj(call["function"]);
    parts.push(
      t.toolCallPart({
        id: pyTruthy(call["id"]) ? pyStr(call["id"]) : `call_${parts.length}`,
        name: pyTruthy(fn["name"]) ? pyStr(fn["name"]) : "tool",
        input: parseJsonObjectValue(fn["arguments"]),
      }),
    );
  });

  if (parts.length === 0) {
    parts = [t.textPart({ text: "" })]; // MAP-2
  }

  const usage = usageFromChat(obj(data["usage"]));
  return t.response({
    id: pyTruthy(data["id"]) ? pyStr(data["id"]) : null,
    model: pyTruthy(data["model"]) ? pyStr(data["model"]) : request.model,
    message: t.message({ role: "assistant", parts }),
    finish_reason: chatFinishReason(choice["finish_reason"], hasToolCall(parts), unmapped),
    usage,
    provider_data: attachUnmapped(data, unmapped),
  });
}
