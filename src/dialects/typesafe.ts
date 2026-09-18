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
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json.ts";
import { MAX_CHOICE_KEYS, MAX_ORDERED_LEVELS, nonJudgmentProperties, requestJudgments, type Judgment } from "../judgments.ts";
import type { SSEEvent } from "../stream.ts";
import type { Request } from "../types/config.ts";
import type { ModelInfo } from "../types/model_info.ts";
import { normalizePart, type DataPart, type Message, type Part, type TextPart } from "../types/parts.ts";
import { Response, Usage } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import { HttpResponse, modelInfosFromEntries, type TransportRequest } from "../wire.ts";
import { optionalWireFloat } from "./openai_responses.ts";
import { obj, str } from "./openai_shared.ts";

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

function messageText(message: Message): string | undefined {
  if (message.parts.every((p) => p.type === "text")) return message.parts.map((p) => (p as TextPart).text).join("\n");
  return undefined;
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

  /** D6: one text part → string; one data part → its value; else the conversation object. Media/protocol parts have no wire slot. */
  protected state(request: Request): JsonValue {
    request.messages.forEach((message, mIndex) => {
      message.parts.forEach((part, pIndex) => {
        if (!isTextOrData(part)) throw this.refuse(`messages[${mIndex}].parts[${pIndex}]`, `a ${part.type} part has no slot on the systemone wire (MAP-10); Jev reads text or data`);
      });
    });
    const system = request.system;
    if (Array.isArray(system) && !system.every((p) => isTextOrData(p as Part))) throw this.refuse("system", "system parts must be text or data on the systemone wire");
    if (system === undefined && request.messages.length === 1 && request.messages[0]!.role === "user") {
      const parts = request.messages[0]!.parts;
      if (parts.length === 1) return textOrValue(parts[0] as TextPart | DataPart);
    }
    const state: JsonObject = {};
    if (system !== undefined) state["system"] = typeof system === "string" ? system : (system as readonly Part[]).map((p) => textOrValue(p as TextPart | DataPart));
    state["messages"] = request.messages.map((m) => {
      const text = messageText(m);
      return { role: m.role, content: text !== undefined ? text : m.parts.map((p) => textOrValue(p as TextPart | DataPart)) };
    });
    return state;
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
      questions[name] = this.question(name, j, instruction);
    }
    return questions;
  }

  private question(name: string, j: Judgment, instruction: string): JsonObject {
    if (j.kind === "boolean") return { type: "noul", instructions: instruction };
    if (j.kind === "choice") {
      if (j.keys.length > MAX_CHOICE_KEYS) throw this.refuse(`config.response_format.schema.properties.${name}`, `a Jev choice takes at most ${MAX_CHOICE_KEYS} keys, got ${j.keys.length}`);
      const criteria: JsonObject = {};
      for (const k of j.keys) criteria[k] = j.descriptions[k] ?? null;
      return { type: "choice", instructions: instruction, criteria };
    }
    if (j.keys.length > MAX_ORDERED_LEVELS) throw this.refuse(`config.response_format.schema.properties.${name}`, `a Jev score takes at most ${MAX_ORDERED_LEVELS} levels, got ${j.keys.length}`);
    return { type: "score", instructions: instruction, criteria: j.keys.map((k) => j.descriptions[k] || j.titles[k] || k) };
  }

  payload(request: Request): JsonObject {
    if (request.tools && request.tools.length > 0) throw this.refuse("tools", "tools have no slot on the systemone wire");
    const cfg = request.config ?? {};
    if (cfg.toolChoice !== undefined) throw this.refuse("config.tool_choice", "tool_choice has no slot on the systemone wire");
    for (const [wire, key] of DROPPED_KNOBS) {
      const value = (cfg as Record<string, unknown>)[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      const asked = FLOAT_KNOBS.has(wire) ? optionalWireFloat(value as number) : typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : JSON.stringify(value);
      adapt(`config.${wire}`, "dropped", "no such control on the systemone wire (Jev returns decisions, not samples)", { asked, provider: this.provider });
    }
    const questions = this.questions(request);
    const payload: JsonObject = { model: request.model, state: this.state(request), questions };
    if (cfg.extensions) for (const [k, v] of Object.entries(cfg.extensions)) payload[k] = v;
    return payload;
  }

  wireRequest(request: Request, stream: boolean): EmitOptions {
    if (stream) throw this.refuse("stream", "systemone answers in one piece; there is no stream to wrap");
    return { method: "POST", url: `${this.base()}/v1/systemone`, endpoint: "systemone", model: request.model, headers: this.headers(), payload: this.payload(request) };
  }

  // ─── Response parsing (pure) ─────────────────────────────────────

  parseResponse(request: Request, response: HttpResponse): Response {
    const data = obj(response.json());
    const found = requestJudgments(request);
    const answers = isJsonObject(data["answers"]) ? data["answers"] : {};
    const value: JsonObject = {};
    const probabilities: Record<string, Record<string, number>> = {};
    const unmapped: JsonObject[] = [];
    for (const [name, j] of found) {
      const answer = answers[name];
      if (!isJsonObject(answer)) {
        unmapped.push({ path: `answers.${name}`, detail: "missing" });
        continue;
      }
      const kind = answer["type"];
      if (kind === "noul" && j.kind === "boolean") {
        const p = Number(answer["noul"] ?? 0);
        value[name] = p >= 0.5;
        probabilities[name] = { true: p, false: 1.0 - p };
      } else if (kind === "choice" && j.kind === "choice") {
        value[name] = (answer["choice"] ?? null) as JsonValue;
        const dist = isJsonObject(answer["probabilities"]) ? answer["probabilities"] : {};
        const probs: Record<string, number> = {};
        for (const k of j.keys) probs[k] = Number(dist[k] ?? 0);
        probabilities[name] = probs;
      } else if (kind === "score" && j.kind === "ordered") {
        const dist = isJsonObject(answer["probabilities"]) ? answer["probabilities"] : {};
        const probs: Record<string, number> = {};
        for (const k of j.keys) probs[k] = Number(dist[k] ?? 0);
        probabilities[name] = probs;
        let best = j.keys[0]!;
        for (const k of j.keys) if (probs[k]! > probs[best]!) best = k;
        value[name] = Number(best);
      } else unmapped.push({ path: `answers.${name}`, detail: `unexpected answer type ${JSON.stringify(kind)}` });
    }
    for (const name of Object.keys(answers)) if (!found.has(name)) unmapped.push({ path: `answers.${name}`, detail: "answer to no declared judgment" });
    const measured = Object.keys(probabilities).length > 0;
    const part = normalizePart({ type: "data", value, ...(measured ? { probabilities, method: "provider_classification" } : {}) });
    const usageRaw = isJsonObject(data["usage"]) ? data["usage"] : {};
    const usage = Usage.create({ inputTokens: Number(usageRaw["input_tokens"] ?? 0) || 0, outputTokens: Number(usageRaw["output_tokens"] ?? 0) || 0 });
    const providerData: JsonObject = { typesafe: { answers } };
    if (unmapped.length > 0) providerData["_lm15_unmapped"] = unmapped;
    return new Response({
      id: response.header("x-typesafe-request-id") || undefined,
      model: str(data["model"]) || request.model,
      message: { role: "assistant", parts: [part] },
      finishReason: "stop",
      usage,
      providerData,
    });
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
