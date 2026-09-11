/** Exercise the shipped page, not just its logic modules. All provider traffic is intercepted. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { findBrowsers, root } from "./headless.ts";

const KEY = "ui-test-key-not-a-real-credential";
let server: ChildProcess;
let browser: Browser;
let origin: string;
let address: string;

before(async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed, "Install Chromium or put it on PATH before running the UI tests");
  server = spawn(process.execPath, ["--experimental-strip-types", "tools/serve.ts", "examples/openrouter-page/"], {
    cwd: root, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  address = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Static server did not start")), 10_000);
    server.on("error", (error) => { clearTimeout(timer); reject(error); });
    server.on("exit", () => { clearTimeout(timer); reject(new Error("Static server exited")); });
    server.stdout!.on("data", (chunk) => {
      output += String(chunk);
      const url = output.match(/http:\/\/localhost:\d+\/examples\/openrouter-page\//)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    });
  });
  origin = new URL(address).origin;
  browser = await chromium.launch({ executablePath: installed.bin, headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
});

interface Options {
  rememberedKey?: string;
  rejectExchange?: boolean;
  rejectKey?: boolean;
}

async function withPage(options: Options, run: (page: Page, requests: string[]) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const unexpected: string[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  let challenge: string | null = null;
  const json = (route: Route, status: number, value: unknown) => route.fulfill({
    status, contentType: "application/json", body: JSON.stringify(value),
    headers: { "Access-Control-Allow-Origin": origin },
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== "https://openrouter.ai") {
      unexpected.push(request.url());
      return route.abort();
    }
    requests.push(url.pathname);
    if (url.pathname === "/auth") {
      assert.equal(url.searchParams.get("callback_url"), address);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      challenge = url.searchParams.get("code_challenge");
      assert.match(challenge ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(url.searchParams.has("code_verifier"), false);
      return route.fulfill({ contentType: "text/html", body: "<h1>Simulated authorization page</h1>" });
    }
    if (url.pathname === "/api/v1/auth/keys") {
      const body = request.postDataJSON() as { code: string; code_verifier: string; code_challenge_method: string };
      assert.equal(body.code, "test-code");
      assert.equal(body.code_challenge_method, "S256");
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
      return options.rejectExchange ? json(route, 403, { error: "Invalid code" }) : json(route, 200, { key: KEY });
    }
    if (url.pathname === "/api/v1/auth/key") {
      assert.equal(request.headers()["authorization"], `Bearer ${options.rememberedKey ?? KEY}`);
      return options.rejectKey ? json(route, 401, { error: "Invalid key" }) : json(route, 200, {
        data: { label: "Test connection", usage: 0, limit: 5, limit_remaining: 5, is_free_tier: false },
      });
    }
    if (url.pathname === "/api/v1/models") {
      return json(route, 200, { data: [{ id: "openai/gpt-4.1-mini" }] });
    }
    unexpected.push(request.url());
    return route.abort();
  });
  if (options.rememberedKey) {
    await context.addInitScript(({ key }) => {
      if (!sessionStorage.getItem("ui-test-seeded")) {
        localStorage.setItem("lm15-example.openrouter-key", key);
        sessionStorage.setItem("ui-test-seeded", "1");
      }
    }, { key: options.rememberedKey });
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await run(page, requests);
    assert.deepEqual(errors, [], "No uncaught page errors");
    assert.deepEqual(unexpected, [], "No unplanned provider calls");
  } finally {
    await context.close();
  }
}

async function signedOut(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Sign in with OpenRouter", exact: true });
  await button.waitFor({ state: "visible" });
  assert.equal(await button.isEnabled(), true);
  assert.equal(await page.locator("#signed-in").isVisible(), false);
  assert.equal(await page.locator("#status").textContent(), "Signed out");
}

async function authorize(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign in with OpenRouter", exact: true }).click();
  await page.waitForURL((url) => url.origin === "https://openrouter.ai" && url.pathname === "/auth");
  // The external consent screen is simulated. Return to the actual application's callback.
  await page.goto(`${address}?code=test-code`);
}

test("fresh visit exposes the login button and key-entry controls", async () => {
  await withPage({}, async (page, requests) => {
    await page.goto(address);
    await signedOut(page);
    await page.getByText("Or paste a key you already have", { exact: true }).click();
    assert.equal(await page.locator("#paste-key").isVisible(), true);
    assert.equal(await page.locator("#remember").isVisible(), true);
    assert.deepEqual(requests, [], "Opening the page does not contact a provider");
  });
});

test("the real login button starts PKCE; callback opens chat; Forget restores login", async () => {
  await withPage({}, async (page, requests) => {
    await page.goto(address);
    await signedOut(page);
    await page.locator("#remember").check();
    await authorize(page);
    await page.getByRole("button", { name: "Forget key", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#model-count")?.textContent === "1 models");
    assert.equal(new URL(page.url()).search, "", "Authorization code is removed from the address");
    assert.equal(await page.locator("#signed-out").isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("lm15-example.openrouter-key")), KEY);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("lm15-example.pkce-verifier")), null);
    assert.ok(requests.includes("/auth") && requests.includes("/api/v1/auth/keys"));
    await page.getByRole("button", { name: "Forget key", exact: true }).click();
    await signedOut(page);
    assert.equal(await page.evaluate(() => localStorage.getItem("lm15-example.openrouter-key")), null);
  });
});

test("a stray callback leaves a visible way to restart login", async () => {
  await withPage({}, async (page, requests) => {
    await page.goto(`${address}?code=stray`);
    await signedOut(page);
    assert.match(await page.locator("#alert").textContent() ?? "", /no login in progress/);
    assert.deepEqual(requests, [], "No verifier means no code exchange");
  });
});

test("a refused code exchange restores the login controls and displays the error", async () => {
  await withPage({ rejectExchange: true }, async (page) => {
    await page.goto(address);
    await signedOut(page);
    await authorize(page);
    await signedOut(page);
    assert.match(await page.locator("#alert").textContent() ?? "", /403/);
  });
});

test("a revoked remembered key restores visible login controls", async () => {
  await withPage({ rememberedKey: KEY, rejectKey: true }, async (page) => {
    await page.goto(address);
    await signedOut(page);
    assert.match(await page.locator("#alert").textContent() ?? "", /remembered key was dropped.*401/);
    assert.equal(await page.evaluate(() => localStorage.getItem("lm15-example.openrouter-key")), null);
  });
});
