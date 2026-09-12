/**
 * Job handles: `BatchJob` and `VideoJob` (api-family § Beyond chat;
 * contract `changes/2026-09-11-job-handles-live-turns-profiles.md` § 1).
 *
 * A batch and a video are tickets on every wire that sells them: submit,
 * poll, wait, fetch. The handle owns the two things users get wrong
 * without it — what counts as terminal, and the forgot-to-reassign-a-
 * stale-status bug — and nothing else. The four pure operations on the
 * adapter (`batchSubmit` … `batchList`, `videoSubmit` … `videoList`)
 * stay the wire truth; the handle is sugar over them, never a second
 * reader.
 *
 * - `info` is one frozen snapshot; `id` / `status` / `done` read it and
 *   never contact the provider.
 * - `refresh()` and `wait()` replace the snapshot in place and return the
 *   handle.
 * - `wait()` is the only thing that waits. It polls until `done`; a
 *   `failed` job RETURNS (the status says so), it does not throw. A
 *   deadline that elapses throws a `DOMException` named `TimeoutError`
 *   (the `AbortSignal.timeout` convention): it is the caller's own
 *   deadline, not a provider or lm15 failure, so it carries no ErrorCode.
 */

import type { ProviderLM } from "./adapter.ts";
import type { BatchEntry, BatchJobInfo, VideoJobInfo } from "./types/endpoints.ts";
import type { VideoPart } from "./types/parts.ts";
import { BatchJobInfo as BatchJobInfoNs, VideoJobInfo as VideoJobInfoNs } from "./types/endpoints.ts";
import type { BatchStatus, VideoStatus } from "./vocab.ts";

export interface WaitOptions {
  /** Poll cadence. Defaults: batch 30 s, video 5 s (the reference's). */
  readonly pollEveryMs?: number;
  /** Give up after this long; throws a `TimeoutError` DOMException. */
  readonly timeoutMs?: number;
  /** Abort the wait (throws the signal's reason). */
  readonly signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal!.reason); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function timeoutError(what: string, id: string, status: string, timeoutMs: number): DOMException {
  return new DOMException(`${what} ${id} still ${JSON.stringify(status)} after ${timeoutMs} ms`, "TimeoutError");
}

async function poll<I>(
  what: string,
  read: () => I,
  isDone: (info: I) => boolean,
  idOf: (info: I) => string,
  statusOf: (info: I) => string,
  refresh: () => Promise<void>,
  defaultPollMs: number,
  opts: WaitOptions,
): Promise<void> {
  const pollEveryMs = opts.pollEveryMs ?? defaultPollMs;
  if (!(pollEveryMs > 0)) throw new RangeError("pollEveryMs must be a positive number of milliseconds");
  const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  for (;;) {
    const info = read();
    if (isDone(info)) return;
    if (deadline !== undefined && Date.now() >= deadline) throw timeoutError(what, idOf(info), statusOf(info), opts.timeoutMs!);
    await sleep(pollEveryMs, opts.signal);
    await refresh();
  }
}

/** A live handle on one provider-side batch job. */
export class BatchJob {
  private readonly lm: ProviderLM;
  private snapshot: BatchJobInfo;

  constructor(lm: ProviderLM, info: BatchJobInfo) {
    this.lm = lm;
    this.snapshot = info;
  }

  /** The frozen snapshot from the last provider contact. */
  get info(): BatchJobInfo { return this.snapshot; }
  get id(): string { return this.snapshot.id; }
  get status(): BatchStatus { return this.snapshot.status; }
  get label(): string | undefined { return this.snapshot.label; }
  get done(): boolean { return BatchJobInfoNs.done(this.snapshot); }

  async refresh(): Promise<this> {
    this.snapshot = await this.lm.batchStatus(this.snapshot.id);
    return this;
  }

  /** Poll until terminal. A convenience for small jobs and notebooks; the primary pattern for real workloads is store the id and re-attach. */
  async wait(opts: WaitOptions = {}): Promise<this> {
    await poll("batch", () => this.snapshot, (i) => BatchJobInfoNs.done(i), (i) => i.id, (i) => i.status, () => this.refresh().then(() => undefined), 30_000, opts);
    return this;
  }

  results(): Promise<BatchEntry[]> { return this.lm.batchResults(this.snapshot.id); }

  async cancel(): Promise<this> {
    this.snapshot = await this.lm.batchCancel(this.snapshot.id);
    return this;
  }

  toString(): string {
    const label = this.snapshot.label ? ` label=${JSON.stringify(this.snapshot.label)}` : "";
    return `BatchJob(id=${JSON.stringify(this.snapshot.id)}, status=${JSON.stringify(this.snapshot.status)}${label})`;
  }
}

/** A live handle on one provider-side video job. */
export class VideoJob {
  private readonly lm: ProviderLM;
  private snapshot: VideoJobInfo;

  constructor(lm: ProviderLM, info: VideoJobInfo) {
    this.lm = lm;
    this.snapshot = info;
  }

  get info(): VideoJobInfo { return this.snapshot; }
  get id(): string { return this.snapshot.id; }
  get status(): VideoStatus { return this.snapshot.status; }
  /** 0–100 when the provider reports it. */
  get progress(): number | undefined { return this.snapshot.progress; }
  get done(): boolean { return VideoJobInfoNs.done(this.snapshot); }

  async refresh(): Promise<this> {
    this.snapshot = await this.lm.videoStatus(this.snapshot.id);
    return this;
  }

  /** Poll until terminal; `failed` returns, it does not throw — check `status`. */
  async wait(opts: WaitOptions = {}): Promise<this> {
    await poll("video", () => this.snapshot, (i) => VideoJobInfoNs.done(i), (i) => i.id, (i) => i.status, () => this.refresh().then(() => undefined), 5_000, opts);
    return this;
  }

  /** The finished video as a `VideoPart` (URL- or bytes-addressed, the provider's own delivery mode). */
  result(): Promise<VideoPart> { return this.lm.videoResult(this.snapshot.id); }

  toString(): string {
    return `VideoJob(id=${JSON.stringify(this.snapshot.id)}, status=${JSON.stringify(this.snapshot.status)}, progress=${this.snapshot.progress ?? "undefined"})`;
  }
}
