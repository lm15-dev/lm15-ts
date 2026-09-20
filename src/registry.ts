/**
 * The one table of named providers (mirrors `lm15.registry`, copied as
 * data). A provider string names one wire dialect plus an access policy
 * and, for bound entries, the compat preset of the server it targets.
 * Nothing else lists providers.
 */

import * as access from "./auth/policy.ts";
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

const owned = (id: string, dialect: Dialect, policy: AccessPolicy, note: string, consoleUrl?: string): ProviderDefinition =>
  define({ id, dialect, access: policy, note, bound: false, ...(consoleUrl ? { consoleUrl } : {}) });

const chatBound = (policy: AccessPolicy, note: string, opts: { compat?: string; placeholderKey?: string; consoleUrl?: string } = {}): ProviderDefinition =>
  define({
    id: policy.provider,
    dialect: "openai-chat",
    access: policy,
    compat: opts.compat ?? policy.provider,
    note,
    ...(opts.placeholderKey ? { placeholderKey: opts.placeholderKey } : {}),
    ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : {}),
  });

const responsesBound = (policy: AccessPolicy, compat: string, note: string, consoleUrl: string): ProviderDefinition =>
  define({ id: policy.provider, dialect: "openai-responses", access: policy, compat, note, consoleUrl });

const anthropicBound = (policy: AccessPolicy, compat: string, note: string, consoleUrl: string): ProviderDefinition =>
  define({ id: policy.provider, dialect: "anthropic", access: policy, compat, note, consoleUrl });

const hosted = (policy: AccessPolicy, dialect: Dialect, note: string, consoleUrl: string, compat?: string): ProviderDefinition =>
  define({ id: policy.provider, dialect, access: policy, note, consoleUrl, ...(compat ? { compat } : {}) });

