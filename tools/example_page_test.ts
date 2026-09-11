/**
 * The example app's modules, exercised in a real browser against the smoke
 * server's fake OpenRouter (`/fake/...`), through a real redirect: this
 * page sends itself to the fake authorization page, comes back with a
 * code, and finishes the login — the verifier surviving in sessionStorage
 * as it would across openrouter.ai. Then the chat: models, the wire
 * preview, a streamed turn, a second turn carrying the first, a cancel,
 * a wrong key. With `?live=1` and a key from the server, the same chat
 * against the real openrouter.ai — the CORS and the wire from a page.
 */

import { Chat, describeError, isCancellation } from "../examples/openrouter-page/src/chat.ts";
import { KeyStore } from "../examples/openrouter-page/src/keys.ts";
import { LoginError, beginLogin, completeLogin, keyHash, keyInfo, pendingCode, type LoginEndpoints } from "../examples/openrouter-page/src/login.ts";

interface Check {
  readonly ok: boolean;
  readonly detail: string;
}

const PHASE_A = "lm15-example-test.phase-a";
const checks: Record<string, Check> = JSON.parse(sessionStorage.getItem(PHASE_A) ?? "{}") as Record<string, Check>;
const check = (name: string, ok: boolean, detail: string) => {
  checks[name] = { ok, detail };
};

const FAKE: LoginEndpoints = { authorize: `${location.origin}/fake/auth`, exchange: `${location.origin}/fake/api/v1/auth/keys`, manage: `${location.origin}/fake/keys`, keyInfo: `${location.origin}/fake/api/v1/auth/key` };
const FAKE_BASE = `${location.origin}/fake/api/v1`;
const here = location.origin + location.pathname;

async function phaseA(): Promise<void> {
  // The key store, with a scratch Storage.
  const scratch = new Map<string, string>();
  const storage = { getItem: (k: string) => scratch.get(k) ?? null, setItem: (k: string, v: string) => void scratch.set(k, v), removeItem: (k: string) => void scratch.delete(k) } as unknown as Storage;
  const keys = new KeyStore(storage);
  keys.set("tab-key", false);
  const tabOnly = keys.load() === "tab-key" && !keys.remembered && scratch.size === 0;
  keys.set("device-key", true);
  const remembered = keys.remembered && new KeyStore(storage).load() === "device-key";
  keys.forget();
  const forgotten = keys.load() === undefined && scratch.size === 0;
  check("key-store", tabOnly && remembered && forgotten, `tab-only=${tabOnly} remembered=${remembered} forgotten=${forgotten}`);

  // A return leg with no login in progress is a LoginError that says so.
  try {
    await completeLogin("stray", FAKE);
    check("login-no-verifier", false, "no error");
  } catch (e) {
    check("login-no-verifier", e instanceof LoginError && /no login in progress/.test(e.message), String(e));
  }

  // Off to the authorization page, for real.
  const url = await beginLogin(here, FAKE);
  const p = url.searchParams;
  check("login-url", url.origin === location.origin && url.pathname === "/fake/auth" && p.get("callback_url") === here && p.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? ""), url.search);
  sessionStorage.setItem(PHASE_A, JSON.stringify(checks));
  if (new URLSearchParams(location.search).get("live") === "1") sessionStorage.setItem("lm15-example-test.live", "1");
  location.assign(url);
}

