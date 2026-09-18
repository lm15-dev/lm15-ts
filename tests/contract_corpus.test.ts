/**
 * Replays the sibling lm15-contract corpus through the library directly:
 * serde vectors, error cases, SigV4 vectors, the router fixture, and every
 * pinned request / complete body / SSE stream that has a golden. The corpus
 * is never copied here; the tests skip when it is absent
 * (`LM15_CONTRACT_DIR` overrides the default `../lm15-contract`).
 *
 * `harness/check.py` remains the gate; this is the regression net for
 * `npm test`.
 */

// These tests import lm15 internals; the Node host is installed here as the `lm15` entry does on import.
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RawNumber, isJsonObject, jsonEquals, parseJson, stringifyJson, type JsonObject, type JsonValue } from "../src/json.ts";
import { serdeForKind, toJSON as canonicalJSON } from "../src/serde.ts";
import { adapterFor } from "../src/providers.ts";
import { Request } from "../src/types/config.ts";
import { Credential, AwsCredentials, parseRfc3339 } from "../src/types/credential.ts";
import { Response } from "../src/types/response.ts";
import { StreamEvent } from "../src/types/stream.ts";
import { HttpResponse, splitUrl } from "../src/wire.ts";
import { coalesceStream, materializeResponse, parseSse, splitLines } from "../src/stream.ts";
import { sign } from "../src/cloud/sigv4.ts";
import { resolveModel } from "../src/router.ts";
import { ModelInfo, ModelRegistry } from "../src/types/model_info.ts";
import { StreamAssemblyError, LM15Error } from "../src/errors.ts";

const root = process.env["LM15_CONTRACT_DIR"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "lm15-contract");
const present = existsSync(join(root, "AUTHORITY.md"));
const read = (p: string) => parseJson(readFileSync(join(root, p), "utf-8")) as JsonObject;
const API_KEY = "test-key-123";
const AUTH_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key"]);
const DROP_HEADERS = new Set(["user-agent", "accept", "accept-encoding", "content-length", "host"]);

test("corpus: serde/canonical.json round-trips exactly", { skip: !present }, () => {
  for (const c of read("serde/canonical.json")["cases"] as JsonObject[]) {
    const { fromJSON, toJSON } = serdeForKind(String(c["kind"]));
    const value = fromJSON(c["value"] as JsonObject);
    const out = toJSON(value);
    assert.ok(jsonEquals(out, canonicalJSON(value)), `generic serializer: ${c["id"]}`);
    assert.ok(jsonEquals(c["value"], out), `${c["id"]}: ${stringifyJson(out)}`);
  }
});

test("corpus: errors/cases/*.json map to the pinned class, code and provider_code", { skip: !present }, () => {
  for (const file of readdirSync(join(root, "errors/cases"))) {
    for (const c of read(`errors/cases/${file}`)["cases"] as JsonObject[]) {
      const lm = adapterFor(String(c["provider"]), { apiKey: "k", ...hostOptions(c) });
      const body = typeof c["body"] === "string" ? c["body"] : JSON.stringify(c["body"]);
      const err = lm.normalizeError(Number(c["status"]), body);
      const expected = c["expected"] as JsonObject;
      assert.equal(err.name, expected["class"], String(c["id"]));
      assert.equal(err.code, expected["code"], String(c["id"]));
      if ("provider_code" in expected) assert.equal(err.providerCode, expected["provider_code"], String(c["id"]));
    }
  }
});

