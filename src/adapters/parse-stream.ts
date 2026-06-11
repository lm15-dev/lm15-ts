/**
 * Per-provider stream-event mapping (Stage E).
 *
 * Each function maps ONE provider SSE frame to zero or more canonical
 * StreamEvents, statelessly — MAP-3's single-end-event guarantee is the
 * coalescer's job (src/stream.ts), not the adapter's. Mapping behavior
 * mirrors the reference `parse_stream_events` implementations
 * (lm15-python2/lm15/providers/*.py) where the spec is silent.
 */

import { isJsonObject, parseCanonicalJson, type JsonObject, type JsonValue } from "../canonical-json.js";
import {
  AuthError,
  BillingError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  UnsupportedModelError,
  canonicalErrorCode,
} from "../errors.js";
import {
  ANTHROPIC_TYPE_MAP,
  GEMINI_STATUS_MAP,
  isContextLengthMessage,
  isGeminiContextLengthMessage,
  isModelError,
} from "../normalize-error.js";
import type { SSEEvent } from "../sse.js";
import * as t from "../types.js";
import { asArray, compactJson, counterOrUndefined, intCount, pyStr, pyTruthy, strOrEmpty } from "./common.js";
import {
  CHAT_FINISH_REASON_MAP,
  OPENAI_RESPONSE_ERROR_CODE_MAP,
  anthropicFinishReason,
  geminiFinishReason,
  usageFromChat,
  type ProviderErrorCtor,
} from "./parse-response.js";

function obj(v: JsonValue | undefined): JsonObject {
  return v !== undefined && v !== null && isJsonObject(v) ? v : {};
}

function intIndex(v: JsonValue | undefined): number {
  const n = pyTruthy(v) ? v : 0;
  return typeof n === "number" ? Math.trunc(n) : 0;
}

function strOrNullTruthy(v: JsonValue | undefined): string | null {
  const s = strOrEmpty(v);
  return s === "" ? null : s;
}

function detailFor(cls: ProviderErrorCtor, providerCode: string, message: string): t.ErrorDetail {
  return t.errorDetail({
    code: canonicalErrorCode(new cls("")),
    message: message || providerCode || "provider error",
    provider_code: providerCode || "provider",
  });
}

// ─── openai (Responses API) ──────────────────────────────────────────

/** Reference `_stream_error_code_map` (openai.py). */
const OPENAI_STREAM_ERROR_CODE_MAP: Record<string, ProviderErrorCtor> = {
  ...OPENAI_RESPONSE_ERROR_CODE_MAP,
  context_length_exceeded: ContextLengthError,
  invalid_api_key: AuthError,
  insufficient_quota: BillingError,
  authentication_error: AuthError,
  rate_limit_error: RateLimitError,
};

function openaiStreamErrorDetail(providerCode: string, message: string): t.ErrorDetail {
  const cls = OPENAI_STREAM_ERROR_CODE_MAP[providerCode] ?? ProviderError;
  return detailFor(cls, providerCode, message);
}

