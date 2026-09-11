/**
 * `explainAuth`: how a provider's credential would resolve, rung by rung,
 * with no network call and no secret material (spec/auth.md AUTH-7).
 * It walks the exact chain the router walks; divergence is a bug. The
 * rungs that read the host — stored logins, cloud chains — are the host
 * platform's to describe; a host without them reports them absent, which
 * is exactly what the router on that host does.
 */

import { resolveSettings } from "../cloud/hosts.ts";
import { NotConfiguredError } from "../errors.ts";
import { getDefaultPlatform, type Env } from "../platform.ts";
import { PROVIDERS, canonicalProvider, lookup } from "../registry.ts";
import { apiKeysSource } from "../router.ts";
import type { CredentialLike } from "../types/credential.ts";
import { ValueError } from "../types/validate.ts";
import type { AuthStepState } from "../vocab.ts";
import { isCloudChain, type AccessPolicy } from "./policy.ts";

/** One rung of the credential chain. `kind` is the language-neutral fixture identifier; `detail` carries no secret by construction. */
export interface AuthStep {
  readonly kind: string;
  readonly source: string;
  readonly detail: string;
  readonly state: AuthStepState;
}

export interface AuthReport {
  readonly provider: string;
  readonly steps: readonly AuthStep[];
  readonly configured: boolean;
  /** Resolved host settings, printed by name and value (they decide residency, not secrets). */
  readonly settings: ReadonlyArray<readonly [string, string]>;
}

const MARKERS: Record<AuthStepState, string> = { selected: "=> ", shadowed: " ~ ", absent: " - ", unprobed: " ? " };

export function describeStep(step: AuthStep): string {
  return `${MARKERS[step.state]}${step.source}: ${step.detail}`;
}

export function selectedStep(report: AuthReport): AuthStep | undefined {
  return report.steps.find((s) => s.state === "selected");
}

export function describeReport(report: AuthReport): string {
  const lines = [`auth for provider ${JSON.stringify(report.provider)}:`, ...report.steps.map((s) => `  ${describeStep(s)}`)];
  const unprobed = report.steps.filter((s) => s.state === "unprobed");
  const selected = selectedStep(report);
  if (report.configured && selected) {
    lines.push(`  configured: yes — ${selected.source}`);
    if (unprobed.length > 0) lines.push(`  note: ${unprobed.map((s) => s.source).join(", ")} run first at request time and may win`);
  } else if (report.configured) lines.push(`  configured: probably — ${unprobed.map((s) => s.source).join(", ")} (unprobed offline)`);
  else lines.push("  configured: no");
  for (const [name, value] of report.settings) lines.push(`  setting ${name}: ${value}`);
  return lines.join("\n");
}

/** The store rung through the host platform; a host without stores reports the rung absent, as its router skips it. */
function storeStep(policy: AccessPolicy, opts: { env: Env; credentialsPath: string | undefined; shadowed: boolean }): AuthStep {
  const platform = getDefaultPlatform();
  if (platform.storedCredentials) return platform.storedCredentials.describe(policy, opts);
  return { kind: "oauth-file", source: `stored login for ${policy.provider}`, detail: `not available on the ${platform.name} platform`, state: "absent" };
}

export interface ExplainAuthOptions {
  /** The complete environment (defaults to the host platform's: `process.env` on Node, empty on the web). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly apiKeys?: Readonly<Record<string, CredentialLike>>;
  readonly claudeCredentialsPath?: string;
  readonly codexAuthPath?: string;
  readonly xaiCredentialsPath?: string;
  /** Harness-materialized files under a sandbox HOME (`~/...` keys). */
  readonly files?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly settings?: Readonly<Record<string, string>>;
}

function hasApiKeysEntry(apiKeys: Readonly<Record<string, CredentialLike>> | undefined, provider: string): boolean {
  return apiKeysSource({ apiKeys }, provider) !== undefined;
}

/** AUTH-7: the source configuration key is shown when it differs from the target; the kind stays `api_keys`. */
function entrySource(provider: string, entry: string | undefined): string {
  let source = "explicit api_keys entry";
  if (entry !== undefined && canonicalProvider(entry) !== provider) source += ` (via ${JSON.stringify(entry)}, shared env-key declarations)`;
  return source;
}

