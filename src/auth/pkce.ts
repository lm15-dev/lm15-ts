/**
 * PKCE (RFC 7636, S256 only) over Web Crypto: the login-flow primitive an
 * application that owns its own login UX needs to send a user to a
 * provider's authorization page and prove, at the code exchange, that it
 * is the same application. Universal: `crypto.subtle` and
 * `crypto.getRandomValues` exist in every browser and in Node.
 *
 * lm15 supplies the pair and nothing else here: the authorization URL, the
 * redirect, and the exchange are the provider's protocol and the
 * application's UX (see examples/openrouter-page). The Python package's
 * `lm15.authkit` is the same primitive; the RFC's own vector pins both.
 */

import { base64UrlEncode, utf8Encode } from "../bytes.ts";

export interface PkcePair {
  /** Secret until the code exchange; never log it, never put it in a URL. */
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The S256 challenge for `verifier` (RFC 7636 §4.2): base64url(SHA-256(ascii(verifier))), unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!VERIFIER_RE.test(verifier)) throw new TypeError("PKCE verifier must be 43–128 unreserved characters (RFC 7636 §4.1)");
  const digest = await crypto.subtle.digest("SHA-256", utf8Encode(verifier));
  return base64UrlEncode(digest);
}

/** A fresh pair: 64 random bytes → an 86-character base64url verifier, and its challenge. */
export async function generatePkce(): Promise<PkcePair> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}
