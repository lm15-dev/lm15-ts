/**
 * The one table of named providers (mirrors `lm15.registry`, copied as
 * data). A provider string names one wire dialect plus an access policy
 * and, for bound entries, the compat preset of the server it targets.
 * Nothing else lists providers.
 */

import { tablePolicy } from "./auth/policy.ts";
import { PROVIDER_ROWS, type ProviderRow } from "./generated/tables.ts";
import type { AccessPolicy, EndpointSupport } from "./auth/policy.ts";
import {
  ANTHROPIC_PRESET_BASE_URLS,
  OPENAI_CHAT_PRESET_BASE_URLS,
  OPENAI_RESPONSES_PRESET_BASE_URLS,
  anthropicPreset,
  openaiChatPreset,
  openaiResponsesPreset,
  presetKey,
  validateCompat,
  type OpenAIChatCompat,
  type OpenAIResponsesCompat,
  type AnthropicCompat,
} from "./compat.ts";
import type { CredentialPolicy } from "./vocab.ts";
import { RawNumber } from "./json.ts";
import { NotConfiguredError } from "./errors.ts";

/** The wire formats lm15 speaks. */
export type Dialect = "openai-responses" | "openai-chat" | "anthropic" | "gemini" | "typesafe";

export const DIALECT_API_FAMILY: Readonly<Record<Dialect, string>> = Object.freeze({
  "openai-responses": "openai_responses",
  "openai-chat": "openai_chat",
  anthropic: "anthropic_messages",
  gemini: "gemini_generate_content",
  typesafe: "typesafe_systemone",
});

/** Provider strings are hyphenated; the underscore spelling is a permanent input alias. */
export function canonicalProvider(name: string): string {
  return name.replace(/_/g, "-");
}

export type Compat = OpenAIChatCompat | OpenAIResponsesCompat | AnthropicCompat;

export interface ProviderDefinition {
  /** Canonical provider string (hyphenated). */
  readonly id: string;
  readonly dialect: Dialect;
  readonly access: AccessPolicy;
  /** Compat preset name (bound and some hosted entries). */
  readonly compat?: string | Compat;
  /** Router-local input aliases; canonical id is always emitted. */
  readonly aliases?: readonly string[];
  /** The key a keyless local server accepts when nothing is configured (AUTH-1 last rung). */
  readonly placeholderKey?: string;
  readonly consoleUrl?: string;
  readonly note: string;
  /** True when the router binds `access` onto the dialect (the dialect's own manifest is not this provider). */
  readonly bound: boolean;
  /** True when the access policy names a cloud host (AUTH-10). */
  readonly hosted: boolean;
}

const COMPAT_TABLES: Record<string, [(name: string) => unknown, Readonly<Record<string, string>>] | undefined> = {
  "openai-responses": [openaiResponsesPreset, OPENAI_RESPONSES_PRESET_BASE_URLS],
  "openai-chat": [openaiChatPreset, OPENAI_CHAT_PRESET_BASE_URLS],
  anthropic: [anthropicPreset, ANTHROPIC_PRESET_BASE_URLS],
};

function define(
  d: Omit<ProviderDefinition, "bound" | "hosted" | "note"> & { note?: string; bound?: boolean },
): ProviderDefinition {
  const hosted = d.access.host !== undefined;
  const bound = d.bound ?? true;
  const def: ProviderDefinition = Object.freeze({ ...d, note: d.note ?? "", bound, hosted });
  if (def.id !== canonicalProvider(def.id)) throw new Error(`provider id must be hyphenated: ${def.id}`);
  if (canonicalProvider(def.access.provider) !== def.id) throw new Error(`${def.id}: access policy names provider ${def.access.provider}`);
  if (def.placeholderKey !== undefined && def.access.envKeys.length > 0) throw new Error(`${def.id}: a keyless local server declares no env_keys`);
  const aliases = def.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string" || !a || /[:/\s]/.test(a) || a !== canonicalProvider(a))) throw new Error(`${def.id}: aliases must be non-empty hyphenated provider names`);
  if (new Set([def.id, ...aliases]).size !== aliases.length + 1) throw new Error(`${def.id}: aliases repeat a spelling`);
  if (!def.id || /[:/\s]/.test(def.id)) throw new Error("provider id must be a non-empty provider name");
  const table = COMPAT_TABLES[def.dialect];
  if (def.compat !== undefined && typeof def.compat !== "string") {
    if (!table) throw new Error(`${def.id}: dialect ${def.dialect} cannot bind compat`);
    validateCompat(def.dialect, def.compat);
    if (!hosted && !def.access.baseUrl) throw new Error(`${def.id}: a declared provider names its baseUrl on the access policy`);
    if (!hosted && def.access.credentialPolicy !== "key") throw new Error(`${def.id}: a declared provider is key-based; subscription policies need their own adapter`);
    return def;
  }
  if (hosted) {
    if (def.compat !== undefined && table) table[0](def.compat);
    return def;
  }
  if (bound) {
    if (def.compat === undefined) throw new Error(`${def.id}: a bound entry names its compat preset`);
    if (!table) throw new Error(`${def.id}: dialect ${def.dialect} cannot bind`);
    table[0](def.compat);
    const expected = table[1][presetKey(def.compat)];
    if (def.access.baseUrl !== expected) throw new Error(`${def.id}: access.base_url ${def.access.baseUrl} != compat table ${expected} for preset ${def.compat}`);
  }
  return def;
}

