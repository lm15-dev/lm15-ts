/**
 * Provider login profiles: the values lm15-contract records in
 * `auth/managed/profiles.json` (AUTH-18 § Provider profiles), copied here and
 * compared against that file by tests/login_profiles.test.ts. This file is
 * never the source of a client id, URL or scope; the contract is.
 *
 * `browser` on each request is the page directness lm15-contract records in
 * `auth/managed/browser.json` (AUTH-22): `direct` = the provider's CORS
 * headers let a page read the reply; `relay` = a browser refuses it. It is
 * evidence of the provider's headers, not a page receipt; the playground
 * exploration records receipts.
 */

import type { RelayStage } from "./types.ts";

export type Encoding = "form" | "json";
export type Directness = "direct" | "relay";

export interface RequestProfile {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly encoding?: Encoding;
  /** Header values required by the provider profile (sent exactly). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly browser: Directness;
}

export interface RouteDirectness {
  readonly catalog: Directness | "none";
  readonly inference: Directness;
}

export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// ─── xAI ─────────────────────────────────────────────────────────────

export const XAI = Object.freeze({
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  referrer: "lm15",
  lifetimeWhenAbsentS: 3600,
  deviceAuthorization: { method: "POST", url: "https://auth.x.ai/oauth2/device/code", encoding: "form", browser: "relay" } as RequestProfile,
  token: { method: "POST", url: "https://auth.x.ai/oauth2/token", encoding: "form", browser: "relay" } as RequestProfile,
});

// ─── Claude (subscription) ───────────────────────────────────────────

export const CLAUDE = Object.freeze({
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  loopbackAuthorizeUrl: "https://claude.ai/oauth/authorize",
  loopbackRedirectUri: "http://localhost:53692/callback",
  hostedVerifierBytes: 32,
  loopbackVerifierBytes: 64,
  stateBytes: 32,
  token: { method: "POST", url: "https://platform.claude.com/v1/oauth/token", encoding: "json", browser: "relay" } as RequestProfile,
});

// ─── ChatGPT (Codex) ─────────────────────────────────────────────────

export const CODEX = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: "openid profile email offline_access",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  redirectUri: "http://localhost:1455/auth/callback",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  deviceVerificationUrl: "https://auth.openai.com/codex/device",
  deviceExpiresInS: 900,
  verifierBytes: 64,
  stateBytes: 16,
  jwtClaim: "https://api.openai.com/auth",
  token: { method: "POST", url: "https://auth.openai.com/oauth/token", encoding: "form", browser: "direct" } as RequestProfile,
  deviceAuthorization: { method: "POST", url: "https://auth.openai.com/api/accounts/deviceauth/usercode", encoding: "json", browser: "direct" } as RequestProfile,
  deviceToken: { method: "POST", url: "https://auth.openai.com/api/accounts/deviceauth/token", encoding: "json", browser: "direct" } as RequestProfile,
});

// ─── GitHub Copilot ──────────────────────────────────────────────────

export const COPILOT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
});

export const COPILOT = Object.freeze({
  clientId: "Iv1.b507a08c87ecfe98",
  scope: "read:user",
  defaultDomain: "github.com",
  defaultApiBase: "https://api.individual.githubcopilot.com",
  deviceAuthorization: (domain: string): RequestProfile => ({
    method: "POST", url: `https://${domain}/login/device/code`, encoding: "form",
    headers: { "User-Agent": COPILOT_HEADERS["User-Agent"]! }, browser: "relay",
  }),
  deviceToken: (domain: string): RequestProfile => ({
    method: "POST", url: `https://${domain}/login/oauth/access_token`, encoding: "form",
    headers: { "User-Agent": COPILOT_HEADERS["User-Agent"]! }, browser: "relay",
  }),
  // browser.json: readable from a page only without the Editor-* headers; the profile sends them, so: relay.
  copilotToken: (domain: string): RequestProfile => ({
    method: "GET", url: `https://api.${domain}/copilot_internal/v2/token`, headers: COPILOT_HEADERS, browser: "relay",
  }),
});

// ─── OpenRouter ──────────────────────────────────────────────────────

export const OPENROUTER = Object.freeze({
  authorizeUrl: "https://openrouter.ai/auth",
  verifierBytes: 64,
  keys: { method: "POST", url: "https://openrouter.ai/api/v1/auth/keys", encoding: "json", browser: "direct" } as RequestProfile,
});

// ─── Kimi Code ───────────────────────────────────────────────────────

export const KIMI = Object.freeze({
  clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
  host: "https://auth.kimi.com",
  inferenceBaseUrl: "https://api.kimi.com/coding",
  deviceExpiresInS: 900,
  deviceAuthorization: (host: string): RequestProfile => ({ method: "POST", url: `${host}/api/oauth/device_authorization`, encoding: "form", browser: "direct" }),
  token: (host: string): RequestProfile => ({ method: "POST", url: `${host}/api/oauth/token`, encoding: "form", browser: "direct" }),
});

// ─── Meta ────────────────────────────────────────────────────────────

export const META = Object.freeze({
  clientId: "1031625952748946",
  keyLifetimeS: 86400,
  deviceAuthorization: { method: "POST", url: "https://auth.meta.com/oidc/device/authorization/", encoding: "form", browser: "relay" } as RequestProfile,
  deviceToken: { method: "POST", url: "https://auth.meta.com/oidc/device/token/", encoding: "form", browser: "relay" } as RequestProfile,
  keyMint: { method: "POST", url: "https://api.meta.ai/muse-code/key", encoding: "json", headers: { "x-api-version": "1.0.0" }, browser: "relay" } as RequestProfile,
});

// ─── Model calls after login (browser.json) ──────────────────────────

export const ROUTE_DIRECTNESS: Readonly<Record<string, RouteDirectness>> = Object.freeze({
  xai: { catalog: "direct", inference: "direct" },
  "claude-code": { catalog: "direct", inference: "direct" },
  "openai-codex": { catalog: "relay", inference: "relay" },
  "github-copilot": { catalog: "direct", inference: "direct" },
  openrouter: { catalog: "direct", inference: "direct" },
  "kimi-code": { catalog: "none", inference: "relay" },
  meta: { catalog: "none", inference: "direct" },
});

/** The stages a method's own auth requests need relayed in a page. */
export function authStageNeedsRelay(requests: readonly RequestProfile[]): readonly RelayStage[] {
  return requests.some((r) => r.browser === "relay") ? ["auth"] : [];
}
