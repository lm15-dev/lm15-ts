/**
 * Signing in with OpenRouter from a page: PKCE (RFC 7636, S256).
 *
 * The user is sent to OpenRouter's authorization page with a challenge;
 * OpenRouter sends them back here with a one-time code; the page exchanges
 * the code plus the verifier for a key the user controls and can revoke.
 * No application secret exists anywhere — a page cannot keep one.
 *
 * lm15 supplies the PKCE pair (`generatePkce`); the URL, the redirect and
 * the exchange are OpenRouter's protocol (openrouter.ai/docs → OAuth PKCE)
 * and this application's job. The verifier waits out the redirect in
 * `sessionStorage`: tab-scoped, gone when the tab closes, never in a URL.
 * OpenRouter's flow carries no `state` parameter; the verifier is what
 * binds the returned code to the tab that started the sign-in.
 */

import { generatePkce, utf8Encode } from "lm15/browser";

export interface LoginEndpoints {
  /** The authorization page the user is sent to. */
  readonly authorize: string;
  /** The code exchange; answers `{ key }`. */
  readonly exchange: string;
  /** Where a key's settings and usage live, keyed by the SHA-256 of the key. */
  readonly manage: string;
  /** The authenticated "this key": label, usage, limit. The one call that proves a key is a key. */
  readonly keyInfo: string;
}

export const OPENROUTER: LoginEndpoints = Object.freeze({
  authorize: "https://openrouter.ai/auth",
  exchange: "https://openrouter.ai/api/v1/auth/keys",
  manage: "https://openrouter.ai/keys",
  keyInfo: "https://openrouter.ai/api/v1/auth/key",
});

const VERIFIER = "lm15-example.pkce-verifier";

export class LoginError extends Error {
  override readonly name = "LoginError";
}

/** Start: a fresh pair, the verifier parked for the redirect, the URL to send the user to. */
export async function beginLogin(callbackUrl: string, endpoints: LoginEndpoints = OPENROUTER, storage: Storage = sessionStorage): Promise<URL> {
  const pair = await generatePkce();
  storage.setItem(VERIFIER, pair.verifier);
  const url = new URL(endpoints.authorize);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", pair.challenge);
  url.searchParams.set("code_challenge_method", pair.method);
  return url;
}

/** The one-time code OpenRouter appended to the callback, if this load is the return leg. */
export function pendingCode(search: string): string | undefined {
  const code = new URLSearchParams(search).get("code");
  return code && code.trim() ? code.trim() : undefined;
}

/** Finish: exchange the code and the parked verifier for the user's key. The verifier is cleared either way. */
export async function completeLogin(code: string, endpoints: LoginEndpoints = OPENROUTER, storage: Storage = sessionStorage): Promise<string> {
  const verifier = storage.getItem(VERIFIER);
  storage.removeItem(VERIFIER);
  if (!verifier) throw new LoginError("This tab has no login in progress (the verifier is gone: a different tab, or the tab was closed). Start the sign-in again.");
  let res: Response;
  try {
    res = await fetch(endpoints.exchange, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
  } catch (e) {
    throw new LoginError(`The code exchange could not be reached (${String(e)}).`);
  }
  if (!res.ok) throw new LoginError(exchangeFailure(res.status, await res.text().catch(() => "")));
  const data = (await res.json().catch(() => ({}))) as { key?: unknown };
  if (typeof data.key !== "string" || data.key === "") throw new LoginError("The code exchange answered without a key.");
  return data.key;
}

function exchangeFailure(status: number, body: string): string {
  // OpenRouter's documented codes (openrouter.ai/docs → OAuth PKCE → Error Codes).
  if (status === 400) return "The exchange refused the challenge method (400). This page always uses S256; the sign-in link was not made by this page.";
  if (status === 403 && /expired/i.test(body)) return "The sign-in code expired (403; codes last 10 minutes). Start the sign-in again.";
  if (status === 403) return "The exchange refused the code or verifier (403). Sign in again from this tab.";
  if (status === 405) return "The exchange wants POST over HTTPS (405).";
  return `The code exchange failed (HTTP ${status}).`;
}

/** SHA-256 of the key, lowercase hex: what OpenRouter's key-management links take. The key itself never goes in a URL. */
export async function keyHash(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(key)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The user's key page on OpenRouter, for the signed-in key. */
export async function manageUrl(key: string, endpoints: LoginEndpoints = OPENROUTER): Promise<string> {
  return `${endpoints.manage}/${await keyHash(key)}`;
}

export interface KeyInfo {
  /** OpenRouter's display label for the key (a redacted spelling of it). */
  readonly label: string;
  /** Credit spent through this key, USD. */
  readonly usage: number;
  /** The key's credit limit, USD, or null when unlimited. */
  readonly limit: number | null;
  readonly limitRemaining: number | null;
  readonly isFreeTier: boolean;
}

/**
 * Verify a key and describe it. OpenRouter's `/models` is public — a wrong
 * key lists models fine — so a page that wants to know it holds a working
 * key asks this endpoint, which answers 401 to anything else.
 */
export async function keyInfo(key: string, endpoints: LoginEndpoints = OPENROUTER): Promise<KeyInfo> {
  let res: Response;
  try {
    res = await fetch(endpoints.keyInfo, { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    throw new LoginError(`OpenRouter could not be reached to check the key (${String(e)}).`);
  }
  if (res.status === 401) throw new LoginError("OpenRouter does not recognise this key (401). Check it, or sign in to make a new one.");
  if (!res.ok) throw new LoginError(`Checking the key failed (HTTP ${res.status}).`);
  const data = ((await res.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    label: typeof data["label"] === "string" ? data["label"] : "(unlabelled key)",
    usage: num(data["usage"]) ?? 0,
    limit: num(data["limit"]),
    limitRemaining: num(data["limit_remaining"]),
    isFreeTier: data["is_free_tier"] === true,
  };
}