export function parseOpenAIStreamEvents(request: t.Request, raw: SSEEvent): t.StreamEvent[] {
  if (!raw.data) return [];
  if (raw.data === "[DONE]") return [t.streamEndEvent({ finish_reason: "stop" })];
  const payload = obj(parseCanonicalJson(raw.data));
  const et = strOrEmpty(payload["type"]);

  if (et === "response.created") {
    const response = obj(payload["response"]);
    return [
      t.streamStartEvent({
        id: strOrNullTruthy(response["id"]),
        model: pyTruthy(response["model"]) ? pyStr(response["model"]) : request.model,
      }),
    ];
  }

  if (et === "response.output_text.delta" || et === "response.refusal.delta") {
    return [
      t.streamDeltaEvent(
        t.textDelta({ text: strOrEmpty(payload["delta"]), part_index: intIndex(payload["output_index"]) }),
      ),
    ];
  }

  if (et === "response.reasoning_summary_text.delta" || et === "response.reasoning_text.delta") {
    return [
      t.streamDeltaEvent(
        t.thinkingDelta({ text: strOrEmpty(payload["delta"]), part_index: intIndex(payload["output_index"]) }),
      ),
    ];
  }

  if (et === "response.output_text.annotation.added") {
    const annotation = payload["annotation"];
    if (annotation !== undefined && annotation !== null && isJsonObject(annotation)) {
      const text = strOrNullTruthy(
        pyTruthy(annotation["text"])
          ? annotation["text"]
          : pyTruthy(annotation["snippet"])
            ? annotation["snippet"]
            : pyTruthy(annotation["cited_text"])
              ? annotation["cited_text"]
              : annotation["quote"],
      );
      const url = strOrNullTruthy(pyTruthy(annotation["url"]) ? annotation["url"] : annotation["uri"]);
      const title = strOrNullTruthy(
        pyTruthy(annotation["title"])
          ? annotation["title"]
          : pyTruthy(annotation["filename"])
            ? annotation["filename"]
            : annotation["file_id"],
      );
      if (text !== null || url !== null || title !== null) {
        return [
          t.streamDeltaEvent(
            t.citationDelta({ text, url, title, part_index: intIndex(payload["output_index"]) }),
          ),
        ];
      }
    }
    return [];
  }

  if (et === "response.output_audio.delta") {
    return [
      t.streamDeltaEvent(
        t.audioDelta({
          data: strOrEmpty(payload["delta"]),
          part_index: intIndex(payload["output_index"]),
          media_type: "audio/wav",
        }),
      ),
    ];
  }

  if (et === "response.output_image.delta" || et === "response.image.delta") {
    return [
      t.streamDeltaEvent(
        t.imageDelta({
          data: strOrEmpty(payload["delta"]),
          part_index: intIndex(payload["output_index"]),
          media_type: "image/png",
        }),
      ),
    ];
  }

  if (et === "response.output_item.added") {
    const item = obj(payload["item"]);
    if (item["type"] === "function_call") {
      return [
        t.streamDeltaEvent(
          t.toolCallDelta({
            input: strOrEmpty(item["arguments"]),
            part_index: intIndex(payload["output_index"]),
            id: strOrNullTruthy(pyTruthy(item["call_id"]) ? item["call_id"] : item["id"]),
            name: strOrNullTruthy(item["name"]),
          }),
        ),
      ];
    }
    return [];
  }

  if (et === "response.function_call_arguments.delta") {
    return [
      t.streamDeltaEvent(
        t.toolCallDelta({
          input: strOrEmpty(payload["delta"]),
          part_index: intIndex(payload["output_index"]),
          id: strOrNullTruthy(pyTruthy(payload["call_id"]) ? payload["call_id"] : payload["id"]),
          name: strOrNullTruthy(payload["name"]),
        }),
      ),
    ];
  }

  if (et === "response.completed") {
    const response = obj(payload["response"]);
    const usageData = obj(response["usage"]);
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
    const hasTool = asArray(response["output"]).some(
      (item) => isJsonObject(item) && item["type"] === "function_call",
    );
    return [
      t.streamEndEvent({
        finish_reason: hasTool ? "tool_call" : "stop",
        usage,
        provider_data: isJsonObject(payload["response"] as JsonValue) ? response : null,
      }),
    ];
  }

  if (et === "response.error" || et === "error") {
    const err = payload["error"];
    let providerCode: string;
    let message: string;
    if (err !== undefined && err !== null && isJsonObject(err)) {
      providerCode = strOrEmpty(
        pyTruthy(err["code"]) ? err["code"] : pyTruthy(err["type"]) ? err["type"] : payload["code"],
      ) || "provider";
      message = strOrEmpty(pyTruthy(err["message"]) ? err["message"] : payload["message"]);
    } else {
      providerCode = strOrEmpty(
        pyTruthy(payload["code"]) ? payload["code"] : payload["error_type"],
      ) || "provider";
      message = strOrEmpty(payload["message"]);
    }
    return [t.streamErrorEvent(openaiStreamErrorDetail(providerCode, message))];
  }

  return [];
}

