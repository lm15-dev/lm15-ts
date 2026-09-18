// Job handles and live turns (api-family § Beyond chat; contract
// changes/2026-09-11-job-handles-live-turns-profiles.md § 1 and § 2).
// Scripted transports and sockets only; no network. The pure verbs are
// pinned by the harness; these pin the handle rules on top of them.
import { installNodePlatform } from "../src/platform_node.ts";

installNodePlatform();

import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { BatchJob, VideoJob } from "../src/jobs.ts";
import { LiveSession, materializeTurn, sumUsage } from "../src/live.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";
import type { LiveServerEvent } from "../src/types/live.ts";
import { Usage } from "../src/types/response.ts";

const video = (status: string, extra: Record<string, unknown> = {}) =>
  new FakeResponse({ status: 200, body: JSON.stringify({ id: "video_1", object: "video", model: "sora-2", status, progress: status === "completed" ? 100 : 40, created_at: 1, ...extra }) });
const batchBody = (status: string) => ({ id: "batch_1", object: "batch", status, created_at: 1, input_file_id: "f", endpoint: "/v1/responses", completion_window: "24h" });
const batch = (status: string) => new FakeResponse({ status: 200, body: JSON.stringify(batchBody(status)) });

test("VideoJob: reading properties never contacts the provider; refresh and wait replace the snapshot in place", async () => {
  const transport = new FakeTransport([video("queued"), video("in_progress"), video("completed")]);
  const lm = new OpenAILM({ apiKey: "k", transport });
  const job = await lm.videoGenerate({ model: "sora-2", prompt: "a fox" });
  assert.ok(job instanceof VideoJob);
  assert.equal(job.id, "video_1");
  assert.equal(job.status, "queued");
  assert.equal(job.done, false);
  assert.equal(transport.requests.length, 1); // properties are the snapshot
  const same = await job.wait({ pollEveryMs: 1 });
  assert.equal(same, job); // returns the handle, mutated in place
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(job.done, true);
  assert.equal(transport.requests.length, 3);
  assert.match(String(job), /VideoJob\(id="video_1", status="completed", progress=100\)/);
});

test("VideoJob.wait: failed returns (the status says so); a deadline that elapses throws the caller's TimeoutError", async (t) => {
  const failed = new OpenAILM({ apiKey: "k", transport: new FakeTransport([video("in_progress"), video("failed", { error: { message: "moderation" } })]) });
  const job = await failed.videoJob("video_1");
  await job.wait({ pollEveryMs: 1 });
  assert.equal(job.status, "failed");

  const transport = new FakeTransport([video("queued"), video("queued"), video("queued"), video("queued")]);
  const slow = new OpenAILM({ apiKey: "k", transport });
  const stuck = await slow.videoJob("video_1");
  // Advance two milliseconds per scripted request. Real 1 ms timers can wake
  // early or late; their scheduling must not exhaust this finite fake script.
  t.mock.method(Date, "now", () => transport.requests.length * 2);
  await assert.rejects(stuck.wait({ pollEveryMs: 1, timeoutMs: 5 }), (e: unknown) => e instanceof DOMException && e.name === "TimeoutError" && /video_1 still "queued" after 5 ms/.test(e.message));
  assert.equal(transport.requests.length, 4);
  assert.equal(stuck.done, false); // the snapshot tells the truth after the deadline
  // An aborted wait throws the signal's reason and stops polling.
  const controller = new AbortController();
  const p = stuck.wait({ pollEveryMs: 50, signal: controller.signal });
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(p, /cancelled by caller/);
  await assert.rejects(stuck.wait({ pollEveryMs: 0 }), RangeError);
});

test("BatchJob: submit → handle; re-attach by id; list as handles; cancel replaces the snapshot", async () => {
  const transport = new FakeTransport([batch("in_progress"), batch("cancelling")]);
  const lm = new OpenAILM({ apiKey: "k", transport });
  const job = await lm.batchJob("batch_1");
  assert.ok(job instanceof BatchJob);
  assert.equal(job.status, "running"); // OpenAI's in_progress is the canonical `running`
  assert.equal(job.done, false);
  await job.cancel();
  assert.equal(job.status, "cancelling");
  const listing = new OpenAILM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({ status: 200, body: JSON.stringify({ object: "list", data: [batchBody("completed"), batchBody("failed")] }) })]) });
  const jobs = await listing.batches();
  assert.deepEqual(jobs.map((j) => [j.constructor.name, j.status, j.done]), [["BatchJob", "completed", true], ["BatchJob", "failed", true]]);
});

