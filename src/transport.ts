/**
 * Transport abstraction — zero-dependency HTTP using native fetch.
 */

import { TransportError } from "./errors.js";

export interface TransportPolicy {
  readonly timeout: number;
  readonly connectTimeout: number;
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
}

export const DEFAULT_POLICY: TransportPolicy = Object.freeze({
  timeout: 30_000,
  connectTimeout: 10_000,
  maxRetries: 0,
  backoffBaseMs: 100,
});

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly params?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly timeout?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

export function httpResponseText(resp: HttpResponse): string {
  return new TextDecoder().decode(resp.body);
}

export function httpResponseJson(resp: HttpResponse): unknown {
  return JSON.parse(httpResponseText(resp));
}

function buildUrl(req: HttpRequest): string {
  if (!req.params || Object.keys(req.params).length === 0) return req.url;
  const qs = new URLSearchParams(req.params).toString();
  return `${req.url}?${qs}`;
}

export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
  stream(req: HttpRequest): AsyncIterable<Uint8Array>;
}

/** Transport implementation using native fetch (Node 18+, Deno, Bun, browsers). */
export class FetchTransport implements Transport {
  readonly policy: TransportPolicy;

  constructor(policy?: Partial<TransportPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = buildUrl(req);
    const timeout = req.timeout ?? this.policy.timeout;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });

      const body = new Uint8Array(await resp.arrayBuffer());
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

      return { status: resp.status, headers, body };
    } catch (err) {
      throw new TransportError(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(req: HttpRequest): AsyncIterable<Uint8Array> {
    const url = buildUrl(req);
    const timeout = req.timeout ?? this.policy.timeout;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });

      if (resp.status >= 400) {
        const body = await resp.text();
        throw new TransportError(`HTTP ${resp.status}: ${body}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new TransportError("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw new TransportError(String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
