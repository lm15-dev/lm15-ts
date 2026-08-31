/**
 * Runs the lm15-contract auth-resolution fixtures (auth/resolution.json,
 * spec/auth.md AUTH-1/AUTH-7, ratified 2026-08-31). Divergence between this
 * port and the fixtures is a port bug, never a reason to edit the fixture
 * (AUTHORITY.md).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { explainAuth, type ExplainOptions } from "../src/auth.ts";

interface FixtureCase {
  id: string;
  provider: string;
  env?: Record<string, string>;
  api_keys_providers?: string[];
  borrowed_file?: { state: string };
  expect: { configured: boolean; steps: { kind: string; state: string }[] };
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "conformance", "auth_resolution.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  sentinel: string;
  cases: FixtureCase[];
};

function materializeBorrowedFile(state: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lm15-auth-fixture-"));
  if (state === "missing") return join(dir, "does-not-exist.json");
  const oauth: Record<string, unknown> = { accessToken: fixture.sentinel };
  if (state === "fresh") {
    oauth["expiresAt"] = Date.now() + 3_600_000;
    oauth["refreshToken"] = fixture.sentinel;
  } else if (state === "expired-with-refresh") {
    oauth["expiresAt"] = 1;
    oauth["refreshToken"] = fixture.sentinel;
  } else if (state === "expired-no-refresh") {
    oauth["expiresAt"] = 1;
  } else {
    throw new Error(`unknown borrowed_file state ${state}`);
  }
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
  return path;
}

assert.ok(fixture.cases.length > 0, "fixture has no cases");

for (const fixtureCase of fixture.cases) {
  test(`auth resolution contract: ${fixtureCase.id}`, () => {
    const options: ExplainOptions = { env: fixtureCase.env ?? {} };
    if (fixtureCase.api_keys_providers?.length) {
      options.apiKeyProviders = fixtureCase.api_keys_providers;
    }
    if (fixtureCase.borrowed_file !== undefined) {
      assert.equal(fixtureCase.provider, "claude-code", "fixture uses claude-code for oauth cases");
      options.claudeCredentialsPath = materializeBorrowedFile(fixtureCase.borrowed_file.state);
    }

    const report = explainAuth(fixtureCase.provider, options);

    assert.equal(report.configured, fixtureCase.expect.configured, "configured");
    assert.deepEqual(
      report.steps.map((step) => ({ kind: step.kind, state: step.state })),
      fixtureCase.expect.steps,
      "steps",
    );

    // AUTH-5: no rendering may carry the planted sentinel.
    for (const rendering of [report.describe(), String(report), JSON.stringify(report)]) {
      assert.ok(!rendering.includes(fixture.sentinel), `sentinel leaked: ${rendering}`);
    }
  });
}
