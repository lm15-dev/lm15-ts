/**
 * The web entry point's guarantees, checked mechanically.
 *
 * 1. Its runtime import graph reaches no `node:*` module, no bare
 *    specifier, and no Node global (`Buffer`, `process`, `require`, ...):
 *    a bundler targeting a browser gets a bundle with nothing to polyfill.
 * 2. Every host service it lacks refuses by name — stored logins, path
 *    reads, cloud chains, SigV4, websocket headers — instead of failing
 *    somewhere downstream or, worse, succeeding by pretending.
 * 3. The byte codec that replaced `Buffer` agrees with `Buffer`, byte for
 *    byte, on every length and on the strictness the wire relies on.
 *
 * The same entry is also run inside a realm with only web globals
 * (`tests/web_realm.test.ts`) and inside Chromium and Firefox
 * (`tools/browser_smoke.ts`); this file is the static half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(root, "src/browser.ts");
const NODE_GLOBALS = new Set(["Buffer", "process", "require", "module", "__dirname", "__filename", "global"]);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/** Walk value imports (type-only ones load nothing) from `entry`; collect every offence. */
function auditRuntimeGraph(entry: string): { files: string[]; findings: Finding[] } {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.ESNext, true);
    const rel = file.slice(root.length + 1);
    const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const follow = (specifier: string, node: ts.Node) => {
      if (specifier.startsWith("node:")) findings.push({ file: rel, line: at(node), what: `imports ${specifier}` });
      else if (!specifier.startsWith(".")) findings.push({ file: rel, line: at(node), what: `bare import ${specifier}` });
      else queue.push(resolve(dirname(file), specifier));
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const typeOnly = clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) follow((node.moduleSpecifier as ts.StringLiteral).text, node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const typeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) follow((node.moduleSpecifier as ts.StringLiteral).text, node);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) follow(arg.text, node);
        else findings.push({ file: rel, line: at(node), what: "dynamic import with a computed specifier" });
      } else if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && isValueReference(node)) {
        findings.push({ file: rel, line: at(node), what: `uses Node global ${node.text}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: [...seen].map((f) => f.slice(root.length + 1)).sort(), findings };
}

/** An identifier that reads a global: not a property name, a declaration, a type, or a `typeof x` guard. */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) return false;
  if (ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isTypeOfExpression(parent)) return false; // `typeof process !== "undefined"` is a guard, not a use
  return true;
}

test("lm15/browser: the runtime import graph has no node:* module, no bare import and no Node global", () => {
  const { files, findings } = auditRuntimeGraph(ENTRY);
  assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.what}`).join("\n"));
  // The graph is the whole wire: every dialect, the router, streaming, live, the transport.
  for (const must of ["src/dialects/openai_chat.ts", "src/dialects/anthropic.ts", "src/dialects/gemini.ts", "src/router.ts", "src/stream.ts", "src/live.ts", "src/transport.ts", "src/platform.ts"]) {
    assert.ok(files.includes(must), `${must} is part of the web entry`);
  }
  // And none of the host services.
  for (const mustNot of ["src/auth/stores.ts", "src/auth/stores_doctor.ts", "src/cloud/chains.ts", "src/cloud/sigv4.ts", "src/cloud/rs256.ts", "src/platform_node.ts", "src/vet.ts"]) {
    assert.ok(!files.includes(mustNot), `${mustNot} must not be reachable from the web entry`);
  }
});

test("lm15 (Node entry) reaches exactly the host services the web entry lacks — and the auditor sees them", () => {
  const { files, findings } = auditRuntimeGraph(resolve(root, "src/index.ts"));
  for (const must of ["src/platform_node.ts", "src/auth/stores.ts", "src/cloud/chains.ts", "src/cloud/sigv4.ts"]) assert.ok(files.includes(must), must);
  // The Node entry legitimately imports node:* and reads process/Buffer; the auditor must report every one, or its clean bill for the web entry means nothing.
  assert.ok(findings.some((f) => f.what === "imports node:fs"), "node:fs seen");
  assert.ok(findings.some((f) => f.what === "uses Node global process"), "process seen");
  assert.ok(findings.some((f) => f.what === "uses Node global Buffer"), "Buffer seen");
  assert.ok(findings.every((f) => !f.file.startsWith("src/dialects/") && f.file !== "src/router.ts" && f.file !== "src/adapter.ts"), "no offence in the shared core");
});

