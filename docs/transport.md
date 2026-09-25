# Connection budgets and response faults

Node's `lm15` entry installs `NodeTransport`; `@lm15/lm15/browser` defaults to
`FetchTransport`. No Node transport or native locking module is imported by the
browser entry.

```ts
import { LMRouter, Timeouts } from "@lm15/lm15";
const router = new LMRouter({
  timeouts: new Timeouts({ connect: 10, read: 600, write: 600, pool: 600 }),
  maxConnections: 100,
});
try {
  // All adapters obtained from this router share one owned transport.
} finally {
  await router.close();
}
```

Timeouts are in **seconds**, per operation, not total generation time. A read
budget covers waiting for the next response bytes, including the first headers.
A healthy stream can outlive 600 seconds. Builders do not replace caller budgets
with a hard-coded streaming limit. Router transport allocation is lazy, so
`plan()` does not create a pool. A supplied transport remains caller-owned;
configure it directly rather than combining it with router budget fields.

## Fetch is not a socket API

Fetch cannot separately control TCP/TLS establishment, request writes or the
browser's socket pool. Explicit `connect`, `write` or `pool` settings therefore
raise `UnsupportedFeatureError`; passing a fully populated `Timeouts` object
also asks for those unsupported controls. Use `timeouts: { read: 600 }` in a
browser, or omit it for the default.

Fetch supports `headersTimeoutMs` and `readTimeoutMs` (600,000 ms defaults),
optional total `timeoutMs`, and `maxConnections` (100 outstanding responses).
This cap bounds SDK operations, not physical browser sockets. `poolTimeoutMs`
is explicitly a **local admission queue deadline**, not a socket-pool setting.
Queued requests can be aborted; closing a transport cancels queued and active
operations. Consume a response, cancel it, or close its owner to release slots.

Fetch follows the browser's network, proxy, TLS and CORS policies. Diagnostic
headers hidden by CORS cannot be recovered by this library. Header-wait timing
includes connect and upload; it is not misrepresented as a ten-second connect
budget.

## Compression and malformed replies

Requests advertise `Accept-Encoding: identity` where the host permits it.
Browsers may forbid overriding that header. Node incrementally inflates `gzip`,
`x-gzip` and `deflate`; unsupported codings raise `ProtocolError` (a typed
`TransportError`). Fetch already inflates HTTP content, so the Fetch transport
only checks the visible `Content-Encoding` policy and never inflates twice.
If a runtime hides the coding or rejects a response before returning its
headers, the library cannot identify that coding; the runtime's transport
failure is retained instead. An injected Fetch implementation must have native
Fetch's decoded-body semantics.

A malformed JSON success is a non-retryable `ProviderError`, never an invented
5xx or a leaked JSON parser error. It retains status, content type, the first
200 body bytes rendered as text, request id and available rate-limit diagnostics.
This applies to JSON auxiliary endpoints as well as chat. Binary download and
speech bodies are not treated as JSON.

The JSON encoder refuses lone UTF-16 surrogates in strings and object keys,
naming the offending `U+XXXX`, before any request bytes are sent. Valid surrogate
pairs are accepted.

## Scope and verification

No automatic retry, fallback host or response-size policy is added. Node's
builtin HTTP transport is not an automatic corporate proxy client: inject a
configured transport for custom proxy/TLS behavior. HTTP protocol and runtime
compression edge cases require the new regression suites to be executed.
No test, build, typecheck or live network verification ran in this pass.
