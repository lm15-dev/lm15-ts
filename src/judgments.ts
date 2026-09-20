/**
 * Judgments: declared keys in, a distribution out (MAP-14;
 * changes/2026-09-17-judgments.md). A judgment is a top-level property of
 * a `json_schema` `response_format` that declares its answer set: a
 * boolean, a string `enum` / `anyOf`-of-`const`, or an ordered integer
 * `enum` / `anyOf`-of-`const` `0..n-1`. This module reads that convention
 * off a schema (§1), rewrites judgment properties for the two wires that
 * need it (§2), folds a model's JSON text into a `DataPart` (§3), and
 * offers the sugar that EMITS the convention (`choice`, `yesNo`, `score`,
 * `judgments`) the way `tool(...)` emits a tool schema. Nothing here
 * touches the network.
 */

import { adapt } from "./adaptation.ts";
import { ProviderError, UnsupportedFeatureError, responseErrorMetadata } from "./errors.ts";
import { RawNumber, isJsonObject, isNumeric, numberValue, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import type { Request, ResponseFormat } from "./types/config.ts";
import { normalizePart, type DataPart, type Part, type TextPart } from "./types/parts.ts";
import { Response, Usage } from "./types/response.ts";
import { ValueError, requireBool, requireJsonObject, requireString } from "./types/validate.ts";
import type { HttpResponse } from "./wire.ts";

export type JudgmentKind = "boolean" | "choice" | "ordered";

/** Jev's Score ceiling (docs.typesafe.ai/primitives/score). */
export const MAX_ORDERED_LEVELS = 10;
/** Jev's Choice ceiling (docs.typesafe.ai/primitives/choice). */
export const MAX_CHOICE_KEYS = 255;

/** One declared judgment read off a schema property. */
export interface Judgment {
  readonly name: string;
  readonly kind: JudgmentKind;
  readonly keys: readonly string[];
  /** The property's `description`: the question. */
  readonly instruction: string | undefined;
  readonly descriptions: Readonly<Record<string, string | undefined>>;
  readonly titles: Readonly<Record<string, string | undefined>>;
}

export function isOrdered(j: Judgment): boolean {
  return j.kind === "ordered";
}

// ─── §1 reading the convention ──────────────────────────────────────

function constBranches(prop: JsonObject): JsonObject[] | undefined {
  const branches = prop["anyOf"];
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  if (!branches.every((b) => isJsonObject(b) && "const" in b)) return undefined;
  return branches as JsonObject[];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function judgmentOf(name: string, prop: unknown): Judgment | undefined {
  if (!isJsonObject(prop)) return undefined;
  const instruction = optionalText(prop["description"]);
  if (prop["type"] === "boolean") {
    return { name, kind: "boolean", keys: ["true", "false"], instruction, descriptions: { true: undefined, false: undefined }, titles: {} };
  }
  const enumValues = prop["enum"];
  const branches = constBranches(prop);
  let values: JsonValue[];
  const descs: Record<string, string | undefined> = Object.create(null);
  const titles: Record<string, string | undefined> = Object.create(null);
  if (Array.isArray(enumValues) && enumValues.length > 0 && branches === undefined) {
    values = enumValues;
  } else if (branches !== undefined && enumValues === undefined) {
    values = branches.map((b) => b["const"] as JsonValue);
    for (const b of branches) {
      const key = String(b["const"]);
      descs[key] = optionalText(b["description"]);
      titles[key] = optionalText(b["title"]);
    }
  } else return undefined;
  if (values.every((v) => typeof v === "string" && v !== "")) {
    if (prop["type"] !== undefined && prop["type"] !== "string") return undefined;
    const keys = values as string[];
    if (new Set(keys).size !== keys.length) return undefined;
    return { name, kind: "choice", keys, instruction, descriptions: pick(descs, keys), titles: pick(titles, keys) };
  }
  if (values.every((v) => typeof v === "number" && Number.isInteger(v))) {
    if (prop["type"] !== undefined && prop["type"] !== "integer") return undefined;
    if (values.length < 2 || !values.every((v, i) => v === i)) return undefined;
    const keys = values.map((v) => String(v));
    return { name, kind: "ordered", keys, instruction, descriptions: pick(descs, keys), titles: pick(titles, keys) };
  }
  return undefined;
}

function pick(map: Record<string, string | undefined>, keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, Object.hasOwn(map, k) ? map[k] : undefined]));
}

