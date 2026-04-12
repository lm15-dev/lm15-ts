/**
 * Middleware pipeline for complete/stream operations.
 */

import {
  RateLimitError, ServerError, TimeoutError, TransportError,
} from "./errors.js";
import type { LMRequest, LMResponse, StreamEvent } from "./types.js";

export type CompleteFn = (req: LMRequest) => Promise<LMResponse>;
export type StreamFn = (req: LMRequest) => AsyncIterable<StreamEvent>;
export type CompleteMiddleware = (req: LMRequest, next: CompleteFn) => Promise<LMResponse>;
export type StreamMiddleware = (req: LMRequest, next: StreamFn) => AsyncIterable<StreamEvent>;

export class MiddlewarePipeline {
  completeMw: CompleteMiddleware[] = [];
  streamMw: StreamMiddleware[] = [];

  add(mw: CompleteMiddleware): void {
    this.completeMw.push(mw);
  }

  wrapComplete(fn: CompleteFn): CompleteFn {
    let wrapped = fn;
    for (let i = this.completeMw.length - 1; i >= 0; i--) {
      const mw = this.completeMw[i];
      const prev = wrapped;
      wrapped = (req) => mw(req, prev);
    }
    return wrapped;
  }

  wrapStream(fn: StreamFn): StreamFn {
    let wrapped = fn;
    for (let i = this.streamMw.length - 1; i >= 0; i--) {
      const mw = this.streamMw[i];
      const prev = wrapped;
      wrapped = (req) => mw(req, prev);
    }
    return wrapped;
  }
}

const TRANSIENT_ERRORS = [RateLimitError, TimeoutError, ServerError, TransportError];

function isTransient(err: unknown): boolean {
  return TRANSIENT_ERRORS.some(cls => err instanceof cls);
}

export function withRetries(maxRetries = 2, sleepBase = 200): CompleteMiddleware {
  return async (req, next) => {
    let last: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await next(req);
      } catch (e) {
        last = e;
        if (i === maxRetries || !isTransient(e)) throw e;
        await sleep(sleepBase * (2 ** i));
      }
    }
    throw last;
  };
}

export function withCache(cache: Map<string, LMResponse>): CompleteMiddleware {
  function key(req: LMRequest): string {
    return JSON.stringify([req.model, req.system, req.messages, req.tools, req.config]);
  }
  return async (req, next) => {
    const k = key(req);
    const cached = cache.get(k);
    if (cached) return cached;
    const resp = await next(req);
    cache.set(k, resp);
    return resp;
  };
}

export interface HistoryEntry {
  ts: number;
  model: string;
  messages: number;
  finish_reason: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export function withHistory(history: HistoryEntry[]): CompleteMiddleware {
  return async (req, next) => {
    const started = Date.now();
    const resp = await next(req);
    history.push({
      ts: started,
      model: req.model,
      messages: req.messages.length,
      finish_reason: resp.finish_reason,
      usage: {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        total_tokens: resp.usage.total_tokens,
      },
    });
    return resp;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
