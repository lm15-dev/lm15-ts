/**
 * Serialization / deserialization — JSON round-tripping for all lm15 types.
 */

import type {
  AudioFormat, Config, DataSource, ErrorInfo, JsonObject,
  LMRequest, LMResponse, LiveClientEvent, LiveConfig, LiveServerEvent,
  Message, Part, PartDelta, ReasoningConfig, StreamEvent, Tool,
  ToolConfig, Usage,
} from "./types.js";
import { Part as PartFactory, EMPTY_USAGE } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function clean(obj: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    let val = v;
    if (Array.isArray(val)) val = val.filter(x => !isEmpty(x));
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      val = clean(val as Record<string, unknown>);
    }
    if (!isEmpty(val)) out[k] = val;
  }
  return out as JsonObject;
}

// ── To dict ────────────────────────────────────────────────────────

export function dataSourceToDict(ds: DataSource): JsonObject {
  return clean({ type: ds.type, media_type: ds.media_type, data: ds.data, url: ds.url, file_id: ds.file_id, detail: ds.detail });
}

export function partToDict(p: Part): JsonObject {
  const base: Record<string, unknown> = { type: p.type };
  if ("text" in p && p.text != null) base.text = p.text;
  if ("source" in p && p.source) base.source = dataSourceToDict(p.source);
  if ("id" in p && p.id != null) base.id = p.id;
  if ("name" in p && p.name != null) base.name = p.name;
  if ("input" in p && p.input != null) base.input = p.input;
  if ("content" in p && Array.isArray(p.content) && p.content.length) base.content = p.content.map(c => partToDict(c));
  if ("is_error" in p && p.is_error != null) base.is_error = p.is_error;
  if ("redacted" in p && p.redacted != null) base.redacted = p.redacted;
  if ("summary" in p && p.summary != null) base.summary = p.summary;
  if ("url" in p && p.url != null) base.url = p.url;
  if ("title" in p && p.title != null) base.title = p.title;
  if ("metadata" in p && p.metadata != null) base.metadata = p.metadata;
  return clean(base);
}

export function messageToDict(m: Message): JsonObject {
  return clean({ role: m.role, parts: m.parts.map(p => partToDict(p)), name: m.name });
}

export function toolToDict(t: Tool): JsonObject {
  if (t.type === "builtin") {
    return clean({ name: t.name, type: t.type, description: t.description, builtin_config: t.builtin_config });
  }
  return clean({ name: t.name, type: t.type, description: t.description, parameters: t.parameters });
}

export function usageToDict(u: Usage): JsonObject {
  return clean({
    input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens,
    cache_read_tokens: u.cache_read_tokens, cache_write_tokens: u.cache_write_tokens,
    reasoning_tokens: u.reasoning_tokens, input_audio_tokens: u.input_audio_tokens,
    output_audio_tokens: u.output_audio_tokens,
  });
}

export function configToDict(c: Config): JsonObject {
  return clean({
    max_tokens: c.max_tokens, temperature: c.temperature, top_p: c.top_p, top_k: c.top_k,
    stop: c.stop ? [...c.stop] : undefined, response_format: c.response_format,
    tool_config: c.tool_config ? clean({ mode: c.tool_config.mode, allowed: [...c.tool_config.allowed], parallel: c.tool_config.parallel }) : undefined,
    reasoning: c.reasoning ? clean({ enabled: (c.reasoning as ReasoningConfig).enabled, budget: (c.reasoning as ReasoningConfig).budget, effort: (c.reasoning as ReasoningConfig).effort }) : undefined,
    provider: c.provider,
  });
}

export function requestToDict(r: LMRequest): JsonObject {
  const system = typeof r.system === "string" ? r.system
    : Array.isArray(r.system) ? (r.system as Part[]).map(p => partToDict(p))
    : undefined;
  return clean({
    model: r.model,
    messages: r.messages.map(m => messageToDict(m)),
    system,
    tools: r.tools?.map(t => toolToDict(t)),
    config: r.config ? configToDict(r.config) : undefined,
  });
}

