/**
 * The playground's code panel is executable documentation in three
 * languages. For every provider, with and without a replayed transcript
 * (including thinking parts and continuation state), with default and
 * full settings (system prompt, temperature, reasoning):
 *
 * - the JavaScript text type-checks against the built package, runs, and
 *   builds the same request as the page's own builder;
 * - the Python text runs under Pyodide (Node-hosted), through
 *   lm15-python's FetchTransport, and builds the same bytes as JavaScript;
 * - the Rust runtime (lm15-rs compiled to wasm) builds the same bytes;
 * - the Rust text is what `lm15-rs/examples/playground.rs` holds, so
 *   `cargo check --examples` there proves it compiles (`npm run
 *   rust:snippets` regenerates the file; this test refuses drift).
 *
 * Pyodide and the wasm codec are skipped, saying why, when they cannot be
 * built here; the JavaScript and drift checks always run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { Message, Request as RequestNs, UnsupportedFeatureError, continuationState, thinking, utf8Decode } from "../dist/browser.js";
import { CONNECTIONS } from "../examples/provider-page/connections.ts";
import { DEFAULT_SETTINGS, buildRequest, createClient, exampleJavascript, examplePython, exampleRust, fuzzyScore, keyless, slashCommand, type Connection, type Settings } from "../examples/provider-page/experience.ts";
import { RustCodec } from "../examples/provider-page/runtimes/rust.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { ensureWheel } from "../tools/python_wheel.ts";
import { ensureRustWasm } from "../tools/rust_wasm.ts";
import { renderRustExamples, rustExamplesPath } from "../tools/rust_snippets.ts";

installNodePlatform();

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = 'Quotes " and a newline\n</script> are text, not executable code.';
const history = [
  Message.user("Earlier question"),
  Message.assistant([thinking("Earlier hidden reasoning", { continuation: [continuationState("anthropic", "thinking_signature", { signature: "opaque-replay-signature" })] }), "Earlier answer"]),
];
const FULL: Settings = { system: "Answer briefly.", temperature: 0.2, maxTokens: 64, reasoning: "low" };
const cases = CONNECTIONS.flatMap((choice) =>
  ([[], history] as Message[][]).flatMap((messages) =>
    [DEFAULT_SETTINGS, FULL].map((settings) => ({
      messages,
      settings,
      connection: { provider: choice.id, model: choice.model || "custom-model", endpoint: "http://localhost:1234/v1" } satisfies Connection,
      key: keyless(choice.id) ? "unused" : "YOUR_API_KEY",
    })),
  ),
);
const wheel = ensureWheel();
const wasm = ensureRustWasm();

test("fuzzy selection ranks exact names first and rejects unordered matches; slash commands stay distinct", () => {
  assert.ok(fuzzyScore("openai", "openai") > fuzzyScore("openai", "openai-chat"));
  assert.ok(fuzzyScore("gpt4mini", "gpt-4.1-mini") > -Infinity);
  assert.equal(fuzzyScore("xyz", "openai"), -Infinity);
  assert.deepEqual(slashCommand("/provider ant"), { kind: "provider", query: "ant" });
  assert.deepEqual(slashCommand("/model gpt4mini"), { kind: "model", query: "gpt4mini" });
  assert.deepEqual(slashCommand("/"), { kind: "commands", query: "" });
  assert.equal(slashCommand("Explain /model to me"), undefined);
});

/** The page's own request for a case, and its bytes through the JavaScript runtime's client — or the typed refusal (ollama has no reasoning field). */
async function expected(c: (typeof cases)[number]) {
  const request = buildRequest(c.connection, c.settings, c.messages, prompt);
  try {
    const built = await createClient(c.connection, c.key).buildRequest(request, true);
    return { request, refused: undefined, method: built.method, url: built.url, body: utf8Decode(built.body), headers: Object.fromEntries(built.headers.map(([k, v]) => [k.toLowerCase(), v])) };
  } catch (e) {
    if (!(e instanceof UnsupportedFeatureError)) throw e;
    return { request, refused: e, method: "", url: "", body: "", headers: {} };
  }
}

test(`JavaScript: all ${cases.length} variants type-check, execute, and build the page's request`, { timeout: 120_000 }, async (t) => {
  assert.equal(cases.length, 44);
  const sources = cases.map((c) => exampleJavascript(c.connection, c.settings, c.messages, prompt).replace("process.stdout.write(text)", "void text"));
  const files = new Map(sources.map((source, i) => [resolve(root, `examples/provider-page/__example_${i}.ts`), source]));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"] };
  const host = ts.createCompilerHost(options);
  const [read, exists, source] = [host.readFile, host.fileExists, host.getSourceFile];
  host.readFile = (f) => files.get(f) ?? read(f);
  host.fileExists = (f) => files.has(f) || exists(f);
  host.getSourceFile = (f, l, e, fresh) => (files.has(f) ? ts.createSourceFile(f, files.get(f)!, ts.ScriptTarget.ES2023, true) : source(f, l, e, fresh));
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...files.keys()], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));

  let calls: Array<{ url: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: new TextDecoder().decode(init.body as Uint8Array<ArrayBuffer>) });
    return new Response(streamFor(url), { headers: { "Content-Type": "text/event-stream" } });
  });
  const entry = pathToFileURL(resolve(root, "dist/browser.js")).href;
  for (const [i, c] of cases.entries()) {
    calls = [];
    const want = await expected(c);
    const url = `data:text/javascript,${encodeURIComponent(`// variant ${i}\n` + sources[i]!.replace('"lm15/browser"', JSON.stringify(entry)) + "\nexport { request, response };")}`;
    if (want.refused) {
      await assert.rejects(import(url), (e: unknown) => e instanceof Error && e.name === "UnsupportedFeatureError", `${c.connection.provider}: the JavaScript text refuses as the page does`);
      assert.equal(calls.length, 0);
      continue;
    }
    const module = await import(url);
    assert.equal(calls.length, 1, `${c.connection.provider}: one request`);
    assert.equal(calls[0]!.url, want.url);
    assert.equal(calls[0]!.body, want.body, `${c.connection.provider}: the JavaScript text and the page build the same bytes`);
    assert.equal(module.response.finishReason, "stop");
    if (c.messages.length) assert.match(sources[i]!, /"continuation": \[/, "the transcript is replayed with its continuation state");
  }
});