// ─── openai_chat (Chat Completions dialect) ──────────────────────────

export function parseOpenAIChatStreamEvents(_request: t.Request, raw: SSEEvent): t.StreamEvent[] {
  if (!raw.data) return [];
  if (raw.data === "[DONE]") return [t.streamEndEvent({})];
  const parsed = parseCanonicalJson(raw.data);
  if (!isJsonObject(parsed)) return [];
  const payload = parsed;

  const err = payload["error"];
  if (err !== undefined && err !== null && isJsonObject(err)) {
    const providerCode =
      strOrEmpty(pyTruthy(err["code"]) ? err["code"] : err["type"]) || "provider";
    return [
      t.streamErrorEvent(openaiStreamErrorDetail(providerCode, strOrEmpty(err["message"]))),
    ];
  }

  const events: t.StreamEvent[] = [];
  const choices = asArray(payload["choices"]);
  const choice = choices.length > 0 && isJsonObject(choices[0]!) ? (choices[0] as JsonObject) : {};
  const delta = obj(choice["delta"]);

  const reasoningText = pyTruthy(delta["reasoning_content"])
    ? delta["reasoning_content"]
    : delta["reasoning"];
  if (pyTruthy(reasoningText)) {
    events.push(t.streamDeltaEvent(t.thinkingDelta({ text: pyStr(reasoningText) })));
  }

  const content = delta["content"];
  if (typeof content === "string" && content !== "") {
    events.push(t.streamDeltaEvent(t.textDelta({ text: content })));
  }

  for (const call of asArray(delta["tool_calls"])) {
    if (!isJsonObject(call)) continue;
    const fn = obj(call["function"]);
    events.push(
      t.streamDeltaEvent(
        t.toolCallDelta({
          input: strOrEmpty(fn["arguments"]),
          part_index: intIndex(call["index"]),
          id: strOrNullTruthy(call["id"]),
          name: strOrNullTruthy(fn["name"]),
        }),
      ),
    );
  }

  const finishRaw = choice["finish_reason"];
  const usageData = payload["usage"];
  const usageObj =
    usageData !== undefined && usageData !== null && isJsonObject(usageData) ? usageData : null;
  if (pyTruthy(finishRaw)) {
    events.push(
      t.streamEndEvent({
        finish_reason: CHAT_FINISH_REASON_MAP[pyStr(finishRaw)] ?? "stop",
        usage: usageObj !== null ? usageFromChat(usageObj) : null,
      }),
    );
  } else if (usageObj !== null) {
    // Final usage-only chunk (stream_options.include_usage).
    events.push(t.streamEndEvent({ usage: usageFromChat(usageObj) }));
  }
  return events;
}

// ─── anthropic ───────────────────────────────────────────────────────

function anthropicStreamErrorDetail(providerCode: string, message: string): t.ErrorDetail {
  let cls: ProviderErrorCtor = ANTHROPIC_TYPE_MAP[providerCode] ?? ProviderError;
  if (isContextLengthMessage(message)) cls = ContextLengthError;
  else if (providerCode === "not_found_error" && isModelError(message)) cls = UnsupportedModelError;
  return detailFor(cls, providerCode, message);
}

