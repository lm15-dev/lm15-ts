/**
 * lm15 canonical serde — THE one serializer module.
 *
 * One function pair per type: xxxToDict / xxxFromDict, mirroring the
 * normative rules in lm15-python2/docs/serde-rules.md:
 *
 * - One omission rule: each typed serializer drops its OWN empty optional
 *   fields (null/""/[]/{}), at the top level of its own object only.
 * - Opaque payloads round-trip verbatim, never cleaned.
 * - Number rule: declared-float fields always emit as JSON floats (CFloat);
 *   declared-int fields always emit as JSON ints.
 * - from_dict delegates validation to the constructors (INV-046) and
 *   restores defaults for omitted optional fields (INV-045).
 *
 * All functions operate on JsonValue trees produced by parseCanonicalJson,
 * in which JSON floats are CFloat-wrapped; stringifyCanonicalJson is the
 * only emitter.
 */

import {
  CFloat,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { TypeErrorEx, ValueError } from "./errors.js";
import * as t from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function isEmpty(v: JsonValue | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isJsonObject(v)) return Object.keys(v).length === 0;
  return false;
}

type Mapping = Record<string, JsonValue | null | undefined>;

/** The omission rule: drop this object's own empty optional fields. */
function cleanMapping(values: Mapping): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || isEmpty(value)) continue;
    out[key] = value;
  }
  return out;
}

function expectObject(name: string, v: JsonValue | undefined): JsonObject {
  if (!isJsonObject(v as JsonValue)) {
    throw new TypeErrorEx(`${name} must be a JSON object`);
  }
  return v as JsonObject;
}

function expectArray(name: string, v: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(v)) throw new TypeErrorEx(`${name} must be an array`);
  return v;
}

/** Number rule: wrap a declared-float field for emission. */
function floatOrNull(v: number | null): CFloat | null {
  return v === null ? null : new CFloat(v);
}

