/**
 * Parts, continuation state, and Message (spec/types.md § Parts, § Messages).
 *
 * `Part` is a closed discriminated union on `type`. Each variant is a plain
 * readonly object; the factories (`text()`, `image()`, `toolCall()`, …) and
 * `Message.user()` etc. validate the invariants and return frozen values.
 * `Part.fromJSON` / `Part.toJSON` are the canonical serde; the JSON keys are
 * the wire contract (snake_case), the identifiers follow TypeScript.
 */

import { canonicalFactory } from "../canonical.ts";
import { float, isJsonObject, isStrictJson, omitEmpty, type JsonObject, type JsonValue } from "../json.ts";
import { IMAGE_DETAILS, JUDGMENT_METHODS, ROLES, type ImageDetail, type JudgmentMethod, type Role } from "../vocab.ts";
import {
  ValueError,
  absent,
  compact,
  encodeBase64,
  frozen,
  optionalOneOf,
  optionalString,
  requireBool,
  requireJsonObject,
  requireString,
  validateBase64,
  requireFloat,
} from "./validate.ts";

// ─── Continuation state ──────────────────────────────────────────────

/** Opaque provider-owned state needed to continue/replay a transcript. */
export interface ContinuationState {
  /** The dialect that consumes the state (`openai`, `anthropic`, `gemini`, `xai`), never the door (MAP-7.8). */
  readonly provider: string;
  /** Open namespace, non-empty. */
  readonly kind: string;
  readonly data: JsonObject;
}

export function continuationState(provider: string, kind: string, data: JsonObject = {}): ContinuationState {
  return normalizeContinuationState({ provider, kind, data });
}

export const normalizeContinuationState = canonicalFactory("continuation_state", normalizeContinuationStateValue);
function normalizeContinuationStateValue(input: unknown): ContinuationState {
  if (!isJsonObject(input) && !(typeof input === "object" && input !== null)) {
    throw new TypeError("continuation must contain ContinuationState objects");
  }
  const d = input as Record<string, unknown>;
  return frozen({
    provider: requireString(d["provider"], "ContinuationState.provider", false),
    kind: requireString(d["kind"], "ContinuationState.kind", false),
    data: requireJsonObject(d["data"] ?? {}, "data"),
  });
}

/** INV-005: `undefined` → `[]`, a single state → `[state]`, a list → a copy. */
export function normalizeContinuation(value: unknown, field = "continuation"): readonly ContinuationState[] {
  if (absent(value)) return EMPTY;
  if (typeof value === "string") throw new TypeError(`${field} must contain ContinuationState objects`);
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return EMPTY;
  return Object.freeze(items.map((item) => normalizeContinuationState(item)));
}

const EMPTY: readonly ContinuationState[] = Object.freeze([]);

export const ContinuationState = {
  fromJSON(d: JsonObject): ContinuationState {
    return normalizeContinuationState({ provider: d["provider"], kind: d["kind"], data: d["data"] ?? {} });
  },
  toJSON(state: ContinuationState): JsonObject {
    return { provider: state.provider, kind: state.kind, data: state.data };
  },
};

function continuationToJson(states: readonly ContinuationState[] | undefined): JsonObject[] | undefined {
  if (!states || states.length === 0) return undefined;
  return states.map(ContinuationState.toJSON);
}

function continuationFromJson(value: JsonValue | undefined): readonly ContinuationState[] {
  if (absent(value)) return EMPTY;
  if (!Array.isArray(value)) throw new TypeError("continuation must be a list");
  return Object.freeze(
    value.map((item) => {
      if (!isJsonObject(item)) throw new TypeError("continuation entries must be objects");
      return ContinuationState.fromJSON(item);
    }),
  );
}

/** The first matching state's data on a Message, Part, or state list. */
export function continuationData(
  value: Message | Part | readonly ContinuationState[],
  provider: string,
  kind: string,
): JsonObject | undefined {
  const states = Array.isArray(value) ? (value as readonly ContinuationState[]) : ((value as Part).continuation ?? EMPTY);
  for (const state of states) if (state.provider === provider && state.kind === kind) return state.data;
  return undefined;
}

