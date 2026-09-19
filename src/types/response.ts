/**
 * Usage, logprobs, ErrorDetail, and Response (spec/types.md § Request/Response).
 *
 * `Response` is a class: it is produced by lm15, never written as a literal
 * by a user, and the ratified API reads `response.text`, `response.toolCalls`,
 * `response.usage.inputTokens`.
 */

import { canonicalFactory, canonicalValue } from "../canonical.ts";
import { normalizeHttpResponse } from "../rate_limits.ts";
import { float, isJsonObject, omitEmpty, parseJson, type JsonObject, type JsonValue } from "../json.ts";
import { ERROR_CODES, FINISH_REASONS, type ErrorCode, type FinishReason } from "../vocab.ts";
import { adaptationsFromJSON, adaptationsToJSON, normalizeAdaptations, type Adaptation } from "./adaptation.ts";
import { Message, normalizeMessage, type CitationPart, type DataPart, type Part, type TextPart, type ToolCallPart } from "./parts.ts";
import {
  ValueError,
  absent,
  compact,
  frozen,
  optionalInt,
  optionalJsonObject,
  optionalString,
  requireFloat,
  requireInt,
  requireOneOf,
  requireString,
} from "./validate.ts";

// ─── Usage ───────────────────────────────────────────────────────────

/**
 * Token usage. Every counter is `number | undefined`: `undefined` means "not
 * reported", distinct from a reported `0` (INV-029). Counters are provider-
 * verbatim; lm15 never re-derives one from another except `totalTokens`
 * when the provider reports none and both primaries are present.
 */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly inputAudioTokens?: number;
  readonly outputAudioTokens?: number;
}

const USAGE_FIELDS = [
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["totalTokens", "total_tokens"],
  ["cacheReadTokens", "cache_read_tokens"],
  ["cacheWriteTokens", "cache_write_tokens"],
  ["reasoningTokens", "reasoning_tokens"],
  ["inputAudioTokens", "input_audio_tokens"],
  ["outputAudioTokens", "output_audio_tokens"],
] as const;

export const normalizeUsage = canonicalFactory("usage", normalizeUsageValue);
function normalizeUsageValue(input: unknown): Usage {
  if (absent(input)) return EMPTY_USAGE;
  if (typeof input !== "object") throw new TypeError("usage must be a Usage");
  const d = input as Record<string, unknown>;
  const out: Record<string, number | undefined> = {};
  for (const [camel, snake] of USAGE_FIELDS) out[camel] = optionalInt(d[camel], snake, { min: 0 });
  if (out["totalTokens"] === undefined && out["inputTokens"] !== undefined && out["outputTokens"] !== undefined) {
    out["totalTokens"] = requireInt(out["inputTokens"] + out["outputTokens"], "total_tokens", { min: 0 });
  }
  return frozen(compact(out) as Usage);
}

const EMPTY_USAGE: Usage = canonicalValue("usage", Object.freeze({}));
const EMPTY_ADAPTATIONS: readonly Adaptation[] = Object.freeze([]);

export function isEmptyUsage(usage: Usage | undefined): boolean {
  return usage === undefined || USAGE_FIELDS.every(([camel]) => usage[camel] === undefined);
}

export const Usage = {
  create: normalizeUsage,
  empty: EMPTY_USAGE,
  fromJSON(d: JsonObject): Usage {
    const input: Record<string, unknown> = {};
    for (const [camel, snake] of USAGE_FIELDS) input[camel] = d[snake];
    return normalizeUsage(input);
  },
  toJSON(u: Usage): JsonObject {
    const out: Record<string, unknown> = {};
    for (const [camel, snake] of USAGE_FIELDS) out[snake] = u[camel];
    return omitEmpty(out);
  },
};

// ─── Logprobs ────────────────────────────────────────────────────────

export interface TopLogprob {
  readonly token: string;
  /** Float-typed; emitted as a float even when integral. */
  readonly logprob: number;
  readonly bytes?: readonly number[];
  readonly tokenId?: number;
}

export interface TokenLogprob extends TopLogprob {
  /** Provider-reported ranked alternatives, descending logprob. */
  readonly top?: readonly TopLogprob[];
}

