/**
 * The encrypted-tunnel fetch (src/tunnel): HTTP/1.1 written and read over a
 * TLS session, through a WebSocket, with a pass-through TLS double and a
 * scripted WebSocket. No network. The real TLS module and tunnel are exercised
 * live by /tmp-style scripts and the playground (see the lm15-contract
 * browser.json receipts); a server with a publicly trusted certificate cannot
 * be faked offline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { tunnelFetch } from "../src/tunnel/tunnel.ts";
import type { TlsEngine, TlsSession } from "../src/tunnel/tls.ts";
import { tunnelRelay } from "../src/login/engine.ts";
import { loginAdapter, loginWay } from "../src/login/run.ts";
import type { LoginOutcome } from "../src/login/types.ts";

/** A TLS "session" that encrypts nothing: what goes in plain comes out as "TLS", and back. */
function passThroughEngine(log: { hosts: string[] }): TlsEngine {
  return {
    open(host: string): TlsSession {
      log.hosts.push(host);
      let toPeer: Uint8Array[] = [];
      let fromPeer: Uint8Array[] = [];
      let handshakeDone = false;
      let peerClosed = false;
      return {
        pushTls: (data) => {
          if (!handshakeDone) { handshakeDone = true; return; } // the first message completes the "handshake"
          if (data.length === 0) peerClosed = true; else fromPeer.push(data);
        },
        pushPlain: (data) => { toPeer.push(data); },
        pullTls: () => { const out = Buffer.concat(toPeer); toPeer = []; return new Uint8Array(out); },
        pullPlain: () => {
          if (fromPeer.length) { const out = Buffer.concat(fromPeer); fromPeer = []; return new Uint8Array(out); }
          return peerClosed ? null : new Uint8Array(0);
        },
        handshaking: () => !handshakeDone,
        close: () => {},
        free: () => {},
      };
    },
  } as unknown as TlsEngine;
}

/** A WebSocket whose peer is a script: it receives the request bytes and answers with `reply` chunks. */
function scriptedWebSocket(reply: (request: string) => Array<string | Uint8Array>, seen: { urls: string[]; requests: string[] }) {
  return class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    #request = "";
    constructor(url: string) {
      seen.urls.push(url);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        this.#deliver(new Uint8Array([22])); // server hello: completes the pass-through handshake
      });
    }
    #deliver(bytes: Uint8Array) {
      const copy = bytes.slice();
      queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
    }
    send(data: Uint8Array) {
      this.#request += Buffer.from(data).toString("latin1");
      if (!this.#request.includes("\r\n\r\n")) return;
      const [head, body = ""] = this.#request.split("\r\n\r\n");
      const length = Number(/content-length: (\d+)/i.exec(head!)?.[1] ?? 0);
      if (Buffer.byteLength(body, "latin1") < length) return;
      seen.requests.push(this.#request);
      for (const chunk of reply(this.#request)) this.#deliver(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
  } as unknown as typeof WebSocket;
}

test("the request is written as HTTP/1.1 for the provider's host: no Origin, identity encoding, our User-Agent, exact body", async () => {
  const log = { hosts: [] as string[] };
  const seen = { urls: [] as string[], requests: [] as string[] };
  const WS = scriptedWebSocket(() => ["HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n", '{"ok":true}'], seen);
  const f = tunnelFetch({ url: "wss://tunnel.example/tunnel", tls: passThroughEngine(log), WebSocket: WS });
  const res = await f("https://auth.x.ai/oauth2/token?x=1", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "lm15/test" }, body: "a=1&b=2" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(log.hosts, ["auth.x.ai"]);
  assert.equal(seen.urls[0], "wss://tunnel.example/tunnel?host=auth.x.ai");
  const req = seen.requests[0]!;
  assert.match(req, /^POST \/oauth2\/token\?x=1 HTTP\/1\.1\r\nHost: auth\.x\.ai\r\n/);
  assert.match(req, /\r\nuser-agent: lm15\/test\r\n/);
  assert.match(req, /\r\naccept-encoding: identity\r\n/);
  assert.match(req, /\r\nContent-Length: 7\r\nConnection: close\r\n\r\na=1&b=2$/);
  assert.ok(!/\r\norigin:/i.test(req));
});

test("a chunked reply split at awkward places reads back whole; 1xx heads are skipped", async () => {
  const seen = { urls: [] as string[], requests: [] as string[] };
  const WS = scriptedWebSocket(() => [
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nX-Id: r1\r\n\r\n5\r\nhel", "lo\r\n6", "\r\n world\r\n0\r\n\r\n",
  ], seen);
  const res = await tunnelFetch({ url: "wss://t/tunnel", tls: passThroughEngine({ hosts: [] }), WebSocket: WS })("https://api.github.com/zen");
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-id"), "r1");
  assert.equal(await res.text(), "hello world");
});

test("a close-delimited body ends at the peer's close; a length body cut short is an error", async () => {
  const seen = { urls: [] as string[], requests: [] as string[] };
  const close = scriptedWebSocket(() => ["HTTP/1.1 200 OK\r\n\r\nall of it", new Uint8Array(0)], seen);
  assert.equal(await (await tunnelFetch({ url: "wss://t/tunnel", tls: passThroughEngine({ hosts: [] }), WebSocket: close })("https://a.example/")).text(), "all of it");
  const cut = scriptedWebSocket(() => ["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort", new Uint8Array(0)], seen);
  const res = await tunnelFetch({ url: "wss://t/tunnel", tls: passThroughEngine({ hosts: [] }), WebSocket: cut })("https://a.example/");
  await assert.rejects(res.text(), /closed mid-body/);
});

test("only https on 443; an abort before the reply rejects as an AbortError", async () => {
  const seen = { urls: [] as string[], requests: [] as string[] };
  const WS = scriptedWebSocket(() => [], seen);
  const f = tunnelFetch({ url: "wss://t/tunnel", tls: passThroughEngine({ hosts: [] }), WebSocket: WS });
  await assert.rejects(f("http://a.example/"), TypeError);
  await assert.rejects(f("https://a.example:8443/"), TypeError);
  const controller = new AbortController();
  const pending = f("https://a.example/", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === "AbortError");
});

test("with a tunnel relay, model calls keep the provider's URL and travel encrypted; the way says so", () => {
  const relay = tunnelRelay("wss://tunnel.example/tunnel", { stages: ["inference", "catalog"], tls: passThroughEngine({ hosts: [] }) });
  const outcome: LoginOutcome = { provider: "claude-code", methodId: "browser", material: { type: "oauth", access: "A", refresh: "R" }, label: "Claude", renewal: "refresh_token", settings: {} };
  const adapter = loginAdapter(outcome, { platform: "browser", relay });
  assert.equal(adapter.baseUrl, "https://api.anthropic.com/v1");
  assert.deepEqual(loginWay(outcome, "inference", { platform: "browser", relay }), { via: "https://tunnel.example", encrypted: true });
});