test("corpus: the 34 SigV4 vectors, byte for byte", { skip: !present }, () => {
  const sig = read("auth/sigv4-vectors.json");
  const fixed = sig["fixed"] as JsonObject;
  for (const c of sig["cases"] as JsonObject[]) {
    const req = c["request"] as JsonObject;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(isJsonObject(req["headers"]) ? req["headers"] : {})) {
      if (["host", "x-amz-date", "x-amz-security-token"].includes(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.map(String).join(",") : String(v);
    }
    const pinnedToken = isJsonObject(req["headers"]) ? Object.entries(req["headers"]).find(([k]) => k.toLowerCase() === "x-amz-security-token")?.[1] : undefined;
    const token = pinnedToken !== undefined ? String(pinnedToken) : typeof c["session_token"] === "string" ? c["session_token"] : undefined;
    const signature = sign({
      method: String(req["method"]),
      url: "https://example.amazonaws.com" + String(req["target"]),
      headers,
      payload: new TextEncoder().encode(String(req["body"] ?? "")),
      credentials: new AwsCredentials({ accessKeyId: String(fixed["access_key_id"]), secretAccessKey: String(fixed["secret_access_key"]), sessionToken: token }),
      region: String(fixed["region"]),
      service: String(fixed["service"]),
      now: parseRfc3339(String(fixed["now"])),
    });
    const expect = c["expect"] as JsonObject;
    const actual: Record<string, unknown> = { canonical_request: signature.canonicalRequest, string_to_sign: signature.stringToSign, authorization: signature.authorization, headers: signature.headers };
    for (const key of Object.keys(expect)) assert.ok(jsonEquals(expect[key], actual[key]), `sigv4.${c["id"]}.${key}`);
  }
});

test("corpus: router/resolution.json", { skip: !present }, () => {
  for (const c of read("router/resolution.json")["cases"] as JsonObject[]) {
    let registry: ModelRegistry | undefined;
    if ("catalog" in c) {
      registry = new ModelRegistry();
      for (const e of c["catalog"] as JsonObject[]) registry.add(ModelInfo.fromJSON(e), { replace: false });
    }
    const expect = c["expect"] as JsonObject;
    try {
      const r = resolveModel(String(c["model"]), { env: {}, ...(registry ? { registry } : {}) });
      assert.deepEqual({ provider: r.provider, model: r.model, source: r.source }, { provider: expect["provider"], model: expect["model"], source: expect["source"] }, String(c["id"]));
    } catch (e) {
      if (!(e instanceof LM15Error)) throw e;
      const raises = expect["error"] as JsonObject | undefined;
      assert.ok(raises, `${c["id"]}: unexpected ${e.name}`);
      assert.equal(e.name, raises["class"], String(c["id"]));
      assert.equal(e.code, raises["code"], String(c["id"]));
    }
  }
});

function hostOptions(c: JsonObject): { settings?: Record<string, string>; clock?: () => Date; baseUrl?: string } {
  const out: { settings?: Record<string, string>; clock?: () => Date; baseUrl?: string } = {};
  if (isJsonObject(c["settings"])) out.settings = Object.fromEntries(Object.entries(c["settings"]).map(([k, v]) => [k, String(v)]));
  if (typeof c["now"] === "string") {
    const fixed = parseRfc3339(c["now"]);
    out.clock = () => fixed;
  }
  if (typeof c["base_url"] === "string") out.baseUrl = c["base_url"];
  return out;
}

function wireCases(): JsonObject[] {
  const out: JsonObject[] = [];
  for (const dir of readdirSync(join(root, "cases"))) {
    for (const file of readdirSync(join(root, "cases", dir))) {
      const c = read(`cases/${dir}/${file}`);
      if (!["models", "live", "files", "batch", "generation", "video", "cache", "ingest"].includes(String(c["surface"] ?? ""))) out.push(c);
    }
  }
  return out;
}

/** Volatile paths compare by presence + type; usage int/float is tolerated (harness rules). */
function compare(expected: JsonValue, actual: JsonValue, path: string[], volatile: Set<string>, id: string): void {
  const rendered = "$." + path.join(".").replace(/\.\[/g, "[");
  if (volatile.has(rendered) || volatile.has(rendered.replace(/^\$\.canonical_response\./, "$.")) || volatile.has(rendered.replace(/^\$\./, ""))) {
    assert.equal(actual === undefined, false, `${id}: ${rendered} absent`);
    return;
  }
  if (isJsonObject(expected)) {
    assert.ok(isJsonObject(actual), `${id}: ${rendered} expected object`);
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (key === "provider_data" && path[path.length - 1] === undefined) continue;
      compare(expected[key] as JsonValue, actual[key] as JsonValue, [...path, key], volatile, id);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${id}: ${rendered} length`);
    expected.forEach((e, i) => compare(e, actual[i]!, [...path.slice(0, -1), `${path[path.length - 1]}[${i}]`], volatile, id));
    return;
  }
  if (path.some((p) => p.startsWith("usage")) && expected instanceof RawNumber === false && typeof expected === "number" && actual instanceof RawNumber) {
    assert.equal(actual.valueOf(), expected, `${id}: ${rendered}`);
    return;
  }
  assert.ok(jsonEquals(expected, actual), `${id}: ${rendered}: expected ${stringifyJson(expected)} got ${stringifyJson(actual)}`);
}

function ingestCases(): JsonObject[] {
  const out: JsonObject[] = [];
  for (const dir of readdirSync(join(root, "cases"))) {
    for (const file of readdirSync(join(root, "cases", dir))) {
      const c = read(`cases/${dir}/${file}`);
      if (c["surface"] === "ingest") {
        out.push(c);
        continue;
      }
      const url = String(((c["request"] as JsonObject | undefined) ?? {})["url"] ?? "").split("?")[0] ?? "";
      const raises = ((c["expect_lm15"] as JsonObject | undefined) ?? {})["raises"] as JsonObject | undefined;
      if (url.endsWith("/chat/completions") && isJsonObject(c["canonical_request"]) && raises?.["op"] !== "build_request") out.push(c);
    }
  }
  return out;
}

test("corpus: every recorded chat body reads back (MAP-12), lossy cells as pinned, foreign shapes as authored", { skip: !present }, () => {
  let roundTrips = 0, lossy = 0, foreign = 0, refusals = 0;
  for (const c of ingestCases()) {
    const id = String(c["id"]);
    const isSurface = c["surface"] === "ingest";
    const lm = adapterFor(String(c["provider"]), { apiKey: "vet-parse-only", ...hostOptions(c) }) as ReturnType<typeof adapterFor> & { requestFromOpenAIChat(body: unknown): Request };
    const body = isSurface ? c["body"] : (c["request"] as JsonObject)["body"];
    const raises = ((c["expect_lm15"] as JsonObject | undefined) ?? {})["raises"] as JsonObject | undefined;
    if (raises?.["op"] === "ingest_openai_chat") {
      assert.throws(() => lm.requestFromOpenAIChat(body), (e: unknown) => e instanceof LM15Error && e.name === raises["type"] && e.code === raises["code"], id);
      refusals++;
      continue;
    }
    const got = Request.toJSON(lm.requestFromOpenAIChat(body));
    let want: JsonValue;
    if (isSurface) {
      want = (c["expect_lm15"] as JsonObject)["canonical_request"] as JsonValue;
      foreign++;
    } else if (isJsonObject(c["ingest"])) {
      const classes = (c["ingest"] as JsonObject)["lossy"];
      assert.ok(Array.isArray(classes) && classes.length > 0, `${id}: an empty lossy declaration`);
      want = (c["ingest"] as JsonObject)["canonical_request"] as JsonValue;
      lossy++;
      roundTrips++;
    } else {
      want = c["canonical_request"] as JsonValue;
      roundTrips++;
    }
    compare(want, got, ["canonical_request"], new Set(), id);
  }
  assert.deepEqual([roundTrips, lossy, foreign, refusals], [125, 27, 33, 9], "case counts moved; move CONTRACT_PIN and these constants together");
});

test("corpus: every canonical request builds the pinned wire request", { skip: !present }, async () => {
  let n = 0;
  for (const c of wireCases()) {
    if (!isJsonObject(c["canonical_request"])) continue;
    const id = String(c["id"]);
    const expectRaise = isJsonObject((c["expect_lm15"] as JsonObject | undefined)?.["raises"]) ? ((c["expect_lm15"] as JsonObject)["raises"] as JsonObject) : undefined;
    const credential = isJsonObject(c["credential"]) ? Credential.fromJSON(c["credential"]) : API_KEY;
    const lm = adapterFor(String(c["provider"]), { apiKey: credential, ...hostOptions(c), ...(String(c["provider"]).replace(/_/g, "-") === "openai-codex" ? { accountId: "test-account" } : {}) });
    const request = Request.fromJSON(c["canonical_request"]);
    if (expectRaise?.["op"] === "build_request") {
      await assert.rejects(lm.buildRequest(request, Boolean(c["stream"])), (e: unknown) => e instanceof LM15Error && e.name === expectRaise["type"] && e.code === expectRaise["code"], id);
      n++;
      continue;
    }
    let built;
    try {
      built = await lm.buildRequest(request, Boolean(c["stream"]));
    } catch (e) {
      throw new Error(`${id}: ${(e as Error).message}`);
    }
    const [url, params] = splitUrl(built.url);
    const wire = c["request"] as JsonObject;
    const [expUrl, expParams] = splitUrl(String(wire["url"]));
    assert.equal(built.method, wire["method"], id);
    assert.equal(url, expUrl, id);
    assert.deepEqual(params, { ...expParams, ...(isJsonObject(wire["params"]) ? Object.fromEntries(Object.entries(wire["params"]).map(([k, v]) => [k, String(v)])) : {}) }, id);
    const pinnedString = isJsonObject(c["credential"]) && ["api_key", "bearer_token"].includes(String(c["credential"]["kind"]));
    const signs = credential instanceof AwsCredentials;
    const actualHeaders: Record<string, string> = {};
    for (const [k, v] of built.headers) if (!DROP_HEADERS.has(k.toLowerCase())) actualHeaders[k.toLowerCase()] = v;
    const expectedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(isJsonObject(wire["headers"]) ? wire["headers"] : {})) {
      const lower = k.toLowerCase();
      if (DROP_HEADERS.has(lower)) continue;
      let value = String(v);
      if (AUTH_HEADERS.has(lower) && !pinnedString && !signs) value = value.replace(/\$[A-Z_]+|REDACTED|[^ ]+$/, API_KEY).replace(/^Bearer .*$/, "Bearer " + API_KEY);
      if (lower === "authorization" && !signs && !pinnedString && !value.startsWith("Bearer")) value = API_KEY;
      expectedHeaders[lower] = value;
    }
    const volatile = new Set(Object.keys(isJsonObject(c["volatile"]) ? c["volatile"] : {}).map((k) => (k.startsWith("$.") ? k : `$.${k}`)));
    for (const [k, v] of Object.entries(expectedHeaders)) {
      if (signs && ["authorization", "x-amz-date", "x-amz-security-token"].includes(k)) {
        assert.equal(actualHeaders[k], v, `${id}: header ${k}`);
        continue;
      }
      if (AUTH_HEADERS.has(k)) continue; // the harness rewrites these; the direction test covers exactness
      assert.equal(actualHeaders[k], v, `${id}: header ${k}`);
    }
    const actualBody = built.body.length > 0 ? parseJson(new TextDecoder().decode(built.body)) : null;
    compare(wire["body"] as JsonValue, actualBody, ["body"], volatile, id);
    n++;
  }
  assert.ok(n > 300, `only ${n} request cases replayed`);
});

test("corpus: every pinned body with a golden parses to it (complete and stream)", { skip: !present }, () => {
  let n = 0;
  for (const c of wireCases()) {
    if (!isJsonObject(c["canonical_request"]) || typeof c["pinned_body"] !== "string") continue;
    const id = String(c["id"]);
    const goldenPath = join(root, "goldens", String(c["provider"]), `${c["feature"]}.json`);
    if (!existsSync(goldenPath)) continue;
    const golden = parseJson(readFileSync(goldenPath, "utf-8")) as JsonObject;
    const body = readFileSync(join(root, "bodies", id, c["pinned_body"]));
    const lm = adapterFor(String(c["provider"]), { apiKey: "vet-parse-only", ...hostOptions(c) });
    const request = Request.fromJSON(c["canonical_request"]);
    const volatile = new Set(Object.keys(isJsonObject(c["volatile"]) ? c["volatile"] : {}).map((k) => (k.startsWith("$.") ? k : `$.${k}`)));
    const raises = isJsonObject((c["expect_lm15"] as JsonObject | undefined)?.["raises"]) ? ((c["expect_lm15"] as JsonObject)["raises"] as JsonObject) : undefined;
    const isStream = c["stream"] === true || /^(event:|data:)/.test(new TextDecoder().decode(body.subarray(0, 64)).trimStart());
    if (isStream) {
      const raw: StreamEvent[] = [];
      for (const sse of parseSse(splitLines(new Uint8Array(body)))) raw.push(...lm.parseStreamEvents(request, sse));
      const events = [...coalesceStream(raw, { model: request.model })];
      if (raises?.["op"] === "replay_stream") {
        assert.throws(() => materializeResponse(events, request), (e: unknown) => e instanceof StreamAssemblyError && e.code === raises["code"], id);
        if (Array.isArray(golden["events"])) compareEvents(golden["events"] as JsonObject[], events.map(StreamEvent.toJSON), volatile, id);
        n++;
        continue;
      }
      const response = materializeResponse(events, request);
      compareEvents(golden["events"] as JsonObject[], events.map(StreamEvent.toJSON), volatile, id);
      compare(golden["canonical_response"] as JsonValue, Response.toJSON(response), ["canonical_response"], volatile, id);
    } else {
      if (raises?.["op"] === "parse_response") {
        assert.throws(() => lm.parseResponse(request, new HttpResponse({ status: 200, body: new Uint8Array(body) })), (e: unknown) => e instanceof LM15Error && e.name === raises["type"], id);
        n++;
        continue;
      }
      const response = lm.parseResponse(request, new HttpResponse({ status: 200, body: new Uint8Array(body) }));
      assert.equal(response.providerData?.["_lm15_unmapped"], undefined, `${id}: unmapped`);
      compare(golden["canonical_response"] as JsonValue, Response.toJSON(response), ["canonical_response"], volatile, id);
    }
    n++;
  }
  assert.ok(n > 300, `only ${n} parse cases replayed`);
});

/** The end event's provider_data compares by presence and JSON type only (MAP-3, D9). */
function compareEvents(expected: JsonObject[], actual: JsonObject[], volatile: Set<string>, id: string): void {
  assert.equal(actual.length, expected.length, `${id}: event count ${actual.length} vs ${expected.length}`);
  expected.forEach((e, i) => {
    const a = actual[i]!;
    if (e["type"] === "end") {
      const { provider_data: ep, ...eRest } = e;
      const { provider_data: ap, ...aRest } = a;
      if (ep !== undefined) assert.equal(typeof ap, typeof ep, `${id}: events[${i}].provider_data type`);
      compare(eRest, aRest, [`events[${i}]`], volatile, id);
    } else compare(e, a, [`events[${i}]`], volatile, id);
  });
}