async function chatChecks(prefix: string, chat: Chat, model: string, opts: { expectText?: string; cancelPrompt: string; wrongKeyBase: string; key: string; endpoints: LoginEndpoints }): Promise<void> {
  // The key, verified: label and credit for a real one; 401 → LoginError for a wrong one. (/models is public and proves nothing.)
  try {
    const info = await keyInfo(opts.key, opts.endpoints);
    check(`${prefix}key-info`, info.label.length > 0 && info.usage >= 0, `label=${info.label} usage=${info.usage} limit=${info.limit} remaining=${info.limitRemaining}`);
  } catch (e) {
    check(`${prefix}key-info`, false, String(e));
  }
  try {
    await keyInfo("sk-or-wrong", opts.endpoints);
    check(`${prefix}key-info-wrong`, false, "accepted a wrong key");
  } catch (e) {
    check(`${prefix}key-info-wrong`, e instanceof LoginError && /401/.test(e.message), String(e));
  }

  try {
    const models = await chat.models();
    check(`${prefix}models`, models.length > 0 && models.some((m) => m.id === model) && models.every((m) => m.provider === "openrouter"), `${models.length} models, has ${model}: ${models.some((m) => m.id === model)}`);
  } catch (e) {
    check(`${prefix}models`, false, describeError(e));
  }

  const first = chat.request(model, "Reply with exactly: hello from a page", 32);
  try {
    const preview = await chat.preview(first);
    const headers = Object.fromEntries(preview.headers.map(([k, v]) => [k.toLowerCase(), v]));
    const body = preview.body as { stream?: boolean; stream_options?: { include_usage?: boolean }; model?: string; messages?: unknown[] };
    check(
      `${prefix}preview`,
      headers["authorization"] === "Bearer [redacted]" && headers["http-referer"] === location.origin && headers["x-title"] === "smoke" && body.stream === true && body.stream_options?.include_usage === true && body.model === model && body.messages?.length === 1,
      `auth=${headers["authorization"]} referer=${headers["http-referer"]} title=${headers["x-title"]} stream=${body.stream} usage=${body.stream_options?.include_usage}`,
    );
  } catch (e) {
    check(`${prefix}preview`, false, describeError(e));
  }

  try {
    const rs = chat.send(first, new AbortController().signal);
    const pieces: string[] = [];
    for await (const piece of rs) pieces.push(piece);
    const response = await rs.response();
    chat.commit(first, response);
    const text = pieces.join("");
    const ok = pieces.length >= 2 && response.finishReason === "stop" && (response.usage?.totalTokens ?? 0) > 0 && (opts.expectText === undefined ? text.length > 0 : text === opts.expectText);
    check(`${prefix}stream`, ok, `pieces=${pieces.length} text=${JSON.stringify(text.slice(0, 60))} finish=${response.finishReason} tokens=${response.usage?.totalTokens}`);
  } catch (e) {
    check(`${prefix}stream`, false, describeError(e));
  }

  // The second turn carries the first: the wire shows three messages.
  const second = chat.request(model, "and again", 16);
  check(`${prefix}history`, chat.messages.length === 2 && second.messages.length === 3, `transcript=${chat.messages.length} wire=${second.messages.length}`);

  // Cancel mid-stream: the abort surfaces as a cancellation, not a failure, and the turn is not kept.
  try {
    const controller = new AbortController();
    const slow = chat.request(model, opts.cancelPrompt, 200);
    const rs = chat.send(slow, controller.signal);
    let seen = 0;
    let error: unknown;
    try {
      for await (const _ of rs) {
        seen++;
        controller.abort();
      }
    } catch (e) {
      error = e;
    }
    check(`${prefix}cancel`, seen >= 1 && isCancellation(error, controller.signal) && chat.messages.length === 2, `seen=${seen} cancellation=${isCancellation(error, controller.signal)} transcript=${chat.messages.length}`);
  } catch (e) {
    check(`${prefix}cancel`, false, describeError(e));
  }

  // A wrong key on a completion: a typed AuthError with the status, described for a person, the key nowhere in it.
  try {
    const wrong = new Chat({ key: "sk-or-wrong", baseUrl: opts.wrongKeyBase, referer: location.origin, title: "smoke" });
    const rs = wrong.send(wrong.request(model, "hi", 1), new AbortController().signal);
    for await (const _ of rs) void _;
    check(`${prefix}auth-error`, false, "no error");
  } catch (e) {
    const text = describeError(e);
    check(`${prefix}auth-error`, /^AuthError: /.test(text) && /HTTP 401/.test(text) && !/in your environment/.test(text) && !text.includes("sk-or-wrong"), text.split("\n")[0]! + " …");
  }
}

async function phaseB(code: string): Promise<void> {
  history.replaceState(null, "", location.pathname);
  let key: string;
  try {
    key = await completeLogin(code, FAKE);
    check("login-exchange", /^sk-or-fake-/.test(key) && sessionStorage.getItem("lm15-example.pkce-verifier") === null, `key prefix ok, verifier cleared`);
  } catch (e) {
    check("login-exchange", false, String(e));
    return;
  }
  // A second exchange with the same code must be refused (the verifier is gone).
  try {
    await completeLogin(code, FAKE);
    check("login-single-use", false, "second exchange succeeded");
  } catch (e) {
    check("login-single-use", e instanceof LoginError, String(e));
  }
  check("key-hash", (await keyHash("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256('abc')");

  const chat = new Chat({ key, baseUrl: FAKE_BASE, referer: location.origin, title: "smoke" });
  await chatChecks("fake-", chat, "openai/gpt-4.1-mini", { expectText: "Reply with exactly: hello from a page", cancelPrompt: "cancel me", wrongKeyBase: FAKE_BASE, key, endpoints: FAKE });
}

async function phaseLive(): Promise<void> {
  const res = await fetch("/_smoke/key");
  if (res.status !== 200) {
    for (const name of ["key-info", "key-info-wrong", "models", "preview", "stream", "history", "cancel", "auth-error"]) check(`live-${name}`, false, "skipped: no OPENROUTER_API_KEY");
    return;
  }
  const { key, model } = (await res.json()) as { key: string; model: string };
  const chat = new Chat({ key, referer: location.origin, title: "smoke" });
  const { OPENROUTER } = await import("../examples/openrouter-page/src/login.ts");
  await chatChecks("live-", chat, model, { cancelPrompt: "Count slowly from one to two hundred, one number per line.", wrongKeyBase: "https://openrouter.ai/api/v1", key, endpoints: OPENROUTER });
}

(async () => {
  const code = pendingCode(location.search);
  if (!code) {
    await phaseA();
    return; // navigating away
  }
  await phaseB(code);
  if (sessionStorage.getItem("lm15-example-test.live") === "1") await phaseLive();
  sessionStorage.removeItem(PHASE_A);
  sessionStorage.removeItem("lm15-example-test.live");
  const report = { userAgent: navigator.userAgent, checks };
  document.body.textContent = JSON.stringify(report);
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
})().catch(async (e) => {
  check("run", false, String(e));
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userAgent: navigator.userAgent, checks }) });
});
