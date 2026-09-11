/**
 * The other endpoint surfaces (spec/types.md § Other endpoints): files,
 * caches, batches, image/speech generation, video jobs.
 */

import { canonicalFactory } from "../canonical.ts";
import { isJsonObject, omitEmpty, type JsonObject } from "../json.ts";
import {
  BATCH_OUTCOMES,
  BATCH_STATUSES,
  BATCH_TERMINAL_STATUSES,
  FILE_READINESS_VALUES,
  VIDEO_STATUSES,
  VIDEO_TERMINAL_STATUSES,
  type BatchOutcome,
  type BatchStatus,
  type FileReadiness,
  type VideoStatus,
} from "../vocab.ts";
import { CacheConfig, Config, Request, isDefaultConfig, normalizeRequest, type Tool } from "./config.ts";
import { Message, Part, isPart, normalizePart, type AudioPart, type ImagePart, type PromptPart } from "./parts.ts";
import { ErrorDetail, Response, Usage, isEmptyUsage, normalizeErrorDetail, normalizeUsage } from "./response.ts";
import {
  ValueError,
  absent,
  compact,
  decodeBase64,
  encodeBase64,
  extensionsField,
  frozen,
  optionalBool,
  optionalInt,
  optionalJsonObject,
  optionalOneOf,
  optionalString,
  requireInt,
  requireOneOf,
  requireString,
} from "./validate.ts";

function requireModel(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new ValueError("model is required");
  return value;
}

function requirePrompt(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("prompt must be a string");
  if (value === "") throw new ValueError("prompt is required");
  return value;
}

function imageParts(value: unknown, owner: string): readonly ImagePart[] {
  if (absent(value)) return EMPTY_IMAGES;
  const list = Array.isArray(value) ? value : [value];
  return Object.freeze(
    list.map((p) => {
      if (!isPart(p) || p.type !== "image") throw new TypeError(`${owner}.images must contain ImagePart objects`);
      return normalizePart(p) as ImagePart;
    }),
  );
}

const EMPTY_IMAGES: readonly ImagePart[] = Object.freeze([]);

// ─── Files ───────────────────────────────────────────────────────────

export interface FileUploadRequest {
  readonly filename: string;
  /** Raw bytes; exactly one of `bytes`/`path`. */
  readonly bytes?: Uint8Array;
  readonly mediaType?: string;
  readonly extensions?: JsonObject;
  /** A local path, read lazily by the adapter. */
  readonly path?: string;
}

export const normalizeFileUploadRequest = canonicalFactory("file_upload_request", normalizeFileUploadRequestValue);
function normalizeFileUploadRequestValue(input: unknown): FileUploadRequest {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a FileUploadRequest");
  const d = input as Record<string, unknown>;
  const filename = requireString(d["filename"], "FileUploadRequest.filename", false);
  let bytes = d["bytes"];
  const path = d["path"];
  if (!absent(path) && typeof path !== "string") throw new TypeError("path must be a string");
  if (path === "") throw new ValueError("path cannot be empty");
  if (absent(bytes) && absent(path)) throw new TypeError("FileUploadRequest requires bytes_data or path");
  if (!absent(bytes) && !absent(path)) throw new ValueError("FileUploadRequest requires exactly one of bytes_data or path");
  if (!absent(bytes)) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes_data must be bytes");
    if (bytes.length === 0) throw new ValueError("bytes_data is required");
  }
  return frozen(
    compact({
      filename,
      bytes: absent(bytes) ? undefined : (bytes as Uint8Array),
      mediaType: requireString(d["mediaType"] ?? "application/octet-stream", "FileUploadRequest.media_type", false),
      extensions: extensionsField(d["extensions"]),
      path: absent(path) ? undefined : (path as string),
    }),
  );
}

