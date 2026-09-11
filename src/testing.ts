/** Deterministic test doubles. No network, credential discovery, or tool execution. */
import type { Transport, TransportResponse } from "./transport.ts";
import type { TransportRequest } from "./wire.ts";
import { checkAborted } from "./async.ts";
import { Request } from "./types/config.ts";
import { Message } from "./types/parts.ts";
import { Response } from "./types/response.ts";
import type { StreamEvent } from "./types/stream.ts";
import { responseToEvents } from "./stream.ts";

/** The canonical seam for applications (also implemented by providers and routers). */
export interface LanguageModel {
  complete(request: Request, opts?: { signal?: AbortSignal }): Promise<Response>;
  stream(request: Request, opts?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

export class FakeLM implements LanguageModel {
  readonly requests: Request[] = [];
  private readonly script: Array<Response | string | Error>;

  constructor(responses: Iterable<Response | string | Error> = []) { this.script = [...responses]; }

  async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    checkAborted(opts.signal);
    const req = Request.create(request);
    const item = this.script.shift();
    if (item === undefined) throw new Error("FakeLM ran out of scripted responses");
    this.requests.push(req);
    if (item instanceof Error) throw item;
    return typeof item === "string" ? new Response({ model: req.model, message: Message.assistant(item), finishReason: "stop" }) : item;
  }

  async *stream(request: Request, opts: { signal?: AbortSignal } = {}): AsyncGenerator<StreamEvent> {
    const response = await this.complete(request, opts);
    for (const event of responseToEvents(response)) { checkAborted(opts.signal); yield event; }
  }
}

export class FakeResponse implements TransportResponse {
  readonly status: number;
  readonly reason: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  private readonly body: Uint8Array[];
  private consumed = false;
  cancelled = false;

  constructor(fields: { status?: number; reason?: string; headers?: ReadonlyArray<readonly [string, string]>; body?: string | Uint8Array; chunks?: readonly Uint8Array[] } = {}) {
    this.status = fields.status ?? 200;
    this.reason = fields.reason ?? "OK";
    this.headers = fields.headers ?? [["content-type", "application/json"]];
    this.body = (fields.chunks ?? [typeof fields.body === "string" ? new TextEncoder().encode(fields.body) : fields.body ?? new Uint8Array()]).map((c) => c.slice());
  }

  async *chunks(): AsyncGenerator<Uint8Array> {
    if (this.consumed) throw new TypeError("response body has already been consumed");
    this.consumed = true;
    let ended = false;
    try {
      if (this.cancelled) throw new Error("FakeResponse was cancelled");
      for (const chunk of this.body) {
        if (this.cancelled) throw new Error("FakeResponse was cancelled");
        yield chunk.slice();
      }
      ended = true;
    } finally { if (!ended) await this.cancel(); }
  }

  async bytes(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.chunks()) parts.push(chunk);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  async cancel(): Promise<void> { this.cancelled = true; }
}

export class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  private readonly script: Array<TransportResponse | Error>;
  constructor(responses: Iterable<TransportResponse | Error> = []) { this.script = [...responses]; }

  async send(request: TransportRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<TransportResponse> {
    checkAborted(opts.signal);
    const item = this.script.shift();
    if (item === undefined) throw new Error("FakeTransport ran out of scripted responses");
    this.requests.push({ ...request, body: request.body.slice(), headers: request.headers.map(([k, v]) => [k, v] as const) });
    if (item instanceof Error) throw item;
    return item;
  }
}
