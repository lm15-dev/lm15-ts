import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MiddlewarePipeline, withCache, withHistory, withRetries, type HistoryEntry } from "../middleware.js";
import { Part, Message, EMPTY_USAGE } from "../types.js";
import type { LMRequest, LMResponse } from "../types.js";
import { RateLimitError } from "../errors.js";

function makeRequest(): LMRequest {
  return { model: "test", messages: [Message.user("hi")] };
}

function makeResponse(): LMResponse {
  return {
    id: "r1",
    model: "test",
    message: { role: "assistant", parts: [Part.text("ok")] },
    finish_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };
}

describe("MiddlewarePipeline", () => {
  it("wraps complete with middleware", async () => {
    const pipeline = new MiddlewarePipeline();
    const log: string[] = [];

    pipeline.add(async (req, next) => {
      log.push("before");
      const resp = await next(req);
      log.push("after");
      return resp;
    });

    const fn = pipeline.wrapComplete(async () => {
      log.push("inner");
      return makeResponse();
    });

    await fn(makeRequest());
    assert.deepEqual(log, ["before", "inner", "after"]);
  });
});

describe("withCache", () => {
  it("caches responses", async () => {
    const cache = new Map<string, LMResponse>();
    const mw = withCache(cache);
    let callCount = 0;

    const fn = async (req: LMRequest) => {
      callCount++;
      return makeResponse();
    };

    await mw(makeRequest(), fn);
    await mw(makeRequest(), fn);
    assert.equal(callCount, 1);
    assert.equal(cache.size, 1);
  });
});

describe("withHistory", () => {
  it("records history", async () => {
    const history: HistoryEntry[] = [];
    const mw = withHistory(history);

    await mw(makeRequest(), async () => makeResponse());
    assert.equal(history.length, 1);
  });
});

describe("withRetries", () => {
  it("retries on transient errors", async () => {
    const mw = withRetries(2, 1); // fast retries for test
    let attempts = 0;

    const result = await mw(makeRequest(), async () => {
      attempts++;
      if (attempts < 3) throw new RateLimitError("429");
      return makeResponse();
    });

    assert.equal(attempts, 3);
    assert.equal(result.id, "r1");
  });
});
