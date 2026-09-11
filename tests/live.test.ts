// These tests import lm15 internals; the Node host is installed here as the `lm15` entry does on import.
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSession } from "../src/live.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { TransportError } from "../src/errors.ts";
import type { LiveServerEvent } from "../src/types/live.ts";

function socketFactory(opts: { connect?: "open" | "close" | "error" | "hang"; setup?: "ok" | "close" | "error" | "reject" | "hang"; closeAck?: boolean; immediateText?: boolean } = {}) {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    binaryType = "arraybuffer";
    frames: string[] = [];
    closeCalls = 0;
    constructor() {
      super(); sockets.push(this);
      queueMicrotask(() => { const event = opts.connect ?? "open"; if (event !== "hang") this.dispatchEvent(new Event(event)); });
    }
    message(body: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) })); }
    send(frame: string) {
      this.frames.push(frame);
      if (this.frames.length !== 1) return;
      const setup = opts.setup ?? "ok";
      if (setup === "close" || setup === "error") this.dispatchEvent(new Event(setup));
      else if (setup === "reject") this.message({ error: { status: "INVALID_ARGUMENT", message: "bad setup" } });
      else if (setup === "ok") this.message({ setupComplete: {} });
      if (opts.immediateText) this.message({ type: "response.output_text.delta", delta: "immediate" });
    }
    close() { this.closeCalls++; if (opts.closeAck !== false) queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  }
  return { WebSocket: Socket as unknown as typeof WebSocket, sockets };
}
const gemini = () => new GeminiLM({ apiKey: "fake" });

test("live rejects a socket closing or failing during connection/setup", { timeout: 3000 }, async () => {
  for (const opts of [{ connect: "close" }, { connect: "error" }, { setup: "close" }, { setup: "error" }, { setup: "reject" }] as const) {
    const fake = socketFactory(opts);
    await assert.rejects(LiveSession.open(gemini(), { model: "m" }, { WebSocket: fake.WebSocket, timeoutMs: 1000 }));
    assert.ok(fake.sockets[0]!.closeCalls > 0);
  }
});

test("live setup and connection have bounded waits", { timeout: 2000 }, async () => {
  for (const opts of [{ connect: "hang" }, { setup: "hang" }] as const) {
    const fake = socketFactory(opts);
    await assert.rejects(LiveSession.open(gemini(), { model: "m" }, { WebSocket: fake.WebSocket, timeoutMs: 15 }), TransportError);
    assert.ok(fake.sockets[0]!.closeCalls > 0);
  }
});

test("immediate OpenAI replies are received, and byte audio is encoded", async () => {
  const fake = socketFactory({ immediateText: true });
  const session = await new OpenAILM({ apiKey: "fake" }).live({ model: "m" }, { WebSocket: fake.WebSocket });
  assert.deepEqual(await session.recv(), { type: "text", text: "immediate" });
  await session.sendAudio(new Uint8Array([0, 1]));
  assert.deepEqual(JSON.parse(fake.sockets[0]!.frames[1]!), { type: "input_audio_buffer.append", audio: "AAE=" });
  const waiting = session.recv();
  await session.close();
  assert.equal(await waiting, undefined);
  await session.close();
});

test("abort interrupts connection and session reads; pre-abort does not open a socket", async () => {
  const fake = socketFactory();
  await assert.rejects(LiveSession.open(gemini(), { model: "m" }, { WebSocket: fake.WebSocket, signal: AbortSignal.abort() }), TransportError);
  assert.equal(fake.sockets.length, 0);
  const controller = new AbortController();
  const session = await LiveSession.open(gemini(), { model: "m" }, { WebSocket: fake.WebSocket, signal: controller.signal });
  const pending = session.recv();
  controller.abort();
  await assert.rejects(pending, TransportError);
  await assert.rejects(session.sendText("late"), /closed/);
});

test("decoder errors reject pending receivers instead of escaping event dispatch", async () => {
  class Broken extends GeminiLM {
    override decodeLiveServerEvent(raw: Uint8Array | string): LiveServerEvent[] {
      if (String(raw).includes("setupComplete")) return [];
      throw new Error("bad decoder");
    }
  }
  const fake = socketFactory();
  const session = await LiveSession.open(new Broken({ apiKey: "fake" }), { model: "m" }, { WebSocket: fake.WebSocket });
  const pending = session.recv();
  fake.sockets[0]!.message({ bad: true });
  await assert.rejects(pending, /decoding/);
});

test("close is bounded and idempotent even without a peer acknowledgement", { timeout: 2000 }, async () => {
  const fake = socketFactory({ closeAck: false });
  const session = await LiveSession.open(gemini(), { model: "m" }, { WebSocket: fake.WebSocket, closeTimeoutMs: 15 });
  const close = session.close();
  assert.equal(session.close(), close);
  await assert.rejects(close, /close timed out/);
  await assert.rejects(session.recv(), /close timed out/);
});
