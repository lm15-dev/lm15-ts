/**
 * Server-Sent Events parsing (mirror of the reference lm15/sse.py).
 *
 * Parses an iterable of raw lines (already split, line terminators
 * stripped or not) into SSEEvent records. The shim replays captured
 * stream bodies, so the input is a string split on newlines; the field
 * grammar matches the reference exactly: `event:` names, `data:` lines
 * joined with "\n", `:` comments skipped, blank line dispatches.
 */

import { TransportError } from "./errors.js";

export interface SSEEvent {
  readonly event: string | null;
  readonly data: string;
}

const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;

export function parseSse(lines: Iterable<string>): SSEEvent[] {
  const events: SSEEvent[] = [];
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let eventBytes = 0;

  const flush = (): void => {
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join("\n") });
    }
    eventName = null;
    dataLines = [];
    eventBytes = 0;
  };

  for (const raw of lines) {
    const rawBytes = Buffer.byteLength(raw, "utf8");
    if (rawBytes > MAX_LINE_BYTES) {
      throw new TransportError(`SSE line exceeds limit (${rawBytes} > ${MAX_LINE_BYTES})`);
    }
    const line = raw.replace(/[\r\n]+$/, "");
    eventBytes += rawBytes;
    if (eventBytes > MAX_EVENT_BYTES) {
      throw new TransportError(`SSE event exceeds limit (${eventBytes} > ${MAX_EVENT_BYTES})`);
    }

    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^\s+/, ""));
      continue;
    }
  }

  flush();
  return events;
}

/** Split a replayed stream body into lines, preserving the reference's `bytes.splitlines` semantics closely enough for SSE (\n / \r\n / \r). */
export function splitBodyLines(body: string): string[] {
  if (body === "") return [];
  return body.split(/\r\n|\n|\r/);
}
