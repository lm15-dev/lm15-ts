/**
 * Shared helpers for provider adapters.
 */

import type { DataSource, JsonObject, Message, Part } from "../types.js";

export function partsToText(parts: readonly Part[]): string {
  return parts
    .filter(p => p.type === "text" && "text" in p && p.text)
    .map(p => (p as { text: string }).text)
    .join("\n");
}

export function partToOpenAIInput(part: Part): JsonObject {
  if (part.type === "text") {
    return { type: "input_text", text: part.text ?? "" };
  }

  if (part.type === "image" && part.source) {
    if (part.source.type === "url") {
      const p: JsonObject = { type: "input_image", image_url: part.source.url! };
      if (part.source.detail) p.detail = part.source.detail;
      return p;
    }
    if (part.source.type === "base64") {
      return {
        type: "input_image",
        image_url: `data:${part.source.media_type};base64,${part.source.data}`,
      };
    }
    if (part.source.type === "file") {
      return { type: "input_image", file_id: part.source.file_id! };
    }
  }

  if (part.type === "audio" && part.source) {
    if (part.source.type === "base64") {
      const media = (part.source.media_type ?? "audio/wav").split("/").pop()!;
      return { type: "input_audio", audio: part.source.data!, format: media };
    }
    if (part.source.type === "url") {
      return { type: "input_audio", audio_url: part.source.url! };
    }
    if (part.source.type === "file") {
      return { type: "input_audio", file_id: part.source.file_id! };
    }
  }

  if (part.type === "document" && part.source) {
    if (part.source.type === "url") {
      return { type: "input_file", file_url: part.source.url! };
    }
    if (part.source.type === "base64") {
      return {
        type: "input_file",
        file_data: `data:${part.source.media_type};base64,${part.source.data}`,
      };
    }
    if (part.source.type === "file") {
      return { type: "input_file", file_id: part.source.file_id! };
    }
  }

  if (part.type === "video" && part.source) {
    if (part.source.type === "url") {
      return { type: "input_video", video_url: part.source.url! };
    }
    if (part.source.type === "base64") {
      return {
        type: "input_video",
        video_data: `data:${part.source.media_type};base64,${part.source.data}`,
      };
    }
    if (part.source.type === "file") {
      return { type: "input_video", file_id: part.source.file_id! };
    }
  }

  if (part.type === "tool_result") {
    return { type: "input_text", text: partsToText(part.content) };
  }

  return { type: "input_text", text: ("text" in part ? (part.text as string) : "") ?? "" };
}

export function messageToOpenAIInput(msg: Message): JsonObject {
  return {
    role: msg.role,
    content: msg.parts.map(p => partToOpenAIInput(p)) as JsonObject[],
  };
}

export function dsToAnthropicSource(ds: DataSource): JsonObject {
  if (ds.type === "url") return { type: "url", url: ds.url! };
  if (ds.type === "file") return { type: "file", file_id: ds.file_id! };
  return { type: "base64", media_type: ds.media_type!, data: ds.data! };
}