/**
 * The judgments a json_schema declares, in property order (MAP-14 §1). Any
 * property that is not one of the three shapes is ordinary structured
 * output and is absent from the result.
 */
export function judgmentsInSchema(schema: unknown): Map<string, Judgment> {
  const out = new Map<string, Judgment>();
  if (!isJsonObject(schema) || (schema["type"] !== undefined && schema["type"] !== "object")) return out;
  const props = schema["properties"];
  if (!isJsonObject(props)) return out;
  for (const [name, prop] of Object.entries(props)) {
    const j = judgmentOf(name, prop);
    if (j) out.set(name, j);
  }
  return out;
}

export function requestJudgments(request: Request): Map<string, Judgment> {
  const fmt = request.config?.responseFormat;
  if (!fmt || fmt.type !== "json_schema") return new Map();
  return judgmentsInSchema(fmt.schema);
}

export function nonJudgmentProperties(schema: unknown, found: ReadonlyMap<string, Judgment>): string[] {
  const props = isJsonObject(schema) ? schema["properties"] : undefined;
  if (!isJsonObject(props)) return [];
  return Object.keys(props).filter((name) => !found.has(name));
}

// ─── §2 what a wire that measures nothing does with `probabilities` ─

/** MAP-14 §3 on a wire with no distribution: `if_available` records `dropped`; `required` refuses before the wire (MAP-13 b). */
export function noteUnmeasurableProbabilities(request: Request, provider: string): void {
  const policy = request.config?.probabilities;
  if (policy == null || policy === "off" || requestJudgments(request).size === 0) return;
  if (policy === "required") {
    throw new UnsupportedFeatureError(
      `${provider}: config.probabilities='required' but this wire cannot measure a distribution over the declared keys (it returns a pick only); use 'if_available' or a provider that can (typesafe, or a vLLM/SGLang server that honours logprob_token_ids)`,
      { provider, feature: "config.probabilities" },
    );
  }
  adapt("config.probabilities", "dropped", "this wire cannot measure a distribution over the declared keys; the answer carries the pick only", { asked: policy, provider });
}

function deepCopy<T extends JsonValue>(value: T): T {
  // INV-002/INV-050: opaque numbers keep their lexemes; native JSON
  // serialization deliberately throws for RawNumber. Clone containers too,
  // so a wire rewrite cannot mutate the caller's schema or branch objects.
  if (value instanceof RawNumber) return new RawNumber(value.raw) as T;
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as T;
  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopy(item)])) as T;
  return value;
}

/**
 * A judgment property carrying both `type` and `anyOf` has its type moved
 * into every branch: the Messages wire answers 400 "For 'anyOf', 'type' is
 * not supported" otherwise (receipted 2026-09-17). Every other keyword
 * stays verbatim (INV-050 exception).
 */
export function anthropicSchema(schema: JsonObject, found: ReadonlyMap<string, Judgment>): JsonObject {
  if (found.size === 0) return schema;
  const out = deepCopy(schema);
  const props = out["properties"] as JsonObject;
  for (const name of found.keys()) {
    const prop = props[name] as JsonObject;
    const branches = prop["anyOf"];
    if ("type" in prop && Array.isArray(branches)) {
      const kind = prop["type"];
      delete prop["type"];
      for (const b of branches) if (isJsonObject(b) && !("type" in b)) b["type"] = kind as JsonValue;
    }
  }
  return out;
}