function normalizeTopLogprob(input: unknown, withTop: boolean): TokenLogprob {
  if (typeof input !== "object" || input === null) throw new TypeError("TokenLogprob must be an object");
  const d = input as Record<string, unknown>;
  const logprob = requireFloat(d["logprob"], "logprob");
  let bytes: readonly number[] | undefined;
  if (!absent(d["bytes"])) {
    if (!Array.isArray(d["bytes"])) throw new TypeError("bytes must contain non-negative ints");
    bytes = Object.freeze(
      d["bytes"].map((b) => {
        if (typeof b === "boolean") throw new TypeError("bytes must contain non-negative ints");
        try {
          return requireInt(b, "bytes", { min: 0 });
        } catch {
          throw new TypeError("bytes must contain non-negative ints");
        }
      }),
    );
  }
  const out: Record<string, unknown> = {
    token: requireString(d["token"], "token"),
    logprob,
    bytes,
    tokenId: optionalInt(d["tokenId"], "token_id"),
  };
  if (withTop) {
    const rawTop = absent(d["top"]) ? [] : Array.isArray(d["top"]) ? d["top"] : [d["top"]];
    const top = rawTop.map((t) => normalizeTopLogprob(t, false));
    out["top"] = top.length > 0 ? Object.freeze(top) : undefined;
  }
  return frozen(compact(out) as unknown as TokenLogprob);
}

export const normalizeTokenLogprob = canonicalFactory("token_logprob", normalizeTokenLogprobValue);
function normalizeTokenLogprobValue(input: unknown): TokenLogprob {
  return normalizeTopLogprob(input, true);
}

export function normalizeLogprobs(value: unknown, field: string): readonly TokenLogprob[] | undefined {
  if (absent(value)) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return Object.freeze(list.map((t) => normalizeTokenLogprob(t)));
}

function topLogprobFromJSON(d: JsonObject): TopLogprob {
  return normalizeTopLogprob({ token: d["token"], logprob: d["logprob"], bytes: d["bytes"], tokenId: d["token_id"] }, false);
}

function topLogprobToJSON(t: TopLogprob): JsonObject {
  const out: JsonObject = { token: t.token, logprob: float(t.logprob) };
  if (t.bytes !== undefined) out["bytes"] = [...t.bytes];
  if (t.tokenId !== undefined) out["token_id"] = t.tokenId;
  return out;
}

export const TokenLogprob = {
  create: normalizeTokenLogprob,
  fromJSON(d: JsonObject): TokenLogprob {
    const top = d["top"];
    return normalizeTokenLogprob({
      token: d["token"],
      logprob: d["logprob"],
      bytes: d["bytes"],
      tokenId: d["token_id"],
      top: Array.isArray(top) ? top.map((x) => topLogprobFromJSON(x as JsonObject)) : [],
    });
  },
  toJSON(t: TokenLogprob): JsonObject {
    const out = topLogprobToJSON(t);
    if (t.top && t.top.length > 0) out["top"] = t.top.map(topLogprobToJSON);
    return out;
  },
};

export function logprobsToJSON(logprobs: readonly TokenLogprob[] | undefined): JsonObject[] | undefined {
  if (!logprobs || logprobs.length === 0) return undefined;
  return logprobs.map(TokenLogprob.toJSON);
}

export function logprobsFromJSON(value: JsonValue | undefined): readonly TokenLogprob[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) throw new TypeError("logprobs must be a list");
  return Object.freeze(value.map((x) => TokenLogprob.fromJSON(x as JsonObject)));
}

// ─── ErrorDetail ─────────────────────────────────────────────────────

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly message: string;
  readonly providerCode?: string;
  readonly httpResponse?: JsonObject;
}

export const normalizeErrorDetail = canonicalFactory("error_detail", normalizeErrorDetailValue);
function normalizeErrorDetailValue(input: unknown): ErrorDetail {
  if (typeof input !== "object" || input === null) throw new TypeError("ErrorDetail must be an object");
  const d = input as Record<string, unknown>;
  const http = normalizeHttpResponse(d["httpResponse"] === undefined ? {} : d["httpResponse"]);
  return frozen(
    compact({
      code: requireOneOf(ERROR_CODES, d["code"], "error code"),
      message: requireString(d["message"] ?? "", "ErrorDetail.message"),
      providerCode: optionalString(d["providerCode"], "ErrorDetail.provider_code", false),
      httpResponse: Object.keys(http).length ? http : undefined,
    }),
  );
}

