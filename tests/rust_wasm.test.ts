/**
 * lm15-rs as a wasm codec, hosted by Node: the same artifact a page loads.
 *
 * 1. The C ABI round-trips: version, a typed refusal, a request built.
 * 2. One standard across languages, at runtime: every request case in the
 *    contract corpus builds to the same method, URL, headers and body in
 *    Rust-under-wasm as in TypeScript; every pinned body parses to the
 *    same canonical response; the incremental decoder, fed a stream in
 *    arbitrary cuts, yields the same events and Response as a whole-body
 *    replay.
 *
 * Skips, saying why, when the artifact cannot be built (no sibling
 * checkout, no cargo) or the contract is absent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RustCodec, RustCodecError } from "../examples/provider-page/runtimes/rust.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { ensureRustWasm, root } from "../tools/rust_wasm.ts";
import * as hostDriver from "./realm_driver.ts";

installNodePlatform();

const contract = process.env["LM15_CONTRACT_DIR"] ?? resolve(root, "..", "lm15-contract");
const artifact = ensureRustWasm();
const skip = "skip" in artifact ? artifact.skip : false;

let codecPromise: Promise<RustCodec> | undefined;
const codec = () => (codecPromise ??= RustCodec.load(readFileSync((artifact as { path: string }).path)));

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

function wireCases(): Array<{ text: string; id: string; provider: string; pinnedBody: string | undefined }> {
  const out: Array<{ text: string; id: string; provider: string; pinnedBody: string | undefined }> = [];
  for (const dir of readdirSync(join(contract, "cases"))) {
    for (const file of readdirSync(join(contract, "cases", dir))) {
      const text = readFileSync(join(contract, "cases", dir, file), "utf-8");
      const c = JSON.parse(text) as { id: string; provider: string; surface?: string; canonical_request?: unknown; pinned_body?: string };
      if (!["models", "live", "files", "batch", "generation", "video", "cache", "ingest"].includes(c.surface ?? "") && c.canonical_request) {
        out.push({ text, id: c.id, provider: c.provider, pinnedBody: c.pinned_body });
      }
    }
  }
  return out;
}

test("Rust wasm: the C ABI answers, refuses by name, and builds a request", { skip }, async () => {
  const rust = await codec();
  const version = rust.version();
  assert.equal(version.language, "rust");
  assert.match(version.version, /^\d+\.\d+\.\d+/);
  assert.throws(() => rust.buildRequest({ provider: "nope", apiKey: "k" }, { model: "m", messages: [] }, false), (e: unknown) => e instanceof RustCodecError && e.name === "NotConfiguredError" && /unknown provider/.test(e.message));
  const wire = rust.buildRequest({ provider: "openai-chat", apiKey: "k" }, { model: "gpt-4.1-mini", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }, true);
  assert.equal(wire.url, "https://api.openai.com/v1/chat/completions");
  assert.equal((wire.body as { stream: boolean }).stream, true);
});

test("Rust wasm: every corpus request builds to the same request in Rust-under-wasm as in TypeScript", { skip: skip || (!existsSync(join(contract, "AUTHORITY.md")) && "lm15-contract not checked out"), timeout: 120_000 }, async () => {
  const rust = await codec();
  let same = 0;
  let refusedBoth = 0;
  for (const { text, id } of wireCases()) {
    const c = JSON.parse(text) as { provider: string; canonical_request: unknown; stream?: boolean; credential?: { kind: string; value?: string }; api_key?: string; base_url?: string; settings?: Record<string, string>; now?: string };
    const ts = JSON.parse(await hostDriver.buildRequestJson(text)) as { refused?: string; code?: string; signs?: boolean; method: string; url: string; headers: Array<[string, string]>; body: string };
    let rs: { method: string; url: string; params: Record<string, string>; headers: Record<string, string>; body: unknown; body_b64?: string } | undefined;
    let refusal: RustCodecError | undefined;
    try {
      // The vet protocol's message, verbatim: the credential object when the case carries one.
      rs = rust.call("build_request", { provider: c.provider, canonical_request: c.canonical_request, stream: Boolean(c.stream), ...(c.credential ? { credential: c.credential } : { api_key: c.api_key ?? "test-key-123" }), base_url: c.base_url, settings: c.settings, now: c.now });
    } catch (e) {
      if (!(e instanceof RustCodecError)) throw e;
      refusal = e;
    }
    if (refusal || ts.refused) {
      assert.ok(refusal && ts.refused, `${id}: one side refused and the other did not (rust=${refusal?.name} ts=${ts.refused})`);
      assert.equal(refusal.code, ts.code, `${id}: refusal codes differ`);
      refusedBoth++;
      continue;
    }
    const rsBody = rs!.body_b64 !== undefined ? Buffer.from(rs!.body_b64, "base64").toString("utf-8") : rs!.body;
    assert.deepEqual(
      comparable({ method: ts.method, url: ts.url, headers: ts.headers, body: Buffer.from(ts.body, "base64").toString("utf-8") }),
      comparable({ method: rs!.method, url: rs!.url, params: rs!.params, headers: rs!.headers, body: rsBody }),
      `${id}: Rust-under-wasm and TypeScript built different requests`,
    );
    same++;
  }
  assert.ok(same > 300, `only ${same} cases agreed`);
  assert.ok(refusedBoth > 0, "the corpus carries pinned refusals; both sides must refuse them");
  console.log(`# rust wasm differential: ${same} requests identical, ${refusedBoth} refused identically`);
});

test("Rust wasm: every pinned body parses to the same canonical response as TypeScript; the incremental decoder equals a whole-body replay", { skip: skip || (!existsSync(join(contract, "AUTHORITY.md")) && "lm15-contract not checked out"), timeout: 120_000 }, async () => {
  const rust = await codec();
  let parsed = 0;
  let streams = 0;
  for (const { text, id, provider, pinnedBody } of wireCases()) {
    if (!pinnedBody) continue;
    const bodyPath = join(contract, "bodies", id, pinnedBody);
    if (!existsSync(bodyPath)) continue;
    const body = readFileSync(bodyPath);
    const c = JSON.parse(text) as { canonical_request: unknown; stream?: boolean; base_url?: string; settings?: Record<string, string>; now?: string };
    const ts = JSON.parse(hostDriver.parseBodyJson(text, body.toString("base64"))) as { refused?: string; code?: string; canonical_response?: unknown; events?: unknown[] };
    const isStream = c.stream === true || /^(event:|data:)/.test(body.subarray(0, 64).toString("utf-8").trimStart());
    const connection = { provider, baseUrl: c.base_url, settings: c.settings };
    let rs: { canonical_response?: unknown; events?: unknown[] } | undefined;
    let refusal: RustCodecError | undefined;
    try {
      rs = isStream
        ? rust.call("replay_stream", { ...connection, base_url: c.base_url, canonical_request: c.canonical_request, body_b64: body.toString("base64"), now: c.now })
        : rust.call("parse_response", { ...connection, base_url: c.base_url, canonical_request: c.canonical_request, status: 200, body_b64: body.toString("base64"), now: c.now });
    } catch (e) {
      if (!(e instanceof RustCodecError)) throw e;
      refusal = e;
    }
    if (refusal || ts.refused) {
      assert.ok(refusal && ts.refused, `${id}: one side refused parsing and the other did not (rust=${refusal?.name} ts=${ts.refused})`);
      continue;
    }
    assert.deepEqual(rs!.canonical_response, ts.canonical_response, `${id}: Rust-under-wasm and TypeScript parsed different responses`);
    parsed++;
    if (isStream) {
      // The incremental decoder, fed in three arbitrary cuts, must equal the whole-body replay.
      const stream = rust.openStream({ provider, baseUrl: c.base_url, settings: c.settings }, c.canonical_request);
      const cuts = [Math.floor(body.length / 3), Math.floor((2 * body.length) / 3)];
      const events = [...stream.feed(body.subarray(0, cuts[0])), ...stream.feed(body.subarray(cuts[0], cuts[1])), ...stream.feed(body.subarray(cuts[1]))];
      const closed = stream.close();
      assert.deepEqual([...events, ...closed.events], rs!.events, `${id}: incremental events differ from the replay`);
      assert.deepEqual(closed.canonical_response, rs!.canonical_response, `${id}: incremental response differs from the replay`);
      streams++;
    }
  }
  assert.ok(parsed > 300, `only ${parsed} bodies compared`);
  assert.ok(streams > 30, `only ${streams} streams decoded incrementally`);
  console.log(`# rust wasm differential: ${parsed} bodies identical, ${streams} streams decoded incrementally`);
});
