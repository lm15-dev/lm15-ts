/** Provider-neutral UI and private credential handoff. Only dummy keys and intercepted traffic. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CONNECTIONS } from "../examples/provider-page/connections.ts";
import { startDemo } from "./provider_demo.ts";
import { findBrowsers } from "./headless.ts";

const choices = CONNECTIONS.filter((c) => c.env);
const key = (id: string) => `dummy-${id}-key`;
async function fixture(run: (envFile: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "lm15-provider-ui-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, choices.map((c) => `export ${c.env}="${key(c.id)}"`).join("\n") + '\nUNRELATED_PASSWORD="never-transfer"\n', { mode: 0o600 });
    await run(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function close(server: Awaited<ReturnType<typeof startDemo>>["server"]) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((e) => e ? reject(e) : done()));
}

test("private test keys require an opted-in, same-origin, one-use capability; files are not exposed", async () => {
  await fixture(async (envFile) => {
    const demo = await startDemo({ envFile });
    try {
      const url = new URL("/__lm15_test_credentials", demo.url);
      const token = new URLSearchParams(new URL(demo.browserUrl).hash.slice(1)).get("local-test")!;
      const headers = { "X-LM15-Test-Token": token };
      assert.equal((await fetch(url)).status, 403);
      assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://other.example" } })).status, 403);
      const wrongHostStatus = await new Promise<number | undefined>((done, reject) => {
        const req = httpRequest(url, { headers: { ...headers, Host: "other.example" } }, (res) => { res.resume(); done(res.statusCode); });
        req.on("error", reject); req.end();
      });
      assert.equal(wrongHostStatus, 403);
      assert.equal((await fetch(url, { headers: { "X-LM15-Test-Token": "é".repeat(token.length) } })).status, 403);
      assert.equal((await fetch(new URL("/.env", demo.url))).status, 404);
      assert.equal((await fetch(new URL("/package.json", demo.url))).status, 404);
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(await response.json(), Object.fromEntries(choices.map((c) => [c.id, key(c.id)])));
      assert.equal((await fetch(url, { headers })).status, 403);
    } finally { await close(demo.server); }
    const plain = await startDemo();
    try {
      assert.equal(plain.browserUrl, plain.url);
      assert.equal((await fetch(new URL("/__lm15_test_credentials", plain.url))).status, 403);
    } finally { await close(plain.server); }
  });
});

test("discovery failures and stale provider replies cannot block manual model selection or leak into the new connection", { timeout: 60_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  await fixture(async (envFile) => {
    const demo = await startDemo({ envFile });
    const browser = await chromium.launch({ executablePath: installed.bin });
    const page = await browser.newPage();
    let release = () => {};
    const delayed = new Promise<void>((done) => { release = done; });
    let signalStarted = () => {};
    const started = new Promise<void>((done) => { signalStarted = done; });
    let lists = 0;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(demo.url).origin) return route.continue();
      assert.equal(route.request().method(), "GET", "Commands and discovery must never infer");
      lists++;
      if (url.hostname === "api.openai.com") {
        signalStarted(); await delayed;
        return route.fulfill({ json: { data: [{ id: "stale-openai-model" }] } });
      }
      return route.fulfill({ status: 503, json: { error: { message: "Test discovery failure" } } });
    });
    try {
      await page.goto(demo.browserUrl);
      await started;
      await page.getByLabel("Message", { exact: true }).fill("/provider anth");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      await page.waitForFunction(() => document.getElementById("model-status")?.textContent?.startsWith("Model discovery failed"));
      await page.getByLabel("Message", { exact: true }).fill("/model manual-model");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      assert.equal(await page.locator("#model-name").textContent(), "manual-model");
      const replied = page.waitForResponse((response) => new URL(response.url()).hostname === "api.openai.com");
      release(); await replied;
      await page.getByRole("button", { name: "Choose model", exact: true }).click();
      assert.match(await page.locator("#picker-status").textContent() ?? "", /Model discovery failed/);
      assert.equal(await page.locator("#picker-results").getByText("stale-openai-model", { exact: true }).count(), 0);
      await page.getByRole("combobox", { name: "Search choices" }).press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Automatically discover model IDs").uncheck();
      await page.getByRole("button", { name: "Close settings" }).click();
      await page.getByLabel("Message", { exact: true }).fill("/provider groq");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      await page.getByRole("button", { name: "Choose model", exact: true }).click();
      await page.getByRole("combobox", { name: "Search choices" }).fill("custom-on-groq");
      await page.getByRole("combobox", { name: "Search choices" }).press("Enter");
      assert.equal(lists, 2, "Discovery stays off while typing and picking");
      await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
      await page.getByRole("button", { name: "Choose provider", exact: true }).click();
      await page.getByRole("combobox", { name: "Search choices" }).press("ArrowDown");
      await page.getByRole("combobox", { name: "Search choices" }).press("Escape");
      assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Keep this draft");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal page overflow on mobile");
    } finally { release(); await browser.close(); await close(demo.server); }
  });
});

function sse(url: URL): string {
  let frames: unknown[];
  if (url.pathname.endsWith("/responses")) {
    frames = [
      { type: "response.created", response: { id: "r", model: "test-model" } },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ];
  } else if (url.pathname.endsWith("/messages")) {
    frames = [
      { type: "message_start", message: { id: "r", model: "test-model", usage: { input_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  } else if (url.pathname.includes("streamGenerateContent")) {
    frames = [{ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }];
  } else {
    assert.ok(url.pathname.endsWith("/chat/completions"));
    frames = [
      { id: "r", model: "test-model", choices: [{ delta: { role: "assistant", content: "Hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ];
  }
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

test("nine local keys load privately; each provider receives only its key; manual keys, clearing, and reload work", { timeout: 120_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed, "Put Chromium on PATH to run browser tests");
  await fixture(async (envFile) => {
    const demo = await startDemo({ envFile });
    const browser = await chromium.launch({ executablePath: installed.bin });
    const page = await browser.newPage();
    const origin = new URL(demo.url).origin;
    let selected = "openai";
    let expectedKey = key(selected);
    let sent = 0;
    let modelLists = 0;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      const headers = request.headers();
      const credential = headers["authorization"]?.replace(/^Bearer /, "") ?? headers["x-api-key"] ?? headers["x-goog-api-key"] ?? url.searchParams.get("key");
      assert.equal(credential, expectedKey);
      if (selected === "anthropic") assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
      if (request.method() === "GET") {
        modelLists++;
        return route.fulfill({ json: { data: [{ id: "model-one" }, { id: "model-two" }], models: [{ name: "models/model-one" }, { name: "models/model-two" }] }, headers: { "Access-Control-Allow-Origin": origin } });
      }
      sent++;
      return route.fulfill({ contentType: "text/event-stream", body: sse(url), headers: { "Access-Control-Allow-Origin": origin } });
    });
    try {
      await page.goto(demo.browserUrl);
      await page.waitForFunction(() => document.getElementById("loaded")?.textContent?.includes("Moonshot"));
      assert.equal(new URL(page.url()).hash, "");
      assert.equal(sent, 0, "Loading keys never starts inference");
      await page.waitForFunction(() => document.getElementById("model-status")?.textContent?.includes("model IDs listed"));
      assert.equal(modelLists, 1, "Only the selected connection is discovered");
      assert.equal(await page.locator("#settings").isVisible(), false);
      assert.match(await page.locator("#code").textContent() ?? "", /YOUR_API_KEY/);
      await page.emulateMedia({ colorScheme: "light" });
      const readability = await page.evaluate(() => {
        const luminance = (color: string) => {
          const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
        };
        const code = getComputedStyle(document.getElementById("code")!);
        const background = luminance(getComputedStyle(document.querySelector(".code-panel")!).backgroundColor);
        const foreground = luminance(code.color);
        return { size: parseFloat(code.fontSize), background, contrast: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) };
      });
      assert.ok(readability.size >= 16, "Code text must not shrink below 16px at default zoom");
      assert.ok(readability.background > 0.9, "Use a light code background in light mode");
      assert.ok(readability.contrast >= 7, "Code text must have at least 7:1 contrast");
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      for (const choice of choices) {
        assert.equal((await page.content()).includes(key(choice.id)), false);
        selected = choice.id; expectedKey = key(selected);
        await page.getByRole("button", { name: "Choose provider", exact: true }).click();
        await page.getByRole("combobox", { name: "Search choices" }).fill(selected);
        await page.getByRole("combobox", { name: "Search choices" }).press("Enter");
        await page.waitForFunction(() => document.getElementById("model-status")?.textContent?.includes("model IDs listed"));
        await page.getByLabel("Message", { exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
        assert.equal(await page.locator("#transcript article").last().locator("p").textContent(), "Hello");
      }
      assert.equal(sent, 9);
      const discoveries = modelLists;
      await page.getByLabel("Message", { exact: true }).fill("/model mdltw");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      assert.equal(await page.locator("#model-name").textContent(), "model-two");
      assert.equal(sent, 9, "A slash command is never sent as a message");
      assert.equal(modelLists, discoveries, "Searching models uses the cached list");
      assert.match(await page.locator("#code").textContent() ?? "", /model-two/);
      await page.getByRole("button", { name: "Choose model", exact: true }).click();
      await page.getByRole("combobox", { name: "Search choices" }).fill("my-custom-model-id");
      await page.getByRole("combobox", { name: "Search choices" }).press("Enter");
      assert.equal(await page.locator("#model-name").textContent(), "my-custom-model-id");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Forget all keys" }).click();
      assert.equal(await page.locator("#loaded").textContent(), "None");
      await page.getByRole("button", { name: "Close settings" }).click();
      selected = "openai"; expectedKey = "manual-dummy-key";
      await page.getByLabel("Message", { exact: true }).fill("/provider opnai");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      assert.equal(await page.locator("#provider-name").textContent(), "OpenAI");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("API key", { exact: true }).fill(expectedKey);
      await page.getByRole("button", { name: "Use key for this provider" }).click();
      assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
      await page.getByLabel("Message", { exact: true }).fill("Hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
      assert.equal(sent, 10);
      await page.reload();
      await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
      assert.equal(await page.locator("#loaded").textContent(), "None");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await close(demo.server); }
  });
});
