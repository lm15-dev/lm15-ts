/**
 * xAI subscription login (RFC 8628 device code); profiles.json `xai.device`.
 * Port of lm15-python `lm15/login/flows/xai.py`: same client, same requests,
 * same material shape, so an entry either SDK writes is the other's.
 */

import { authRequest, LoginDenied, positiveNumber, runDeviceFlow, httpsUrl, type LoginContext } from "../engine.ts";
import { OAUTH_DEVICE_GRANT, XAI } from "../profiles.ts";
import type { LoginMaterial, OAuthMaterial } from "../types.ts";
import { oauth, oauthMaterial, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const DESCRIPTOR: FlowDescriptor = {
  id: "xai", label: "xAI", service: "xAI", routes: ["xai"], consoleUrl: "https://console.x.ai",
  methods: [{
    id: "device", label: "Sign in with SuperGrok or X Premium", kind: "account", flow: "device_code",
    nativeAvailability: "supported", delivery: ["device"], subscription: true,
    billingNote: "Subscription access per xAI's own recommendation (2026-09-01); the API key path is metered.",
  }],
};

function materialFromToken(body: Record<string, unknown>, nowMs: number, previousRefresh?: string): OAuthMaterial {
  const access = str(body["access_token"]);
  if (!access) throw new LoginDenied("xAI token response carried no access token", { stage: "exchange" });
  const refresh = str(body["refresh_token"]) ?? previousRefresh; // xAI may omit it when it does not rotate
  return oauthMaterial({ access, refresh, expiresInS: positiveNumber(body["expires_in"]) ?? XAI.lifetimeWhenAbsentS, nowMs });
}

export const xaiFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: () => [XAI.deviceAuthorization, XAI.token],

  async login(ctx: LoginContext, methodId: string, _inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "device") throw new TypeError(methodId);
    const start = await authRequest(ctx, XAI.deviceAuthorization, { params: { client_id: XAI.clientId, scope: XAI.scope, referrer: XAI.referrer }, stage: "authorization" });
    if (!start.ok) throw new LoginDenied(`xAI refused to start a device authorization (HTTP ${start.status})`, { reply: start });
    const deviceCode = str(start.body["device_code"]);
    const userCode = str(start.body["user_code"]);
    if (!deviceCode || !userCode) throw new LoginDenied("xAI device authorization response is missing required fields");
    const verification = httpsUrl(start.body["verification_uri"], "xAI");
    const complete = str(start.body["verification_uri_complete"]);
    const target = complete ? httpsUrl(complete, "xAI") : verification;
    const intervalS = positiveNumber(start.body["interval"]);
    const expiresInS = positiveNumber(start.body["expires_in"]);
    ctx.notify({ type: "device_code", userCode, verificationUrl: target, expiresInS: expiresInS ?? 900, intervalS: intervalS ?? 5 });
    const material = await runDeviceFlow(ctx, async () => {
      const reply = await authRequest(ctx, XAI.token, { params: { grant_type: OAUTH_DEVICE_GRANT, client_id: XAI.clientId, device_code: deviceCode }, consumes: true, stage: "polling" });
      if (reply.ok) return { status: "complete", value: materialFromToken(reply.body, ctx.wallClock()) };
      const error = reply.body["error"];
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down", intervalS: positiveNumber(reply.body["interval"]) };
      if (error === "access_denied" || error === "authorization_denied") return { status: "denied" };
      if (error === "expired_token") return { status: "expired" };
      throw new LoginDenied(`xAI device token polling failed (HTTP ${reply.status})`, { reply, stage: "polling" });
    }, { intervalS, expiresInS });
    return { material, label: "xAI subscription", renewal: "refresh_token" };
  },

  async renew(ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    const material = oauth(saved, "xai");
    if (!material.refresh) throw new LoginDenied("xAI credential has no refresh token", { stage: "renewal" });
    const reply = await authRequest(ctx, XAI.token, { params: { grant_type: "refresh_token", client_id: XAI.clientId, refresh_token: material.refresh }, consumes: true, stage: "renewal" });
    if (!reply.ok) throw new LoginDenied(`xAI token renewal failed`, { reply, stage: "renewal" });
    return { material: materialFromToken(reply.body, ctx.wallClock(), material.refresh), label: "xAI subscription", renewal: "refresh_token" };
  },

  requestAuth(saved: LoginMaterial) {
    return { route: "xai", credential: { kind: "bearer", value: oauth(saved, "xai").access }, headers: {} };
  },
};
