/**
 * Judgments by candidate-sequence likelihood (MAP-14 §4): the pure half.
 *
 * A server that scores named tokens (compat `tokenScoring:
 * "logprob_token_ids"`; vLLM ≥ 0.29, receipted 2026-09-17) can deliver a
 * distribution over the declared keys of every judgment. The driver in
 * `openai_chat.ts` sequences these hooks like files and batch:
 *
 * 1. one `/tokenize` per (judgment, key) and per judgment prefill, so the
 *    server's chat template is honoured and the key path is read in
 *    context (terminator included: prefix-free paths);
 * 2. ONE `/v1/completions` call carrying every trie node as a prompt
 *    (token ids), `max_tokens: 1`, `logprob_token_ids` = union of child
 *    tokens; raw log-probs sum along each path, one normalisation.
 */

import { UnsupportedFeatureError } from "../errors.ts";
import { isJsonObject, parseJson, type JsonObject } from "../json.ts";
import { normalizeLogprobs, type Judgment } from "../judgments.ts";
import { ValueError } from "../types/validate.ts";

export const JUDGMENT_PREFILL = "Answer:";

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
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "number" && Number.isInteger(t))) throw new ValueError("tokenize reply carries no integer token list");
  return tokens as number[];
}

export function scorePayload(model: string, prompts: number[][], tokenIds: number[]): JsonObject {
  return { model, prompt: prompts, max_tokens: 1, temperature: 1.0, logprobs: 0, return_tokens_as_token_ids: true, logprob_token_ids: [...tokenIds].sort((a, b) => a - b) };
}

/** Per prompt, `{token_id: logprob}` for the ids the server reported; plus usage and model. */
export function scoresFromBody(body: string, nPrompts: number): { scores: Map<number, number>[]; usage: JsonObject; model: string | undefined } {
  const data = parseJson(body);
  const raw = isJsonObject(data) && Array.isArray(data["choices"]) ? data["choices"] : [];
  const choices = raw.filter(isJsonObject).sort((a, b) => Number(a["index"] ?? 0) - Number(b["index"] ?? 0));
  if (choices.length !== nPrompts) throw new ValueError(`completions reply has ${choices.length} choices for ${nPrompts} prompts`);
  const scores = choices.map((choice) => {
    const logprobs = isJsonObject(choice["logprobs"]) ? choice["logprobs"] : {};
    const tops = Array.isArray(logprobs["top_logprobs"]) ? logprobs["top_logprobs"] : [];
    const top = isJsonObject(tops[0]) ? tops[0] : {};
    const out = new Map<number, number>();
    for (const [token, value] of Object.entries(top)) {
      if (token.startsWith("token_id:") && /^\d+$/.test(token.slice(9))) out.set(Number(token.slice(9)), Number(value));
    }
    return out;
  });
  const usage = isJsonObject(data) && isJsonObject(data["usage"]) ? data["usage"] : {};
  const model = isJsonObject(data) && typeof data["model"] === "string" ? data["model"] : undefined;
  return { scores, usage, model };
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
    raw[key] = total;
  }
  const coverage = Object.values(raw).reduce((n, v) => n + Math.exp(v), 0);
  return { distribution: normalizeLogprobs(raw), coverage };
}
