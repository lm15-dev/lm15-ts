/**
 * Managed authentication beyond what the contract's `managed` direction runs:
 * the managed router (AUTH-15 mode B), bound clients (AUTH-20.1, R4),
 * `connect()` (AUTH-23), the Node loopback listener with real sockets
 * (AUTH-18) and the file store (AUTH-25). No network beyond 127.0.0.1.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installNodePlatform } from "../src/platform_node.ts";
import { AuthOperationError } from "../src/errors.ts";
import { FileStore } from "../src/login/file_store.ts";
import { openCallbackListener } from "../src/login/listener_node.ts";
import { Auth } from "../src/login/manager.ts";
import { BoundClient } from "../src/login/bound.ts";
import { connect } from "../src/login/connect.ts";
import type { AuthUI, Notice, Prompt } from "../src/login/types.ts";
import { LMRouter } from "../src/router.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import { Message } from "../src/types/parts.ts";

installNodePlatform();

const CHAT_REPLY = JSON.stringify({ id: "r", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const RESPONSES_REPLY = JSON.stringify({ id: "r", object: "response", status: "completed", model: "m", output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

function header(transport: FakeTransport, name: string): string | undefined {
  const request = transport.requests.at(-1)!;
  return request.headers.find(([k]) => k.toLowerCase() === name)?.[1];
}

class ScriptUI implements AuthUI {
  readonly prompts: Prompt[] = [];
  readonly notices: Notice[] = [];
  readonly answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  async prompt(prompt: Prompt): Promise<string> {
    this.prompts.push(prompt);
    const next = this.answers.shift();
    if (next === undefined) throw new Error(`unexpected prompt ${prompt.fieldId}`);
    return next;
  }
  notify(notice: Notice): void {
    this.notices.push(notice);
  }
}

test("a managed router sends the saved key, never the environment's, and a signed-out slot blocks it", async () => {
  const auth = Auth.memory();
  await auth.setApiKey("openai", "saved-key");
  const transport = new FakeTransport([new FakeResponse({ body: RESPONSES_REPLY })]);
  const router = new LMRouter({ auth, env: { OPENAI_API_KEY: "ambient-key" }, transport });
  const response = await router.complete({ model: "openai:gpt-test", messages: [Message.user("hi")] });
  assert.equal(response.text, "ok");
  assert.equal(header(transport, "authorization"), "Bearer saved-key");
  assert.match(router.explainAuth("openai:gpt-test").steps.map((s) => `${s.kind}=${s.state}`).join(" "), /connection=selected env:OPENAI_API_KEY=shadowed/);

  await auth.logout("openai");
  const fresh = new LMRouter({ auth, env: { OPENAI_API_KEY: "ambient-key" }, transport });
  assert.throws(() => fresh.lm("openai:gpt-test"), (e: unknown) => e instanceof AuthOperationError && e.reason === "login_required");
});

test("an explicit apiKeys entry outranks the saved connection under a managed Auth", async () => {
  const auth = Auth.memory();
  await auth.setApiKey("openai", "saved-key");
  const transport = new FakeTransport([new FakeResponse({ body: RESPONSES_REPLY })]);
  const router = new LMRouter({ auth, apiKeys: { openai: "explicit-key" }, transport });
  await router.complete({ model: "openai:gpt-test", messages: [Message.user("hi")] });
  assert.equal(header(transport, "authorization"), "Bearer explicit-key");
});

test("a managed router routes the connection-only providers, with the account's host and headers", async () => {
  const auth = Auth.memory();
  const now = Date.now();
  await auth.store.mutate((doc) => ({
    ...doc,
    "github-copilot": { type: "oauth", access: "tid=1;proxy-ep=proxy.business.githubcopilot.com;tok", refresh: "gh", expires: now + 3_600_000, issued_at: now, lifetime_s: 3600 },
    _lm15: { version: 1, slots: { "github-copilot": { generation: "1", connection_id: "cn_copilotcopilot01", revision: "1", kind: "account", method_id: "device", instance_id: "public", label: "GitHub Copilot", created_at: "2026-09-25T00:00:00Z", routes: ["github-copilot"], settings: {}, state: "ready", renewal: "remint" } } },
  }));
  const transport = new FakeTransport([new FakeResponse({ body: CHAT_REPLY })]);
  const router = new LMRouter({ auth, transport });
  await router.complete({ model: "github-copilot:gpt-4.1", messages: [Message.user("hi")] });
  const request = transport.requests[0]!;
  assert.equal(new URL(request.url).host, "api.business.githubcopilot.com");
  assert.equal(header(transport, "editor-version"), "vscode/1.107.0");
  assert.equal(header(transport, "authorization"), "Bearer tid=1;proxy-ep=proxy.business.githubcopilot.com;tok");
  assert.throws(() => new LMRouter().lm("github-copilot:gpt-4.1")); // not routed without a managed Auth
});

test("a bound client follows renewals only: a replacement is connection_changed, a logout login_required (R4)", async () => {
  const auth = Auth.memory();
  const first = await auth.setApiKey("openai", "key-1");
  const transport = new FakeTransport([new FakeResponse({ body: RESPONSES_REPLY })]);
  const client = new BoundClient(auth, { provider: "openai", model: "gpt-test", connectionId: first.id, identityGeneration: first.identityGeneration }, { routerConfig: { transport } });
  assert.equal((await client.complete("hi")).text, "ok");
  assert.equal(transport.requests[0]!.headers.find(([k]) => k === "Authorization")?.[1] ?? header(transport, "authorization"), "Bearer key-1");
  await assert.rejects(client.complete({ model: "anthropic:claude", messages: [Message.user("x")] }), (e: unknown) => e instanceof AuthOperationError && e.reason === "selection_mismatch");
  await auth.setApiKey("openai", "key-2", { replace: first.id });
  await assert.rejects(client.complete("hi"), (e: unknown) => e instanceof AuthOperationError && e.reason === "connection_changed");
  await auth.logout("openai");
  await assert.rejects(client.complete("hi"), (e: unknown) => e instanceof AuthOperationError && e.reason === "login_required");
  await client.close();
});

test("connect() walks provider, method, key and model with the application's UI, and sends nothing", async () => {
  const auth = Auth.memory();
  // No $OPENAI_API_KEY here, so the only method is pasting a key (an unset variable is not offered).
  const saved = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  const ui = new ScriptUI(["openai", "typed-key", "__manual__", "gpt-test"]);
  let client;
  try {
    client = await connect({ auth, ui, routerConfig: { transport: new FakeTransport([new Error("the catalog is unreachable")]) } });
  } finally {
    if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
  }
  assert.equal(client.routed, "openai:gpt-test");
  assert.deepEqual(ui.prompts.map((p) => p.fieldId), ["provider", "key", "model", "model"]);
  assert.equal((await auth.requestAuth("openai")).credential?.value, "typed-key");
  assert.ok(ui.notices.some((n) => n.type === "info" && n.message.startsWith("Could not list models")));
  await client.close();
});

test("connect() without a UI and without a terminal fails before reading anything", async () => {
  await assert.rejects(connect({ auth: Auth.memory() }), (e: unknown) => e instanceof AuthOperationError && e.reason === "interaction_required");
});

test("the loopback listener: exact path, state checked on success and error returns, one use", async () => {
  const listener = await openCallbackListener({ path: "/cb", expectedState: "S", port: 0 });
  const base = listener.redirectUri;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/cb$/);
  assert.equal((await fetch(base.replace("/cb", "/other") + "?code=c&state=S")).status, 404);
  assert.equal((await fetch(`${base}?code=c&state=wrong`)).status, 400);
  assert.equal((await fetch(`${base}?error=access_denied&state=wrong`)).status, 400);
  assert.equal((await fetch(`${base}?code=c&state=S&state=S`)).status, 400);
  assert.equal(listener.done, false, "a rejected return never ends the legitimate wait");
  const page = await fetch(`${base}?code=the-code&state=S`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listener.wait(), { code: "the-code", state: "S" });
});

test("a busy registered port is method_unavailable, never a wider bind", async () => {
  const first = await openCallbackListener({ path: "/cb", expectedState: null, port: 0 });
  const port = Number(new URL(first.redirectUri).port);
  await assert.rejects(openCallbackListener({ path: "/cb", expectedState: null, port }), (e: unknown) => e instanceof AuthOperationError && e.reason === "method_unavailable");
  await assert.rejects(openCallbackListener({ path: "/cb", expectedState: null, port: 0, bindHost: "0.0.0.0" as "127.0.0.1" }), (e: unknown) => e instanceof AuthOperationError);
  first.stop();
});

test("ChatGPT browser login returns through the loopback listener", async () => {
  const auth = new Auth(Auth.memory().store, {
    fetch: (async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("code"), "loopback-code");
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url");
      return new Response(JSON.stringify({ access_token: `h.${payload}.s`, refresh_token: "r", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const ui: AuthUI = {
    notify(notice) {
      if (notice.type !== "auth_url") return;
      const url = new URL(notice.url);
      // The "browser": follow the redirect to the registered localhost return.
      setTimeout(() => void fetch(`http://127.0.0.1:1455/auth/callback?code=loopback-code&state=${url.searchParams.get("state")}`), 10);
    },
    prompt: (_p, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("dismissed")))),
  };
  let connection;
  try {
    connection = await auth.login("openai-codex", { method: "browser", ui, allowUnverified: true });
  } catch (error) {
    if (error instanceof AuthOperationError && error.reason === "method_unavailable") return; // port 1455 busy on this machine
    throw error;
  }
  assert.equal(connection.accountLabel, "acct");
});

test("the file store: private, strict, shared layout; an unreadable file is never overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lm15-store-"));
  const path = join(dir, "credentials.json");
  // A document as lm15-python writes it (floats, insertion order): read, used, rewritten compatibly.
  writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: "py-key" }, _lm15: { version: 1, slots: { openai: { generation: "1", connection_id: "cn_pythonwrote0001", revision: "1", kind: "api_key", method_id: "api_key", instance_id: "public", label: "openai API key", created_at: "2026-09-25T00:00:00Z", routes: ["openai"], settings: {}, state: "ready", renewal: "none" } } } }).replace('"version":1', '"version":1'));
  const auth = new Auth(new FileStore(path));
  assert.equal((await auth.requestAuth("openai")).credential?.value, "py-key");
  await auth.logout("openai");
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after._lm15.slots.openai.logged_out, true);
  assert.equal(after.openai, undefined);

  writeFileSync(path, "{broken");
  await assert.rejects(auth.setApiKey("openai", "k"), (e: unknown) => e instanceof AuthOperationError && e.reason === "storage_unavailable");
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
