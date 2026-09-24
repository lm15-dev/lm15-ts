import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync, deflateSync, deflateRawSync } from "node:zlib";
import { BROWSER_NEGOTIATED_CODINGS, FetchTransport, platformNegotiatesCoding } from "../src/transport.ts";
import { NodeTransport } from "../src/transport_node.ts";
import { ProtocolError, ProviderError, TransportError } from "../src/errors.ts";
import { parseProviderJson, stringifyJson } from "../src/json.ts";
import { HttpResponse, jsonBytes, type TransportRequest } from "../src/wire.ts";

const body = Buffer.from('{"text":"hello 🌍","value":123}');
const wire = (url: string): TransportRequest => ({ method: "GET", url, headers: [], body: new Uint8Array() });

async function withReply(coding: string, encoded: Uint8Array, use: (url: string) => Promise<void>, split = 0): Promise<void> {
  const host = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": coding });
    if (split) {
      let offset = 0;
      const write = () => {
        if (response.destroyed) return;
        if (offset >= encoded.length) { response.end(); return; }
        response.write(encoded.subarray(offset, offset + split));
        offset += split;
        setImmediate(write);
      };
      write();
    } else response.end(encoded);
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const address = host.address();
  assert.ok(address && typeof address !== "string");
  try { await use(`http://127.0.0.1:${address.port}`); }
  finally { host.closeAllConnections(); await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve())); }
}

test("INV055 refuses lone surrogates in values, nested values and keys before encoding", () => {
  for (const cp of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
    const text = String.fromCharCode(cp);
    const point = `U+${cp.toString(16).toUpperCase()}`;
    for (const value of [text, { nested: [text] }, { [text]: 1 }]) {
      assert.throws(() => stringifyJson(value), error => error instanceof TypeError && error.message.includes(point));
      assert.throws(() => jsonBytes(value), TypeError);
    }
  }
  assert.equal(stringifyJson({ "🌍": "A🌍B" }), '{"🌍":"A🌍B"}');
});

test("INV054 malformed success is non-retryable ProviderError with bounded byte evidence", () => {
  const response = new HttpResponse({ status: 200, headers: [
    ["Content-Type", "text/html"], ["X-Request-ID", "request-123"],
    ["Retry-After", "2"], ["X-RateLimit-Remaining-Tokens", "0"],
  ], body: new TextEncoder().encode("<html>" + "é".repeat(200)) });
  assert.throws(() => parseProviderJson(response, "example"), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "provider");
    assert.equal(error.retryable, false);
    assert.equal(error.status, 200);
    assert.equal(error.provider, "example");
    assert.equal(error.contentType, "text/html");
    assert.equal(error.requestId, "request-123");
    assert.equal(error.retryAfter, 2);
    assert.deepEqual(error.rateLimitHeaders["x-ratelimit-remaining-tokens"], ["0"]);
    assert.equal(error.bodyExcerpt, new TextDecoder().decode(response.body.subarray(0, 200)));
    return true;
  });
  // The wire helper is the integration point used by ordinary and auxiliary dialects.
  assert.throws(() => response.json(), ProviderError);
});

test("malformed UTF8 is a provider reply fault, not replacement text or an escaped codec error", () => {
  assert.throws(() => parseProviderJson(new HttpResponse({ status: 201, body: new Uint8Array([34, 0xff, 34]) })), ProviderError);
});

