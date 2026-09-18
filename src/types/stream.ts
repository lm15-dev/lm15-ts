/**
 * Deltas and stream events (spec/types.md § Deltas, § Stream events).
 * Closed discriminated unions on `type`.
 */

import { canonicalFactory } from "../canonical.ts";
import { isJsonObject, omitEmpty, type JsonObject, type JsonValue } from "../json.ts";
import { FINISH_REASONS, type FinishReason } from "../vocab.ts";
import { adaptationsFromJSON, adaptationsToJSON, normalizeAdaptations, type Adaptation } from "./adaptation.ts";
import { continuationState, type ContinuationState } from "./parts.ts";
import {
  ErrorDetail,
  TokenLogprob,
  Usage,
  isEmptyUsage,
  logprobsToJSON,
  normalizeErrorDetail,
  normalizeLogprobs,
  normalizeUsage,
} from "./response.ts";
import {
  ValueError,
  absent,
  compact,
  frozen,
  optionalInt,
  optionalJsonObject,
  optionalOneOf,
  optionalString,
  requireInt,
  requireJsonObject,
  requireString,
} from "./validate.ts";

// ─── Deltas ──────────────────────────────────────────────────────────

interface Indexed {
  /** The slot this fragment belongs to (MAP-9 assembly); default 0. */
  readonly partIndex?: number;
}

export interface TextDelta extends Indexed {
  readonly type: "text";
  readonly text: string;
  readonly logprobs?: readonly TokenLogprob[];
  /** `false`: a client-side cut left this fragment's retained text without its original scores. Materialization ANDs it. */
  readonly logprobsComplete?: boolean;
}
export interface ThinkingDelta extends Indexed {
  readonly type: "thinking";
  readonly text: string;
}
export interface AudioDelta extends Indexed {
  readonly type: "audio";
  /** May be an UNALIGNED partial base64 chunk. */
  readonly data?: string;
  readonly url?: string;
  readonly fileId?: string;
  readonly mediaType?: string;
}
export interface ImageDelta extends Indexed {
  readonly type: "image";
  readonly data?: string;
  readonly url?: string;
  readonly fileId?: string;
  readonly mediaType?: string;
}
export interface ToolCallDelta extends Indexed {
  readonly type: "tool_call";
  /** A raw JSON-text fragment. */
  readonly input: string;
  readonly id?: string;
  readonly name?: string;
}
export interface CitationDelta extends Indexed {
  readonly type: "citation";
  readonly text?: string;
  readonly url?: string;
  readonly title?: string;
}
export interface ContinuationDelta {
  readonly type: "continuation";
  readonly provider: string;
  readonly kind: string;
  readonly data: JsonObject;
  /** `undefined` attaches to the Message; an int attaches to that completed part. */
  readonly partIndex?: number;
}

export type Delta = TextDelta | ThinkingDelta | AudioDelta | ImageDelta | ToolCallDelta | CitationDelta | ContinuationDelta;

const DELTA_TYPE_SET = new Set(["text", "thinking", "audio", "image", "tool_call", "citation", "continuation"]);

export function isDelta(value: unknown): value is Delta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    DELTA_TYPE_SET.has((value as { type: string }).type)
  );
}

function partIndexOf(d: Record<string, unknown>): number {
  return absent(d["partIndex"]) ? 0 : requireInt(d["partIndex"], "part_index", { min: 0 });
}