test(`Python under Pyodide: all ${cases.length} variants execute and build the same bytes as JavaScript`, { skip: "skip" in wheel ? wheel.skip : false, timeout: 600_000 }, async () => {
  const { loadPyodide } = await import("pyodide");
  let calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  (globalThis as { fetch: typeof fetch }).fetch = async (url, init) => {
    calls.push({ url: String(url), body: new TextDecoder().decode(init?.body as Uint8Array), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(streamFor(String(url)), { headers: { "Content-Type": "text/event-stream" } });
  };
  const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });
  await py.loadPackage(pathToFileURL((wheel as { path: string }).path).href, { messageCallback: () => {} });
  for (const c of cases) {
    calls = [];
    const want = await expected(c);
    const source = examplePython(c.connection, c.settings, c.messages, prompt).replace('"YOUR_API_KEY"', JSON.stringify(c.key));
    let out: string;
    try {
      out = String(await py.runPythonAsync(`${source}\nimport json\nfrom lm15.serde import response_to_dict\njson.dumps(response_to_dict(response))`));
    } catch (e) {
      const tail = String((e as Error).message).split("\n").slice(-6).join("\n");
      if (want.refused) {
        assert.match(tail, /UnsupportedFeatureError/, `${c.connection.provider}: Python refuses as JavaScript does`);
        assert.equal(calls.length, 0);
        continue;
      }
      assert.fail(`${c.connection.provider}: the Python text failed under Pyodide:\n${tail}\n---\n${source}`);
    }
    assert.equal(want.refused, undefined, `${c.connection.provider}: JavaScript refused but Python did not`);
    assert.equal(calls.length, 1, `${c.connection.provider}: one request`);
    assert.equal(calls[0]!.url, want.url, c.connection.provider);
    assert.equal(calls[0]!.body, want.body, `${c.connection.provider}: Python and JavaScript build the same bytes`);
    assert.deepEqual(calls[0]!.headers, want.headers, `${c.connection.provider}: the same headers`);
    assert.equal((JSON.parse(out) as { finish_reason: string }).finish_reason, "stop");
  }
});

test(`Rust under wasm: all ${cases.length} variants build the same bytes as JavaScript`, { skip: "skip" in wasm ? wasm.skip : false, timeout: 120_000 }, async () => {
  const rust = await RustCodec.load(readFileSync((wasm as { path: string }).path));
  for (const c of cases) {
    const want = await expected(c);
    const codecConnection = c.connection.provider === "custom" ? { provider: "openai-chat", apiKey: c.key, baseUrl: c.connection.endpoint } : { provider: c.connection.provider, apiKey: c.key };
    if (want.refused) {
      assert.throws(() => rust.buildRequest(codecConnection, RequestNs.toJSON(want.request), true), (e: unknown) => e instanceof Error && e.name === "UnsupportedFeatureError", `${c.connection.provider}: Rust refuses as JavaScript does`);
      continue;
    }
    const built = rust.buildRequest(codecConnection, RequestNs.toJSON(want.request), true);
    const url = new URL(built.url);
    for (const [k, v] of Object.entries(built.params)) url.searchParams.set(k, v);
    assert.equal(url.href, want.url, c.connection.provider);
    assert.deepEqual(built.body, JSON.parse(want.body), `${c.connection.provider}: Rust and JavaScript build the same body`);
  }
});

test("Rust: lm15-rs/examples/playground.rs is the generator's output (cargo check --examples compiles it there)", () => {
  const rendered = renderRustExamples();
  assert.ok(existsSync(rustExamplesPath), `${rustExamplesPath} is missing; run npm run rust:snippets`);
  assert.equal(readFileSync(rustExamplesPath, "utf-8"), rendered, "the Rust snippets drifted; run npm run rust:snippets and cargo check --examples in lm15-rs");
  for (const c of cases.filter((x) => (x.settings === FULL) === x.messages.length > 0)) {
    assert.ok(rendered.includes(exampleRust(c.connection, c.settings, c.messages, prompt).split("\n")[1]!), c.connection.provider);
  }
});

/** A stream body of the right dialect for the URL, ending in `stop` with usage. */
function streamFor(url: string): string {
  let frames: unknown[];
  if (url.includes("/responses")) frames = [
    { type: "response.created", response: { id: "r", model: "m" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" },
    { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
  ];
  else if (url.includes("/messages")) frames = [
    { type: "message_start", message: { id: "r", model: "m", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  else if (url.includes("streamGenerateContent")) frames = [{ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }];
  else frames = [{ id: "r", model: "m", choices: [{ delta: { role: "assistant", content: "Hi" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (url.includes("/responses") || url.includes("/messages") || url.includes("streamGenerateContent") ? "" : "data: [DONE]\n\n");
}
