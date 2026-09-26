// Google Cloud (Vertex): API keys on the project door, where the project
// comes from, and guidance that names the fix (lm15-contract spec/auth.md
// AUTH-2, AUTH-10, amended 2026-09-26; changes/2026-09-26-vertex-live.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERTEX } from "../src/auth/policy.ts";
import { ChainContext, credentialProvider, profileSettings } from "../src/cloud/chains.ts";
import { resolveSettings } from "../src/cloud/hosts.ts";
import { AuthError, NotConfiguredError } from "../src/errors.ts";
import { adapterFor } from "../src/providers.ts";
import { BearerToken } from "../src/types/credential.ts";
import { Message } from "../src/types/parts.ts";

const SECRET = "SECRET-SENTINEL-DO-NOT-PRINT";
const REQUEST = { model: "gemini-2.5-flash", messages: [Message.user("hi")] };
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function authHeaders(apiKey: string | BearerToken): Promise<Record<string, string>> {
  const lm = adapterFor("vertex", { apiKey, settings: { project: "p", location: "global" }, env: {} });
  const req = await lm.buildRequest(REQUEST, false);
  const out: Record<string, string> = {};
  for (const [k, v] of req.headers) if (["authorization", "x-goog-api-key"].includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

test("vertex: a plain string is a Vertex API key in x-goog-api-key", async () => {
  for (const key of ["AQ.Ab8RN6-test", "AIzaSyTestKey", "test-key-123"]) assert.deepEqual(await authHeaders(key), { "x-goog-api-key": key });
});

test("vertex: a token-shaped string (ya29., JWT) and a BearerToken go as bearer", async () => {
  const jwt = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.e30.c2ln`;
  for (const token of ["ya29.a0-test", jwt]) assert.deepEqual(await authHeaders(token), { authorization: `Bearer ${token}` });
  assert.deepEqual(await authHeaders(new BearerToken("opaque")), { authorization: "Bearer opaque" });
  assert.deepEqual(VERTEX.envKeys, []);
});

const CONFIG = "[core]\naccount = a@example.com\nproject = from-gcloud\n";
const ADC = JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r", quota_project_id: "from-adc-quota" });

function project(env: Record<string, string>, files: Record<string, string>): [string | undefined, string | undefined] {
  const ctx = new ChainContext({ env: { HOME: "/h", ...env }, home: "/h", files });
  const sources: Record<string, string> = {};
  const deferred = new Set<string>();
  const problems: NotConfiguredError[] = [];
  const out = resolveSettings(VERTEX.host, undefined, ctx.env, { provider: "vertex", profile: profileSettings(VERTEX, ctx), sources, deferred, problems });
  return [out["project"], sources["project"]];
}

test("project: env, then the credential file, gcloud's configuration, the ADC file, the metadata server", () => {
  const files = { "~/.config/gcloud/application_default_credentials.json": ADC, "~/.config/gcloud/configurations/config_default": CONFIG };
  assert.deepEqual(project({ GOOGLE_CLOUD_PROJECT: "from-env" }, files), ["from-env", "env:GOOGLE_CLOUD_PROJECT"]);
  assert.deepEqual(project({ NO_GCE_CHECK: "1" }, files), ["from-gcloud", "gcloud-config"]);
  assert.deepEqual(project({ CLOUDSDK_CORE_PROJECT: "core" }, files), ["core", "env:CLOUDSDK_CORE_PROJECT"]);
  assert.deepEqual(project({}, { "~/.config/gcloud/application_default_credentials.json": ADC }), ["from-adc-quota", "adc-file"]);
  const named = { "~/.config/gcloud/active_config": "work\n", "~/.config/gcloud/configurations/config_work": "[core]\nproject = from-work\n" };
  assert.deepEqual(project({}, named), ["from-work", "gcloud-config"]);
  assert.deepEqual(project({ CLOUDSDK_ACTIVE_CONFIG_NAME: "../../x", NO_GCE_CHECK: "1" }, { "~/x": CONFIG }), [undefined, "missing"]);
  assert.deepEqual(project({}, {}), [undefined, "unprobed:metadata"]);
  assert.deepEqual(project({ NO_GCE_CHECK: "1" }, {}), [undefined, "missing"]);
});

test("project: a deferred setting is asked once, before the first request", async () => {
  let asked = 0;
  const lm = adapterFor("vertex", {
    apiKey: new BearerToken("t"), env: {}, settings: { location: "global" },
    deferredSettings: { project: async () => { asked++; return "from-metadata"; } },
  });
  const [a, b] = await Promise.all([lm.buildRequest(REQUEST, false), lm.buildRequest(REQUEST, false)]);
  assert.match(a.url, /\/projects\/from-metadata\/locations\/global\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(b.url, a.url);
  assert.equal(asked, 1);
  const failing = adapterFor("vertex", { apiKey: new BearerToken("t"), env: {}, deferredSettings: { project: async () => undefined } });
  await assert.rejects(failing.buildRequest(REQUEST, false), (e: unknown) => e instanceof NotConfiguredError && /gcloud config set project/.test(e.message));
});

test("a stale ADC login names the OAuth word and the command, never the reply's description", async () => {
  const ctx = new ChainContext({
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/creds.json", NO_GCE_CHECK: "1" },
    files: { "/creds.json": JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: SECRET, refresh_token: SECRET }) },
    http: async () => [400, {}, jsonBytes({ error: "invalid_grant", error_description: `reauth ${SECRET}` })],
  });
  await assert.rejects(credentialProvider(VERTEX, ctx)(), (e: unknown) => {
    assert.ok(e instanceof AuthError);
    assert.match(e.message, /HTTP 400 \(invalid_grant\)/);
    assert.match(e.message, /gcloud auth application-default login/);
    assert.ok(!e.message.includes(SECRET));
    assert.equal(e.providerCode, "invalid_grant");
    return true;
  });
});

test("vertex wire refusals: 403 is an IAM question, 401 depends on what was sent", () => {
  const body = (code: number) => JSON.stringify({ error: { code, status: "X", message: "denied" } });
  const token = adapterFor("vertex", { apiKey: new BearerToken(SECRET), settings: { project: "p" }, env: {} });
  const e403 = token.normalizeError(403, body(403));
  assert.match(e403.message, /roles\/aiplatform\.user/);
  assert.ok(!e403.message.includes("Check that your API key"));
  assert.match(token.normalizeError(401, body(401)).message, /access token/);
  const key = adapterFor("vertex", { apiKey: "AQ.not-a-real-key", settings: { project: "p" }, env: {} });
  const e401 = key.normalizeError(401, body(401));
  assert.match(e401.message, /Vertex AI key/);
  assert.ok(!e401.message.includes("not-a-real-key"));
});