export function responseToDict(r: LMResponse, includeProvider = false): JsonObject {
  const out: Record<string, unknown> = {
    id: r.id, model: r.model, message: messageToDict(r.message),
    finish_reason: r.finish_reason, usage: usageToDict(r.usage),
  };
  if (includeProvider) out.provider = r.provider;
  return clean(out);
}

export function errorInfoToDict(e: ErrorInfo): JsonObject {
  return clean({ code: e.code, provider_code: e.provider_code, message: e.message });
}

export function partDeltaToDict(d: PartDelta): JsonObject {
  return clean({ type: d.type, text: d.text, data: d.data, input: d.input });
}

export function streamEventToDict(e: StreamEvent): JsonObject {
  const delta = e.delta
    ? ("type" in e.delta && typeof (e.delta as PartDelta).type === "string"
        ? partDeltaToDict(e.delta as PartDelta)
        : clean(e.delta as Record<string, unknown>))
    : undefined;
  return clean({
    type: e.type, id: e.id, model: e.model, part_index: e.part_index,
    delta, part_type: e.part_type, finish_reason: e.finish_reason,
    usage: e.usage ? usageToDict(e.usage) : undefined,
    error: e.error ? errorInfoToDict(e.error) : undefined,
  });
}

export function liveConfigToDict(c: LiveConfig): JsonObject {
  const system = typeof c.system === "string" ? c.system
    : Array.isArray(c.system) ? (c.system as Part[]).map(p => partToDict(p))
    : undefined;
  return clean({
    model: c.model, system, tools: c.tools?.map(t => toolToDict(t)),
    voice: c.voice,
    input_format: c.input_format ? clean({ encoding: c.input_format.encoding, sample_rate: c.input_format.sample_rate, channels: c.input_format.channels }) : undefined,
    output_format: c.output_format ? clean({ encoding: c.output_format.encoding, sample_rate: c.output_format.sample_rate, channels: c.output_format.channels }) : undefined,
    provider: c.provider,
  });
}

export function liveClientEventToDict(e: LiveClientEvent): JsonObject {
  return clean({
    type: e.type, data: e.data, text: e.text, id: e.id,
    content: e.content?.map(p => partToDict(p)),
  });
}

export function liveServerEventToDict(e: LiveServerEvent): JsonObject {
  return clean({
    type: e.type, data: e.data, text: e.text, id: e.id, name: e.name,
    input: e.input, usage: e.usage ? usageToDict(e.usage) : undefined,
    error: e.error ? errorInfoToDict(e.error) : undefined,
  });
}

// ── From dict ──────────────────────────────────────────────────────

export function dataSourceFromDict(d: JsonObject): DataSource {
  return d as unknown as DataSource;
}

export function partFromDict(d: JsonObject): Part {
  const type = d.type as string;
  const source = d.source ? dataSourceFromDict(d.source as JsonObject) : undefined;
  const content = Array.isArray(d.content) ? d.content.map(c => partFromDict(c as JsonObject)) : undefined;

  switch (type) {
    case "text": return PartFactory.text(d.text as string);
    case "thinking": return PartFactory.thinking(d.text as string, { redacted: d.redacted as boolean | undefined, summary: d.summary as string | undefined, metadata: d.metadata as JsonObject | undefined });
    case "refusal": return PartFactory.refusal(d.text as string);
    case "citation": return PartFactory.citation({ text: d.text as string | undefined, url: d.url as string | undefined, title: d.title as string | undefined });
    case "image": return { type: "image", source: source!, metadata: d.metadata as JsonObject | undefined } as Part;
    case "audio": return { type: "audio", source: source!, metadata: d.metadata as JsonObject | undefined } as Part;
    case "video": return { type: "video", source: source!, metadata: d.metadata as JsonObject | undefined } as Part;
    case "document": return { type: "document", source: source!, metadata: d.metadata as JsonObject | undefined } as Part;
    case "tool_call": return PartFactory.toolCall(d.id as string, d.name as string, d.input as JsonObject);
    case "tool_result": return PartFactory.toolResult(d.id as string, content ?? [], { is_error: d.is_error as boolean | undefined, name: d.name as string | undefined });
    default: throw new Error(`unsupported part type: ${type}`);
  }
}