/**
 * Judgment properties go as `enum` with the per-key descriptions folded
 * into the property description: `responseJsonSchema` ignores
 * `anyOf`/`const` (it answered "Bordeaux-blend" for a declared set;
 * receipted 2026-09-17) and honours `enum`.
 */
export function geminiSchema(schema: JsonObject, found: ReadonlyMap<string, Judgment>): JsonObject {
  if (found.size === 0) return schema;
  const out = deepCopy(schema);
  const props = out["properties"] as JsonObject;
  for (const [name, j] of found) {
    const prop = props[name] as JsonObject;
    if (j.kind === "boolean" || !("anyOf" in prop)) continue;
    delete prop["anyOf"];
    prop["type"] = isOrdered(j) ? "integer" : "string";
    prop["enum"] = isOrdered(j) ? j.keys.map((k) => Number(k)) : [...j.keys];
    const lines: string[] = [];
    for (const k of j.keys) {
      const label = j.titles[k];
      const desc = j.descriptions[k];
      if (label === undefined && desc === undefined) {
        lines.push(k); // a bare key still tells the model it is an option (receipted wire form)
        continue;
      }
      lines.push(`${k} = ` + (label && desc ? `${label}: ${desc}` : (label ?? desc ?? "")));
    }
    if (j.keys.some((k) => j.titles[k] || j.descriptions[k])) {
      const head = typeof prop["description"] === "string" ? prop["description"] : "";
      prop["description"] = (head + (head ? " " : "") + (isOrdered(j) ? "Levels: " : "Options: ") + lines.join("; ")).trim();
    }
  }
  return out;
}

// ─── §3 the answer ──────────────────────────────────────────────────

/** The model's JSON object as a DataPart (value only), or undefined when the text is not a JSON object (a truncated answer stays a TextPart). */
export function dataPartFromText(text: string, found: ReadonlyMap<string, Judgment>): DataPart | undefined {
  if (found.size === 0) return undefined;
  let value: JsonValue;
  try {
    value = parseJson(text.trim());
  } catch {
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  return normalizePart({ type: "data", value }) as DataPart;
}

/** Swap the single text part of a judgment answer for its DataPart. */
export function replaceTextWithData(parts: readonly Part[], found: ReadonlyMap<string, Judgment>): readonly Part[] {
  if (found.size === 0) return parts;
  const texts = parts.filter((p): p is TextPart => p.type === "text");
  if (texts.length !== 1) return parts;
  const text = texts[0]!;
  let part = dataPartFromText(text.text, found);
  if (!part) return parts;
  if (text.continuation && text.continuation.length > 0) part = normalizePart({ type: "data", value: part.value, continuation: text.continuation }) as DataPart;
  return parts.map((p) => (p === text ? part! : p));
}

/** Softmax over log-scores: one normalisation over the key set. */
export function normalizeLogprobs(scores: Readonly<Record<string, number>>): Record<string, number> {
  const top = Math.max(...Object.values(scores));
  const weights: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(scores)) {
    const weight = Math.exp(v - top);
    Object.defineProperty(weights, k, { value: weight, enumerable: true });
    total += weight;
  }
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(weights)) Object.defineProperty(out, k, { value: w / total, enumerable: true });
  return out;
}

export function expectedLevel(distribution: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [k, p] of Object.entries(distribution)) total += p * Number(k);
  return total;
}

/**
 * Fold a native TypeSafe reply without fabricating measurements (MAP-14).
 * Kept pure so the dialect and callers of its buffered parser use the same
 * validation. INV-052 deliberately does NOT validate or normalize sums.
 */
