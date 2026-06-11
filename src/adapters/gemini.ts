/**
 * Gemini generateContent adapter — request building (Stage C).
 *
 * proto3-JSON dialect: integral float knobs are sent in integer form
 * (geminiNumber); auth is the x-goog-api-key header; streaming targets
 * :streamGenerateContent with alt=sse.
 */

import { type JsonObject, type JsonValue, isJsonObject } from "../canonical-json.js";
import type { BuiltinTool, Message, Part, Request, Response, StreamEvent } from "../types.js";
import {
  continuationData,
  geminiNumber,
  partsToText,
  systemText,
  trimTrailingSlash,
  type ProviderAdapter,
  type WireRequest,
} from "./common.js";
import { parseGeminiResponse } from "./parse-response.js";
import { parseGeminiStreamEvents } from "./parse-stream.js";
import type { SSEEvent } from "../sse.js";

const GEMINI_BUILTIN_MAP: Record<string, string> = {
  web_search: "googleSearch",
  code_execution: "codeExecution",
};

function builtinToGemini(tool: BuiltinTool): JsonObject {
  return { [GEMINI_BUILTIN_MAP[tool.name] ?? tool.name]: tool.config ?? {} };
}

function containsKey(value: JsonValue, key: string): boolean {
  if (isJsonObject(value)) {
    if (key in value) return true;
    return Object.values(value).some((v) => containsKey(v, key));
  }
  if (Array.isArray(value)) return value.some((v) => containsKey(v, key));
  return false;
}

/** responseSchema rejects JSON-Schema keywords; responseJsonSchema accepts them. */
function geminiSchemaField(schema: JsonObject): "responseSchema" | "responseJsonSchema" {
  return containsKey(schema, "additionalProperties") ? "responseJsonSchema" : "responseSchema";
}

/** Map canonical lm15 response_format to Gemini generationConfig entries. */
function responseFormatToGeminiConfig(formatConfig: JsonObject): JsonObject {
  const generationConfig = formatConfig["generationConfig"];
  if (isJsonObject(generationConfig)) return { ...generationConfig };

  const out: JsonObject = {};
  const mimeType = formatConfig["responseMimeType"] ?? formatConfig["response_mime_type"];
  const schemaIn = formatConfig["responseSchema"] ?? formatConfig["response_schema"];
  const jsonSchemaIn = formatConfig["responseJsonSchema"] ?? formatConfig["response_json_schema"];

  if (mimeType !== undefined && mimeType !== null) out["responseMimeType"] = String(mimeType);
  if (isJsonObject(schemaIn)) out["responseSchema"] = schemaIn;
  if (isJsonObject(jsonSchemaIn)) out["responseJsonSchema"] = jsonSchemaIn;

  const setSchema = (schema: JsonObject): void => {
    const field = geminiSchemaField(schema);
    out[field] = schema;
    delete out[field === "responseJsonSchema" ? "responseSchema" : "responseJsonSchema"];
  };

  const fmtType = formatConfig["type"];
  if (fmtType === "json_object") {
    if (out["responseMimeType"] === undefined) out["responseMimeType"] = "application/json";
    return out;
  }
  if (fmtType === "json_schema") {
    const schema = formatConfig["schema"];
    if (isJsonObject(schema)) setSchema(schema);
    if (out["responseMimeType"] === undefined) out["responseMimeType"] = "application/json";
    return out;
  }
  const schema = formatConfig["schema"];
  if (isJsonObject(schema)) {
    setSchema(schema);
    if (out["responseMimeType"] === undefined) out["responseMimeType"] = "application/json";
    return out;
  }
  if ("type" in formatConfig || "properties" in formatConfig || "items" in formatConfig) {
    setSchema({ ...formatConfig });
    if (out["responseMimeType"] === undefined) out["responseMimeType"] = "application/json";
  }
  return Object.keys(out).length > 0 ? out : { ...formatConfig };
}

function geminiPart(part: Part): JsonObject {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary": {
      const mime = part.media_type || "application/octet-stream";
      if (part.url !== null) return { fileData: { mimeType: mime, fileUri: part.url } };
      if (part.file_id !== null) return { fileData: { mimeType: mime, fileUri: part.file_id } };
      if (part.data !== null) return { inlineData: { mimeType: mime, data: part.data } };
      return { text: "" };
    }
    case "tool_call": {
      const functionCall: JsonObject = { name: part.name, args: part.input };
      if (part.id !== "") functionCall["id"] = part.id;
      const out: JsonObject = { functionCall };
      const thought = continuationData(part.continuation, "gemini", "thought_signature");
      const value = thought?.["value"];
      if (typeof value === "string" && value !== "") out["thoughtSignature"] = value;
      return out;
    }
    case "tool_result": {
      const fr: JsonObject = {
        name: part.name !== null && part.name !== "" ? part.name : "tool",
        response: { result: partsToText(part.content) },
      };
      if (part.id !== "") fr["id"] = part.id;
      return { functionResponse: fr };
    }
    case "thinking": {
      const out: JsonObject = { text: part.text };
      const thought = continuationData(part.continuation, "gemini", "thought_signature");
      const value = thought?.["value"];
      if (typeof value === "string" && value !== "") {
        out["thought"] = true;
        out["thoughtSignature"] = value;
      }
      return out;
    }
    default: {
      const text = "text" in part && typeof part.text === "string" ? part.text : "";
      return { text };
    }
  }
}

