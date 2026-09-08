/**
 * The HTTP transport: `fetch` (Node 22+ ships it; zero dependencies).
 * A `Transport` is the one seam a test or a proxy replaces.
 */

import { TransportError } from "./errors.ts";
import { HttpResponse, type TransportRequest } from "./wire.ts";

export interface TransportResponse {
  readonly status: number;
  readonly reason: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Buffer the whole body. */
  bytes(): Promise<Uint8Array>;
  /** Stream the body as byte chunks. */
  chunks(): AsyncIterable<Uint8Array>;
}

export interface Transport {
  send(request: TransportRequest, opts?: { signal?: AbortSignal | undefined }): Promise<TransportResponse>;
}

export interface FetchTransportOptions {
  /** A custom fetch (tests, proxies, other runtimes). Default: `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Default per-request timeout in milliseconds; `undefined` = none. */
  readonly timeoutMs?: number;
}

export class FetchTransport implements Transport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(opts: FetchTransportOptions = {}) {
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TransportError("no fetch implementation available; pass one to FetchTransport");
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs;
  }

  async send(request: TransportRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<TransportResponse> {
    const headers = new Headers();
    for (const [k, v] of request.headers) headers.append(k, v);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = this.timeoutMs !== undefined ? setTimeout(() => controller.abort(new TransportError("request timed out")), this.timeoutMs) : undefined;
    let res: globalThis.Response;
    try {
      res = await this.fetchImpl(request.url, {
        method: request.method,
        headers,
        body: request.body.length > 0 ? (request.body as unknown as BodyInit) : null,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw new TransportError(`${request.method} ${stripQuery(request.url)}: ${(e as Error).message}`, { cause: e });
    }
    const pairs: Array<[string, string]> = [];
    res.headers.forEach((v, k) => pairs.push([k, v]));
    const clear = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    return {
      status: res.status,
      reason: res.statusText,
      headers: pairs,
      async bytes() {
        try {
          return new Uint8Array(await res.arrayBuffer());
        } catch (e) {
          throw new TransportError(`reading response body: ${(e as Error).message}`, { cause: e });
        } finally {
          clear();
        }
      },
      async *chunks() {
        if (!res.body) {
          clear();
          return;
        }
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield value;
          }
        } catch (e) {
          throw new TransportError(`reading response stream: ${(e as Error).message}`, { cause: e });
        } finally {
          clear();
          reader.releaseLock();
        }
      },
    };
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? url : url.slice(0, i);
}

export async function bufferResponse(res: TransportResponse): Promise<HttpResponse> {
  return new HttpResponse({ status: res.status, reason: res.reason, headers: res.headers, body: await res.bytes() });
}

let defaultTransport: Transport | undefined;

export function getDefaultTransport(): Transport {
  defaultTransport ??= new FetchTransport();
  return defaultTransport;
}
