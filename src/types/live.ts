/**
 * Audio / live (realtime) types (spec/types.md § Audio / Live).
 */

import { isJsonObject, omitEmpty, type JsonObject } from "../json.ts";
import { AUDIO_ENCODINGS, type AudioEncoding } from "../vocab.ts";
import { Tool, isTool, normalizeTool } from "./config.ts";
import {
  Part,
  isPart,
  normalizePart,
  normalizeSystem,
  systemFromJSON,
  systemToJSON,
  type PromptPart,
  type ToolResultContentPart,
} from "./parts.ts";
import { ErrorDetail, Usage, isEmptyUsage, normalizeErrorDetail, normalizeUsage } from "./response.ts";
import {
  ValueError,
  absent,
  compact,
  extensionsField,
  frozen,
  optionalString,
  requireBool,
  requireInt,
  requireJsonObject,
  requireOneOf,
  requireString,
  validateBase64,
} from "./validate.ts";

// ─── AudioFormat ─────────────────────────────────────────────────────

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRate: number;
  readonly channels?: number;
}

export function normalizeAudioFormat(input: unknown): AudioFormat {
  if (typeof input !== "object" || input === null) throw new TypeError("expected an AudioFormat");
  const d = input as Record<string, unknown>;
  return frozen({
    encoding: requireOneOf(AUDIO_ENCODINGS, d["encoding"], "audio encoding"),
    sampleRate: requireInt(d["sampleRate"], "sample_rate", { min: 1 }),
    channels: absent(d["channels"]) ? 1 : requireInt(d["channels"], "channels", { min: 1 }),
  });
}

export const AudioFormat = {
  create: normalizeAudioFormat,
  fromJSON(d: JsonObject): AudioFormat {
    return normalizeAudioFormat({ encoding: d["encoding"], sampleRate: d["sample_rate"], channels: d["channels"] ?? 1 });
  },
  toJSON(f: AudioFormat): JsonObject {
    return omitEmpty({ encoding: f.encoding, sample_rate: f.sampleRate, channels: f.channels ?? 1 });
  },
};

// ─── LiveConfig ──────────────────────────────────────────────────────

export interface LiveConfig {
  readonly model: string;
  readonly system?: string | readonly PromptPart[];
  readonly tools?: readonly Tool[];
  readonly voice?: string;
  readonly inputFormat?: AudioFormat;
  readonly outputFormat?: AudioFormat;
  readonly extensions?: JsonObject;
}

export function normalizeLiveConfig(input: unknown): LiveConfig {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a LiveConfig");
  const d = input as Record<string, unknown>;
  if (typeof d["model"] !== "string" || d["model"] === "") throw new ValueError("model is required");
  const rawTools = absent(d["tools"]) ? [] : Array.isArray(d["tools"]) ? d["tools"] : [d["tools"]];
  const tools = Object.freeze(
    rawTools.map((t) => {
      if (!isTool(t)) throw new TypeError("LiveConfig.tools must contain Tool objects");
      return normalizeTool(t);
    }),
  );
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new ValueError("LiveConfig.tools cannot contain duplicate tool names");
  return frozen(
    compact({
      model: d["model"],
      system: normalizeSystem(d["system"]),
      tools: tools.length > 0 ? tools : undefined,
      voice: optionalString(d["voice"], "LiveConfig.voice", false),
      inputFormat: absent(d["inputFormat"]) ? undefined : normalizeAudioFormat(d["inputFormat"]),
      outputFormat: absent(d["outputFormat"]) ? undefined : normalizeAudioFormat(d["outputFormat"]),
      extensions: extensionsField(d["extensions"]),
    }),
  );
}

export const LiveConfig = {
  create: normalizeLiveConfig,
  fromJSON(d: JsonObject): LiveConfig {
    const tools = d["tools"] ?? [];
    if (!Array.isArray(tools)) throw new TypeError("LiveConfig.tools must be a list");
    return normalizeLiveConfig({
      model: d["model"],
      system: systemFromJSON(d["system"]),
      tools: tools.map((t) => Tool.fromJSON(t as JsonObject)),
      voice: d["voice"],
      inputFormat: isJsonObject(d["input_format"]) ? AudioFormat.fromJSON(d["input_format"]) : undefined,
      outputFormat: isJsonObject(d["output_format"]) ? AudioFormat.fromJSON(d["output_format"]) : undefined,
      extensions: d["extensions"],
    });
  },
  toJSON(c: LiveConfig): JsonObject {
    return omitEmpty({
      model: c.model,
      system: systemToJSON(c.system),
      tools: (c.tools ?? []).map(Tool.toJSON),
      voice: c.voice,
      input_format: c.inputFormat ? AudioFormat.toJSON(c.inputFormat) : undefined,
      output_format: c.outputFormat ? AudioFormat.toJSON(c.outputFormat) : undefined,
      extensions: c.extensions,
    });
  },
};

