/**
 * The web entry point, executed inside a realm that has only web globals.
 *
 * The realm is a `vm` context holding what a page has (`fetch`, `URL`,
 * `TextEncoder`, `crypto`, `AbortController`, timers) and nothing Node has
 * (`process`, `Buffer`, `require`, `node:*`). Every module of the web entry
 * is linked and evaluated in it from source, types stripped on the fly.
 *
 * Inside the realm the corpus driver builds every canonical request and
 * parses every pinned body; the same driver runs on the Node host outside
 * the realm. The two outputs must agree byte for byte. Node's agreement
 * with the contract is pinned by `contract_corpus.test.ts`; this test
 * makes the web entry's agreement follow from it.
 *
 * Needs `--experimental-vm-modules` (the `test` script passes it); skips,
 * saying so, without it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { installNodePlatform } from "../src/platform_node.ts";
import { isJsonObject, type JsonObject } from "../src/json.ts";
import * as hostDriver from "./realm_driver.ts";

installNodePlatform();

const here = dirname(fileURLToPath(import.meta.url));
const contract = process.env["LM15_CONTRACT_DIR"] ?? resolve(here, "..", "..", "lm15-contract");
const present = existsSync(join(contract, "AUTHORITY.md"));
const SourceTextModule = (vm as unknown as { SourceTextModule?: new (...args: unknown[]) => VmModule }).SourceTextModule;
type VmModule = {
  link(linker: (specifier: string, referencing: VmModule) => Promise<VmModule>): Promise<void>;
  evaluate(): Promise<void>;
  readonly namespace: Record<string, unknown>;
  readonly identifier: string;
};

/** A page's globals and none of Node's. Intrinsics (Uint8Array, Promise, …) come with the context. */
function webGlobals(): Record<string, unknown> {
  const g = globalThis as unknown as Record<string, unknown>;
  const names = [
    "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "AbortController", "AbortSignal", "Headers", "Request", "Response", "Blob", "File", "FormData",
    "ReadableStream", "WritableStream", "TransformStream", "crypto", "atob", "btoa", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "queueMicrotask", "structuredClone", "performance", "console", "DOMException", "Event", "EventTarget",
  ];
  const out: Record<string, unknown> = {};
  for (const name of names) if (name in g) out[name] = g[name];
  // No network in the realm: a fetch that reaches the wire is a test failure, not a request.
  out["fetch"] = () => Promise.reject(new Error("the realm has no network"));
  return out;
}

/** Link and evaluate `entry` (a `.ts` path) and everything it imports inside `context`. */
async function loadInRealm(entry: string, context: vm.Context): Promise<Record<string, unknown>> {
  const cache = new Map<string, VmModule>();
  const load = (path: string): VmModule => {
    let mod = cache.get(path);
    if (mod) return mod;
    const code = stripTypeScriptTypes(readFileSync(path, "utf-8"), { mode: "strip" });
    mod = new SourceTextModule!(code, {
      context,
      identifier: pathToFileURL(path).href,
      initializeImportMeta: (meta: { url: string }) => {
        meta.url = pathToFileURL(path).href;
      },
    });
    cache.set(path, mod);
    return mod;
  };
  const root = load(entry);
  await root.link(async (specifier, referencing) => {
    if (!specifier.startsWith(".")) throw new Error(`${referencing.identifier} imports ${specifier}: not a web module`);
    return load(resolve(dirname(fileURLToPath(referencing.identifier)), specifier));
  });
  await root.evaluate();
  return root.namespace;
}

/** Each wire case as its file's text (what crosses the realm boundary) plus the fields the test reads. */
function wireCases(): Array<{ text: string; id: string; pinnedBody: string | undefined }> {
  const out: Array<{ text: string; id: string; pinnedBody: string | undefined }> = [];
  for (const dir of readdirSync(join(contract, "cases"))) {
    for (const file of readdirSync(join(contract, "cases", dir))) {
      const text = readFileSync(join(contract, "cases", dir, file), "utf-8");
      const c = JSON.parse(text) as JsonObject;
      if (!["models", "live", "files", "batch", "generation", "video", "cache", "ingest"].includes(String(c["surface"] ?? "")) && isJsonObject(c["canonical_request"])) {
        out.push({ text, id: String(c["id"]), pinnedBody: typeof c["pinned_body"] === "string" ? c["pinned_body"] : undefined });
      }
    }
  }
  return out;
}

const skip = !SourceTextModule ? "needs --experimental-vm-modules" : !present ? "lm15-contract not checked out" : false;

test("web realm: the browser entry evaluates with only web globals and reports itself as the web platform", { skip }, async () => {
  const context = vm.createContext(webGlobals());
  assert.equal(vm.runInContext("typeof process", context), "undefined");
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  assert.equal(vm.runInContext("typeof require", context), "undefined");
  const web = await loadInRealm(resolve(here, "..", "src", "browser.ts"), context);
  const platform = (web["getDefaultPlatform"] as () => { name: string })();
  assert.equal(platform.name, "web");
  assert.ok(typeof web["LMRouter"] === "function" && typeof web["OpenAIChatLM"] === "function" && typeof web["ResponseStream"] === "function");
});

test("web realm: every corpus request builds to the same bytes as on the Node host; SigV4 alone is refused by name", { skip }, async () => {
  const context = vm.createContext(webGlobals());
  const driver = await loadInRealm(resolve(here, "realm_driver.ts"), context);
  const buildInRealm = driver["buildRequestJson"] as (caseJson: string) => Promise<string>;
  assert.equal((driver["getDefaultPlatform"] as () => { name: string })().name, "web");
  assert.equal(hostDriver.getDefaultPlatform().name, "node");
  let same = 0;
  let signed = 0;
  for (const { text, id } of wireCases()) {
    const [host, realm] = await Promise.all([hostDriver.buildRequestJson(text), buildInRealm(text)]);
    const realmOut = JSON.parse(realm) as JsonObject;
    if (realmOut["signs"] === true && realmOut["refused"]) {
      // The only difference a page may show: no SigV4 signer. The host signed; the realm refused by name, before the wire.
      const hostOut = JSON.parse(host) as JsonObject;
      assert.equal(realmOut["refused"], "NotConfiguredError", id);
      assert.match(String(realmOut["message"]), /SigV4 signing is not available on the web platform/, id);
      assert.ok(hostOut["refused"] === undefined || hostOut["signs"] === true, id);
      signed++;
      continue;
    }
    assert.equal(realm, host, `${id}: the web realm and the Node host built different bytes`);
    same++;
  }
  assert.ok(same > 300, `only ${same} cases agreed`);
  assert.ok(signed > 0, "the corpus carries SigV4 cases; none were seen");
});

test("web realm: every pinned body parses to the same canonical response as on the Node host", { skip }, async () => {
  const context = vm.createContext(webGlobals());
  const driver = await loadInRealm(resolve(here, "realm_driver.ts"), context);
  const parseInRealm = driver["parseBodyJson"] as (caseJson: string, bodyBase64: string) => string;
  let n = 0;
  for (const { text, id, pinnedBody } of wireCases()) {
    if (pinnedBody === undefined) continue;
    const bodyPath = join(contract, "bodies", id, pinnedBody);
    if (!existsSync(bodyPath)) continue;
    const body = readFileSync(bodyPath).toString("base64");
    assert.equal(parseInRealm(text, body), hostDriver.parseBodyJson(text, body), `${id}: the web realm and the Node host parsed differently`);
    n++;
  }
  assert.ok(n > 300, `only ${n} bodies compared`);
});