function scalarToString(v: JsonValue): string {
  if (v instanceof CFloat) {
    const s = String(v.value);
    return /^-?\d+$/.test(s) ? `${s}.0` : s;
  }
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

// ─── ContinuationState ───────────────────────────────────────────────

export function continuationToDict(state: t.ContinuationState): JsonObject {
  return { provider: state.provider, kind: state.kind, data: state.data };
}

export function continuationFromDict(d: JsonValue): t.ContinuationState {
  const obj = expectObject("continuation state", d);
  return t.continuationState({ provider: obj["provider"], kind: obj["kind"], data: obj["data"] ?? {} });
}

function continuationToJson(states: readonly t.ContinuationState[]): JsonValue[] | null {
  if (states.length === 0) return null;
  return states.map(continuationToDict);
}

function continuationFromJson(v: JsonValue | undefined): t.ContinuationState[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new TypeErrorEx("continuation must be a list");
  return v.map((item) => {
    if (!isJsonObject(item)) throw new TypeErrorEx("continuation entries must be objects");
    return continuationFromDict(item);
  });
}

// ─── Parts ───────────────────────────────────────────────────────────

export function partToDict(part: t.Part): JsonObject {
  const d: JsonObject = { type: part.type };

  switch (part.type) {
    case "text":
      d["text"] = part.text;
      break;
    case "thinking":
      d["text"] = part.text;
      if (part.redacted) d["redacted"] = part.redacted;
      break;
    case "refusal":
      d["text"] = part.text;
      break;
    case "citation":
      if (part.text !== null) d["text"] = part.text;
      if (part.url !== null) d["url"] = part.url;
      if (part.title !== null) d["title"] = part.title;
      break;
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary":
      d["media_type"] = part.media_type;
      if (part.data !== null) d["data"] = part.data;
      if (part.url !== null) d["url"] = part.url;
      if (part.file_id !== null) d["file_id"] = part.file_id;
      if (part.path !== null) d["path"] = part.path;
      if (part.type === "image" && part.detail !== null) d["detail"] = part.detail;
      break;
    case "tool_call":
      d["id"] = part.id;
      d["name"] = part.name;
      d["input"] = part.input; // consistent: "input" everywhere
      break;
    case "tool_result":
      d["id"] = part.id;
      if (part.name !== null) d["name"] = part.name;
      d["content"] = part.content.map(partToDict);
      if (part.is_error) d["is_error"] = part.is_error;
      break;
    default: {
      const exhaustive: never = part;
      throw new TypeErrorEx(`unsupported part type: ${JSON.stringify(exhaustive)}`);
    }
  }

  const continuation = continuationToJson(part.continuation);
  if (continuation !== null) d["continuation"] = continuation;
  return d;
}

export function partFromDict(d: JsonValue): t.Part {
  const obj = expectObject("part", d);
  const type = obj["type"];
  const continuation = continuationFromJson(obj["continuation"]);

  switch (type) {
    case "text":
      return t.textPart({ text: obj["text"] ?? "", continuation }); // INV-040
    case "thinking":
      return t.thinkingPart({
        text: obj["text"] ?? "",
        redacted: obj["redacted"] ?? false,
        continuation,
      });
    case "refusal":
      return t.refusalPart({ text: obj["text"] ?? "", continuation });
    case "citation":
      return t.citationPart({
        text: obj["text"],
        url: obj["url"],
        title: obj["title"],
        continuation,
      });
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary":
      return t.mediaPart(type, {
        media_type: obj["media_type"] ?? "",
        data: obj["data"],
        url: obj["url"],
        file_id: obj["file_id"],
        path: obj["path"],
        detail: type === "image" ? obj["detail"] : undefined,
        continuation,
      });
    case "tool_call":
      return t.toolCallPart({
        id: obj["id"],
        name: obj["name"],
        input: obj["input"] ?? {}, // INV-045
        continuation,
      });
    case "tool_result": {
      // INV-041: lenient content reading.
      const raw = obj["content"] ?? [];
      let content: t.Part[];
      if (typeof raw === "string") {
        content = raw === "" ? [] : [t.textPart({ text: raw })];
      } else if (Array.isArray(raw)) {
        content = raw.map((c) =>
          isJsonObject(c) ? partFromDict(c) : t.textPart({ text: scalarToString(c) }),
        );
      } else {
        content = [];
      }
      return t.toolResultPart({
        id: obj["id"],
        content,
        name: obj["name"],
        is_error: obj["is_error"] ?? false,
        continuation,
      });
    }
    default:
      throw new ValueError(`unsupported part type: ${String(type)}`); // INV-044
  }
}

// ─── Messages ────────────────────────────────────────────────────────

export function messageToDict(msg: t.Message): JsonObject {
  const out: JsonObject = { role: msg.role, parts: msg.parts.map(partToDict) };
  const continuation = continuationToJson(msg.continuation);
  if (continuation !== null) out["continuation"] = continuation;
  return out;
}

export function messageFromDict(d: JsonValue): t.Message {
  const obj = expectObject("message", d);
  const role = obj["role"];
  const partsRaw = obj["parts"] ?? [];
  const parts = (Array.isArray(partsRaw) ? partsRaw : []).map((p) =>
    isJsonObject(p) ? partFromDict(p) : t.textPart({ text: scalarToString(p) }),
  ); // INV-047
  if (parts.length === 0) {
    throw new ValueError(`message for role '${String(role)}' has no parts`);
  }
  return t.message({ role, parts, continuation: continuationFromJson(obj["continuation"]) });
}

// ─── Tools ───────────────────────────────────────────────────────────

export function toolToDict(tool: t.Tool): JsonObject {
  switch (tool.type) {
    case "function": {
      const out = cleanMapping({
        type: "function",
        name: tool.name,
        description: tool.description,
      });
      // parameters is required-with-shape (INV-033): always emitted, even as
      // the opaque literal {} — never subject to the omission rule.
      out["parameters"] = tool.parameters;
      return out;
    }
    case "builtin":
      return cleanMapping({ type: "builtin", name: tool.name, config: tool.config });
    default: {
      const exhaustive: never = tool;
      throw new TypeErrorEx(`unsupported tool type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function toolFromDict(d: JsonValue): t.Tool {
  const obj = expectObject("tool", d);
  if (obj["type"] === "builtin") {
    return t.builtinTool({ name: obj["name"], config: obj["config"] });
  }
  // INV-034: any other or missing type reads as FunctionTool.
  return t.functionTool({
    name: obj["name"],
    description: obj["description"],
    parameters: obj["parameters"] ?? t.DEFAULT_FUNCTION_PARAMETERS,
  });
}

// ─── Config family ───────────────────────────────────────────────────

export function toolChoiceToDict(tc: t.ToolChoice): JsonObject {
  return cleanMapping({ mode: tc.mode, allowed: [...tc.allowed], parallel: tc.parallel });
}

export function toolChoiceFromDict(d: JsonValue): t.ToolChoice {
  const obj = expectObject("tool_choice", d);
  return t.toolChoice({
    mode: obj["mode"] ?? "auto", // INV-045
    allowed: obj["allowed"] ?? [],
    parallel: obj["parallel"],
  });
}

export function reasoningToDict(r: t.Reasoning): JsonObject {
  return cleanMapping({
    effort: r.effort,
    thinking_budget: r.thinking_budget,
    total_budget: r.total_budget,
    summary: r.summary,
  });
}

export function reasoningFromDict(d: JsonValue): t.Reasoning {
  const obj = expectObject("reasoning", d);
  // INV-043: legacy keys.
  const defaultEffort = obj["enabled"] === false ? "off" : "medium";
  const effort = obj["effort"] ?? defaultEffort;
  if (effort === "off") return t.reasoning({ effort: "off" });
  return t.reasoning({
    effort,
    thinking_budget: obj["thinking_budget"] ?? obj["budget"],
    total_budget: obj["total_budget"],
    summary: obj["summary"],
  });
}

export function cacheConfigToDict(c: t.CacheConfig): JsonObject {
  return cleanMapping({
    mode: c.mode,
    retention: c.retention,
    key: c.key,
    prefix_until_index: c.prefix_until_index,
  });
}

export function cacheConfigFromDict(d: JsonValue): t.CacheConfig {
  const obj = expectObject("cache_config", d);
  return t.cacheConfig({
    mode: obj["mode"] ?? "auto",
    retention: obj["retention"],
    key: obj["key"],
    prefix_until_index: obj["prefix_until_index"],
  });
}

export function configToDict(c: t.Config): JsonObject {
  return cleanMapping({
    max_tokens: c.max_tokens,
    temperature: floatOrNull(c.temperature),
    top_p: floatOrNull(c.top_p),
    top_k: c.top_k,
    stop: [...c.stop],
    response_format: c.response_format,
    tool_choice: c.tool_choice ? toolChoiceToDict(c.tool_choice) : null,
    reasoning: c.reasoning ? reasoningToDict(c.reasoning) : null,
    cache: c.cache ? cacheConfigToDict(c.cache) : null,
    extensions: c.extensions,
  });
}

/** INV-042: a present non-object config nest is malformed — TypeError. */
function configNest(d: JsonObject, key: string): JsonObject | null {
  const value = d[key];
  if (value === null || value === undefined) return null;
  if (!isJsonObject(value)) {
    throw new TypeErrorEx(`config.${key} must be a JSON object`);
  }
  return value;
}

export function configFromDict(d: JsonValue): t.Config {
  const obj = expectObject("config", d);
  const toolChoiceNest = configNest(obj, "tool_choice");
  const reasoningNest = configNest(obj, "reasoning");
  const cacheNest = configNest(obj, "cache");
  return t.config({
    max_tokens: obj["max_tokens"],
    temperature: obj["temperature"],
    top_p: obj["top_p"],
    top_k: obj["top_k"],
    stop: obj["stop"] ?? [],
    response_format: obj["response_format"],
    tool_choice: toolChoiceNest !== null ? toolChoiceFromDict(toolChoiceNest) : null,
    reasoning: reasoningNest !== null ? reasoningFromDict(reasoningNest) : null,
    cache: cacheNest !== null ? cacheConfigFromDict(cacheNest) : null,
    extensions: obj["extensions"],
  });
}

// ─── ErrorDetail ─────────────────────────────────────────────────────

export function errorDetailToDict(e: t.ErrorDetail): JsonObject {
  return cleanMapping({ code: e.code, message: e.message, provider_code: e.provider_code });
}

export function errorDetailFromDict(d: JsonValue): t.ErrorDetail {
  const obj = expectObject("error_detail", d);
  return t.errorDetail({
    code: obj["code"],
    message: obj["message"] ?? "",
    provider_code: obj["provider_code"],
  });
}

// ─── Delta ───────────────────────────────────────────────────────────

export function deltaToDict(delta: t.Delta): JsonObject {
  // delta_to_dict drops only null fields — empty strings ARE emitted, and
  // part_index is always emitted (ContinuationDelta's may be null → omitted).
  const out: Record<string, JsonValue | null> = {
    type: delta.type,
    part_index: delta.part_index,
  };

  switch (delta.type) {
    case "text":
    case "thinking":
      out["text"] = delta.text;
      break;
    case "audio":
    case "image":
      out["data"] = delta.data;
      out["url"] = delta.url;
      out["file_id"] = delta.file_id;
      out["media_type"] = delta.media_type;
      break;
    case "tool_call":
      out["input"] = delta.input;
      out["id"] = delta.id;
      out["name"] = delta.name;
      break;
    case "citation":
      out["text"] = delta.text;
      out["url"] = delta.url;
      out["title"] = delta.title;
      break;
    case "continuation":
      out["provider"] = delta.provider;
      out["kind"] = delta.kind;
      out["data"] = delta.data;
      out["part_index"] = delta.part_index;
      break;
    default: {
      const exhaustive: never = delta;
      throw new TypeErrorEx(`unsupported delta type: ${JSON.stringify(exhaustive)}`);
    }
  }

  const result: JsonObject = {};
  for (const [key, value] of Object.entries(out)) {
    if (value !== null) result[key] = value;
  }
  return result;
}

export function deltaFromDict(d: JsonValue): t.Delta {
  const obj = expectObject("delta", d);
  const type = obj["type"];
  const part_index = obj["part_index"] ?? 0;

  switch (type) {
    case "text":
      return t.textDelta({ text: obj["text"] ?? "", part_index });
    case "thinking":
      return t.thinkingDelta({ text: obj["text"] ?? "", part_index });
    case "audio":
      return t.audioDelta({
        data: obj["data"],
        url: obj["url"],
        file_id: obj["file_id"],
        part_index,
        media_type: obj["media_type"],
      });
    case "image":
      return t.imageDelta({
        data: obj["data"],
        url: obj["url"],
        file_id: obj["file_id"],
        part_index,
        media_type: obj["media_type"],
      });
    case "tool_call":
      return t.toolCallDelta({
        input: obj["input"] ?? "",
        part_index,
        id: obj["id"],
        name: obj["name"],
      });
    case "citation":
      return t.citationDelta({
        text: obj["text"],
        url: obj["url"],
        title: obj["title"],
        part_index,
      });
    case "continuation":
      return t.continuationDelta({
        provider: obj["provider"],
        kind: obj["kind"],
        data: obj["data"] ?? {},
        part_index: obj["part_index"],
      });
    default:
      throw new ValueError(`unsupported delta type: ${String(type)}`); // INV-044
  }
}

// ─── Usage ───────────────────────────────────────────────────────────

export function usageToDict(u: t.Usage): JsonObject {
  return cleanMapping({
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
    cache_read_tokens: u.cache_read_tokens,
    cache_write_tokens: u.cache_write_tokens,
    reasoning_tokens: u.reasoning_tokens,
    input_audio_tokens: u.input_audio_tokens,
    output_audio_tokens: u.output_audio_tokens,
  });
}

export function usageFromDict(d: JsonValue): t.Usage {
  const obj = expectObject("usage", d);
  return t.usage({
    input_tokens: obj["input_tokens"],
    output_tokens: obj["output_tokens"],
    total_tokens: obj["total_tokens"],
    cache_read_tokens: obj["cache_read_tokens"],
    cache_write_tokens: obj["cache_write_tokens"],
    reasoning_tokens: obj["reasoning_tokens"],
    input_audio_tokens: obj["input_audio_tokens"],
    output_audio_tokens: obj["output_audio_tokens"],
  });
}

// ─── StreamEvent ─────────────────────────────────────────────────────

export function streamEventToDict(e: t.StreamEvent): JsonObject {
  switch (e.type) {
    case "start":
      return cleanMapping({ type: e.type, id: e.id, model: e.model });
    case "delta":
      return { type: e.type, delta: deltaToDict(e.delta) };
    case "end":
      return cleanMapping({
        type: e.type,
        finish_reason: e.finish_reason,
        usage: e.usage ? usageToDict(e.usage) : null,
        provider_data: e.provider_data,
      });
    case "error":
      return { type: e.type, error: errorDetailToDict(e.error) };
    default: {
      const exhaustive: never = e;
      throw new TypeErrorEx(`unsupported stream event type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function streamEventFromDict(d: JsonValue): t.StreamEvent {
  const obj = expectObject("stream_event", d);
  const type = obj["type"];
  switch (type) {
    case "start":
      return t.streamStartEvent({ id: obj["id"], model: obj["model"] });
    case "delta":
      return t.streamDeltaEvent(deltaFromDict(obj["delta"] as JsonValue));
    case "end":
      return t.streamEndEvent({
        finish_reason: obj["finish_reason"],
        usage: isJsonObject(obj["usage"]) ? usageFromDict(obj["usage"]) : null,
        provider_data: obj["provider_data"],
      });
    case "error":
      return t.streamErrorEvent(errorDetailFromDict(obj["error"] as JsonValue));
    default:
      throw new ValueError(`unsupported stream event type: ${String(type)}`);
  }
}

// ─── Request / Response ──────────────────────────────────────────────

export function requestToDict(r: t.Request): JsonObject {
  const system: JsonValue =
    typeof r.system === "string" || r.system === null
      ? r.system
      : r.system.map(partToDict);
  return cleanMapping({
    model: r.model,
    messages: r.messages.map(messageToDict),
    system,
    tools: r.tools.map(toolToDict),
    config: configToDict(r.config),
  });
}

export function requestFromDict(d: JsonValue): t.Request {
  const obj = expectObject("request", d);
  const rawSystem = obj["system"];
  let system: string | t.Part[] | null;
  if (Array.isArray(rawSystem)) system = rawSystem.map(partFromDict);
  else if (typeof rawSystem === "string") system = rawSystem;
  else system = null;
  return t.request({
    model: obj["model"],
    messages: expectArray("request.messages", obj["messages"]).map(messageFromDict),
    system,
    tools: (obj["tools"] === undefined ? [] : expectArray("request.tools", obj["tools"])).map(toolFromDict),
    config: configFromDict(obj["config"] ?? {}),
  });
}

export function responseToDict(
  r: t.Response,
  options: { includeProviderData?: boolean } = {},
): JsonObject {
  const out: Mapping = {
    id: r.id,
    model: r.model,
    message: messageToDict(r.message),
    finish_reason: r.finish_reason,
    usage: usageToDict(r.usage),
  };
  if (options.includeProviderData && r.provider_data !== null) {
    out["provider_data"] = r.provider_data;
  }
  return cleanMapping(out);
}

export function responseFromDict(d: JsonValue): t.Response {
  const obj = expectObject("response", d);
  return t.response({
    id: obj["id"],
    model: obj["model"],
    message: messageFromDict(obj["message"] as JsonValue),
    finish_reason: obj["finish_reason"],
    usage: usageFromDict(obj["usage"] ?? {}),
    provider_data: obj["provider_data"],
  });
}

// ─── ModelInfo ───────────────────────────────────────────────────────

function inferencePricingToDict(p: t.InferencePricing): JsonObject {
  return cleanMapping({
    input_per_million: floatOrNull(p.input_per_million),
    output_per_million: floatOrNull(p.output_per_million),
    cache_read_per_million: floatOrNull(p.cache_read_per_million),
    cache_write_per_million: floatOrNull(p.cache_write_per_million),
    currency: p.currency,
    dimensions: p.dimensions,
  });
}

function inferencePricingFromDict(d: JsonObject): t.InferencePricing {
  return t.inferencePricing({
    input_per_million: d["input_per_million"],
    output_per_million: d["output_per_million"],
    cache_read_per_million: d["cache_read_per_million"],
    cache_write_per_million: d["cache_write_per_million"],
    currency: d["currency"] ?? "USD",
    dimensions: d["dimensions"],
  });
}

function trainingPricingToDict(p: t.TrainingPricing): JsonObject {
  return cleanMapping({
    training_tokens_per_million: floatOrNull(p.training_tokens_per_million),
    gpu_second: floatOrNull(p.gpu_second),
    currency: p.currency,
    dimensions: p.dimensions,
  });
}

function trainingPricingFromDict(d: JsonObject): t.TrainingPricing {
  return t.trainingPricing({
    training_tokens_per_million: d["training_tokens_per_million"],
    gpu_second: d["gpu_second"],
    currency: d["currency"] ?? "USD",
    dimensions: d["dimensions"],
  });
}

function inferenceModelInfoToDict(i: t.InferenceModelInfo): JsonObject {
  return cleanMapping({
    input_modalities: [...i.input_modalities],
    output_modalities: [...i.output_modalities],
    context_window: i.context_window,
    max_output_tokens: i.max_output_tokens,
    supports_reasoning: i.supports_reasoning || null,
    reasoning_efforts: [...i.reasoning_efforts],
    pricing: i.pricing ? inferencePricingToDict(i.pricing) : null,
    extensions: i.extensions,
  });
}

function inferenceModelInfoFromDict(d: JsonObject): t.InferenceModelInfo {
  return t.inferenceModelInfo({
    input_modalities: d["input_modalities"] ?? ["text"],
    output_modalities: d["output_modalities"] ?? ["text"],
    context_window: d["context_window"],
    max_output_tokens: d["max_output_tokens"],
    supports_reasoning: d["supports_reasoning"] ?? false,
    reasoning_efforts: d["reasoning_efforts"] ?? [],
    pricing: isJsonObject(d["pricing"]) ? inferencePricingFromDict(d["pricing"]) : null,
    extensions: d["extensions"],
  });
}

function trainingModelInfoToDict(tr: t.TrainingModelInfo): JsonObject {
  return cleanMapping({
    supports_lora: tr.supports_lora || null,
    supports_full_finetune: tr.supports_full_finetune || null,
    trainable_modalities: [...tr.trainable_modalities],
    pricing: tr.pricing ? trainingPricingToDict(tr.pricing) : null,
    extensions: tr.extensions,
  });
}

function trainingModelInfoFromDict(d: JsonObject): t.TrainingModelInfo {
  return t.trainingModelInfo({
    supports_lora: d["supports_lora"] ?? false,
    supports_full_finetune: d["supports_full_finetune"] ?? false,
    trainable_modalities: d["trainable_modalities"] ?? [],
    pricing: isJsonObject(d["pricing"]) ? trainingPricingFromDict(d["pricing"]) : null,
    extensions: d["extensions"],
  });
}

function modelOriginToDict(o: t.ModelOrigin): JsonObject {
  return cleanMapping({
    type: o.type,
    id: o.id,
    base_model: o.base_model,
    provider_data: o.provider_data,
  });
}

function modelOriginFromDict(d: JsonObject): t.ModelOrigin {
  return t.modelOrigin({
    type: d["type"] ?? "provider",
    id: d["id"],
    base_model: d["base_model"],
    provider_data: d["provider_data"],
  });
}

export function modelInfoToDict(m: t.ModelInfo): JsonObject {
  let origin = modelOriginToDict(m.origin);
  // The default origin carries no information.
  if (Object.keys(origin).length === 1 && origin["type"] === "provider") origin = {};
  return cleanMapping({
    id: m.id,
    provider: m.provider,
    api_family: m.api_family,
    aliases: [...m.aliases],
    origin,
    inference: m.inference ? inferenceModelInfoToDict(m.inference) : null,
    training: m.training ? trainingModelInfoToDict(m.training) : null,
    extensions: m.extensions,
  });
}

export function modelInfoFromDict(d: JsonValue): t.ModelInfo {
  const obj = expectObject("model_info", d);
  return t.modelInfo({
    id: obj["id"],
    provider: obj["provider"],
    api_family: obj["api_family"],
    aliases: obj["aliases"] ?? [],
    origin: isJsonObject(obj["origin"]) ? modelOriginFromDict(obj["origin"]) : t.DEFAULT_MODEL_ORIGIN,
    inference: isJsonObject(obj["inference"]) ? inferenceModelInfoFromDict(obj["inference"]) : null,
    training: isJsonObject(obj["training"]) ? trainingModelInfoFromDict(obj["training"]) : null,
    extensions: obj["extensions"],
  });
}

// ─── AudioFormat / LiveConfig ────────────────────────────────────────

export function audioFormatToDict(af: t.AudioFormat): JsonObject {
  return cleanMapping({
    encoding: af.encoding,
    sample_rate: af.sample_rate,
    channels: af.channels,
  });
}

export function audioFormatFromDict(d: JsonValue): t.AudioFormat {
  const obj = expectObject("audio_format", d);
  return t.audioFormat({
    encoding: obj["encoding"],
    sample_rate: obj["sample_rate"],
    channels: obj["channels"] ?? 1, // INV-045
  });
}

export function liveConfigToDict(lc: t.LiveConfig): JsonObject {
  const system: JsonValue =
    typeof lc.system === "string" || lc.system === null
      ? lc.system
      : lc.system.map(partToDict);
  return cleanMapping({
    model: lc.model,
    system,
    tools: lc.tools.map(toolToDict),
    voice: lc.voice,
    input_format: lc.input_format ? audioFormatToDict(lc.input_format) : null,
    output_format: lc.output_format ? audioFormatToDict(lc.output_format) : null,
    extensions: lc.extensions,
  });
}

export function liveConfigFromDict(d: JsonValue): t.LiveConfig {
  const obj = expectObject("live_config", d);
  const rawSystem = obj["system"];
  let system: string | t.Part[] | null;
  if (Array.isArray(rawSystem)) system = rawSystem.map(partFromDict);
  else if (typeof rawSystem === "string") system = rawSystem;
  else system = null;
  return t.liveConfig({
    model: obj["model"],
    system,
    tools: (obj["tools"] === undefined ? [] : expectArray("live_config.tools", obj["tools"])).map(toolFromDict),
    voice: obj["voice"],
    input_format: isJsonObject(obj["input_format"]) ? audioFormatFromDict(obj["input_format"]) : null,
    output_format: isJsonObject(obj["output_format"]) ? audioFormatFromDict(obj["output_format"]) : null,
    extensions: obj["extensions"],
  });
}

// ─── Live events ─────────────────────────────────────────────────────

export function liveClientEventToDict(e: t.LiveClientEvent): JsonObject {
  switch (e.type) {
    case "turn":
      // Serialized without cleaning: ALL fields verbatim, incl. false.
      return { type: e.type, parts: e.parts.map(partToDict), turn_complete: e.turn_complete };
    case "audio":
    case "image":
      return { type: e.type, data: e.data, media_type: e.media_type };
    case "text":
      return { type: e.type, text: e.text };
    case "tool_result":
      return { type: e.type, id: e.id, content: e.content.map(partToDict) };
    case "interrupt":
    case "end_audio":
      return { type: e.type };
    default: {
      const exhaustive: never = e;
      throw new TypeErrorEx(`unsupported live client event type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function liveClientEventFromDict(d: JsonValue): t.LiveClientEvent {
  const obj = expectObject("live_client_event", d);
  const type = obj["type"];
  switch (type) {
    case "turn":
      return t.liveClientTurnEvent({
        parts: (obj["parts"] === undefined ? [] : expectArray("turn.parts", obj["parts"])).map(partFromDict),
        turn_complete: obj["turn_complete"] ?? true, // INV-045
      });
    case "audio":
      return t.liveClientAudioEvent({ data: obj["data"], media_type: obj["media_type"] });
    case "image":
      return t.liveClientImageEvent({ data: obj["data"], media_type: obj["media_type"] });
    case "text":
      return t.liveClientTextEvent({ text: obj["text"] ?? "" });
    case "tool_result":
      return t.liveClientToolResultEvent({
        id: obj["id"],
        content: (obj["content"] === undefined ? [] : expectArray("tool_result.content", obj["content"])).map(partFromDict),
      });
    case "interrupt":
      return t.liveClientInterruptEvent;
    case "end_audio":
      return t.liveClientEndAudioEvent;
    default:
      throw new ValueError(`unsupported live client event type: ${String(type)}`);
  }
}

export function liveServerEventToDict(e: t.LiveServerEvent): JsonObject {
  switch (e.type) {
    case "audio":
      return cleanMapping({ type: e.type, data: e.data, media_type: e.media_type });
    case "text":
      return { type: e.type, text: e.text };
    case "tool_call":
      return { type: e.type, id: e.id, name: e.name, input: e.input };
    case "tool_call_delta":
      return cleanMapping({ type: e.type, id: e.id, name: e.name, input_delta: e.input_delta });
    case "interrupted":
      return { type: e.type };
    case "turn_end":
      return cleanMapping({ type: e.type, usage: usageToDict(e.usage) });
    case "error":
      return { type: e.type, error: errorDetailToDict(e.error) };
    default: {
      const exhaustive: never = e;
      throw new TypeErrorEx(`unsupported live server event type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function liveServerEventFromDict(d: JsonValue): t.LiveServerEvent {
  const obj = expectObject("live_server_event", d);
  const type = obj["type"];
  switch (type) {
    case "audio":
      return t.liveServerAudioEvent({ data: obj["data"], media_type: obj["media_type"] });
    case "text":
      return t.liveServerTextEvent({ text: obj["text"] ?? "" });
    case "tool_call":
      return t.liveServerToolCallEvent({
        id: obj["id"],
        name: obj["name"],
        input: obj["input"] ?? {},
      });
    case "tool_call_delta":
      return t.liveServerToolCallDeltaEvent({
        input_delta: obj["input_delta"] ?? "",
        id: obj["id"],
        name: obj["name"],
      });
    case "interrupted":
      return t.liveServerInterruptedEvent;
    case "turn_end":
      return t.liveServerTurnEndEvent(usageFromDict(obj["usage"] ?? {}));
    case "error":
      return t.liveServerErrorEvent(errorDetailFromDict(obj["error"] as JsonValue));
    default:
      throw new ValueError(`unsupported live server event type: ${String(type)}`);
  }
}

// ─── Serde kind table (harness/PROTOCOL.md "Serde kinds") ────────────

export type SerdePair = {
  fromDict: (d: JsonValue) => unknown;
  toDict: (obj: never) => JsonObject;
};

export const KIND_SERDE: Record<string, [(d: JsonValue) => unknown, (obj: unknown) => JsonObject]> = {
  part: [partFromDict, partToDict as (obj: unknown) => JsonObject],
  message: [messageFromDict, messageToDict as (obj: unknown) => JsonObject],
  tool: [toolFromDict, toolToDict as (obj: unknown) => JsonObject],
  tool_choice: [toolChoiceFromDict, toolChoiceToDict as (obj: unknown) => JsonObject],
  reasoning: [reasoningFromDict, reasoningToDict as (obj: unknown) => JsonObject],
  config: [configFromDict, configToDict as (obj: unknown) => JsonObject],
  cache_config: [cacheConfigFromDict, cacheConfigToDict as (obj: unknown) => JsonObject],
  continuation_state: [continuationFromDict, continuationToDict as (obj: unknown) => JsonObject],
  error_detail: [errorDetailFromDict, errorDetailToDict as (obj: unknown) => JsonObject],
  delta: [deltaFromDict, deltaToDict as (obj: unknown) => JsonObject],
  usage: [usageFromDict, usageToDict as (obj: unknown) => JsonObject],
  stream_event: [streamEventFromDict, streamEventToDict as (obj: unknown) => JsonObject],
  request: [requestFromDict, requestToDict as (obj: unknown) => JsonObject],
  response: [responseFromDict, responseToDict as (obj: unknown) => JsonObject],
  model_info: [modelInfoFromDict, modelInfoToDict as (obj: unknown) => JsonObject],
  audio_format: [audioFormatFromDict, audioFormatToDict as (obj: unknown) => JsonObject],
  live_config: [liveConfigFromDict, liveConfigToDict as (obj: unknown) => JsonObject],
  live_client_event: [liveClientEventFromDict, liveClientEventToDict as (obj: unknown) => JsonObject],
  live_server_event: [liveServerEventFromDict, liveServerEventToDict as (obj: unknown) => JsonObject],
};

export function serdeForKind(
  kind: string,
): [(d: JsonValue) => unknown, (obj: unknown) => JsonObject] {
  const pair = KIND_SERDE[kind];
  if (pair === undefined) throw new ValueError(`unknown kind: ${kind}`);
  return pair;
}
