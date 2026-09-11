import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKey, AwsCredentials, BearerToken, Credential } from "../src/types/credential.ts";
import { ANTHROPIC_API, AZURE_ANTHROPIC, BEDROCK_CHAT, GEMINI_API, OPENAI_API, authHeader, selectScheme } from "../src/auth/policy.ts";
import { CredentialFileStore, LocalOAuthCredential, loadCredential, withFileLock, writePrivateJsonAtomic } from "../src/auth/stores.ts";
import { explainAuth, describeReport } from "../src/auth/doctor.ts";
import { LockTimeoutError, NotConfiguredError } from "../src/errors.ts";

const SECRET = "SECRET-SENTINEL-DO-NOT-PRINT";

test("AUTH-5: credential values never print", () => {
  for (const c of [new ApiKey(SECRET), new BearerToken(SECRET, new Date()), new AwsCredentials({ accessKeyId: "AKID", secretAccessKey: SECRET, sessionToken: SECRET })]) {
    for (const rendered of [String(c), inspect(c), JSON.stringify(c), JSON.stringify({ nested: c })]) assert.ok(!rendered.includes(SECRET), rendered);
  }
  assert.ok(!inspect(new LocalOAuthCredential({ accessToken: SECRET, refreshToken: SECRET })).includes(SECRET));
  // The one deliberate way out.
  assert.equal(Credential.toJSON(new ApiKey(SECRET))["value"], SECRET);
});

test("AUTH-2 scheme selection: ApiKey takes the policy's order, BearerToken the token's, AWS signs only", () => {
  assert.equal(selectScheme(AZURE_ANTHROPIC, new ApiKey("k")), "x-api-key");
  assert.equal(selectScheme(AZURE_ANTHROPIC, new BearerToken("t")), "bearer");
  assert.equal(selectScheme(BEDROCK_CHAT, new BearerToken("t")), "bearer");
  assert.equal(selectScheme(BEDROCK_CHAT, new AwsCredentials({ accessKeyId: "a", secretAccessKey: "s" })), "sigv4");
  assert.throws(() => selectScheme(ANTHROPIC_API, new AwsCredentials({ accessKeyId: "a", secretAccessKey: "s" })), NotConfiguredError);
  assert.deepEqual(authHeader(OPENAI_API, "k"), ["Authorization", "Bearer k"]);
  assert.deepEqual(authHeader(GEMINI_API, "k", "x-goog-api-key"), ["x-goog-api-key", "k"]);
  // A JWT handed over as a plain string on a key-header door is named, not sent as a key.
  const jwt = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.e30.sig`;
  assert.throws(() => authHeader(AZURE_ANTHROPIC, jwt), NotConfiguredError);
});

test("AUTH-1: an explicit key wins; a key policy with nothing is a typed not-configured error", () => {
  assert.equal(loadCredential(OPENAI_API, "k").source, "explicit");
  assert.throws(() => loadCredential(OPENAI_API, undefined), (e: unknown) => e instanceof NotConfiguredError && e.message.includes("OPENAI_API_KEY"));
});

test("AUTH-4: private atomic writes and a cooperative lock", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lm15-auth-"));
  process.env["LM15_LOCK_DIR"] = join(dir, "locks");
  const target = join(dir, "store.json");
  writePrivateJsonAtomic(target, { a: 1 });
  assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf-8")), { a: 1 });

  let inside = 0;
  await withFileLock(target, async () => {
    inside++;
    await assert.rejects(withFileLock(target, async () => {}, { timeoutMs: 120 }), (e: unknown) => e instanceof LockTimeoutError && e.lockPath.endsWith(".lock"));
  });
  assert.equal(inside, 1);

  const store = new CredentialFileStore(target);
  await store.write("xai", { type: "oauth", access: "t" });
  assert.deepEqual(store.read("xai"), { type: "oauth", access: "t" });
  await store.mutate("xai", (cur) => ({ ...cur, refresh: "r" }));
  assert.equal(store.read("xai")?.["refresh"], "r");
  await store.delete("xai");
  assert.equal(store.read("xai"), undefined);
  assert.ok(!inspect(store).includes("access"));
});

test("AUTH-7: the doctor walks the chain, names the winner, and never renders the sentinel", () => {
  const report = explainAuth("groq", { env: { GROQ_API_KEY: SECRET } });
  assert.deepEqual(
    report.steps.map((s) => [s.kind, s.state]),
    [
      ["api_keys", "absent"],
      ["env:GROQ_API_KEY", "selected"],
    ],
  );
  assert.ok(report.configured);
  assert.ok(!describeReport(report).includes(SECRET));

  const shadowed = explainAuth("groq", { env: { GROQ_API_KEY: SECRET }, apiKeys: { groq: SECRET } });
  assert.equal(shadowed.steps[1]?.state, "shadowed");

  const local = explainAuth("ollama", { env: {} });
  assert.equal(local.steps[local.steps.length - 1]?.kind, "placeholder");

  const dir = mkdtempSync(join(tmpdir(), "lm15-doctor-"));
  const claude = join(dir, "creds.json");
  writeFileSync(claude, JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET, expiresAt: Date.now() + 3_600_000 } }));
  const oauth = explainAuth("claude-code", { env: {}, claudeCredentialsPath: claude });
  assert.equal(oauth.steps[0]?.kind, "oauth-file");
  assert.equal(oauth.steps[0]?.state, "selected");
  assert.ok(!describeReport(oauth).includes(SECRET));
});

test("AUTH-7 cloud: offline network rungs are unprobed; the door key is selected when set", () => {
  const report = explainAuth("bedrock-chat", { env: { AWS_BEARER_TOKEN_BEDROCK: SECRET, AWS_REGION: "us-east-1", HOME: "/nonexistent" }, files: {} });
  assert.equal(report.steps.find((s) => s.kind === "env:AWS_BEARER_TOKEN_BEDROCK")?.state, "selected");
  assert.equal(report.steps.find((s) => s.kind === "imds")?.state, "shadowed");
  assert.deepEqual(report.settings, [["region", "us-east-1"]]);
  const bare = explainAuth("bedrock-chat", { env: { HOME: "/nonexistent" }, files: {} });
  assert.equal(bare.steps.find((s) => s.kind === "imds")?.state, "unprobed");
  assert.ok(bare.configured); // "probably": a network rung may win at request time
  assert.equal(bare.settings.find(([k]) => k === "error")?.[1]?.includes("region"), true);
});