test("bytes: base64 agrees with Buffer on every length, both alphabets decode, and the decoder is strict", async () => {
  const { base64Decode, base64Encode, base64UrlEncode, utf8Decode, utf8Encode } = await import("../src/bytes.ts");
  for (let n = 0; n <= 70; n++) {
    for (let trial = 0; trial < 4; trial++) {
      const bytes = new Uint8Array(randomBytes(n));
      const expected = Buffer.from(bytes).toString("base64");
      assert.equal(base64Encode(bytes), expected, `encode length ${n}`);
      assert.deepEqual(base64Decode(expected), bytes, `decode length ${n}`);
      assert.deepEqual(base64Decode(base64UrlEncode(bytes)), bytes, `url-safe round trip length ${n}`);
      assert.equal(base64UrlEncode(bytes), Buffer.from(bytes).toString("base64url"), `url-safe length ${n}`);
    }
  }
  const big = new Uint8Array(randomBytes(1_000_003));
  assert.equal(base64Encode(big), Buffer.from(big).toString("base64"));
  assert.deepEqual(base64Decode(Buffer.from(big).toString("base64")), big);
  assert.throws(() => base64Decode("AAA*"), TypeError, "outside the alphabet");
  assert.throws(() => base64Decode("A"), TypeError, "a dangling character");
  assert.throws(() => base64Decode("AB=="), TypeError, "non-zero padding bits"); // Buffer accepts this; the wire must not have two spellings
  assert.throws(() => base64Decode("QQ==\n"), TypeError, "whitespace is the caller's to strip");
  assert.equal(utf8Decode(utf8Encode("héllo ✓ 🙂")), "héllo ✓ 🙂");
});

test("lm15/browser: every missing host service refuses by name, none is skipped", async () => {
  const web = await import("../src/browser.ts");
  const { mediaBase64 } = await import("../src/wire.ts");
  const { webPlatform, setDefaultPlatform, getDefaultPlatform } = web;
  const before = getDefaultPlatform();
  setDefaultPlatform(webPlatform);
  try {
    // A stored login (Claude Code) on a host with no stores: the policy is named, the fix is named.
    assert.throws(
      () => new web.ClaudeCodeLM({}),
      (e: unknown) => e instanceof web.NotConfiguredError && /stored logins are not available on the web platform/.test(e.message),
    );
    // A key policy with nothing given: the ordinary env-key message, unchanged.
    assert.throws(() => new web.OpenAILM({}), (e: unknown) => e instanceof web.NotConfiguredError && /OPENAI_API_KEY/.test(e.message));
    // An explicit credential always works — the browser's normal case.
    const lm = new web.OpenAIChatLM({ apiKey: "user-supplied", baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
    const req = await lm.buildRequest({ model: "m", messages: [web.Message.user("hi")] }, false);
    assert.equal(req.url, "http://localhost:1234/v1/chat/completions");
    // A path-addressed part on a host with no filesystem.
    const image = web.image({ mediaType: "image/png", path: "/tmp/x.png" });
    assert.throws(
      () => mediaBase64(image),
      (e: unknown) => e instanceof web.UnsupportedFeatureError && /web platform has no filesystem/.test(e.message) && /supply the bytes/.test(e.message),
    );
    // Bytes, not a path, is the browser's shape and it works.
    const inline = web.image({ mediaType: "image/png", data: web.base64Encode(new Uint8Array([137, 80, 78, 71])) });
    assert.equal(mediaBase64(inline), "iVBORw==");
    // SigV4 on a host with no signer: refused before the wire, naming the host.
    const aws = new web.AwsCredentials({ accessKeyId: "AKIA", secretAccessKey: "s" });
    const bedrock = new web.OpenAIChatLM({ apiKey: aws, access: web.access.BEDROCK_CHAT, settings: { region: "us-east-1" } });
    await assert.rejects(
      bedrock.buildRequest({ model: "m", messages: [web.Message.user("hi")] }, false),
      (e: unknown) => e instanceof web.NotConfiguredError && /SigV4 signing is not available on the web platform/.test(e.message),
    );
    // The router: no process environment to read, so a bare model is not configured, and the message says how to configure it.
    assert.throws(
      () => new web.LMRouter().lm("gpt-4.1-mini"),
      (e: unknown) => e instanceof web.NotConfiguredError && /apiKeys/.test(e.message),
    );
    assert.equal(new web.LMRouter({ apiKeys: { openai: "k" } }).lm("gpt-4.1-mini").provider, "openai");
    // A cloud chain door without a chain: refused by name; with an explicit token it builds.
    assert.throws(
      () => new web.LMRouter({ settings: { "bedrock-chat": { region: "us-east-1" } } }).lm("bedrock-chat:m"),
      (e: unknown) => e instanceof web.NotConfiguredError && /aws-chain credential chain is not available on the web platform/.test(e.message),
    );
    assert.equal(new web.LMRouter({ apiKeys: { "bedrock-chat": new web.BearerToken("t") }, settings: { "bedrock-chat": { region: "us-east-1" } } }).lm("bedrock-chat:m").provider, "bedrock-chat");
    // The doctor reports the absent rungs as absent — the same walk the router made.
    const report = web.explainAuth("claude-code");
    assert.equal(report.configured, false);
    assert.match(report.steps[0]!.detail, /not available on the web platform/);
    const cloud = web.explainAuth("bedrock-chat", { settings: { region: "us-east-1" } });
    assert.ok(cloud.steps.some((s) => s.kind === "aws-chain" && s.state === "absent"));
    assert.equal(web.explainAuth("openai", { apiKeys: { openai: "k" } }).configured, true);
  } finally {
    setDefaultPlatform(before);
  }
});
