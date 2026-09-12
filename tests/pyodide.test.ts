/**
 * lm15-python inside Pyodide (CPython compiled to WebAssembly), hosted by
 * Node: the same Python that runs in a page, with the host's `fetch` as
 * its transport. Two claims, tested:
 *
 * 1. `lm15.transports.FetchTransport` carries the wire for the async
 *    adapters: streamed text as it arrives, usage at the end, a cancel the
 *    server observes, a 401 as the typed AuthError.
 * 2. One standard across languages, at runtime: every request case in the
 *    contract corpus builds to the same method, URL, headers and body in
 *    Python-under-Pyodide as in TypeScript, through each SDK's own code.
 *
 * Pyodide is 13 MB from npm and a few seconds to start; the whole file
 * shares one interpreter. Skips, saying why, when the wheel cannot be
 * built (no sibling checkout, no uv/python) or the contract is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installNodePlatform } from "../src/platform_node.ts";
import { ensureWheel, root } from "../tools/python_wheel.ts";
import * as hostDriver from "./realm_driver.ts";

installNodePlatform();

const contract = process.env["LM15_CONTRACT_DIR"] ?? resolve(root, "..", "lm15-contract");
const wheel = ensureWheel();
const skip = "skip" in wheel ? wheel.skip : false;

type Fetch = typeof fetch;
interface Host {
  py: { runPythonAsync(code: string): Promise<unknown>; globals: { set(name: string, value: unknown): void } };
  setFetch(fetch: Fetch): void;
}

let host: Promise<Host> | undefined;
function pyodide(): Promise<Host> {
  host ??= (async (): Promise<Host> => {
    const { loadPyodide } = await import("pyodide");
    let current: Fetch = () => Promise.reject(new Error("no fetch installed for this test"));
    // Pyodide's `js.fetch` is the global at call time; route it through a swappable one.
    (globalThis as { fetch: Fetch }).fetch = (input, init) => current(input, init);
    const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
    await py.loadPackage(pathToFileURL((wheel as { path: string }).path).href, { messageCallback: () => {} });
    return { py: py as unknown as Host["py"], setFetch: (f) => void (current = f) };
  })();
  return host;
}

function sse(frames: unknown[], done = true): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

const CHAT_STREAM = [
  { id: "r", model: "gpt-4.1-mini", choices: [{ delta: { role: "assistant", content: "Hel" } }] },
  { choices: [{ delta: { content: "lo from Pyodide" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
];

test("Pyodide: FetchTransport streams, reports usage, and sends the bytes the stdlib transport would", { skip, timeout: 120_000 }, async () => {
  const { py, setFetch } = await pyodide();
  const calls: Array<{ url: string; method: string; headers: [string, string][]; body: string }> = [];
  setFetch(async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: [...new Headers(init?.headers).entries()], body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "" });
    return new Response(sse(CHAT_STREAM), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const out = (await py.runPythonAsync(`
import json
from lm15 import AsyncOpenAIChatLM, Message, Request, AsyncResponseStream
from lm15.transports import FetchTransport
lm = AsyncOpenAIChatLM(api_key="k", transport=FetchTransport())
request = Request(model="gpt-4.1-mini", messages=(Message.user("hello"),))
pieces = []
rs = AsyncResponseStream(lm.stream(request), request)
async for text in rs:
    pieces.append(text)
response = await rs.response()
json.dumps({"pieces": pieces, "text": response.text, "finish": response.finish_reason, "tokens": response.usage.total_tokens})
`)) as string;
  assert.deepEqual(JSON.parse(out), { pieces: ["Hel", "lo from Pyodide"], text: "Hello from Pyodide", finish: "stop", tokens: 5 });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.deepEqual(JSON.parse(call.body), { model: "gpt-4.1-mini", messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } });
  assert.deepEqual(Object.fromEntries(call.headers), { authorization: "Bearer k", "content-type": "application/json" });
});

test("Pyodide: a cancel mid-stream aborts the fetch and the server-side body sees it; a 401 is the typed AuthError", { skip, timeout: 120_000 }, async () => {
  const { py, setFetch } = await pyodide();
  let aborted = false;
  let cancelled = false;
  setFetch(async (_url, init) => {
    if (init?.headers && new Headers(init.headers).get("authorization") === "Bearer wrong") {
      return new Response(JSON.stringify({ error: { message: "Incorrect API key", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json", "x-request-id": "req-py-401" } });
    }
    init?.signal?.addEventListener("abort", () => (aborted = true));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse([CHAT_STREAM[0]], false)));
        // The second chunk never comes on its own; the reader must cancel.
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const out = (await py.runPythonAsync(`
import json
from lm15 import AsyncOpenAIChatLM, Message, Request, AsyncResponseStream, AuthError
from lm15.transports import FetchTransport
lm = AsyncOpenAIChatLM(api_key="k", transport=FetchTransport())
request = Request(model="gpt-4.1-mini", messages=(Message.user("cancel me"),))
rs = AsyncResponseStream(lm.stream(request), request)
first = None
async for text in rs:
    first = text
    break  # the caller stops reading: the stream must be released, the request aborted
await rs.aclose() if hasattr(rs, "aclose") else None
error = None
try:
    await AsyncOpenAIChatLM(api_key="wrong", transport=FetchTransport()).complete(request)
except AuthError as exc:
    error = {"name": type(exc).__name__, "status": exc.status, "request_id": exc.request_id}
json.dumps({"first": first, "error": error})
`)) as string;
  const result = JSON.parse(out) as { first: string; error: { name: string; status: number; request_id: string } };
  assert.equal(result.first, "Hel");
  assert.deepEqual(result.error, { name: "AuthError", status: 401, request_id: "req-py-401" });
  assert.ok(aborted || cancelled, "the abandoned stream was released (abort signalled or body cancelled)");
});

/** The comparable form of a built request from either SDK: method, URL without query, sorted params, lowercase headers, parsed body. */
function comparable(built: { method: string; url: string; headers: Array<[string, string]> | Record<string, string>; body: unknown; params?: Record<string, string> }): unknown {
  const url = new URL(built.url);
  const params: Record<string, string> = { ...(built.params ?? {}) };
  for (const [k, v] of url.searchParams) params[k] = v;
  const headers = Object.fromEntries((Array.isArray(built.headers) ? built.headers : Object.entries(built.headers)).map(([k, v]) => [k.toLowerCase(), v]));
  let body: unknown = built.body;
  if (typeof body === "string") {
    try {
      body = body === "" ? null : JSON.parse(body);
    } catch {
      // a non-JSON body compares as text
    }
  }
  return { method: built.method, url: url.origin + url.pathname, params: Object.fromEntries(Object.entries(params).sort()), headers, body };
}

