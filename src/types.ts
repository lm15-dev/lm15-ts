/**
 * lm15 canonical types (spec/types.md) and construction-time invariants
 * (spec/invariants.md, cited as INV-###).
 *
 * Canonical data is plain readonly objects discriminated on `type`;
 * construction goes through validating factory functions (the idiomatic
 * equivalent of the reference's frozen dataclasses' __post_init__).
 * Numbers follow the Number rule (docs/serde-rules.md): int-typed fields
 * store integral JS numbers; float-typed fields store JS numbers and are
 * wrapped as CFloat by the serializer. Opaque payloads (JsonObject) are
 * stored verbatim, never copied or mutated (INV-002).
 */

import { CFloat, isJsonObject, type JsonObject, type JsonValue } from "./canonical-json.js";
import { TypeErrorEx, ValueError } from "./errors.js";

export type { ErrorCode } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { ERROR_CODES } from "./errors.js";

// ─── Vocabularies (spec/vocabularies.md; closed — INV-037, INV-044) ──

export type Role = "user" | "assistant" | "tool" | "developer";
export const ROLE_VALUES: readonly Role[] = ["user", "assistant", "tool", "developer"];

export type PartType =
  | "text" | "image" | "audio" | "video" | "document" | "binary"
  | "tool_call" | "tool_result" | "thinking" | "refusal" | "citation";
export const PART_TYPES: readonly PartType[] = [
  "text", "image", "audio", "video", "document", "binary",
  "tool_call", "tool_result", "thinking", "refusal", "citation",
];

export type DeltaType =
  | "text" | "thinking" | "audio" | "image" | "tool_call" | "citation" | "continuation";
export const DELTA_TYPES: readonly DeltaType[] = [
  "text", "thinking", "audio", "image", "tool_call", "citation", "continuation",
];

export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "error";
export const FINISH_REASONS: readonly FinishReason[] = [
  "stop", "length", "tool_call", "content_filter", "error",
];

export type ReasoningEffort =
  | "off" | "adaptive" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off", "adaptive", "minimal", "low", "medium", "high", "xhigh",
];

export type ReasoningSummary = "auto" | "concise" | "detailed";
export const REASONING_SUMMARIES: readonly ReasoningSummary[] = ["auto", "concise", "detailed"];

export type StreamEventType = "start" | "delta" | "end" | "error";
export const STREAM_EVENT_TYPES: readonly StreamEventType[] = ["start", "delta", "end", "error"];

export type BatchStatus =
  | "submitted" | "queued" | "running" | "completed" | "failed" | "cancelled";
export const BATCH_STATUSES: readonly BatchStatus[] = [
  "submitted", "queued", "running", "completed", "failed", "cancelled",
];

export type AudioEncoding = "pcm16" | "opus" | "mp3" | "aac";
export const AUDIO_ENCODINGS: readonly AudioEncoding[] = ["pcm16", "opus", "mp3", "aac"];

export type ToolChoiceMode = "auto" | "required" | "none";
export const TOOL_CHOICE_MODES: readonly ToolChoiceMode[] = ["auto", "required", "none"];

export type CacheMode = "auto" | "off";
export const CACHE_MODES: readonly CacheMode[] = ["auto", "off"];

export type CacheRetention = "short" | "long";
export const CACHE_RETENTIONS: readonly CacheRetention[] = ["short", "long"];

export type ImageDetail = "low" | "high" | "auto";
const IMAGE_DETAILS: readonly ImageDetail[] = ["low", "high", "auto"];

export type LiveClientEventType =
  | "turn" | "audio" | "image" | "text" | "tool_result" | "interrupt" | "end_audio";
export const LIVE_CLIENT_EVENT_TYPES: readonly LiveClientEventType[] = [
  "turn", "audio", "image", "text", "tool_result", "interrupt", "end_audio",
];

export type LiveServerEventType =
  | "audio" | "text" | "tool_call" | "tool_call_delta" | "interrupted" | "turn_end" | "error";
export const LIVE_SERVER_EVENT_TYPES: readonly LiveServerEventType[] = [
  "audio", "text", "tool_call", "tool_call_delta", "interrupted", "turn_end", "error",
];

export { ERROR_CODES };

// ─── Validation helpers ──────────────────────────────────────────────

function reqString(name: string, v: unknown, nonEmpty: boolean): string {
  if (typeof v !== "string") throw new ValueError(`${name} must be a string`);
  if (nonEmpty && v === "") throw new ValueError(`${name} must be non-empty`);
  return v;
}

function optString(name: string, v: unknown, nonEmpty = true): string | null {
  if (v === null || v === undefined) return null;
  return reqString(name, v, nonEmpty);
}

function reqBool(name: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw new ValueError(`${name} must be a boolean`);
  return v;
}

/** Number rule (INV-007): int fields coerce same-valued floats, reject the rest. */
function toInt(
  name: string,
  v: unknown,
  opts: { min?: number } = {},
): number {
  // INV-003: booleans never coerce (typeof boolean !== "number" in JS).
  let n: number;
  if (v instanceof CFloat) n = v.value;
  else if (typeof v === "number") n = v;
  else throw new ValueError(`${name} must be an integer`);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ValueError(`${name} must be an integer`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new ValueError(`${name} must be >= ${opts.min}`);
  }
  return n;
}

function toIntOrNull(name: string, v: unknown, opts: { min?: number } = {}): number | null {
  if (v === null || v === undefined) return null;
  return toInt(name, v, opts);
}

/** Number rule (INV-008): float fields coerce same-valued ints. */
function toFloatOrNull(
  name: string,
  v: unknown,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (v === null || v === undefined) return null;
  let n: number;
  if (v instanceof CFloat) n = v.value;
  else if (typeof v === "number") n = v;
  else throw new ValueError(`${name} must be a number`);
  if (!Number.isFinite(n)) throw new ValueError(`${name} must be finite`);
  if (opts.min !== undefined && n < opts.min) throw new ValueError(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new ValueError(`${name} must be <= ${opts.max}`);
  return n;
}

function checkVocab<T extends string>(name: string, v: unknown, vocab: readonly T[]): T {
  if (typeof v !== "string" || !(vocab as readonly string[]).includes(v)) {
    throw new ValueError(`unsupported ${name}: ${String(v)}`);
  }
  return v as T;
}

/** INV-001: strict JSON values only inside opaque payloads. */
function checkJsonValue(name: string, v: unknown): void {
  if (v === null || typeof v === "boolean" || typeof v === "string") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValueError(`${name} contains a non-finite number`);
    return;
  }
  if (v instanceof CFloat) {
    if (!Number.isFinite(v.value)) throw new ValueError(`${name} contains a non-finite number`);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) checkJsonValue(name, item);
    return;
  }
  if (typeof v === "object") {
    for (const value of Object.values(v as Record<string, unknown>)) {
      checkJsonValue(name, value);
    }
    return;
  }
  throw new ValueError(`${name} must contain only JSON values`);
}