export function parseAnthropicStreamEvents(request: t.Request, raw: SSEEvent): t.StreamEvent[] {
  if (!raw.data) return [];
  const payload = obj(parseCanonicalJson(raw.data));
  const et = payload["type"];

  if (et === "message_start") {
    const msg = obj(payload["message"]);
    const events: t.StreamEvent[] = [
      t.streamStartEvent({
        id: strOrNullTruthy(msg["id"]),
        model: pyTruthy(msg["model"]) ? pyStr(msg["model"]) : request.model,
      }),
    ];
    if (pyTruthy(msg["id"])) {
      events.push(
        t.streamDeltaEvent(
          t.continuationDelta({
            provider: "anthropic",
            kind: "message_id",
            data: { id: pyStr(msg["id"]) },
            part_index: null,
          }),
        ),
      );
    }
    return events;
  }

  if (et === "content_block_start") {
    const block = obj(payload["content_block"]);
    if (block["type"] === "tool_use") {
      const input = block["input"];
      return [
        t.streamDeltaEvent(
          t.toolCallDelta({
            input:
              input !== undefined && input !== null && isJsonObject(input)
                ? compactJson(input)
                : strOrEmpty(input),
            part_index: intIndex(payload["index"]),
            id: strOrNullTruthy(block["id"]),
            name: strOrNullTruthy(block["name"]),
          }),
        ),
      ];
    }
    if (block["type"] === "redacted_thinking" && block["data"] !== undefined && block["data"] !== null) {
      const idx = intIndex(payload["index"]);
      return [
        t.streamDeltaEvent(t.thinkingDelta({ text: "[redacted]", part_index: idx })),
        t.streamDeltaEvent(
          t.continuationDelta({
            provider: "anthropic",
            kind: "redacted_thinking",
            data: { data: block["data"]! },
            part_index: idx,
          }),
        ),
      ];
    }
    return [];
  }

  if (et === "content_block_delta") {
    const delta = obj(payload["delta"]);
    const idx = intIndex(payload["index"]);
    const dtype = delta["type"];
    if (dtype === "text_delta") {
      return [t.streamDeltaEvent(t.textDelta({ text: strOrEmpty(delta["text"]), part_index: idx }))];
    }
    if (dtype === "input_json_delta") {
      return [
        t.streamDeltaEvent(t.toolCallDelta({ input: strOrEmpty(delta["partial_json"]), part_index: idx })),
      ];
    }
    if (dtype === "thinking_delta") {
      return [t.streamDeltaEvent(t.thinkingDelta({ text: strOrEmpty(delta["thinking"]), part_index: idx }))];
    }
    if (dtype === "signature_delta" && pyTruthy(delta["signature"])) {
      return [
        t.streamDeltaEvent(
          t.continuationDelta({
            provider: "anthropic",
            kind: "thinking_signature",
            data: { signature: pyStr(delta["signature"]) },
            part_index: idx,
          }),
        ),
      ];
    }
    if (dtype === "citation_delta" || dtype === "citations_delta") {
      const citation = isJsonObject(delta["citation"] as JsonValue) ? obj(delta["citation"]) : delta;
      const text = strOrNullTruthy(
        pyTruthy(citation["cited_text"]) ? citation["cited_text"] : citation["text"],
      );
      return [
        t.streamDeltaEvent(
          t.citationDelta({
            part_index: idx,
            text,
            url: strOrNullTruthy(citation["url"]),
            title: strOrNullTruthy(citation["title"]),
          }),
        ),
      ];
    }
    return [];
  }

  if (et === "message_delta") {
    // Anthropic sends the authoritative stop_reason and final usage here;
    // message_stop is just the terminator and carries neither.
    const delta = obj(payload["delta"]);
    const usagePayload = obj(payload["usage"]);
    let usage: t.Usage | null = null;
    if (Object.keys(usagePayload).length > 0) {
      const inputTokens = intCount(usagePayload["input_tokens"]);
      const outputTokens = intCount(usagePayload["output_tokens"]);
      usage = t.usage({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cache_read_tokens: counterOrUndefined(usagePayload["cache_read_input_tokens"]),
        cache_write_tokens: counterOrUndefined(usagePayload["cache_creation_input_tokens"]),
      });
    }
    const stopReason = delta["stop_reason"];
    if ((stopReason !== undefined && stopReason !== null) || usage !== null) {
      return [
        t.streamEndEvent({
          finish_reason:
            stopReason !== undefined && stopReason !== null
              ? anthropicFinishReason(stopReason, false)
              : null,
          usage,
        }),
      ];
    }
    return [];
  }

  if (et === "message_stop") return [t.streamEndEvent({})];

  if (et === "error") {
    const err = payload["error"];
    let providerCode: string;
    let message: string;
    if (err !== undefined && err !== null && isJsonObject(err)) {
      providerCode =
        strOrEmpty(
          pyTruthy(err["type"]) ? err["type"] : pyTruthy(err["code"]) ? err["code"] : payload["code"],
        ) || "provider";
      message = strOrEmpty(pyTruthy(err["message"]) ? err["message"] : payload["message"]);
    } else {
      providerCode =
        strOrEmpty(pyTruthy(payload["code"]) ? payload["code"] : payload["error_type"]) || "provider";
      message = strOrEmpty(payload["message"]);
    }
    return [t.streamErrorEvent(anthropicStreamErrorDetail(providerCode, message))];
  }

  return [];
}

