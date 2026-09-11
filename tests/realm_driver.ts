/**
 * The corpus operations, phrased so that only strings cross a realm
 * boundary: a case's JSON in, the built wire request (or the parsed
 * canonical response) as JSON out. Loaded twice by `web_realm.test.ts` —
 * once as an ordinary module on the Node host, once inside a realm that
 * has only web globals — and the two outputs must agree byte for byte.
 *
 * Imports the web entry only: the realm has nothing else to import.
 */

import {
  AwsCredentials,
  Credential,
  HttpResponse,
  NotConfiguredError,
  Request,
  Response,
  StreamEvent,
  adapterFor,
  base64Decode,
  base64Encode,
  coalesceStream,
  isJsonObject,
  materializeResponse,
  parseJson,
  parseRfc3339,
  parseSse,
  splitLines,
  stringifyJson,
  type JsonObject,
} from "../src/browser.ts";

function hostOptions(c: JsonObject): { settings?: Record<string, string>; clock?: () => Date; baseUrl?: string } {
  const out: { settings?: Record<string, string>; clock?: () => Date; baseUrl?: string } = {};
  if (isJsonObject(c["settings"])) out.settings = Object.fromEntries(Object.entries(c["settings"]).map(([k, v]) => [k, String(v)]));
  if (typeof c["now"] === "string") {
    const fixed = parseRfc3339(c["now"]);
    out.clock = () => fixed;
  }
  if (typeof c["base_url"] === "string") out.baseUrl = c["base_url"];
  return out;
}

function adapter(c: JsonObject, apiKey: unknown) {
  const provider = String(c["provider"]);
  return adapterFor(provider, { apiKey: apiKey as never, ...hostOptions(c), ...(provider.replace(/_/g, "-") === "openai-codex" ? { accountId: "test-account" } : {}) });
}

/**
 * Build the case's wire request. Returns JSON: `{ method, url, headers, body }`
 * (body base64), or `{ refused: name, message }` for a typed refusal, or
 * `{ signs: true, ... }` when the case needs SigV4 (the host decides whether
 * that is a signature or a named refusal).
 */
export async function buildRequestJson(caseJson: string): Promise<string> {
  const c = parseJson(caseJson) as JsonObject;
  const credential = isJsonObject(c["credential"]) ? Credential.fromJSON(c["credential"]) : "test-key-123";
  const signs = credential instanceof AwsCredentials;
  try {
    const lm = adapter(c, credential);
    const built = await lm.buildRequest(Request.fromJSON(c["canonical_request"] as JsonObject), Boolean(c["stream"]));
    return stringifyJson({ signs, method: built.method, url: built.url, headers: built.headers.map(([k, v]) => [k.toLowerCase(), v]), body: base64Encode(built.body) });
  } catch (e) {
    const error = e as Error & { code?: string };
    return stringifyJson({ signs, refused: error.name, code: error.code ?? null, message: error.message, notConfigured: e instanceof NotConfiguredError });
  }
}

/** Parse the case's pinned body (base64) to its canonical response, complete or stream. Returns JSON, or `{ refused }`. */
export function parseBodyJson(caseJson: string, bodyBase64: string): string {
  const c = parseJson(caseJson) as JsonObject;
  const body = base64Decode(bodyBase64);
  const request = Request.fromJSON(c["canonical_request"] as JsonObject);
  const lm = adapter(c, "vet-parse-only");
  const head = new TextDecoder().decode(body.subarray(0, 64)).trimStart();
  const isStream = c["stream"] === true || /^(event:|data:)/.test(head);
  try {
    if (isStream) {
      const raw: StreamEvent[] = [];
      for (const sse of parseSse(splitLines(body))) raw.push(...lm.parseStreamEvents(request, sse));
      const events = [...coalesceStream(raw, { model: request.model })];
      const response = materializeResponse(events, request);
      return stringifyJson({ events: events.map(StreamEvent.toJSON), canonical_response: Response.toJSON(response) });
    }
    const response = lm.parseResponse(request, new HttpResponse({ status: 200, body }));
    return stringifyJson({ canonical_response: Response.toJSON(response) });
  } catch (e) {
    const error = e as Error & { code?: string };
    return stringifyJson({ refused: error.name, code: error.code ?? null });
  }
}

/** The platform the driver's realm runs on: the name proves which host answered. */
export { getDefaultPlatform } from "../src/browser.ts";