export function messageFromDict(d: JsonObject): Message {
  return {
    role: d.role as Message["role"],
    parts: (d.parts as JsonObject[]).map(p => partFromDict(p)),
    name: d.name as string | undefined,
  };
}

export function toolFromDict(d: JsonObject): Tool {
  if (d.type === "builtin") {
    return { type: "builtin", name: d.name as string, description: d.description as string | undefined, builtin_config: d.builtin_config as JsonObject | undefined };
  }
  return { type: "function", name: d.name as string, description: d.description as string | undefined, parameters: d.parameters as JsonObject | undefined };
}

export function usageFromDict(d: JsonObject): Usage {
  return {
    input_tokens: (d.input_tokens as number) ?? 0,
    output_tokens: (d.output_tokens as number) ?? 0,
    total_tokens: (d.total_tokens as number) ?? 0,
    cache_read_tokens: d.cache_read_tokens as number | undefined,
    cache_write_tokens: d.cache_write_tokens as number | undefined,
    reasoning_tokens: d.reasoning_tokens as number | undefined,
    input_audio_tokens: d.input_audio_tokens as number | undefined,
    output_audio_tokens: d.output_audio_tokens as number | undefined,
  };
}

export function configFromDict(d: JsonObject): Config {
  return {
    max_tokens: d.max_tokens as number | undefined,
    temperature: d.temperature as number | undefined,
    top_p: d.top_p as number | undefined,
    top_k: d.top_k as number | undefined,
    stop: d.stop ? (d.stop as string[]) : undefined,
    response_format: d.response_format as JsonObject | undefined,
    tool_config: d.tool_config ? { mode: (d.tool_config as JsonObject).mode as ToolConfig["mode"], allowed: ((d.tool_config as JsonObject).allowed as string[]) ?? [], parallel: (d.tool_config as JsonObject).parallel as boolean | undefined } : undefined,
    reasoning: d.reasoning ? { enabled: (d.reasoning as JsonObject).enabled as boolean, budget: (d.reasoning as JsonObject).budget as number | undefined, effort: (d.reasoning as JsonObject).effort as ReasoningConfig["effort"] } : undefined,
    provider: d.provider as JsonObject | undefined,
  };
}

export function requestFromDict(d: JsonObject): LMRequest {
  const rawSystem = d.system;
  const system = Array.isArray(rawSystem) ? (rawSystem as JsonObject[]).map(p => partFromDict(p)) : rawSystem as string | undefined;
  return {
    model: d.model as string,
    messages: (d.messages as JsonObject[]).map(m => messageFromDict(m)),
    system: system as LMRequest["system"],
    tools: d.tools ? (d.tools as JsonObject[]).map(t => toolFromDict(t)) : undefined,
    config: d.config ? configFromDict(d.config as JsonObject) : undefined,
  };
}

export function responseFromDict(d: JsonObject): LMResponse {
  return {
    id: (d.id as string) ?? "",
    model: d.model as string,
    message: messageFromDict(d.message as JsonObject),
    finish_reason: d.finish_reason as LMResponse["finish_reason"],
    usage: d.usage ? usageFromDict(d.usage as JsonObject) : EMPTY_USAGE,
    provider: d.provider as JsonObject | undefined,
  };
}

export function errorInfoFromDict(d: JsonObject): ErrorInfo {
  return { code: d.code as ErrorInfo["code"], message: d.message as string, provider_code: d.provider_code as string | undefined };
}

export function streamEventFromDict(d: JsonObject): StreamEvent {
  const rawDelta = d.delta as JsonObject | undefined;
  const delta = rawDelta && typeof rawDelta.type === "string" && ["text", "tool_call", "thinking", "audio"].includes(rawDelta.type as string)
    ? rawDelta as unknown as PartDelta
    : rawDelta;
  return {
    type: d.type as StreamEvent["type"],
    id: d.id as string | undefined,
    model: d.model as string | undefined,
    part_index: d.part_index as number | undefined,
    delta,
    part_type: d.part_type as string | undefined,
    finish_reason: d.finish_reason as StreamEvent["finish_reason"],
    usage: d.usage ? usageFromDict(d.usage as JsonObject) : undefined,
    error: d.error ? errorInfoFromDict(d.error as JsonObject) : undefined,
  };
}