// ─── Parts ───────────────────────────────────────────────────────────

interface WithContinuation {
  readonly continuation?: readonly ContinuationState[];
}

export interface TextPart extends WithContinuation {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingPart extends WithContinuation {
  readonly type: "thinking";
  /** Empty for hidden thinking (MAP-7 rule 11); the replay state rides in `continuation`. */
  readonly text: string;
}

export interface RefusalPart extends WithContinuation {
  readonly type: "refusal";
  readonly text: string;
}

export interface CitationPart extends WithContinuation {
  readonly type: "citation";
  readonly url?: string;
  readonly title?: string;
  readonly text?: string;
}

/**
 * Structured data as content (changes/2026-09-17-judgments.md, D2). In a
 * user/system message: structured input (`value` alone, INV-052). In an
 * assistant message: the answer to a json_schema request that declares
 * judgments (MAP-14) — `value` the model's JSON, `probabilities` one
 * distribution per judgment over its declared keys when measured, `method`
 * how. `value` is opaque and verbatim (INV-002); `null` is a value.
 */
export interface DataPart extends WithContinuation {
  readonly type: "data";
  readonly value: JsonValue;
  readonly probabilities?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly method?: JudgmentMethod;
}

/** Shared by the five media parts: exactly one of `data`/`url`/`fileId`/`path` (INV-011). */
interface MediaFields extends WithContinuation {
  /** Defaults per part kind; always emitted. */
  readonly mediaType?: string;
  /** Base64 (a data URI is accepted and stripped to its payload). */
  readonly data?: string;
  readonly url?: string;
  readonly fileId?: string;
  /** A local path; serialized as a string. */
  readonly path?: string;
}

export interface ImagePart extends MediaFields {
  readonly type: "image";
  readonly detail?: ImageDetail;
}
export interface AudioPart extends MediaFields {
  readonly type: "audio";
}
export interface VideoPart extends MediaFields {
  readonly type: "video";
}
export interface DocumentPart extends MediaFields {
  readonly type: "document";
}
export interface BinaryPart extends MediaFields {
  readonly type: "binary";
}

export interface ToolCallPart extends WithContinuation {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  /** Opaque, always emitted (even `{}`). Named `input` everywhere, never `arguments`. */
  readonly input: JsonObject;
}

export interface ToolResultPart extends WithContinuation {
  readonly type: "tool_result";
  readonly id: string;
  /** Presentational parts only, non-empty (INV-013, INV-014). */
  readonly content: readonly ToolResultContentPart[];
  readonly name?: string;
  readonly isError?: boolean;
}

export type MediaPart = ImagePart | AudioPart | VideoPart | DocumentPart | BinaryPart;
export type Part =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | DocumentPart
  | BinaryPart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart
  | RefusalPart
  | CitationPart
  | DataPart;

export type ToolResultContentPart = TextPart | MediaPart | CitationPart | DataPart;
export type PromptPart = TextPart | MediaPart | DataPart;
export type AssistantPart = Exclude<Part, ToolResultPart>;

/** What a factory accepts as content: a string, a part, or a list of either (INV-021). */
export type PartInput<P extends Part = Part> = string | P | ReadonlyArray<string | P>;

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "binary"]);
const PART_TYPE_SET = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "binary",
  "tool_call",
  "tool_result",
  "thinking",
  "refusal",
  "citation",
  "data",
]);
const TOOL_RESULT_FORBIDDEN = new Set(["tool_call", "tool_result", "thinking", "refusal"]);
const PROMPT_FORBIDDEN = new Set(["tool_call", "tool_result", "thinking", "refusal", "citation"]);

export const DEFAULT_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
  document: "application/pdf",
  binary: "application/octet-stream",
});

