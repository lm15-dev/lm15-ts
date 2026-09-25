/**
 * OpenRouter sign-in that mints an API key; profiles.json `openrouter`.
 * Port of lm15-python `lm15/login/flows/openrouter.py`, plus the page-redirect
 * delivery a web page uses (lm15-ts examples/openrouter-page, live 2026-09-11).
 *
 * The result is a permanent, user-controlled key that spends the person's
 * OpenRouter credits, not a subscription (AUTH-13.7). OpenRouter echoes no
 * state, and it drops a fragment and a trailing `/` from the callback
 * (observed live from the playground, 2026-09-24), so no marker survives the
 * trip. The binding is PKCE plus the waiting attempt: a code is exchangeable
 * only with the verifier this attempt holds, so an injected code fails at the
 * exchange instead of signing anyone in (AUTH-18's evidenced equivalent).
 */

import { pkceChallenge } from "../../auth/pkce.ts";
import { authRequest, awaitReturn, LoginDenied, openListener, randomBase64Url, type LoginContext } from "../engine.ts";
import { OPENROUTER } from "../profiles.ts";
import type { LoginMaterial } from "../types.ts";
import { str, type FlowDescriptor, type FlowResult, type LoginInputs, type ProviderFlow } from "./base.ts";

const DESCRIPTOR: FlowDescriptor = {
  id: "openrouter", label: "OpenRouter", service: "OpenRouter", routes: ["openrouter"], consoleUrl: "https://openrouter.ai/keys",
  methods: [{
    id: "browser", label: "Sign in with OpenRouter (creates an API key for this app)", kind: "account", flow: "authorization_code",
    nativeAvailability: "unverified", reason: "native login, key limit, inference and persistence observed 2026-09-23; broader review pending",
    delivery: ["loopback", "manual", "page_redirect"], subscription: false,
    billingNote: "The minted key spends your OpenRouter credits like any other key.",
  }],
};

function authorizeUrl(callback: string, challenge: string): string {
  const url = new URL(OPENROUTER.authorizeUrl);
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export const openrouterFlow: ProviderFlow = {
  descriptor: DESCRIPTOR,

  requests: () => [OPENROUTER.keys],

  async login(ctx: LoginContext, methodId: string, inputs: LoginInputs): Promise<FlowResult> {
    if (methodId !== "browser") throw new TypeError(methodId);
    const verifier = randomBase64Url(OPENROUTER.verifierBytes);
    const challenge = await pkceChallenge(verifier);
    let returned;
    if (inputs.pageReturnUrl) {
      // A web page is the redirect target itself.
      const base = new URL(inputs.pageReturnUrl);
      base.search = "";
      base.hash = "";
      const callback = base.toString();
      ctx.notify({ type: "auth_url", url: authorizeUrl(callback, challenge), instructions: "Sign in to OpenRouter and approve the key. You are sent back to this page; if not, paste the address of the page you land on." });
      returned = await awaitReturn(ctx, {
        type: "manual_code", fieldId: "return", label: "Paste the address OpenRouter sent you back to", accepted: "the full return URL",
        pageReturn: { url: callback },
      }, { expectedState: null, allowBareCode: false, registeredUri: callback, trailingSlashOptional: true });
    } else {
      // Native: a one-shot listener on an ephemeral port with a random path. No state in OpenRouter's
      // protocol: the one-time random path plus PKCE is the evidenced equivalent binding (AUTH-18).
      const path = `/oauth/callback/${randomBase64Url(24)}`;
      const listener = await openListener(ctx, { path, expectedState: null, port: 0 }, true);
      try {
        ctx.notify({ type: "auth_url", url: authorizeUrl(listener!.redirectUri, challenge), instructions: "Sign in to OpenRouter in your browser and approve the key. If the browser is on another machine, paste the final redirect URL back here." });
        returned = await awaitReturn(ctx, {
          type: "manual_code", fieldId: "return", label: "Paste the redirect URL or code here (or wait for the browser)", accepted: "the full redirect URL, or the code",
        }, { expectedState: null, allowBareCode: true, registeredUri: listener!.redirectUri, trailingSlashOptional: true }, listener);
      } finally {
        listener?.stop();
      }
    }
    ctx.notify({ type: "progress", stage: "exchange", message: "Exchanging the code for an API key…" });
    const reply = await authRequest(ctx, OPENROUTER.keys, {
      params: { code: returned.code, code_verifier: verifier, code_challenge_method: "S256" }, consumes: true, stage: "exchange",
    });
    if (!reply.ok) throw new LoginDenied("OpenRouter rejected the authorization code", { reply, stage: "exchange" });
    const key = str(reply.body["key"]);
    if (!key) throw new LoginDenied("OpenRouter returned no key", { stage: "exchange" });
    return { material: Object.freeze({ type: "api_key", key, minted: true }), label: "OpenRouter (minted key)", renewal: "none" };
  },

  async renew(_ctx: LoginContext, saved: LoginMaterial): Promise<FlowResult> {
    return { material: saved, label: "OpenRouter (minted key)", renewal: "none" };
  },

  requestAuth(saved: LoginMaterial) {
    if (saved.type !== "api_key") throw new TypeError("openrouter: expected a minted key");
    return { route: "openrouter", credential: { kind: "api_key", value: saved.key }, headers: {} };
  },
};