test("Pyodide: every corpus request builds to the same request in Python-under-Pyodide as in TypeScript", { skip: skip || (!existsSync(join(contract, "AUTHORITY.md")) && "lm15-contract not checked out"), timeout: 300_000 }, async () => {
  const { py } = await pyodide();
  py.globals.set("VET_CASES", "[]");
  const cases: string[] = [];
  for (const dir of readdirSync(join(contract, "cases"))) {
    for (const file of readdirSync(join(contract, "cases", dir))) {
      const text = readFileSync(join(contract, "cases", dir, file), "utf-8");
      const c = JSON.parse(text) as { surface?: string; canonical_request?: unknown };
      if (!["models", "live", "files", "batch", "generation", "video", "cache", "ingest"].includes(c.surface ?? "") && c.canonical_request) cases.push(text);
    }
  }
  py.globals.set("VET_CASES", JSON.stringify(cases));
  // The Python shim's own handler, in-process: exactly what the contract harness drives over stdin.
  const replies = JSON.parse((await py.runPythonAsync(`
import json
from lm15.vet import handle_line
out = []
for text in json.loads(VET_CASES):
    case = json.loads(text)
    msg = {"id": 1, "op": "build_request", **{k: case[k] for k in ("provider", "canonical_request", "stream", "credential", "api_key", "base_url", "settings", "now") if k in case}}
    if "credential" not in case and "api_key" not in case:
        msg["api_key"] = "test-key-123"
    out.append(handle_line(json.dumps(msg)))
json.dumps(out)
`)) as string) as Array<{ result?: { method: string; url: string; params: Record<string, string>; headers: Record<string, string>; body: unknown; body_b64?: string }; error?: { type: string; code: string } }>;
  let same = 0;
  let refusedBoth = 0;
  for (const [i, text] of cases.entries()) {
    const id = (JSON.parse(text) as { id: string }).id;
    const ts = JSON.parse(await hostDriver.buildRequestJson(text)) as { refused?: string; code?: string; method: string; url: string; headers: Array<[string, string]>; body: string };
    const pyReply = replies[i]!;
    if (pyReply.error || ts.refused) {
      assert.ok(pyReply.error && ts.refused, `${id}: one side refused and the other did not (python=${JSON.stringify(pyReply.error)} ts=${ts.refused})`);
      assert.equal(pyReply.error.code, ts.code, `${id}: refusal codes differ`);
      refusedBoth++;
      continue;
    }
    const py = pyReply.result!;
    const pyBody = py.body_b64 !== undefined ? Buffer.from(py.body_b64, "base64").toString("utf-8") : py.body;
    const tsBody = Buffer.from(ts.body, "base64").toString("utf-8");
    assert.deepEqual(
      comparable({ method: ts.method, url: ts.url, headers: ts.headers, body: tsBody }),
      comparable({ method: py.method, url: py.url, params: py.params, headers: py.headers, body: pyBody }),
      `${id}: Python-under-Pyodide and TypeScript built different requests`,
    );
    same++;
  }
  assert.ok(same > 300, `only ${same} cases agreed`);
  assert.ok(refusedBoth > 0, "the corpus carries pinned refusals; both sides must refuse them");
  console.log(`# pyodide differential: ${same} requests identical, ${refusedBoth} refused identically`);
});