/** Declaration order is presentation order. */
const DEFINITIONS: readonly ProviderDefinition[] = [
  owned("openai", "openai-responses", access.OPENAI_API, "OpenAI Responses API", "https://platform.openai.com/api-keys"),
  owned("openai-chat", "openai-chat", access.OPENAI_CHAT_API, "OpenAI Chat Completions dialect (the de-facto standard other servers speak)", "https://platform.openai.com/api-keys"),
  owned("anthropic", "anthropic", access.ANTHROPIC_API, "Anthropic Messages API", "https://console.anthropic.com"),
  owned("gemini", "gemini", access.GEMINI_API, "Google Gemini API", "https://aistudio.google.com/apikey"),
  define({
    id: "xai",
    dialect: "openai-chat",
    access: access.XAI,
    compat: "xai",
    bound: false,
    consoleUrl: "https://console.x.ai",
    note: "xAI Grok (Chat Completions dialect; XAI_API_KEY or subscription OAuth)",
  }),
  owned("typesafe", "typesafe", access.TYPESAFE_API, "TypeSafe System One (Jev): judgments over declared keys with probabilities; no text generation", "https://console.typesafe.ai/keys"),
  owned("claude-code", "anthropic", access.CLAUDE_CODE, "Claude subscription through the local `claude` CLI login"),
  owned("openai-codex", "openai-responses", access.OPENAI_CODEX, "ChatGPT subscription through the local `codex` CLI login"),
  chatBound(access.GROQ, "Groq Cloud (Chat Completions dialect)", { consoleUrl: "https://console.groq.com/keys" }),
  chatBound(access.OPENROUTER, "OpenRouter (Chat Completions dialect)", { consoleUrl: "https://openrouter.ai/keys" }),
  chatBound(access.DEEPSEEK, "DeepSeek (Chat Completions dialect; thinking mode on by default)", { consoleUrl: "https://platform.deepseek.com/api_keys" }),
  anthropicBound(
    access.DEEPSEEK_ANTHROPIC,
    "deepseek",
    "DeepSeek over the Anthropic Messages wire (same key as `deepseek`; no model listing)",
    "https://platform.deepseek.com/api_keys",
  ),
  chatBound(access.ZAI, "Z.AI GLM (Chat Completions dialect; general endpoint, not the Coding Plan)", { consoleUrl: "https://z.ai/manage-apikey/apikey-list" }),
  chatBound(
    access.MOONSHOTAI,
    "Moonshot AI Kimi (Chat Completions dialect; kimi-k3 takes reasoning effort low|high|max, kimi-k2.6 takes effort off; Moonshot's docs call the key MOONSHOT_API_KEY — read after MOONSHOTAI_API_KEY)",
    { consoleUrl: "https://platform.kimi.ai/console/api-keys" },
  ),
  responsesBound(
    access.MOONSHOTAI_RESPONSES,
    "moonshotai",
    "Moonshot AI Kimi over the Responses wire (same key as `moonshotai`; kimi-k3 only; stateless — reasoning replays as summary text; web_search built-in)",
    "https://platform.kimi.ai/console/api-keys",
  ),
  anthropicBound(
    access.MOONSHOTAI_ANTHROPIC,
    "moonshotai",
    "Moonshot AI Kimi over the Anthropic Messages wire (same key as `moonshotai`, bearer token; kimi-k3 only)",
    "https://platform.kimi.ai/console/api-keys",
  ),
  responsesBound(
    access.META,
    "meta",
    "Meta Model API — Muse Spark over the Responses wire (reasoning replay, web_search), plus Files, Images (muse-image-1.0) and Models; Meta's docs call the key MODEL_API_KEY — export it as META_API_KEY",
    "https://dev.meta.ai/",
  ),
  chatBound(access.META_CHAT, "Meta Model API over the Chat Completions wire (same key as `meta`; no cross-turn reasoning)", { compat: "meta", consoleUrl: "https://dev.meta.ai/" }),
  anthropicBound(access.META_ANTHROPIC, "meta", "Meta Model API over the Anthropic Messages wire (same key as `meta`; bearer token)", "https://dev.meta.ai/"),
  hosted(access.AZURE, "openai-responses", "Azure OpenAI v1 Responses wire ({resource}.openai.azure.com; model = deployment name; api-key or Entra token)", "https://portal.azure.com/"),
  hosted(access.AZURE_CHAT, "openai-chat", "Azure OpenAI v1 Chat Completions wire (same resource; also Foundry-sold models such as DeepSeek and Grok)", "https://portal.azure.com/", "openai"),
  hosted(access.AZURE_ANTHROPIC, "anthropic", "Claude in Microsoft Foundry ({resource}.services.ai.azure.com/anthropic; api-key, x-api-key or Entra token)", "https://ai.azure.com/"),
  hosted(access.AWS_ANTHROPIC, "anthropic", "Claude Platform on AWS (Anthropic-operated; SigV4 or ANTHROPIC_AWS_API_KEY; needs AWS_REGION and ANTHROPIC_AWS_WORKSPACE_ID)", "https://console.aws.amazon.com/"),
  hosted(access.BEDROCK_ANTHROPIC, "anthropic", "Claude in Amazon Bedrock (bedrock-mantle, Opus 4.7 and later; SigV4 or AWS_BEARER_TOKEN_BEDROCK; needs AWS_REGION)", "https://console.aws.amazon.com/bedrock/"),
  hosted(access.BEDROCK_CHAT, "openai-chat", "Amazon Bedrock over the OpenAI Chat Completions wire (bedrock-runtime /openai/v1; SigV4 or AWS_BEARER_TOKEN_BEDROCK)", "https://console.aws.amazon.com/bedrock/", "bedrock"),
  hosted(
    access.BEDROCK_MANTLE_CHAT,
    "openai-chat",
    "Amazon Bedrock Chat Completions on bedrock-mantle (un-versioned ids, GET /v1/models; SigV4 or AWS_BEARER_TOKEN_BEDROCK)",
    "https://console.aws.amazon.com/bedrock/",
    "bedrock-mantle",
  ),
  hosted(access.VERTEX, "gemini", "Gemini on Google Cloud (Agent Platform); ADC chain; needs GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION defaults to global", "https://console.cloud.google.com/vertex-ai"),
  hosted(access.VERTEX_EXPRESS, "gemini", "Agent Platform express mode: GOOGLE_API_KEY as ?key=, no project or location", "https://console.cloud.google.com/vertex-ai/studio"),
  hosted(access.VERTEX_ANTHROPIC, "anthropic", "Claude on Google Cloud (rawPredict; model in the path, anthropic_version in the body)", "https://console.cloud.google.com/vertex-ai/model-garden"),
  chatBound(access.OLLAMA, "local ollama server (keyless)", { placeholderKey: "ollama" }),
  chatBound(access.VLLM, "local vLLM server (keyless)", { placeholderKey: "EMPTY" }),
  chatBound(access.SGLANG, "local SGLang server (keyless)", { placeholderKey: "EMPTY" }),
];

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
