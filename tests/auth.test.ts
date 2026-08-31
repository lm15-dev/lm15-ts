/**
 * Unit tests: credential providers, borrowed-file readers, secrecy
 * renderings, alias and ordering rules.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  explainAuth,
  LocalOAuthCredential,
  NotConfiguredError,
  readClaudeCodeCredential,
  readCodexCliCredential,
  resolveCredential,
  UnknownProviderError,
} from "../src/auth.ts";

const SENTINEL = "SECRET-SENTINEL-DO-NOT-PRINT";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "lm15-auth-"));
}

function fakeCodexJwt(accountId: string, expSeconds: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({ exp: expSeconds, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
  return `${header}.${payload}.signature`;
}

test("credential provider callable is invoked per resolution (AUTH-2)", () => {
  let calls = 0;
  const provider = () => `token-${++calls}`;
  assert.notEqual(resolveCredential(provider), resolveCredential(provider));
  assert.equal(resolveCredential("static"), "static");
});

test("underscore alias is accepted", () => {
  assert.equal(explainAuth("openai_chat", { env: {} }).provider, "openai-chat");
});

test("unknown provider names known ones", () => {
  assert.throws(() => explainAuth("not-a-provider"), (error: unknown) => {
    assert.ok(error instanceof UnknownProviderError);
    assert.match(error.message, /anthropic/);
    return true;
  });
});

test("gemini env key order: first declared wins, second is shadowed", () => {
  const report = explainAuth("gemini", { env: { GEMINI_API_KEY: "a", GOOGLE_API_KEY: "b" } });
  assert.equal(report.selected?.kind, "env:GEMINI_API_KEY");
  assert.deepEqual(
    report.steps[2],
    { kind: "env:GOOGLE_API_KEY", detail: "set (value never shown)", state: "shadowed" },
  );
});

test("codex reader decodes JWT expiry (with skew) and account id", () => {
  const dir = scratchDir();
  const path = join(dir, "auth.json");
  const fresh = fakeCodexJwt("acct_test", Math.floor(Date.now() / 1000) + 3600);
  writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: fresh, refresh_token: "rt" } }));
  const credential = readCodexCliCredential(path);
  assert.equal(credential.expired, false);
  assert.equal(credential.accountId, "acct_test");
  assert.equal(credential.hasRefreshToken, true);

  const nearExpiry = fakeCodexJwt("acct", Math.floor(Date.now() / 1000) + 120); // inside 5min skew
  writeFileSync(path, JSON.stringify({ tokens: { access_token: nearExpiry } }));
  assert.equal(readCodexCliCredential(path).expired, true, "token inside the skew window counts as expired (AUTH-3)");
});

test("missing files raise typed NotConfiguredError with a re-login hint", () => {
  const missing = join(scratchDir(), "nope.json");
  for (const reader of [readClaudeCodeCredential, readCodexCliCredential]) {
    assert.throws(() => reader(missing), (error: unknown) => {
      assert.ok(error instanceof NotConfiguredError);
      assert.match(error.message, /Log in again/);
      assert.ok(!error.message.includes(SENTINEL));
      return true;
    });
  }
});

test("credential renderings never contain token material (AUTH-5)", () => {
  const dir = scratchDir();
  const path = join(dir, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken: SENTINEL, refreshToken: SENTINEL, expiresAt: Date.now() + 60_000 },
    }),
  );
  const credential = readClaudeCodeCredential(path);
  for (const rendering of [String(credential), inspect(credential), JSON.stringify(credential)]) {
    assert.ok(!rendering.includes(SENTINEL), `sentinel leaked: ${rendering}`);
  }
  assert.equal(credential.accessToken, SENTINEL, "accessor must return the real token");
  assert.ok(credential instanceof LocalOAuthCredential);
});
