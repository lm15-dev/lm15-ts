/**
 * OpenAI Chat Completions adapter — request building (Stage C).
 *
 * The dialect spoken by OpenAI's legacy endpoint and most compatible
 * servers (ollama, Groq, OpenRouter, vLLM, SGLang). Quirks are described
 * by compat policies; named presets bundle a policy with that server's
 * default base URL.
 */

import { type JsonObject, type JsonValue, isJsonObject } from "../canonical-json.js";
import {
  OPENAI_CHAT_PRESET_BASE_URLS,
  chatCompatPreset,
  resolveOpenAIChatCompat,
  type ResolvedOpenAIChatCompat,
} from "../compat.js";
import type { Message, Part, Request, ToolChoice } from "../types.js";
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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Map non-assistant message parts to chat-completions content. */
function chatContentParts(msg: Message): string | JsonValue[] {
  const parts = msg.parts.filter((p) => p.type !== "tool_call" && p.type !== "tool_result");
  if (parts.length === 1 && parts[0]!.type === "text") {
    return (parts[0] as Part & { text: string }).text;
  }
  const out: JsonValue[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const url = part.url !== null ? part.url : mediaDataUri(part);
      const payload: JsonObject = { url };
      if (part.detail !== null) payload["detail"] = part.detail;
      out.push({ type: "image_url", image_url: payload });
    } else if (part.type === "thinking") {
      continue; // thinking is never replayed as user content
    } else {
      const text = partsToText([part]);
      if (text !== "") out.push({ type: "text", text });
    }
  }
  return out;
}

/** Map canonical lm15 response_format to chat-completions response_format. */
function responseFormatToChat(formatConfig: JsonObject): JsonObject {
  if (formatConfig["type"] === "json_object") return { type: "json_object" };
  if (isJsonObject(formatConfig["json_schema"])) return { ...formatConfig };
  if (formatConfig["type"] === "json_schema") {
    const inner: JsonObject = {};
    for (const [k, v] of Object.entries(formatConfig)) {
      if (k !== "type") inner[k] = v;
    }
    if (inner["name"] === undefined) inner["name"] = "response";
    return { type: "json_schema", json_schema: inner };
  }
  const rawSchema = formatConfig["schema"];
  const schema = isJsonObject(rawSchema) ? rawSchema : formatConfig;
  const name = formatConfig["name"];
  return {
    type: "json_schema",
    json_schema: {
      name: typeof name === "string" && name !== "" ? name : "response",
      schema,
    },
  };
}

function toolChoicePayload(tc: ToolChoice | null): JsonValue | null {
  if (tc === null) return null;
  if (tc.mode === "none") return "none";
  if (tc.allowed.length === 1) {
    return { type: "function", function: { name: tc.allowed[0]! } };
  }
  if (tc.mode === "required") return "required";
  return "auto";
}

const RESERVED_EXTENSIONS = new Set([
  "prompt_caching",
  "cache",
  "compat",
  "openai_compat",
  "openai_chat_compat",
]);

