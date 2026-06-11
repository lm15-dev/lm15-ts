/**
 * Anthropic Messages API adapter — request building (Stage C).
 *
 * max_tokens arithmetic: when reasoning is enabled, the wire max_tokens
 * includes both thinking and visible budgets (spec/invariants.md; the
 * thinking+visible sum or an explicit total_budget).
 */

import { type JsonObject, type JsonValue, isJsonObject } from "../canonical-json.js";
import { ValueError } from "../errors.js";
import type { BuiltinTool, Message, Part, Request, ToolChoice, Response } from "../types.js";
import {
  anthropicSource,
  continuationData,
  partsToText,
  systemText,
  trimTrailingSlash,
  wireFloat,
  type ProviderAdapter,
  type WireRequest,
} from "./common.js";
import { parseAnthropicResponse } from "./parse-response.js";

const ANTHROPIC_BUILTIN_MAP: Record<string, string> = {
  web_search: "web_search_20250305",
  code_execution: "code_execution_20250522",
};

const DEFAULT_VISIBLE_TOKENS = 1024;
const DEFAULT_THINKING_BUDGET = 1024;

function builtinToAnthropic(tool: BuiltinTool): JsonObject {
  const out: JsonObject = {
    type: ANTHROPIC_BUILTIN_MAP[tool.name] ?? tool.name,
    name: tool.name,
  };
  if (tool.config !== null && Object.keys(tool.config).length > 0) {
    Object.assign(out, tool.config);
  }
  return out;
}

/** Map canonical lm15 response_format to Anthropic output_config. */
function responseFormatToOutputConfig(formatConfig: JsonObject): JsonObject {
  const outputConfig = formatConfig["output_config"];
  if (isJsonObject(outputConfig)) return { ...outputConfig };

  if (isJsonObject(formatConfig["format"])) return { ...formatConfig };

  const fmtType = formatConfig["type"];
  if (fmtType === "json_schema") {
    const schema = formatConfig["schema"];
    return {
      format: { type: "json_schema", schema: isJsonObject(schema) ? schema : {} },
    };
  }
  if (fmtType === "json_object") {
    return { format: { type: "json_schema", schema: { type: "object" } } };
  }
  const rawSchema = formatConfig["schema"];
  const schema = isJsonObject(rawSchema) ? rawSchema : formatConfig;
  return { format: { type: "json_schema", schema } };
}

function reasoningThinkingBudget(request: Request): number | null {
  const reasoning = request.config.reasoning;
  if (reasoning === null || reasoning.effort === "off") return null;
  return reasoning.thinking_budget ?? DEFAULT_THINKING_BUDGET;
}

function maxTokensForAnthropic(request: Request, thinkingBudget: number | null): number {
  if (thinkingBudget === null) {
    return request.config.max_tokens ?? DEFAULT_VISIBLE_TOKENS;
  }
  const reasoning = request.config.reasoning;
  if (reasoning !== null && reasoning.total_budget !== null) {
    if (reasoning.total_budget <= thinkingBudget) {
      throw new ValueError(
        "Anthropic requires Reasoning.total_budget to be greater than " +
          "Reasoning.thinking_budget because max_tokens includes thinking tokens",
      );
    }
    return reasoning.total_budget;
  }
  const visibleBudget = request.config.max_tokens ?? DEFAULT_VISIBLE_TOKENS;
  return thinkingBudget + visibleBudget;
}

function toolChoicePayload(tc: ToolChoice | null): JsonObject | null {
  if (tc === null) return null;
  const payload: JsonObject = {};
  if (tc.mode === "none") {
    payload["type"] = "none";
  } else if (tc.allowed.length === 1) {
    payload["type"] = "tool";
    payload["name"] = tc.allowed[0]!;
  } else if (tc.allowed.length > 1) {
    payload["type"] = tc.mode === "required" ? "any" : "auto";
  } else if (tc.mode === "required") {
    payload["type"] = "any";
  } else {
    payload["type"] = "auto";
  }
  if (tc.parallel === false && payload["type"] !== "none") {
    payload["disable_parallel_tool_use"] = true;
  }
  return payload;
}

