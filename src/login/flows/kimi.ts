/**
 * Kimi Code (subscription) device login; profiles.json `kimi-code`. Port of
 * lm15-python `lm15/login/flows/kimi.py`. The token authenticates the Anthropic
 * Messages wire at api.kimi.com/coding (the declared `kimi-code` route).
 */

import { authRequest, httpsUrl, LoginDenied, positiveNumber, runDeviceFlow, type LoginContext } from "../engine.ts";
import { KIMI, OAUTH_DEVICE_GRANT } from "../profiles.ts";
import type { LoginMaterial } from "../types.ts";
import { oauth, oauthMaterial, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";
import { RateLimitError } from "../../errors.ts";

const DESCRIPTOR: FlowDescriptor = {
  id: "kimi-code", label: "Kimi Code (subscription)", service: "Moonshot AI", routes: ["kimi-code"],
  methods: [{
    id: "device", label: "Sign in with Kimi Code (subscription)", kind: "account", flow: "device_code",
    nativeAvailability: "unverified", reason: "no live receipt yet", delivery: ["device"], subscription: true,
  }],
};

function host(settings: Readonly<Record<string, string>>): string {
  return (settings["oauth_host"] || KIMI.host).replace(/\/$/, "");
}

function tokens(body: Record<string, unknown>, nowMs: number) {
  const access = str(body["access_token"]);
  const refresh = str(body["refresh_token"]);
  if (!access || !refresh) throw new LoginDenied("Kimi Code token response is missing required fields", { stage: "exchange" });
  return oauthMaterial({ access, refresh, expiresInS: positiveNumber(body["expires_in"]), nowMs });
}

export const kimiFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: (_m, settings) => [KIMI.deviceAuthorization(host(settings)), KIMI.token(host(settings))],

  async login(ctx: LoginContext, methodId: string, inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "device") throw new TypeError(methodId);
    const h = host(inputs.settings);
    const start = await authRequest(ctx, KIMI.deviceAuthorization(h), { params: { client_id: KIMI.clientId }, stage: "authorization" });
    if (!start.ok) throw new LoginDenied(`Kimi Code refused to start a device authorization (HTTP ${start.status})`, { reply: start });
    const deviceCode = str(start.body["device_code"]);
    const userCode = str(start.body["user_code"]);
    const raw = str(start.body["verification_uri_complete"]) ?? str(start.body["verification_uri"]);
    if (!deviceCode || !userCode || !raw) throw new LoginDenied("Kimi Code device authorization response is missing required fields");
    const verification = httpsUrl(raw, "Kimi Code", true);
    const intervalS = positiveNumber(start.body["interval"]);
    const expiresInS = positiveNumber(start.body["expires_in"]) ?? KIMI.deviceExpiresInS;
    ctx.notify({ type: "device_code", userCode, verificationUrl: verification, expiresInS, intervalS: intervalS ?? 5 });
    const material = await runDeviceFlow(ctx, async () => {
      const reply = await authRequest(ctx, KIMI.token(h), { params: { client_id: KIMI.clientId, device_code: deviceCode, grant_type: OAUTH_DEVICE_GRANT }, consumes: true, stage: "polling" });
      if (reply.ok && str(reply.body["access_token"])) return { status: "complete", value: tokens(reply.body, ctx.wallClock()) };
      const error = reply.body["error"];
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down", intervalS: positiveNumber(reply.body["interval"]) };
      if (error === "expired_token") return { status: "expired" };
      if (error === "access_denied") return { status: "denied" };
      throw new LoginDenied(`Kimi Code device token request failed (HTTP ${reply.status})`, { reply, stage: "polling" });
    }, { intervalS, expiresInS });
    return { material, label: "Kimi Code subscription", renewal: "refresh_token", settings: h !== KIMI.host ? { oauth_host: h } : {} };
  },

  async renew(ctx: LoginContext, saved: LoginMaterial, settings): Promise<FlowResult> {
    const material = oauth(saved, "kimi-code");
    if (!material.refresh) throw new LoginDenied("Kimi Code credential has no refresh token", { stage: "renewal" });
    const reply = await authRequest(ctx, KIMI.token(host(settings)), { params: { client_id: KIMI.clientId, grant_type: "refresh_token", refresh_token: material.refresh }, consumes: true, stage: "renewal" });
    if (reply.status === 401 || reply.status === 403 || reply.body["error"] === "invalid_grant") throw new LoginDenied("Kimi Code rejected the refresh token", { reply, stage: "renewal" });
    // 429 is transient: not a rejection of the credential (profiles.json renewal_errors).
    if (!reply.ok) throw new RateLimitError(`Kimi Code rate-limited the token refresh (HTTP ${reply.status})`, { provider: "kimi-code", status: reply.status });
    return { material: tokens(reply.body, ctx.wallClock()), label: "Kimi Code subscription", renewal: "refresh_token" };
  },

  requestAuth(saved: LoginMaterial) {
    return { route: "kimi-code", credential: { kind: "bearer", value: oauth(saved, "kimi-code").access }, headers: {}, baseUrl: KIMI.inferenceBaseUrl };
  },
};
