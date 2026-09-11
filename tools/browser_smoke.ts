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

import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { findBrowsers, printReport, readBody, runInBrowser } from "./headless.ts";

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

async function main(): Promise<number> {
  const found = findBrowsers();
  if (found.length === 0) {
    console.error("browser smoke: no browser on PATH (looked for chromium, google-chrome, firefox)");
    return 2;
  }
  let failures = 0;
  for (const browser of found) {
    const state = { cancelObserved: false };
    const report = await runInBrowser(browser, {
      path: "/",
      handler: async (req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
          return true;
        }
        return fakeDoor(req, res, state);
      },
    });
    failures += printReport(browser.name, report, { "server-saw-cancel": { ok: state.cancelObserved, detail: "the stream socket closed before the second chunk" } }) > 0 ? 1 : 0;
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
