/**
 * MAP-13 — adapt freely, never invisibly; refuse only when a guess could hurt.
 *
 * lm15 makes two promises, ranked: first, change the model or provider
 * string and the program keeps working; second, never change what the
 * caller asked for. The second is kept by VISIBILITY, not refusal. When a
 * wire cannot take a setting as asked, the adapter does the obvious thing
 * and records it here; the record rides `Response.adaptations` and
 * `StreamStartEvent.adaptations`, and `lm.plan(request)` previews it with
 * no network.
 *
 * The policy (`AdaptationPolicy`) is set on the LM (`adaptations`) and on
 * `RouterConfig`:
 *
 * - `"note"` (default): adapt and record.
 * - `"silent"`: adapt exactly as `"note"` does; the response carries no
 *   record. The policy never changes what goes to the wire or what lm15
 *   does after it.
 * - `"refuse"`: every DEVIATION — `dropped`, `clamped`, `substituted`,
 *   `client_side` — is an `UnsupportedFeatureError` before the wire (the
 *   pre-2026-09-14 behaviour), carrying `feature` = the config path so a
 *   policy layer can act without parsing prose. `satisfied` and
 *   `defaulted` change nothing the caller asked for and are recorded under
 *   every policy but `"silent"`.
 *
 * Nothing here prints. The record is data on the response.
 *
 * How the record reaches the response without threading a parameter
 * through every builder: `collecting(scope, fn)` runs one SYNCHRONOUS
 * payload build with the scope installed; `adapt(...)` inside a builder
 * appends to it. Every dialect's `payload()` is synchronous (credential
 * resolution and signing happen afterwards, in `emit`), so the slot is
 * never shared across an `await` — the same discipline React uses for its
 * hook dispatcher. `collecting` refuses a function that returns a promise,
 * so the discipline is checked, not assumed. A builder called with no
 * scope open (a unit test, a bare `payload()` call) adapts under `"note"`
 * and the record is simply not kept.
 *
 * Trade-off, stated: an explicit recorder parameter would be more visible
 * than a module slot; it would also touch every helper between the LM and
 * the adaptation site (some forty signatures). The slot with a synchronous
 * guard keeps the builders readable and cannot leak across concurrent
 * builds; `AsyncLocalStorage` was rejected because the browser entry has no
 * `node:async_hooks`.
 */