const PART_CLASS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  text: "TextPart",
  image: "ImagePart",
  audio: "AudioPart",
  video: "VideoPart",
  document: "DocumentPart",
  binary: "BinaryPart",
  tool_call: "ToolCallPart",
  tool_result: "ToolResultPart",
  thinking: "ThinkingPart",
  refusal: "RefusalPart",
  citation: "CitationPart",
  data: "DataPart",
});

export function isPart(value: unknown): value is Part {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    PART_TYPE_SET.has((value as { type: string }).type)
  );
}

export function isMediaPart(part: Part): part is MediaPart {
  return MEDIA_TYPES.has(part.type);
}

/**
 * The validating constructor for every Part variant. Accepts a plain object
 * with a `type` discriminator and camelCase fields; returns a frozen Part
 * with the invariants checked and defaults filled.
 */
export const normalizePart = canonicalFactory("part", normalizePartValue);
function normalizePartValue(input: unknown): Part {
  if (!isPart(input)) {
    const t = typeof input === "object" && input !== null ? (input as { type?: unknown }).type : undefined;
    if (typeof t === "string") throw new ValueError(`unsupported part type: ${t}`);
    throw new TypeError("expected a Part object with a type discriminator");
  }
  const d = input as unknown as Record<string, unknown>;
  const continuation = normalizeContinuation(d["continuation"]);
  const cont = continuation.length > 0 ? { continuation } : {};
  const name = PART_CLASS_NAMES[input.type] ?? "Part";
  switch (input.type) {
    case "text":
    case "thinking":
      return frozen({ type: input.type, text: requireString(d["text"], `${name}.text`), ...cont });
    case "refusal":
      return frozen({ type: "refusal", text: requireString(d["text"], "RefusalPart.text", false), ...cont });
    case "citation": {
      const part = compact({
        type: "citation" as const,
        url: optionalString(d["url"], "CitationPart.url", false),
        title: optionalString(d["title"], "CitationPart.title", false),
        text: optionalString(d["text"], "CitationPart.text", false),
        ...cont,
      });
      if (part.url === undefined && part.title === undefined && part.text === undefined) {
        throw new ValueError("CitationPart requires at least one of url, title, or text");
      }
      return frozen(part);
    }
    case "data": {
      if (!("value" in d)) throw new ValueError("DataPart.value is required (null is a value; absence is not)");
      const value = d["value"];
      if (!isStrictJson(value)) throw new TypeError("DataPart.value must be a JSON-compatible value");
      const probabilities = normalizeProbabilities(d["probabilities"]);
      const method = optionalOneOf(JUDGMENT_METHODS, d["method"], "DataPart.method");
      if ((method === undefined) !== (probabilities === undefined)) {
        throw new ValueError("DataPart.method is present iff DataPart.probabilities is (INV-052)");
      }
      return frozen(compact({ type: "data" as const, value: value as JsonValue, probabilities, method, ...cont }));
    }
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary": {
      const media = normalizeMedia(input.type, d, name);
      if (input.type === "image") {
        const detail = optionalOneOf(IMAGE_DETAILS, d["detail"], "ImagePart.detail");
        return frozen(compact({ ...media, type: "image" as const, detail, ...cont }));
      }
      return frozen(compact({ ...media, type: input.type, ...cont }));
    }
    case "tool_call":
      return frozen({
        type: "tool_call",
        id: requireString(d["id"], "ToolCallPart.id", false),
        name: requireString(d["name"], "ToolCallPart.name", false),
        input: requireJsonObject(d["input"], "input"),
        ...cont,
      });
    case "tool_result": {
      const rawContent = d["content"];
      if (!Array.isArray(rawContent)) throw new TypeError("ToolResultPart.content must contain Part objects");
      if (rawContent.length === 0) throw new ValueError("ToolResultPart requires content");
      const content = rawContent.map((p) => {
        if (!isPart(p)) throw new TypeError("ToolResultPart.content must contain Part objects");
        const part = normalizePart(p);
        if (TOOL_RESULT_FORBIDDEN.has(part.type)) {
          throw new TypeError(
            "ToolResultPart.content cannot contain tool calls, nested tool results, thinking parts, or refusals",
          );
        }
        validateInputDataParts("tool results", [part]);
        return part as ToolResultContentPart;
      });
      const isError = absent(d["isError"]) ? false : requireBool(d["isError"], "ToolResultPart.is_error");
      return frozen(
        compact({
          type: "tool_result" as const,
          id: requireString(d["id"], "ToolResultPart.id", false),
          content: Object.freeze(content),
          name: optionalString(d["name"], "ToolResultPart.name", false),
          isError: isError ? true : undefined,
          ...cont,
        }),
      );
    }
  }
}