// ─── Live turns (LIVE-1, LIVE-2) ─────────────────────────────────────

const usage = (n: number) => Usage.create({ inputTokens: n, outputTokens: n });

test("LIVE-2: a turn's bill sums every usage and turn_end it saw; absent on either side stays absent", () => {
  const a = Usage.create({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3 });
  const b = Usage.create({ inputTokens: 1, outputTokens: 1 });
  const sum = sumUsage(a, b);
  assert.equal(sum.inputTokens, 11);
  assert.equal(sum.outputTokens, 6);
  assert.equal(sum.totalTokens, 17);
  assert.equal(sum.reasoningTokens, undefined); // absent on one side: unknown, never zero
  assert.equal(sumUsage(undefined, a), a);

  const turn = materializeTurn([
    { type: "usage", usage: usage(75) }, // the tool-call response's tokens open the continuation turn
    { type: "text", text: "Hel" },
    { type: "audio", data: "AAE=", mediaType: "audio/pcm;rate=24000" },
    { type: "text", text: "lo" },
    { type: "audio", data: "Ag==" },
    { type: "turn_end", usage: usage(20) },
  ]);
  assert.equal(turn.endedBy, "turn_end");
  assert.equal(turn.ok, true);
  assert.equal(turn.text, "Hello");
  assert.deepEqual([...turn.audio], [0, 1, 2]);
  assert.equal(turn.audioMediaType, "audio/pcm;rate=24000");
  assert.deepEqual(turn.usage, usage(95));
  assert.equal(turn.events.length, 6);
});

test("LIVE-1: result() returns at a tool_call (the caller must answer); an interrupted turn keeps its usage; error is the terminal", () => {
  const atCall = materializeTurn([{ type: "text", text: "Let me check" }, { type: "tool_call", id: "c1", name: "weather", input: { city: "Montreal" } }]);
  assert.equal(atCall.endedBy, "tool_call");
  assert.equal(atCall.ok, false);
  assert.deepEqual(atCall.toolCalls, [{ id: "c1", name: "weather", input: { city: "Montreal" } }]);
  const interrupted = materializeTurn([{ type: "text", text: "Once upon" }, { type: "usage", usage: usage(143) }, { type: "interrupted" }]);
  assert.equal(interrupted.endedBy, "interrupted");
  assert.deepEqual(interrupted.usage, usage(143)); // no longer free on paper
  const errored = materializeTurn([{ type: "error", error: { code: "server", message: "boom" } }]);
  assert.equal(errored.endedBy, "error");
  assert.equal(errored.error?.message, "boom");
  const cut = materializeTurn([{ type: "text", text: "cut" }]);
  assert.equal(cut.endedBy, "incomplete"); // no terminal at all: not ok, and not an error the peer sent
  assert.equal(cut.ok, false);
});

function geminiSocket(frames: unknown[]) {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    binaryType = "arraybuffer";
    sent: string[] = [];
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    message(body: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) })); }
    send(frame: string) {
      this.sent.push(frame);
      if (this.sent.length === 1) { this.message({ setupComplete: {} }); return; }
      // Every client frame after setup replays the scripted server frames.
      for (const f of frames) this.message(f);
    }
    close() { queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
  }
  return { WebSocket: Socket as unknown as typeof WebSocket, sockets };
}

test("session.turn(): iteration ends itself at turn_end; a tool_call is yielded mid-turn; the session stays open for the next turn", async () => {
  const fake = geminiSocket([
    { serverContent: { modelTurn: { parts: [{ text: "Hi " }] } } },
    { toolCall: { functionCalls: [{ id: "c1", name: "weather", args: { city: "Montreal" } }] } },
    { serverContent: { modelTurn: { parts: [{ text: "there" }] }, turnComplete: true }, usageMetadata: { promptTokenCount: 3, responseTokenCount: 2, totalTokenCount: 5 } },
  ]);
  const session = await LiveSession.open(new GeminiLM({ apiKey: "fake" }), { model: "m" }, { WebSocket: fake.WebSocket });
  await session.sendText("hello");
  const seen: string[] = [];
  for await (const event of session.turn()) seen.push(event.type);
  assert.deepEqual(seen, ["text", "tool_call", "text", "turn_end"]); // tool_call did not end iteration; turn_end did

  await session.sendText("again");
  const turn = await session.turn().result();
  assert.equal(turn.endedBy, "tool_call"); // result() stops where the caller must answer
  assert.equal(turn.text, "Hi ");
  assert.equal(turn.toolCalls[0]!.name, "weather");
  // The rest of that turn is still on the session; a second turn() drains it.
  const rest = await session.turn().result();
  assert.equal(rest.endedBy, "turn_end");
  assert.equal(rest.text, "there");
  assert.equal(rest.usage?.totalTokens, 5);
  await session.close();
  // A closed socket before a boundary is a transport fault, never a silent empty turn (the reference's rule).
  const { TransportError } = await import("../src/errors.ts");
  await assert.rejects(async () => { for await (const _e of session.turn()) { /* nothing arrives */ } }, TransportError);
});

