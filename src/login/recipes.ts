/**
 * Connections that are recipes, not tokens (port of lm15-python
 * `lm15/login/flows/recipes.py`). Four kinds (AUTH-12, AUTH-15):
 *
 * - `api_key`: a literal key the person typed (no interpolation);
 * - `env`: use the key in this environment variable; its name is saved,
 *   never its value, and the value is read at request time. This is how an
 *   ambient key becomes an explicit choice (R2/R3);
 * - `external`: use the login another tool owns (Claude Code CLI, Codex CLI,
 *   the Pi agent's xAI store). The file stays the owner; lm15 reads and
 *   renews it in place through the host, copying nothing (R1);
 * - `local`: a keyless local server's URL;
 * - `cloud`: a named cloud identity (AUTH-11) the router's chain runs.
 *
 * Browser-safe: external logins and the environment are host services
 * (`Platform.externalLogins`, `Platform.env`).
 */

import { NAMED_CREDENTIALS } from "../cloud/identity.ts";
import { getDefaultPlatform } from "../platform.ts";
import { LoginDenied } from "./engine.ts";
import type { LoginMethod, MethodField } from "./types.ts";

/** source id → [provider route, human label] */
export const EXTERNAL_SOURCES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "claude-code-cli": ["claude-code", "your Claude Code login (~/.claude/.credentials.json)"],
  "codex-cli": ["openai-codex", "your Codex CLI login (~/.codex/auth.json)"],
  "pi-xai": ["xai", "your Pi agent xAI login (~/.pi/agent/auth.json)"],
});

/** What a request sends for a saved connection (secret: `credential`). `named`: a saved cloud recipe's identity. */
export interface RequestAuth {
  readonly credential: { readonly kind: "bearer" | "api_key"; readonly value: string } | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly baseUrl: string | null;
  readonly accountId: string | null;
  readonly named: string | null;
}

export type Material = Readonly<Record<string, unknown>>;

export interface RecipeResult {
  readonly material: Material;
  readonly label: string;
  readonly renewal: string;
  readonly settings?: Readonly<Record<string, string>>;
}

function method(m: Omit<LoginMethod, "availability" | "delivery" | "subscription" | "needsRelay" | "fields"> & Partial<LoginMethod>): LoginMethod {
  return Object.freeze({ availability: "supported", delivery: [], subscription: false, needsRelay: [], fields: [], ...m }) as LoginMethod;
}

export function apiKeyMethod(consoleUrl?: string): LoginMethod {
  return method({
    id: "api_key", label: "Paste an API key", kind: "api_key", flow: "form",
    fields: [{ id: "key", label: "API key", type: "secret", required: true }],
    ...(consoleUrl ? { guidance: `Create one at ${consoleUrl}` } : {}),
    billingNote: "Metered per token by the provider.",
  });
}

export function envMethod(envKeys: readonly string[]): LoginMethod {
  const field: MethodField = {
    id: "name", label: "Environment variable", type: "select", required: true,
    options: envKeys.map((k) => ({ id: k, label: `$${k}` })),
  };
  return method({
    id: "env", label: `Use the key in $${envKeys[0]} from the environment`, kind: "api_key", flow: "source_recipe",
    fields: [field],
    billingNote: "Metered per token by the provider; the variable's value is read at request time, never saved.",
  });
}

export function externalMethod(source: string): LoginMethod {
  const [, label] = EXTERNAL_SOURCES[source]!;
  return method({
    id: `external:${source}`, label: `Use ${label}`, kind: "account", flow: "source_recipe", subscription: true,
    billingNote: "Whatever that tool's login is entitled to; LM15 reads and renews it in place and copies nothing.",
    guidance: "Sign in with that tool first if it says no credential is present.",
  });
}

export function cloudMethod(): LoginMethod {
  return method({
    id: "cloud", label: "Use a named cloud identity", kind: "cloud_identity", flow: "source_recipe",
    fields: [{ id: "named", label: "Identity", type: "select", required: true, options: NAMED_CREDENTIALS.map((n) => ({ id: n, label: n })) }],
    billingNote: "Billed to that cloud account.",
  });
}

