// AUTH-10 backend settings (amended 2026-09-30) and MAP-7 rule 6's default
// max_tokens: lm15-contract changes/2026-09-30-claude-code-client-version.md.
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CLAUDE_CODE, DEFAULT_CLAUDE_CODE_VERSION, OPENAI_CODEX, resolveBackendSettings } from "../src/auth/policy.ts";
import { describeReport, explainAuth } from "../src/auth/doctor.ts";
import { AnthropicLM, ClaudeCodeLM } from "../src/dialects/anthropic.ts";
import { OpenAICodexLM } from "../src/dialects/openai_responses.ts";
import { InvalidRequestError, NotConfiguredError } from "../src/errors.ts";
import { LMRouter } from "../src/router.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { Message } from "../src/types/parts.ts";
import { ValueError } from "../src/types/validate.ts";
import type { TransportRequest } from "../src/wire.ts";

installNodePlatform();

const REFUSAL = "Claude Code 2.1.170 does not support this model; version 2.1.280 or newer is required. "
  + "Run 'claude update', or update the Claude desktop app, then try again.";

/** A routed subscription door reads its CLI's login file: a scratch HOME, never the real one. */
function withScratchLogins<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "lm15-backend-settings-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }));
  writeFileSync(join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "tok", refresh_token: "r", account_id: "acct" } }));
  const saved = process.env["HOME"];
  process.env["HOME"] = home;
  return run().finally(() => {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  });
}

function header(req: TransportRequest, name: string): string | undefined {
  return req.headers.find(([k]) => k.toLowerCase() === name)?.[1];
}

async function userAgent(lm: AnthropicLM): Promise<string | undefined> {
  return header(await lm.buildRequest({ model: "claude-opus-5-5", messages: [Message.user("hi")] }, false), "user-agent");
}

test("the table default is the header and the option", async () => {
  assert.equal(DEFAULT_CLAUDE_CODE_VERSION, "2.1.285");
  assert.deepEqual(CLAUDE_CODE.backendOptions, { client_version: DEFAULT_CLAUDE_CODE_VERSION });
  assert.deepEqual(CLAUDE_CODE.backendSettings.map((s) => [s.name, s.env]), [["client_version", ["LM15_CLAUDE_CODE_VERSION"]]]);
  assert.deepEqual(OPENAI_CODEX.backendSettings.map((s) => [s.name, s.env]), [["client_version", ["LM15_CODEX_CLIENT_VERSION"]]]);
  assert.equal(await userAgent(new ClaudeCodeLM({ apiKey: "k" })), `claude-cli/${DEFAULT_CLAUDE_CODE_VERSION}`);
});

test("the setting and the named option move the header", async () => {
  for (const lm of [
    new ClaudeCodeLM({ apiKey: "k", settings: { client_version: "2.1.280" } }),
    new ClaudeCodeLM({ apiKey: "k", claudeCodeVersion: "2.1.280" }),
    new AnthropicLM({ apiKey: "k", access: CLAUDE_CODE, settings: { client_version: "2.1.280" } }),
  ]) {
    assert.equal(await userAgent(lm), "claude-cli/2.1.280");
    assert.equal(lm.access.backendOptions["client_version"], "2.1.280");
  }
  assert.equal(new ClaudeCodeLM({ apiKey: "k", settings: { client_version: "2.1.280" } }).claudeCodeVersion, "2.1.280");
  assert.throws(() => new ClaudeCodeLM({ apiKey: "k", claudeCodeVersion: "1", settings: { client_version: "2" } }), ValueError);
});

test("the router reads the setting, then the environment, then the table", () => withScratchLogins(async () => {
  const explicit = new LMRouter({ apiKeys: { "claude-code": "k" }, env: { LM15_CLAUDE_CODE_VERSION: "2.1.282" }, settings: { claude_code: { client_version: "2.1.281" } } });
  assert.equal(await userAgent(explicit.lm("claude-code:claude-opus-5-5") as AnthropicLM), "claude-cli/2.1.281");
  const fromEnv = new LMRouter({ apiKeys: { "claude-code": "k" }, env: { LM15_CLAUDE_CODE_VERSION: "2.1.282" } });
  assert.equal(await userAgent(fromEnv.lm("claude-code:claude-opus-5-5") as AnthropicLM), "claude-cli/2.1.282");
  const byDefault = new LMRouter({ apiKeys: { "claude-code": "k" }, env: {} });
  assert.equal(await userAgent(byDefault.lm("claude-code:claude-opus-5-5") as AnthropicLM), `claude-cli/${DEFAULT_CLAUDE_CODE_VERSION}`);
}));