// ─── Client events ───────────────────────────────────────────────────

export interface LiveClientTurnEvent {
  readonly type: "turn";
  readonly parts: readonly PromptPart[];
  readonly turnComplete?: boolean;
}
export interface LiveClientAudioEvent {
  readonly type: "audio";
  readonly data: string;
  readonly mediaType?: string;
}
export interface LiveClientImageEvent {
  readonly type: "image";
  readonly data: string;
  readonly mediaType?: string;
}
export interface LiveClientTextEvent {
  readonly type: "text";
  readonly text: string;
}
export interface LiveClientToolResultEvent {
  readonly type: "tool_result";
  readonly id: string;
  readonly content: readonly ToolResultContentPart[];
}
export interface LiveClientInterruptEvent {
  readonly type: "interrupt";
}
export interface LiveClientEndAudioEvent {
  readonly type: "end_audio";
}

export type LiveClientEvent =
  | LiveClientTurnEvent
  | LiveClientAudioEvent
  | LiveClientImageEvent
  | LiveClientTextEvent
  | LiveClientToolResultEvent
  | LiveClientInterruptEvent
  | LiveClientEndAudioEvent;

const PROMPT_FORBIDDEN = new Set(["tool_call", "tool_result", "thinking", "refusal", "citation"]);
const TOOL_RESULT_FORBIDDEN = new Set(["tool_call", "tool_result", "thinking", "refusal"]);

export const DEFAULT_LIVE_AUDIO_MEDIA_TYPE = "audio/pcm;rate=16000";
export const DEFAULT_LIVE_IMAGE_MEDIA_TYPE = "image/jpeg";

export function normalizeLiveClientEvent(input: unknown): LiveClientEvent {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a LiveClientEvent");
  const d = input as Record<string, unknown>;
  switch (d["type"]) {
    case "turn": {
      const raw = isPart(d["parts"]) ? [d["parts"]] : d["parts"];
      if (!Array.isArray(raw)) throw new TypeError("LiveClientTurnEvent.parts must contain Part objects");
      if (raw.length === 0) throw new ValueError("LiveClientTurnEvent requires at least one part");
      const parts = raw.map((p) => {
        if (!isPart(p)) throw new TypeError("LiveClientTurnEvent.parts must contain Part objects");
        const part = normalizePart(p);
        if (PROMPT_FORBIDDEN.has(part.type)) throw new TypeError("LiveClientTurnEvent.parts cannot contain model/tool protocol parts");
        return part as PromptPart;
      });
      const turnComplete = absent(d["turnComplete"]) ? true : requireBool(d["turnComplete"], "LiveClientTurnEvent.turn_complete");
      return frozen({ type: "turn", parts: Object.freeze(parts), turnComplete });
    }
    case "audio":
    case "image": {
      const name = d["type"] === "audio" ? "LiveClientAudioEvent" : "LiveClientImageEvent";
      const prefix = d["type"] === "audio" ? "audio/" : "image/";
      const data = requireString(d["data"], `${name}.data`, false);
      validateBase64(name, data);
      const mediaType = requireString(
        d["mediaType"] ?? (d["type"] === "audio" ? DEFAULT_LIVE_AUDIO_MEDIA_TYPE : DEFAULT_LIVE_IMAGE_MEDIA_TYPE),
        `${name}.media_type`,
        false,
      );
      if (!mediaType.startsWith(prefix)) throw new ValueError(`${name}.media_type must start with '${prefix}'`);
      return frozen({ type: d["type"], data, mediaType });
    }
    case "text":
      return frozen({ type: "text", text: requireString(d["text"], "LiveClientTextEvent.text") });
    case "tool_result": {
      const raw = d["content"];
      if (!Array.isArray(raw)) throw new TypeError("LiveClientToolResultEvent.content must contain Part objects");
      if (raw.length === 0) throw new ValueError("LiveClientToolResultEvent requires content");
      const content = raw.map((p) => {
        if (!isPart(p)) throw new TypeError("LiveClientToolResultEvent.content must contain Part objects");
        const part = normalizePart(p);
        if (TOOL_RESULT_FORBIDDEN.has(part.type)) throw new TypeError("LiveClientToolResultEvent.content cannot contain model or protocol parts");
        return part as ToolResultContentPart;
      });
      return frozen({ type: "tool_result", id: requireString(d["id"], "LiveClientToolResultEvent.id", false), content: Object.freeze(content) });
    }
    case "interrupt":
      return frozen({ type: "interrupt" });
    case "end_audio":
      return frozen({ type: "end_audio" });
    default:
      throw new ValueError(`unsupported live client event type: ${String(d["type"])}`);
  }
}