// ─── gemini ──────────────────────────────────────────────────────────

function geminiStreamErrorDetail(providerCode: string, message: string): t.ErrorDetail {
  let cls: ProviderErrorCtor = GEMINI_STATUS_MAP[providerCode] ?? ProviderError;
  if (isGeminiContextLengthMessage(message)) cls = ContextLengthError;
  else if (providerCode === "NOT_FOUND" && isModelError(message)) cls = UnsupportedModelError;
  return detailFor(cls, providerCode, message);
}

/** Reference `_inband_error` finish reasons that abort the stream (gemini.py). */
const GEMINI_BLOCK_FINISH: ReadonlySet<string> = new Set([
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

function geminiInbandStreamError(payload: JsonObject): t.ErrorDetail | null {
  const promptFeedback = payload["promptFeedback"];
  if (promptFeedback !== undefined && promptFeedback !== null && isJsonObject(promptFeedback)) {
    const blockReason = strOrEmpty(promptFeedback["blockReason"]);
    if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
      return t.errorDetail({
        code: "invalid_request",
        provider_code: "inband_finish_reason",
        message: `Prompt blocked: ${blockReason}`,
      });
    }
  }
  const candidates = asArray(payload["candidates"]);
  const candidate = candidates.length > 0 && isJsonObject(candidates[0]!) ? (candidates[0] as JsonObject) : {};
  const finishReason = strOrEmpty(candidate["finishReason"]);
  if (GEMINI_BLOCK_FINISH.has(finishReason)) {
    const finishMessage = strOrEmpty(candidate["finishMessage"]);
    return t.errorDetail({
      code: "invalid_request",
      provider_code: "inband_finish_reason",
      message: finishMessage || `Candidate blocked: ${finishReason}`,
    });
  }
  return null;
}

function geminiUsageFromPayload(payload: JsonObject): t.Usage {
  const usagePayload = obj(payload["usageMetadata"]);
  const outputRaw =
    usagePayload["candidatesTokenCount"] !== undefined
      ? usagePayload["candidatesTokenCount"]
      : usagePayload["responseTokenCount"];
  return t.usage({
    input_tokens: intCount(usagePayload["promptTokenCount"]),
    output_tokens: intCount(outputRaw),
    total_tokens: counterOrUndefined(usagePayload["totalTokenCount"]),
    cache_read_tokens: counterOrUndefined(usagePayload["cachedContentTokenCount"]),
    reasoning_tokens: counterOrUndefined(usagePayload["thoughtsTokenCount"]),
  });
}

export function parseGeminiStreamEvents(_request: t.Request, raw: SSEEvent): t.StreamEvent[] {
  if (!raw.data) return [];
  const parsed = parseCanonicalJson(raw.data);
  if (!isJsonObject(parsed)) return [];
  const payload = parsed;

  const errRaw = payload["error"];
  if (errRaw !== undefined) {
    let providerCode = "provider";
    let message = "";
    if (errRaw !== null && isJsonObject(errRaw)) {
      providerCode =
        strOrEmpty(pyTruthy(errRaw["status"]) ? errRaw["status"] : errRaw["code"]) || "provider";
      message = strOrEmpty(errRaw["message"]);
    }
    return [t.streamErrorEvent(geminiStreamErrorDetail(providerCode, message))];
  }

  const inband = geminiInbandStreamError(payload);
  if (inband !== null) return [t.streamErrorEvent(inband)];

  const events: t.StreamEvent[] = [];
  const candidates = asArray(payload["candidates"]);
  const candidate =
    candidates.length > 0 && isJsonObject(candidates[0]!) ? (candidates[0] as JsonObject) : null;
  let yieldedDelta = false;
  let sawTool = false;
  let finish: JsonValue | undefined;

  if (candidate !== null) {
    const content = obj(candidate["content"]);
    asArray(content["parts"]).forEach((partRaw, idx) => {
      if (!isJsonObject(partRaw)) return;
      const part = partRaw;
      if (pyTruthy(part["thought"]) && "text" in part) {
        yieldedDelta = true;
        events.push(t.streamDeltaEvent(t.thinkingDelta({ text: strOrEmpty(part["text"]), part_index: idx })));
        if (part["thoughtSignature"] !== undefined && part["thoughtSignature"] !== null) {
          events.push(
            t.streamDeltaEvent(
              t.continuationDelta({
                provider: "gemini",
                kind: "thought_signature",
                data: { value: pyStr(part["thoughtSignature"]) },
                part_index: idx,
              }),
            ),
          );
        }
      } else if ("text" in part) {
        yieldedDelta = true;
        events.push(t.streamDeltaEvent(t.textDelta({ text: strOrEmpty(part["text"]), part_index: idx })));
      } else if (part["functionCall"] !== undefined && isJsonObject(part["functionCall"] as JsonValue)) {
        const fc = obj(part["functionCall"]);
        sawTool = true;
        yieldedDelta = true;
        events.push(
          t.streamDeltaEvent(
            t.toolCallDelta({
              input: compactJson(obj(fc["args"])),
              part_index: idx,
              id: strOrNullTruthy(fc["id"]),
              name: strOrNullTruthy(fc["name"]),
            }),
          ),
        );
        const thoughtSignature = pyTruthy(part["thoughtSignature"])
          ? part["thoughtSignature"]
          : fc["thoughtSignature"];
        if (thoughtSignature !== undefined && thoughtSignature !== null) {
          events.push(
            t.streamDeltaEvent(
              t.continuationDelta({
                provider: "gemini",
                kind: "thought_signature",
                data: { value: pyStr(thoughtSignature) },
                part_index: idx,
              }),
            ),
          );
        }
      } else if (part["inlineData"] !== undefined && isJsonObject(part["inlineData"] as JsonValue)) {
        const inline = obj(part["inlineData"]);
        const mime = pyTruthy(inline["mimeType"]) ? pyStr(inline["mimeType"]) : "application/octet-stream";
        const data = strOrEmpty(inline["data"]);
        if (mime.startsWith("audio/")) {
          yieldedDelta = true;
          events.push(t.streamDeltaEvent(t.audioDelta({ data, part_index: idx, media_type: mime })));
        } else if (mime.startsWith("image/")) {
          yieldedDelta = true;
          events.push(t.streamDeltaEvent(t.imageDelta({ data, part_index: idx, media_type: mime })));
        }
      }
    });
    finish = candidate["finishReason"];
  }

  if (payload["responseId"] !== undefined && payload["responseId"] !== null) {
    events.push(
      t.streamDeltaEvent(
        t.continuationDelta({
          provider: "gemini",
          kind: "response_id",
          data: { id: pyStr(payload["responseId"]) },
          part_index: null,
        }),
      ),
    );
  }

  if (pyTruthy(finish)) {
    events.push(
      t.streamEndEvent({
        finish_reason: geminiFinishReason(finish, sawTool),
        usage: geminiUsageFromPayload(payload),
        provider_data: payload,
      }),
    );
  } else if (!yieldedDelta && "usageMetadata" in payload) {
    events.push(
      t.streamEndEvent({
        finish_reason: "stop",
        usage: geminiUsageFromPayload(payload),
        provider_data: payload,
      }),
    );
  }
  return events;
}
