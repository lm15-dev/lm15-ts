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
    let selected = "";
    let expectedKey = "";
    let sent = 0;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      sent++;
      const headers = request.headers();
      const credential = headers["authorization"]?.replace(/^Bearer /, "") ?? headers["x-api-key"] ?? headers["x-goog-api-key"] ?? url.searchParams.get("key");
      assert.equal(credential, expectedKey);
      if (selected === "anthropic") assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
      return route.fulfill({ contentType: "text/event-stream", body: sse(url), headers: { "Access-Control-Allow-Origin": origin } });
    });
    try {
      await page.goto(demo.browserUrl);
      await page.waitForFunction(() => document.getElementById("loaded")?.textContent?.includes("Moonshot"));
      assert.equal(new URL(page.url()).hash, "");
      assert.equal(sent, 0, "Loading keys never sends a provider request");
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      for (const choice of choices) {
        assert.equal((await page.content()).includes(key(choice.id)), false);
        selected = choice.id; expectedKey = key(selected);
        await page.getByLabel("Provider", { exact: true }).selectOption(selected);
        await page.getByLabel("Message", { exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
        assert.equal(await page.locator("#transcript article").last().locator("p").textContent(), "Hello");
      }
      assert.equal(sent, 9);
      await page.getByRole("button", { name: "Forget all keys" }).click();
      assert.equal(await page.locator("#loaded").textContent(), "None");
      selected = "openai"; expectedKey = "manual-dummy-key";
      await page.getByLabel("Provider", { exact: true }).selectOption(selected);
      await page.getByLabel("Your API key", { exact: true }).fill(expectedKey);
      await page.getByRole("button", { name: "Use key for this provider" }).click();
      assert.equal(await page.getByLabel("Your API key", { exact: true }).inputValue(), "");
      await page.getByLabel("Message", { exact: true }).fill("Hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
      assert.equal(sent, 10);
      await page.reload();
      await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("Enter your own"));
      assert.equal(await page.locator("#loaded").textContent(), "None");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); await close(demo.server); }
  });
});
