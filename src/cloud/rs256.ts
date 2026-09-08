/**
 * RS256 (RSASSA-PKCS1-v1_5 / SHA-256) JWT assertions (spec/auth.md
 * AUTH-11 `jwt-rs256`) on the platform RSA (`node:crypto`), deterministic:
 * the harness compares the assertion byte for byte.
 *
 * lm15 pins one JWS serialization: compact JSON, keys in the caller's
 * order, base64url without padding.
 */

import { X509Certificate, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { NotConfiguredError } from "../errors.ts";
import { stringifyJson, type JsonObject } from "../json.ts";

export function b64url(data: Uint8Array | Buffer): string {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Parse an unencrypted RSA private key from PEM (PKCS#8 or PKCS#1). */
export function loadPrivateKey(pem: string): KeyObject {
  if (pem.includes("ENCRYPTED PRIVATE KEY") || pem.includes("Proc-Type: 4,ENCRYPTED")) {
    throw new NotConfiguredError("encrypted private keys are not supported; decrypt it first: openssl pkey -in key.pem -out key-plain.pem", {
      credentialHint: "openssl pkey -in key.pem -out key-plain.pem",
    });
  }
  if (pem.includes("BEGIN EC PRIVATE KEY")) throw new NotConfiguredError("EC private keys are not supported (RS256 needs an RSA key)");
  const block = pemBlock(pem, "PRIVATE KEY") ?? pemBlock(pem, "RSA PRIVATE KEY");
  if (!block) {
    throw new NotConfiguredError("no PEM private key found; PKCS#12 (.pfx/.p12) is not parsed — convert with: openssl pkcs12 -in cert.pfx -nodes -out cert.pem", {
      credentialHint: "openssl pkcs12 -in cert.pfx -nodes -out cert.pem",
    });
  }
  const key = createPrivateKey(block);
  if (key.asymmetricKeyType !== "rsa") throw new NotConfiguredError(`${key.asymmetricKeyType} private keys are not supported (RS256 needs an RSA key)`);
  return key;
}

function pemBlock(text: string, label: string): string | undefined {
  const head = `-----BEGIN ${label}-----`;
  const tail = `-----END ${label}-----`;
  const start = text.indexOf(head);
  if (start < 0) return undefined;
  const end = text.indexOf(tail, start);
  if (end < 0) throw new Error(`PEM block '${label}' has no END line`);
  return text.slice(start, end + tail.length);
}

/** The DER bytes of the first CERTIFICATE block (for `x5t` thumbprints). */
export function certificateDer(pem: string): Buffer {
  const block = pemBlock(pem, "CERTIFICATE");
  if (!block) throw new NotConfiguredError("no PEM CERTIFICATE block found");
  return Buffer.from(new X509Certificate(block).raw);
}

export function signPkcs1v15Sha256(key: KeyObject, message: Uint8Array): Buffer {
  return createSign("RSA-SHA256").update(message).sign(key);
}

/** Compact JWS with the pinned serialization. */
export function jwtEncode(header: JsonObject, payload: JsonObject, key: KeyObject): string {
  const head = b64url(Buffer.from(stringifyJson(header), "utf-8"));
  const body = b64url(Buffer.from(stringifyJson(payload), "utf-8"));
  const signingInput = Buffer.from(`${head}.${body}`, "ascii");
  return `${head}.${body}.${b64url(signPkcs1v15Sha256(key, signingInput))}`;
}
