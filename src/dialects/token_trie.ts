/**
 * Judgments by candidate-sequence likelihood (MAP-14 §4): the pure half.
 *
 * A server that scores named tokens (compat `tokenScoring:
 * "logprob_token_ids"`; vLLM ≥ 0.29, receipted 2026-09-17) can deliver a
 * distribution over the declared keys of every judgment. The driver in
 * `openai_chat.ts` sequences these hooks like files and batch:
 *
 * 1. two `/tokenize` calls per key plus one per judgment prefill, so the
 *    server's chat template is honoured and the key path is read in
 *    context (terminator included: prefix-free paths);
 * 2. ONE `/v1/completions` call carrying every trie node as a prompt
 *    (token ids), `max_tokens: 1`, `logprob_token_ids` = union of child
 *    tokens; raw log-probs sum along each path, one normalisation.
 */

import { ProviderError, UnsupportedFeatureError } from "../errors.ts";
import { isJsonObject, isNumeric, numberValue, parseJson, type JsonObject } from "../json.ts";
import { Usage } from "../types/response.ts";
import { usageFromChat } from "./openai_shared.ts";
import { nonJudgmentProperties, normalizeLogprobs, requestJudgments, type Judgment } from "../judgments.ts";
import type { Request } from "../types/config.ts";

export const JUDGMENT_PREFILL = "Answer:";

/** Reject harmful omissions before any credential or tokenization call. */
export function validateScoringRequest(request: Request, provider: string): void {
  const refuse = (feature: string, reason: string): never => {
    throw new UnsupportedFeatureError(
      `${provider}: ${reason}; use generated JSON with probabilities='off' or a separate scoring request`,
      { provider, feature },
    );
  };
  const config = request.config ?? {};
  if (request.tools?.length) refuse("tools", "candidate scoring cannot execute tools; the program may depend on their results");
  if (config.toolChoice !== undefined) refuse("config.tool_choice", "candidate scoring cannot preserve tool/action semantics");
  if (config.cache?.resource !== undefined) refuse("config.cache.resource", "candidate scoring cannot read a stored cache object; omitting it would lose prompt content");
  const n = config.extensions?.["n"];
  if (isNumeric(n) && numberValue(n) > 1) refuse("config.extensions.n", "n > 1 has no canonical multiple-response representation");
  for (const [name, value] of [["store", config.store], ["user_id", config.userId], ["service_tier", config.serviceTier]] as const) {
    if (value !== undefined) refuse(`config.${name}`, "measurement endpoints have no established mapping for this privacy, safety or billing control");
  }
  if (config.cache?.mode === "off") refuse("config.cache.mode", "measurement endpoints cannot guarantee cache writes are disabled");
  if (config.cache?.retention !== undefined) refuse("config.cache.retention", "measurement endpoints cannot preserve cache lifetime and billing intent");
  const harmless = new Set(["temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty"]);
  for (const [name, value] of Object.entries(config.extensions ?? {})) {
    const number = isNumeric(value) ? numberValue(value) : NaN;
    if (Number.isFinite(number) && ((name === "n" && number === 1) || harmless.has(name))) continue;
    refuse(`config.extensions.${name}`, "unknown measurement extension semantics; dropping it could lose privacy, money or action controls");
  }
}

export function mixedJudgments(request: Request): boolean {
  const format = request.config?.responseFormat;
  return nonJudgmentProperties(format?.type === "json_schema" ? format.schema : undefined, requestJudgments(request)).length > 0;
}

/** Unknown dimensions propagate; totals remain provider-verbatim. */
export function sumScoringUsage(scoring: Usage, generated: Usage): Usage {
  const sum: Record<string, number> = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "inputAudioTokens", "outputAudioTokens"] as const) {
    const a = scoring[field], b = generated[field];
    if (a !== undefined && b !== undefined) {
      const total = a + b;
      if (!Number.isSafeInteger(total)) throw new ProviderError("combined judgment usage exceeds exact integer range");
      sum[field] = total;
    }
  }
  return Usage.create(sum);
}

/** The judgment's question as the final user turn's text. */
export function judgmentAsk(j: Judgment): string {
  const keys = j.keys.map((k) => {
    const label = j.titles[k];
    const desc = j.descriptions[k];
    const tail = label && desc ? `: ${label} - ${desc}` : label || desc ? `: ${label ?? desc}` : "";
    return `- ${k}${tail}`;
  });
  return `${j.instruction ?? j.name}\nOptions:\n${keys.join("\n")}\nAnswer with the option only, spelled exactly as listed.`;
}

export function tokenizePayload(model: string, messages: JsonObject[], continueFinal: boolean): JsonObject {
  return { model, messages, add_generation_prompt: false, continue_final_message: continueFinal };
}

export function tokensFromBody(body: string): number[] {
  const data = parseJson(body);
  const tokens = isJsonObject(data) ? data["tokens"] : undefined;
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokens.every((t) => typeof t === "number" && Number.isSafeInteger(t) && t >= 0)) throw new ProviderError("malformed judgment reply: tokenize reply carries no non-negative exact integer token list");
  return tokens as number[];
}

export function scorePayload(model: string, prompts: number[][], tokenIds: number[]): JsonObject {
  return { model, prompt: prompts, max_tokens: 1, temperature: 1.0, logprobs: 0, return_tokens_as_token_ids: true, logprob_token_ids: [...tokenIds].sort((a, b) => a - b) };
}

