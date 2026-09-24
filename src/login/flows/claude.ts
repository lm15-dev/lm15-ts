/**
 * Claude subscription login owned by LM15; profiles.json `claude-code`.
 * Port of lm15-python `lm15/login/flows/claude.py` (2026-09-23).
 *
 * `browser`: Claude's hosted code page. The person copies the displayed
 * `code#state` (or the whole return URL) back; no listener, so the browser may
 * be on another machine, and a web page can run it too. `loopback` needs a
 * local listener; this build has none (the native port adds it), so it offers
 * manual return only, which the registration also accepts.
 */

import { pkceChallenge } from "../../auth/pkce.ts";
import { authRequest, awaitReturn, LoginDenied, randomBase64Url, type LoginContext } from "../engine.ts";
import { CLAUDE } from "../profiles.ts";
import type { LoginMaterial } from "../types.ts";
import { oauth, oauthMaterial, str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const BILLING = "Provider permission and included usage must be verified separately for your account.";

const DESCRIPTOR: FlowDescriptor = {
  id: "claude-code", label: "Claude (subscription)", service: "Anthropic", routes: ["claude-code"],
  methods: [
    {
      id: "browser", label: "Sign in with Claude (paste code from hosted page)", kind: "account", flow: "authorization_code",
      nativeAvailability: "unverified",
      reason: "hosted login, inference, persistence and early renewal observed natively 2026-09-23; permission and billing unverified",
      delivery: ["manual"], subscription: true, billingNote: BILLING,
    },
    {
      id: "loopback", label: "Sign in with Claude (local browser callback)", kind: "account", flow: "authorization_code",
      nativeAvailability: "unverified", reason: "no live receipt for the local callback flow",
      delivery: ["loopback", "manual"], subscription: true, billingNote: BILLING,
    },
  ],
};

function tokens(body: Record<string, unknown>, nowMs: number) {
  const access = str(body["access_token"]);
  const refresh = str(body["refresh_token"]);
  if (!access || !refresh) throw new LoginDenied("Claude token response is missing required fields", { stage: "exchange" });
  const expiresIn = body["expires_in"];
  return oauthMaterial({ access, refresh, expiresInS: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : undefined, nowMs });
}

export const claudeFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: () => [CLAUDE.token],

  async login(ctx: LoginContext, methodId: string, _inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "browser" && methodId !== "loopback") throw new TypeError(methodId);
    ctx.check();
    const hosted = methodId === "browser";
    const verifier = randomBase64Url(hosted ? CLAUDE.hostedVerifierBytes : CLAUDE.loopbackVerifierBytes);
    const challenge = await pkceChallenge(verifier);
    const state = randomBase64Url(CLAUDE.stateBytes);
    const redirectUri = hosted ? CLAUDE.redirectUri : CLAUDE.loopbackRedirectUri;
    const url = new URL(hosted ? CLAUDE.authorizeUrl : CLAUDE.loopbackAuthorizeUrl);
    for (const [k, v] of Object.entries({
      code: "true", client_id: CLAUDE.clientId, response_type: "code", redirect_uri: redirectUri, scope: CLAUDE.scope,
      code_challenge: challenge, code_challenge_method: "S256", state,
    })) url.searchParams.set(k, v);
    ctx.notify({
      type: "auth_url", url: url.toString(),
      instructions: hosted
        ? "Sign in to Claude. On the Authentication code page, copy the whole displayed code (including the part after #) and paste it here. The full return URL also works."
        : "Sign in to Claude. The browser then tries to open localhost:53692, which fails without a local listener; copy that page's full address and paste it here.",
    });
    const returned = await awaitReturn(ctx, {
      type: "manual_code", fieldId: "return", label: "Paste the full code#state or return URL",
      accepted: "the full return URL, or code#state (a bare code without state is not accepted)",
    }, { expectedState: state, allowBareCode: false, registeredUri: redirectUri });
    ctx.notify({ type: "progress", stage: "exchange", message: "Exchanging the authorization code…" });
    const reply = await authRequest(ctx, CLAUDE.token, {
      params: { grant_type: "authorization_code", code: returned.code, redirect_uri: redirectUri, client_id: CLAUDE.clientId, code_verifier: verifier, state },
      consumes: true, stage: "exchange",
    });
    if (!reply.ok) throw new LoginDenied("Claude authorization-code exchange failed; the code will not be retried automatically", { reply, stage: "exchange" });
    return { material: tokens(reply.body, ctx.wallClock()), label: "Claude subscription", renewal: "refresh_token" };
  },

  async renew(ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    const material = oauth(saved, "claude-code");
    if (!material.refresh) throw new LoginDenied("Claude credential has no refresh token", { stage: "renewal" });
    const reply = await authRequest(ctx, CLAUDE.token, {
      params: { grant_type: "refresh_token", client_id: CLAUDE.clientId, refresh_token: material.refresh }, consumes: true, stage: "renewal",
    });
    if (!reply.ok) throw new LoginDenied("Claude token renewal failed", { reply, stage: "renewal" });
    return { material: tokens(reply.body, ctx.wallClock()), label: "Claude subscription", renewal: "refresh_token" };
  },

  requestAuth(saved: LoginMaterial) {
    return { route: "claude-code", credential: { kind: "bearer", value: oauth(saved, "claude-code").access }, headers: {} };
  },
};