export const FileUploadRequest = {
  create: normalizeFileUploadRequest,
  fromJSON(d: JsonObject): FileUploadRequest {
    const raw = d["bytes_data"];
    return normalizeFileUploadRequest({
      filename: d["filename"],
      bytes: typeof raw === "string" ? decodeBase64("FileUploadRequest", raw) : undefined,
      mediaType: d["media_type"] ?? "application/octet-stream",
      extensions: d["extensions"],
      path: d["path"],
    });
  },
  toJSON(r: FileUploadRequest): JsonObject {
    return omitEmpty({
      filename: r.filename,
      bytes_data: r.bytes ? encodeBase64(r.bytes) : undefined,
      media_type: r.mediaType ?? "application/octet-stream",
      extensions: r.extensions,
      path: r.path,
    });
  },
};

export interface FileInfo {
  /** The provider reference verbatim; place it in a media part's `fileId`. */
  readonly id: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  /** ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly readiness?: FileReadiness;
  /** Tri-state: the provider's stated capability, or `undefined` when unreported. */
  readonly downloadable?: boolean;
  readonly providerData?: JsonObject;
}

export const normalizeFileInfo = canonicalFactory("file_info", normalizeFileInfoValue);
function normalizeFileInfoValue(input: unknown): FileInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a FileInfo");
  const d = input as Record<string, unknown>;
  return frozen(
    compact({
      id: requireString(d["id"], "FileInfo.id", false),
      filename: optionalString(d["filename"], "FileInfo.filename", false),
      mediaType: optionalString(d["mediaType"], "FileInfo.media_type", false),
      sizeBytes: optionalInt(d["sizeBytes"], "FileInfo.size_bytes", { min: 0 }),
      createdAt: optionalString(d["createdAt"], "FileInfo.created_at", false),
      expiresAt: optionalString(d["expiresAt"], "FileInfo.expires_at", false),
      readiness: absent(d["readiness"]) ? "ready" : requireOneOf(FILE_READINESS_VALUES, d["readiness"], "file readiness"),
      downloadable: optionalBool(d["downloadable"], "FileInfo.downloadable"),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const FileInfo = {
  create: normalizeFileInfo,
  ready(f: FileInfo): boolean {
    return (f.readiness ?? "ready") === "ready";
  },
  fromJSON(d: JsonObject): FileInfo {
    return normalizeFileInfo({
      id: d["id"],
      filename: d["filename"],
      mediaType: d["media_type"],
      sizeBytes: d["size_bytes"],
      createdAt: d["created_at"],
      expiresAt: d["expires_at"],
      readiness: d["readiness"] ?? "ready",
      downloadable: d["downloadable"],
      providerData: d["provider_data"],
    });
  },
  toJSON(f: FileInfo): JsonObject {
    const out = omitEmpty({
      id: f.id,
      filename: f.filename,
      media_type: f.mediaType,
      size_bytes: f.sizeBytes,
      created_at: f.createdAt,
      expires_at: f.expiresAt,
      readiness: f.readiness ?? "ready",
      provider_data: f.providerData,
    });
    if (f.downloadable !== undefined) out["downloadable"] = f.downloadable;
    return out;
  },
};

export interface FilePage {
  readonly items: readonly FileInfo[];
  /** Provider-issued, opaque; `undefined` = the listing is complete. */
  readonly nextCursor?: string;
}

export const normalizeFilePage = canonicalFactory("file_page", normalizeFilePageValue);
function normalizeFilePageValue(input: unknown): FilePage {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a FilePage");
  const d = input as Record<string, unknown>;
  const items = absent(d["items"]) ? [] : d["items"];
  if (!Array.isArray(items)) throw new TypeError("FilePage.items must contain FileInfo objects");
  return frozen(
    compact({
      items: Object.freeze(items.map(normalizeFileInfo)),
      nextCursor: optionalString(d["nextCursor"], "FilePage.next_cursor", false),
    }),
  );
}

export const FilePage = {
  create: normalizeFilePage,
  fromJSON(d: JsonObject): FilePage {
    const items = d["items"] ?? [];
    if (!Array.isArray(items)) throw new TypeError("FilePage.items must be a list");
    return normalizeFilePage({ items: items.map((x) => FileInfo.fromJSON(x as JsonObject)), nextCursor: d["next_cursor"] });
  },
  toJSON(p: FilePage): JsonObject {
    return omitEmpty({ items: p.items.map(FileInfo.toJSON), next_cursor: p.nextCursor });
  },
};

// ─── Caches (the stored tier of MAP-6) ───────────────────────────────

export interface CacheInfo {
  readonly id: string;
  readonly model: string;
  readonly tokens?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly label?: string;
  readonly providerData?: JsonObject;
}

export const normalizeCacheInfo = canonicalFactory("cache_info", normalizeCacheInfoValue);
function normalizeCacheInfoValue(input: unknown): CacheInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a CacheInfo");
  const d = input as Record<string, unknown>;
  return frozen(
    compact({
      id: requireString(d["id"], "CacheInfo.id", false),
      model: requireString(d["model"], "CacheInfo.model", false),
      tokens: optionalInt(d["tokens"], "CacheInfo.tokens", { min: 0 }),
      createdAt: optionalString(d["createdAt"], "CacheInfo.created_at", false),
      expiresAt: optionalString(d["expiresAt"], "CacheInfo.expires_at", false),
      label: optionalString(d["label"], "CacheInfo.label", false),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const CacheInfo = {
  create: normalizeCacheInfo,
  fromJSON(d: JsonObject): CacheInfo {
    return normalizeCacheInfo({
      id: d["id"],
      model: d["model"],
      tokens: d["tokens"],
      createdAt: d["created_at"],
      expiresAt: d["expires_at"],
      label: d["label"],
      providerData: d["provider_data"],
    });
  },
  toJSON(c: CacheInfo): JsonObject {
    return omitEmpty({
      id: c.id,
      model: c.model,
      tokens: c.tokens,
      created_at: c.createdAt,
      expires_at: c.expiresAt,
      label: c.label,
      provider_data: c.providerData,
    });
  },
};

export interface CachePage {
  readonly items: readonly CacheInfo[];
  readonly nextCursor?: string;
}

export const normalizeCachePage = canonicalFactory("cache_page", normalizeCachePageValue);
function normalizeCachePageValue(input: unknown): CachePage {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a CachePage");
  const d = input as Record<string, unknown>;
  const items = absent(d["items"]) ? [] : d["items"];
  if (!Array.isArray(items)) throw new TypeError("CachePage.items must contain CacheInfo objects");
  return frozen(
    compact({
      items: Object.freeze(items.map(normalizeCacheInfo)),
      nextCursor: optionalString(d["nextCursor"], "CachePage.next_cursor", false),
    }),
  );
}

export const CachePage = {
  create: normalizeCachePage,
  fromJSON(d: JsonObject): CachePage {
    const items = d["items"] ?? [];
    if (!Array.isArray(items)) throw new TypeError("CachePage.items must be a list");
    return normalizeCachePage({ items: items.map((x) => CacheInfo.fromJSON(x as JsonObject)), nextCursor: d["next_cursor"] });
  },
  toJSON(p: CachePage): JsonObject {
    return omitEmpty({ items: p.items.map(CacheInfo.toJSON), next_cursor: p.nextCursor });
  },
};

/** A reusable prompt beginning: `cached = await lm.cache(prefix)`, then `cached.request(messages)`. */
export interface CachedPrefix {
  /** Its config must be default: a cached object has no generation settings. */
  readonly prefix: Request;
  readonly resource?: CacheInfo;
}

export const normalizeCachedPrefix = canonicalFactory("cached_prefix", normalizeCachedPrefixValue);
function normalizeCachedPrefixValue(input: unknown): CachedPrefix {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a CachedPrefix");
  const d = input as Record<string, unknown>;
  if (typeof d["prefix"] !== "object" || d["prefix"] === null) throw new TypeError("CachedPrefix.prefix must be a Request");
  const prefix = normalizeRequest(d["prefix"]);
  if (!isDefaultConfig(prefix.config)) {
    throw new ValueError("CachedPrefix.prefix must carry a default Config: a cached object has no generation settings");
  }
  const resource = absent(d["resource"]) ? undefined : normalizeCacheInfo(d["resource"]);
  if (resource && resource.model !== prefix.model) {
    throw new ValueError("CachedPrefix.resource.model must equal the prefix model (a stored cache belongs to one model)");
  }
  return frozen(compact({ prefix, resource }));
}

export const CachedPrefix = {
  create: normalizeCachedPrefix,
  id(c: CachedPrefix): string | undefined {
    return c.resource?.id;
  },
  expiresAt(c: CachedPrefix): string | undefined {
    return c.resource?.expiresAt;
  },
  /** The CacheConfig that marks the seam between prefix and suffix. */
  cacheConfig(c: CachedPrefix): CacheConfig {
    return CacheConfig.create({ prefixUntilIndex: c.prefix.messages.length - 1, resource: c.resource?.id });
  },
  /**
   * Append `messages` (a string → one user message, a Message, a list, or a
   * Request with the same model and no system/tools) and set the boundary.
   */
  request(c: CachedPrefix, messages: string | Message | readonly Message[] | Request, config?: Config): Request {
    let suffix: readonly Message[];
    let base = config;
    if (typeof messages === "string") suffix = [Message.user(messages)];
    else if (Array.isArray(messages)) {
      if (messages.length === 0 || !messages.every((m) => typeof m === "object" && "role" in m)) {
        throw new TypeError("messages must be a Message or a non-empty sequence of Messages");
      }
      suffix = messages as readonly Message[];
    } else if ("role" in messages) suffix = [messages as Message];
    else {
      const req = normalizeRequest(messages);
      if (req.model !== c.prefix.model) throw new ValueError("suffix Request model must equal the prefix model");
      if (req.system !== undefined || (req.tools && req.tools.length > 0)) {
        throw new ValueError("suffix Request cannot redefine system or tools: the prefix owns them");
      }
      if (base === undefined && !isDefaultConfig(req.config)) base = req.config;
      suffix = req.messages;
    }
    const baseConfig = base ?? {};
    if (baseConfig.cache !== undefined) throw new ValueError("config.cache is decided by the CachedPrefix; leave it unset");
    return normalizeRequest({
      model: c.prefix.model,
      system: c.prefix.system,
      tools: c.prefix.tools,
      messages: [...c.prefix.messages, ...suffix],
      config: { ...baseConfig, cache: CachedPrefix.cacheConfig(c) },
    });
  },
  fromJSON(d: JsonObject): CachedPrefix {
    if (!isJsonObject(d["prefix"])) throw new TypeError("CachedPrefix.prefix must be a Request");
    return normalizeCachedPrefix({
      prefix: Request.fromJSON(d["prefix"]),
      resource: isJsonObject(d["resource"]) ? CacheInfo.fromJSON(d["resource"]) : undefined,
    });
  },
  toJSON(c: CachedPrefix): JsonObject {
    return omitEmpty({ prefix: Request.toJSON(c.prefix), resource: c.resource ? CacheInfo.toJSON(c.resource) : undefined });
  },
};

// ─── Batch ───────────────────────────────────────────────────────────

export interface BatchRequest {
  /** Routing convenience only; inferred from `requests[0].model` (INV-032). */
  readonly model?: string;
  readonly requests: readonly Request[];
  readonly label?: string;
  readonly extensions?: JsonObject;
}

export const normalizeBatchRequest = canonicalFactory("batch_request", normalizeBatchRequestValue);
function normalizeBatchRequestValue(input: unknown): BatchRequest {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a BatchRequest");
  const d = input as Record<string, unknown>;
  const raw = absent(d["requests"]) ? [] : d["requests"];
  if (!Array.isArray(raw)) throw new TypeError("BatchRequest.requests must contain Request objects");
  if (raw.length === 0) throw new ValueError("requests cannot be empty");
  const requests = Object.freeze(
    raw.map((r) => {
      if (typeof r !== "object" || r === null) throw new TypeError("BatchRequest.requests must contain Request objects");
      return normalizeRequest(r);
    }),
  );
  return frozen(
    compact({
      model: optionalString(d["model"], "BatchRequest.model", false) ?? requests[0]!.model,
      requests,
      label: optionalString(d["label"], "BatchRequest.label", false),
      extensions: extensionsField(d["extensions"]),
    }),
  );
}

export const BatchRequest = {
  create: normalizeBatchRequest,
  fromJSON(d: JsonObject): BatchRequest {
    const raw = d["requests"] ?? [];
    if (!Array.isArray(raw)) throw new TypeError("BatchRequest.requests must be a list");
    return normalizeBatchRequest({
      model: d["model"],
      requests: raw.map((r) => Request.fromJSON(r as JsonObject)),
      label: d["label"],
      extensions: d["extensions"],
    });
  },
  toJSON(b: BatchRequest): JsonObject {
    return omitEmpty({ model: b.model, requests: b.requests.map(Request.toJSON), label: b.label, extensions: b.extensions });
  },
};

export interface BatchJobInfo {
  readonly id: string;
  readonly status: BatchStatus;
  readonly label?: string;
  readonly createdAt?: string;
  readonly providerData?: JsonObject;
}

export const normalizeBatchJobInfo = canonicalFactory("batch_job", normalizeBatchJobInfoValue);
function normalizeBatchJobInfoValue(input: unknown): BatchJobInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a BatchJobInfo");
  const d = input as Record<string, unknown>;
  return frozen(
    compact({
      id: requireString(d["id"], "BatchJobInfo.id", false),
      status: requireOneOf(BATCH_STATUSES, d["status"], "batch status"),
      label: optionalString(d["label"], "BatchJobInfo.label", false),
      createdAt: optionalString(d["createdAt"], "BatchJobInfo.created_at", false),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const BatchJobInfo = {
  create: normalizeBatchJobInfo,
  done(j: BatchJobInfo): boolean {
    return (BATCH_TERMINAL_STATUSES as readonly string[]).includes(j.status);
  },
  fromJSON(d: JsonObject): BatchJobInfo {
    return normalizeBatchJobInfo({
      id: d["id"],
      status: d["status"],
      label: d["label"],
      createdAt: d["created_at"],
      providerData: d["provider_data"],
    });
  },
  toJSON(j: BatchJobInfo): JsonObject {
    return omitEmpty({ id: j.id, status: j.status, label: j.label, created_at: j.createdAt, provider_data: j.providerData });
  },
};

export interface BatchEntry {
  /** Submission position. */
  readonly index: number;
  readonly outcome: BatchOutcome;
  readonly response?: Response;
  readonly error?: ErrorDetail;
}

export const normalizeBatchEntry = canonicalFactory("batch_entry", normalizeBatchEntryValue);
function normalizeBatchEntryValue(input: unknown): BatchEntry {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a BatchEntry");
  const d = input as Record<string, unknown>;
  let index: number;
  try {
    index = requireInt(d["index"], "BatchEntry.index", { min: 0 });
  } catch {
    throw new ValueError("BatchEntry.index must be a non-negative int");
  }
  const outcome = requireOneOf(BATCH_OUTCOMES, d["outcome"], "batch outcome");
  const response = d["response"];
  const error = d["error"];
  if (outcome === "succeeded") {
    if (!(response instanceof Response) || !absent(error)) throw new ValueError("succeeded entries carry a Response and no error");
  } else if (outcome === "errored") {
    if (absent(error) || !absent(response)) throw new ValueError("errored entries carry an ErrorDetail and no response");
  } else if (!absent(response) || !absent(error)) {
    throw new ValueError(`${outcome} entries carry neither response nor error`);
  }
  return frozen(
    compact({
      index,
      outcome,
      response: response instanceof Response ? response : undefined,
      error: absent(error) ? undefined : normalizeErrorDetail(error),
    }),
  );
}

export const BatchEntry = {
  create: normalizeBatchEntry,
  ok(e: BatchEntry): boolean {
    return e.outcome === "succeeded";
  },
  fromJSON(d: JsonObject): BatchEntry {
    return normalizeBatchEntry({
      index: d["index"],
      outcome: d["outcome"],
      response: isJsonObject(d["response"]) ? Response.fromJSON(d["response"]) : undefined,
      error: isJsonObject(d["error"]) ? ErrorDetail.fromJSON(d["error"]) : undefined,
    });
  },
  toJSON(e: BatchEntry): JsonObject {
    return omitEmpty({
      index: e.index,
      outcome: e.outcome,
      response: e.response ? Response.toJSON(e.response, { includeProviderData: true }) : undefined,
      error: e.error ? ErrorDetail.toJSON(e.error) : undefined,
    });
  },
};

// ─── Image generation ────────────────────────────────────────────────

export interface ImageGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  /** The provider's own sizing vocabulary. */
  readonly size?: string;
  /** Input images for edits. */
  readonly images?: readonly ImagePart[];
  readonly extensions?: JsonObject;
}

export const normalizeImageGenerationRequest = canonicalFactory("image_generation_request", normalizeImageGenerationRequestValue);
function normalizeImageGenerationRequestValue(input: unknown): ImageGenerationRequest {
  if (typeof input !== "object" || input === null) throw new TypeError("expected an ImageGenerationRequest");
  const d = input as Record<string, unknown>;
  const images = imageParts(d["images"], "ImageGenerationRequest");
  return frozen(
    compact({
      model: requireModel(d["model"]),
      prompt: requirePrompt(d["prompt"]),
      size: optionalString(d["size"], "size", false),
      images: images.length > 0 ? images : undefined,
      extensions: extensionsField(d["extensions"]),
    }),
  );
}

export const ImageGenerationRequest = {
  create: normalizeImageGenerationRequest,
  fromJSON(d: JsonObject): ImageGenerationRequest {
    const images = d["images"] ?? [];
    if (!Array.isArray(images)) throw new TypeError("images must be a list");
    return normalizeImageGenerationRequest({
      model: d["model"],
      prompt: d["prompt"],
      size: d["size"],
      images: images.map((x) => Part.fromJSON(x as JsonObject)),
      extensions: d["extensions"],
    });
  },
  toJSON(r: ImageGenerationRequest): JsonObject {
    return omitEmpty({
      model: r.model,
      prompt: r.prompt,
      size: r.size,
      images: (r.images ?? []).map(Part.toJSON),
      extensions: r.extensions,
    });
  },
};

export interface ImageGenerationResponse {
  readonly images: readonly ImagePart[];
  /** Narration returned next to images (Gemini); never fabricated. */
  readonly text?: string;
  readonly id?: string;
  readonly model?: string;
  readonly usage?: Usage;
  readonly providerData?: JsonObject;
}

export const normalizeImageGenerationResponse = canonicalFactory("image_generation_response", normalizeImageGenerationResponseValue);
function normalizeImageGenerationResponseValue(input: unknown): ImageGenerationResponse {
  if (typeof input !== "object" || input === null) throw new TypeError("expected an ImageGenerationResponse");
  const d = input as Record<string, unknown>;
  const images = imageParts(d["images"], "ImageGenerationResponse");
  if (images.length === 0) throw new ValueError("ImageGenerationResponse requires at least one image");
  return frozen(
    compact({
      images,
      text: optionalString(d["text"], "ImageGenerationResponse.text", false),
      id: optionalString(d["id"], "ImageGenerationResponse.id", false),
      model: optionalString(d["model"], "ImageGenerationResponse.model", false),
      usage: normalizeUsage(d["usage"]),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const ImageGenerationResponse = {
  create: normalizeImageGenerationResponse,
  fromJSON(d: JsonObject): ImageGenerationResponse {
    const images = d["images"] ?? [];
    if (!Array.isArray(images)) throw new TypeError("images must be a list");
    return normalizeImageGenerationResponse({
      images: images.map((x) => Part.fromJSON(x as JsonObject)),
      text: d["text"],
      id: d["id"],
      model: d["model"],
      usage: isJsonObject(d["usage"]) ? Usage.fromJSON(d["usage"]) : undefined,
      providerData: d["provider_data"],
    });
  },
  toJSON(r: ImageGenerationResponse): JsonObject {
    return omitEmpty({
      images: r.images.map(Part.toJSON),
      text: r.text,
      id: r.id,
      model: r.model,
      usage: r.usage && !isEmptyUsage(r.usage) ? Usage.toJSON(r.usage) : undefined,
      provider_data: r.providerData,
    });
  },
};

// ─── Speech generation ───────────────────────────────────────────────

export interface SpeechGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly voice?: string;
  readonly format?: string;
  readonly extensions?: JsonObject;
}

export const normalizeSpeechGenerationRequest = canonicalFactory("speech_generation_request", normalizeSpeechGenerationRequestValue);
function normalizeSpeechGenerationRequestValue(input: unknown): SpeechGenerationRequest {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a SpeechGenerationRequest");
  const d = input as Record<string, unknown>;
  return frozen(
    compact({
      model: requireModel(d["model"]),
      prompt: requirePrompt(d["prompt"]),
      voice: optionalString(d["voice"], "voice", false),
      format: optionalString(d["format"], "format", false),
      extensions: extensionsField(d["extensions"]),
    }),
  );
}

export const SpeechGenerationRequest = {
  create: normalizeSpeechGenerationRequest,
  fromJSON(d: JsonObject): SpeechGenerationRequest {
    return normalizeSpeechGenerationRequest({ model: d["model"], prompt: d["prompt"], voice: d["voice"], format: d["format"], extensions: d["extensions"] });
  },
  toJSON(r: SpeechGenerationRequest): JsonObject {
    return omitEmpty({ model: r.model, prompt: r.prompt, voice: r.voice, format: r.format, extensions: r.extensions });
  },
};

export interface SpeechGenerationResponse {
  /** `mediaType` from the wire verbatim, parameterized MIME included. */
  readonly audio: AudioPart;
  readonly id?: string;
  readonly model?: string;
  readonly usage?: Usage;
  readonly providerData?: JsonObject;
}

export const normalizeSpeechGenerationResponse = canonicalFactory("speech_generation_response", normalizeSpeechGenerationResponseValue);
function normalizeSpeechGenerationResponseValue(input: unknown): SpeechGenerationResponse {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a SpeechGenerationResponse");
  const d = input as Record<string, unknown>;
  const audio = d["audio"];
  if (!isPart(audio) || audio.type !== "audio") throw new TypeError("audio must be an AudioPart");
  return frozen(
    compact({
      audio: normalizePart(audio) as AudioPart,
      id: optionalString(d["id"], "SpeechGenerationResponse.id", false),
      model: optionalString(d["model"], "SpeechGenerationResponse.model", false),
      usage: normalizeUsage(d["usage"]),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const SpeechGenerationResponse = {
  create: normalizeSpeechGenerationResponse,
  fromJSON(d: JsonObject): SpeechGenerationResponse {
    if (!isJsonObject(d["audio"])) throw new TypeError("audio must be an AudioPart");
    return normalizeSpeechGenerationResponse({
      audio: Part.fromJSON(d["audio"]),
      id: d["id"],
      model: d["model"],
      usage: isJsonObject(d["usage"]) ? Usage.fromJSON(d["usage"]) : undefined,
      providerData: d["provider_data"],
    });
  },
  toJSON(r: SpeechGenerationResponse): JsonObject {
    return omitEmpty({
      audio: Part.toJSON(r.audio),
      id: r.id,
      model: r.model,
      usage: r.usage && !isEmptyUsage(r.usage) ? Usage.toJSON(r.usage) : undefined,
      provider_data: r.providerData,
    });
  },
};

// ─── Video ───────────────────────────────────────────────────────────

export interface VideoGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly seconds?: number;
  readonly images?: readonly ImagePart[];
  readonly extensions?: JsonObject;
}

export const normalizeVideoGenerationRequest = canonicalFactory("video_generation_request", normalizeVideoGenerationRequestValue);
function normalizeVideoGenerationRequestValue(input: unknown): VideoGenerationRequest {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a VideoGenerationRequest");
  const d = input as Record<string, unknown>;
  const seconds = d["seconds"];
  if (!absent(seconds) && (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0)) {
    throw new ValueError("VideoGenerationRequest.seconds must be a positive int");
  }
  const images = imageParts(d["images"], "VideoGenerationRequest");
  return frozen(
    compact({
      model: requireModel(d["model"]),
      prompt: requirePrompt(d["prompt"]),
      seconds: absent(seconds) ? undefined : (seconds as number),
      images: images.length > 0 ? images : undefined,
      extensions: extensionsField(d["extensions"]),
    }),
  );
}

export const VideoGenerationRequest = {
  create: normalizeVideoGenerationRequest,
  fromJSON(d: JsonObject): VideoGenerationRequest {
    const images = d["images"] ?? [];
    if (!Array.isArray(images)) throw new TypeError("images must be a list");
    return normalizeVideoGenerationRequest({
      model: d["model"],
      prompt: d["prompt"],
      seconds: typeof d["seconds"] === "object" && d["seconds"] !== null ? Number(d["seconds"].valueOf()) : d["seconds"],
      images: images.map((x) => Part.fromJSON(x as JsonObject)),
      extensions: d["extensions"],
    });
  },
  toJSON(r: VideoGenerationRequest): JsonObject {
    return omitEmpty({
      model: r.model,
      prompt: r.prompt,
      seconds: r.seconds,
      images: (r.images ?? []).map(Part.toJSON),
      extensions: r.extensions,
    });
  },
};

export interface VideoJobInfo {
  readonly id: string;
  readonly status: VideoStatus;
  /** 0–100 when reported. */
  readonly progress?: number;
  readonly createdAt?: string;
  readonly model?: string;
  readonly providerData?: JsonObject;
}

export const normalizeVideoJobInfo = canonicalFactory("video_job", normalizeVideoJobInfoValue);
function normalizeVideoJobInfoValue(input: unknown): VideoJobInfo {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a VideoJobInfo");
  const d = input as Record<string, unknown>;
  const progress = d["progress"];
  if (!absent(progress) && (typeof progress !== "number" || !Number.isInteger(progress) || progress < 0 || progress > 100)) {
    throw new ValueError("VideoJobInfo.progress must be an int percentage 0-100");
  }
  return frozen(
    compact({
      id: requireString(d["id"], "VideoJobInfo.id", false),
      status: requireOneOf(VIDEO_STATUSES, d["status"], "video status"),
      progress: absent(progress) ? undefined : (progress as number),
      createdAt: optionalString(d["createdAt"], "VideoJobInfo.created_at", false),
      model: optionalString(d["model"], "VideoJobInfo.model", false),
      providerData: optionalJsonObject(d["providerData"], "provider_data"),
    }),
  );
}

export const VideoJobInfo = {
  create: normalizeVideoJobInfo,
  done(j: VideoJobInfo): boolean {
    return (VIDEO_TERMINAL_STATUSES as readonly string[]).includes(j.status);
  },
  fromJSON(d: JsonObject): VideoJobInfo {
    return normalizeVideoJobInfo({
      id: d["id"],
      status: d["status"],
      progress: typeof d["progress"] === "object" && d["progress"] !== null ? Number(d["progress"].valueOf()) : d["progress"],
      createdAt: d["created_at"],
      model: d["model"],
      providerData: d["provider_data"],
    });
  },
  toJSON(j: VideoJobInfo): JsonObject {
    return omitEmpty({
      id: j.id,
      status: j.status,
      progress: j.progress,
      created_at: j.createdAt,
      model: j.model,
      provider_data: j.providerData,
    });
  },
};

export type { PromptPart, Tool };
