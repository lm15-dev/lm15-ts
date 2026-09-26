/**
 * Reading a JWT's unverified claims. lm15 never validates a signature here:
 * these helpers only recognise a token's shape (AUTH-2 scheme selection) and
 * lift a claim the wire needs as a header (the Codex `chatgpt-account-id`).
 */

import { base64Decode, utf8Decode } from "../bytes.ts";
import { isJsonObject, parseJson, type JsonObject } from "../json.ts";

const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

function segmentJson(segment: string): unknown {
  return parseJson(utf8Decode(base64Decode(segment)));
}

/** The header of a three-part token names an `alg`: the shape a bearer JWT has. */
export function looksLikeJwt(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return false;
  try {
    const header = segmentJson(parts[0]!);
    return isJsonObject(header) && "alg" in header;
  } catch {
    return false;
  }
}

/**
 * The token shape a plain string has, if any (AUTH-2, amended 2026-09-19 and
 * 2026-09-26): a JWS compact JWT, or a Google OAuth access token (`ya29.`,
 * what every Google token endpoint issues). No key any door issues has either.
 */
export function looksLikeAccessToken(text: string): "JWT" | "Google access token" | undefined {
  if (text.startsWith("ya29.")) return "Google access token";
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text) && looksLikeJwt(text)) return "JWT";
  return undefined;
}

/** The payload claims of a three-part token, unverified. Throws on a non-JWT. */
export function decodeJwtPayload(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const data = segmentJson(parts[1]!);
  return isJsonObject(data) ? data : {};
}

/** The ChatGPT account id a Codex access token carries, when it is one. */
export function extractChatgptAccountId(token: string): string | undefined {
  try {
    const claim = decodeJwtPayload(token)[OPENAI_CODEX_JWT_CLAIM_PATH];
    if (isJsonObject(claim) && typeof claim["chatgpt_account_id"] === "string" && claim["chatgpt_account_id"]) return claim["chatgpt_account_id"];
  } catch {
    // not a JWT
  }
  return undefined;
}