function normalizeMedia(type: MediaPart["type"], d: Record<string, unknown>, name: string): Omit<MediaFields, "continuation"> & { mediaType: string } {
  const mediaType = absent(d["mediaType"]) ? DEFAULT_MEDIA_TYPES[type]! : d["mediaType"];
  if (typeof mediaType !== "string" || mediaType === "") throw new ValueError(`${name} requires media_type`);
  const data = d["data"];
  const url = d["url"];
  const fileId = d["fileId"];
  let path = d["path"];
  if (!absent(path)) {
    if (typeof path !== "string") throw new TypeError(`${name} path must be a string`);
    if (path === "") throw new ValueError(`${name} path cannot be empty`);
  } else path = undefined;
  const count = [data, url, fileId, path].filter((v) => !absent(v)).length;
  if (count !== 1) throw new ValueError(`${name} requires exactly one of data, url, file_id, or path`);
  for (const [field, value] of [
    ["data", data],
    ["url", url],
    ["file_id", fileId],
  ] as const) {
    if (absent(value)) continue;
    if (typeof value !== "string") throw new TypeError(`${name} ${field} must be a string`);
    if (value === "") throw new ValueError(`${name} ${field} cannot be empty`);
  }
  if (!absent(data)) validateBase64(name, data);
  return compact({
    mediaType,
    data: absent(data) ? undefined : (data as string),
    url: absent(url) ? undefined : (url as string),
    fileId: absent(fileId) ? undefined : (fileId as string),
    path: path as string | undefined,
  });
}

// ─── Factories ───────────────────────────────────────────────────────

export interface ContinuationOption {
  readonly continuation?: readonly ContinuationState[] | ContinuationState;
}

export function text(content: string, opts: ContinuationOption = {}): TextPart {
  return normalizePart({ type: "text", text: content, continuation: opts.continuation }) as TextPart;
}

/** Structured input or an assistant's measured answer; opaque value is never copied. */
export function data(value: JsonValue, opts: ContinuationOption & Pick<DataPart, "probabilities" | "method"> = {}): DataPart {
  return normalizePart({ type: "data", value, ...opts }) as DataPart;
}

export function thinking(content: string, opts: ContinuationOption = {}): ThinkingPart {
  return normalizePart({ type: "thinking", text: content, continuation: opts.continuation }) as ThinkingPart;
}

export function refusal(content: string, opts: ContinuationOption = {}): RefusalPart {
  return normalizePart({ type: "refusal", text: content, continuation: opts.continuation }) as RefusalPart;
}

export function citation(opts: { url?: string; title?: string; text?: string } & ContinuationOption): CitationPart {
  return normalizePart({ type: "citation", ...opts }) as CitationPart;
}

export interface MediaOptions extends ContinuationOption {
  readonly url?: string;
  /** Raw bytes (base64-encoded for you) or a base64 string / data URI. */
  readonly data?: Uint8Array | ArrayBuffer | string;
  readonly path?: string;
  readonly fileId?: string;
  /** Inferred from `path` when omitted; falls back to the part kind's default. */
  readonly mediaType?: string;
}