/** Strict JSON object, stored verbatim (INV-001, INV-002). */
function checkOpaqueObject(name: string, v: unknown): JsonObject {
  if (!isJsonObject(v as JsonValue)) throw new TypeErrorEx(`${name} must be a JSON object`);
  checkJsonValue(name, v);
  return v as JsonObject;
}

function optOpaqueObject(name: string, v: unknown): JsonObject | null {
  if (v === null || v === undefined) return null;
  return checkOpaqueObject(name, v);
}

/** INV-004: empty `extensions` normalizes to absent. */
function normalizeExtensions(name: string, v: unknown): JsonObject | null {
  const obj = optOpaqueObject(name, v);
  if (obj !== null && Object.keys(obj).length === 0) return null;
  return obj;
}

/** INV-012: base64-shaped inline data; data-URI stripped, whitespace collapsed. */
function validateBase64Data(name: string, raw: string): string {
  let payload = raw;
  const dataUri = /^data:[^;,]*(;[^;,]*)*;base64,/.exec(payload);
  if (dataUri) payload = payload.slice(dataUri[0].length);
  payload = payload.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new ValueError(`${name} must be valid base64 data`);
  }
  return payload;
}

// ─── ContinuationState ───────────────────────────────────────────────

export interface ContinuationState {
  readonly provider: string;
  readonly kind: string;
  readonly data: JsonObject;
}

export function continuationState(fields: {
  provider: unknown;
  kind: unknown;
  data?: unknown;
}): ContinuationState {
  return {
    provider: reqString("ContinuationState.provider", fields.provider, true),
    kind: reqString("ContinuationState.kind", fields.kind, true),
    data: checkOpaqueObject("ContinuationState.data", fields.data ?? {}),
  };
}

/** INV-005: continuation normalization. */
function normalizeContinuation(v: unknown): readonly ContinuationState[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new ValueError("continuation entries must be ContinuationState objects");
      }
    }
    return v as ContinuationState[];
  }
  if (typeof v === "object") return [v as ContinuationState];
  throw new ValueError("continuation must be a ContinuationState or a sequence of them");
}

// ─── Parts ───────────────────────────────────────────────────────────

export interface TextPart {
  readonly type: "text";
  readonly text: string;
  readonly continuation: readonly ContinuationState[];
}

export interface ThinkingPart {
  readonly type: "thinking";
  readonly text: string;
  readonly redacted: boolean;
  readonly continuation: readonly ContinuationState[];
}

export interface RefusalPart {
  readonly type: "refusal";
  readonly text: string;
  readonly continuation: readonly ContinuationState[];
}

export interface CitationPart {
  readonly type: "citation";
  readonly url: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly continuation: readonly ContinuationState[];
}

export type MediaPartType = "image" | "audio" | "video" | "document" | "binary";

interface MediaFields {
  readonly media_type: string;
  readonly data: string | null;
  readonly url: string | null;
  readonly file_id: string | null;
  /** A local filesystem path; string in TypeScript, string on the wire (INV-009). */
  readonly path: string | null;
  readonly continuation: readonly ContinuationState[];
}

export interface ImagePart extends MediaFields {
  readonly type: "image";
  readonly detail: ImageDetail | null;
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

export type MediaPart = ImagePart | AudioPart | VideoPart | DocumentPart | BinaryPart;

export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly continuation: readonly ContinuationState[];
}

export interface ToolResultPart {
  readonly type: "tool_result";
  readonly id: string;
  readonly content: readonly Part[];
  readonly name: string | null;
  readonly is_error: boolean;
  readonly continuation: readonly ContinuationState[];
}

export type Part =
  | TextPart
  | ThinkingPart
  | RefusalPart
  | CitationPart
  | ImagePart
  | AudioPart
  | VideoPart
  | DocumentPart
  | BinaryPart
  | ToolCallPart
  | ToolResultPart;

export const DEFAULT_MEDIA_TYPES: Record<MediaPartType, string> = {
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
  document: "application/pdf",
  binary: "application/octet-stream",
};

export function textPart(fields: { text: unknown; continuation?: unknown }): TextPart {
  return {
    type: "text",
    text: reqString("TextPart.text", fields.text, false), // INV-015
    continuation: normalizeContinuation(fields.continuation),
  };
}

export function thinkingPart(fields: {
  text: unknown;
  redacted?: unknown;
  continuation?: unknown;
}): ThinkingPart {
  return {
    type: "thinking",
    text: reqString("ThinkingPart.text", fields.text, false), // INV-015
    redacted: reqBool("ThinkingPart.redacted", fields.redacted ?? false),
    continuation: normalizeContinuation(fields.continuation),
  };
}

export function refusalPart(fields: { text: unknown; continuation?: unknown }): RefusalPart {
  return {
    type: "refusal",
    text: reqString("RefusalPart.text", fields.text, true), // INV-016
    continuation: normalizeContinuation(fields.continuation),
  };
}

export function citationPart(fields: {
  url?: unknown;
  title?: unknown;
  text?: unknown;
  continuation?: unknown;
}): CitationPart {
  const url = optString("CitationPart.url", fields.url);
  const title = optString("CitationPart.title", fields.title);
  const text = optString("CitationPart.text", fields.text);
  if (url === null && title === null && text === null) {
    throw new ValueError("CitationPart requires at least one of url/title/text"); // INV-017
  }
  return { type: "citation", url, title, text, continuation: normalizeContinuation(fields.continuation) };
}

