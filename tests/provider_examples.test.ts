/** The code panel is executable documentation, not decorative source text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { Message } from "../dist/browser.js";
import { CONNECTIONS } from "../examples/provider-page/connections.ts";
import { createClient, example, fuzzyScore, slashCommand, type Connection, type ExampleMode } from "../examples/provider-page/experience.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modes: ExampleMode[] = ["connect", "request", "stream", "models"];
const prompt = 'Quotes " and a newline\n</script> are text, not executable code.';
const cases = CONNECTIONS.flatMap((choice) => modes.map((mode) => ({
  mode, connection: { provider: choice.id, model: choice.model || "custom-model", endpoint: "http://localhost:1234/v1" } satisfies Connection,
})));

test("fuzzy selection ranks exact names first and rejects unordered matches; slash commands stay distinct", () => {
  assert.ok(fuzzyScore("openai", "openai") > fuzzyScore("openai", "openai-chat"));
  assert.ok(fuzzyScore("gpt4mini", "gpt-4.1-mini") > -Infinity);
  assert.equal(fuzzyScore("xyz", "openai"), -Infinity);
  assert.deepEqual(slashCommand("/provider ant"), { kind: "provider", query: "ant" });
  assert.deepEqual(slashCommand("/model gpt4mini"), { kind: "model", query: "gpt4mini" });
  assert.deepEqual(slashCommand("/"), { kind: "commands", query: "" });
  assert.equal(slashCommand("Explain /model to me"), undefined);
});

test("all 44 displayed JavaScript variants type-check against the browser package", () => {
  const files = new Map(cases.map(({ connection, mode }, index) => [resolve(root, `examples/provider-page/__example_${index}.ts`), example(connection, prompt, mode)]));
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"] };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile, originalExists = host.fileExists, originalSource = host.getSourceFile;
  host.readFile = (file) => files.get(file) ?? originalRead(file);
  host.fileExists = (file) => files.has(file) || originalExists(file);
  host.getSourceFile = (file, language, error, fresh) => files.has(file)
    ? ts.createSourceFile(file, files.get(file)!, ts.ScriptTarget.ES2023, true)
    : originalSource(file, language, error, fresh);
  const program = ts.createProgram([...files.keys()], options, host);
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
});

function reply(url: string, streaming: boolean): Response {
  if (!streaming) return new Response(JSON.stringify({ data: [{ id: "example" }], models: [{ name: "models/example" }] }));
  let frames: unknown[];
  if (url.includes("/responses")) frames = [
    { type: "response.created", response: { id: "r", model: "example" } },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
  ];
  else if (url.includes("/messages")) frames = [
    { type: "message_start", message: { id: "r", model: "example" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  else if (url.includes("streamGenerateContent")) frames = [{ candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }] }];
  else frames = [{ id: "r", model: "example", choices: [{ delta: { content: "Hello" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

test("the actual displayed code executes and builds the same request as the interface", async (t) => {
  let calls: Array<{ url: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? new TextDecoder().decode(init.body as Uint8Array<ArrayBuffer>) : "" });
    return reply(url, init.method === "POST");
  });
  const entry = pathToFileURL(resolve(root, "dist/browser.js")).href;
  for (const { connection, mode } of cases) {
    calls = [];
    // Only module resolution changes: this data URL imports the exact package's built browser entry.
    const source = example(connection, prompt, mode).replace('"lm15/browser"', JSON.stringify(entry));
    const exported = mode === "request" ? "lm, request, wire" : mode === "stream" ? "lm, request" : "lm";
    const module = await import(`data:text/javascript,${encodeURIComponent('const console = { log() {} };\n' + source + `\nexport { ${exported} };`)}`);
    assert.equal(module.lm.provider, createClient(connection, connection.provider === "ollama" ? "unused" : "YOUR_API_KEY").provider);
    assert.equal(calls.length, ["stream", "models"].includes(mode) ? 1 : 0, `${connection.provider}/${mode}`);
    if (mode !== "request" && mode !== "stream") continue;
    const expected = await createClient(connection, connection.provider === "ollama" ? "unused" : "YOUR_API_KEY").buildRequest({
      model: connection.model, messages: [Message.user(prompt)], config: { maxTokens: 400 },
    }, true);
    const actual = mode === "request" ? { url: module.wire.url, body: new TextDecoder().decode(module.wire.body) } : calls[0]!;
    assert.equal(actual.url, expected.url, connection.provider);
    assert.equal(actual.body, new TextDecoder().decode(expected.body), `${connection.provider}: code panel and UI mapping`);
  }
});
