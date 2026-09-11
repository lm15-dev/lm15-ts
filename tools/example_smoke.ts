#!/usr/bin/env node
/**
 * The example app (examples/openrouter-page) in real browsers.
 *
 * The loopback server plays OpenRouter under `/fake/`: the authorization
 * page (which redirects back with a one-time code bound to the PKCE
 * challenge), the code exchange (which checks the verifier against that
 * challenge, exactly as RFC 7636 says), the model list, and Chat
 * Completions (streamed, with usage; a slow stream to cancel; 401 for a
 * wrong key; the attribution headers recorded). `tools/example_page_test.ts`
 * drives the app's modules through it, including the real redirect.
 *
 * `--live` (or LM15_SMOKE_LIVE=1) with OPENROUTER_API_KEY in the
 * environment additionally runs the chat against the real openrouter.ai
 * from the page and writes a receipt (key redacted) under `receipts/`.
 * The PKCE login itself cannot be run headless: it needs a person at
 * OpenRouter's page — run `npm run example` for that.
 *
 * Run: `npm run test:example`.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findBrowsers, printReport, readBody, root, runInBrowser, type Check, type Report } from "./headless.ts";

const LIVE = process.argv.includes("--live") || process.env["LM15_SMOKE_LIVE"] === "1";
const LIVE_KEY = LIVE ? process.env["OPENROUTER_API_KEY"] : undefined;
const LIVE_MODEL = process.env["LM15_SMOKE_MODEL"] ?? "openai/gpt-4.1-mini";

const PAGE = `<!doctype html><meta charset="utf-8"><title>lm15 example smoke</title>
<script type="importmap">{"imports":{"lm15/browser":"/src/browser.ts"}}</script>
<body><script type="module" src="/tools/example_page_test.ts"></script>`;

interface FakeState {
  readonly codes: Map<string, string>; // code → challenge
  readonly keys: Set<string>;
  attribution: Record<string, string | undefined> | undefined;
  cancelObserved: boolean;
}

function chunk(model: string, delta: Record<string, unknown>, finish?: string, usage?: Record<string, number>): string {
  const frame: Record<string, unknown> = { id: "gen-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
  if (usage) frame["usage"] = usage;
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** OpenRouter, as far as the example touches it. */
async function fakeOpenRouter(req: IncomingMessage, res: ServerResponse, state: FakeState): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/fake/")) return false;
  const path = url.pathname.slice("/fake".length);

  if (path === "/auth" && req.method === "GET") {
    const callback = url.searchParams.get("callback_url");
    const challenge = url.searchParams.get("code_challenge");
    if (!callback || !challenge || url.searchParams.get("code_challenge_method") !== "S256") {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("bad authorization request");
      return true;
    }
    const code = randomBytes(16).toString("hex");
    state.codes.set(code, challenge);
    const back = new URL(callback);
    back.searchParams.set("code", code);
    res.writeHead(302, { Location: back.href }).end();
    return true;
  }

  if (path === "/api/v1/auth/keys" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { code?: string; code_verifier?: string; code_challenge_method?: string };
    if (body.code_challenge_method !== "S256") {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid code_challenge_method" }));
      return true;
    }
    const challenge = body.code ? state.codes.get(body.code) : undefined;
    state.codes.delete(body.code ?? ""); // one-time
    const expected = challenge && body.code_verifier ? createHash("sha256").update(body.code_verifier, "ascii").digest("base64url") : undefined;
    if (!challenge || expected !== challenge) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid code or code_verifier" }));
      return true;
    }
    const key = `sk-or-fake-${randomBytes(12).toString("hex")}`;
    state.keys.add(key);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ key }));
    return true;
  }

  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!state.keys.has(key)) {
    res.writeHead(401, { "Content-Type": "application/json", "x-request-id": "req-fake-401" }).end(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }));
    return true;
  }
  state.attribution = { referer: req.headers["http-referer"] as string | undefined, title: req.headers["x-title"] as string | undefined };

  if (path === "/api/v1/models" && req.method === "GET") {
    const data = ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5", "meta-llama/llama-3.3-70b-instruct:free"].map((id) => ({ id, name: id, context_length: 128000, pricing: { prompt: "0.0000004", completion: "0.0000016" } }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data }));
    return true;
  }

  if (path === "/api/v1/chat/completions" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { model: string; stream?: boolean; messages: Array<{ role: string; content: string }> };
    const last = body.messages[body.messages.length - 1]?.content ?? "";
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.flushHeaders();
    if (last === "cancel me") {
      res.write(chunk(body.model, { role: "assistant", content: "one" }));
      const closed = new Promise<void>((resolve) => res.once("close", resolve));
      if ((await Promise.race([closed.then(() => "closed"), sleep(5000).then(() => "timeout")])) === "closed") state.cancelObserved = true;
      else res.end(chunk(body.model, {}, "stop") + "data: [DONE]\n\n");
      return true;
    }
    // Echo the request's last user text back as the reply, in pieces, with the turn count in usage.
    const pieces = last.split(/(?<= )/);
    for (const [i, piece] of pieces.entries()) {
      res.write(chunk(body.model, i === 0 ? { role: "assistant", content: piece } : { content: piece }));
      await sleep(10);
    }
    res.write(chunk(body.model, {}, "stop", { prompt_tokens: body.messages.length * 5, completion_tokens: pieces.length, total_tokens: body.messages.length * 5 + pieces.length }));
    res.end("data: [DONE]\n\n");
    return true;
  }
  res.writeHead(404).end();
  return true;
}

