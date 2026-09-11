/**
 * The page `tools/browser_smoke.ts` loads in a real browser. Runs the web
 * entry against the smoke server's fake Chat Completions door, in the page
 * and in a module worker, and posts one JSON report back. Each check is
 * named so a failure says which promise broke.
 */

import {
  LMRouter,
  Message,
  NotConfiguredError,
  OpenAIChatLM,
  Request,
  ResponseStream,
  TransportError,
  UnsupportedFeatureError,
  explainAuth,
  getDefaultPlatform,
  image,
  toJSON,
} from "../src/browser.ts";
import { mediaBase64 } from "../src/wire.ts";

interface Check {
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Record<string, Check> = {};
const check = (name: string, ok: boolean, detail: string) => {
  checks[name] = { ok, detail };
};

async function run(): Promise<void> {
  const base = `${location.origin}/api`;
  check("platform", getDefaultPlatform().name === "web" && typeof (globalThis as { process?: unknown }).process === "undefined", `platform=${getDefaultPlatform().name}`);

  const lm = new OpenAIChatLM({ apiKey: "page-key", baseUrl: base });
  const request: Request = { model: "smoke-model", messages: [Message.user("hello from a page")] };

  // complete: the wire round trip through the browser's fetch.
  try {
    const response = await lm.complete(request);
    check("complete", response.text === "Hello, page." && response.finishReason === "stop" && response.usage?.totalTokens === 7, `text=${JSON.stringify(response.text)} finish=${response.finishReason}`);
  } catch (e) {
    check("complete", false, String(e));
  }

  // stream: chunks arrive as they are flushed; the end event carries finish + usage.
  try {
    const rs = new ResponseStream(lm.stream(request), request);
    const chunks: string[] = [];
    for await (const text of rs) chunks.push(text);
    const response = await rs.response();
    check("stream", chunks.length >= 3 && chunks.join("") === "Hello, streamed page." && response.finishReason === "stop", `chunks=${chunks.length} text=${JSON.stringify(chunks.join(""))}`);
  } catch (e) {
    check("stream", false, String(e));
  }

  // cancel: abort after the first chunk; the iteration ends with the abort as a TransportError and the server sees the socket close.
  try {
    const controller = new AbortController();
    const slow: Request = { model: "smoke-model", messages: [Message.user("cancel me")] };
    const rs = new ResponseStream(lm.stream(slow, { signal: controller.signal }), slow);
    let first = "";
    let error: unknown;
    try {
      for await (const text of rs) {
        first ||= text;
        controller.abort();
      }
    } catch (e) {
      error = e;
    }
    check("cancel", first.length > 0 && error instanceof TransportError && /abort/i.test(error.message), `first=${JSON.stringify(first)} error=${error instanceof Error ? error.name : String(error)}`);
  } catch (e) {
    check("cancel", false, String(e));
  }

  // errors: the fake door answers 401 to a wrong key; it must arrive as AuthError with the status.
  try {
    await new OpenAIChatLM({ apiKey: "wrong", baseUrl: base }).complete(request);
    check("auth-error", false, "no error");
  } catch (e) {
    const err = e as Error & { status?: number };
    check("auth-error", err.name === "AuthError" && err.status === 401, `${err.name} status=${err.status}`);
  }

  // The host refusals, in a real page: no stored login, no path, no environment.
  check("no-stored-login", (() => {
    try {
      new LMRouter().lm("claude-code:x");
      return false;
    } catch (e) {
      return e instanceof NotConfiguredError && /web platform/.test(e.message);
    }
  })(), "ClaudeCode via router");
  check("no-path", (() => {
    try {
      mediaBase64(image({ mediaType: "image/png", path: "/etc/hostname" }));
      return false;
    } catch (e) {
      return e instanceof UnsupportedFeatureError && /no filesystem/.test(e.message);
    }
  })(), "path-addressed image");
  check("doctor", !explainAuth("openai").configured && explainAuth("openai", { apiKeys: { openai: "k" } }).configured, "explainAuth without / with apiKeys");
  check("serde", JSON.stringify(toJSON(Message.user("hi"), "message")) === JSON.stringify({ role: "user", parts: [{ type: "text", text: "hi" }] }), "message toJSON");

  // A module worker: the same entry, no DOM, builds a request.
  try {
    const result = await new Promise<{ ok: boolean; detail: string }>((resolve, reject) => {
      const worker = new Worker("/tools/browser_worker.ts", { type: "module" });
      const timer = setTimeout(() => reject(new Error("worker timed out")), 15_000);
      worker.onmessage = (event: MessageEvent<{ ok: boolean; detail: string }>) => {
        clearTimeout(timer);
        resolve(event.data);
        worker.terminate();
      };
      worker.onerror = (event: ErrorEvent) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
    });
    check("worker", result.ok, result.detail);
  } catch (e) {
    check("worker", false, String(e));
  }
}

run()
  .catch((e) => check("run", false, String(e)))
  .finally(async () => {
    const report = { userAgent: navigator.userAgent, checks };
    document.body.textContent = JSON.stringify(report);
    await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
  });
