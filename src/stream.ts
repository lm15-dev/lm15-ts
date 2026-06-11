/**
 * Stream coalescing and materialization (Stage E).
 *
 * - `coalesceStream` enforces MAP-3 (mapping-rules.md): adapters are
 *   stateless and may emit one end event per provider terminal frame
 *   (finish_reason chunk, usage-only chunk, [DONE], message_delta +
 *   message_stop); the coalescer absorbs every end event — a later
 *   non-null field replaces the accumulated value, null never erases —
 *   and emits EXACTLY ONE merged StreamEndEvent as the final event.
 *   If no end event was seen, none is fabricated.
 * - `materializeResponse` accumulates the post-coalesce trace into a
 *   complete canonical Response (the reference's `_RoundState`).
 */

import { isJsonObject, parseCanonicalJson, type JsonObject, type JsonValue } from "./canonical-json.js";
import * as t from "./types.js";

// ─── MAP-3 coalescer ─────────────────────────────────────────────────

export function coalesceStream(events: Iterable<t.StreamEvent>): t.StreamEvent[] {
  const out: t.StreamEvent[] = [];
  let sawEnd = false;
  let finishReason: t.StreamEndEvent["finish_reason"] = null;
  let usage: t.Usage | null = null;
  let providerData: JsonObject | null = null;
  for (const event of events) {
    if (event.type === "end") {
      sawEnd = true;
      if (event.finish_reason !== null) finishReason = event.finish_reason;
      if (event.usage !== null) usage = event.usage;
      if (event.provider_data !== null) providerData = event.provider_data;
      continue;
    }
    out.push(event);
  }
  if (sawEnd) {
    out.push(
      t.streamEndEvent({ finish_reason: finishReason, usage, provider_data: providerData }),
    );
  }
  return out;
}

// ─── Materialization (reference _RoundState) ─────────────────────────

function parseJsonBestEffort(raw: string): JsonObject {
  if (!raw) return {};
  let value: JsonValue;
  try {
    value = parseCanonicalJson(raw);
  } catch {
    return { partial_json: raw };
  }
  return isJsonObject(value) ? value : { value };
}

