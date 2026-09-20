/**
 * TypeSafe System One (Jev) — provider `typesafe`.
 *
 * changes/2026-09-17-judgments.md. One `POST /v1/systemone` per Request:
 * the messages become Jev's `state` (D6), the judgment properties of the
 * `json_schema` become its `questions` (MAP-14 §2), and the answers come
 * back as one `DataPart` with the distribution per judgment and
 * `method = "provider_classification"` (§3). Jev generates no text: a
 * request without judgments, with tools, or with media is refused before
 * the wire (D8). Wire facts: receipts/2026-09-17-judgments/ (jev-*.json).
 */

import { adapt } from "../adaptation.ts";
import { ProviderLM, type EmitOptions, type LMOptions } from "../adapter.ts";
import { TYPESAFE_API, type AccessPolicy } from "../auth/policy.ts";
import { AuthError, InvalidRequestError, ProviderError, RateLimitError, ServerError, UnsupportedFeatureError, UnsupportedModelError, mapHttpError } from "../errors.ts";
import { isJsonObject, isNumeric, numberValue, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../json.ts";
import { MAX_CHOICE_KEYS, MAX_ORDERED_LEVELS, nonJudgmentProperties, parseTypeSafeResponse, requestJudgments, type Judgment } from "../judgments.ts";
import type { SSEEvent } from "../stream.ts";
import type { Request } from "../types/config.ts";
import type { ModelInfo } from "../types/model_info.ts";
import type { DataPart, Part, TextPart } from "../types/parts.ts";
import type { Response } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import { HttpResponse, modelInfosFromEntries, type TransportRequest } from "../wire.ts";
import { optionalWireFloat } from "./openai_responses.ts";
import { str } from "./openai_shared.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Config knobs with no home on the systemone wire (D8): dropped with a record. */
const DROPPED_KNOBS: ReadonlyArray<readonly [string, string]> = [
  ["max_tokens", "maxTokens"],
  ["temperature", "temperature"],
  ["top_p", "topP"],
  ["top_k", "topK"],
  ["stop", "stop"],
  ["seed", "seed"],
  ["frequency_penalty", "frequencyPenalty"],
  ["presence_penalty", "presencePenalty"],
  ["reasoning", "reasoning"],
  ["logprobs", "logprobs"],
  ["store", "store"],
  ["user_id", "userId"],
  ["service_tier", "serviceTier"],
  ["cache", "cache"],
];

const FLOAT_KNOBS: ReadonlySet<string> = new Set(["temperature", "top_p", "frequency_penalty", "presence_penalty"]);

function isTextOrData(part: Part): part is TextPart | DataPart {
  return part.type === "text" || part.type === "data";
}

function textOrValue(part: TextPart | DataPart): JsonValue {
  return part.type === "text" ? part.text : part.value;
}

export class TypeSafeLM extends ProviderLM {
  static override readonly manifest: AccessPolicy = TYPESAFE_API;
  protected readonly dialectBaseUrl = DEFAULT_BASE_URL;

  constructor(opts: LMOptions = {}) {
    super(TYPESAFE_API, DEFAULT_BASE_URL, opts);
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [k, v] of this.access.headers) headers[k] = v;
    return headers;
  }

  // ─── Request building (pure) ─────────────────────────────────────

  protected refuse(feature: string, why: string): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: ${why}`, { provider: this.provider, feature });
  }

  /**
   * changes/2026-09-19-jev-state.md D1/D2: the state is the one user part,
   * verbatim — a text's string or a data part's value. Jev has no system
   * prompt and no conversation; anything else is refused with the native
   * place named, never merged into a shape of ours. A media part is refused
   * first, as the specific fault it is (MAP-10).
   */
  protected state(request: Request): JsonValue {
    request.messages.forEach((message, mIndex) => {
      message.parts.forEach((part, pIndex) => {
        if (!isTextOrData(part)) throw this.refuse(`messages[${mIndex}].parts[${pIndex}]`, `a ${part.type} part has no slot on the systemone wire (MAP-10); Jev reads text or data`);
      });
    });
    if (request.system !== undefined) {
      throw this.refuse("system", 'Jev has no system prompt; put context in the state as a named key (Message.user({ type: "data", value: { policy, note } })), or the framing in each question\'s description (changes/2026-09-19-jev-state.md D2)');
    }
    if (request.messages.length !== 1) {
      throw this.refuse("messages", `Jev judges one state, got ${request.messages.length} messages; put a transcript in the state as an array or object (Message.user({ type: "data", value: { messages: [...] } })), where a question can point at a turn with a backtick path (changes/2026-09-19-jev-state.md D2)`);
    }
    const message = request.messages[0]!;
    if (message.role !== "user") throw this.refuse("messages[0].role", `Jev's state is a user message, got role ${JSON.stringify(message.role)}`);
    if (message.parts.length !== 1) throw this.refuse("messages[0].parts", `Jev's state is one text or data part, got ${message.parts.length} parts; put several pieces in one data part as named keys`);
    return textOrValue(message.parts[0] as TextPart | DataPart);
  }

  protected questions(request: Request): JsonObject {
    const fmt = request.config?.responseFormat;
    if (!fmt || fmt.type !== "json_schema") {
      throw this.refuse(
        "config.response_format",
        "Jev answers declared judgments only; give a json_schema response_format whose properties are enums / booleans / ordered levels (MAP-14), e.g. judgments({...})",
      );
    }
    const found = requestJudgments(request);
    const extra = nonJudgmentProperties(fmt.schema, found);
    if (found.size === 0 || extra.length > 0) {
      const what = extra.length > 0 ? `properties ${JSON.stringify(extra)} are free-form` : "no property declares a judgment";
      throw this.refuse("config.response_format", `${what}; Jev cannot generate values, only pick among declared keys (MAP-14 §1)`);
    }
    const questions: JsonObject = {};
    for (const [name, j] of found) {
      let instruction = j.instruction;
      if (instruction === undefined) {
        adapt(
          `config.response_format.schema.properties.${name}.description`,
          "defaulted",
          "a judgment without a description: the property name goes as the instruction (Jev never sees property names)",
          { applied: name, provider: this.provider },
        );
        instruction = name;
      }
      Object.defineProperty(questions, name, { value: this.question(name, j, instruction), enumerable: true, configurable: true, writable: true });
    }
    return questions;
  }

  private question(name: string, j: Judgment, instruction: string): JsonObject {
    if (j.kind === "boolean") return { type: "noul", instructions: instruction };
    if (j.kind === "choice") {
      if (j.keys.length > MAX_CHOICE_KEYS) throw this.refuse(`config.response_format.schema.properties.${name}`, `a Jev choice takes at most ${MAX_CHOICE_KEYS} keys, got ${j.keys.length}`);
      const criteria: JsonObject = {};
      for (const k of j.keys) Object.defineProperty(criteria, k, { value: j.descriptions[k] ?? null, enumerable: true, configurable: true, writable: true });
      return { type: "choice", instructions: instruction, criteria };
    }
    if (j.keys.length > MAX_ORDERED_LEVELS) throw this.refuse(`config.response_format.schema.properties.${name}`, `a Jev score takes at most ${MAX_ORDERED_LEVELS} levels, got ${j.keys.length}`);
    return { type: "score", instructions: instruction, criteria: j.keys.map((k) => j.descriptions[k] || k) };
  }

  payload(request: Request): JsonObject {
    if (request.tools && request.tools.length > 0) throw this.refuse("tools", "tools have no slot on the systemone wire");
    const cfg = request.config ?? {};
    if (cfg.toolChoice !== undefined) throw this.refuse("config.tool_choice", "tool_choice has no slot on the systemone wire");
    for (const [wire, key] of DROPPED_KNOBS) {
      const value = (cfg as Record<string, unknown>)[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      const asked = FLOAT_KNOBS.has(wire) ? optionalWireFloat(value as number) : typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : stringifyJson(value);
      adapt(`config.${wire}`, "dropped", "no such control on the systemone wire (Jev returns decisions, not samples)", { asked, provider: this.provider });
    }
    const questions = this.questions(request);
    const payload: JsonObject = { model: request.model, state: this.state(request), questions };
    if (cfg.extensions) for (const [k, v] of Object.entries(cfg.extensions)) {
      if (k === "n" && isNumeric(v) && numberValue(v) > 1) throw this.refuse("config.extensions.n", "n > 1 has no canonical multiple-response representation");
      Object.defineProperty(payload, k, { value: v, enumerable: true, configurable: true, writable: true });
    }
    return payload;
  }

  wireRequest(request: Request, stream: boolean): EmitOptions {
    request = this.wireModelRequest(request);
    if (stream) throw this.refuse("stream", "systemone answers in one piece; there is no stream to wrap");
    return { method: "POST", url: `${this.base()}/v1/systemone`, endpoint: "systemone", model: request.model, headers: this.headers(), payload: this.payload(request) };
  }

  // ─── Response parsing (pure) ─────────────────────────────────────

  parseResponse(request: Request, response: HttpResponse): Response {
    request = this.wireModelRequest(request);
    return parseTypeSafeResponse(request, response, this.provider);
  }

  parseStreamEvents(_request: Request, _event: SSEEvent): StreamEvent[] {
    throw this.refuse("stream", "systemone has no stream");
  }

  // ─── Errors ──────────────────────────────────────────────────────

  override normalizeError(status: number, body: string): ProviderError {
    let message = body.trim().slice(0, 500) || `HTTP ${status}`;
    let code: string | null = null;
    let payload: JsonValue | undefined;
    try {
      payload = parseJson(body);
    } catch {
      payload = undefined;
    }
    const detail = isJsonObject(payload) ? payload["detail"] : undefined;
    if (isJsonObject(detail)) {
      code = typeof detail["error_type"] === "string" ? detail["error_type"] : null;
      if (typeof detail["message"] === "string") message = detail["message"];
    } else if (Array.isArray(detail) && detail.length > 0) {
      // pydantic validation: [{type, loc, msg, input}]
      const first = isJsonObject(detail[0]) ? detail[0] : {};
      const loc = (Array.isArray(first["loc"]) ? first["loc"] : []).filter((x) => x !== "body").map(String).join(".");
      message = loc ? `${loc}: ${str(first["msg"]) || "validation error"}` : str(first["msg"]) || message;
    }
    const meta = { provider: this.provider, providerCode: code, status };
    if (status === 401 || code === "authentication_error") return this.withLoginHint(new AuthError(message, { ...meta, envKeys: this.access.envKeys }));
    if (status === 429) return new RateLimitError(message, meta);
    if (status === 400 && message.toLowerCase().includes("unknown model")) return new UnsupportedModelError(message, meta);
    if (status === 400 || status === 422) return new InvalidRequestError(message, meta);
    if (status >= 500) return new ServerError(message, meta);
    return this.withLoginHint(mapHttpError(status, message, { provider: this.provider, envKeys: this.access.envKeys, providerCode: code }));
  }

  // ─── Models ──────────────────────────────────────────────────────

  override modelsRequest(): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/v1/models`, headers: this.headers() });
  }

  override modelsFromBody(body: string): ModelInfo[] {
    const data = parseJson(body);
    return modelInfosFromEntries(isJsonObject(data) ? data["models"] : undefined, { provider: this.provider, apiFamily: "typesafe_systemone", idOf: (e) => e["name"] });
  }
}
