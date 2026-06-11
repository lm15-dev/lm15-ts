/**
 * OpenAI Responses API adapter — request building (Stage C).
 *
 * Wire mapping mirrors the contract's openai/ case fixtures; compat policy
 * (developer role, max-tokens field name, reasoning format) resolves from
 * the base URL plus request-extension overrides (see compat.ts).
 */

import { type JsonObject, type JsonValue, isJsonObject } from "../canonical-json.js";
import { resolveOpenAIResponsesCompat, type ResolvedOpenAIResponsesCompat } from "../compat.js";
import type { BuiltinTool, Message, Part, Request, ToolChoice, Response, StreamEvent } from "../types.js";
import {
  compactJson,
  mediaDataUri,
  partsToText,
  systemText,
  toolResultTypeListJson,
  trimTrailingSlash,
  wireFloat,
  type ProviderAdapter,
  type WireRequest,
} from "./common.js";
import { parseOpenAIResponse } from "./parse-response.js";
import { parseOpenAIStreamEvents } from "./parse-stream.js";
import type { SSEEvent } from "../sse.js";

const OPENAI_BUILTIN_MAP: Record<string, string> = {
  web_search: "web_search_preview",
  code_execution: "code_interpreter",
  file_search: "file_search",
  computer_use: "computer_use_preview",
};

function builtinToOpenAI(tool: BuiltinTool): JsonObject {
  const out: JsonObject = { type: OPENAI_BUILTIN_MAP[tool.name] ?? tool.name };
  if (tool.config !== null && Object.keys(tool.config).length > 0) {
    Object.assign(out, tool.config);
  }
  return out;
}

/** Map canonical lm15 response_format to OpenAI Responses text config. */
function responseFormatToOpenAIText(formatConfig: JsonObject): JsonObject {
  const textConfig = formatConfig["text"];
  if (isJsonObject(textConfig)) return textConfig;

  const textFormat = formatConfig["format"];
  if (isJsonObject(textFormat)) return { ...formatConfig };

  if (formatConfig["type"] === "json_schema") {
    const fmt: JsonObject = { ...formatConfig };
    if (fmt["name"] === undefined) fmt["name"] = "response";
    return { format: fmt };
  }
  if (formatConfig["type"] === "json_object") {
    return { format: { ...formatConfig } };
  }
  const rawSchema = formatConfig["schema"];
  const schema = isJsonObject(rawSchema) ? rawSchema : formatConfig;
  const name = formatConfig["name"];
  return {
    format: {
      type: "json_schema",
      name: typeof name === "string" && name !== "" ? name : "response",
      schema,
    },
  };
}

function partToOpenAIInput(part: Part): JsonObject {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image": {
      if (part.url !== null) {
        const payload: JsonObject = { type: "input_image", image_url: part.url };
        if (part.detail !== null) payload["detail"] = part.detail;
        return payload;
      }
      if (part.data !== null) {
        const payload: JsonObject = { type: "input_image", image_url: mediaDataUri(part) };
        if (part.detail !== null) payload["detail"] = part.detail;
        return payload;
      }
      if (part.file_id !== null) return { type: "input_image", file_id: part.file_id };
      break;
    }
    case "audio": {
      if (part.data !== null) {
        let media = (part.media_type || "audio/wav").split("/").slice(1).join("/") || "wav";
        if (media === "mpeg" || media === "mp3") media = "mp3";
        return { type: "input_audio", audio: part.data, format: media };
      }
      if (part.url !== null) return { type: "input_audio", audio_url: part.url };
      if (part.file_id !== null) return { type: "input_audio", file_id: part.file_id };
      break;
    }
    case "document":
    case "binary": {
      if (part.url !== null) return { type: "input_file", file_url: part.url };
      if (part.data !== null) {
        const subtype =
          (part.media_type || "application/octet-stream").split("/").slice(1).join("/").split("+")[0] ||
          "bin";
        return { type: "input_file", filename: `file.${subtype}`, file_data: mediaDataUri(part) };
      }
      if (part.file_id !== null) return { type: "input_file", file_id: part.file_id };
      break;
    }
    case "video": {
      if (part.url !== null) return { type: "input_video", video_url: part.url };
      if (part.data !== null) return { type: "input_video", video_data: mediaDataUri(part) };
      if (part.file_id !== null) return { type: "input_video", file_id: part.file_id };
      break;
    }
    case "tool_result":
      return { type: "input_text", text: partsToText(part.content) };
    case "citation":
      return { type: "input_text", text: partsToText([part]) };
    case "thinking":
      return { type: "input_text", text: part.text };
    default:
      break;
  }
  const text = "text" in part && typeof part.text === "string" ? part.text : "";
  return { type: "input_text", text };
}

function toolChoicePayload(tc: ToolChoice | null): JsonValue | null {
  if (tc === null) return null;
  if (tc.mode === "none") return "none";
  if (tc.allowed.length === 1) return { type: "function", name: tc.allowed[0]! };
  if (tc.mode === "required") return "required";
  return "auto";
}

