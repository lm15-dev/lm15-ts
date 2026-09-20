/**
 * The doctor's rungs over the Node login stores (spec/auth.md AUTH-7):
 * where a stored login would be read from and what state it is in. Reads
 * files; never the network; never a secret value. The `describe` of the
 * Node platform's `StoredCredentials`.
 */

import { NotConfiguredError } from "../errors.ts";
import type { ChainStep, Env } from "../platform.ts";
import type { AuthStepState } from "../vocab.ts";
import type { AccessPolicy } from "./policy.ts";
import {
  LocalOAuthCredential,
  claudeCodeCredentialsPath,
  codexCliAuthPath,
  credentialLockingDetail,
  defaultCredentialsPath,
  expandHome,
  loadClaudeCodeCredential,
  loadCodexCliCredential,
  loadXaiCredential,
  piAgentAuthPath,
} from "./stores.ts";

function expiryDetail(credential: LocalOAuthCredential): string {
  if (credential.expiresAt === undefined) return "no recorded expiry";
  const remaining = credential.expiresAt - Date.now();
  if (remaining <= 0) return `expired, ${credential.refreshToken ? "refresh token present" : "NO refresh token"}`;
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const span = hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes % 60}m`;
  return `fresh, expires in ${span}`;
}

function usableState(credential: LocalOAuthCredential, detail: string, shadowed: boolean): AuthStepState {
  if (detail.includes("expired") && !credential.refreshToken) return "absent";
  return shadowed ? "shadowed" : "selected";
}

function borrowedCliStep(provider: string, pathOverride: string | undefined, env: Env): ChainStep {
  const envForPaths = { HOME: env["HOME"] } as NodeJS.ProcessEnv;
  const file = pathOverride ? expandHome(pathOverride, env["HOME"]) : provider === "claude-code" ? claudeCodeCredentialsPath(envForPaths) : codexCliAuthPath(envForPaths);
  const source = `local OAuth credential ${file}`;
  let credential: LocalOAuthCredential;
  try {
    credential = provider === "claude-code" ? loadClaudeCodeCredential(file) : loadCodexCliCredential(file);
  } catch (e) {
    if (e instanceof NotConfiguredError) return { kind: "oauth-file", source, detail: "missing or unreadable", state: "absent" };
    throw e;
  }
  const detail = expiryDetail(credential);
  return { kind: "oauth-file", source, detail: `${detail}; ${credentialLockingDetail()}`, state: usableState(credential, detail, false) };
}

function ownStoreStep(pathOverride: string | undefined, shadowed: boolean, env: Env): ChainStep {
  const envForPaths = { HOME: env["HOME"], XDG_CONFIG_HOME: env["XDG_CONFIG_HOME"], LM15_CREDENTIALS_PATH: env["LM15_CREDENTIALS_PATH"] } as NodeJS.ProcessEnv;
  const paths = pathOverride ? [expandHome(pathOverride, env["HOME"])] : [defaultCredentialsPath(envForPaths), piAgentAuthPath(envForPaths)];
  for (const file of paths) {
    let credential: LocalOAuthCredential;
    try {
      credential = loadXaiCredential(file);
    } catch {
      continue;
    }
    const detail = expiryDetail(credential);
    return { kind: "oauth-file", source: `local OAuth credential ${file}`, detail: `${detail}; ${credentialLockingDetail()}`, state: usableState(credential, detail, shadowed) };
  }
  return { kind: "oauth-file", source: `local OAuth credential ${paths.join(" or ")}`, detail: "missing or unreadable", state: "absent" };
}

/** The store rung for `policy`: the borrowed CLI file under `oauth`, lm15's own store under `oauth-unless-explicit`. */
export function describeStoredCredential(
  policy: AccessPolicy,
  opts: { readonly env: Env; readonly credentialsPath?: string | undefined; readonly shadowed: boolean },
): ChainStep {
  if (policy.credentialPolicy === "oauth") return borrowedCliStep(policy.provider, opts.credentialsPath, opts.env);
  return ownStoreStep(opts.credentialsPath, opts.shadowed, opts.env);
}
