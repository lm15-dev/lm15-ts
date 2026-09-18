/**
 * The client-side stop (MAP-13, `client_side` on `config.stop`): a stop
 * sequence the wire cannot take is honoured after the wire — the visible
 * text is cut at the first sequence, on a plain call and as it streams,
 * and the source is closed at the cut.
 *
 * Scores after a cut (spec/types.md § Scores after a client-side stop,
 * ratified 2026-09-15): keep the original scores of whole tokens entirely
 * before the cut; a token the cut lands inside keeps its visible text but
 * loses its score and the coverage flag goes false; never invent a score
 * for shortened text. Alignment uses token bytes, or token spellings only
 * when their UTF-8 concatenation reproduces the original text exactly;
 * when no alignment exists every score of the shortened event is dropped
 * and coverage is marked incomplete. Unmatched stops leave events alone.
 *
 * Whether the provider then stops generating (and billing) on a closed
 * connection is its own behaviour, not a promise made here. What lm15 does
 * promise: after a cut the end event carries no usage (the final frame was
 * never read) — "not reported", never estimated.
 */

import type { Response, TokenLogprob } from "./types/response.ts";
import { normalizePart, type Part, type TextPart } from "./types/parts.ts";
import { StreamEvent as StreamEventNs, type StreamEvent, type TextDelta } from "./types/stream.ts";

const encoder = new TextEncoder();

function firstStop(text: string, stop: readonly string[]): [number, string] | undefined {
  let best: [number, string] | undefined;
  for (const seq of stop) {
    if (!seq) continue;
    const idx = text.indexOf(seq);
    if (idx >= 0 && (best === undefined || idx < best[0])) best = [idx, seq];
  }
  return best;
}

/** Keep original scores for whole retained tokens; never score a token fragment. */
export function scoresBeforeCut(scores: readonly TokenLogprob[] | undefined, text: string, cutAt: number): [readonly TokenLogprob[], boolean] {
  if (!scores || scores.length === 0 || cutAt === 0) return [[], false];
  if (cutAt === text.length) return [scores, false];
  const tokenBytes = scores.map((s) => (s.bytes !== undefined ? Uint8Array.from(s.bytes) : encoder.encode(s.token)));
  const original = encoder.encode(text);
  const boundary = encoder.encode(text.slice(0, cutAt)).length;
  const joinedLength = tokenBytes.reduce((n, b) => n + b.length, 0);
  if (joinedLength !== original.length) return [[], true];
  let offset = 0;
  for (const bytes of tokenBytes) {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== original[offset + i]) return [[], true];
    offset += bytes.length;
  }
  let end = 0;
  for (let index = 0; index < tokenBytes.length; index++) {
    if (end === boundary) return [scores.slice(0, index), false];
    end += tokenBytes[index]!.length;
    if (end > boundary) return [scores.slice(0, index), true];
  }
  return [scores, false];
}

/**
 * Cut the response's visible text at the first stop sequence. The text
 * parts are one stream in document order: a sequence that starts at the
 * end of one part and finishes at the start of the next is a hit (a
 * provider's own stop works on the token stream and knows no block
 * boundary). The part holding the start is cut there; every later part is
 * removed.
 */
export function applyClientSideStop(response: Response, stop: readonly string[] | undefined): Response {
  if (!stop || stop.length === 0) return response;
  const textParts = response.message.parts.map((p, i) => [i, p] as const).filter((e): e is readonly [number, TextPart] => e[1].type === "text");
  const joined = textParts.map(([, p]) => p.text).join("");
  const hit = firstStop(joined, stop);
  if (hit === undefined) return response;
  let offset = 0;
  let cutIndex = textParts[textParts.length - 1]![0];
  let cutAt = 0;
  for (const [index, part] of textParts) {
    if (offset + part.text.length > hit[0]) {
      cutIndex = index;
      cutAt = hit[0] - offset;
      break;
    }
    offset += part.text.length;
  }
  const parts: Part[] = [];
  for (const [index, part] of response.message.parts.entries()) {
    if (index > cutIndex) break;
    parts.push(index === cutIndex ? normalizePart({ ...(part as TextPart), text: (part as TextPart).text.slice(0, cutAt) }) : part);
  }
  if (parts.length === 0) parts.push(normalizePart({ type: "text", text: "" }));
  const [scores, incomplete] = scoresBeforeCut(response.logprobs, joined, hit[0]);
  return response.with({
    message: { ...response.message, parts },
    finishReason: "stop",
    logprobs: scores.length > 0 ? scores : undefined,
    logprobsComplete: response.logprobsComplete && !incomplete,
  });
}