function geminiMessage(msg: Message): JsonObject {
  if (msg.role === "developer") {
    return { role: "user", parts: [{ text: `[developer]\n${partsToText(msg.parts)}` }] };
  }
  const role = msg.role === "assistant" ? "model" : "user";
  return { role, parts: msg.parts.map(geminiPart) };
}

const TOOL_CONFIG_MODES: Record<string, string> = {
  none: "NONE",
  required: "ANY",
  auto: "AUTO",
};

export class GeminiAdapter implements ProviderAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  private modelPath(model: string): string {
    return model.startsWith("models/") ? model : `models/${model}`;
  }

  private payload(request: Request): JsonObject {
    const cfg = request.config;
    const extensions = cfg.extensions ?? {};

    const payload: JsonObject = { contents: request.messages.map(geminiMessage) };
    if (request.system !== null) {
      payload["systemInstruction"] = { parts: [{ text: systemText(request.system) }] };
    }

    const generationConfig: JsonObject = {};
    if (cfg.temperature !== null) generationConfig["temperature"] = geminiNumber(cfg.temperature);
    if (cfg.max_tokens !== null) generationConfig["maxOutputTokens"] = cfg.max_tokens;
    if (cfg.top_p !== null) generationConfig["topP"] = geminiNumber(cfg.top_p);
    if (cfg.top_k !== null) generationConfig["topK"] = cfg.top_k;
    if (cfg.stop.length > 0) generationConfig["stopSequences"] = [...cfg.stop];
    if (cfg.response_format !== null) {
      Object.assign(generationConfig, responseFormatToGeminiConfig(cfg.response_format));
    }
    if (cfg.reasoning !== null) {
      if (cfg.reasoning.effort === "off") {
        generationConfig["thinkingConfig"] = { thinkingBudget: 0 };
      } else {
        const thinking: JsonObject = { includeThoughts: true };
        if (cfg.reasoning.thinking_budget !== null) {
          thinking["thinkingBudget"] = cfg.reasoning.thinking_budget;
        }
        generationConfig["thinkingConfig"] = thinking;
      }
    }
    if (Object.keys(generationConfig).length > 0) payload["generationConfig"] = generationConfig;

    if (request.tools.length > 0) {
      const functionDeclarations = request.tools
        .filter((t) => t.type === "function")
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
      const toolsWire: JsonValue[] = [];
      if (functionDeclarations.length > 0) toolsWire.push({ functionDeclarations });
      for (const tool of request.tools) {
        if (tool.type === "builtin") toolsWire.push(builtinToGemini(tool));
      }
      payload["tools"] = toolsWire;
    }

    const tc = cfg.tool_choice;
    if (tc !== null) {
      const fcc: JsonObject = { mode: TOOL_CONFIG_MODES[tc.mode]! };
      if (tc.allowed.length > 0) fcc["allowedFunctionNames"] = [...tc.allowed];
      payload["toolConfig"] = { functionCallingConfig: fcc };
    }

    const output = extensions["output"];
    if (output === "image" || output === "audio") {
      const gc = isJsonObject(payload["generationConfig"])
        ? (payload["generationConfig"] as JsonObject)
        : {};
      gc["responseModalities"] = [output === "image" ? "IMAGE" : "AUDIO"];
      payload["generationConfig"] = gc;
    }

    for (const [key, value] of Object.entries(extensions)) {
      if (key !== "prompt_caching" && key !== "output") payload[key] = value;
    }
    return payload;
  }

  buildRequest(request: Request, stream: boolean): WireRequest {
    const endpoint = stream ? "streamGenerateContent" : "generateContent";
    return {
      method: "POST",
      url: `${trimTrailingSlash(this.baseUrl)}/${this.modelPath(request.model)}:${endpoint}`,
      params: stream ? { alt: "sse" } : {},
      headers: {
        "x-goog-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: this.payload(request),
    };
  }
  parseResponse(request: Request, _status: number, body: JsonValue): Response {
    return parseGeminiResponse(request, body);
  }

  parseStreamEvents(request: Request, raw: SSEEvent): StreamEvent[] {
    return parseGeminiStreamEvents(request, raw);
  }
}