export const LiveClientEvent = {
  create: normalizeLiveClientEvent,
  fromJSON(d: JsonObject): LiveClientEvent {
    const t = d["type"];
    switch (t) {
      case "turn": {
        const parts = d["parts"] ?? [];
        return normalizeLiveClientEvent({
          type: t,
          parts: Array.isArray(parts) ? parts.map((p) => Part.fromJSON(p as JsonObject)) : [],
          turnComplete: d["turn_complete"] ?? true,
        });
      }
      case "audio":
        return normalizeLiveClientEvent({ type: t, data: d["data"], mediaType: d["media_type"] ?? DEFAULT_LIVE_AUDIO_MEDIA_TYPE });
      case "image":
        return normalizeLiveClientEvent({ type: t, data: d["data"], mediaType: d["media_type"] ?? DEFAULT_LIVE_IMAGE_MEDIA_TYPE });
      case "text":
        return normalizeLiveClientEvent({ type: t, text: d["text"] ?? "" });
      case "tool_result": {
        const content = d["content"] ?? [];
        return normalizeLiveClientEvent({
          type: t,
          id: d["id"],
          content: Array.isArray(content) ? content.map((p) => Part.fromJSON(p as JsonObject)) : [],
        });
      }
      case "interrupt":
      case "end_audio":
        return normalizeLiveClientEvent({ type: t });
      default:
        throw new ValueError(`unsupported live client event type: ${String(t)}`);
    }
  },
  /** Serialized WITHOUT cleaning: every field verbatim, including `turn_complete: false`. */
  toJSON(e: LiveClientEvent): JsonObject {
    switch (e.type) {
      case "turn":
        return { type: "turn", parts: e.parts.map(Part.toJSON), turn_complete: e.turnComplete ?? true };
      case "audio":
        return { type: "audio", data: e.data, media_type: e.mediaType ?? DEFAULT_LIVE_AUDIO_MEDIA_TYPE };
      case "image":
        return { type: "image", data: e.data, media_type: e.mediaType ?? DEFAULT_LIVE_IMAGE_MEDIA_TYPE };
      case "text":
        return { type: "text", text: e.text };
      case "tool_result":
        return { type: "tool_result", id: e.id, content: e.content.map(Part.toJSON) };
      case "interrupt":
      case "end_audio":
        return { type: e.type };
    }
  },
};

// ─── Server events ───────────────────────────────────────────────────

export interface LiveServerAudioEvent {
  readonly type: "audio";
  readonly data: string;
  readonly mediaType?: string;
}
export interface LiveServerTextEvent {
  readonly type: "text";
  readonly text: string;
}
export interface LiveServerToolCallEvent {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}
export interface LiveServerToolCallDeltaEvent {
  readonly type: "tool_call_delta";
  readonly inputDelta: string;
  readonly id?: string;
  readonly name?: string;
}
export interface LiveServerInterruptedEvent {
  readonly type: "interrupted";
}
export interface LiveServerTurnEndEvent {
  readonly type: "turn_end";
  readonly usage: Usage;
}
/** Billed usage of a response that did not end the turn; never a turn boundary. */
export interface LiveServerUsageEvent {
  readonly type: "usage";
  readonly usage: Usage;
}
export interface LiveServerErrorEvent {
  readonly type: "error";
  readonly error: ErrorDetail;
}