function mediaFactory<T extends MediaPart>(type: T["type"], opts: MediaOptions & { detail?: ImageDetail }): T {
  const count = [opts.data, opts.url, opts.fileId, opts.path].filter((v) => !absent(v)).length;
  if (count !== 1) throw new ValueError(`${PART_CLASS_NAMES[type]} requires exactly one of data, url, file_id, or path`);
  let mediaType = opts.mediaType;
  if (opts.path !== undefined) {
    if (opts.path === "") throw new ValueError(`${PART_CLASS_NAMES[type]} path cannot be empty`);
    mediaType = mediaType || guessMediaType(opts.path);
  }
  const data = typeof opts.data === "string" || opts.data === undefined ? opts.data : encodeBase64(opts.data);
  return normalizePart({
    type,
    mediaType: mediaType || DEFAULT_MEDIA_TYPES[type],
    data,
    url: opts.url,
    fileId: opts.fileId,
    path: opts.path,
    detail: opts.detail,
    continuation: opts.continuation,
  }) as T;
}

export function image(opts: MediaOptions & { detail?: ImageDetail }): ImagePart {
  return mediaFactory<ImagePart>("image", opts);
}
export function audio(opts: MediaOptions): AudioPart {
  return mediaFactory<AudioPart>("audio", opts);
}
export function video(opts: MediaOptions): VideoPart {
  return mediaFactory<VideoPart>("video", opts);
}
export function document(opts: MediaOptions): DocumentPart {
  return mediaFactory<DocumentPart>("document", opts);
}
export function binary(opts: MediaOptions): BinaryPart {
  return mediaFactory<BinaryPart>("binary", opts);
}

export function toolCall(id: string, name: string, input: JsonObject, opts: ContinuationOption = {}): ToolCallPart {
  return normalizePart({ type: "tool_call", id, name, input, continuation: opts.continuation }) as ToolCallPart;
}

export interface ToolResultOptions extends ContinuationOption {
  readonly name?: string;
  readonly isError?: boolean;
}

/** `content` accepts a string, a single part, or a list (INV-021). */
export function toolResult(id: string, content: PartInput<ToolResultContentPart>, opts: ToolResultOptions = {}): ToolResultPart {
  return normalizePart({
    type: "tool_result",
    id,
    content: normalizeParts(content),
    name: opts.name,
    isError: opts.isError,
    continuation: opts.continuation,
  }) as ToolResultPart;
}

/** INV-021: a string → one TextPart; a part → [part]; a list of strings/parts; empty rejected. */
export function normalizeParts(content: PartInput): Part[] {
  if (typeof content === "string") return [text(content)];
  if (isPart(content)) return [normalizePart(content)];
  if (Array.isArray(content)) {
    if (content.length === 0) throw new ValueError("content sequence cannot be empty");
    return content.map((item) => {
      if (typeof item === "string") return text(item);
      if (isPart(item)) return normalizePart(item);
      throw new TypeError("content sequence must contain strings or Part objects");
    });
  }
  throw new TypeError("content must be a string, Part, or sequence of Parts");
}

const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  wav: "audio/x-wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mpeg: "video/mpeg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
});

export function guessMediaType(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? MIME_BY_EXT[m[1]!.toLowerCase()] : undefined;
}

// ─── Part serde ──────────────────────────────────────────────────────

function partToJSON(part: Part): JsonObject {
  const out: JsonObject = { type: part.type };
  switch (part.type) {
    case "text":
    case "thinking":
    case "refusal":
      out["text"] = part.text;
      break;
    case "citation":
      if (part.text !== undefined) out["text"] = part.text;
      if (part.url !== undefined) out["url"] = part.url;
      if (part.title !== undefined) out["title"] = part.title;
      break;
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary":
      out["media_type"] = part.mediaType ?? DEFAULT_MEDIA_TYPES[part.type]!;
      if (part.data !== undefined) out["data"] = part.data;
      if (part.url !== undefined) out["url"] = part.url;
      if (part.fileId !== undefined) out["file_id"] = part.fileId;
      if (part.path !== undefined) out["path"] = part.path;
      if (part.type === "image" && part.detail !== undefined) out["detail"] = part.detail;
      break;
    case "tool_call":
      out["id"] = part.id;
      out["name"] = part.name;
      out["input"] = part.input;
      break;
    case "tool_result":
      out["id"] = part.id;
      if (part.name !== undefined) out["name"] = part.name;
      out["content"] = part.content.map(partToJSON);
      if (part.isError) out["is_error"] = true;
      break;
    case "data":
      out["value"] = part.value; // opaque, always emitted (null is a value)
      if (part.probabilities !== undefined) {
        // canonical data, not an opaque payload: floats stay JSON floats (Number rule)
        out["probabilities"] = Object.fromEntries(
          Object.entries(part.probabilities).map(([name, dist]) => [name, Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, float(v)]))]),
        );
      }
      if (part.method !== undefined) out["method"] = part.method;
      break;
  }
  const continuation = continuationToJson(part.continuation);
  if (continuation) out["continuation"] = continuation;
  return out;
}