export const ErrorDetail = {
  create: normalizeErrorDetail,
  fromJSON(d: JsonObject): ErrorDetail {
    return normalizeErrorDetail({ code: d["code"], message: d["message"] ?? "", providerCode: d["provider_code"], httpResponse: d["http_response"] });
  },
  toJSON(e: ErrorDetail): JsonObject {
    const http = e.httpResponse ? { ...e.httpResponse } : undefined;
    if (http && typeof http["retry_after"] === "number") http["retry_after"] = float(http["retry_after"]);
    return omitEmpty({ code: e.code, message: e.message, provider_code: e.providerCode, http_response: http });
  },
};

// ─── Response ────────────────────────────────────────────────────────

export interface ResponseFields {
  readonly id?: string | null | undefined;
  readonly model: string;
  readonly message: Message;
  readonly finishReason: FinishReason;
  readonly usage?: Usage | undefined;
  readonly logprobs?: readonly TokenLogprob[] | null | undefined;
  /** `false`: local editing (a client-side stop) left retained text without its original scores. */
  readonly logprobsComplete?: boolean | undefined;
  readonly providerData?: JsonObject | null | undefined;
  /** MAP-13: what the wire got that differs from what was asked; empty when the request went out as written. */
  readonly adaptations?: readonly Adaptation[] | null | undefined;
}

export class Response {
  readonly id: string | undefined;
  readonly model: string;
  /** The assistant turn to replay: `messages = [...messages, response.message, Message.tool(...)]`. */
  readonly message: Message;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /** Decoding telemetry; `undefined` = the provider did not report (or local editing removed every usable score). */
  readonly logprobs: readonly TokenLogprob[] | undefined;
  /** `false` means a client-side cut left retained text without its scores; `true` does not promise the provider supplied any. */
  readonly logprobsComplete: boolean;
  /** The raw provider body, verbatim. Not part of canonical JSON. */
  readonly providerData: JsonObject | undefined;
  /** MAP-13: the record of what differs from what was asked. Data, never printed. */
  readonly adaptations: readonly Adaptation[];

  constructor(fields: ResponseFields) {
    this.id = optionalString(fields.id, "Response.id", false);
    this.model = requireString(fields.model, "Response.model", false);
    const message = normalizeMessage(fields.message);
    if (message.role !== "assistant") throw new ValueError("Response.message must have role 'assistant'");
    this.message = message;
    this.finishReason = requireOneOf(FINISH_REASONS, fields.finishReason, "finish reason");
    this.usage = normalizeUsage(fields.usage);
    this.logprobs = normalizeLogprobs(fields.logprobs, "Response.logprobs");
    if (fields.logprobsComplete !== undefined && typeof fields.logprobsComplete !== "boolean") throw new TypeError("Response.logprobs_complete must be a bool");
    this.logprobsComplete = fields.logprobsComplete ?? true;
    this.providerData = optionalJsonObject(fields.providerData, "provider_data");
    this.adaptations = normalizeAdaptations(fields.adaptations, "Response.adaptations") ?? EMPTY_ADAPTATIONS;
    Object.freeze(this);
  }

  /** The structured answer of a judgment request (MAP-14): the first DataPart's value, else the parsed JSON text. */
  get data(): JsonValue | undefined {
    const part = this.dataPart;
    if (part) return part.value;
    return this.json;
  }

  /** The DataPart of a judgment answer, when the wire delivered one. */
  get dataPart(): DataPart | undefined {
    return this.message.parts.find((p): p is DataPart => p.type === "data");
  }

  /** `{field: {key: probability}}` when the provider measured a distribution; `undefined` otherwise. */
  get probabilities(): Readonly<Record<string, Readonly<Record<string, number>>>> | undefined {
    return this.dataPart?.probabilities;
  }