test("bounded turn collection (2026-09-15): max_events fails before consuming; max_bytes rejects the event that cannot fit; the view seals, the session stays open", async () => {
  const { CollectionLimitError } = await import("../src/errors.ts");
  const { liveEventSize, incompleteTurn } = await import("../src/live.ts");
  const fake = geminiSocket([
    { serverContent: { modelTurn: { parts: [{ text: "one " }] } } },
    { serverContent: { modelTurn: { parts: [{ text: "two " }] } } },
    { serverContent: { modelTurn: { parts: [{ text: "three" }] }, turnComplete: true } },
  ]);
  const session = await LiveSession.open(new GeminiLM({ apiKey: "fake" }), { model: "m" }, { WebSocket: fake.WebSocket });
  await session.sendText("go");
  const view = session.turn({ maxEvents: 2 });
  const seen: string[] = [];
  const failure = await (async () => {
    try {
      for await (const e of view) seen.push(e.type);
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  assert.ok(failure instanceof CollectionLimitError);
  assert.equal(failure.code, "collection_limit");
  assert.equal(failure.retryable, false);
  assert.equal(failure.limit, "max_events");
  assert.equal(failure.maximum, 2);
  assert.equal(failure.retainedEvents, 2);
  assert.equal(failure.rejectedEvent, undefined); // a count overflow performed no receive
  assert.deepEqual(seen, ["text", "text"]); // already-yielded events stay in the collection
  assert.equal((failure.partial as { endedBy: string; ok: boolean; text: string }).endedBy, "incomplete");
  assert.equal((failure.partial as { text: string }).text, "one two ");
  assert.equal(view.snapshot().ok, false);
  await assert.rejects(view.result(), CollectionLimitError); // sealed: the same failure, no further read
  // The session is open: the unread event is still there for a raw read.
  const rest = await session.recv();
  assert.equal(rest?.type, "text");
  assert.equal((await session.recv())?.type, "turn_end");

  await session.sendText("again");
  const tiny = session.turn({ maxBytes: liveEventSize({ type: "text", text: "one " }) + 4 });
  const byteFailure = await (async () => {
    try {
      for await (const _e of tiny) { /* consume */ }
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  assert.ok(byteFailure instanceof CollectionLimitError, String(byteFailure));
  assert.equal(byteFailure.limit, "max_bytes");
  assert.equal(byteFailure.retainedEvents, 1);
  assert.deepEqual(byteFailure.rejectedEvent, { type: "text", text: "two " }); // received, neither yielded nor retained
  assert.equal(incompleteTurn(byteFailure.partialEvents as never).text, "one ");
  assert.throws(() => session.turn({ maxEvents: 0 }), /positive integer/);
  assert.throws(() => session.turn({ maxBytes: 1.5 }), /positive integer/);
  await session.close();
});

test("liveEventSize: compact ASCII JSON — non-ASCII code units cost six bytes, a slash one", async () => {
  const { liveEventSize } = await import("../src/live.ts");
  assert.equal(liveEventSize({ type: "text", text: "a/b" }), '{"type":"text","text":"a/b"}'.length);
  assert.equal(liveEventSize({ type: "text", text: "é" }), '{"type":"text","text":"\\u00e9"}'.length);
  assert.equal(liveEventSize({ type: "text", text: "😀" }), '{"type":"text","text":"\\ud83d\\ude00"}'.length);
  assert.ok(liveEventSize({ type: "text", text: "abcdef" }, 5) > 5); // counting stops once the budget is exceeded
});