export class OpenAIChatAdapter implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly compat: ResolvedOpenAIChatCompat;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = DEFAULT_BASE_URL,
    compat: string | ResolvedOpenAIChatCompat | null = null,
  ) {
    if (typeof compat === "string") {
      const key = compat.toLowerCase().replace(/[- ]/g, "_");
      this.compat = chatCompatPreset(compat);
      this.baseUrl =
        baseUrl === DEFAULT_BASE_URL
          ? (OPENAI_CHAT_PRESET_BASE_URLS[key] ?? DEFAULT_BASE_URL)
          : baseUrl;
    } else {
      this.compat = resolveOpenAIChatCompat(compat, null);
      this.baseUrl = baseUrl;
    }
  }

  private buildMessages(request: Request, compat: ResolvedOpenAIChatCompat): JsonValue[] {
    const messages: JsonValue[] = [];
    if (request.system !== null) {
      messages.push({ role: compat.instruction_role, content: systemText(request.system) });
    }

    for (const msg of request.messages) {
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type !== "tool_result") continue;
          let output = partsToText(part.content);
          if (output === "") output = toolResultTypeListJson(part.content);
          const item: JsonObject = { role: "tool", tool_call_id: part.id, content: output };
          if (compat.tool_result_name === "include" && part.name !== null && part.name !== "") {
            item["name"] = part.name;
          }
          messages.push(item);
        }
        continue;
      }

      if (msg.role === "assistant") {
        const textBits: string[] = [];
        for (const part of msg.parts) {
          if (part.type === "text") textBits.push(part.text);
          else if (part.type === "refusal" && part.text !== "") textBits.push(part.text);
          else if (part.type === "thinking" && compat.thinking_replay === "as_text" && part.text !== "") {
            textBits.push(part.text);
          }
        }
        const toolCalls: JsonValue[] = [];
        for (const part of msg.parts) {
          if (part.type !== "tool_call") continue;
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: compactJson(part.input) },
          });
        }
        const item: JsonObject = {
          role: "assistant",
          content: textBits.length > 0 ? textBits.join("\n") : null,
        };
        if (compat.thinking_replay === "native") {
          const thinking = msg.parts
            .filter((p) => p.type === "thinking" && p.text !== "")
            .map((p) => (p as Part & { text: string }).text)
            .join("\n");
          if (thinking !== "" || compat.assistant_reasoning_content === "include_empty") {
            item["reasoning_content"] = thinking;
          }
        }
        if (toolCalls.length > 0) item["tool_calls"] = toolCalls;
        messages.push(item);
        continue;
      }

      const role = msg.role === "developer" ? compat.instruction_role : msg.role;
      const content = chatContentParts(msg);
      if (content === "" || (typeof content === "string" ? content !== "" : content.length > 0)) {
        messages.push({ role, content });
      }
    }
    return messages;
  }

  private payload(request: Request, stream: boolean): JsonObject {
    const cfg = request.config;
    const compat = this.compat;
    const payload: JsonObject = {
      model: request.model,
      messages: this.buildMessages(request, compat),
    };
    if (stream) {
      payload["stream"] = true;
      if (compat.stream_usage === "include") {
        payload["stream_options"] = { include_usage: true };
      }
    }
    if (cfg.max_tokens !== null) payload[compat.max_tokens_field] = cfg.max_tokens;
    if (cfg.temperature !== null) payload["temperature"] = wireFloat(cfg.temperature);
    if (cfg.top_p !== null) payload["top_p"] = wireFloat(cfg.top_p);
    if (cfg.stop.length > 0) payload["stop"] = [...cfg.stop];
    if (request.tools.length > 0) {
      const toolsWire: JsonValue[] = [];
      for (const tool of request.tools) {
        if (tool.type !== "function") continue;
        const functionPayload: JsonObject = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        };
        if (compat.strict_tools === "include") functionPayload["strict"] = false;
        toolsWire.push({ type: "function", function: functionPayload });
      }
      if (toolsWire.length > 0) payload["tools"] = toolsWire;
    }
    const toolChoice = toolChoicePayload(cfg.tool_choice);
    if (toolChoice !== null) payload["tool_choice"] = toolChoice;
    if (cfg.tool_choice !== null && cfg.tool_choice.parallel !== null) {
      payload["parallel_tool_calls"] = cfg.tool_choice.parallel;
    }
    if (cfg.response_format !== null) {
      payload["response_format"] = responseFormatToChat(cfg.response_format);
    }
    if (cfg.reasoning !== null) {
      const reasoning = cfg.reasoning;
      if (reasoning.effort !== "off") {
        const effort =
          reasoning.effort === "adaptive" ? "medium" : reasoning.effort === "xhigh" ? "high" : reasoning.effort;
        switch (compat.thinking_format) {
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
        switch (compat.thinking_format) {
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
      url: `${trimTrailingSlash(this.baseUrl)}/chat/completions`,
      params: {},
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: this.payload(request, stream),
    };
  }
}
