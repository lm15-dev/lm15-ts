/**
 * ChatGPT (Codex) subscription login; profiles.json `openai-codex`.
 * Port of lm15-python `lm15/login/flows/codex.py`.
 *
 * `browser`: authorization code + PKCE with the registered
 * `localhost:1455` return. Without a listener (this build, and every page),
 * the browser lands on a page that fails to load; its address bar holds the
 * return URL to paste. `device`: OpenAI's device endpoints, which hand back an
 * authorization code + verifier that is exchanged like the browser flow.
 */

import { decodeJwtPayload, extractChatgptAccountId } from "../../auth/jwt.ts";
import { pkceChallenge } from "../../auth/pkce.ts";
import { authRequest, awaitReturn, LoginDenied, randomBase64Url, randomHex, runDeviceFlow, type LoginContext } from "../engine.ts";
import { CODEX } from "../profiles.ts";
import type { LoginMaterial } from "../types.ts";
import { oauth, oauthMaterial, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const UNVERIFIED = "provider permission and billing remain unverified";

const DESCRIPTOR: FlowDescriptor = {
  id: "openai-codex", label: "ChatGPT (subscription)", service: "OpenAI", routes: ["openai-codex"],
  methods: [
    {
      id: "browser", label: "Sign in with ChatGPT (browser)", kind: "account", flow: "authorization_code",
      nativeAvailability: "unverified", reason: `browser login, inference, persistence and early renewal observed natively 2026-09-23; ${UNVERIFIED}`,
      delivery: ["loopback", "manual"], subscription: true,
    },
    {
      id: "device", label: "Sign in with ChatGPT (device code)", kind: "account", flow: "device_code",
      nativeAvailability: "unverified", reason: `device login and inference observed natively 2026-09-23; ${UNVERIFIED}`,
      delivery: ["device"], subscription: true,
    },
  ],
};

function tokens(body: Record<string, unknown>, nowMs: number) {
  const access = str(body["access_token"]);
  const refresh = str(body["refresh_token"]);
  if (!access || !refresh) throw new LoginDenied("ChatGPT token response is missing required fields", { stage: "exchange" });
  const expiresIn = body["expires_in"];
  let lifetime = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : undefined;
  if (lifetime === undefined) {
    try {
      const exp = decodeJwtPayload(access)["exp"];
      if (typeof exp === "number") lifetime = Math.max((exp * 1000 - nowMs) / 1000, 0) || undefined;
    } catch {
      // not a JWT: expiry unknown
    }
  }
  const accountId = extractChatgptAccountId(access);
  if (!accountId) throw new LoginDenied("ChatGPT token carries no account id", { stage: "exchange" });
  const idToken = str(body["id_token"]);
  return oauthMaterial({ access, refresh, expiresInS: lifetime, nowMs, extra: { accountId, ...(idToken ? { id_token: idToken } : {}) } });
}

async function exchange(ctx: LoginContext, code: string, verifier: string, redirectUri: string): Promise<FlowResult> {
  ctx.notify({ type: "progress", stage: "exchange", message: "Exchanging the authorization code…" });
  const reply = await authRequest(ctx, CODEX.token, {
    params: { grant_type: "authorization_code", client_id: CODEX.clientId, code, code_verifier: verifier, redirect_uri: redirectUri },
    consumes: true, stage: "exchange",
  });
  if (!reply.ok) throw new LoginDenied("ChatGPT authorization-code exchange failed", { reply, stage: "exchange" });
  return { material: tokens(reply.body, ctx.wallClock()), label: "ChatGPT subscription", renewal: "refresh_token" };
}

export const codexFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: (methodId) => (methodId === "device" ? [CODEX.deviceAuthorization, CODEX.deviceToken, CODEX.token] : [CODEX.token]),

  async login(ctx: LoginContext, methodId: string, _inputs: LoginInputs): Promise<FlowResult> {
    if (methodId === "device") return loginDevice(ctx);
    if (methodId !== "browser") throw new TypeError(methodId);
    const verifier = randomBase64Url(CODEX.verifierBytes);
    const challenge = await pkceChallenge(verifier);
    const state = randomHex(CODEX.stateBytes);
    const url = new URL(CODEX.authorizeUrl);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: CODEX.clientId, redirect_uri: CODEX.redirectUri, scope: CODEX.scope,
      code_challenge: challenge, code_challenge_method: "S256", state,
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "lm15",
    })) url.searchParams.set(k, v);
    ctx.notify({
      type: "auth_url", url: url.toString(),
      instructions: "Sign in to ChatGPT. The browser then tries to open localhost:1455 and shows an error page; copy that page's full address and paste it here.",
    });
    const returned = await awaitReturn(ctx, {
      type: "manual_code", fieldId: "return", label: "Paste the full return URL (http://localhost:1455/auth/callback?code=…)",
      accepted: "the full return URL",
    }, { expectedState: state, allowBareCode: false, registeredUri: CODEX.redirectUri });
    return exchange(ctx, returned.code, verifier, CODEX.redirectUri);
  },

  async renew(ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    const material = oauth(saved, "openai-codex");
    if (!material.refresh) throw new LoginDenied("ChatGPT credential has no refresh token", { stage: "renewal" });
    const reply = await authRequest(ctx, CODEX.token, {
      params: { grant_type: "refresh_token", refresh_token: material.refresh, client_id: CODEX.clientId }, consumes: true, stage: "renewal",
    });
    if (!reply.ok) throw new LoginDenied("ChatGPT token renewal failed", { reply, stage: "renewal" });
    const body: Record<string, unknown> = { ...reply.body };
    if (!str(body["refresh_token"])) body["refresh_token"] = material.refresh; // OpenAI may omit it when it does not rotate
    return { material: tokens(body, ctx.wallClock()), label: "ChatGPT subscription", renewal: "refresh_token" };
  },

  requestAuth(saved: LoginMaterial) {
    const material = oauth(saved, "openai-codex");
    const accountId = material.accountId ?? extractChatgptAccountId(material.access);
    return {
      route: "openai-codex", credential: { kind: "bearer", value: material.access },
      headers: accountId ? { "chatgpt-account-id": accountId } : {}, ...(accountId ? { accountId } : {}),
    };
  },
};

