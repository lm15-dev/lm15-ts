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
  assert.equal(provider.source, undefined);
  await provider();
  await provider();
  assert.deepEqual(commands, ["az", "pwsh", "azd"]);
  assert.equal(provider.source?.rung, "azd");
  assert.equal(provider.source?.named, "cli");
  assert.equal(provider.source?.expiresAt?.toISOString(), "2026-09-20T01:00:00.000Z");
  assert.ok(!String(provider.source).includes(SECRET));
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