/** INV-040/041/044/045: the read-side leniencies, exactly the reference's. */
function partFromJSON(d: JsonObject): Part {
  const t = d["type"];
  if (typeof t !== "string") throw new ValueError(`unsupported part type: ${String(t)}`);
  const continuation = continuationFromJson(d["continuation"]);
  switch (t) {
    case "text":
    case "thinking":
    case "refusal":
      return normalizePart({ type: t, text: d["text"] ?? "", continuation });
    case "citation":
      return normalizePart({ type: t, text: d["text"], url: d["url"], title: d["title"], continuation });
    case "image":
    case "audio":
    case "video":
    case "document":
    case "binary":
      return normalizePart({
        type: t,
        mediaType: d["media_type"] ?? "",
        data: d["data"],
        url: d["url"],
        fileId: d["file_id"],
        path: d["path"],
        detail: t === "image" ? d["detail"] : undefined,
        continuation,
      });
    case "tool_call":
      return normalizePart({ type: t, id: d["id"], name: d["name"], input: d["input"] ?? {}, continuation });
    case "tool_result": {
      const raw = d["content"] ?? [];
      let content: Part[];
      if (typeof raw === "string") content = raw ? [text(raw)] : [];
      else if (Array.isArray(raw)) content = raw.map((c) => (isJsonObject(c) ? partFromJSON(c) : text(String(c))));
      else content = [];
      return normalizePart({
        type: t,
        id: d["id"],
        content,
        name: d["name"],
        isError: d["is_error"] ?? false,
        continuation,
      });
    }
    case "data":
      if (!("value" in d)) throw new ValueError("data part requires 'value' (null is a value; absence is not)");
      return normalizePart({ type: t, value: d["value"], probabilities: d["probabilities"], method: d["method"], continuation });
    default:
      throw new ValueError(`unsupported part type: ${t}`);
  }
}

export const Part = {
  /** The validating constructor: a plain object → a frozen Part. */
  create: normalizePart,
  is: isPart,
  fromJSON: partFromJSON,
  toJSON: partToJSON,
};

// ─── Message ─────────────────────────────────────────────────────────

export interface Message {
  readonly role: Role;
  readonly parts: readonly Part[];
  readonly continuation?: readonly ContinuationState[];
}

export type PromptContent = PartInput<PromptPart>;
export type AssistantContent = PartInput<AssistantPart>;