/** Explain, rung by rung, how `provider`'s credential resolves. Never returns secret values; performs no network I/O. */
export function explainAuth(provider: string, opts: ExplainAuthOptions = {}): AuthReport {
  const canonical = canonicalProvider(provider);
  const definition = lookup(canonical);
  if (!definition) throw new ValueError(`Unknown provider ${JSON.stringify(provider)}. Known providers: ${[...PROVIDERS.keys()].sort().join(", ")}`);
  const env = opts.env ?? getDefaultPlatform().env();
  const policy = definition.access;

  if (isCloudChain(policy) || definition.hosted) return explainCloud(canonical, opts, env);

  if (policy.credentialPolicy === "oauth") {
    const step = storeStep(policy, { env, credentialsPath: canonical === "claude-code" ? opts.claudeCredentialsPath : opts.codexAuthPath, shadowed: false });
    return { provider: canonical, steps: [step], configured: step.state === "selected", settings: [] };
  }

  const steps: AuthStep[] = [];
  let selected = false;
  const entry = apiKeysSource({ apiKeys: opts.apiKeys }, canonical);
  if (entry !== undefined) {
    steps.push({ kind: "api_keys", source: entrySource(canonical, entry), detail: "provided (value never shown)", state: "selected" });
    selected = true;
  } else steps.push({ kind: "api_keys", source: "explicit api_keys entry", detail: "not provided", state: "absent" });
  if (policy.credentialPolicy === "oauth-unless-explicit") {
    const step = storeStep(policy, { env, credentialsPath: opts.xaiCredentialsPath, shadowed: selected });
    steps.push(step);
    selected = selected || step.state === "selected";
  }
  for (const key of policy.envKeys) {
    if (env[key]) {
      steps.push({ kind: `env:${key}`, source: `env $${key}`, detail: "set (value never shown)", state: selected ? "shadowed" : "selected" });
      selected = true;
    } else steps.push({ kind: `env:${key}`, source: `env $${key}`, detail: "not set", state: "absent" });
  }
  if (definition.placeholderKey !== undefined) {
    steps.push({ kind: "placeholder", source: "local-server placeholder key", detail: `preset default for keyless ${canonical} servers`, state: selected ? "shadowed" : "selected" });
    selected = true;
  }
  return { provider: canonical, steps, configured: selected, settings: [] };
}

function explainCloud(canonical: string, opts: ExplainAuthOptions, env: Readonly<Record<string, string | undefined>>): AuthReport {
  const definition = lookup(canonical)!;
  const policy = definition.access;
  const hasEntry = hasApiKeysEntry(opts.apiKeys, canonical);
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) values[k] = v;
  const platform = getDefaultPlatform();
  const chain = platform.openCloudChain?.({ env: values, online: false, home: opts.home, files: opts.files });
  const profile = chain ? chain.profile(policy) : undefined;
  let resolved: Record<string, string> = {};
  let settingError: string | undefined;
  try {
    resolved = resolveSettings(policy.host, opts.settings, values, { provider: canonical, ...(profile ? { profile } : {}) });
  } catch (e) {
    if (!(e instanceof NotConfiguredError)) throw e;
    settingError = String(e.message).split("\n")[0]!;
  }
  if (chain) chain.settings = resolved;
  let steps: AuthStep[];
  let configured: boolean;
  if (isCloudChain(policy) && chain) {
    const [chainSteps, ok] = chain.explain(policy, hasEntry);
    steps = chainSteps.map((s) => ({ kind: s.kind, source: s.source, detail: s.detail, state: s.state }));
    configured = ok;
  } else if (isCloudChain(policy)) {
    steps = [
      { kind: "api_keys", source: "explicit api_keys entry", detail: hasEntry ? "provided (value never shown)" : "not provided", state: hasEntry ? "selected" : "absent" },
      { kind: policy.credentialPolicy, source: `${policy.credentialPolicy} (profile files, CLIs, metadata endpoints)`, detail: `not available on the ${platform.name} platform`, state: "absent" },
    ];
    configured = hasEntry;
  } else {
    steps = [{ kind: "api_keys", source: "explicit api_keys entry", detail: hasEntry ? "provided (value never shown)" : "not provided", state: hasEntry ? "selected" : "absent" }];
    configured = hasEntry;
    for (const key of policy.envKeys) {
      if (values[key]) {
        steps.push({ kind: `env:${key}`, source: `env $${key}`, detail: "set (value never shown)", state: configured ? "shadowed" : "selected" });
        configured = true;
      } else steps.push({ kind: `env:${key}`, source: `env $${key}`, detail: "not set", state: "absent" });
    }
  }
  const shown: Array<[string, string]> = Object.entries(resolved).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (settingError) shown.push(["error", settingError]);
  return { provider: canonical, steps, configured, settings: shown };
}
