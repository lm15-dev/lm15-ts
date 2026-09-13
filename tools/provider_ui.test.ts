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
      assert.equal(await page.locator("#settings").isVisible(), true);
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
      await page.waitForFunction(() => document.getElementById("loaded")?.textContent === "None");
      selected = "openai"; expectedKey = "manual-dummy-key";
      await page.getByLabel("Message", { exact: true }).fill("/provider opnai");
      await page.getByLabel("Message", { exact: true }).press("Enter");
      assert.equal(await page.locator("#provider-name").textContent(), "OpenAI");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("API key", { exact: true }).fill(expectedKey);
      await page.getByRole("button", { name: "Use key for this provider" }).click();
      await page.waitForFunction(() => (document.getElementById("key") as HTMLInputElement).value === "" && document.getElementById("key-state")?.textContent === "Key ready (this tab)");
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

/** A streamed reply of the right dialect for the URL: what the fake provider answers every runtime with. */
function replyFor(url: URL): string {
  let frames: unknown[];
  if (url.pathname.endsWith("/responses")) frames = [
    { type: "response.created", response: { id: "r", model: "gpt-4.1-mini" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello " },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "there." },
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ];
  else frames = [{ id: "r", model: "m", choices: [{ delta: { role: "assistant", content: "Hello there." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (url.pathname.endsWith("/responses") ? "" : "data: [DONE]\n\n");
}

test("the playground: settings reach the code and the wire; a remembered key survives a reload encrypted; the key page is the registry's", { timeout: 120_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bodies: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(demo.url).origin) return route.continue();
    if (route.request().method() === "POST") bodies.push(route.request().postData() ?? "");
    return route.fulfill({ contentType: "text/event-stream", body: replyFor(url), headers: { "Access-Control-Allow-Origin": new URL(demo.url).origin } });
  });
  try {
    await page.goto(demo.url);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(await page.locator("#get-key").getAttribute("href"), "https://platform.openai.com/api-keys", "the key page comes from the registry");
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-openai-key");
    await page.getByLabel("Remember on this device").check();
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("System prompt").fill("Answer briefly.");
    await page.getByLabel("Max tokens").fill("64");
    await page.getByLabel("Reasoning effort").selectOption("low");
    for (const [tab, expected] of [["JavaScript", /system: "Answer briefly\."[\s\S]*maxTokens: 64[\s\S]*reasoning: \{ effort: "low" \}/], ["Python", /system="Answer briefly\."[\s\S]*Config\(max_tokens=64, reasoning=Reasoning\(effort="low"\)\)/], ["Rust", /system: Some\("Answer briefly\."\.into\(\)\)[\s\S]*Reasoning::new\("low"\.parse\(\)\?\)/], ["JSON", /"instructions": "Answer briefly\."[\s\S]*"max_output_tokens": 64[\s\S]*"reasoning": \{\s*"effort": "low"/], ["curl", /curl -X POST 'https:\/\/api\.openai\.com\/v1\/responses'[\s\S]*Bearer YOUR_API_KEY/]] as const) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForFunction((pattern) => new RegExp(pattern, "s").test(document.getElementById("code")?.textContent ?? ""), expected.source);
      assert.ok(!(await page.locator("#code").textContent())!.includes("dummy-openai-key"), `${tab}: the key never appears in the code panel`);
    }
    await page.getByLabel("Message", { exact: true }).fill("hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
    assert.equal(bodies.length, 1);
    const sent = JSON.parse(bodies[0]!) as { instructions: string; max_output_tokens: number; reasoning: { effort: string } };
    assert.equal(sent.instructions, "Answer briefly.");
    assert.equal(sent.max_output_tokens, 64);
    assert.equal(sent.reasoning.effort, "low");
    assert.equal(await page.locator("#transcript article").last().locator("p").textContent(), "Hello there.");
    // Encrypted at rest: the stored record is not the key; a reload decrypts it back.
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("lm15-playground"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const rows = await new Promise<Array<{ provider: string; ciphertext: ArrayBuffer }>>((resolve, reject) => { const r = db.transaction("keys").objectStore("keys").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return rows.map((row) => ({ provider: row.provider, text: new TextDecoder().decode(row.ciphertext) }));
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.provider, "openai");
    assert.ok(!stored[0]!.text.includes("dummy-openai-key"), "the stored record is ciphertext");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Key ready (remembered on this device)");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Forget this key" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Add key in Settings");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await close(demo.server); }
});

test("settings stay beside the live code; defaults and invalid inputs stay honest", { timeout: 60_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const bodies: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(demo.url).origin) return route.continue();
    assert.equal(route.request().method(), "POST", "Editing settings must not call a provider");
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({ contentType: "text/event-stream", body: replyFor(url) });
  });
  try {
    await page.goto(demo.url);
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-settings-key");
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Key ready (this tab)");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const tab of ["JavaScript", "Python", "Rust", "JSON", "curl"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      const text = `Changed in ${tab}`;
      await page.getByLabel("System prompt").fill(text);
      await page.waitForFunction((text) => document.getElementById("code")?.textContent?.includes(text), text);
      assert.equal(await page.locator(":modal").count(), 0, "No overlay hides the code");
      assert.ok(await page.evaluate(() => {
        const setting = document.getElementById("system")!.getBoundingClientRect();
        const code = document.getElementById("code")!.getBoundingClientRect();
        return setting.top >= 0 && setting.bottom < innerHeight && code.top >= 0 && code.top < innerHeight && setting.right < code.left;
      }), "Setting and changed code are visible together");
    }
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    await page.getByLabel("Max tokens").fill("72");
    await page.getByLabel("Reasoning effort").selectOption("low");
    const slider = page.getByLabel("Temperature", { exact: false });
    await slider.focus();
    await slider.press("Home"); // zero is an explicit value, not the unset/default state
    await page.waitForFunction(() => {
      try {
        const body = JSON.parse(document.getElementById("code")!.textContent!);
        return body.temperature === 0 && body.max_output_tokens === 72 && body.reasoning.effort === "low";
      } catch { return false; }
    });
    await page.getByRole("button", { name: "Use provider default" }).click();
    await page.getByLabel("Reasoning effort").selectOption("");
    await page.waitForFunction(() => {
      try {
        const body = JSON.parse(document.getElementById("code")!.textContent!);
        return !("temperature" in body) && !("reasoning" in body);
      } catch { return false; }
    });
    await page.getByLabel("Message", { exact: true }).fill("hello");
    for (const invalid of ["", "0", "1.5", "100001"]) {
      await page.getByLabel("Max tokens").fill(invalid);
      assert.match(await page.locator("#code").textContent() ?? "", /Max tokens must be a whole number/);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      assert.equal(bodies.length, 0, "Never replace an invalid setting with an invisible default");
    }
    await page.getByLabel("Max tokens").fill("72");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("usage")?.textContent?.startsWith("stop"));
    assert.equal(bodies.length, 1);
    const body = JSON.parse(bodies[0]!);
    assert.equal(body.max_output_tokens, 72);
    assert.equal(body.instructions, "Changed in curl");
    assert.equal("temperature" in body, false);
    assert.equal("reasoning" in body, false);
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      assert.ok(await page.evaluate(() => document.activeElement?.id === "system"));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
      await page.getByLabel("System prompt").fill(`Width ${width}`);
      await page.waitForFunction((width) => document.getElementById("code")?.textContent?.includes(`Width ${width}`), width);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await close(demo.server); }
});

test("workspace design: guided setup, safe code coloring, copying, reset and small-screen navigation", { timeout: 90_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(demo.url).origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let externalRequests = 0;
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === new URL(demo.url).origin) return route.continue();
    externalRequests++; return route.abort();
  });
  try {
    await page.goto(demo.url);
    assert.equal(await page.locator("#send").isDisabled(), true);
    await page.getByRole("button", { name: /Explain something/ }).click();
    const draft = await page.locator("#prompt").inputValue();
    assert.match(draft, /sky is blue/);
    assert.equal(externalRequests, 0, "Starting prompts do not send or load a provider");
    await page.locator("#send").click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "key");
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    assert.equal(await page.locator("#transcript article").count(), 0, "Missing-key setup preserves the draft without creating a failed turn");
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-design-key");
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Key ready (this tab)");
    assert.equal(await page.locator("#start-setup").isVisible(), false);
    await page.getByLabel("System prompt").fill('<script>window.hacked=true</script> <img src=x onerror=alert(1)> dummy-design-key');
    assert.equal(await page.locator("#code script, #code img").count(), 0);
    assert.ok(await page.locator("#code .token-string").count() > 0);
    assert.ok(!(await page.locator("#code").textContent())?.includes("dummy-design-key"));
    const code = await page.locator("#code").textContent();
    await page.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code, "Copied text has no line numbers or styling markup");
    assert.match(await page.locator("#copy-code").textContent() ?? "", /Copied/);
    await page.getByLabel("Max tokens").fill("64");
    await page.getByLabel("Reasoning effort").selectOption("low");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    assert.equal(await page.getByLabel("System prompt").inputValue(), "");
    assert.equal(await page.getByLabel("Max tokens").inputValue(), "400");
    assert.equal(await page.getByLabel("Reasoning effort").inputValue(), "");
    assert.equal(await page.locator("#prompt").inputValue(), draft, "Reset settings does not erase the draft or key");
    assert.match(await page.locator("#key-state").textContent() ?? "", /Key ready/);
    await page.getByRole("button", { name: "Wrap lines", exact: true }).click();
    assert.equal(await page.locator("#wrap-code").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#code-scroll").evaluate((e) => getComputedStyle(e).whiteSpace), "pre-wrap");
    await page.getByRole("button", { name: "Jump to request", exact: false }).click();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      const contrast = await page.evaluate(() => {
        const luminance = (color: string) => {
          const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => { value /= 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
          return r! * .2126 + g! * .7152 + b! * .0722;
        };
        const code = getComputedStyle(document.getElementById("code")!);
        const panel = getComputedStyle(document.getElementById("code-panel")!);
        const a = luminance(code.color), b = luminance(panel.backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      });
      assert.ok(contrast >= 7, `${scheme}: readable code contrast`);
    }
    for (const width of [1024, 700, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("System prompt").fill(`Screen ${width}`);
      await page.locator('[data-view-target="code"]').click();
      assert.equal(await page.locator("#code-panel").isVisible(), true);
      assert.match(await page.locator("#code").textContent() ?? "", new RegExp(`Screen ${width}`));
      assert.equal(await page.locator("#settings").isVisible(), width > 700);
      await page.locator('[data-view-target="chat"]').click();
      assert.equal(await page.locator("#chat-panel").isVisible(), true);
      assert.equal(await page.locator("#prompt").inputValue(), draft);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`);
    }
    assert.equal(externalRequests, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await close(demo.server); }
});

test("runtime loading can be retried, never silently switches language, and does not allow sending while loading", { timeout: 90_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const page = await browser.newPage();
  let attempts = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let releaseReply = () => {};
  const heldReply = new Promise<void>((resolve) => { releaseReply = resolve; });
  let posts = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/vendor/rust/lm15.wasm")) {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 503, body: "Temporary test failure" });
      await held;
      return route.continue();
    }
    if (url.origin === new URL(demo.url).origin) return route.continue();
    assert.equal(route.request().method(), "POST");
    posts++;
    await heldReply;
    return route.fulfill({ contentType: "text/event-stream", body: replyFor(url) });
  });
  try {
    await page.goto(demo.url);
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-loading-key");
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    await page.waitForFunction(() => document.getElementById("key-state")?.textContent === "Key ready (this tab)");
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
    await page.getByLabel("Rust", { exact: true }).check();
    await page.getByRole("button", { name: "Retry loading" }).waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Rust", { exact: true }).isChecked(), true);
    assert.equal(await page.locator('[data-language="rust"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#send").isDisabled(), true);
    await page.getByRole("button", { name: "Retry loading" }).click();
    await page.getByLabel("Message", { exact: true }).press("Enter");
    assert.equal(posts, 0, "Keyboard sending is blocked too while the runtime loads");
    assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft");
    await page.getByLabel("JavaScript", { exact: true }).check();
    assert.equal(await page.locator("#send").isDisabled(), false);
    release();
    await page.getByLabel("Rust", { exact: true }).check();
    await page.waitForFunction(() => document.getElementById("runtime-status")?.textContent?.startsWith("Rust ready"));
    assert.equal(attempts, 2, "Retry actually refetches, rather than reusing a rejected promise");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    for (const name of ["JavaScript", "Python", "Rust"]) assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), true, "The executing language cannot change mid-turn");
    releaseReply();
    await page.waitForFunction(() => document.getElementById("usage")?.textContent?.endsWith("Rust"));
    assert.equal(posts, 1);
    assert.equal(await page.getByLabel("JavaScript", { exact: true }).isDisabled(), false);
  } finally { release(); releaseReply(); await browser.close(); await close(demo.server); }
});

test("Python can retry a failed module download without reloading the page", { timeout: 120_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const page = await browser.newPage();
  let attempts = 0;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, new URL(demo.url).origin, "Runtime setup never sends a provider request");
    if (url.pathname.endsWith("/pyodide.mjs") && ++attempts === 1) return route.fulfill({ status: 503, body: "Temporary test failure" });
    return route.continue();
  });
  try {
    await page.goto(demo.url);
    await page.getByLabel("Python", { exact: true }).check();
    await page.getByRole("button", { name: "Retry loading" }).waitFor({ state: "visible" });
    assert.equal(await page.getByLabel("Python", { exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "Retry loading" }).click();
    await page.waitForFunction(() => document.getElementById("runtime-status")?.textContent?.startsWith("Python ready"), undefined, { timeout: 90_000 });
    assert.equal(attempts, 2);
    assert.equal(await page.locator("#code-file").textContent(), "playground.py");
    assert.equal(await page.locator("#retry-runtime").isVisible(), false);
  } finally { await browser.close(); await close(demo.server); }
});

test("the playground runs the same turn through Python (Pyodide) and Rust (wasm) in the browser, and the three runtimes build the same bytes", { timeout: 300_000 }, async () => {
  const installed = findBrowsers().find((b) => b.name === "chromium");
  assert.ok(installed);
  const demo = await startDemo();
  const browser = await chromium.launch({ executablePath: installed.bin });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const sent: Array<{ url: string; body: string; auth: string | undefined }> = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(demo.url).origin) return route.continue();
    sent.push({ url: url.href, body: route.request().postData() ?? "", auth: route.request().headers()["authorization"] });
    return route.fulfill({ contentType: "text/event-stream", body: replyFor(url), headers: { "Access-Control-Allow-Origin": new URL(demo.url).origin } });
  });
  try {
    await page.goto(demo.url);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Automatically discover model IDs").uncheck();
    await page.getByLabel("API key", { exact: true }).fill("dummy-openai-key");
    await page.getByRole("button", { name: "Use key for this provider" }).click();
    for (const runtime of ["Rust", "Python", "JavaScript"] as const) {
      await page.getByLabel(runtime, { exact: true }).check();
      if (runtime !== "JavaScript") await page.waitForFunction((r) => document.getElementById("runtime-status")?.textContent?.startsWith(`${r} ready`), runtime, { timeout: 120_000 });
      await page.getByLabel("Message", { exact: true }).fill(`hello from ${runtime}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction((r) => document.getElementById("usage")?.textContent?.endsWith(r), runtime, { timeout: 60_000 });
      assert.equal(await page.locator("#transcript article").last().locator("p").textContent(), "Hello there.", runtime);
      assert.equal(await page.locator("#transcript article").last().locator("b").textContent(), `OpenAI · ${runtime}`);
    }
    await page.waitForFunction(() => document.getElementById("fidelity")?.textContent?.includes("Same request bytes from JavaScript, Python, Rust"));
    assert.equal(sent.length, 3);
    for (const call of sent) {
      assert.equal(call.url, "https://api.openai.com/v1/responses");
      assert.equal(call.auth, "Bearer dummy-openai-key", "every runtime sends the page's key, once, as a header");
    }
    // The third turn carries the first two replies, whichever runtime produced them: one transcript, three SDKs.
    const third = JSON.parse(sent[2]!.body) as { input: Array<{ role: string }> };
    assert.deepEqual(third.input.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
    assert.match((await page.locator("#code").textContent()) ?? "", /Message\.fromJSON/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await close(demo.server); }
});