export const normalizeDelta = canonicalFactory("delta", normalizeDeltaValue);
function normalizeDeltaValue(input: unknown): Delta {
  if (!isDelta(input)) {
    const t = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
    if (typeof t === "string") throw new ValueError(`unsupported delta type: ${t}`);
    throw new TypeError("StreamDeltaEvent.delta must be a Delta");
  }
  const d = input as unknown as Record<string, unknown>;
  switch (input.type) {
    case "text": {
      const logprobs = normalizeLogprobs(d["logprobs"], "TextDelta.logprobs");
      const complete = d["logprobsComplete"];
      if (!absent(complete) && typeof complete !== "boolean") throw new TypeError("TextDelta.logprobs_complete must be a bool");
      return frozen(
        compact({
          type: "text" as const,
          text: requireString(d["text"], "TextDelta.text"),
          partIndex: partIndexOf(d),
          logprobs: logprobs && logprobs.length > 0 ? logprobs : undefined,
          // Only the non-default survives on the value, so an untouched delta stays structurally equal to before.
          logprobsComplete: complete === false ? false : undefined,
        }),
      );
    }
    case "thinking":
      return frozen({ type: "thinking", text: requireString(d["text"], "ThinkingDelta.text"), partIndex: partIndexOf(d) });
    case "audio":
    case "image": {
      const name = input.type === "audio" ? "AudioDelta" : "ImageDelta";
      const data = optionalString(d["data"], `${name}.data`);
      const url = optionalString(d["url"], `${name}.url`);
      const fileId = optionalString(d["fileId"], `${name}.file_id`);
      if ([data, url, fileId].filter((v) => v !== undefined).length > 1) {
        throw new ValueError(`${name} can include at most one of data, url, or file_id`);
      }
      return frozen(
        compact({
          type: input.type,
          data,
          url,
          fileId,
          partIndex: partIndexOf(d),
          mediaType: optionalString(d["mediaType"], `${name}.media_type`, false),
        }),
      );
    }
    case "tool_call":
      return frozen(
        compact({
          type: "tool_call" as const,
          input: requireString(d["input"], "ToolCallDelta.input"),
          partIndex: partIndexOf(d),
          id: optionalString(d["id"], "ToolCallDelta.id", false),
          name: optionalString(d["name"], "ToolCallDelta.name", false),
        }),
      );
    case "citation": {
      const delta = compact({
        type: "citation" as const,
        text: optionalString(d["text"], "CitationDelta.text"),
        url: optionalString(d["url"], "CitationDelta.url"),
        title: optionalString(d["title"], "CitationDelta.title"),
        partIndex: partIndexOf(d),
      });
      if (delta.text === undefined && delta.url === undefined && delta.title === undefined) {
        throw new ValueError("CitationDelta requires at least one of text, url, or title");
      }
      return frozen(delta);
    }
    case "continuation":
      return frozen(
        compact({
          type: "continuation" as const,
          provider: requireString(d["provider"], "ContinuationDelta.provider", false),
          kind: requireString(d["kind"], "ContinuationDelta.kind", false),
          data: requireJsonObject(d["data"] ?? {}, "data"),
          partIndex: optionalInt(d["partIndex"], "part_index", { min: 0 }),
        }),
      );
  }
}

export function continuationDeltaToState(d: ContinuationDelta): ContinuationState {
  return continuationState(d.provider, d.kind, d.data);
}

export const Delta = {
  create: normalizeDelta,
  is: isDelta,
  fromJSON(d: JsonObject): Delta {
    const t = d["type"];
    if (typeof t !== "string") throw new ValueError(`unsupported delta type: ${String(t)}`);
    const partIndex = d["part_index"] ?? (t === "continuation" ? undefined : 0);
    switch (t) {
      case "text": {
        const lp = d["logprobs"];
        return normalizeDelta({
          type: t,
          text: d["text"] ?? "",
          partIndex,
          logprobs: Array.isArray(lp) ? lp.map((x) => TokenLogprob.fromJSON(x as JsonObject)) : undefined,
          logprobsComplete: d["logprobs_complete"],
        });
      }
      case "thinking":
        return normalizeDelta({ type: t, text: d["text"] ?? "", partIndex });
      case "audio":
      case "image":
        return normalizeDelta({ type: t, data: d["data"], url: d["url"], fileId: d["file_id"], partIndex, mediaType: d["media_type"] });
      case "tool_call":
        return normalizeDelta({ type: t, input: d["input"] ?? "", partIndex, id: d["id"], name: d["name"] });
      case "citation":
        return normalizeDelta({ type: t, text: d["text"], url: d["url"], title: d["title"], partIndex });
      case "continuation":
        return normalizeDelta({ type: t, provider: d["provider"], kind: d["kind"], data: d["data"] ?? {}, partIndex });
      default:
        throw new ValueError(`unsupported delta type: ${t}`);
    }
  },
  /** Drops only `null`/absent fields — empty strings ARE emitted; `part_index` always (except a null ContinuationDelta's). */
  toJSON(delta: Delta): JsonObject {
    const out: JsonObject = { type: delta.type };
    if (delta.type !== "continuation") out["part_index"] = delta.partIndex ?? 0;
    switch (delta.type) {
      case "text":
        out["text"] = delta.text;
        if (delta.logprobs && delta.logprobs.length > 0) out["logprobs"] = logprobsToJSON(delta.logprobs) as JsonValue;
        if (delta.logprobsComplete === false) out["logprobs_complete"] = false;
        break;
      case "thinking":
        out["text"] = delta.text;
        break;
      case "audio":
      case "image":
        if (delta.data !== undefined) out["data"] = delta.data;
        if (delta.url !== undefined) out["url"] = delta.url;
        if (delta.fileId !== undefined) out["file_id"] = delta.fileId;
        if (delta.mediaType !== undefined) out["media_type"] = delta.mediaType;
        break;
      case "tool_call":
        out["input"] = delta.input;
        if (delta.id !== undefined) out["id"] = delta.id;
        if (delta.name !== undefined) out["name"] = delta.name;
        break;
      case "citation":
        if (delta.text !== undefined) out["text"] = delta.text;
        if (delta.url !== undefined) out["url"] = delta.url;
        if (delta.title !== undefined) out["title"] = delta.title;
        break;
      case "continuation":
        out["provider"] = delta.provider;
        out["kind"] = delta.kind;
        out["data"] = delta.data;
        if (delta.partIndex !== undefined) out["part_index"] = delta.partIndex;
        break;
    }
    return out;
  },
};