export function mediaPart(
  type: MediaPartType,
  fields: {
    media_type?: unknown;
    data?: unknown;
    url?: unknown;
    file_id?: unknown;
    path?: unknown;
    detail?: unknown;
    continuation?: unknown;
  },
): MediaPart {
  // Absent media_type takes the per-type default; an explicit null/"" is
  // rejected (INV-010 — matches the reference's from_dict behavior).
  const mediaType =
    fields.media_type === undefined
      ? DEFAULT_MEDIA_TYPES[type]
      : reqString(`${type}.media_type`, fields.media_type, true);
  let data = optString(`${type}.data`, fields.data);
  const url = optString(`${type}.url`, fields.url);
  const fileId = optString(`${type}.file_id`, fields.file_id);
  const path = optString(`${type}.path`, fields.path); // INV-009: empty rejected
  const sources = [data, url, fileId, path].filter((s) => s !== null);
  if (sources.length !== 1) {
    throw new ValueError(`${type} part requires exactly one of data/url/file_id/path`); // INV-011
  }
  if (data !== null) data = validateBase64Data(`${type}.data`, data); // INV-012
  const base: MediaFields = {
    media_type: mediaType,
    data,
    url,
    file_id: fileId,
    path,
    continuation: normalizeContinuation(fields.continuation),
  };
  if (type === "image") {
    const detail =
      fields.detail === null || fields.detail === undefined
        ? null
        : checkVocab("image detail", fields.detail, IMAGE_DETAILS);
    return { type: "image", ...base, detail };
  }
  if (fields.detail !== null && fields.detail !== undefined) {
    throw new ValueError(`${type} part does not accept detail`);
  }
  return { type, ...base };
}

export function toolCallPart(fields: {
  id: unknown;
  name: unknown;
  input: unknown;
  continuation?: unknown;
}): ToolCallPart {
  return {
    type: "tool_call",
    id: reqString("ToolCallPart.id", fields.id, true),
    name: reqString("ToolCallPart.name", fields.name, true),
    input: checkOpaqueObject("ToolCallPart.input", fields.input),
    continuation: normalizeContinuation(fields.continuation),
  };
}

const NON_PRESENTATIONAL: ReadonlySet<string> = new Set([
  "tool_call", "tool_result", "thinking", "refusal",
]);

function checkPresentational(name: string, parts: readonly Part[]): void {
  for (const part of parts) {
    if (NON_PRESENTATIONAL.has(part.type)) {
      throw new ValueError(`${name} may contain presentational parts only, got ${part.type}`); // INV-013
    }
  }
}

export function toolResultPart(fields: {
  id: unknown;
  content: readonly Part[];
  name?: unknown;
  is_error?: unknown;
  continuation?: unknown;
}): ToolResultPart {
  if (fields.content.length === 0) {
    throw new ValueError("ToolResultPart.content must be non-empty"); // INV-014
  }
  checkPresentational("ToolResultPart.content", fields.content);
  return {
    type: "tool_result",
    id: reqString("ToolResultPart.id", fields.id, true),
    content: fields.content,
    name: optString("ToolResultPart.name", fields.name),
    is_error: reqBool("ToolResultPart.is_error", fields.is_error ?? false),
    continuation: normalizeContinuation(fields.continuation),
  };
}

// ─── Message ─────────────────────────────────────────────────────────

export interface Message {
  readonly role: Role;
  readonly parts: readonly Part[];
  readonly continuation: readonly ContinuationState[];
}

const PROTOCOL_PARTS: ReadonlySet<string> = new Set([
  "tool_call", "tool_result", "thinking", "refusal", "citation",
]);

export function message(fields: {
  role: unknown;
  parts: readonly Part[];
  continuation?: unknown;
}): Message {
  const role = checkVocab("role", fields.role, ROLE_VALUES); // INV-037
  if (fields.parts.length === 0) {
    throw new ValueError(`message for role '${role}' has no parts`);
  }
  for (const part of fields.parts) {
    if (role === "tool" && part.type !== "tool_result") {
      throw new ValueError("tool messages may contain only ToolResultPart"); // INV-022
    }
    if (role === "assistant" && part.type === "tool_result") {
      throw new ValueError("assistant messages may not contain ToolResultPart"); // INV-023
    }
    if ((role === "user" || role === "developer") && PROTOCOL_PARTS.has(part.type)) {
      throw new ValueError(`${role} messages may not contain ${part.type} parts`); // INV-024
    }
  }
  return { role, parts: fields.parts, continuation: normalizeContinuation(fields.continuation) };
}

// ─── Tools ───────────────────────────────────────────────────────────

export const DEFAULT_FUNCTION_PARAMETERS: JsonObject = { type: "object", properties: {} };

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string | null;
  /** Opaque JSON-Schema payload; required-with-shape (INV-033). */
  readonly parameters: JsonObject;
}

export interface BuiltinTool {
  readonly type: "builtin";
  readonly name: string;
  readonly config: JsonObject | null;
}

export type Tool = FunctionTool | BuiltinTool;

export function functionTool(fields: {
  name: unknown;
  description?: unknown;
  parameters?: unknown;
}): FunctionTool {
  return {
    type: "function",
    name: reqString("FunctionTool.name", fields.name, true),
    description: optString("FunctionTool.description", fields.description, false),
    parameters:
      fields.parameters === null || fields.parameters === undefined
        ? DEFAULT_FUNCTION_PARAMETERS
        : checkOpaqueObject("FunctionTool.parameters", fields.parameters),
  };
}

export function builtinTool(fields: { name: unknown; config?: unknown }): BuiltinTool {
  return {
    type: "builtin",
    name: reqString("BuiltinTool.name", fields.name, true),
    config: optOpaqueObject("BuiltinTool.config", fields.config),
  };
}

// ─── Configuration ───────────────────────────────────────────────────

export interface ToolChoice {
  readonly mode: ToolChoiceMode;
  readonly allowed: readonly string[];
  readonly parallel: boolean | null;
}

export function toolChoice(fields: {
  mode?: unknown;
  allowed?: unknown;
  parallel?: unknown;
}): ToolChoice {
  const mode = checkVocab("tool choice mode", fields.mode ?? "auto", TOOL_CHOICE_MODES);
  let allowed: readonly string[] = [];
  const rawAllowed = fields.allowed;
  if (typeof rawAllowed === "string") allowed = [rawAllowed]; // INV-020
  else if (Array.isArray(rawAllowed)) allowed = rawAllowed;
  else if (rawAllowed !== null && rawAllowed !== undefined) {
    throw new ValueError("ToolChoice.allowed must be a string or a list of strings");
  }
  for (const name of allowed) reqString("ToolChoice.allowed entry", name, true);
  const parallel =
    fields.parallel === null || fields.parallel === undefined
      ? null
      : reqBool("ToolChoice.parallel", fields.parallel);
  if (mode === "none" && (allowed.length > 0 || parallel !== null)) {
    throw new ValueError("ToolChoice(mode='none') cannot specify allowed or parallel"); // INV-028
  }
  return { mode, allowed, parallel };
}