/**
 * The built page itself — index.html with its CSP and import map, build/main.js,
 * dist/browser.js — loaded in Chromium; the DOM read back must say "Signed out"
 * (the boot ran) and must not say "Loading…" (a CSP or import failure).
 */
async function pageBoot(): Promise<Check> {
  const chromium = findBrowsers().find((b) => b.name === "chromium");
  if (!chromium) return { ok: false, detail: "skipped: no chromium for --dump-dom" };
  if (!existsSync(join(root, "examples/openrouter-page/build/main.js")) || !existsSync(join(root, "dist/browser.js"))) return { ok: false, detail: "skipped: run `npm run build` first" };
  const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const server = createServer((req, res) => {
    let file = resolve(root, "." + new URL(req.url ?? "/", "http://localhost").pathname);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/examples/openrouter-page/`;
  const profile = mkdtempSync(join(tmpdir(), "lm15-smoke-page-"));
  try {
    const { stdout } = await promisify(execFile)(chromium.bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=5000", "--dump-dom", url], { timeout: 30_000, maxBuffer: 4 << 20 });
    const booted = /id="status"[^>]*>Signed out</.test(stdout);
    const stuck = /id="status"[^>]*>Loading…</.test(stdout);
    return { ok: booted && !stuck, detail: booted ? "index.html booted to “Signed out” (CSP, import map, build/main.js, dist/browser.js all load)" : stuck ? "status stayed “Loading…”: a CSP or import failure" : "status not found in the DOM" };
  } catch (e) {
    return { ok: false, detail: String(e) };
  } finally {
    server.close();
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const found = findBrowsers();
  if (found.length === 0) {
    console.error("example smoke: no browser on PATH (looked for chromium, google-chrome, firefox)");
    return 2;
  }
  if (LIVE && !LIVE_KEY) console.error("example smoke: --live given but OPENROUTER_API_KEY is not set; live checks will be reported as skipped");
  let failures = 0;
  const receipts: Array<{ browser: string; report: Report }> = [];
  for (const browser of found) {
    const state: FakeState = { codes: new Map(), keys: new Set(), attribution: undefined, cancelObserved: false };
    const report = await runInBrowser(browser, {
      path: LIVE ? "/example-test?live=1" : "/example-test",
      timeoutMs: LIVE ? 120_000 : 60_000,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/example-test") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
          return true;
        }
        if (url.pathname === "/_smoke/key") {
          if (!LIVE_KEY) res.writeHead(404).end();
          else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ key: LIVE_KEY, model: LIVE_MODEL }));
          return true;
        }
        return fakeOpenRouter(req, res, state);
      },
    });
    const extra: Record<string, Check> = {
      "fake-attribution": { ok: state.attribution?.referer !== undefined && state.attribution?.title === "smoke", detail: `HTTP-Referer=${state.attribution?.referer} X-Title=${state.attribution?.title}` },
      "fake-server-saw-cancel": { ok: state.cancelObserved, detail: "the stream socket closed before the second chunk" },
    };
    failures += printReport(browser.name, report, extra) > 0 ? 1 : 0;
    if (report) receipts.push({ browser: browser.name, report: { ...report, checks: { ...report.checks, ...extra } } });
  }
  const boot = await pageBoot();
  console.log(`page: ${boot.ok ? "ok  " : boot.detail.startsWith("skipped") ? "skip" : "FAIL"} ${boot.detail}`);
  if (!boot.ok && !boot.detail.startsWith("skipped")) failures++;
  if (LIVE_KEY && receipts.length > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(root, "receipts", `${day}-browser-openrouter-live`);
    mkdirSync(dir, { recursive: true });
    const redacted = JSON.stringify({ model: LIVE_MODEL, keySha256Prefix: createHash("sha256").update(LIVE_KEY).digest("hex").slice(0, 12), runs: receipts }, null, 2).replaceAll(LIVE_KEY, "[redacted]");
    writeFileSync(join(dir, "report.json"), redacted + "\n");
    console.log(`receipt: ${dir}/report.json`);
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
