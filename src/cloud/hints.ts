/**
 * Guidance for a cloud door's refusals. Pure (no platform module), so the
 * adapter can use it on every host, the browser included.
 */

import type { AccessPolicy } from "../auth/policy.ts";

/**
 * How a cloud door's wire refusal (HTTP 401/403 after a credential was
 * obtained) is fixed; replaces the generic API-key guidance. `sent` is what
 * the adapter knows it sent: "key", "token", or undefined (a callable).
 */
export function wireAuthHint(policy: AccessPolicy, status: number | null | undefined, sent: "key" | "token" | undefined): string | undefined {
  if (policy.credentialPolicy !== "gcp-chain") return undefined;
  if (status === 403) {
    return "give the identity named above the Vertex AI User role (roles/aiplatform.user) on the project and enable the Vertex AI API (aiplatform.googleapis.com); a new project or a new grant can take a few minutes to apply. To use another identity: `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS=<file>";
  }
  if (status !== 401) return undefined;
  if (sent === "key") {
    return "Google refused this API key: use a Vertex AI key (Cloud console > APIs & Services > Credentials, restricted to the Vertex AI API or bound to a service account); Claude on Vertex takes no keys. If the value is an access token that does not start with `ya29.`, pass new BearerToken(value)";
  }
  return "Google refused this access token: it expired (they last an hour; pass a callable, or let lm15's chain refresh it) or it is not an OAuth token. Sign in again with `gcloud auth application-default login`";
}