export interface Reasoning {
  readonly effort: ReasoningEffort;
  readonly thinking_budget: number | null;
  readonly total_budget: number | null;
  readonly summary: ReasoningSummary | null;
}

export function reasoning(fields: {
  effort?: unknown;
  thinking_budget?: unknown;
  total_budget?: unknown;
  summary?: unknown;
}): Reasoning {
  const effort = checkVocab("reasoning effort", fields.effort ?? "off", REASONING_EFFORTS);
  const thinkingBudget = toIntOrNull("Reasoning.thinking_budget", fields.thinking_budget, { min: 1 });
  const totalBudget = toIntOrNull("Reasoning.total_budget", fields.total_budget, { min: 1 });
  const summary =
    fields.summary === null || fields.summary === undefined
      ? null
      : checkVocab("reasoning summary", fields.summary, REASONING_SUMMARIES);
  if (effort === "off" && (thinkingBudget !== null || totalBudget !== null || summary !== null)) {
    throw new ValueError(
      "Reasoning(effort='off') cannot specify thinking_budget, total_budget, or summary",
    ); // INV-026
  }
  return { effort, thinking_budget: thinkingBudget, total_budget: totalBudget, summary };
}

export interface CacheConfig {
  readonly mode: CacheMode;
  readonly retention: CacheRetention | null;
  readonly key: string | null;
  readonly prefix_until_index: number | null;
}

export function cacheConfig(fields: {
  mode?: unknown;
  retention?: unknown;
  key?: unknown;
  prefix_until_index?: unknown;
}): CacheConfig {
  const mode = checkVocab("cache mode", fields.mode ?? "auto", CACHE_MODES);
  const retention =
    fields.retention === null || fields.retention === undefined
      ? null
      : checkVocab("cache retention", fields.retention, CACHE_RETENTIONS);
  const key = optString("CacheConfig.key", fields.key, false);
  const prefixUntilIndex = toIntOrNull(
    "CacheConfig.prefix_until_index",
    fields.prefix_until_index,
    { min: 0 },
  );
  if (mode === "off" && (retention !== null || key !== null)) {
    throw new ValueError("CacheConfig(mode='off') cannot specify retention or key"); // INV-027
  }
  return { mode, retention, key, prefix_until_index: prefixUntilIndex };
}

export interface Config {
  readonly max_tokens: number | null;
  readonly temperature: number | null;
  readonly top_p: number | null;
  readonly top_k: number | null;
  readonly stop: readonly string[];
  readonly response_format: JsonObject | null;
  readonly tool_choice: ToolChoice | null;
  readonly reasoning: Reasoning | null;
  readonly cache: CacheConfig | null;
  readonly extensions: JsonObject | null;
}

export function config(fields: {
  max_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stop?: unknown;
  response_format?: unknown;
  tool_choice?: ToolChoice | null;
  reasoning?: Reasoning | null;
  cache?: CacheConfig | null;
  extensions?: unknown;
}): Config {
  let stop: readonly string[] = [];
  if (typeof fields.stop === "string") stop = [fields.stop]; // INV-020
  else if (Array.isArray(fields.stop)) stop = fields.stop;
  else if (fields.stop !== null && fields.stop !== undefined) {
    throw new ValueError("Config.stop must be a string or a list of strings");
  }
  for (const s of stop) reqString("Config.stop entry", s, true);
  return {
    max_tokens: toIntOrNull("Config.max_tokens", fields.max_tokens, { min: 1 }),
    temperature: toFloatOrNull("Config.temperature", fields.temperature, { min: 0 }),
    top_p: toFloatOrNull("Config.top_p", fields.top_p, { min: 0, max: 1 }),
    top_k: toIntOrNull("Config.top_k", fields.top_k, { min: 1 }),
    stop,
    response_format: optOpaqueObject("Config.response_format", fields.response_format),
    tool_choice: fields.tool_choice ?? null,
    reasoning: fields.reasoning ?? null,
    cache: fields.cache ?? null,
    extensions: normalizeExtensions("Config.extensions", fields.extensions), // INV-004
  };
}

export function defaultConfig(): Config {
  return config({});
}

// ─── Request / Response ──────────────────────────────────────────────

export interface Request {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system: string | readonly Part[] | null;
  readonly tools: readonly Tool[];
  readonly config: Config;
}

export function request(fields: {
  model: unknown;
  messages: readonly Message[];
  system?: string | readonly Part[] | null;
  tools?: readonly Tool[];
  config?: Config;
}): Request {
  const model = reqString("Request.model", fields.model, true);
  if (fields.messages.length === 0) throw new ValueError("Request.messages must be non-empty");
  let system: string | readonly Part[] | null = fields.system ?? null;
  if (typeof system === "string") {
    if (system === "") throw new ValueError("Request.system must be non-empty"); // INV-024
  } else if (system !== null) {
    if (system.length === 0) throw new ValueError("Request.system must be non-empty");
    for (const part of system) {
      if (PROTOCOL_PARTS.has(part.type)) {
        throw new ValueError(`system may not contain ${part.type} parts`); // INV-024
      }
    }
  }
  const tools = fields.tools ?? [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new ValueError("Request.tools cannot contain duplicate tool names"); // INV-030
    }
    names.add(tool.name);
  }
  const cfg = fields.config ?? defaultConfig();
  if (cfg.tool_choice !== null) {
    for (const allowed of cfg.tool_choice.allowed) {
      if (!names.has(allowed)) {
        throw new ValueError(`tool_choice.allowed contains unknown tool: ${allowed}`); // INV-031
      }
    }
  }
  return { model, messages: fields.messages, system, tools, config: cfg };
}

export interface Usage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly input_audio_tokens: number | null;
  readonly output_audio_tokens: number | null;
}

export function usage(fields: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  reasoning_tokens?: unknown;
  input_audio_tokens?: unknown;
  output_audio_tokens?: unknown;
} = {}): Usage {
  const counter = (name: string, v: unknown) => toIntOrNull(`Usage.${name}`, v, { min: 0 });
  const inputTokens = counter("input_tokens", fields.input_tokens);
  const outputTokens = counter("output_tokens", fields.output_tokens);
  let totalTokens = counter("total_tokens", fields.total_tokens);
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens; // INV-029
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_tokens: counter("cache_read_tokens", fields.cache_read_tokens),
    cache_write_tokens: counter("cache_write_tokens", fields.cache_write_tokens),
    reasoning_tokens: counter("reasoning_tokens", fields.reasoning_tokens),
    input_audio_tokens: counter("input_audio_tokens", fields.input_audio_tokens),
    output_audio_tokens: counter("output_audio_tokens", fields.output_audio_tokens),
  };
}