function concatB64Chunks(chunks: readonly string[]): Buffer {
  const raw: Buffer[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    try {
      raw.push(Buffer.from(chunk, "base64"));
    } catch {
      // ignore undecodable chunk (mirrors the reference's best-effort decode)
    }
  }
  return Buffer.concat(raw);
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface ToolCallMeta {
  id?: string;
  name?: string;
  input?: JsonObject;
}

export function materializeResponse(
  events: Iterable<t.StreamEvent>,
  request: t.Request,
): t.Response {
  let startedId: string | null = null;
  let startedModel: string | null = null;
  let finishReason: string | null = null;
  let usage: t.Usage | null = null;
  let providerData: JsonObject | null = null;
  const textParts = new Map<number, string[]>();
  const thinkingParts = new Map<number, string[]>();
  const audioChunks = new Map<number, string[]>();
  const audioMediaTypes = new Map<number, string | null>();
  const imageParts = new Map<number, t.ImagePart>();
  const citationParts = new Map<number, t.CitationPart[]>();
  const toolCallRaw = new Map<number, string>();
  const toolCallMeta = new Map<number, ToolCallMeta>();
  const messageContinuation: t.ContinuationState[] = [];
  const partContinuation = new Map<number, t.ContinuationState[]>();

  const push = <V>(map: Map<number, V[]>, idx: number, value: V): void => {
    const list = map.get(idx);
    if (list === undefined) map.set(idx, [value]);
    else list.push(value);
  };

  for (const event of events) {
    switch (event.type) {
      case "start":
        startedId = event.id ?? startedId;
        startedModel = event.model ?? startedModel;
        break;
      case "end":
        finishReason = event.finish_reason ?? finishReason;
        usage = event.usage ?? usage;
        if (event.provider_data !== null) providerData = event.provider_data;
        break;
      case "error":
        // The vet replay path never reaches materialization on error events;
        // tolerate them here by ignoring (Result raises instead).
        break;
      case "delta": {
        const delta = event.delta;
        switch (delta.type) {
          case "text":
            push(textParts, delta.part_index, delta.text);
            break;
          case "thinking":
            push(thinkingParts, delta.part_index, delta.text);
            break;
          case "audio":
            push(audioChunks, delta.part_index, delta.data ?? "");
            if (!audioMediaTypes.has(delta.part_index)) {
              audioMediaTypes.set(delta.part_index, delta.media_type);
            }
            break;
          case "tool_call": {
            const idx = delta.part_index;
            let meta = toolCallMeta.get(idx);
            if (meta === undefined) {
              meta = {};
              toolCallMeta.set(idx, meta);
            }
            if (delta.id !== null) meta.id = delta.id;
            if (delta.name !== null) meta.name = delta.name;
            const aggregate = (toolCallRaw.get(idx) ?? "") + delta.input;
            toolCallRaw.set(idx, aggregate);
            meta.input = parseJsonBestEffort(aggregate);
            break;
          }
          case "image": {
            const mt = delta.media_type ?? "image/png";
            let part: t.ImagePart | null = null;
            if (delta.data !== null) {
              part = t.mediaPart("image", { media_type: mt, data: delta.data }) as t.ImagePart;
            } else if (delta.url !== null) {
              part = t.mediaPart("image", { media_type: mt, url: delta.url }) as t.ImagePart;
            } else if (delta.file_id !== null) {
              part = t.mediaPart("image", { media_type: mt, file_id: delta.file_id }) as t.ImagePart;
            }
            if (part !== null) imageParts.set(delta.part_index, part);
            break;
          }
          case "citation":
            push(
              citationParts,
              delta.part_index,
              t.citationPart({ text: delta.text, url: delta.url, title: delta.title }),
            );
            break;
          case "continuation": {
            const state = t.continuationState({
              provider: delta.provider,
              kind: delta.kind,
              data: delta.data,
            });
            if (delta.part_index === null) messageContinuation.push(state);
            else push(partContinuation, delta.part_index, state);
            break;
          }
          default: {
            const exhaustive: never = delta;
            throw new Error(`unsupported delta: ${JSON.stringify(exhaustive)}`);
          }
        }
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`unsupported stream event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const parts: t.Part[] = [];
  const toolNames = request.tools.filter((x) => x.type === "function").map((x) => x.name);
  const partIndexes = [
    ...new Set([
      ...thinkingParts.keys(),
      ...textParts.keys(),
      ...imageParts.keys(),
      ...audioChunks.keys(),
      ...citationParts.keys(),
      ...toolCallMeta.keys(),
      ...partContinuation.keys(),
    ]),
  ].sort((a, b) => a - b);

  partIndexes.forEach((idx, pos) => {
    const continuation = partContinuation.get(idx) ?? [];
    if (thinkingParts.has(idx)) {
      parts.push(t.thinkingPart({ text: thinkingParts.get(idx)!.join(""), continuation }));
    }
    if (textParts.has(idx)) {
      parts.push(t.textPart({ text: textParts.get(idx)!.join(""), continuation }));
    }
    if (imageParts.has(idx)) {
      const img = imageParts.get(idx)!;
      parts.push({ ...img, continuation });
    }
    if (audioChunks.has(idx)) {
      const rawData = concatB64Chunks(audioChunks.get(idx)!);
      const mediaType = audioMediaTypes.get(idx) ?? null;
      if (mediaType === null || mediaType === "audio/pcm" || mediaType === "audio/pcm16") {
        parts.push(
          t.mediaPart("audio", {
            media_type: "audio/wav",
            data: pcmToWav(rawData).toString("base64"),
            continuation,
          }),
        );
      } else {
        parts.push(
          t.mediaPart("audio", {
            media_type: mediaType,
            data: rawData.toString("base64"),
            continuation,
          }),
        );
      }
    }
    if (citationParts.has(idx)) {
      for (const part of citationParts.get(idx)!) {
        parts.push({ ...part, continuation });
      }
    }
    if (toolCallMeta.has(idx)) {
      const meta = toolCallMeta.get(idx)!;
      const payload = meta.input ?? parseJsonBestEffort(toolCallRaw.get(idx) ?? "");
      let tcName = meta.name;
      if (tcName === undefined || tcName === "") {
        if (toolNames.length === 1) tcName = toolNames[0]!;
        else if (pos < toolNames.length) tcName = toolNames[pos]!;
        else tcName = "tool";
      }
      const tcId = meta.id !== undefined && meta.id !== "" ? meta.id : `tool_call_${idx}`;
      parts.push(t.toolCallPart({ id: tcId, name: tcName, input: payload, continuation }));
    } else if (
      !thinkingParts.has(idx) &&
      !textParts.has(idx) &&
      !imageParts.has(idx) &&
      !audioChunks.has(idx) &&
      !citationParts.has(idx)
    ) {
      parts.push(t.textPart({ text: "", continuation }));
    }
  });

  if (parts.length === 0) parts.push(t.textPart({ text: "" })); // MAP-2

  const hasToolCalls = parts.some((p) => p.type === "tool_call");
  let finish = finishReason;
  if (finish === null) finish = hasToolCalls ? "tool_call" : "stop";
  else if (finish === "stop" && hasToolCalls) finish = "tool_call";

  return t.response({
    id: startedId,
    model: startedModel ?? request.model,
    message: t.message({ role: "assistant", parts, continuation: messageContinuation }),
    finish_reason: finish,
    usage: usage ?? t.usage(),
    provider_data: providerData,
  });
}