function isTextDelta(event: StreamEvent): event is StreamEvent & { type: "delta"; delta: TextDelta } {
  return event.type === "delta" && event.delta.type === "text";
}

/**
 * Keep original events until their text is safe, then pass them unchanged.
 * A possible stop suffix holds its entire event, plus intervening events to
 * preserve order. Only the event actually cut is reconstructed. This can
 * delay delivery by an event boundary, but never splits token scores just
 * to release text earlier.
 */
export class StopCutter {
  readonly stop: readonly string[];
  private readonly hold: number;
  private segments: StreamEvent[] = [];
  cut = false;

  constructor(stop: readonly string[]) {
    this.stop = stop.filter((s) => s.length > 0);
    this.hold = Math.max(1, ...this.stop.map((s) => s.length)) - 1;
  }

  private take(count: number, cutting = false): StreamEvent[] {
    const out: StreamEvent[] = [];
    while (this.segments.length > 0) {
      const event = this.segments[0]!;
      if (!isTextDelta(event)) {
        out.push(this.segments.shift()!);
        continue;
      }
      const delta = event.delta;
      if (cutting && count === 0) break;
      if (delta.text.length <= count) {
        out.push(this.segments.shift()!);
        count -= delta.text.length;
      } else if (cutting) {
        const [scores, incomplete] = scoresBeforeCut(delta.logprobs, delta.text, count);
        out.push(
          StreamEventNs.create({
            ...event,
            delta: { ...delta, text: delta.text.slice(0, count), logprobs: scores, logprobsComplete: delta.logprobsComplete !== false && !incomplete },
          }),
        );
        break;
      } else break;
    }
    return out;
  }

  feed(event: StreamEvent): StreamEvent[] {
    if (!isTextDelta(event)) {
      if (this.segments.length === 0) return [event];
      this.segments.push(event);
      return [];
    }
    this.segments.push(event);
    const buf = this.segments.filter(isTextDelta).map((e) => e.delta.text).join("");
    const hit = firstStop(buf, this.stop);
    if (hit !== undefined) {
      const out = this.take(hit[0], true);
      this.segments = [];
      this.cut = true;
      return out;
    }
    return this.take(Math.max(0, buf.length - this.hold));
  }

  flush(): StreamEvent[] {
    const out = this.segments;
    this.segments = [];
    return out;
  }

  /** The events to emit for one incoming event, and whether the stream is now cut. */
  step(event: StreamEvent): StreamEvent[] {
    if (event.type === "end" || event.type === "error") return [...this.flush(), event];
    return this.feed(event);
  }
}

const CUT_END: StreamEvent = StreamEventNs.create({ type: "end", finishReason: "stop" });

export function* truncateStreamAtStop(events: Iterable<StreamEvent>, stop: readonly string[] | undefined): Generator<StreamEvent> {
  const cutter = new StopCutter(stop ?? []);
  if (cutter.stop.length === 0) {
    yield* events;
    return;
  }
  const it = events[Symbol.iterator]();
  try {
    for (;;) {
      const next = it.next();
      if (next.done) return;
      yield* cutter.step(next.value);
      if (cutter.cut) {
        yield CUT_END;
        return;
      }
    }
  } finally {
    it.return?.();
  }
}

export async function* truncateStreamAtStopAsync(events: AsyncIterable<StreamEvent>, stop: readonly string[] | undefined): AsyncGenerator<StreamEvent> {
  const cutter = new StopCutter(stop ?? []);
  if (cutter.stop.length === 0) {
    yield* events;
    return;
  }
  const it = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      yield* cutter.step(next.value);
      if (cutter.cut) {
        yield CUT_END;
        return;
      }
    }
  } finally {
    await it.return?.();
  }
}