export interface Response {
  readonly id: string | null;
  readonly model: string;
  readonly message: Message;
  readonly finish_reason: FinishReason;
  readonly usage: Usage;
  readonly provider_data: JsonObject | null;
}

export function response(fields: {
  id?: unknown;
  model: unknown;
  message: Message;
  finish_reason: unknown;
  usage?: Usage;
  provider_data?: unknown;
}): Response {
  if (fields.message.role !== "assistant") {
    throw new ValueError("Response.message must have role 'assistant'"); // INV-036
  }
  return {
    id: optString("Response.id", fields.id, true),
    model: reqString("Response.model", fields.model, true),
    message: fields.message,
    finish_reason: checkVocab("finish_reason", fields.finish_reason, FINISH_REASONS),
    usage: fields.usage ?? usage(),
    provider_data: optOpaqueObject("Response.provider_data", fields.provider_data),
  };
}

// ─── Deltas ──────────────────────────────────────────────────────────

export interface TextDelta {
  readonly type: "text";
  readonly text: string;
  readonly part_index: number;
}

export interface ThinkingDelta {
  readonly type: "thinking";
  readonly text: string;
  readonly part_index: number;
}

interface MediaDeltaFields {
  readonly data: string | null;
  readonly url: string | null;
  readonly file_id: string | null;
  readonly part_index: number;
  readonly media_type: string | null;
}

export interface AudioDelta extends MediaDeltaFields {
  readonly type: "audio";
}

export interface ImageDelta extends MediaDeltaFields {
  readonly type: "image";
}

export interface ToolCallDelta {
  readonly type: "tool_call";
  readonly input: string;
  readonly part_index: number;
  readonly id: string | null;
  readonly name: string | null;
}

export interface CitationDelta {
  readonly type: "citation";
  readonly text: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly part_index: number;
}

export interface ContinuationDelta {
  readonly type: "continuation";
  readonly provider: string;
  readonly kind: string;
  readonly data: JsonObject;
  readonly part_index: number | null;
}

export type Delta =
  | TextDelta
  | ThinkingDelta
  | AudioDelta
  | ImageDelta
  | ToolCallDelta
  | CitationDelta
  | ContinuationDelta;

function partIndex(v: unknown): number {
  return toInt("part_index", v ?? 0, { min: 0 }); // INV-006
}

export function textDelta(fields: { text: unknown; part_index?: unknown }): TextDelta {
  return {
    type: "text",
    text: reqString("TextDelta.text", fields.text, false),
    part_index: partIndex(fields.part_index),
  };
}

export function thinkingDelta(fields: { text: unknown; part_index?: unknown }): ThinkingDelta {
  return {
    type: "thinking",
    text: reqString("ThinkingDelta.text", fields.text, false),
    part_index: partIndex(fields.part_index),
  };
}

function mediaDelta(
  kind: "audio" | "image",
  fields: {
    data?: unknown;
    url?: unknown;
    file_id?: unknown;
    part_index?: unknown;
    media_type?: unknown;
  },
): MediaDeltaFields {
  const data = optString(`${kind}Delta.data`, fields.data, false);
  const url = optString(`${kind}Delta.url`, fields.url);
  const fileId = optString(`${kind}Delta.file_id`, fields.file_id);
  if ([data, url, fileId].filter((s) => s !== null).length > 1) {
    throw new ValueError(`${kind} delta carries at most one of data/url/file_id`); // INV-018
  }
  return {
    data,
    url,
    file_id: fileId,
    part_index: partIndex(fields.part_index),
    media_type: optString(`${kind}Delta.media_type`, fields.media_type),
  };
}

export function audioDelta(fields: Parameters<typeof mediaDelta>[1]): AudioDelta {
  return { type: "audio", ...mediaDelta("audio", fields) };
}

export function imageDelta(fields: Parameters<typeof mediaDelta>[1]): ImageDelta {
  return { type: "image", ...mediaDelta("image", fields) };
}

export function toolCallDelta(fields: {
  input: unknown;
  part_index?: unknown;
  id?: unknown;
  name?: unknown;
}): ToolCallDelta {
  return {
    type: "tool_call",
    input: reqString("ToolCallDelta.input", fields.input, false),
    part_index: partIndex(fields.part_index),
    id: optString("ToolCallDelta.id", fields.id),
    name: optString("ToolCallDelta.name", fields.name),
  };
}

export function citationDelta(fields: {
  text?: unknown;
  url?: unknown;
  title?: unknown;
  part_index?: unknown;
}): CitationDelta {
  const text = optString("CitationDelta.text", fields.text, false);
  const url = optString("CitationDelta.url", fields.url, false);
  const title = optString("CitationDelta.title", fields.title, false);
  if (text === null && url === null && title === null) {
    throw new ValueError("CitationDelta requires at least one of text/url/title"); // INV-019
  }
  return { type: "citation", text, url, title, part_index: partIndex(fields.part_index) };
}

export function continuationDelta(fields: {
  provider: unknown;
  kind: unknown;
  data?: unknown;
  part_index?: unknown;
}): ContinuationDelta {
  return {
    type: "continuation",
    provider: reqString("ContinuationDelta.provider", fields.provider, true),
    kind: reqString("ContinuationDelta.kind", fields.kind, true),
    data: checkOpaqueObject("ContinuationDelta.data", fields.data ?? {}),
    part_index:
      fields.part_index === null || fields.part_index === undefined
        ? null
        : toInt("part_index", fields.part_index, { min: 0 }),
  };
}

// ─── Stream events ───────────────────────────────────────────────────

export interface StreamStartEvent {
  readonly type: "start";
  readonly id: string | null;
  readonly model: string | null;
}

export interface StreamDeltaEvent {
  readonly type: "delta";
  readonly delta: Delta;
}

export interface StreamEndEvent {
  readonly type: "end";
  readonly finish_reason: FinishReason | null;
  readonly usage: Usage | null;
  readonly provider_data: JsonObject | null;
}

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly provider_code: string | null;
}

export interface StreamErrorEvent {
  readonly type: "error";
  readonly error: ErrorDetail;
}

export type StreamEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamEndEvent
  | StreamErrorEvent;

export function streamStartEvent(fields: { id?: unknown; model?: unknown }): StreamStartEvent {
  return {
    type: "start",
    id: optString("StreamStartEvent.id", fields.id, false),
    model: optString("StreamStartEvent.model", fields.model, false),
  };
}

