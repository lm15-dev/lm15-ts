/**
 * GitHub Copilot login; profiles.json `github-copilot`. Port of lm15-python
 * `lm15/login/flows/copilot.py`.
 *
 * GitHub's device flow yields a GitHub token, stored as `refresh`; renewal
 * re-mints a short-lived Copilot token from it. The Copilot token's
 * `proxy-ep` names the account's API host, accepted only under GitHub's own
 * domains (AUTH-20.9). Enterprise accounts give their domain as a field.
 * Model-policy enablement changes account settings and is never part of login
 * (AUTH-17). GitHub needs a person to press Authorize; nothing bypasses it.
 */

import { authRequest, httpsUrl, LoginDenied, positiveNumber, runDeviceFlow, type LoginContext } from "../engine.ts";
import { COPILOT, COPILOT_HEADERS, OAUTH_DEVICE_GRANT } from "../profiles.ts";
import type { LoginMaterial, OAuthMaterial } from "../types.ts";
import { oauth, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const DESCRIPTOR: FlowDescriptor = {
  id: "github-copilot", label: "GitHub Copilot", service: "GitHub", routes: ["github-copilot"],
  methods: [{
    id: "device", label: "Sign in with GitHub (Copilot subscription)", kind: "account", flow: "device_code",
    nativeAvailability: "unverified", reason: "login, catalog, inference, persistence and early renewal observed natively 2026-09-23; permission review pending",
    delivery: ["device"], subscription: true,
    fields: [{ id: "enterprise_domain", label: "GitHub Enterprise domain (blank for github.com)", type: "text", required: false, help: "e.g. company.ghe.com" }],
    billingNote: "Some models require enabling on your account first; LM15 does not change that setting during login.",
  }],
};

export function copilotDomain(settings: Readonly<Record<string, string>>): string {
  const raw = (settings["enterprise_domain"] ?? "").trim();
  if (!raw) return COPILOT.defaultDomain;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    throw new LoginDenied("invalid GitHub Enterprise domain");
  }
  if (!/^[a-z0-9.-]+$/.test(host)) throw new LoginDenied("invalid GitHub Enterprise domain");
  return host;
}

/** The account's API host from the Copilot token, validated against GitHub's domains; never an arbitrary host. */
export function copilotBaseUrl(material: OAuthMaterial, settings: Readonly<Record<string, string>>): string {
  const domain = copilotDomain(settings);
  const match = /proxy-ep=([^;]+)/.exec(material.access);
  if (match) {
    const apiHost = match[1]!.trim().toLowerCase().replace(/^proxy\./, "api.");
    const allowed = domain === COPILOT.defaultDomain ? [".githubcopilot.com"] : [`.${domain}`, ".githubcopilot.com"];
    if (/^[a-z0-9.-]+$/.test(apiHost) && allowed.some((suffix) => apiHost.endsWith(suffix))) return `https://${apiHost}`;
  }
  return domain === COPILOT.defaultDomain ? COPILOT.defaultApiBase : `https://copilot-api.${domain}`;
}

async function mint(ctx: LoginContext, githubToken: string, settings: Readonly<Record<string, string>>, stage: "exchange" | "renewal"): Promise<OAuthMaterial> {
  const reply = await authRequest(ctx, COPILOT.copilotToken(copilotDomain(settings)), { headers: { Authorization: `Bearer ${githubToken}` }, stage });
  if (reply.status === 401 || reply.status === 403) throw new LoginDenied("GitHub rejected the token for Copilot; sign in again", { reply, stage });
  if (!reply.ok) throw new LoginDenied(`Copilot token exchange failed (HTTP ${reply.status})`, { reply, stage });
  const token = str(reply.body["token"]);
  const expiresAt = reply.body["expires_at"];
  if (!token || typeof expiresAt !== "number") throw new LoginDenied("Copilot token response is missing required fields", { stage });
  const nowMs = ctx.wallClock();
  const expiresMs = Math.trunc(expiresAt * 1000);
  return Object.freeze({ type: "oauth", access: token, refresh: githubToken, issued_at: nowMs, lifetime_s: Math.max((expiresMs - nowMs) / 1000, 1), expires: expiresMs });
}

export const copilotFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: (_m, settings) => {
    const domain = copilotDomain(settings);
    return [COPILOT.deviceAuthorization(domain), COPILOT.deviceToken(domain), COPILOT.copilotToken(domain)];
  },

  async login(ctx: LoginContext, methodId: string, inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "device") throw new TypeError(methodId);
    const merged: Record<string, string> = { ...inputs.settings };
    if (inputs.answers["enterprise_domain"]) merged["enterprise_domain"] = inputs.answers["enterprise_domain"];
    const domain = copilotDomain(merged);
    const start = await authRequest(ctx, COPILOT.deviceAuthorization(domain), { params: { client_id: COPILOT.clientId, scope: COPILOT.scope }, stage: "authorization" });
    if (!start.ok) throw new LoginDenied(`GitHub refused to start a device authorization (HTTP ${start.status})`, { reply: start });
    const deviceCode = str(start.body["device_code"]);
    const userCode = str(start.body["user_code"]);
    if (!deviceCode || !userCode) throw new LoginDenied("GitHub device authorization response is missing required fields");
    const verification = httpsUrl(start.body["verification_uri"], "GitHub", true);
    const intervalS = positiveNumber(start.body["interval"]);
    const expiresInS = positiveNumber(start.body["expires_in"]);
    ctx.notify({ type: "device_code", userCode, verificationUrl: verification, expiresInS: expiresInS ?? 900, intervalS: intervalS ?? 5 });
    const githubToken = await runDeviceFlow<string>(ctx, async () => {
      const reply = await authRequest(ctx, COPILOT.deviceToken(domain), {
        params: { client_id: COPILOT.clientId, device_code: deviceCode, grant_type: OAUTH_DEVICE_GRANT }, consumes: true, stage: "polling",
      });
      const token = str(reply.body["access_token"]);
      if (token) return { status: "complete", value: token };
      const error = reply.body["error"];
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down", intervalS: positiveNumber(reply.body["interval"]) };
      if (error === "expired_token") return { status: "expired" };
      if (error === "access_denied") return { status: "denied" };
      throw new LoginDenied(`GitHub device authorization failed (HTTP ${reply.status})`, { reply, stage: "polling" });
    }, { intervalS, expiresInS });
    ctx.notify({ type: "progress", stage: "exchange", message: "Exchanging the GitHub token for a Copilot token…" });
    const material = await mint(ctx, githubToken, merged, "exchange");
    return {
      material, renewal: "remint",
      label: domain === COPILOT.defaultDomain ? "GitHub Copilot" : `GitHub Copilot (${domain})`,
      settings: domain === COPILOT.defaultDomain ? {} : { enterprise_domain: domain },
    };
  },

  async renew(ctx: LoginContext, saved: LoginMaterial, settings): Promise<FlowResult> {
    const githubToken = oauth(saved, "github-copilot").refresh;
    if (!githubToken) throw new LoginDenied("Copilot credential has no GitHub token to renew with", { stage: "renewal" });
    return { material: await mint(ctx, githubToken, settings, "renewal"), label: "GitHub Copilot", renewal: "remint" };
  },

  requestAuth(saved: LoginMaterial, settings) {
    const material = oauth(saved, "github-copilot");
    return { route: "github-copilot", credential: { kind: "bearer", value: material.access }, headers: { ...COPILOT_HEADERS }, baseUrl: copilotBaseUrl(material, settings) };
  },
};