/** Per prompt, `{token_id: logprob}` for the ids the server reported; plus usage and model. */
export function scoresFromBody(body: string, nPrompts: number): { scores: Map<number, number>[]; usage: Usage; model: string | undefined } {
  const invalid = (detail: string) => new ProviderError(`malformed judgment reply: ${detail}`);
  const data = parseJson(body);
  if (!isJsonObject(data)) throw invalid("expected an object");
  const raw = data["choices"];
  if (!Array.isArray(raw) || raw.length !== nPrompts || raw.some(c => !isJsonObject(c) || typeof c["index"] !== "number" || !Number.isSafeInteger(c["index"]) || c["index"] < 0 || c["index"] >= nPrompts)) {
    throw invalid("choices must contain every prompt index exactly once");
  }
  const choices = (raw as JsonObject[]).slice().sort((a, b) => Number(a["index"]) - Number(b["index"]));
  if (choices.some((c, index) => c["index"] !== index)) throw invalid("choices must contain every prompt index exactly once");
  const scores = choices.map((choice) => {
    const logprobs = choice["logprobs"] ?? {};
    if (!isJsonObject(logprobs)) throw invalid("logprobs must be an object or null");
    const tops = logprobs["top_logprobs"];
    let top: JsonObject = {};
    if (tops != null && !(Array.isArray(tops) && tops.length === 0)) {
      if (!Array.isArray(tops) || tops.length !== 1 || (tops[0] !== null && !isJsonObject(tops[0]))) throw invalid("expected one top_logprobs object");
      top = (tops[0] as JsonObject | null) ?? {};
    }
    const out = new Map<number, number>();
    for (const [token, value] of Object.entries(top)) {
      if (!token.startsWith("token_id:") || !/^\d+$/.test(token.slice(9))) continue;
      const id = Number(token.slice(9));
      if (!Number.isSafeInteger(id) || !isNumeric(value)) throw invalid(`invalid token score for ${token}`);
      const score = numberValue(value);
      if (Number.isNaN(score) || score > 0) throw invalid(`invalid log probability for ${token}`);
      out.set(id, score);
    }
    return out;
  });
  const usageRaw = data["usage"] ?? {};
  if (!isJsonObject(usageRaw)) throw invalid("usage must be an object or null");
  for (const name of ["prompt_tokens_details", "completion_tokens_details"]) {
    if (usageRaw[name] != null && !isJsonObject(usageRaw[name])) throw invalid(`${name} must be an object or null`);
  }
  let usage: Usage;
  try { usage = usageFromChat(usageRaw); }
  catch (cause) { throw new ProviderError("malformed judgment reply: invalid usage", { cause }); }
  const model = data["model"];
  if (model != null && (typeof model !== "string" || !model)) throw invalid("model must be a non-empty string");
  return { scores, usage, model: model ?? undefined };
}

const startsWith = (seq: readonly number[], prefix: readonly number[]): boolean => prefix.every((t, i) => seq[i] === t);

/** Each key's token path after the prefill, terminator included. */
export function keyPaths(prefix: readonly number[], keys: ReadonlyMap<string, readonly [number[], number[]]>): Map<string, number[]> {
  const paths = new Map<string, number[]>();
  for (const [key, [open, closed]] of keys) {
    if (!startsWith(open, prefix) || !startsWith(closed, open)) {
      throw new UnsupportedFeatureError(
        `openai-chat: key ${JSON.stringify(key)} does not tokenize as an extension of the prefill in this chat template; candidate-sequence scoring cannot place it (rename the key or use a provider that classifies natively)`,
        { provider: "openai-chat", feature: "config.response_format" },
      );
    }
    const body = open.slice(prefix.length);
    const terminator = closed.slice(open.length, open.length + 1);
    if (body.length === 0 || terminator.length === 0) {
      throw new UnsupportedFeatureError(`openai-chat: key ${JSON.stringify(key)} yields no scorable tokens (empty key or no end-of-turn token in the template)`, {
        provider: "openai-chat",
        feature: "config.response_format",
      });
    }
    paths.set(key, [...body, ...terminator]);
  }
  return paths;
}

export const nodeKey = (prefix: readonly number[]): string => prefix.join(",");

/** Every trie node (a path prefix) → the set of child tokens the model may write next. */
export function trieNodes(paths: ReadonlyMap<string, readonly number[]>): Map<string, { prefix: number[]; children: Set<number> }> {
  const nodes = new Map<string, { prefix: number[]; children: Set<number> }>();
  for (const seq of paths.values()) {
    for (let i = 0; i < seq.length; i++) {
      const prefix = seq.slice(0, i);
      const key = nodeKey(prefix);
      let node = nodes.get(key);
      if (!node) {
        node = { prefix, children: new Set() };
        nodes.set(key, node);
      }
      node.children.add(seq[i]!);
    }
  }
  return nodes;
}

/** Raw log-probs summed along each path, one normalisation over the key set; `coverage` = the raw mass on the key set. */
export function foldJudgment(paths: ReadonlyMap<string, readonly number[]>, table: ReadonlyMap<string, ReadonlyMap<number, number>>): { distribution: Record<string, number>; coverage: number } {
  const raw: Record<string, number> = {};
  for (const [key, seq] of paths) {
    let total = 0;
    for (let i = 0; i < seq.length; i++) total += table.get(nodeKey(seq.slice(0, i)))!.get(seq[i]!)!;
    Object.defineProperty(raw, key, { value: total, enumerable: true });
  }
  const values = Object.values(raw);
  if (values.some(Number.isNaN) || !values.some(Number.isFinite)) throw new ProviderError("malformed judgment reply: every declared key has zero or unknown likelihood; cannot normalize");
  const coverage = values.reduce((n, v) => n + Math.exp(v), 0);
  return { distribution: normalizeLogprobs(raw), coverage };
}
