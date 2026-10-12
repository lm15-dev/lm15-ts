/**
 * Meta (Muse Code subscription) device login + key mint; profiles.json `meta`.
 * Port of lm15-python `lm15/login/flows/meta.py`. The identity token is not
 * accepted for inference; it mints the account's Muse Code key (the same key
 * on every mint, live 2026-10-12). Renewal re-mints daily; a 401/403 from the
 * mint is a permanent rejection. The mint's `base_url` is where requests go,
 * and only when it is an https meta.ai host; its plan is the account label
 * (lm15-contract changes/2026-10-12-muse-code-subscription.md).
 */

import { authRequest, httpsUrl, LoginDenied, positiveNumber, runDeviceFlow, type LoginContext } from "../engine.ts";
import { META, OAUTH_DEVICE_GRANT } from "../profiles.ts";
import type { LoginMaterial, OAuthMaterial } from "../types.ts";
import { oauth, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const TERMS_NOTE = "Meta's Model API terms (§ 3.2) reserve the Muse Code key for Muse Code; using it here is outside "
  + "those terms and puts the Meta account at risk. Subscription traffic is Contributor mode by default "
  + "(Meta may train on it).";

const DESCRIPTOR: FlowDescriptor = {
  id: "meta", label: "Meta", service: "Meta", routes: ["meta", "meta-chat", "meta-anthropic"], consoleUrl: "https://dev.meta.ai",
  methods: [{
    id: "device", label: "Sign in with Meta (Muse subscription)", kind: "account", flow: "device_code",
    nativeAvailability: "unverified", reason: "login, mint and inference observed 2026-10-12; " + TERMS_NOTE,
    delivery: ["device"], subscription: true,
    billingNote: "Billed to the Muse Code plan when it is active (muse-wonder-full-1.0 needs Power or Maximum "
      + "Usage); without one, Meta bills the key pay-as-you-go.",
  }],
};

/** The mint's `base_url` when the key may go there: https, a meta.ai host, no userinfo or query. */
function apiBase(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  const host = url?.hostname ?? "";
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search
      || !(host === "meta.ai" || host.endsWith(".meta.ai"))) {
    throw new LoginDenied("Meta named an API address outside meta.ai for the minted key; refusing to send it there");
  }
  return (value as string).replace(/\/+$/, "");
}

/** Display text for the account's plan; undefined when the reply is silent. */
function plan(body: Readonly<Record<string, unknown>>): string | undefined {
  if (body["is_subs_active"] === true) return str(body["subs_tier_name"]) ?? "Muse Code subscription";
  if (body["is_subs_active"] === false) return "no Muse Code subscription (pay-as-you-go)";
  return undefined;
}

function result(minted: { material: OAuthMaterial; accountLabel: string | undefined }): FlowResult {
  return { material: minted.material, label: "Meta (Muse subscription)", renewal: "remint",
    ...(minted.accountLabel !== undefined ? { accountLabel: minted.accountLabel } : {}) };
}

async function mint(ctx: LoginContext, identity: string, stage: "exchange" | "renewal"): Promise<{ material: OAuthMaterial; accountLabel: string | undefined }> {
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
  const baseUrl = apiBase(reply.body["base_url"]);
  const nowMs = ctx.wallClock();
  const material: OAuthMaterial = Object.freeze({
    type: "oauth", access: key, refresh: identity, issued_at: nowMs, lifetime_s: META.keyLifetimeS,
    expires: Math.trunc(nowMs + META.keyLifetimeS * 1000), ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
  });
  return { material, accountLabel: plan(reply.body) };
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
    return result(await mint(ctx, identity, "exchange"));
  },

  async renew(ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    const identity = oauth(saved, "meta").refresh;
    if (!identity) throw new LoginDenied("Meta credential has no identity token to re-mint with", { stage: "renewal" });
    return result(await mint(ctx, identity, "renewal"));
  },

  requestAuth(saved: LoginMaterial) {
    const material = oauth(saved, "meta");
    return { route: "meta", credential: { kind: "api_key", value: material.access }, headers: {},
      ...(material.base_url ? { baseUrl: material.base_url } : {}) };
  },
};
