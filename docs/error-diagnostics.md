# Rate and capacity errors

“No capacity” is not proof of a wrong endpoint. On Azure, our small deployment
returned that error through both supported addresses; the headers revealed
rate limiting, and longer gaps restored success.

```ts
import { RateLimitError } from "@lm15/lm15";

try {
  const response = await router.complete(request);
} catch (error) {
  if (!(error instanceof RateLimitError)) throw error;
  console.error(String(error)); // message, request ID, wait advice and limits
  console.log(error.retryAfter); // seconds, or null if no usable hint
  console.log(error.requestId);  // provider support reference
  console.log(error.rateLimitHeaders);
  // Your application decides whether and when to retry.
}
```

`rateLimitHeaders` is an immutable mapping of lowercase header names to arrays
of original values. Duplicates, negative balances, and contradictory evidence
are retained. Reset fields are raw: seconds, duration strings and timestamps
must not be conflated. A valid body wait hint wins, then `Retry-After`, then
numeric `retry-after-ms` and `x-ms-retry-after-ms` converted to seconds. Nothing
usable means null, not zero. A wait hint never guarantees that retrying works.

This applies to inference, rejected streams and auxiliary calls. An error
inside HTTP 200 has handshake evidence in `event.error.httpResponse` (canonical
JSON: `http_response`). Saved/replayed events keep it, and response
materialization propagates it to the exception. It does not give the error
HTTP status 200. A long-running stream's handshake is not a live quota feed.

Only the contract's closed set of rate-limit headers is retained—no
credentials, cookies or arbitrary x-* fields. Each name retains up to four
values of at most 256 printable ASCII characters. Longer displays use a
bounded preview. Treat all provider error content under your logging policy.

**In a browser**, CORS can hide headers that Node can see. Missing headers mean
unknown, not unlimited quota. Fetch may already have combined duplicate
headers; lm15 preserves what the transport exposes rather than splitting
commas (dates contain commas too).

No automatic retry, endpoint fallback, quota increase or paid-capacity upgrade
is performed. Retry policy belongs to the application.

[Shared contract and exact header list](https://github.com/lm15-dev/lm15-contract/blob/main/docs/error-diagnostics.md).
