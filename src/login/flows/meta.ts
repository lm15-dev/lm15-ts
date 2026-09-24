/**
 * Meta (Muse subscription) device login + key mint; profiles.json `meta`.
 * Port of lm15-python `lm15/login/flows/meta.py`. The identity token is not
 * accepted for inference; it mints a Model API key living about a day.
 * Renewal re-mints; a 401/403 from the mint is a permanent rejection.
 */

import { authRequest, httpsUrl, LoginDenied, positiveNumber, runDeviceFlow, type LoginContext } from "../engine.ts";
import { META, OAUTH_DEVICE_GRANT } from "../profiles.ts";
import type { LoginMaterial, OAuthMaterial } from "../types.ts";
import { oauth, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const DESCRIPTOR: FlowDescriptor = {
  id: "meta", label: "Meta", service: "Meta", routes: ["meta", "meta-chat", "meta-anthropic"], consoleUrl: "https://dev.meta.ai",
  methods: [{
    id: "device", label: "Sign in with Meta (Muse subscription)", kind: "account", flow: "device_code",
    nativeAvailability: "unverified", reason: "no live receipt yet", delivery: ["device"], subscription: true,
    billingNote: "Minted Model API keys are tied to the Muse subscription; verify entitlement on your account.",
  }],
};

async function mint(ctx: LoginContext, identity: string, stage: "exchange" | "renewal"): Promise<OAuthMaterial> {
  ctx.notify({ type: "progress", stage: "exchange", message: "Enabling Meta Model API access…" });
  const reply = await authRequest(ctx, META.keyMint, { params: {}, headers: { Authorization: `Bearer ${identity}` }, stage });
  if (reply.status === 401 || reply.status === 403) throw new LoginDenied("Meta session is no longer valid; sign in again", { reply, stage });
  if (!reply.ok) throw new LoginDenied(`Meta API key mint failed (HTTP ${reply.status})`, { reply, stage });
  const key = str(reply.body["api_key"]);
  if (!key) {
    let action: string | undefined;
    try {
      action = str(reply.body["action_url"]) ? httpsUrl(reply.body["action_url"], "Meta") : undefined;
    } catch {
      action = undefined;
    }
    throw new LoginDenied(`Meta did not issue an API key${action ? `; complete setup at ${action}` : ""}`, { stage });
  }
  const nowMs = ctx.wallClock();
  return Object.freeze({ type: "oauth", access: key, refresh: identity, issued_at: nowMs, lifetime_s: META.keyLifetimeS, expires: Math.trunc(nowMs + META.keyLifetimeS * 1000) });
}

export const metaFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: () => [META.deviceAuthorization, META.deviceToken, META.keyMint],

  async login(ctx: LoginContext, methodId: string, _inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "device") throw new TypeError(methodId);
    const start = await authRequest(ctx, META.deviceAuthorization, { params: { client_id: META.clientId }, stage: "authorization" });
    if (!start.ok) throw new LoginDenied(`Meta refused to start a device authorization (HTTP ${start.status})`, { reply: start });
    const deviceCode = str(start.body["device_code"]);
    const userCode = str(start.body["user_code"]);
    const raw = str(start.body["verification_uri_complete"]) ?? str(start.body["verification_uri"]);
    if (!deviceCode || !userCode || !raw) throw new LoginDenied("Meta device authorization response is missing required fields");
    const verification = httpsUrl(raw, "Meta", true);
    const intervalS = positiveNumber(start.body["interval"]);
    const expiresInS = positiveNumber(start.body["expires_in"]);
    ctx.notify({ type: "device_code", userCode, verificationUrl: verification, expiresInS: expiresInS ?? 900, intervalS: intervalS ?? 5 });
    const identity = await runDeviceFlow<string>(ctx, async () => {
      const reply = await authRequest(ctx, META.deviceToken, { params: { grant_type: OAUTH_DEVICE_GRANT, device_code: deviceCode, client_id: META.clientId }, consumes: true, stage: "polling" });
      const token = str(reply.body["access_token"]);
      if (reply.ok && token) return { status: "complete", value: token };
      const error = reply.body["error"];
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down", intervalS: positiveNumber(reply.body["interval"]) };
      if (error === "access_denied") return { status: "denied" };
      if (error === "expired_token") return { status: "expired" };
      throw new LoginDenied(`Meta device token request failed (HTTP ${reply.status})`, { reply, stage: "polling" });
    }, { intervalS, expiresInS });
    return { material: await mint(ctx, identity, "exchange"), label: "Meta (Muse subscription)", renewal: "remint" };
  },

  async renew(ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    const identity = oauth(saved, "meta").refresh;
    if (!identity) throw new LoginDenied("Meta credential has no identity token to re-mint with", { stage: "renewal" });
    return { material: await mint(ctx, identity, "renewal"), label: "Meta (Muse subscription)", renewal: "remint" };
  },

  requestAuth(saved: LoginMaterial) {
    return { route: "meta", credential: { kind: "api_key", value: oauth(saved, "meta").access }, headers: {} };
  },
};
