/**
 * Real browsers, headless, driven by a loopback server: the harness behind
 * `browser_smoke.ts` (the SDK) and `example_smoke.ts` (the example app).
 *
 * One server per browser run serves the repository's `.ts` files as
 * JavaScript (types stripped on the fly, no bundler), plus whatever the
 * caller's handler answers, and collects the page's report at `/report`.
 * Every browser found on PATH runs the page; the caller prints and judges.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Check {
  readonly ok: boolean;
  readonly detail: string;
}

export interface Report {
  readonly userAgent: string;
  readonly checks: Record<string, Check>;
}

export interface Browser {
  readonly name: string;
  readonly bin: string;
  args(url: string, profile: string): string[];
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** `/src/**.ts`, `/tools/**.ts`, `/examples/**.ts` as JavaScript; nothing outside the repository. */
export function serveSource(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!(path.startsWith("/src/") || path.startsWith("/tools/") || path.startsWith("/examples/")) || !path.endsWith(".ts")) return false;
  const file = resolve(root, "." + path);
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return true;
  }
  const code = stripTypeScriptTypes(readFileSync(file, "utf-8"), { mode: "strip" });
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
  res.end(code);
  return true;
}

function onPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(":")) if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  return undefined;
}

export function findBrowsers(): Browser[] {
  const out: Browser[] = [];
  const chromium = onPath("chromium") ?? onPath("chromium-browser") ?? onPath("google-chrome") ?? onPath("google-chrome-stable");
  if (chromium) out.push({ name: "chromium", bin: chromium, args: (url, profile) => ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${profile}`, url] });
  const firefox = onPath("firefox");
  if (firefox) out.push({ name: "firefox", bin: firefox, args: (url, profile) => ["--headless", "--no-remote", "--profile", profile, url] });
  return out;
}

export interface RunOptions {
  /** Answers a request, or returns false to fall through to the source server and 404. Runs once per browser. */
  readonly handler: (req: IncomingMessage, res: ServerResponse, origin: string) => Promise<boolean>;
  /** The path the browser opens. */
  readonly path: string;
  readonly timeoutMs?: number;
}

/** Run the page in one browser: start a server, launch, wait for `/report`, tear down. */
export async function runInBrowser(browser: Browser, opts: RunOptions): Promise<Report | undefined> {
  let resolveReport: (r: Report) => void = () => {};
  const reported = new Promise<Report>((resolve) => (resolveReport = resolve));
  let origin = "";
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/report" && req.method === "POST") {
        const report = JSON.parse(await readBody(req)) as Report;
        res.writeHead(204).end();
        resolveReport(report);
      } else if (await opts.handler(req, res, origin)) {
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
  origin = `http://127.0.0.1:${port}`;
  const profile = mkdtempSync(join(tmpdir(), `lm15-smoke-${browser.name}-`));
  let child: ChildProcess | undefined;
  try {
    child = spawn(browser.bin, browser.args(origin + opts.path, profile), { stdio: "ignore", env: { ...process.env, MOZ_HEADLESS: "1" } });
    return await Promise.race([reported, sleep(opts.timeoutMs ?? 60_000).then(() => undefined)]);
  } finally {
    child?.kill("SIGKILL");
    server.close();
    await sleep(200); // Chromium keeps writing to the profile briefly after SIGKILL
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Print a report; return the number of failed checks. */
export function printReport(name: string, report: Report | undefined, extra: Record<string, Check> = {}): number {
  if (!report) {
    console.error(`${name}: no report (timed out)`);
    return 1;
  }
  const checks = { ...report.checks, ...extra };
  console.log(`${name}: ${report.userAgent}`);
  let failed = 0;
  for (const [key, c] of Object.entries(checks)) {
    console.log(`  ${c.ok ? "ok  " : c.detail.startsWith("skipped") ? "skip" : "FAIL"} ${key}: ${c.detail}`);
    if (!c.ok && !c.detail.startsWith("skipped")) failed++;
  }
  return failed;
}
