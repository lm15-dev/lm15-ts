/**
 * `Adaptation` (spec/types.md § Adaptation; MAP-13): one record of the wire
 * getting something other than what was asked. Produced by request building,
 * carried by `Response.adaptations` and `StreamStartEvent.adaptations`,
 * previewed by `plan(request)`. Translations — the adapter's ordinary job —
 * are never recorded; a record exists only where the wire got something
 * different.
 */

import { canonicalFactory } from "../canonical.ts";
import { omitEmpty, type JsonObject, type JsonValue } from "../json.ts";
import { ADAPTATION_ACTIONS, type AdaptationAction } from "../vocab.ts";
import { absent, compact, frozen, requireOneOf, requireString } from "./validate.ts";

export interface Adaptation {
  /** The config path: `config.seed`, `config.reasoning.summary`, `config.tool_choice.allowed`, `label`. */
  readonly field: string;
  readonly action: AdaptationAction;
  /** One sentence naming the provider fact; the port's own wording, never pinned. */
  readonly reason: string;
  /** What the caller set; absent for `defaulted`. */
  readonly asked?: JsonValue;
  /** What went to the wire; absent for `dropped` and `satisfied`. */
  readonly applied?: JsonValue;
}

export const normalizeAdaptation = canonicalFactory("adaptation", normalizeAdaptationValue);
function normalizeAdaptationValue(input: unknown): Adaptation {
  if (typeof input !== "object" || input === null) throw new TypeError("Adaptation must be an object");
  const d = input as Record<string, unknown>;
  return frozen(
    compact({
      field: requireString(d["field"], "Adaptation.field", false),
      action: requireOneOf(ADAPTATION_ACTIONS, d["action"], "adaptation action"),
      reason: requireString(d["reason"], "Adaptation.reason", false),
      asked: absent(d["asked"]) ? undefined : (d["asked"] as JsonValue),
      applied: absent(d["applied"]) ? undefined : (d["applied"] as JsonValue),
    }),
  );
}

export const Adaptation = {
  create: normalizeAdaptation,
  fromJSON(d: JsonObject): Adaptation {
    return normalizeAdaptation({ field: d["field"], action: d["action"], reason: d["reason"], asked: d["asked"], applied: d["applied"] });
  },
  toJSON(a: Adaptation): JsonObject {
    return omitEmpty({ field: a.field, action: a.action, reason: a.reason, asked: a.asked, applied: a.applied });
  },
};

export function adaptationsToJSON(list: readonly Adaptation[] | undefined): JsonObject[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map(Adaptation.toJSON);
}

export function adaptationsFromJSON(value: JsonValue | undefined): readonly Adaptation[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) throw new TypeError("adaptations must be a list");
  const list = value.map((x) => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) throw new TypeError("adaptations must contain Adaptation objects");
    return Adaptation.fromJSON(x as JsonObject);
  });
  return list.length > 0 ? Object.freeze(list) : undefined;
}

export function normalizeAdaptations(value: unknown, where: string): readonly Adaptation[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${where} must be a list of Adaptation`);
  if (value.length === 0) return undefined;
  return Object.freeze(value.map((x) => normalizeAdaptation(x)));
}