export class AnthropicAdapter implements ProviderAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.anthropic.com/v1",
    private readonly apiVersion: string = "2023-06-01",
  ) {}

  private headers(request: Request): Record<string, string> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
      "content-type": "application/json",
    };
    if (request.tools.some((tool) => tool.type === "builtin" && tool.name === "code_execution")) {
      headers["anthropic-beta"] = "code-execution-2025-05-22";
    }
    return headers;
  }

  private part(part: Part): JsonObject {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return { type: "image", source: anthropicSource(part) };
      case "document":
        return { type: "document", source: anthropicSource(part) };
      case "tool_call":
        return { type: "tool_use", id: part.id, name: part.name, input: part.input };
      case "tool_result": {
        const contentBlocks = part.content.map((p) => this.toolResultContent(p));
        const out: JsonObject = { type: "tool_result", tool_use_id: part.id };
        if (contentBlocks.length > 0) {
          if (contentBlocks.length === 1 && contentBlocks[0]!["type"] === "text") {
            out["content"] = contentBlocks[0]!["text"]!;
          } else {
            out["content"] = contentBlocks;
          }
        }
        if (part.is_error) out["is_error"] = true;
        return out;
      }
      case "thinking": {
        const redacted = continuationData(part.continuation, "anthropic", "redacted_thinking");
        if (redacted !== null) return { type: "redacted_thinking", ...redacted };
        const signature = continuationData(part.continuation, "anthropic", "thinking_signature");
        const sig = signature?.["signature"];
        if (typeof sig === "string" && sig !== "") {
          return { type: "thinking", thinking: part.text, signature: sig };
        }
        return { type: "text", text: part.text };
      }
      default: {
        const text = "text" in part && typeof part.text === "string" ? part.text : "";
        return { type: "text", text };
      }
    }
  }

  private toolResultContent(part: Part): JsonObject {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return { type: "image", source: anthropicSource(part) };
      case "document":
        return { type: "document", source: anthropicSource(part) };
      default: {
        const text = "text" in part && typeof part.text === "string" ? part.text : "";
        return { type: "text", text };
      }
    }
  }

  private message(msg: Message): JsonObject {
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (msg.role === "developer") {
      return {
        role: "user",
        content: [{ type: "text", text: `[developer]\n${partsToText(msg.parts)}` }],
      };
    }
    return { role, content: msg.parts.map((part) => this.part(part)) };
  }

  private payload(request: Request, stream: boolean): JsonObject {
    const cfg = request.config;
    const cacheCfg = cfg.cache;
    const useCache = cacheCfg !== null && cacheCfg.mode !== "off";
    const longCache = cacheCfg !== null && cacheCfg.retention === "long";

    const messages = request.messages.map((m) => this.message(m));

    if (useCache && cacheCfg.prefix_until_index !== null) {
      const idx = Math.min(cacheCfg.prefix_until_index, messages.length - 1);
      if (idx >= 0) {
        const content = messages[idx]!["content"];
        if (Array.isArray(content) && content.length > 0) {
          const lastBlock = content[content.length - 1];
          if (isJsonObject(lastBlock as JsonValue) && (lastBlock as JsonObject)["cache_control"] === undefined) {
            (lastBlock as JsonObject)["cache_control"] = { type: "ephemeral" };
          }
        }
      }
    }

    const thinkingBudget = reasoningThinkingBudget(request);
    const payload: JsonObject = {
      model: request.model,
      messages,
      stream,
      max_tokens: maxTokensForAnthropic(request, thinkingBudget),
    };

    if (request.system !== null) {
      const text = systemText(request.system);
      if (useCache) {
        const cacheMarker: JsonObject = { type: "ephemeral" };
        if (longCache) cacheMarker["ttl"] = "1h";
        payload["system"] = [{ type: "text", text, cache_control: cacheMarker }];
      } else {
        payload["system"] = text;
      }
    }
    if (cfg.temperature !== null) payload["temperature"] = wireFloat(cfg.temperature);
    if (cfg.top_p !== null) payload["top_p"] = wireFloat(cfg.top_p);
    if (cfg.top_k !== null) payload["top_k"] = cfg.top_k;
    if (cfg.stop.length > 0) payload["stop_sequences"] = [...cfg.stop];
    if (request.tools.length > 0) {
      payload["tools"] = request.tools.map((tool) =>
        tool.type === "function"
          ? { name: tool.name, description: tool.description, input_schema: tool.parameters }
          : builtinToAnthropic(tool),
      );
    }
    const toolChoice = toolChoicePayload(cfg.tool_choice);
    if (toolChoice !== null) payload["tool_choice"] = toolChoice;
    if (thinkingBudget !== null) {
      payload["thinking"] = { type: "enabled", budget_tokens: thinkingBudget };
    }
    if (cfg.response_format !== null) {
      payload["output_config"] = responseFormatToOutputConfig(cfg.response_format);
    }
    if (cfg.extensions !== null) {
      for (const [key, value] of Object.entries(cfg.extensions)) {
        if (key !== "prompt_caching") payload[key] = value;
      }
    }
    return payload;
  }

  buildRequest(request: Request, stream: boolean): WireRequest {
    return {
      method: "POST",
      url: `${trimTrailingSlash(this.baseUrl)}/messages`,
      params: {},
      headers: this.headers(request),
      body: this.payload(request, stream),
    };
  }
  parseResponse(request: Request, _status: number, body: JsonValue): Response {
    return parseAnthropicResponse(request, body);
  }
}