export type LiveServerEvent =
  | LiveServerAudioEvent
  | LiveServerTextEvent
  | LiveServerToolCallEvent
  | LiveServerToolCallDeltaEvent
  | LiveServerInterruptedEvent
  | LiveServerTurnEndEvent
  | LiveServerUsageEvent
  | LiveServerErrorEvent;

export function normalizeLiveServerEvent(input: unknown): LiveServerEvent {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a LiveServerEvent");
  const d = input as Record<string, unknown>;
  switch (d["type"]) {
    case "audio": {
      const data = requireString(d["data"], "LiveServerAudioEvent.data", false);
      validateBase64("LiveServerAudioEvent", data);
      const mediaType = optionalString(d["mediaType"], "LiveServerAudioEvent.media_type", false);
      if (mediaType !== undefined && !mediaType.startsWith("audio/")) {
        throw new ValueError("LiveServerAudioEvent.media_type must start with 'audio/'");
      }
      return frozen(compact({ type: "audio" as const, data, mediaType }));
    }
    case "text":
      return frozen({ type: "text", text: requireString(d["text"], "LiveServerTextEvent.text") });
    case "tool_call":
      return frozen({
        type: "tool_call",
        id: requireString(d["id"], "LiveServerToolCallEvent.id", false),
        name: requireString(d["name"], "LiveServerToolCallEvent.name", false),
        input: requireJsonObject(d["input"], "input"),
      });
    case "tool_call_delta":
      return frozen(
        compact({
          type: "tool_call_delta" as const,
          inputDelta: requireString(d["inputDelta"], "LiveServerToolCallDeltaEvent.input_delta"),
          id: optionalString(d["id"], "LiveServerToolCallDeltaEvent.id", false),
          name: optionalString(d["name"], "LiveServerToolCallDeltaEvent.name", false),
        }),
      );
    case "interrupted":
      return frozen({ type: "interrupted" });
    case "turn_end":
    case "usage":
      return frozen({ type: d["type"], usage: normalizeUsage(d["usage"]) });
    case "error":
      return frozen({ type: "error", error: normalizeErrorDetail(d["error"]) });
    default:
      throw new ValueError(`unsupported live server event type: ${String(d["type"])}`);
  }
}

export const LiveServerEvent = {
  create: normalizeLiveServerEvent,
  fromJSON(d: JsonObject): LiveServerEvent {
    const t = d["type"];
    switch (t) {
      case "audio":
        return normalizeLiveServerEvent({ type: t, data: d["data"], mediaType: d["media_type"] });
      case "text":
        return normalizeLiveServerEvent({ type: t, text: d["text"] ?? "" });
      case "tool_call":
        return normalizeLiveServerEvent({ type: t, id: d["id"], name: d["name"], input: d["input"] ?? {} });
      case "tool_call_delta":
        return normalizeLiveServerEvent({ type: t, inputDelta: d["input_delta"] ?? "", id: d["id"], name: d["name"] });
      case "interrupted":
        return normalizeLiveServerEvent({ type: t });
      case "turn_end":
      case "usage":
        return normalizeLiveServerEvent({ type: t, usage: isJsonObject(d["usage"]) ? Usage.fromJSON(d["usage"]) : Usage.empty });
      case "error":
        if (!isJsonObject(d["error"])) throw new TypeError("LiveServerErrorEvent.error must be an ErrorDetail");
        return normalizeLiveServerEvent({ type: t, error: ErrorDetail.fromJSON(d["error"]) });
      default:
        throw new ValueError(`unsupported live server event type: ${String(t)}`);
    }
  },
  toJSON(e: LiveServerEvent): JsonObject {
    switch (e.type) {
      case "audio":
        return omitEmpty({ type: "audio", data: e.data, media_type: e.mediaType });
      case "text":
        return { type: "text", text: e.text };
      case "tool_call":
        return { type: "tool_call", id: e.id, name: e.name, input: e.input };
      case "tool_call_delta":
        return omitEmpty({ type: "tool_call_delta", id: e.id, name: e.name, input_delta: e.inputDelta });
      case "interrupted":
        return { type: "interrupted" };
      case "turn_end":
      case "usage":
        return omitEmpty({ type: e.type, usage: isEmptyUsage(e.usage) ? undefined : Usage.toJSON(e.usage) });
      case "error":
        return { type: "error", error: ErrorDetail.toJSON(e.error) };
    }
  },
};