export function parseTypeSafeResponse(request: Request, response: HttpResponse, provider = "typesafe"): Response {
  const requestId = response.header("x-typesafe-request-id") || undefined;
  const invalid = (path: string, detail: string, cause?: unknown): ProviderError => new ProviderError(
    `malformed systemone reply at ${path}: ${detail}`,
    { ...responseErrorMetadata(response, provider), cause },
  );
  let data: JsonValue;
  try {
    data = response.json();
  } catch (cause) {
    if (cause instanceof ProviderError) {
      (cause as { provider: string | null }).provider ??= provider;
      throw cause;
    }
    const excerpt = new TextDecoder().decode(response.body.subarray(0, 200));
    throw new ProviderError(`expected JSON; content-type=${response.header("content-type") ?? "<absent>"}; first 200 bytes=${JSON.stringify(excerpt)}`, {
      ...responseErrorMetadata(response, provider), bodyExcerpt: excerpt, cause,
    });
  }
  if (!isJsonObject(data)) throw invalid("$", "expected an object");
  const found = requestJudgments(request);
  const answers = data["answers"];
  if (!isJsonObject(answers)) throw invalid("answers", "expected an object containing every declared judgment");
  if (Object.keys(answers).length !== found.size || [...found.keys()].some((name) => !Object.hasOwn(answers, name))) {
    throw invalid("answers", "keys must match the declared judgments exactly");
  }
  const probability = (raw: unknown, path: string): number => {
    if (!isNumeric(raw)) throw invalid(path, "expected a finite number in [0, 1]");
    const p = numberValue(raw);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw invalid(path, "expected a finite number in [0, 1]");
    return p;
  };
  const values: Array<[string, JsonValue]> = [];
  const distributions: Array<[string, Record<string, number>]> = [];
  for (const [name, j] of found) {
    const answer = answers[name];
    const path = `answers.${name}`;
    if (!isJsonObject(answer)) throw invalid(path, "expected an answer object");
    const expected = j.kind === "boolean" ? "noul" : j.kind === "choice" ? "choice" : "score";
    if (answer["type"] !== expected) throw invalid(`${path}.type`, `expected ${JSON.stringify(expected)}`);
    if (j.kind === "boolean") {
      const p = probability(answer["noul"], `${path}.noul`);
      values.push([name, p >= 0.5]);
      distributions.push([name, { true: p, false: 1 - p }]);
      continue;
    }
    const raw = answer["probabilities"];
    if (!isJsonObject(raw) || Object.keys(raw).length !== j.keys.length || j.keys.some((key) => !Object.hasOwn(raw, key))) {
      throw invalid(`${path}.probabilities`, "expected one probability for every declared key, and no other keys");
    }
    const probs = Object.fromEntries(j.keys.map((key) => [key, probability(raw[key], `${path}.probabilities.${key}`)]));
    distributions.push([name, probs]);
    if (j.kind === "choice") {
      const chosen = answer["choice"];
      if (typeof chosen !== "string" || !j.keys.includes(chosen)) throw invalid(`${path}.choice`, "expected a declared choice key");
      values.push([name, chosen]);
    } else {
      // The first declared level wins a tie; Jev's score is an expectation,
      // not a chosen level, and stays verbatim in provider_data.
      let best = j.keys[0]!;
      for (const key of j.keys) if (probs[key]! > probs[best]!) best = key;
      values.push([name, Number(best)]);
    }
  }
  const usageRaw = data["usage"] ?? {};
  if (!isJsonObject(usageRaw)) throw invalid("usage", "expected an object or null");
  let usage: Usage;
  try {
    usage = Usage.create({ inputTokens: usageRaw["input_tokens"], outputTokens: usageRaw["output_tokens"] });
  } catch (cause) {
    if (!(cause instanceof TypeError || cause instanceof ValueError)) throw cause;
    throw invalid("usage", cause.message, cause);
  }
  const model = data["model"];
  if (model != null && (typeof model !== "string" || model === "")) throw invalid("model", "expected a non-empty string");
  try {
    const part = normalizePart({
      type: "data", value: Object.fromEntries(values),
      ...(distributions.length > 0 ? { probabilities: Object.fromEntries(distributions), method: "provider_classification" } : {}),
    });
    return new Response({
      id: requestId, model: model ?? request.model,
      message: { role: "assistant", parts: [part] }, finishReason: "stop", usage,
      providerData: { typesafe: { answers } },
    });
  } catch (cause) {
    if (!(cause instanceof TypeError || cause instanceof ValueError)) throw cause;
    throw invalid("answers", cause.message, cause);
  }
}