export interface ProviderDeclarationOptions<C extends Compat> {
  readonly compat: C | string;
  readonly aliases?: readonly string[];
  readonly placeholderKey?: string;
  readonly consoleUrl?: string;
  readonly note?: string;
}

function declare<C extends Compat>(dialect: Dialect, policy: AccessPolicy, opts: ProviderDeclarationOptions<C>): ProviderDefinition {
  if (typeof opts.compat !== "string") validateCompat(dialect, opts.compat);
  return define({
    ...opts,
    id: canonicalProvider(policy.provider),
    dialect,
    access: freezeCompat({ ...policy, provider: canonicalProvider(policy.provider) }),
    aliases: Object.freeze([...(opts.aliases ?? [])]),
    compat: typeof opts.compat === "string" ? opts.compat : freezeCompat(opts.compat),
  });
}

function freezeCompat<C>(compat: C): C {
  // Snapshot nested knobs too: later caller mutation must not alter a route.
  function copy(value: unknown): unknown {
    if (value instanceof RawNumber) return Object.freeze(new RawNumber(value.raw));
    if (Array.isArray(value)) return Object.freeze(value.map(copy));
    if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])));
    return value;
  }
  return copy(compat) as C;
}

/** Factories create values, never register globally. Pass them in RouterConfig.providers. */
export const ProviderDefinition = Object.freeze({
  chat: (policy: AccessPolicy, opts: ProviderDeclarationOptions<OpenAIChatCompat>): ProviderDefinition => declare("openai-chat", policy, opts),
  responses: (policy: AccessPolicy, opts: ProviderDeclarationOptions<OpenAIResponsesCompat>): ProviderDefinition => declare("openai-responses", policy, opts),
  anthropic: (policy: AccessPolicy, opts: ProviderDeclarationOptions<AnthropicCompat>): ProviderDefinition => declare("anthropic", policy, opts),
});

/** A fresh router-local table; neither definitions nor aliases mutate PROVIDERS. */
export function providerTable(declarations: readonly ProviderDefinition[] = []): ReadonlyMap<string, ProviderDefinition> {
  if (!Array.isArray(declarations)) throw new TypeError("RouterConfig providers must be an array of ProviderDefinition values");
  const table = new Map(PROVIDERS);
  for (const value of declarations) {
    if (!value || typeof value !== "object" || !value.access) throw new TypeError("RouterConfig providers must contain ProviderDefinition values");
    const definition = define(value);
    for (const spelling of [definition.id, ...(definition.aliases ?? [])]) {
      if (table.has(spelling)) throw new NotConfiguredError(`RouterConfig providers: ${JSON.stringify(spelling)} already names ${JSON.stringify(table.get(spelling)!.id)}; declarations cannot replace a door or alias`);
      table.set(spelling, definition);
    }
  }
  return table;
}

/** A generated table row as a definition: the router binds `access` on every row but an adapter-owned one. */
function rowDefinition(row: ProviderRow): ProviderDefinition {
  return define({
    id: row.id,
    dialect: row.dialect,
    access: tablePolicy(row.id),
    bound: row.kind !== "adapter-owned",
    note: row.note,
    ...(row.compat !== undefined ? { compat: row.compat } : {}),
    ...(row.aliases.length > 0 ? { aliases: row.aliases } : {}),
    ...(row.placeholderKey !== undefined ? { placeholderKey: row.placeholderKey } : {}),
    ...(row.consoleUrl !== undefined ? { consoleUrl: row.consoleUrl } : {}),
  });
}

/**
 * Declaration order is presentation order. The rows are the reference's
 * (lm15-contract tables/providers.json, generated into src/generated/tables.ts);
 * a provider is added there, never here.
 */
const DEFINITIONS: readonly ProviderDefinition[] = PROVIDER_ROWS.map(rowDefinition);

export const PROVIDERS: ReadonlyMap<string, ProviderDefinition> = new Map(DEFINITIONS.map((d) => [d.id, d]));

/** The definition for a provider string in either spelling, or `undefined`. */
export function lookup(name: string): ProviderDefinition | undefined {
  return PROVIDERS.get(canonicalProvider(name));
}

export function providerEnvKeys(id: string): readonly string[] {
  return lookup(id)?.access.envKeys ?? [];
}

export function providerCredentialPolicy(id: string): CredentialPolicy | undefined {
  return lookup(id)?.access.credentialPolicy;
}

export function providerSupports(id: string): EndpointSupport | undefined {
  return lookup(id)?.access.supports;
}