// ─── Stream events ───────────────────────────────────────────────────

export interface StreamStartEvent {
  readonly type: "start";
  readonly id?: string;
  readonly model?: string;
  /** MAP-13: known before the first byte, carried by the first event; the coalesced Response carries the same list. */
  readonly adaptations?: readonly Adaptation[];
}
export interface StreamDeltaEvent {
  readonly type: "delta";
  readonly delta: Delta;
}
export interface StreamEndEvent {
  readonly type: "end";
  readonly finishReason?: FinishReason;
  readonly usage?: Usage;
  /** The wire frame that supplied usage (MAP-3, D9) — an escape hatch, not a canonical fact. */
  readonly providerData?: JsonObject;
}
export interface StreamErrorEvent {
  readonly type: "error";
  readonly error: ErrorDetail;
}

export type StreamEvent = StreamStartEvent | StreamDeltaEvent | StreamEndEvent | StreamErrorEvent;

export const normalizeStreamEvent = canonicalFactory("stream_event", normalizeStreamEventValue);
function normalizeStreamEventValue(input: unknown): StreamEvent {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a StreamEvent object");
  const d = input as Record<string, unknown>;
  switch (d["type"]) {
    case "start":
      return frozen(
        compact({
          type: "start" as const,
          id: optionalString(d["id"], "StreamStartEvent.id", false),
          model: optionalString(d["model"], "StreamStartEvent.model", false),
          adaptations: normalizeAdaptations(d["adaptations"], "StreamStartEvent.adaptations"),
        }),
      );
    case "delta":
      return frozen({ type: "delta", delta: normalizeDelta(d["delta"]) });
    case "end": {
      const usage = absent(d["usage"]) ? undefined : normalizeUsage(d["usage"]);
      return frozen(
        compact({
          type: "end" as const,
          finishReason: optionalOneOf(FINISH_REASONS, d["finishReason"], "finish reason"),
          usage,
          providerData: optionalJsonObject(d["providerData"], "provider_data"),
        }),
      );
    }
    case "error":
      return frozen({ type: "error", error: normalizeErrorDetail(d["error"]) });
    default:
      throw new ValueError(`unsupported stream event type: ${String(d["type"])}`);
  }
}

export function streamStart(fields: { id?: string; model?: string; adaptations?: readonly Adaptation[] } = {}): StreamStartEvent {
  return normalizeStreamEvent({ type: "start", ...fields }) as StreamStartEvent;
}
export function streamDelta(delta: Delta): StreamDeltaEvent {
  return normalizeStreamEvent({ type: "delta", delta }) as StreamDeltaEvent;
}
export function streamEnd(fields: { finishReason?: FinishReason; usage?: Usage; providerData?: JsonObject } = {}): StreamEndEvent {
  return normalizeStreamEvent({ type: "end", ...fields }) as StreamEndEvent;
}
export function streamError(error: ErrorDetail): StreamErrorEvent {
  return normalizeStreamEvent({ type: "error", error }) as StreamErrorEvent;
}

export const StreamEvent = {
  create: normalizeStreamEvent,
  fromJSON(d: JsonObject): StreamEvent {
    switch (d["type"]) {
      case "start":
        return normalizeStreamEvent({ type: "start", id: d["id"], model: d["model"], adaptations: adaptationsFromJSON(d["adaptations"]) });
      case "delta":
        if (!isJsonObject(d["delta"])) throw new TypeError("StreamDeltaEvent.delta must be a Delta");
        return normalizeStreamEvent({ type: "delta", delta: Delta.fromJSON(d["delta"]) });
      case "end":
        return normalizeStreamEvent({
          type: "end",
          finishReason: d["finish_reason"],
          usage: isJsonObject(d["usage"]) ? Usage.fromJSON(d["usage"]) : undefined,
          providerData: d["provider_data"],
        });
      case "error":
        if (!isJsonObject(d["error"])) throw new TypeError("StreamErrorEvent.error must be an ErrorDetail");
        return normalizeStreamEvent({ type: "error", error: ErrorDetail.fromJSON(d["error"]) });
      default:
        throw new ValueError(`unsupported stream event type: ${String(d["type"])}`);
    }
  },
  toJSON(e: StreamEvent): JsonObject {
    switch (e.type) {
      case "start":
        return omitEmpty({ type: "start", id: e.id, model: e.model, adaptations: adaptationsToJSON(e.adaptations) });
      case "delta":
        return { type: "delta", delta: Delta.toJSON(e.delta) };
      case "end":
        return omitEmpty({
          type: "end",
          finish_reason: e.finishReason,
          usage: e.usage && !isEmptyUsage(e.usage) ? Usage.toJSON(e.usage) : undefined,
          provider_data: e.providerData,
        });
      case "error":
        return { type: "error", error: ErrorDetail.toJSON(e.error) };
    }
  },
};