import { UnsupportedFeatureError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import { normalizeAdaptation, type Adaptation } from "./types/adaptation.ts";
import { ValueError } from "./types/validate.ts";
import { ADAPTATION_POLICIES, REASONING_EFFORTS, type AdaptationAction, type AdaptationPolicy } from "./vocab.ts";

export type { Adaptation, AdaptationAction, AdaptationPolicy };

/** The actions that change what the caller asked for; `"refuse"` refuses these. */
export const DEVIATIONS: ReadonlySet<AdaptationAction> = new Set<AdaptationAction>(["dropped", "clamped", "substituted", "client_side"]);

export function checkPolicy(value: unknown): AdaptationPolicy {
  if (!(ADAPTATION_POLICIES as readonly unknown[]).includes(value)) {
    throw new ValueError(`adaptations must be one of ${ADAPTATION_POLICIES.map((p) => JSON.stringify(p)).join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as AdaptationPolicy;
}

export class AdaptationScope {
  readonly records: Adaptation[] = [];
  readonly policy: AdaptationPolicy;
  readonly provider: string | undefined;
  /** `plan()`: the wire request is built and discarded — no credential is invoked. */
  readonly planning: boolean;

  constructor(policy: AdaptationPolicy, provider: string | undefined, planning = false) {
    this.policy = policy;
    this.provider = provider;
    this.planning = planning;
  }
}

let current: AdaptationScope | undefined;

/**
 * Run one synchronous build with `scope` installed. Nested scopes are
 * independent; the outer scope is restored on every exit.
 */
export function collecting<T>(scope: AdaptationScope, fn: () => T): T {
  const outer = current;
  current = scope;
  let result: T;
  try {
    result = fn();
  } finally {
    current = outer;
  }
  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    throw new TypeError("collecting() takes a synchronous build; an async build would share the scope across awaits");
  }
  return result;
}

const ACTION_VERB: Readonly<Record<AdaptationAction, string>> = Object.freeze({
  dropped: "would be dropped",
  clamped: "would be clamped",
  substituted: "would be substituted",
  client_side: "would be applied client-side",
  satisfied: "is already satisfied here",
  defaulted: "would be defaulted",
});

export interface AdaptOptions {
  readonly asked?: JsonValue | undefined;
  readonly applied?: JsonValue | undefined;
  readonly provider?: string | undefined;
  /** An explicit policy for a builder that runs outside a scope (a batch ticket has no adaptations field). */
  readonly policy?: AdaptationPolicy | undefined;
}

/**
 * Record one adaptation in the open scope, or throw under `"refuse"`.
 *
 * Builders call this at the point where they would have thrown before
 * MAP-13, then do the adapted thing. The message under `"refuse"` is the
 * same sentence the note carries, so the two policies never say different
 * things about the same fact.
 */
export function adapt(field: string, action: AdaptationAction, reason: string, opts: AdaptOptions = {}): void {
  const scope = current;
  const policy: AdaptationPolicy = opts.policy ?? scope?.policy ?? "note";
  const who = opts.provider ?? scope?.provider;
  if (policy === "refuse" && DEVIATIONS.has(action)) {
    const head = who ? `${who}: ` : "";
    throw new UnsupportedFeatureError(`${head}${field} ${ACTION_VERB[action]}: ${reason} (adaptations='refuse')`, { provider: who, feature: field });
  }
  if (!scope) return;
  // Every policy records into the scope: the adapter's own behaviour (a
  // client-side stop, a narrowed tool list) is read from these records, so
  // "silent" must not empty them — it hides them on the response instead.
  scope.records.push(normalizeAdaptation({ field, action, reason, asked: opts.asked, applied: opts.applied }));
}

export function currentPolicy(): AdaptationPolicy {
  return current?.policy ?? "note";
}

/** True inside `plan()`: the build's bytes are discarded, so credentials and signing are skipped. */
export function isPlanning(): boolean {
  return current?.planning ?? false;
}

// ─── Shared clamps ───────────────────────────────────────────────────

export const EFFORT_LADDER: readonly string[] = REASONING_EFFORTS.filter((e) => e !== "off");

/**
 * The closest level to `asked` among `available` on the ordinal effort
 * ladder. A tie goes to the lower level: the cheaper guess is the one a
 * caller who set a dial would rather see recorded.
 */
export function nearestEffort(asked: string, available: readonly string[]): string {
  const levels = available.filter((l) => EFFORT_LADDER.includes(l));
  if (levels.length === 0) throw new ValueError(`no comparable effort levels in ${JSON.stringify(available)}`);
  if (levels.includes(asked)) return asked;
  const want = EFFORT_LADDER.includes(asked) ? EFFORT_LADDER.indexOf(asked) : 0;
  let best = levels[0]!;
  let bestKey = [Math.abs(EFFORT_LADDER.indexOf(best) - want), EFFORT_LADDER.indexOf(best)];
  for (const level of levels.slice(1)) {
    const key = [Math.abs(EFFORT_LADDER.indexOf(level) - want), EFFORT_LADDER.indexOf(level)];
    if (key[0]! < bestKey[0]! || (key[0] === bestKey[0] && key[1]! < bestKey[1]!)) {
      best = level;
      bestKey = key;
    }
  }
  return best;
}

export function hasClientSideStop(adaptations: readonly Adaptation[]): boolean {
  return adaptations.some((a) => a.field === "config.stop" && a.action === "client_side");
}
