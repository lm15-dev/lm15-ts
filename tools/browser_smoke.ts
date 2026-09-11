#!/usr/bin/env node
/**
 * The web entry in real browsers. Starts one server on the loopback that
 * (a) serves this repository's `.ts` files as JavaScript, types stripped
 * on the fly, so a page imports `/src/browser.ts` straight from source with
 * no bundler; (b) plays a fake Chat Completions door under `/api`,
 * complete and streamed, with a slow stream the page cancels mid-way;
 * (c) collects the page's report. Then launches every browser found on
 * PATH — Chromium and Firefox — headless, one after the other, and prints
 * each report. Exits non-zero if any check fails, if a browser never
 * reports, or if no browser was found.
 *
 * Run: `npm run test:browser`. Not part of `npm test`: it needs browsers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_TIMEOUT_MS = 60_000;

interface Report {
  readonly userAgent: string;
  readonly checks: Record<string, { ok: boolean; detail: string }>;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>lm15 browser smoke</title><body><script type="module" src="/tools/browser_page.ts"></script>`;

function chunkJson(model: string, delta: Record<string, unknown>, finish?: string, usage?: Record<string, number>): string {
  const frame: Record<string, unknown> = { id: "chatcmpl-smoke", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
  if (usage) frame["usage"] = usage;
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The fake door. Returns true when the request was for it. */
async function fakeDoor(req: IncomingMessage, res: ServerResponse, state: { cancelObserved: boolean }): Promise<boolean> {
  if (req.url !== "/api/chat/completions" || req.method !== "POST") return false;
  const body = JSON.parse(await readBody(req)) as { model: string; stream?: boolean; messages: Array<{ content: string }> };
  if (req.headers.authorization !== "Bearer page-key") {
    res.writeHead(401, { "Content-Type": "application/json", "x-request-id": "req-smoke-401" });
    res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
    return true;
  }
  const prompt = body.messages[0]?.content ?? "";
  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Hello, page." }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
    return true;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.flushHeaders();
  if (prompt === "cancel me") {
    // First chunk now; the page aborts; the socket closes before the second chunk is due.
    res.write(chunkJson(body.model, { role: "assistant", content: "first" }));
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    const result = await Promise.race([closed.then(() => "closed"), sleep(5000).then(() => "timeout")]);
    if (result === "closed") state.cancelObserved = true;
    else res.end(chunkJson(body.model, {}, "stop") + "data: [DONE]\n\n");
    return true;
  }
  for (const piece of ["Hello,", " streamed", " page."]) {
    res.write(chunkJson(body.model, piece === "Hello," ? { role: "assistant", content: piece } : { content: piece }));
    await sleep(20);
  }
  res.write(chunkJson(body.model, {}, "stop", { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 }));
  res.end("data: [DONE]\n\n");
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Serve `/src/**.ts` and `/tools/**.ts` as JavaScript; nothing outside the repository. */
function serveSource(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!(url.pathname.startsWith("/src/") || url.pathname.startsWith("/tools/")) || !url.pathname.endsWith(".ts")) return false;
  const file = resolve(root, "." + url.pathname);
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return true;
  }
  const code = stripTypeScriptTypes(readFileSync(file, "utf-8"), { mode: "strip" });
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
  res.end(code);
  return true;
}

interface Browser {
  readonly name: string;
  readonly bin: string;
  args(url: string, profile: string): string[];
}

function onPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(":")) if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  return undefined;
}

function browsers(): Browser[] {
  const out: Browser[] = [];
  const chromium = onPath("chromium") ?? onPath("chromium-browser") ?? onPath("google-chrome") ?? onPath("google-chrome-stable");
  if (chromium) out.push({ name: "chromium", bin: chromium, args: (url, profile) => ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url] });
  const firefox = onPath("firefox");
  if (firefox) out.push({ name: "firefox", bin: firefox, args: (url, profile) => ["--headless", "--no-remote", "--profile", profile, url] });
  return out;
}

async function main(): Promise<number> {
  const found = browsers();
  if (found.length === 0) {
    console.error("browser smoke: no browser on PATH (looked for chromium, google-chrome, firefox)");
    return 2;
  }
  let failures = 0;
  for (const browser of found) {
    const state = { cancelObserved: false };
    let resolveReport: (r: Report) => void = () => {};
    const reported = new Promise<Report>((resolve) => (resolveReport = resolve));
    const server = createServer((req, res) => {
      void (async () => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
        } else if (req.url === "/report" && req.method === "POST") {
          const report = JSON.parse(await readBody(req)) as Report;
          res.writeHead(204).end();
          resolveReport(report);
        } else if (await fakeDoor(req, res, state)) {
          // handled
        } else if (!serveSource(req, res)) res.writeHead(404).end();
      })().catch((e) => {
        console.error("smoke server:", e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/`;
    const profile = mkdtempSync(join(tmpdir(), `lm15-smoke-${browser.name}-`));
    let child: ChildProcess | undefined;
    try {
      child = spawn(browser.bin, browser.args(url, profile), { stdio: "ignore", env: { ...process.env, MOZ_HEADLESS: "1" } });
      const report = await Promise.race([reported, sleep(REPORT_TIMEOUT_MS).then(() => undefined)]);
      if (!report) {
        console.error(`${browser.name}: no report within ${REPORT_TIMEOUT_MS / 1000}s`);
        failures++;
        continue;
      }
      const checks = { ...report.checks, "server-saw-cancel": { ok: state.cancelObserved, detail: "the stream socket closed before the second chunk" } };
      const bad = Object.entries(checks).filter(([, c]) => !c.ok);
      console.log(`${browser.name}: ${report.userAgent}`);
      for (const [name, c] of Object.entries(checks)) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${name}: ${c.detail}`);
      if (bad.length > 0) failures++;
    } finally {
      child?.kill("SIGKILL");
      server.close();
      // Chromium keeps writing to the profile briefly after SIGKILL.
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    }
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