// ─── §4 sugar that emits the convention ─────────────────────────────

/** A choice judgment property: `{key: description-or-undefined}` or a list of keys. */
export function choice(instruction: string, options: Readonly<Record<string, string | null | undefined>> | readonly string[]): JsonObject {
  requireString(instruction, "choice instruction");
  if (!Array.isArray(options) && !isJsonObject(options)) throw new TypeError("choice options must be a mapping or a list of keys");
  const items: Array<[string, string | undefined]> = Array.isArray(options)
    ? Array.from(options as readonly string[], (k): [string, undefined] => [k, undefined])
    : Object.entries(options as Record<string, string | null | undefined>).map(([k, d]) => [k, d ?? undefined]);
  if (items.length === 0) throw new ValueError("choice needs at least one option");
  if (items.some(([k]) => typeof k !== "string" || k === "")) throw new TypeError("choice option keys must be non-empty strings");
  if (new Set(items.map(([k]) => k)).size !== items.length) throw new ValueError("choice option keys must be unique");
  for (const [key, description] of items) if (description !== undefined) requireString(description, `choice option ${JSON.stringify(key)} description`);
  const prop: JsonObject = { type: "string", description: instruction };
  if (items.every(([, d]) => d === undefined)) prop["enum"] = items.map(([k]) => k);
  else prop["anyOf"] = items.map(([k, d]) => (d ? { const: k, description: d } : { const: k }));
  return prop;
}

export function yesNo(instruction: string): JsonObject {
  return { type: "boolean", description: requireString(instruction, "yesNo instruction") };
}

/** An ordered judgment: levels low → high; `{name: description}` or a list of descriptions. */
export function score(instruction: string, levels: Readonly<Record<string, string>> | readonly string[]): JsonObject {
  requireString(instruction, "score instruction");
  if (!Array.isArray(levels) && !isJsonObject(levels)) throw new TypeError("score levels must be a mapping or a list of descriptions");
  const items: Array<[string | undefined, string]> = Array.isArray(levels)
    ? Array.from(levels as readonly string[], (d): [undefined, string] => [undefined, d])
    : Object.entries(levels as Record<string, string>);
  if (items.length < 2) throw new ValueError("score needs at least two levels");
  if (items.length > MAX_ORDERED_LEVELS) throw new ValueError(`score takes at most ${MAX_ORDERED_LEVELS} levels`);
  const branches = items.map(([name, desc], i) => {
    requireString(desc, `score level ${i} description`);
    const b: JsonObject = { const: i };
    if (name) b["title"] = name;
    if (desc) b["description"] = desc;
    return b;
  });
  return { type: "integer", description: instruction, anyOf: branches };
}

/** The `response_format` `judgments()` emits: a `json_schema` whose properties are judgments, typed so it drops straight into `Config.responseFormat`. */
export type JudgmentsFormat = Extract<ResponseFormat, { type: "json_schema" }> & { readonly name: string; readonly strict: boolean };

/** A `response_format` declaring the given judgment properties. */
export function judgments(properties: Readonly<Record<string, JsonObject>>, opts: { name?: string; strict?: boolean } = {}): JudgmentsFormat {
  requireJsonObject(properties, "judgments properties");
  const names = Object.keys(properties);
  if (names.length === 0) throw new ValueError("judgments needs at least one property");
  for (const name of names) requireJsonObject(properties[name], `judgments property ${JSON.stringify(name)}`);
  if (!isJsonObject(opts)) throw new TypeError("judgments options must be an object");
  const name = opts.name === undefined ? "judgments" : requireString(opts.name, "judgments name", false);
  const strict = opts.strict === undefined ? true : requireBool(opts.strict, "judgments strict");
  const schema: JsonObject = { type: "object", properties: { ...properties }, required: names, additionalProperties: false };
  return { type: "json_schema", name, strict, schema };
}