const RESERVED_EXTENSIONS = new Set([
  "prompt_caching",
  "cache",
  "compat",
  "openai_compat",
  "openai_responses_compat",
]);

export class OpenAIAdapter implements ProviderAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.openai.com/v1",
  ) {}

  private buildInput(
    messages: readonly Message[],
    compat: ResolvedOpenAIResponsesCompat,
  ): JsonValue[] {
    const items: JsonValue[] = [];
    for (const msg of messages) {
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type !== "tool_result") continue;
          let output = partsToText(part.content);
          if (output === "") output = toolResultTypeListJson(part.content);
          const item: JsonObject = {
            type: "function_call_output",
            call_id: part.id,
            output,
          };
          if (compat.tool_result_name === "include" && part.name !== null && part.name !== "") {
            item["name"] = part.name;
          }
          items.push(item);
        }
        continue;
      }

      let contentParts: JsonObject[];
      if (msg.role === "assistant") {
        contentParts = [];
        for (const part of msg.parts) {
          if (part.type === "text") {
            contentParts.push({ type: "output_text", text: part.text });
          } else if (part.type === "refusal") {
            contentParts.push({ type: "refusal", refusal: part.text });
          }
        }
      } else {
        contentParts = msg.parts
          .filter((p) => p.type !== "tool_call" && p.type !== "tool_result")
          .map(partToOpenAIInput);
      }
      if (contentParts.length > 0) {
        const role = msg.role === "developer" ? compat.developer_role : msg.role;
        items.push({ role, content: contentParts });
      }

      for (const part of msg.parts) {
        if (part.type === "tool_call") {
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: compactJson(part.input),
          });
        }
      }
    }
    return items;
  }

  private payload(request: Request, stream: boolean): JsonObject {
    const cfg = request.config;
    const compat = resolveOpenAIResponsesCompat(this.baseUrl, cfg.extensions);
    const payload: JsonObject = {
      model: request.model,
      input: this.buildInput(request.messages, compat),
      stream,
    };
    if (request.system !== null) payload["instructions"] = systemText(request.system);
    if (cfg.max_tokens !== null) payload[compat.max_output_tokens_field] = cfg.max_tokens;
    if (cfg.temperature !== null) payload["temperature"] = wireFloat(cfg.temperature);
    if (cfg.top_p !== null) payload["top_p"] = wireFloat(cfg.top_p);
    if (request.tools.length > 0) {
      const toolsWire: JsonValue[] = [];
      for (const tool of request.tools) {
        if (tool.type === "function") {
          const toolPayload: JsonObject = {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          };
          if (compat.strict_tools === "include") toolPayload["strict"] = false;
          toolsWire.push(toolPayload);
        } else {
          toolsWire.push(builtinToOpenAI(tool));
        }
      }
      payload["tools"] = toolsWire;
    }
    const toolChoice = toolChoicePayload(cfg.tool_choice);
    if (toolChoice !== null) payload["tool_choice"] = toolChoice;
    if (cfg.tool_choice !== null && cfg.tool_choice.parallel !== null) {
      payload["parallel_tool_calls"] = cfg.tool_choice.parallel;
    }
    if (cfg.response_format !== null) {
      payload["text"] = responseFormatToOpenAIText(cfg.response_format);
    }
    if (cfg.reasoning !== null) {
      const reasoning = cfg.reasoning;
      if (reasoning.effort !== "off") {
        const effort =
          reasoning.effort === "adaptive" ? "medium" : reasoning.effort === "xhigh" ? "high" : reasoning.effort;
        switch (compat.reasoning_format) {
          case "responses_reasoning": {
            const reasoningPayload: JsonObject = { effort };
            if (reasoning.summary !== null) reasoningPayload["summary"] = reasoning.summary;
            payload["reasoning"] = reasoningPayload;
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
        switch (compat.reasoning_format) {
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
          default:
            break;
        }
      }
    }
    if (cfg.cache !== null && cfg.cache.mode !== "off" && compat.cache_control === "openai") {
      if (cfg.cache.key !== null) payload["prompt_cache_key"] = cfg.cache.key;
      if (cfg.cache.retention === "long") payload["prompt_cache_retention"] = "24h";
    }
    if (compat.routing !== null) payload["provider"] = compat.routing;
    if (cfg.extensions !== null) {
      for (const [key, value] of Object.entries(cfg.extensions)) {
        if (!RESERVED_EXTENSIONS.has(key)) payload[key] = value;
      }
    }
    return payload;
  }

  buildRequest(request: Request, stream: boolean): WireRequest {
    return {
      method: "POST",
      url: `${trimTrailingSlash(this.baseUrl)}/responses`,
      params: {},
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: this.payload(request, stream),
    };
  }
  parseResponse(request: Request, _status: number, body: JsonValue): Response {
    return parseOpenAIResponse(request, body);
  }

  parseStreamEvents(request: Request, raw: SSEEvent): StreamEvent[] {
    return parseOpenAIStreamEvents(request, raw);
  }
}
