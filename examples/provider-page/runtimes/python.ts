/**
 * The Python runtime: lm15-python under Pyodide (CPython compiled to
 * WebAssembly), with `lm15.transports.FetchTransport` carrying the wire
 * over this page's `fetch`. What runs is the Python text the code panel
 * shows, with the placeholder key replaced by the real one at execution
 * — never in the panel, never in a URL, never persisted by Pyodide.
 *
 * Pyodide is 13 MB (cached by the browser after the first load) and the
 * lm15 wheel 0.5 MB; both are served by this site, no CDN.
 */

import { Message, Response, type Request } from "lm15/browser";
import { examplePython, keyless, type Connection, type Wire } from "../experience.ts";
import type { Runtime } from "./index.ts";

interface Pyodide {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { write?: (buffer: Uint8Array) => number; batched?: (line: string) => void }): void;
  loadPackage(name: string, options?: { messageCallback?: (m: string) => void }): Promise<unknown>;
  globals: { get(name: string): unknown; delete(name: string): void };
}

// Relative to the built module: works locally and under a versioned static release.
const INDEX_URL = new URL("../../../../vendor/pyodide/", import.meta.url).href;
const WHEEL_URL = new URL("../../../../vendor/python/lm15.whl", import.meta.url).href;
let pyodide: Pyodide | undefined;
let loading: Promise<Pyodide> | undefined;
let bootAttempts = 0;

async function boot(report: (status: string) => void): Promise<Pyodide> {
  if (pyodide) return pyodide;
  loading ??= (async () => {
    report("Loading Pyodide (13 MB, cached after the first time)…");
    // Browsers can cache a failed module import. A retry needs a fresh module URL.
    const retry = bootAttempts++ === 0 ? "" : `?retry=${bootAttempts}`;
    const module = (await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs${retry}`)) as { loadPyodide(options: { indexURL: string }): Promise<Pyodide> };
    const py = await module.loadPyodide({ indexURL: INDEX_URL });
    report("Installing lm15 for Python…");
    await py.loadPackage(WHEEL_URL, { messageCallback: () => {} });
    const version = String(await py.runPythonAsync("import lm15, sys; f'lm15 {lm15.__version__} on Python {sys.version.split()[0]}'"));
    report(`Python ready: ${version}`);
    pyodide = py;
    return py;
  })().catch((error) => { loading = undefined; throw error; });
  return loading;
}

/** The displayed source with the key in place of the placeholder: what actually executes. */
function withKey(source: string, key: string | undefined, connection: Connection): string {
  const value = keyless(connection.provider) ? "unused" : key;
  if (!value) throw new Error("Add this provider's API key in Settings first.");
  return source.replace('"YOUR_API_KEY"', JSON.stringify(value));
}

/** The transcript and prompt the request carries, as the generator expects them. */
function split(request: Request): { messages: Message[]; prompt: string } {
  const all = [...request.messages];
  const last = all.pop()!;
  const prompt = last.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return { messages: all, prompt };
}

export const pythonRuntime: Runtime = {
  id: "python",
  label: "Python",
  claim: "lm15-python under Pyodide (real CPython in WebAssembly), the code shown, over this page's fetch.",
  loaded: () => pyodide !== undefined,
  load: async (report) => void (await boot(report)),

  async wire(connection, key, request): Promise<Wire> {
    const py = await boot(() => {});
    const { messages, prompt } = split(request);
    const source = examplePython(connection, settingsOf(request), messages, prompt);
    // The same construction with the sync class (no transport needed) and its
    // build_request: the bytes, no network. Public API only.
    const head = source.split("\nresult = AsyncResponseStream")[0]!
      .replace(/\bAsync(OpenAILM|OpenAIChatLM|AnthropicLM|GeminiLM)\b/g, "$1")
      .replace(/^from lm15\.transports import FetchTransport.*\n/m, "")
      .replace(/^    transport=FetchTransport\(\),\n/m, "");
    const program = `${withKey(head, key, connection)}
import json
_built = lm.build_request(request, stream=True)
json.dumps({"method": _built.method, "url": _built.url, "headers": list(_built.headers), "body": _built.body.decode("utf-8")})
`;
    return JSON.parse(String(await py.runPythonAsync(program))) as Wire;
  },

  async stream(connection, key, request, signal, onText): Promise<Response> {
    const py = await boot(() => {});
    const { messages, prompt } = split(request);
    const source = examplePython(connection, settingsOf(request), messages, prompt);
    const decoder = new TextDecoder();
    py.setStdout({ write: (bytes) => (onText(decoder.decode(bytes, { stream: true })), bytes.length) });
    const program = `${withKey(source, key, connection)}
import json
from lm15.serde import response_to_dict
json.dumps(response_to_dict(response))
`;
    const abort = () => void py.runPythonAsync("await result.aclose()").catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      const out = String(await py.runPythonAsync(program));
      return Response.fromJSON(JSON.parse(out));
    } catch (error) {
      throw translate(error, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      py.setStdout({ batched: () => {} });
    }
  },
};

/** The settings a Request carries, read back for the generator (the page passes the same object it built the request from). */
function settingsOf(request: Request) {
  const config = request.config ?? {};
  return {
    system: typeof request.system === "string" ? request.system : "",
    temperature: config.temperature ?? null,
    maxTokens: config.maxTokens ?? 400,
    reasoning: config.reasoning?.effort ?? ("" as const),
  };
}

/** A Python exception, as one line a person can read: the lm15 error class and its message. */
function translate(error: unknown, signal: AbortSignal): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (signal.aborted) return Object.assign(new Error("stopped"), { name: "TransportError" });
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1] ?? text;
  const match = /^lm15\.[\w.]*?(\w+Error): (.*)$/.exec(last) ?? /^(\w+Error): (.*)$/.exec(last);
  const out = new Error(match ? match[2]! : last);
  out.name = match ? match[1]! : "PythonError";
  return out;
}

