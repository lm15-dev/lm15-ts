/**
 * SSE (Server-Sent Events) parser — zero dependencies.
 */

export interface SSEEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Parse an SSE byte stream into events.
 *
 * Follows the EventSource spec: blank lines delimit events,
 * `data:` lines are joined with newlines, `event:` sets the event name.
 */
export async function* parseSSE(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last partial line in the buffer
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");

      if (line === "") {
        // Blank line = end of event
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
        }
        eventName = undefined;
        dataLines = [];
        continue;
      }

      if (line.startsWith(":")) continue; // comment

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  // Flush remaining
  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}