test("Fetch enforces exposed coding policy but NEVER inflates already-decoded bytes", async () => {
  for (const coding of ["gzip", "x-gzip", "deflate"]) {
    const transport = new FetchTransport({ fetch: async () => new Response(body, { headers: { "Content-Encoding": coding } }) });
    try { assert.deepEqual(Buffer.from(await (await transport.send(wire("https://example.invalid/"))).bytes()), body); }
    finally { transport.close(); }
  }
  for (const coding of ["br", "zstd", "unrecognized"]) {
    let cancelled = false;
    const transport = new FetchTransport({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Encoding": coding } }) });
    try {
      await assert.rejects(transport.send(wire("https://example.invalid/")), error => error instanceof ProtocolError && error instanceof TransportError && error.message.includes(coding));
      assert.equal(cancelled, true);
    } finally { transport.close(); }
  }
});

test("INV-053 in a browser: br/zstd the platform negotiated itself arrive decoded and are accepted, never decoded again; other codings still refused", async () => {
  // Node's own Request keeps Accept-Encoding, so this realm is not a browser: the default stays strict.
  assert.equal(platformNegotiatesCoding(), false);
  for (const coding of ["br", "zstd", "gzip, br"]) {
    const transport = new FetchTransport({ platformDecodedCodings: BROWSER_NEGOTIATED_CODINGS, fetch: async () => new Response(body, { headers: { "Content-Encoding": coding } }) });
    try { assert.deepEqual(Buffer.from(await (await transport.send(wire("https://example.invalid/"))).bytes()), body, coding); }
    finally { transport.close(); }
  }
  const strict = new FetchTransport({ platformDecodedCodings: BROWSER_NEGOTIATED_CODINGS, fetch: async () => new Response(body, { headers: { "Content-Encoding": "snappy" } }) });
  try { await assert.rejects(strict.send(wire("https://example.invalid/")), ProtocolError); }
  finally { strict.close(); }
});

test("Node decodes gzip/x-gzip/wrapped and raw deflate and reversed stacked coding exactly once", async () => {
  const cases: Array<[string, Uint8Array]> = [
    ["gzip", gzipSync(body)], ["x-gzip", gzipSync(body)],
    ["deflate", deflateSync(body)], ["deflate", deflateRawSync(body)],
    ["gzip, deflate", deflateSync(gzipSync(body))],
  ];
  const transport = new NodeTransport();
  try {
    for (const [coding, bytes] of cases) for (const split of [0, 1, 2, 7]) {
      await withReply(coding, bytes, async url => {
        const response = await transport.send(wire(url));
        assert.deepEqual(Buffer.from(await response.bytes()), body);
      }, split);
    }
  } finally { transport.close(); }
});

test("gzip parses every concatenated/empty member, even after zero padding across chunks", async () => {
  const encoded = Buffer.concat([gzipSync(body.subarray(0, 10)), Buffer.alloc(3), gzipSync(Buffer.alloc(0)), gzipSync(body.subarray(10)), Buffer.alloc(4)]);
  const transport = new NodeTransport();
  try {
    for (const split of [0, 1, 2, 9]) await withReply("gzip", encoded, async url => {
      assert.deepEqual(Buffer.from(await (await transport.send(wire(url))).bytes()), body);
    }, split);
  } finally { transport.close(); }
});

test("corrupt/truncated later gzip member and deflate trailing data are typed protocol faults", async () => {
  const corrupted = Buffer.from(gzipSync(body));
  corrupted[corrupted.length - 8] = corrupted[corrupted.length - 8]! ^ 1;
  const cases: Array<[string, Uint8Array]> = [
    ["gzip", Buffer.concat([gzipSync(body), corrupted])],
    ["gzip", Buffer.concat([gzipSync(body), Buffer.alloc(2), gzipSync(body).subarray(0, 14)])],
    ["gzip", Buffer.concat([gzipSync(body), Buffer.from("bad trailing bytes")])],
    ["deflate", Buffer.concat([deflateSync(body), Buffer.from([1, 2, 3])])],
    ["deflate", deflateSync(body).subarray(0, 5)],
  ];
  const transport = new NodeTransport({ maxConnections: 1 });
  try {
    for (const [coding, bytes] of cases) for (const split of [0, 1]) await withReply(coding, bytes, async url => {
      await assert.rejects((await transport.send(wire(url))).bytes(), ProtocolError);
    }, split);
    // A decoder failure must release the only admission slot.
    await withReply("gzip", gzipSync(body), async url => {
      assert.deepEqual(Buffer.from(await (await transport.send(wire(url))).bytes()), body);
    });
  } finally { transport.close(); }
});

test("Node rejects unknown codings before handing out response bytes", async () => {
  const transport = new NodeTransport({ maxConnections: 1 });
  try {
    for (const coding of ["br", "zstd", "snappy"]) await withReply(coding, body, async url => {
      await assert.rejects(transport.send(wire(url)), error => error instanceof ProtocolError && error.message.includes(coding));
    });
  } finally { transport.close(); }
});
