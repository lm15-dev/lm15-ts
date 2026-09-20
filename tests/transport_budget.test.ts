import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { createServer as createTcpServer, type Socket } from "node:net";
import { FetchTransport, Timeouts, TransportSlots } from "../src/transport.ts";
import { NodeTransport } from "../src/transport_node.ts";
import { TransportError, UnsupportedFeatureError } from "../src/errors.ts";
import type { TransportRequest } from "../src/wire.ts";

const wire = (url = "https://example.invalid/"): TransportRequest => ({ url, method: "GET", headers: [], body: new Uint8Array() });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function server(handler: RequestListener) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  } };
}

test("connection budgets are immutable shared defaults, validated in seconds", () => {
  const timeouts = new Timeouts();
  assert.deepEqual({ ...timeouts }, { connect: 10, read: 600, write: 600, pool: 600 });
  assert.ok(Object.isFrozen(timeouts));
  assert.equal(new Timeouts({ read: 900 }).read, 900);
  for (const read of [0, -1, Infinity, NaN]) assert.throws(() => new Timeouts({ read }), RangeError);
  for (const n of [0, -1, 1.5, Infinity]) assert.throws(() => new TransportSlots(n), RangeError);
  for (const field of ["connect", "write", "pool"] as const) {
    assert.throws(() => new FetchTransport({ timeouts: { [field]: 600 } }), UnsupportedFeatureError);
  }
  const native = new NodeTransport();
  assert.equal(native.maxConnections, 100);
  native.close();
});

test("admission slots transfer FIFO, remove aborted waiters and close all queued callers", async () => {
  const slots = new TransportSlots(1);
  const first = await slots.acquire(1000);
  const abort = new AbortController();
  const cancelled = slots.acquire(1000, abort.signal);
  const rejection = assert.rejects(cancelled, TransportError);
  abort.abort();
  await rejection;
  const second = slots.acquire(1000);
  first(); first(); // idempotent release
  const release = await second;
  const queued = assert.rejects(slots.acquire(1000), /closed/);
  slots.close();
  release();
  await queued;
  await assert.rejects(slots.acquire(1000), /closed/);
});

test("Fetch budgets retain admission until body release and cancellation unblocks the queue", async () => {
  let calls = 0;
  let cancellations = 0;
  const transport = new FetchTransport({ maxConnections: 1, poolTimeoutMs: 1000, fetch: async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }));
  } });
  try {
    const first = await transport.send(wire());
    const second = transport.send(wire());
    await pause(5);
    assert.equal(calls, 1);
    await first.cancel!();
    const response = await second;
    assert.equal(calls, 2);
    await response.cancel!();
    assert.equal(cancellations, 2);
  } finally { transport.close(); }
});

test("Fetch times out local admission, headers and body with named client knobs", async () => {
  const transport = new FetchTransport({ maxConnections: 1, poolTimeoutMs: 10, fetch: async () => new Response(new ReadableStream()) });
  const response = await transport.send(wire());
  try { await assert.rejects(transport.send(wire()), /pool timeout/); }
  finally { await response.cancel!(); transport.close(); }
  const head = new FetchTransport({ headersTimeoutMs: 10, fetch: () => new Promise(() => {}) });
  try { await assert.rejects(head.send(wire()), /headersTimeoutMs/); } finally { head.close(); }
  const read = new FetchTransport({ readTimeoutMs: 10, fetch: async () => new Response(new ReadableStream()) });
  try { await assert.rejects((await read.send(wire())).bytes(), /Timeouts.read/); } finally { read.close(); }
});

test("Fetch close interrupts headers and queued calls even if injected fetch ignores signals", async () => {
  const transport = new FetchTransport({ maxConnections: 1, fetch: () => new Promise(() => {}) });
  const active = assert.rejects(transport.send(wire()), TransportError);
  const queued = assert.rejects(transport.send(wire()), TransportError);
  transport.close();
  await Promise.all([active, queued]);
  await assert.rejects(transport.send(wire()), /closed/);
});

test("Fetch cancellation cannot hang on an injected body's never-settling cancel", async () => {
  const transport = new FetchTransport({ maxConnections: 1, fetch: async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })) });
  try {
    const first = await transport.send(wire());
    await first.cancel!();
    const next = await transport.send(wire());
    await next.cancel!();
  } finally { transport.close(); }
});

test("Node pools/reuses connections, advertises identity, and caller read overrides win", async () => {
  const ports: Array<number | undefined> = [];
  const host = await server((request, response) => {
    ports.push(request.socket.remotePort);
    assert.equal(request.headers["accept-encoding"], "identity");
    setTimeout(() => response.end("ok"), 30);
  });
  const transport = new NodeTransport({ timeouts: { read: 0.01 }, maxConnections: 1 });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await transport.send({ ...wire(host.url), readTimeout: 1 });
      assert.equal(new TextDecoder().decode(await response.bytes()), "ok");
    }
    assert.equal(ports[0], ports[1]);
    await assert.rejects(transport.send(wire(host.url)), /Timeouts.read/);
  } finally { transport.close(); await host.close(); }
});

test("Node queue deadline, active response cancel and transport close release ownership", async () => {
  const host = await server((_request, response) => { response.writeHead(200); response.flushHeaders(); });
  const transport = new NodeTransport({ maxConnections: 1, timeouts: { pool: 0.01 } });
  try {
    const response = await transport.send(wire(host.url));
    await assert.rejects(transport.send(wire(host.url)), /pool timeout/);
    await response.cancel!();
    const next = await transport.send(wire(host.url));
    const pendingRead = assert.rejects(next.bytes(), TransportError);
    transport.close();
    await pendingRead;
  } finally { transport.close(); await host.close(); }
});

test("Node write budget bounds an upload whose peer stops reading", async () => {
  const host = await server(request => request.pause());
  const transport = new NodeTransport({ timeouts: { write: 0.05, read: 2 } });
  try {
    await assert.rejects(transport.send({ ...wire(host.url), method: "POST", body: new Uint8Array(32 * 1024 * 1024) }), /Timeouts.write/);
  } finally { transport.close(); await host.close(); }
});

test("Node connect budget includes a stalled TLS handshake", async () => {
  const sockets = new Set<Socket>();
  const listener = createTcpServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const transport = new NodeTransport({ timeouts: { connect: 0.02, read: 1 } });
  try { await assert.rejects(transport.send(wire(`https://127.0.0.1:${address.port}`)), /Timeouts.connect/); }
  finally {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});

test("Node body read budget is idle, not total stream duration", async () => {
  const host = await server((_request, response) => {
    let left = 6;
    const timer = setInterval(() => { response.write("x"); if (--left === 0) { clearInterval(timer); response.end(); } }, 15);
    response.on("close", () => clearInterval(timer));
  });
  const transport = new NodeTransport({ timeouts: { read: 0.07 } });
  try {
    const response = await transport.send(wire(host.url));
    assert.equal(new TextDecoder().decode(await response.bytes()), "xxxxxx");
  } finally { transport.close(); await host.close(); }
});