async function loginDevice(ctx: LoginContext): Promise<FlowResult> {
  const start = await authRequest(ctx, CODEX.deviceAuthorization, { params: { client_id: CODEX.clientId }, stage: "authorization" });
  if (!start.ok) {
    if (start.status === 404) throw new LoginDenied("ChatGPT device-code login is not enabled for this account; use the browser method", { reply: start });
    throw new LoginDenied(`ChatGPT refused to start a device authorization (HTTP ${start.status})`, { reply: start });
  }
  const deviceId = str(start.body["device_auth_id"]);
  const userCode = str(start.body["user_code"]);
  if (!deviceId || !userCode) throw new LoginDenied("ChatGPT device authorization response is missing required fields");
  const raw = start.body["interval"];
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  const intervalS = typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  ctx.notify({ type: "device_code", userCode, verificationUrl: CODEX.deviceVerificationUrl, expiresInS: CODEX.deviceExpiresInS, intervalS: intervalS || 5 });
  const [code, verifier] = await runDeviceFlow<[string, string]>(ctx, async () => {
    const reply = await authRequest(ctx, CODEX.deviceToken, { params: { device_auth_id: deviceId, user_code: userCode }, consumes: true, stage: "polling" });
    if (reply.ok) {
      const c = str(reply.body["authorization_code"]);
      const v = str(reply.body["code_verifier"]);
      if (!c || !v) throw new LoginDenied("ChatGPT device token response is missing required fields", { stage: "polling" });
      return { status: "complete", value: [c, v] };
    }
    if (reply.status === 403 || reply.status === 404) return { status: "pending" };
    const error = reply.body["error"];
    const code = typeof error === "object" && error !== null && !Array.isArray(error) ? (error as Record<string, unknown>)["code"] : error;
    if (code === "deviceauth_authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow_down" };
    throw new LoginDenied(`ChatGPT device authorization failed (HTTP ${reply.status})`, { reply, stage: "polling" });
  }, { intervalS, expiresInS: CODEX.deviceExpiresInS, waitBeforeFirstPoll: true });
  return exchange(ctx, code, verifier, CODEX.deviceRedirectUri);
}
