import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describeReport, explainAuth } from "../src/auth/doctor.ts";
import { ANTHROPIC_API, AZURE, AZURE_ANTHROPIC, BEDROCK_CHAT, VERTEX, authHeader } from "../src/auth/policy.ts";
import { ChainContext, credentialProvider, namedRungs } from "../src/cloud/chains.ts";
import { endpointFromEnv, joinEndpoint, renderBaseUrl, resolveSettings } from "../src/cloud/hosts.ts";
import { validateNamedCredential } from "../src/cloud/identity.ts";
import { AuthError, NotConfiguredError, withCredentialHint } from "../src/errors.ts";
import { getDefaultPlatform, setDefaultPlatform, webPlatform } from "../src/platform.ts";
import { nodePlatform } from "../src/platform_node.ts";
import { adapterFor } from "../src/providers.ts";
import { ApiKey, BearerToken, CredentialSource, type NamedCredential } from "../src/types/credential.ts";
import { Message } from "../src/types/parts.ts";

const SECRET = "SECRET-SENTINEL-DO-NOT-PRINT";
const JWT = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.e30.signature`;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

interface NamedCase {
  id: string;
  provider: string;
  credential: NamedCredential;
  base_url?: string;
  api_keys_providers?: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  expect: {
    error?: string;
    configured?: boolean;
    steps?: { kind: string; state: string }[];
    base_url?: string;
    settings?: Record<string, string>;
  };
}
const contract = process.env["LM15_CONTRACT_DIR"] ?? fileURLToPath(new URL("../../lm15-contract/", import.meta.url));
const fixtures = JSON.parse(readFileSync(resolvePath(contract, "auth/named-credentials.json"), "utf8")) as { cases: NamedCase[] };

for (const fixture of fixtures.cases) {
  test(`AUTH-1/7 named corpus: ${fixture.id}`, () => {
    const previous = getDefaultPlatform();
    setDefaultPlatform(nodePlatform);
    try {
      const opts = {
        env: fixture.env, files: fixture.files, home: "/lm15-named-sandbox", credential: fixture.credential,
        ...(fixture.base_url === undefined ? {} : { baseUrl: fixture.base_url }),
        apiKeys: Object.fromEntries((fixture.api_keys_providers ?? []).map((p) => [p, SECRET])),
      };
      if (fixture.expect.error) {
        assert.throws(() => explainAuth(fixture.provider, opts), (error: unknown) => {
          assert.ok(error instanceof NotConfiguredError);
          assert.match(error.message, new RegExp(fixture.expect.error!));
          assert.ok(!String(error).includes(SECRET));
          return true;
        });
        return;
      }
      const report = explainAuth(fixture.provider, opts);
      assert.equal(report.configured, fixture.expect.configured);
      assert.deepEqual(report.steps.map(({ kind, state }) => ({ kind, state })), fixture.expect.steps);
      assert.equal(report.named, fixture.credential);
      if (fixture.expect.base_url) assert.equal(report.baseUrl, fixture.expect.base_url);
      for (const [key, value] of Object.entries(fixture.expect.settings ?? {})) assert.equal(Object.fromEntries(report.settings)[key], value);
      const rendered = describeReport(report);
      assert.match(rendered, /the chain is not walked/);
      assert.ok(!rendered.includes(SECRET));
      assert.ok(!JSON.stringify(report).includes(SECRET));
    } finally { setDefaultPlatform(previous); }
  });
}

test("endpoint root, full path, leading path and gateway path join to one door", () => {
  for (const endpoint of ["https://account.example", "https://account.example/anthropic", "https://account.example/anthropic/v1/"]) {
    assert.equal(joinEndpoint(endpoint, "/anthropic/v1"), "https://account.example/anthropic/v1");
  }
  assert.equal(joinEndpoint("https://gateway.example/customer/openai", "/openai/v1"), "https://gateway.example/customer/openai/v1");
  for (const endpoint of ["file:///tmp/key", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com#fragment", "https://example.com?"]) {
    assert.throws(() => joinEndpoint(endpoint, "/v1"), NotConfiguredError);
  }
  assert.equal(endpointFromEnv(BEDROCK_CHAT.host, { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://specific.example", AWS_ENDPOINT_URL: "https://generic.example" }), "https://specific.example");
  assert.equal(endpointFromEnv(VERTEX.host, { GOOGLE_ENDPOINT: "https://ignored.example" }), undefined);
});

test("endpoint relaxes resource but never signing region or path project; Azure default unchanged", () => {
  const endpoint = "https://account.services.ai.azure.com";
  const settings = resolveSettings(AZURE.host, {}, {}, { endpoint });
  assert.equal(settings["resource"], undefined);
  assert.equal(renderBaseUrl(AZURE.host!, settings, endpoint), `${endpoint}/openai/v1`);
  assert.equal(renderBaseUrl(AZURE.host!, { resource: "classic" }), "https://classic.openai.azure.com/openai/v1");
  assert.throws(() => resolveSettings(BEDROCK_CHAT.host, {}, {}, { endpoint }), /region/);
  assert.throws(() => resolveSettings(VERTEX.host, {}, {}, { endpoint }), /project/);
});

test("construction rejects unknown, noncloud and conflicting named credentials", () => {
  assert.throws(() => validateNamedCredential(AZURE, "unknown"), NotConfiguredError);
  assert.throws(() => validateNamedCredential(ANTHROPIC_API, "platform"), NotConfiguredError);
  assert.throws(() => adapterFor("azure", { apiKey: SECRET, credential: "platform", baseUrl: "https://account.example" }), /both api_keys and credentials/);
  assert.throws(() => adapterFor("azure", { apiKey: "", credential: "platform", baseUrl: "https://account.example" }), /both api_keys and credentials/);
});

test("JWT strings use bearer on hybrid doors only, including callable returns", async () => {
  assert.deepEqual(authHeader(AZURE, JWT), ["Authorization", `Bearer ${JWT}`]);
  assert.deepEqual(authHeader(AZURE_ANTHROPIC, JWT), ["Authorization", `Bearer ${JWT}`]);
  assert.deepEqual(authHeader(ANTHROPIC_API, JWT), ["x-api-key", JWT]);
  assert.deepEqual(authHeader(AZURE, new BearerToken(SECRET)), ["Authorization", `Bearer ${SECRET}`]);
  const badShape = JWT.replace(/signature$/, "not+base64url");
  assert.deepEqual(authHeader(AZURE, badShape), ["api-key", badShape]);
  let calls = 0;
  const lm = adapterFor("azure", { apiKey: () => { calls++; return JWT; }, baseUrl: "https://account.example" });
  const request = { model: "deployment", messages: [Message.user("hello")] };
  await lm.plan(request);
  assert.equal(calls, 0);
  const built = await lm.buildRequest(request, false);
  assert.equal(calls, 1);
  assert.equal(built.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1], `Bearer ${JWT}`);
  assert.match(lm.credentialOrigin(), /callable.*identity not inspected/);
  const report = explainAuth("azure", { env: {}, apiKeys: { azure: JWT }, baseUrl: "https://account.example" });
  assert.match(describeReport(report), /sent as bearer \(JWT\)/);
});

test("named workload does not fall through to environment, a door key or a CLI", async () => {
  let requests = 0;
  const ctx = new ChainContext({
    env: { AZURE_TENANT_ID: "tenant", AZURE_CLIENT_ID: "client", AZURE_CLIENT_SECRET: SECRET, AZURE_OPENAI_API_KEY: SECRET, PATH: "~/bin" },
    files: { "~/bin/az": "present" },
    http: async () => { requests++; return [200, {}, jsonBytes({ access_token: SECRET })]; },
    run: async () => { requests++; return JSON.stringify({ accessToken: SECRET }); },
  });
  await assert.rejects(credentialProvider(AZURE, ctx, "workload")(), (error: unknown) => {
    assert.ok(error instanceof NotConfiguredError);
    assert.match(error.message, /named credential "workload".*workload-identity/s);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.equal(requests, 0);
  assert.deepEqual(namedRungs(BEDROCK_CHAT, "platform").map((r) => r.name), ["container", "imds"]);
});

test("GCP workload refuses a service account without contacting token exchange", async () => {
  const ctx = new ChainContext({ env: { GOOGLE_APPLICATION_CREDENTIALS: "~/sa.json" }, files: { "~/sa.json": JSON.stringify({ type: "service_account", private_key: SECRET }) }, http: async () => { throw new Error("must not contact token exchange"); } });
  await assert.rejects(credentialProvider(VERTEX, ctx, "workload")(), /use named credential "environment"/);
});

test("Azure named CLI continues through command errors and records the winning rung and expiry", async () => {
  const commands: string[] = [];
  const ctx = new ChainContext({
    env: { PATH: "~/bin" }, files: { "~/bin/az": "present", "~/bin/pwsh": "present", "~/bin/azd": "present" },
    now: () => new Date("2026-09-20T00:00:00Z"),
    run: async (argv) => { commands.push(argv[0]!); if (argv[0] !== "azd") throw new AuthError("command failed"); return JSON.stringify({ token: SECRET, expiresOn: "2026-09-20T01:00:00Z" }); },
  });
  const provider = credentialProvider(AZURE, ctx, "cli");
  // Read through a function: after assert.equal(x, undefined) TypeScript would
  // keep `provider.source` narrowed to undefined, though calling provider() sets it.
  const source = () => provider.source;
  assert.equal(source(), undefined);
  await provider();
  await provider();
  assert.deepEqual(commands, ["az", "pwsh", "azd"]);
  assert.equal(source()?.rung, "azd");
  assert.equal(source()?.named, "cli");
  assert.equal(source()?.expiresAt?.toISOString(), "2026-09-20T01:00:00.000Z");
  assert.ok(!String(source()).includes(SECRET));
});

test("auth provenance appears exactly once and survives login guidance", () => {
  const lm = adapterFor("azure", { apiKey: new ApiKey(SECRET), baseUrl: "https://account.example" });
  lm.setCredentialOrigin("env $AZURE_OPENAI_API_KEY (value never shown)");
  const first = lm.normalizeError(401, '{"error":{"message":"access denied"}}');
  const error = withCredentialHint(first, "sign in again");
  assert.equal(error.message.split("Credential came from:").length - 1, 1);
  assert.match(error.message, /env \$AZURE_OPENAI_API_KEY/);
  assert.ok(error.message.indexOf("Credential came from:") < error.message.indexOf("To fix:"));
  assert.ok(!String(error).includes(SECRET));
});

test("browser explicit token and endpoint work; unavailable named chain is refused by name", async () => {
  const previous = getDefaultPlatform();
  setDefaultPlatform(webPlatform);
  try {
    const lm = adapterFor("azure", { apiKey: new BearerToken(SECRET), baseUrl: "https://account.example" });
    assert.equal(lm.baseUrl, "https://account.example/openai/v1");
    await lm.buildRequest({ model: "deployment", messages: [Message.user("hello")] }, false);
    assert.throws(() => adapterFor("azure", { credential: "platform", baseUrl: "https://account.example" }), /named credential "platform".*web platform/);
    const report = explainAuth("azure", { credential: "platform", baseUrl: "https://account.example" });
    assert.equal(report.configured, false);
    assert.deepEqual(report.steps.map((step) => step.kind), ["api_keys", "managed-identity"]);
    let selected: NamedCredential | undefined;
    setDefaultPlatform({ ...webPlatform, name: "custom-web", openCloudChain: () => ({
      settings: {}, profile: () => () => undefined,
      credentialProvider: (_policy, named) => {
        selected = named;
        return Object.assign(async () => new BearerToken(SECRET), { named, source: new CredentialSource({ rung: "managed-identity", label: "application token bridge", named }) });
      },
      explain: () => [[], true],
    }) });
    const bridged = adapterFor("azure", { credential: "platform", baseUrl: "https://account.example" });
    await bridged.buildRequest({ model: "deployment", messages: [Message.user("hello")] }, false);
    assert.equal(selected, "platform");
    assert.match(bridged.credentialOrigin(), /application token bridge.*managed-identity/);
  } finally { setDefaultPlatform(previous); }
});

// ─── Google external_account with an AWS source (AUTH-1 gcp-chain) ───────────
// The subject token is pinned byte for byte by lm15-contract auth/token-vectors.json
// (gcp-external-account-aws*.build, computed by google-auth itself); these walk the whole
// acquisition: where the AWS identity comes from, then STS, then impersonation.

const AWS_WIF = {
  type: "external_account",
  audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
  subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
  token_url: "https://sts.googleapis.com/v1/token",
  credential_source: {
    environment_id: "aws1",
    region_url: "http://169.254.169.254/latest/meta-data/placement/availability-zone",
    url: "http://169.254.169.254/latest/meta-data/iam/security-credentials",
    regional_cred_verification_url: "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15",
  } as Record<string, string>,
  service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
};
type Call = [string, string, Record<string, string>, Uint8Array | undefined];
const GOOGLE_ANSWERS: [string, [number, unknown]][] = [
  ["https://sts.googleapis.com/", [200, { access_token: "federated", expires_in: 3600, token_type: "Bearer" }]],
  ["https://iamcredentials.googleapis.com/", [200, { accessToken: "sa-token", expireTime: "2026-09-20T01:00:00Z" }]],
];
function awsWif(env: Record<string, string>, answers: [string, [number, unknown]][], source = AWS_WIF.credential_source) {
  const calls: Call[] = [];
  const ctx = new ChainContext({
    env: { GOOGLE_APPLICATION_CREDENTIALS: "~/wif.json", ...env }, files: { "~/wif.json": JSON.stringify({ ...AWS_WIF, credential_source: source }) },
    now: () => new Date("2026-09-20T00:00:00Z"),
    http: async (method, url, headers, body) => {
      calls.push([method, url, { ...headers }, body]);
      const hit = answers.find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`unexpected request ${method} ${url}`);
      const [status, data] = hit[1];
      return [status, {}, typeof data === "string" ? new TextEncoder().encode(data) : jsonBytes(data)];
    },
  });
  return { calls, provide: credentialProvider(VERTEX, ctx, "workload") };
}
function signedRequest(calls: Call[]): { url: string; headers: Record<string, string> } {
  const sts = calls.find((c) => c[1].startsWith("https://sts.googleapis.com/"))!;
  const body = JSON.parse(new TextDecoder().decode(sts[3])) as Record<string, string>;
  assert.equal(body["subjectTokenType"], "urn:ietf:params:aws:token-type:aws4_request");
  const signed = JSON.parse(decodeURIComponent(body["subjectToken"]!)) as { url: string; headers: { key: string; value: string }[] };
  return { url: signed.url, headers: Object.fromEntries(signed.headers.map((h) => [h.key, h.value])) };
}

test("GCP AWS source on ECS: the task role from the container endpoint signs, then STS, then impersonation", async () => {
  const { calls, provide } = awsWif({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc", AWS_REGION: "us-east-2" }, [
    ["http://169.254.170.2/v2/credentials/abc", [200, { AccessKeyId: "ASIATASK", SecretAccessKey: "s", Token: "task-session", Expiration: "2026-09-20T06:00:00Z" }]],
    ...GOOGLE_ANSWERS,
  ]);
  const token = await provide();
  assert.ok(token instanceof BearerToken);
  assert.equal(token.value, "sa-token");
  assert.deepEqual(calls.map((c) => c[1]), ["http://169.254.170.2/v2/credentials/abc", "https://sts.googleapis.com/v1/token", AWS_WIF.service_account_impersonation_url]);
  const signed = signedRequest(calls);
  assert.equal(signed.url, "https://sts.us-east-2.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15");
  assert.match(signed.headers["Authorization"]!, /^AWS4-HMAC-SHA256 Credential=ASIATASK\/20260920\/us-east-2\/sts\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, /);
  assert.equal(signed.headers["x-amz-security-token"], "task-session");
  assert.equal(signed.headers["x-goog-cloud-target-resource"], AWS_WIF.audience);
  assert.equal(calls[2]![2]["authorization"], "Bearer federated");
});

test("GCP AWS source on EC2: IMDSv2 once, the region from the availability zone, the role's credentials", async () => {
  const { calls, provide } = awsWif({}, [
    ["http://169.254.169.254/latest/api/token", [200, "imds-session"]],
    ["http://169.254.169.254/latest/meta-data/placement/availability-zone", [200, "eu-west-1b"]],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/web", [200, { Code: "Success", AccessKeyId: "ASIAEC2", SecretAccessKey: "s", Token: "t" }]],
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials", [200, "web\n"]],
    ...GOOGLE_ANSWERS,
  ], { ...AWS_WIF.credential_source, imdsv2_session_token_url: "http://169.254.169.254/latest/api/token" });
  assert.equal(((await provide()) as BearerToken).value, "sa-token");
  assert.equal(calls.filter((c) => c[0] === "PUT").length, 1);
  assert.deepEqual(calls[0]![2], { "X-aws-ec2-metadata-token-ttl-seconds": "300" });
  for (const c of calls.slice(1, 4)) assert.equal(c[2]["X-aws-ec2-metadata-token"], "imds-session");
  assert.ok(signedRequest(calls).url.startsWith("https://sts.eu-west-1.amazonaws.com?"));
});

test("GCP AWS source: the environment's keys win and no endpoint is asked", async () => {
  const { calls, provide } = awsWif({ AWS_ACCESS_KEY_ID: "AKIDENV", AWS_SECRET_ACCESS_KEY: "s", AWS_DEFAULT_REGION: "ca-central-1", AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc" }, GOOGLE_ANSWERS);
  await provide();
  const h = signedRequest(calls).headers;
  assert.equal(h["x-amz-security-token"], undefined);
  assert.match(h["Authorization"]!, /AKIDENV\/20260920\/ca-central-1\/sts/);
});

test("GCP AWS source: a malformed source or no AWS identity is refused before any request", async () => {
  const refuse = async () => { throw new Error("no request before the source is valid"); };
  for (const [source, why] of [
    [{ environment_id: "aws2", regional_cred_verification_url: "https://sts.{region}.amazonaws.com" }, /only aws1/],
    [{ environment_id: "aws1" }, /regional_cred_verification_url/],
    [{ environment_id: "azure1", regional_cred_verification_url: "https://x" }, /environment_id/],
  ] as const) {
    const ctx = new ChainContext({ env: { GOOGLE_APPLICATION_CREDENTIALS: "~/wif.json", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" }, files: { "~/wif.json": JSON.stringify({ ...AWS_WIF, credential_source: source }) }, http: refuse });
    await assert.rejects(credentialProvider(VERTEX, ctx, "workload")(), why);
  }
  const { url: _url, ...noUrl } = AWS_WIF.credential_source;
  const ctx = new ChainContext({ env: { GOOGLE_APPLICATION_CREDENTIALS: "~/wif.json", AWS_REGION: "us-east-1" }, files: { "~/wif.json": JSON.stringify({ ...AWS_WIF, credential_source: noUrl }) }, http: refuse });
  await assert.rejects(credentialProvider(VERTEX, ctx, "workload")(), /AWS_ACCESS_KEY_ID nor a container endpoint/);
});