export function streamDeltaEvent(delta: Delta): StreamDeltaEvent {
  return { type: "delta", delta };
}

export function streamEndEvent(fields: {
  finish_reason?: unknown;
  usage?: Usage | null;
  provider_data?: unknown;
}): StreamEndEvent {
  return {
    type: "end",
    finish_reason:
      fields.finish_reason === null || fields.finish_reason === undefined
        ? null
        : checkVocab("finish_reason", fields.finish_reason, FINISH_REASONS),
    usage: fields.usage ?? null,
    provider_data: optOpaqueObject("StreamEndEvent.provider_data", fields.provider_data),
  };
}

export function errorDetail(fields: {
  code: unknown;
  message?: unknown;
  provider_code?: unknown;
}): ErrorDetail {
  return {
    code: checkVocab("error code", fields.code, ERROR_CODES),
    message: reqString("ErrorDetail.message", fields.message ?? "", false),
    provider_code: optString("ErrorDetail.provider_code", fields.provider_code),
  };
}

export function streamErrorEvent(error: ErrorDetail): StreamErrorEvent {
  return { type: "error", error };
}

// ─── Audio / Live ────────────────────────────────────────────────────

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sample_rate: number;
  readonly channels: number;
}

export function audioFormat(fields: {
  encoding: unknown;
  sample_rate: unknown;
  channels?: unknown;
}): AudioFormat {
  return {
    encoding: checkVocab("audio encoding", fields.encoding, AUDIO_ENCODINGS),
    sample_rate: toInt("AudioFormat.sample_rate", fields.sample_rate, { min: 1 }),
    channels: toInt("AudioFormat.channels", fields.channels ?? 1, { min: 1 }),
  };
}

export interface LiveConfig {
  readonly model: string;
  readonly system: string | readonly Part[] | null;
  readonly tools: readonly Tool[];
  readonly voice: string | null;
  readonly input_format: AudioFormat | null;
  readonly output_format: AudioFormat | null;
  readonly extensions: JsonObject | null;
}

export function liveConfig(fields: {
  model: unknown;
  system?: string | readonly Part[] | null;
  tools?: readonly Tool[];
  voice?: unknown;
  input_format?: AudioFormat | null;
  output_format?: AudioFormat | null;
  extensions?: unknown;
}): LiveConfig {
  const model = reqString("LiveConfig.model", fields.model, true);
  let system: string | readonly Part[] | null = fields.system ?? null;
  if (typeof system === "string") {
    if (system === "") throw new ValueError("LiveConfig.system must be non-empty");
  } else if (system !== null) {
    for (const part of system) {
      if (PROTOCOL_PARTS.has(part.type)) {
        throw new ValueError(`system may not contain ${part.type} parts`);
      }
    }
  }
  const tools = fields.tools ?? [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new ValueError("LiveConfig.tools cannot contain duplicate tool names"); // INV-030
    }
    names.add(tool.name);
  }
  return {
    model,
    system,
    tools,
    voice: optString("LiveConfig.voice", fields.voice),
    input_format: fields.input_format ?? null,
    output_format: fields.output_format ?? null,
    extensions: normalizeExtensions("LiveConfig.extensions", fields.extensions),
  };
}

export interface LiveClientTurnEvent {
  readonly type: "turn";
  readonly parts: readonly Part[];
  readonly turn_complete: boolean;
}

export interface LiveClientAudioEvent {
  readonly type: "audio";
  readonly data: string;
  readonly media_type: string;
}

export interface LiveClientImageEvent {
  readonly type: "image";
  readonly data: string;
  readonly media_type: string;
}

export interface LiveClientTextEvent {
  readonly type: "text";
  readonly text: string;
}

