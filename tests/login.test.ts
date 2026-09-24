/**
 * Managed-login mechanics (src/login): the profiles against lm15-contract's
 * auth/managed/profiles.json and browser.json, return validation (AUTH-18),
 * device pacing (RFC 8628), routing and relay refusal (AUTH-22, proposed
 * AUTH-21), AUTH-24 errors and diagnostics, and whole flows against fake
 * providers. No network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AuthOperationError, ServerError } from "../src/errors.ts";
import { authRequest, LoginContext, LoginDenied, parseManualReturn, pathRelay, runDeviceFlow, type LoginRouting } from "../src/login/engine.ts";
import { copilotBaseUrl } from "../src/login/flows/copilot.ts";
import { CLAUDE, CODEX, COPILOT, COPILOT_HEADERS, KIMI, META, OPENROUTER, ROUTE_DIRECTNESS, XAI, type RequestProfile } from "../src/login/profiles.ts";
import { loginAdapter, loginMethods, loginProviders, renewalDue, runLogin, runRenewal } from "../src/login/run.ts";
import type { AuthUI, LoginOutcome, Notice, Prompt } from "../src/login/types.ts";

const contract = process.env["LM15_CONTRACT_DIR"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "lm15-contract");
const profiles = JSON.parse(readFileSync(resolve(contract, "auth/managed/profiles.json"), "utf8"));
const browserEvidence = JSON.parse(readFileSync(resolve(contract, "auth/managed/browser.json"), "utf8"));
const P = profiles.providers;

// ─── Profiles are the contract's ─────────────────────────────────────

test("client ids, scopes, URLs and return URIs are the contract's profiles.json values", () => {
  assert.equal(XAI.clientId, P.xai.client_id);
  assert.equal(XAI.scope, P.xai.methods.device.requests.device_authorization.params.scope);
  assert.equal(XAI.deviceAuthorization.url, P.xai.methods.device.requests.device_authorization.url);
  assert.equal(XAI.token.url, P.xai.methods.device.requests.device_token.url);
  assert.equal(XAI.lifetimeWhenAbsentS, P.xai.methods.device.tokens.lifetime_when_absent_s);

  const claude = P["claude-code"];
  assert.equal(CLAUDE.clientId, claude.client_id);
  assert.equal(CLAUDE.scope, claude.scope);
  assert.equal(CLAUDE.authorizeUrl, claude.methods.browser.requests.authorize.url);
  assert.equal(CLAUDE.redirectUri, claude.methods.browser.return.registered_uri);
  assert.equal(CLAUDE.loopbackAuthorizeUrl, claude.methods.loopback.requests.authorize.url);
  assert.equal(CLAUDE.loopbackRedirectUri, claude.methods.loopback.return.registered_uri);
  assert.equal(CLAUDE.token.url, claude.token_url);
  assert.equal(CLAUDE.hostedVerifierBytes, claude.methods.browser.pkce.verifier_bytes);
  assert.equal(CLAUDE.loopbackVerifierBytes, claude.methods.loopback.pkce.verifier_bytes);
  assert.equal(CLAUDE.stateBytes, claude.methods.browser.state.state_bytes);

  const codex = P["openai-codex"];
  assert.equal(CODEX.clientId, codex.client_id);
  assert.equal(CODEX.scope, codex.scope);
  assert.equal(CODEX.authorizeUrl, codex.methods.browser.requests.authorize.url);
  assert.equal(CODEX.redirectUri, codex.methods.browser.return.registered_uri);
  assert.equal(CODEX.deviceRedirectUri, codex.methods.device.requests.token.params.redirect_uri);
  assert.equal(CODEX.deviceVerificationUrl, codex.methods.device.device.verification.split(" ")[0]);
  assert.equal(CODEX.deviceAuthorization.url, codex.methods.device.requests.device_authorization.url);
  assert.equal(CODEX.deviceToken.url, codex.methods.device.requests.device_token.url);
  assert.equal(CODEX.token.url, codex.token_url);
  assert.equal(CODEX.stateBytes, codex.methods.browser.state.state_bytes);

  const copilot = P["github-copilot"];
  assert.equal(COPILOT.clientId, copilot.client_id);
  assert.deepEqual({ ...COPILOT_HEADERS }, copilot.headers);
  assert.equal(COPILOT.deviceAuthorization("github.com").url, copilot.methods.device.requests.device_authorization.url.replace("<domain>", "github.com"));
  assert.equal(COPILOT.copilotToken("github.com").url, copilot.methods.device.requests.copilot_token.url.replace("<domain>", "github.com"));

  assert.equal(OPENROUTER.authorizeUrl, P.openrouter.methods.browser.requests.authorize.url);
  assert.equal(OPENROUTER.keys.url, P.openrouter.methods.browser.requests.token.url);

  assert.equal(KIMI.clientId, P["kimi-code"].client_id);
  assert.equal(KIMI.host, P["kimi-code"].host);
  assert.equal(KIMI.inferenceBaseUrl, P["kimi-code"].methods.device.inference.base_url);

  assert.equal(META.clientId, P.meta.client_id);
  assert.equal(META.keyMint.url, P.meta.methods.device.requests.key_mint.url);
  assert.equal(META.keyLifetimeS, P.meta.methods.device.tokens.lifetime_s);
});

test("page directness of every request is browser.json's verdict", () => {
  const verdict = new Map<string, string>();
  for (const r of browserEvidence.cors_probe.results) verdict.set(r.id, r.verdict);
  const expect: Array<[string, RequestProfile]> = [
    ["xai.device_authorization", XAI.deviceAuthorization], ["xai.device_token", XAI.token],
    ["claude-code.token", CLAUDE.token],
    ["openai-codex.token", CODEX.token], ["openai-codex.device_authorization", CODEX.deviceAuthorization], ["openai-codex.device_token", CODEX.deviceToken],
    ["github-copilot.device_authorization", COPILOT.deviceAuthorization("github.com")], ["github-copilot.device_token", COPILOT.deviceToken("github.com")],
    ["github-copilot.copilot_token", COPILOT.copilotToken("github.com")],
    ["openrouter.token", OPENROUTER.keys],
    ["kimi-code.device_authorization", KIMI.deviceAuthorization(KIMI.host)], ["kimi-code.device_token", KIMI.token(KIMI.host)],
    ["meta.device_authorization", META.deviceAuthorization], ["meta.device_token", META.deviceToken], ["meta.key_mint", META.keyMint],
  ];
  for (const [id, profile] of expect) assert.equal(profile.browser, verdict.get(id), id);
  for (const [route, direct] of Object.entries(ROUTE_DIRECTNESS)) {
    assert.equal(direct.inference, verdict.get(`${route}.inference`), `${route}.inference`);
    if (direct.catalog !== "none") assert.equal(direct.catalog, verdict.get(`${route}.models`), `${route}.models`);
  }
});

// ─── Returns (AUTH-18) ───────────────────────────────────────────────

const claudeReturn = { expectedState: "STATE", allowBareCode: false, registeredUri: CLAUDE.redirectUri };

test("a Claude return is code#state or the exact registered URL; nothing looser", () => {
  assert.deepEqual(parseManualReturn("abc#STATE", claudeReturn, "claude-code"), { code: "abc", state: "STATE" });
  assert.deepEqual(parseManualReturn(`${CLAUDE.redirectUri}?code=abc&state=STATE`, claudeReturn, "claude-code"), { code: "abc", state: "STATE" });
  assert.deepEqual(parseManualReturn("https://platform.claude.com:443/oauth/code/callback?code=abc&state=STATE", claudeReturn, "claude-code"), { code: "abc", state: "STATE" });
  const refused = [
    "abc", // bare code: no state
    "abc#WRONG",
    "https://evil.example/oauth/code/callback?code=abc&state=STATE",
    "https://platform.claude.com/oauth/code/other?code=abc&state=STATE",
    "https://user:pw@platform.claude.com/oauth/code/callback?code=abc&state=STATE",
    `${CLAUDE.redirectUri}?code=abc&state=STATE#frag`,
    `${CLAUDE.redirectUri}?code=abc&code=def&state=STATE`,
    `${CLAUDE.redirectUri}?code=abc&error=access_denied&state=STATE`,
    `${CLAUDE.redirectUri}?code=abc`,
    "",
    "x".repeat(9000),
  ];
  for (const text of refused) {
    assert.throws(() => parseManualReturn(text, claudeReturn, "claude-code"), (e: unknown) => e instanceof AuthOperationError && e.reason === "invalid_login_state" && !e.message.includes("abc"), text.slice(0, 60));
  }
});

test("a provider error return is a denial only when its state is this attempt's", () => {
  assert.throws(() => parseManualReturn(`${CLAUDE.redirectUri}?error=access_denied&state=STATE`, claudeReturn, "claude-code"), LoginDenied);
  assert.throws(() => parseManualReturn(`${CLAUDE.redirectUri}?error=access_denied&state=OTHER`, claudeReturn, "claude-code"), (e: unknown) => e instanceof AuthOperationError && e.reason === "invalid_login_state");
});

test("a page-redirect return: the registered page, trailing slash optional where the profile says so; nothing else", () => {
  const ctx = { expectedState: null, allowBareCode: false, registeredUri: "https://lm15.dev/playground/", trailingSlashOptional: true };
  // What OpenRouter actually sent back on 2026-09-24: no fragment, no trailing slash.
  assert.equal(parseManualReturn("https://lm15.dev/playground?code=c1", ctx, "openrouter").code, "c1");
  assert.equal(parseManualReturn("https://lm15.dev/playground/?code=c2", ctx, "openrouter").code, "c2");
  for (const text of ["https://lm15.dev/other?code=c1", "https://evil.example/playground?code=c1", "http://lm15.dev/playground?code=c1", "https://lm15.dev/playground?code=c1#x", "https://lm15.dev/playground?code=a&code=b", "c1"]) {
    assert.throws(() => parseManualReturn(text, ctx, "openrouter"), (e: unknown) => e instanceof AuthOperationError && e.reason === "invalid_login_state", text);
  }
  assert.throws(() => parseManualReturn("https://lm15.dev/playground?code=c1", { ...ctx, trailingSlashOptional: false }, "openrouter"), AuthOperationError);
});

// ─── A fake world ────────────────────────────────────────────────────

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(route: (req: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" };
    seen.push(req);
    return route(req);
  }) as typeof fetch;
  return { fetch: f, seen };
}

class ScriptedUI implements AuthUI {
  notices: Notice[] = [];
  prompts: Prompt[] = [];
  answers: Array<string | ((p: Prompt) => string)>;
  constructor(answers: Array<string | ((p: Prompt) => string)> = []) {
    this.answers = answers;
  }
  async prompt(p: Prompt): Promise<string> {
    this.prompts.push(p);
    const next = this.answers.shift();
    if (next === undefined) throw new Error("unexpected prompt");
    return typeof next === "function" ? next(p) : next;
  }
  notify(n: Notice): void {
    this.notices.push(n);
  }
}

function fakeTime() {
  let now = 0;
  return {
    clock: () => now,
    wallClock: () => 1_790_000_000_000 + now,
    sleep: async (ms: number) => {
      now += ms;
    },
    waited: () => now,
  };
}

const relay = pathRelay("https://relay.test", { stages: ["auth", "inference"], userAgentHeader: "x-lm15-user-agent" });

// ─── Routing (AUTH-22, proposed AUTH-21) ─────────────────────────────

test("in a page, an endpoint the evidence marks relay-only is refused before anything is sent", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, {}));
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "xai", routing: { platform: "browser" }, fetch });
  await assert.rejects(authRequest(ctx, XAI.token, { params: {} }), (e: unknown) => e instanceof AuthOperationError && e.reason === "method_unavailable" && e.delivery === "not_sent" && e.host === "auth.x.ai");
  assert.equal(seen.length, 0);
});

test("with a relay for sign-in, the request goes to /<host>/<path> and the identification rides the relay's header", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { ok: true }));
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "xai", routing: { platform: "browser", relay }, fetch });
  const reply = await authRequest(ctx, XAI.token, { params: { a: "1" } });
  assert.equal(seen[0]!.url, "https://relay.test/auth.x.ai/oauth2/token");
  assert.match(seen[0]!.headers["x-lm15-user-agent"]!, /^lm15\//);
  assert.equal(seen[0]!.headers["user-agent"], undefined);
  assert.equal(reply.via, "https://relay.test");
});

test("a direct endpoint in a page never uses the relay, even when one is configured", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, {}));
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "openai-codex", routing: { platform: "browser", relay }, fetch });
  await authRequest(ctx, CODEX.token, { params: {} });
  assert.equal(seen[0]!.url, CODEX.token.url);
});

test("native requests identify as lm15/<version>, or as the profile says", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, {}));
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "github-copilot", routing: { platform: "native" }, fetch });
  await authRequest(ctx, XAI.token, { params: {} });
  await authRequest(ctx, COPILOT.deviceAuthorization("github.com"), { params: {} });
  assert.match(seen[0]!.headers["user-agent"]!, /^lm15\//);
  assert.equal(seen[1]!.headers["user-agent"], "GitHubCopilotChat/0.35.0");
  assert.equal(seen[1]!.headers["accept"], "application/json");
});

// ─── AUTH-24 diagnostics and failures ────────────────────────────────

test("diagnostics keep status, format and a recognized OAuth word; provider text never leaves the reply", async () => {
  const secret = "PROVIDER-SAYS-sk-live-123";
  const { fetch } = fakeFetch(() => json(400, { error: "invalid_grant", error_description: secret }));
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "claude-code", routing: { platform: "native" }, fetch });
  const reply = await authRequest(ctx, CLAUDE.token, { params: {} });
  assert.equal(reply.oauthError, "invalid_grant");
  assert.equal(reply.responseFormat, "json");
  const denied = new LoginDenied("Claude token renewal failed", { reply, stage: "renewal" });
  assert.match(denied.summary!, /HTTP 400; response=json; OAuth error=invalid_grant/);
  assert.ok(!denied.summary!.includes(secret));

  const odd = fakeFetch(() => json(403, { error: "you_are_blocked" }));
  const r2 = await authRequest(new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, fetch: odd.fetch }), CLAUDE.token);
  assert.equal(r2.oauthError, null);
  const html = fakeFetch(() => new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } }));
  const r3 = await authRequest(new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, fetch: html.fetch }), CLAUDE.token);
  assert.equal(r3.responseFormat, "html");
  assert.equal(r3.securityChallenge, true);
});

test("a reply with duplicate JSON members is not trusted as JSON (AUTH-25 strictness)", async () => {
  const { fetch } = fakeFetch(() => new Response('{"access_token":"a","access_token":"b"}', { status: 200, headers: { "content-type": "application/json" } }));
  const reply = await authRequest(new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, fetch }), CLAUDE.token);
  assert.equal(reply.responseFormat, "invalid_json");
  assert.deepEqual(reply.body, {});
});

test("5xx is a ServerError; a redirect and an over-large body are refused", async () => {
  const ctx = (f: typeof fetch) => new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, fetch: f });
  await assert.rejects(authRequest(ctx(fakeFetch(() => json(503, {})).fetch), CLAUDE.token), ServerError);
  await assert.rejects(authRequest(ctx(fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil" } })).fetch), CLAUDE.token), (e: unknown) => e instanceof AuthOperationError && e.reason === "method_unavailable");
  await assert.rejects(authRequest(ctx(fakeFetch(() => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })).fetch), CLAUDE.token, { consumes: true }), (e: unknown) => e instanceof AuthOperationError && e.reason === "indeterminate");
});

test("a failed one-use exchange is indeterminate; a failed harmless one is not", async () => {
  const broken = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "openai-codex", routing: { platform: "browser" }, fetch: broken });
  await assert.rejects(authRequest(ctx, CODEX.token, { consumes: true, stage: "renewal" }), (e: unknown) => e instanceof AuthOperationError && e.reason === "indeterminate" && e.delivery === "unknown" && e.stage === "renewal");
  await assert.rejects(authRequest(ctx, CODEX.deviceAuthorization, { stage: "authorization" }), (e: unknown) => e instanceof AuthOperationError && e.reason === "method_unavailable" && /looks exactly like this/.test(e.message));
});

test("AuthOperationError is auth_operation, root-level, never retryable", () => {
  const e = new AuthOperationError("x", { reason: "login_denied" });
  assert.equal(e.code, "auth_operation");
  assert.equal(e.retryable, false);
  assert.throws(() => new AuthOperationError("x", { reason: "nope" as never }), TypeError);
});

// ─── Device pacing (RFC 8628) ────────────────────────────────────────

test("device polling: waits first, slow_down adds 5 s and never shortens, expiry bounds the attempt", async () => {
  const time = fakeTime();
  const ctx = new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, clock: time.clock, sleep: time.sleep });
  const at: number[] = [];
  const steps = [{ status: "pending" }, { status: "slow_down" }, { status: "slow_down", intervalS: 30 }, { status: "complete", value: "done" }] as const;
  let i = 0;
  const value = await runDeviceFlow(ctx, async () => {
    at.push(time.waited());
    return steps[i++]!;
  }, { intervalS: 2, expiresInS: 600 });
  assert.equal(value, "done");
  assert.deepEqual(at, [2000, 4000, 11000, 41000]);

  const t2 = fakeTime();
  const ctx2 = new LoginContext({ ui: new ScriptedUI(), provider: "x", routing: { platform: "native" }, clock: t2.clock, sleep: t2.sleep });
  await assert.rejects(runDeviceFlow(ctx2, async () => ({ status: "pending" }), { intervalS: 5, expiresInS: 12 }), /deadline/);
});

// ─── Whole flows ─────────────────────────────────────────────────────

test("xAI device login in a page through the sign-in relay: exact requests, pacing, material", async () => {
  const time = fakeTime();
  let polls = 0;
  const { fetch, seen } = fakeFetch((req) => {
    if (req.url.endsWith("/oauth2/device/code")) return json(200, { device_code: "DC", user_code: "UC-1", verification_uri: "https://accounts.x.ai/device", verification_uri_complete: "https://accounts.x.ai/device?user_code=UC-1", interval: 1, expires_in: 900 });
    polls++;
    if (polls === 1) return json(400, { error: "authorization_pending" });
    return json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 });
  });
  const ui = new ScriptedUI();
  const outcome = await runLogin("xai", "device", { ui, fetch, platform: "browser", relay, allowUnverified: true, clock: time.clock, wallClock: time.wallClock, sleep: time.sleep });
  assert.equal(seen[0]!.url, "https://relay.test/auth.x.ai/oauth2/device/code");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0]!.body)), { client_id: XAI.clientId, scope: XAI.scope, referrer: "lm15" });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[1]!.body)), { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: XAI.clientId, device_code: "DC" });
  const device = ui.notices.find((n) => n.type === "device_code");
  assert.deepEqual(device && device.type === "device_code" ? [device.userCode, device.verificationUrl] : [], ["UC-1", "https://accounts.x.ai/device?user_code=UC-1"]);
  assert.equal(outcome.material.type, "oauth");
  assert.deepEqual({ ...outcome.material }, { type: "oauth", access: "AT", refresh: "RT", issued_at: time.wallClock(), lifetime_s: 3600, expires: time.wallClock() + 3_600_000 });
  assert.equal(outcome.renewal, "refresh_token");
});

test("in a page without a sign-in relay, xAI is unavailable before anything is clicked; with one, unverified", () => {
  const without = loginMethods("xai", { platform: "browser" })[0]!;
  assert.equal(without.availability, "unavailable");
  assert.match(without.reason!, /auth\.x\.ai needs a relay/);
  const withRelay = loginMethods("xai", { platform: "browser", relay })[0]!;
  assert.equal(withRelay.availability, "unverified");
  assert.deepEqual(withRelay.needsRelay, ["auth"]);
  assert.equal(loginMethods("xai", { platform: "native" })[0]!.availability, "supported");
  const codex = loginMethods("openai-codex", { platform: "browser" });
  assert.deepEqual(codex.map((m) => [m.id, m.availability, m.delivery.join("+"), m.needsRelay.join("+")]), [["browser", "unverified", "manual", "catalog+inference"], ["device", "unverified", "device", "catalog+inference"]]);
  const openrouter = loginMethods("openrouter", { platform: "browser" })[0]!;
  assert.deepEqual([openrouter.availability, openrouter.delivery], ["unverified", ["manual", "page_redirect"]]);
  assert.equal(loginMethods("openrouter", { platform: "native" })[0]!.delivery.includes("page_redirect"), false);
  assert.ok(loginProviders({ platform: "browser" }).every((p) => p.methods.every((m) => m.availability !== "supported")), "a page never inherits native support");
});

test("an unverified method needs explicit opt-in; nothing is sent without it", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, {}));
  await assert.rejects(runLogin("openai-codex", "device", { ui: new ScriptedUI(), fetch, platform: "browser" }), (e: unknown) => e instanceof AuthOperationError && e.reason === "method_unavailable" && /allowUnverified/.test(e.message));
  assert.equal(seen.length, 0);
});

test("Claude hosted login: exact authorize URL, a wrong paste is rejected and the wait goes on, exact exchange", async () => {
  let authUrl = "";
  const ui = new ScriptedUI([
    "abc#WRONG-STATE",
    () => `CODE#${new URL(authUrl).searchParams.get("state")}`,
  ]);
  const notify = ui.notify.bind(ui);
  ui.notify = (n) => {
    if (n.type === "auth_url") authUrl = n.url;
    notify(n);
  };
  const { fetch, seen } = fakeFetch(() => json(200, { access_token: "AT", refresh_token: "RT", expires_in: 28800 }));
  const outcome = await runLogin("claude-code", "browser", { ui, fetch, platform: "browser", relay, allowUnverified: true });
  const url = new URL(authUrl);
  assert.equal(url.origin + url.pathname, CLAUDE.authorizeUrl);
  assert.deepEqual([...url.searchParams.keys()], ["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"]);
  assert.equal(url.searchParams.get("redirect_uri"), CLAUDE.redirectUri);
  assert.equal(url.searchParams.get("state")!.length, 43);
  assert.ok(ui.notices.some((n) => n.type === "info" && /does not belong/.test(n.message)));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://relay.test/platform.claude.com/v1/oauth/token");
  const body = JSON.parse(seen[0]!.body);
  assert.deepEqual(Object.keys(body), ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "state"]);
  assert.equal(body.code, "CODE");
  assert.equal(body.code_verifier.length, 43);
  assert.equal(outcome.material.type === "oauth" && outcome.material.refresh, "RT");
});

test("Codex device login goes direct in a page (auth.openai.com allows it) and exchanges at the device redirect", async () => {
  const time = fakeTime();
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" }, exp: 2_000_000_000 })).toString("base64url");
  const access = `eyJhbGciOiJub25lIn0.${payload}.sig`;
  let polls = 0;
  const { fetch, seen } = fakeFetch((req) => {
    if (req.url === CODEX.deviceAuthorization.url) return json(200, { device_auth_id: "DA", user_code: "UC", interval: "5" });
    if (req.url === CODEX.deviceToken.url) return ++polls === 1 ? json(403, {}) : json(200, { authorization_code: "AC", code_verifier: "CV" });
    return json(200, { access_token: access, refresh_token: "RT", expires_in: 864000 });
  });
  const outcome = await runLogin("openai-codex", "device", { ui: new ScriptedUI(), fetch, platform: "browser", allowUnverified: true, clock: time.clock, wallClock: time.wallClock, sleep: time.sleep });
  assert.deepEqual(seen.map((s) => s.url), [CODEX.deviceAuthorization.url, CODEX.deviceToken.url, CODEX.deviceToken.url, CODEX.token.url]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[3]!.body)), { grant_type: "authorization_code", client_id: CODEX.clientId, code: "AC", code_verifier: "CV", redirect_uri: CODEX.deviceRedirectUri });
  assert.equal(outcome.material.type === "oauth" && outcome.material.accountId, "acct_1");
  assert.throws(() => loginAdapter(outcome, { platform: "browser" }), (e: unknown) => e instanceof AuthOperationError && /relay the person agreed to for inference/.test(e.message));
  const adapter = loginAdapter(outcome, { platform: "browser", relay });
  assert.equal(adapter.baseUrl, "https://relay.test/chatgpt.com/backend-api/codex");
});

test("OpenRouter in a page: the callback is the page itself; the normalized return is accepted; the key is minted direct", async () => {
  const ui = new ScriptedUI([() => "https://lm15.dev/playground?code=OC"]);
  const { fetch, seen } = fakeFetch(() => json(200, { key: "sk-or-v1-x" }));
  const outcome = await runLogin("openrouter", "browser", { ui, fetch, platform: "browser", allowUnverified: true, pageReturnUrl: "https://lm15.dev/playground/?mode=chat" });
  const auth = ui.notices.find((n) => n.type === "auth_url");
  assert.equal(new URL(auth && auth.type === "auth_url" ? auth.url : "x:").searchParams.get("callback_url"), "https://lm15.dev/playground/");
  assert.equal(seen[0]!.url, OPENROUTER.keys.url);
  const body = JSON.parse(seen[0]!.body);
  assert.equal(body.code, "OC");
  assert.equal(body.code_challenge_method, "S256");
  assert.deepEqual({ ...outcome.material }, { type: "api_key", key: "sk-or-v1-x", minted: true });
});

test("Copilot: the account host comes from the token, only under GitHub's domains", () => {
  const m = (access: string) => ({ type: "oauth" as const, access });
  assert.equal(copilotBaseUrl(m("tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=1"), {}), "https://api.business.githubcopilot.com");
  assert.equal(copilotBaseUrl(m("tid=1;proxy-ep=evil.example;exp=1"), {}), COPILOT.defaultApiBase);
  assert.equal(copilotBaseUrl(m("tid=1;proxy-ep=proxy.corp.ghe.com"), { enterprise_domain: "corp.ghe.com" }), "https://api.corp.ghe.com");
});

// ─── Renewal ─────────────────────────────────────────────────────────

test("renewal lead is min(5 min, lifetime/10) of the actual expiry", () => {
  const hour = { type: "oauth" as const, access: "a", expires: 3_600_000, issued_at: 0, lifetime_s: 3600 };
  assert.equal(renewalDue(hour, 3_600_000 - 300_001), false);
  assert.equal(renewalDue(hour, 3_600_000 - 300_000), true);
  const minute = { type: "oauth" as const, access: "a", expires: 60_000, issued_at: 0, lifetime_s: 60 };
  assert.equal(renewalDue(minute, 53_999), false);
  assert.equal(renewalDue(minute, 54_000), true);
  assert.equal(renewalDue({ type: "oauth", access: "a" }, 1e15), false);
});

test("a rejected renewal is credential_rejected; a lost renewal reply is indeterminate", async () => {
  const outcome: LoginOutcome = { provider: "claude-code", methodId: "browser", material: { type: "oauth", access: "A", refresh: "R" }, label: "", renewal: "refresh_token", settings: {} };
  const routing = { platform: "native" as const };
  await assert.rejects(runRenewal(outcome, { ...routing, fetch: fakeFetch(() => json(400, { error: "invalid_grant" })).fetch }), (e: unknown) => e instanceof AuthOperationError && e.reason === "credential_rejected" && e.providerCode === "invalid_grant");
  await assert.rejects(runRenewal(outcome, { ...routing, fetch: (() => Promise.reject(new TypeError("x"))) as typeof fetch }), (e: unknown) => e instanceof AuthOperationError && e.reason === "indeterminate");
  const renewed = await runRenewal(outcome, { ...routing, fetch: fakeFetch(() => json(200, { access_token: "A2", refresh_token: "R2", expires_in: 100 })).fetch });
  assert.equal(renewed.material.type === "oauth" && renewed.material.refresh, "R2");
});

test("cancelling at a prompt ends the attempt with a native AbortError", async () => {
  const controller = new AbortController();
  const ui: AuthUI = {
    prompt: (_p, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    notify: () => controller.abort(),
  };
  await assert.rejects(runLogin("claude-code", "browser", { ui, signal: controller.signal, platform: "browser", relay, allowUnverified: true, fetch: fakeFetch(() => json(200, {})).fetch }), (e: unknown) => e instanceof Error && e.name === "AbortError");
});

void ({} as LoginRouting);

test("the external Claude Code source renews with the contract's client id (was …-44d5-…, a transcription error)", async () => {
  const { CLAUDE_CODE_CLIENT_ID } = await import("../src/auth/stores.ts");
  assert.equal(CLAUDE_CODE_CLIENT_ID, P["claude-code"].client_id);
});

test("every exchange is reported once, secret-free: host, path, way, status, OAuth word", async () => {
  const records: unknown[] = [];
  const secretBody = { access_token: "SECRET-AT", refresh_token: "SECRET-RT", expires_in: 100 };
  const outcome: LoginOutcome = { provider: "claude-code", methodId: "browser", material: { type: "oauth", access: "A", refresh: "SECRET-OLD" }, label: "", renewal: "refresh_token", settings: {} };
  await runRenewal(outcome, { platform: "browser", relay, fetch: fakeFetch(() => json(200, secretBody)).fetch, onExchange: (r) => records.push(r) });
  await assert.rejects(runRenewal(outcome, { platform: "browser", onExchange: (r) => records.push(r) }));
  assert.equal(records.length, 2);
  assert.deepEqual({ ...(records[0] as object), ms: 0 }, { provider: "claude-code", stage: "renewal", method: "POST", host: "platform.claude.com", path: "/v1/oauth/token", via: "https://relay.test", status: 200, responseFormat: "json", oauthError: null, failure: null, ms: 0 });
  assert.equal((records[1] as { failure: string }).failure, "method_unavailable");
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});

test("relay consent is per stage: agreeing to model calls does not cover model lists", () => {
  const outcome: LoginOutcome = { provider: "openai-codex", methodId: "device", material: { type: "oauth", access: "A", refresh: "R", accountId: "acct" }, label: "", renewal: "refresh_token", settings: {} };
  const inferenceOnly = pathRelay("https://relay.test", { stages: ["inference"] });
  assert.equal(loginAdapter(outcome, { platform: "browser", relay: inferenceOnly }).baseUrl, "https://relay.test/chatgpt.com/backend-api/codex");
  assert.throws(() => loginAdapter(outcome, { platform: "browser", relay: inferenceOnly, stage: "catalog" }), /model lists need a relay/);
  assert.equal(loginAdapter(outcome, { platform: "native" }).baseUrl, "https://chatgpt.com/backend-api/codex");
});