test("an adapter built by hand reads no environment", async () => {
  process.env["LM15_CLAUDE_CODE_VERSION"] = "9.9.9";
  try {
    assert.equal(await userAgent(new ClaudeCodeLM({ apiKey: "k" })), `claude-cli/${DEFAULT_CLAUDE_CODE_VERSION}`);
  } finally {
    delete process.env["LM15_CLAUDE_CODE_VERSION"];
  }
});

test("codex client_version is the same setting", () => withScratchLogins(async () => {
  const lm = new OpenAICodexLM({ apiKey: "k", accountId: "a", settings: { client_version: "0.150.0" } });
  assert.equal(lm.clientVersion, "0.150.0");
  assert.equal(new OpenAICodexLM({ apiKey: "k", accountId: "a", clientVersion: "0.149.0" }).clientVersion, "0.149.0");
  const routed = new LMRouter({ apiKeys: { "openai-codex": "k" }, env: { LM15_CODEX_CLIENT_VERSION: "0.151.0" } });
  assert.equal(routed.lm("openai-codex:gpt-5.4-mini").access.backendOptions["client_version"], "0.151.0");
}));

test("a setting nothing reads is refused, not dropped", () => {
  assert.throws(() => new ClaudeCodeLM({ apiKey: "k", settings: { version: "2.1.280" } }), (e: unknown) => e instanceof NotConfiguredError && /known: client_version/.test(e.message));
  const router = new LMRouter({ apiKeys: { anthropic: "k" }, settings: { anthropic: { client_version: "1" } } });
  assert.throws(() => router.lm("anthropic:claude-opus-5-5"), (e: unknown) => e instanceof NotConfiguredError && /this door takes no settings/.test(e.message));
  assert.throws(() => resolveBackendSettings(CLAUDE_CODE, { region: "x" }), NotConfiguredError);
});

test("the doctor says which release is claimed and why", () => {
  const report = explainAuth("claude-code", { env: { LM15_CLAUDE_CODE_VERSION: "2.1.290" }, claudeCredentialsPath: "/nonexistent" });
  assert.deepEqual(report.settings, [["client_version", "2.1.290"]]);
  assert.deepEqual(report.settingSources, [["client_version", "env:LM15_CLAUDE_CODE_VERSION"]]);
  assert.match(describeReport(report), /setting client_version: 2\.1\.290 \(from env \$LM15_CLAUDE_CODE_VERSION\)/);
  assert.deepEqual(explainAuth("claude-code", { env: {}, claudeCredentialsPath: "/nonexistent" }).settingSources, [["client_version", "default"]]);
  assert.deepEqual(explainAuth("anthropic", { env: {} }).settings, []);
});

test("the minimum-version refusal names the setting", () => {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: REFUSAL }, request_id: "req_1" });
  const error = new ClaudeCodeLM({ apiKey: "k" }).normalizeError(400, body);
  assert.ok(error instanceof InvalidRequestError);
  assert.equal(error.message, REFUSAL + "\n\n  To fix:\n"
    + "    - lm15 sends this version itself; updating Claude Code does not change it\n"
    + "    - Set the claude-code setting client_version to 2.1.280 or newer (or LM15_CLAUDE_CODE_VERSION=2.1.280)\n");
  assert.equal(new AnthropicLM({ apiKey: "k" }).normalizeError(400, body).message, REFUSAL);
});

const CEILINGS: ReadonlyArray<[string, number | undefined, number, number]> = [
  ["claude-opus-5-5", undefined, 128000, 128000],
  ["claude-haiku-4-5", undefined, 64000, 64000],
  ["claude-sonnet-4-5", 32768, 64000, 64000 - 32768],
  ["claude-haiku-4-5", 64000, 64000 + 16384, 16384],
  ["anthropic.claude-haiku-4-5-20251001-v1:0", undefined, 64000, 64000],
  ["claude-3-5-haiku-20241022", undefined, 8192, 8192],
  ["deepseek-v4-flash", undefined, 16384, 16384],
];

for (const [model, budget, wire, applied] of CEILINGS) {
  test(`MAP-7 rule 6: an unset max_tokens on ${model}${budget ? ` (budget ${budget})` : ""} is ${wire} on the wire, ${applied} recorded`, async () => {
    const lm = new AnthropicLM({ apiKey: "k" });
    const request = { model, messages: [Message.user("hi")], ...(budget ? { config: { reasoning: { effort: "high" as const, thinkingBudget: budget } } } : {}) };
    const req = await lm.buildRequest(request, false);
    const body = JSON.parse(new TextDecoder().decode(req.body)) as { max_tokens: number };
    assert.equal(body.max_tokens, wire);
    assert.deepEqual((await lm.plan(request)).filter((a) => a.field === "config.max_tokens").map((a) => [a.action, a.applied]), [["defaulted", applied]]);
  });
}