export interface LiveClientToolResultEvent {
  readonly type: "tool_result";
  readonly id: string;
  readonly content: readonly Part[];
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

export function liveClientTurnEvent(fields: {
  parts: readonly Part[];
  turn_complete?: unknown;
}): LiveClientTurnEvent {
  if (fields.parts.length === 0) {
    throw new ValueError("LiveClientTurnEvent.parts must be non-empty");
  }
  for (const part of fields.parts) {
    if (PROTOCOL_PARTS.has(part.type)) {
      throw new ValueError(`turn parts may not contain ${part.type} parts`);
    }
  }
  return {
    type: "turn",
    parts: fields.parts,
    turn_complete: reqBool("LiveClientTurnEvent.turn_complete", fields.turn_complete ?? true),
  };
}

export function liveClientAudioEvent(fields: {
  data: unknown;
  media_type?: unknown;
}): LiveClientAudioEvent {
  const mediaType =
    fields.media_type === null || fields.media_type === undefined
      ? "audio/pcm;rate=16000"
      : reqString("LiveClientAudioEvent.media_type", fields.media_type, true);
  if (!mediaType.startsWith("audio/")) {
    throw new ValueError("LiveClientAudioEvent.media_type must start with 'audio/'");
  }
  const data = reqString("LiveClientAudioEvent.data", fields.data, true);
  return { type: "audio", data: validateBase64Data("LiveClientAudioEvent.data", data), media_type: mediaType };
}

export function liveClientImageEvent(fields: {
  data: unknown;
  media_type?: unknown;
}): LiveClientImageEvent {
  const mediaType =
    fields.media_type === null || fields.media_type === undefined
      ? "image/jpeg"
      : reqString("LiveClientImageEvent.media_type", fields.media_type, true);
  if (!mediaType.startsWith("image/")) {
    throw new ValueError("LiveClientImageEvent.media_type must start with 'image/'");
  }
  const data = reqString("LiveClientImageEvent.data", fields.data, true);
  return { type: "image", data: validateBase64Data("LiveClientImageEvent.data", data), media_type: mediaType };
}

export function liveClientTextEvent(fields: { text: unknown }): LiveClientTextEvent {
  return { type: "text", text: reqString("LiveClientTextEvent.text", fields.text, false) };
}

export function liveClientToolResultEvent(fields: {
  id: unknown;
  content: readonly Part[];
}): LiveClientToolResultEvent {
  if (fields.content.length === 0) {
    throw new ValueError("LiveClientToolResultEvent.content must be non-empty");
  }
  checkPresentational("LiveClientToolResultEvent.content", fields.content);
  return {
    type: "tool_result",
    id: reqString("LiveClientToolResultEvent.id", fields.id, true),
    content: fields.content,
  };
}

export const liveClientInterruptEvent: LiveClientInterruptEvent = { type: "interrupt" };
export const liveClientEndAudioEvent: LiveClientEndAudioEvent = { type: "end_audio" };

export interface LiveServerAudioEvent {
  readonly type: "audio";
  readonly data: string;
  readonly media_type: string | null;
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
  readonly input_delta: string;
  readonly id: string | null;
  readonly name: string | null;
}

export interface LiveServerInterruptedEvent {
  readonly type: "interrupted";
}

export interface LiveServerTurnEndEvent {
  readonly type: "turn_end";
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
  | LiveServerErrorEvent;

export function liveServerAudioEvent(fields: {
  data: unknown;
  media_type?: unknown;
}): LiveServerAudioEvent {
  const mediaType = optString("LiveServerAudioEvent.media_type", fields.media_type, true);
  if (mediaType !== null && !mediaType.startsWith("audio/")) {
    throw new ValueError("LiveServerAudioEvent.media_type must start with 'audio/'");
  }
  const data = reqString("LiveServerAudioEvent.data", fields.data, true);
  return { type: "audio", data: validateBase64Data("LiveServerAudioEvent.data", data), media_type: mediaType };
}

export function liveServerTextEvent(fields: { text: unknown }): LiveServerTextEvent {
  return { type: "text", text: reqString("LiveServerTextEvent.text", fields.text, false) };
}

export function liveServerToolCallEvent(fields: {
  id: unknown;
  name: unknown;
  input: unknown;
}): LiveServerToolCallEvent {
  return {
    type: "tool_call",
    id: reqString("LiveServerToolCallEvent.id", fields.id, true),
    name: reqString("LiveServerToolCallEvent.name", fields.name, true),
    input: checkOpaqueObject("LiveServerToolCallEvent.input", fields.input),
  };
}

export function liveServerToolCallDeltaEvent(fields: {
  input_delta?: unknown;
  id?: unknown;
  name?: unknown;
}): LiveServerToolCallDeltaEvent {
  return {
    type: "tool_call_delta",
    input_delta: reqString("LiveServerToolCallDeltaEvent.input_delta", fields.input_delta ?? "", false),
    id: optString("LiveServerToolCallDeltaEvent.id", fields.id),
    name: optString("LiveServerToolCallDeltaEvent.name", fields.name),
  };
}

export const liveServerInterruptedEvent: LiveServerInterruptedEvent = { type: "interrupted" };

export function liveServerTurnEndEvent(u: Usage): LiveServerTurnEndEvent {
  return { type: "turn_end", usage: u };
}

export function liveServerErrorEvent(error: ErrorDetail): LiveServerErrorEvent {
  return { type: "error", error };
}

// ─── ToolCallInfo (callback view; in-memory only) ────────────────────

export interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export function toolCallInfoFromPart(part: ToolCallPart): ToolCallInfo {
  return { id: part.id, name: part.name, input: part.input };
}

export function toolCallInfoToPart(info: ToolCallInfo): ToolCallPart {
  return toolCallPart({ id: info.id, name: info.name, input: info.input });
}

// ─── Other endpoints (provisional per spec/SCOPE.md) ─────────────────

export interface EmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly string[];
  readonly extensions: JsonObject | null;
}

export function embeddingRequest(fields: {
  model: unknown;
  inputs: unknown;
  extensions?: unknown;
}): EmbeddingRequest {
  const model = reqString("EmbeddingRequest.model", fields.model, true);
  let inputs: readonly string[];
  if (typeof fields.inputs === "string") inputs = [fields.inputs]; // INV-020
  else if (Array.isArray(fields.inputs)) inputs = fields.inputs;
  else throw new ValueError("EmbeddingRequest.inputs must be a string or a list of strings");
  if (inputs.length === 0) throw new ValueError("EmbeddingRequest.inputs must be non-empty");
  for (const input of inputs) reqString("EmbeddingRequest.inputs entry", input, true);
  return { model, inputs, extensions: normalizeExtensions("EmbeddingRequest.extensions", fields.extensions) };
}

export interface EmbeddingResponse {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
  readonly provider_data: JsonObject | null;
}

export interface FileUploadRequest {
  readonly filename: string;
  readonly bytes_data: Uint8Array | null;
  readonly media_type: string;
  readonly model: string | null;
  readonly extensions: JsonObject | null;
  readonly path: string | null;
}

export interface FileUploadResponse {
  readonly id: string;
  readonly provider_data: JsonObject | null;
}

export interface BatchRequest {
  readonly model: string;
  readonly requests: readonly Request[];
  readonly extensions: JsonObject | null;
}

export function batchRequest(fields: {
  model?: unknown;
  requests: readonly Request[];
  extensions?: unknown;
}): BatchRequest {
  if (fields.requests.length === 0) {
    throw new ValueError("BatchRequest.requests must be non-empty");
  }
  const model =
    fields.model === null || fields.model === undefined
      ? fields.requests[0]!.model // INV-032
      : reqString("BatchRequest.model", fields.model, true);
  return {
    model,
    requests: fields.requests,
    extensions: normalizeExtensions("BatchRequest.extensions", fields.extensions),
  };
}

export interface BatchResponse {
  readonly id: string;
  readonly status: BatchStatus;
  readonly provider_data: JsonObject | null;
}

export interface ImageGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly size: string | null;
  readonly extensions: JsonObject | null;
}

export interface ImageGenerationResponse {
  readonly images: readonly ImagePart[];
  readonly id: string | null;
  readonly model: string | null;
  readonly usage: Usage;
  readonly provider_data: JsonObject | null;
}

export interface AudioGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly voice: string | null;
  readonly format: string | null;
  readonly extensions: JsonObject | null;
}

export interface AudioGenerationResponse {
  readonly audio: AudioPart;
  readonly id: string | null;
  readonly model: string | null;
  readonly usage: Usage;
  readonly provider_data: JsonObject | null;
}

// ─── ModelInfo (model catalog; serde kind "model_info") ──────────────
// NOTE: ModelInfo and its nested types are absent from spec/types.md; the
// shapes below follow the Python reference (lm15/models.py + serde.py),
// which the contract's serde vectors exercise. Spec gap noted in the
// stage report.

export interface InferencePricing {
  readonly input_per_million: number | null;
  readonly output_per_million: number | null;
  readonly cache_read_per_million: number | null;
  readonly cache_write_per_million: number | null;
  readonly currency: string;
  readonly dimensions: JsonObject | null;
}

