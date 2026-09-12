/** Test the exact static artifact, or SITE_URL's deployed copy, with dummy credentials. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { findBrowsers } from "./headless.ts";
import { siteDir } from "./package_site.ts";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".whl": "application/zip", ".zip": "application/zip", ".txt": "text/plain" };

test("the published static files boot, keep keys private, and run all three SDKs", { timeout: 240_000 }, async () => {
  const installed = findBrowsers().find((browser) => browser.name === "chromium");
  assert.ok(installed, "Chromium is required; a release must not silently skip browser tests");
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = resolve(siteDir, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(siteDir + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = process.env["SITE_URL"] ?? `http://127.0.0.1:${address.port}/`;
  const origin = new URL(url).origin;
  const browser = await chromium.launch({ executablePath: installed.bin });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  const badResponses: string[] = [];
  const assetRequests: string[] = [];
  const calls: Array<{ body: string; auth: string | undefined }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (target.origin === origin) { assetRequests.push(target.pathname); return route.continue(); }
    if (target.href === "https://api.openai.com/v1/models" && request.method() === "GET") {
      assert.equal(request.headers()["authorization"], "Bearer dummy-static-site-key");
      return route.fulfill({ json: { data: [{ id: "gpt-4.1-mini" }] } });
    }
    assert.equal(target.href, "https://api.openai.com/v1/responses", "No third-party scripts, CDN, analytics, or credential upload");
    assert.equal(request.method(), "POST");
    calls.push({ body: request.postData() ?? "", auth: request.headers()["authorization"] });
    const frames = [
      { type: "response.created", response: { id: "static-test", model: "gpt-4.1-mini" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Static site works." },
      { type: "response.completed", response: { id: "static-test", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
    ];
    return route.fulfill({ contentType: "text/event-stream", body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") });
  });
  try {
    const response = await page.goto(url);
    assert.equal(response?.status(), 200);
    if (process.env["SITE_URL"]) assert.equal(new URL(page.url()).protocol, "https:", "Live verification must use real HTTPS, not ignore certificate errors");
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
    assert.equal(await page.locator("#settings").isVisible(), true);
    assert.equal(assetRequests.some((path) => /\.wasm$|\.whl$/.test(path)), false, "No wasm download until a runtime is selected");
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-static-site-key");
    await page.getByLabel("Remember on this device").check();
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent?.includes("remembered"));
    await page.getByLabel("System prompt").fill("Answer briefly.");
    await page.getByLabel("Max tokens").fill("48");
    for (const runtime of ["JavaScript", "Python", "Rust"]) {
      await page.getByLabel(runtime, { exact: true }).check();
      if (runtime !== "JavaScript") await page.waitForFunction((name) => document.getElementById("runtime-status")?.textContent?.startsWith(`${name} ready`), runtime, { timeout: 120_000 });
      await page.getByLabel("Message", { exact: true }).fill(`Hello from ${runtime}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction((name) => document.getElementById("usage")?.textContent?.endsWith(name), runtime, { timeout: 30_000 });
      assert.equal(await page.locator("#transcript article").last().locator("p").textContent(), "Static site works.");
    }
    await page.waitForFunction(() => document.getElementById("fidelity")?.textContent?.includes("Same request bytes from JavaScript, Python, Rust"));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.auth, "Bearer dummy-static-site-key");
      const body = JSON.parse(call.body);
      assert.equal(body.instructions, "Answer briefly.");
      assert.equal(body.max_output_tokens, 48);
    }
    assert.deepEqual(JSON.parse(calls[2]!.body).input.map((message: { role: string }) => message.role), ["user", "assistant", "user", "assistant", "user"]);
    for (const tab of ["JavaScript", "Python", "Rust", "JSON", "curl"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForFunction(() => (document.getElementById("code")?.textContent?.length ?? 0) > 30);
      assert.ok(!(await page.locator("#code").textContent())?.includes("dummy-static-site-key"));
    }
    const releaseResponse = await page.request.get(new URL("release.json", url).href);
    assert.equal(releaseResponse.status(), 200);
    const manifest = await releaseResponse.json() as { release: string; files: Record<string, string> };
    assert.match(manifest.release, /^[a-f0-9]{20}$/);
    for (const path of assetRequests) assert.ok(path === "/" || path.startsWith(`/assets/${manifest.release}/`), `Unexpected or unversioned asset ${path}`);
    for (const name of ["vendor/rust/lm15.wasm", "vendor/python/lm15.whl", "vendor/pyodide/pyodide.asm.wasm"]) {
      const result = await page.request.get(new URL(`/assets/${manifest.release}/${name}`, url).href);
      assert.equal(result.status(), 200);
      assert.equal(createHash("sha256").update(await result.body()).digest("hex"), manifest.files[name], `Published ${name} matches the release manifest`);
    }
    for (const path of ["/.env", "/__lm15_test_credentials", "/tools/provider_demo.ts", "/.git/config"]) assert.equal((await page.request.get(new URL(path, url).href)).status(), 404, `${path} is not published`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent?.includes("remembered"));
    // Reload restores the key; immediately disable discovery again before further tests.
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByRole("button", { name: "Forget this key" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("link", { name: "Privacy, licenses & hosting" }).click();
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Privacy and hosting");
    for (const href of await page.locator('a[href^="/assets/"]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))) {
      assert.equal((await page.request.get(href)).status(), 200, `License notice exists: ${href}`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(badResponses, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