  /**
   * The expected level of an ordered judgment: Σ p·i over its keys `"0"…"n-1"`
   * (Jev's `score`, computed, never stored). `undefined` when the field has
   * no distribution.
   */
  expected(field: string): number | undefined {
    const dist = this.probabilities?.[field];
    if (!dist) return undefined;
    let total = 0;
    for (const [key, p] of Object.entries(dist)) {
      const level = Number(key);
      if (!Number.isInteger(level)) throw new ValueError(`expected(${JSON.stringify(field)}): keys are not ordered levels (got ${JSON.stringify(key)})`);
      total += p * level;
    }
    return total;
  }

  /** The visible answer: text parts joined with `\n`; citations and thinking are metadata around it. */
  get text(): string | undefined {
    const strict = Message.text(this.message);
    if (strict !== undefined) return strict;
    if (this.message.parts.every((p) => p.type === "text" || p.type === "citation" || p.type === "thinking")) {
      const texts = this.message.parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text);
      if (texts.length > 0) return texts.join("\n");
    }
    return undefined;
  }

  get toolCalls(): ToolCallPart[] {
    return Message.partsOf(this.message, "tool_call");
  }

  get citations(): CitationPart[] {
    return Message.partsOf(this.message, "citation");
  }

  /** Parse the response text as JSON; `fallback` is returned instead of throwing when given. */
  parseJson<T = JsonValue>(fallback?: T): JsonValue | T {
    const t = this.text;
    const hasFallback = arguments.length > 0;
    if (t === undefined) {
      if (hasFallback) return fallback as T;
      throw new ValueError(`Cannot parse response as JSON: response is not pure text. Parts: ${JSON.stringify(this.message.parts.map((p) => p.type))}`);
    }
    const stripped = t.trim();
    try {
      return parseJson(stripped);
    } catch (e) {
      if (hasFallback) return fallback as T;
      const preview = stripped.length > 200 ? stripped.slice(0, 200) + "..." : stripped;
      throw new ValueError(`Cannot parse response as JSON: ${(e as Error).message}\nRaw text: ${preview}`);
    }
  }

  /** Parsed JSON text, or `undefined` when parsing fails. */
  get json(): JsonValue | undefined {
    return this.parseJson<undefined>(undefined);
  }

  with(changes: Partial<ResponseFields>): Response {
    return new Response({
      id: this.id,
      model: this.model,
      message: this.message,
      finishReason: this.finishReason,
      usage: this.usage,
      logprobs: this.logprobs,
      logprobsComplete: this.logprobsComplete,
      providerData: this.providerData,
      adaptations: this.adaptations,
      ...changes,
    });
  }

  static fromJSON(d: JsonObject): Response {
    if (!isJsonObject(d["message"])) throw new TypeError("Response.message must be a Message object");
    return new Response({
      id: d["id"] as string | undefined,
      model: d["model"] as string,
      message: Message.fromJSON(d["message"]),
      finishReason: d["finish_reason"] as FinishReason,
      usage: isJsonObject(d["usage"]) ? Usage.fromJSON(d["usage"]) : undefined,
      logprobs: logprobsFromJSON(d["logprobs"]),
      logprobsComplete: absent(d["logprobs_complete"]) ? undefined : (d["logprobs_complete"] as boolean),
      providerData: isJsonObject(d["provider_data"]) ? d["provider_data"] : undefined,
      adaptations: adaptationsFromJSON(d["adaptations"]),
    });
  }

  /** Canonical JSON; `provider_data` only when asked (the vet protocol serializes without it). */
  static toJSON(r: Response, opts: { includeProviderData?: boolean } = {}): JsonObject {
    const out = omitEmpty({
      id: r.id,
      model: r.model,
      message: Message.toJSON(r.message),
      finish_reason: r.finishReason,
      usage: Usage.toJSON(r.usage),
      logprobs: logprobsToJSON(r.logprobs),
    });
    // false is data (the coverage claim), emitted; true is the default and omitted.
    if (!r.logprobsComplete) out["logprobs_complete"] = false;
    if (opts.includeProviderData && r.providerData !== undefined) out["provider_data"] = r.providerData;
    const adaptations = adaptationsToJSON(r.adaptations);
    if (adaptations) out["adaptations"] = adaptations;
    return out;
  }

  toJSON(): JsonObject {
    return Response.toJSON(this);
  }
}

export type { Part };