export function localMethod(): LoginMethod {
  return method({
    id: "local", label: "Local server (no key needed)", kind: "local_server", flow: "source_recipe",
    fields: [{ id: "base_url", label: "Server URL", type: "text", required: false }],
  });
}

/** Run a recipe method: nothing is contacted except an external tool's file, probed so a missing login fails now. */
export function recipeLogin(provider: string, methodId: string, answers: Readonly<Record<string, string>>, settings: Readonly<Record<string, string>>): RecipeResult {
  if (methodId === "api_key") {
    const key = (answers["key"] ?? "").trim();
    if (!key) throw new LoginDenied("no API key was entered");
    return { material: { type: "api_key", key }, label: `${provider} API key`, renewal: "none" };
  }
  if (methodId === "env") {
    const name = answers["name"] ?? "";
    if (!name) throw new LoginDenied("no environment variable was chosen");
    return { material: { type: "env", name }, label: `${provider} key from $${name}`, renewal: "recipe" };
  }
  if (methodId.startsWith("external:")) {
    const source = methodId.slice("external:".length);
    if (!EXTERNAL_SOURCES[source]) throw new LoginDenied(`unknown external source ${JSON.stringify(source)}`);
    externalLogins().probe(source);
    return { material: { type: "external", source }, label: `${provider} via ${EXTERNAL_SOURCES[source]![1]}`, renewal: "external" };
  }
  if (methodId === "cloud") {
    const named = answers["named"] ?? "";
    if (!(NAMED_CREDENTIALS as readonly string[]).includes(named)) throw new LoginDenied(`choose one of ${NAMED_CREDENTIALS.join(", ")}`);
    return { material: { type: "cloud", named }, label: `${provider} via ${named} identity`, renewal: "recipe" };
  }
  if (methodId === "local") {
    const baseUrl = answers["base_url"] || settings["base_url"] || "";
    return {
      material: { type: "local", base_url: baseUrl, key: answers["key"] || "local" }, label: `${provider} local server`, renewal: "none",
      ...(baseUrl ? { settings: { base_url: baseUrl } } : {}),
    };
  }
  throw new TypeError(methodId);
}

function externalLogins() {
  const hosted = getDefaultPlatform().externalLogins;
  if (!hosted) throw new LoginDenied(`another tool's login lives on the host's disk; the ${getDefaultPlatform().name} platform cannot read it`);
  return hosted;
}

function str(material: Material, key: string): string {
  const value = material[key];
  return typeof value === "string" ? value : "";
}

/** What a request sends for recipe material. External logins are read (and renewed in place) by the host. */
export async function recipeRequestAuth(material: Material): Promise<RequestAuth> {
  const kind = material["type"];
  const none = { headers: {}, baseUrl: null, accountId: null, named: null } as const;
  if (kind === "api_key") return { ...none, credential: { kind: "api_key", value: str(material, "key") } };
  if (kind === "env") {
    const name = str(material, "name");
    const value = getDefaultPlatform().env()[name] ?? "";
    if (!value) throw new LoginDenied(`$${name} is not set in this process's environment`);
    return { ...none, credential: { kind: "api_key", value } };
  }
  if (kind === "external") {
    const auth = await externalLogins().requestAuth(str(material, "source"));
    return { ...none, credential: { kind: "bearer", value: auth.token }, headers: auth.headers, accountId: auth.accountId ?? null };
  }
  if (kind === "local") return { ...none, credential: { kind: "api_key", value: str(material, "key") || "local" }, baseUrl: str(material, "base_url") || null };
  if (kind === "cloud") return { ...none, credential: null, named: str(material, "named") };
  throw new LoginDenied(`unknown connection material ${JSON.stringify(kind)}`);
}

/** Recipes never expire on their own; an external login's expiry is its owner's business (unknown). */
export function recipeExpiry(material: Material): number | "never" | null {
  const kind = material["type"];
  return kind === "api_key" || kind === "env" || kind === "local" || kind === "cloud" ? "never" : null;
}