export interface TrainingPricing {
  readonly training_tokens_per_million: number | null;
  readonly gpu_second: number | null;
  readonly currency: string;
  readonly dimensions: JsonObject | null;
}

export interface InferenceModelInfo {
  readonly input_modalities: readonly string[];
  readonly output_modalities: readonly string[];
  readonly context_window: number | null;
  readonly max_output_tokens: number | null;
  readonly supports_reasoning: boolean;
  readonly reasoning_efforts: readonly string[];
  readonly pricing: InferencePricing | null;
  readonly extensions: JsonObject | null;
}

export interface TrainingModelInfo {
  readonly supports_lora: boolean;
  readonly supports_full_finetune: boolean;
  readonly trainable_modalities: readonly string[];
  readonly pricing: TrainingPricing | null;
  readonly extensions: JsonObject | null;
}

export interface ModelOrigin {
  readonly type: string;
  readonly id: string | null;
  readonly base_model: string | null;
  readonly provider_data: JsonObject | null;
}

export const DEFAULT_MODEL_ORIGIN: ModelOrigin = {
  type: "provider",
  id: null,
  base_model: null,
  provider_data: null,
};

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly api_family: string;
  readonly aliases: readonly string[];
  readonly origin: ModelOrigin;
  readonly inference: InferenceModelInfo | null;
  readonly training: TrainingModelInfo | null;
  readonly extensions: JsonObject | null;
}

export function inferencePricing(fields: {
  input_per_million?: unknown;
  output_per_million?: unknown;
  cache_read_per_million?: unknown;
  cache_write_per_million?: unknown;
  currency?: unknown;
  dimensions?: unknown;
}): InferencePricing {
  const price = (name: string, v: unknown) =>
    toFloatOrNull(`InferencePricing.${name}`, v, { min: 0 });
  return {
    input_per_million: price("input_per_million", fields.input_per_million),
    output_per_million: price("output_per_million", fields.output_per_million),
    cache_read_per_million: price("cache_read_per_million", fields.cache_read_per_million),
    cache_write_per_million: price("cache_write_per_million", fields.cache_write_per_million),
    currency: reqString("InferencePricing.currency", fields.currency ?? "USD", true),
    dimensions: optOpaqueObject("InferencePricing.dimensions", fields.dimensions),
  };
}

export function trainingPricing(fields: {
  training_tokens_per_million?: unknown;
  gpu_second?: unknown;
  currency?: unknown;
  dimensions?: unknown;
}): TrainingPricing {
  return {
    training_tokens_per_million: toFloatOrNull(
      "TrainingPricing.training_tokens_per_million",
      fields.training_tokens_per_million,
      { min: 0 },
    ),
    gpu_second: toFloatOrNull("TrainingPricing.gpu_second", fields.gpu_second, { min: 0 }),
    currency: reqString("TrainingPricing.currency", fields.currency ?? "USD", true),
    dimensions: optOpaqueObject("TrainingPricing.dimensions", fields.dimensions),
  };
}

function stringList(name: string, v: unknown, fallback: readonly string[]): readonly string[] {
  if (v === null || v === undefined) return fallback;
  if (!Array.isArray(v)) throw new ValueError(`${name} must be a list of strings`);
  for (const item of v) reqString(`${name} entry`, item, true);
  return v;
}

export function inferenceModelInfo(fields: {
  input_modalities?: unknown;
  output_modalities?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
  supports_reasoning?: unknown;
  reasoning_efforts?: unknown;
  pricing?: InferencePricing | null;
  extensions?: unknown;
}): InferenceModelInfo {
  return {
    input_modalities: stringList("InferenceModelInfo.input_modalities", fields.input_modalities, ["text"]),
    output_modalities: stringList("InferenceModelInfo.output_modalities", fields.output_modalities, ["text"]),
    context_window: toIntOrNull("InferenceModelInfo.context_window", fields.context_window, { min: 1 }),
    max_output_tokens: toIntOrNull("InferenceModelInfo.max_output_tokens", fields.max_output_tokens, { min: 1 }),
    supports_reasoning: reqBool("InferenceModelInfo.supports_reasoning", fields.supports_reasoning ?? false),
    reasoning_efforts: stringList("InferenceModelInfo.reasoning_efforts", fields.reasoning_efforts, []),
    pricing: fields.pricing ?? null,
    extensions: normalizeExtensions("InferenceModelInfo.extensions", fields.extensions),
  };
}

export function trainingModelInfo(fields: {
  supports_lora?: unknown;
  supports_full_finetune?: unknown;
  trainable_modalities?: unknown;
  pricing?: TrainingPricing | null;
  extensions?: unknown;
}): TrainingModelInfo {
  return {
    supports_lora: reqBool("TrainingModelInfo.supports_lora", fields.supports_lora ?? false),
    supports_full_finetune: reqBool(
      "TrainingModelInfo.supports_full_finetune",
      fields.supports_full_finetune ?? false,
    ),
    trainable_modalities: stringList("TrainingModelInfo.trainable_modalities", fields.trainable_modalities, []),
    pricing: fields.pricing ?? null,
    extensions: normalizeExtensions("TrainingModelInfo.extensions", fields.extensions),
  };
}

export function modelOrigin(fields: {
  type?: unknown;
  id?: unknown;
  base_model?: unknown;
  provider_data?: unknown;
}): ModelOrigin {
  return {
    type: reqString("ModelOrigin.type", fields.type ?? "provider", true),
    id: optString("ModelOrigin.id", fields.id),
    base_model: optString("ModelOrigin.base_model", fields.base_model),
    provider_data: optOpaqueObject("ModelOrigin.provider_data", fields.provider_data),
  };
}

export function modelInfo(fields: {
  id: unknown;
  provider: unknown;
  api_family: unknown;
  aliases?: unknown;
  origin?: ModelOrigin;
  inference?: InferenceModelInfo | null;
  training?: TrainingModelInfo | null;
  extensions?: unknown;
}): ModelInfo {
  return {
    id: reqString("ModelInfo.id", fields.id, true),
    provider: reqString("ModelInfo.provider", fields.provider, true),
    api_family: reqString("ModelInfo.api_family", fields.api_family, true),
    aliases: stringList("ModelInfo.aliases", fields.aliases, []),
    origin: fields.origin ?? DEFAULT_MODEL_ORIGIN,
    inference: fields.inference ?? null,
    training: fields.training ?? null,
    extensions: normalizeExtensions("ModelInfo.extensions", fields.extensions),
  };
}