/** INV-052: `{field: {key: probability}}`, inner maps non-empty, probabilities in [0, 1]. */
function normalizeProbabilities(raw: unknown): Readonly<Record<string, Readonly<Record<string, number>>>> | undefined {
  if (absent(raw)) return undefined;
  if (!isJsonObject(raw) || Object.keys(raw).length === 0) {
    throw new TypeError("DataPart.probabilities must be a non-empty mapping of field -> {key: probability}");
  }
  const out: Record<string, Readonly<Record<string, number>>> = {};
  for (const [name, dist] of Object.entries(raw)) {
    if (!name) throw new TypeError("DataPart.probabilities keys must be non-empty strings");
    if (!isJsonObject(dist) || Object.keys(dist).length === 0) {
      throw new TypeError(`DataPart.probabilities[${JSON.stringify(name)}] must be a non-empty mapping of key -> probability`);
    }
    const inner: Record<string, number> = {};
    for (const [key, prob] of Object.entries(dist)) {
      if (!key) throw new TypeError(`DataPart.probabilities[${JSON.stringify(name)}] keys must be non-empty strings`);
      const n = requireFloat(prob, `DataPart.probabilities[${JSON.stringify(name)}][${JSON.stringify(key)}]`);
      if (n < 0 || n > 1) throw new ValueError(`DataPart.probabilities[${JSON.stringify(name)}][${JSON.stringify(key)}] must be in [0, 1]`);
      Object.defineProperty(inner, key, { value: n, enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(out, name, { value: Object.freeze(inner), enumerable: true, configurable: true, writable: true });
  }
  return Object.freeze(out);
}

function validateInputDataParts(where: string, parts: readonly Part[]): void {
  for (const p of parts) {
    if (p.type === "data" && p.probabilities !== undefined) {
      throw new TypeError(`${where} data parts carry value only; probabilities belong to assistant messages (INV-052)`);
    }
  }
}

function validateMessageParts(role: Role, parts: readonly Part[]): void {
  if (role === "tool") {
    if (!parts.every((p) => p.type === "tool_result")) throw new TypeError("tool messages may only contain ToolResultPart objects");
    return;
  }
  if (role === "assistant") {
    if (parts.some((p) => p.type === "tool_result")) throw new TypeError("assistant messages cannot contain ToolResultPart objects");
    return;
  }
  if (parts.some((p) => PROMPT_FORBIDDEN.has(p.type))) {
    throw new TypeError(`${role} messages cannot contain model/tool protocol parts`);
  }
  validateInputDataParts(role, parts);
}

/** The validating constructor for Message (INV-020, INV-022..024). */
export const normalizeMessage = canonicalFactory("message", normalizeMessageValue);
function normalizeMessageValue(input: unknown): Message {
  if (typeof input !== "object" || input === null) throw new TypeError("expected a Message object");
  const d = input as Record<string, unknown>;
  const role = d["role"];
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    throw new ValueError(`unsupported role: ${String(role)}`);
  }
  const rawParts = d["parts"];
  if (typeof rawParts === "string") {
    throw new TypeError("Message.parts must be Part objects; use Message.user('text') for strings");
  }
  const list = isPart(rawParts) ? [rawParts] : rawParts;
  if (!Array.isArray(list)) throw new TypeError("Message.parts must contain Part objects");
  if (list.length === 0) throw new ValueError("Message requires at least one part");
  const parts = Object.freeze(
    list.map((p) => {
      if (!isPart(p)) throw new TypeError("Message.parts must contain Part objects");
      return normalizePart(p);
    }),
  );
  const continuation = normalizeContinuation(d["continuation"]);
  validateMessageParts(role as Role, parts);
  return frozen(compact({ role: role as Role, parts, continuation: continuation.length > 0 ? continuation : undefined }));
}

export type ToolResultsInput =
  | ToolResultPart
  | readonly ToolResultPart[]
  | Readonly<Record<string, PartInput<ToolResultContentPart>>>;

function messageToJSON(message: Message): JsonObject {
  const out: JsonObject = { role: message.role, parts: message.parts.map(partToJSON) };
  const continuation = continuationToJson(message.continuation);
  if (continuation) out["continuation"] = continuation;
  return out;
}

function messageFromJSON(d: JsonObject): Message {
  const role = d["role"];
  const raw = d["parts"] ?? [];
  const parts = Array.isArray(raw) ? raw.map((p) => (isJsonObject(p) ? partFromJSON(p) : text(String(p)))) : [];
  if (parts.length === 0) throw new ValueError(`message for role '${String(role)}' has no parts`);
  return normalizeMessage({ role, parts, continuation: continuationFromJson(d["continuation"]) });
}

export const Message = {
  create: normalizeMessage,

  user(content: PromptContent): Message {
    return normalizeMessage({ role: "user", parts: normalizeParts(content) });
  },

  /** High-authority instructions; native on OpenAI, a prefixed user message elsewhere. */
  developer(content: PromptContent): Message {
    return normalizeMessage({ role: "developer", parts: normalizeParts(content) });
  },

  assistant(content: AssistantContent): Message {
    return normalizeMessage({ role: "assistant", parts: normalizeParts(content) });
  },

  /**
   * Three spellings: `Message.tool(callId, output, { isError })`,
   * `Message.tool({ [callId]: output, ... })`, or `Message.tool(part | parts)`.
   */
  tool(results: string | ToolResultsInput, output?: PartInput<ToolResultContentPart>, opts: { isError?: boolean } = {}): Message {
    if (typeof results === "string") {
      if (output === undefined) {
        throw new TypeError(
          "Message.tool(callId) is missing the output. Accepted spellings: Message.tool(callId, output, { isError }), Message.tool({ [callId]: output }), or Message.tool(toolResult(...)).",
        );
      }
      return normalizeMessage({ role: "tool", parts: [toolResult(results, output, { isError: opts.isError ?? false })] });
    }
    if (output !== undefined) {
      throw new TypeError("Message.tool() takes an output only with a call-id string: Message.tool(callId, output, { isError }).");
    }
    if (opts.isError) {
      throw new TypeError(
        "Message.tool({...}, { isError: true }) is ambiguous — the map form cannot say which result errored. Use Message.tool(callId, output, { isError: true }).",
      );
    }
    if (isPart(results)) {
      if (results.type !== "tool_result") throw new TypeError("Message.tool() requires ToolResultPart objects.");
      return normalizeMessage({ role: "tool", parts: [results] });
    }
    if (Array.isArray(results)) {
      if (!results.every((p) => isPart(p) && p.type === "tool_result")) {
        throw new TypeError("Message.tool() requires ToolResultPart objects.");
      }
      return normalizeMessage({ role: "tool", parts: results });
    }
    const parts = Object.entries(results as Record<string, PartInput<ToolResultContentPart>>).map(([id, value]) =>
      toolResult(id, value),
    );
    return normalizeMessage({ role: "tool", parts });
  },

  /** Text only when the message contains text and nothing else. */
  text(message: Message): string | undefined {
    if (!message.parts.every((p) => p.type === "text")) return undefined;
    return message.parts.map((p) => (p as TextPart).text).join("\n");
  },

  partsOf<T extends Part["type"]>(message: Message, type: T): Extract<Part, { type: T }>[] {
    return message.parts.filter((p): p is Extract<Part, { type: T }> => p.type === type);
  },

  first<T extends Part["type"]>(message: Message, type: T): Extract<Part, { type: T }> | undefined {
    return message.parts.find((p): p is Extract<Part, { type: T }> => p.type === type);
  },

  fromJSON: messageFromJSON,
  toJSON: messageToJSON,
};

/** `system` normalization (INV-021, INV-024): a non-empty string or prompt parts. */
export function normalizeSystem(system: unknown): string | readonly PromptPart[] | undefined {
  if (absent(system)) return undefined;
  if (typeof system === "string") {
    if (system === "") throw new ValueError("system cannot be empty");
    return system;
  }
  const parts = normalizeParts(system as PartInput);
  if (parts.some((p) => PROMPT_FORBIDDEN.has(p.type))) throw new TypeError("system parts cannot contain model/tool protocol parts");
  validateInputDataParts("system", parts);
  return Object.freeze(parts) as readonly PromptPart[];
}

export function systemToJSON(system: string | readonly PromptPart[] | undefined): JsonValue | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map(partToJSON);
}

export function systemFromJSON(value: JsonValue | undefined): string | Part[] | undefined {
  if (absent(value)) return undefined;
  if (Array.isArray(value)) {
    return value.map((x) => {
      if (!isJsonObject(x)) throw new TypeError("system parts must be objects");
      return partFromJSON(x);
    });
  }
  if (typeof value !== "string") throw new TypeError("system must be a string or a list of parts");
  return value;
}

export { omitEmpty };
