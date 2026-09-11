# Runtime correctness and remaining work

This pass fixes the confirmed runtime findings from the Python/Rust comparison.
It is not a line-by-line audit of all three implementations or a release approval.

## Fixed and tested

- Generic `toJSON()` distinguishes parts, deltas, live events, configuration and
  empty usage. Each constructed kind is checked through the public serializer
  against the sibling canonical corpus. Kind identity lives in a WeakMap, never
  in serialized data. Copies and plain literals must name their kind explicitly.
- Integer normalizers reject unsafe JavaScript integers, including computed
  usage totals that overflow the safe range. Opaque payload numbers remain exact.
- All four chat request builders validate before resolving credentials. Public
  file-upload, batch-submit, cache-create, image, speech and video submission
  drivers validate their canonical request values too.
- `ResponseStream` supports pause-then-drain, rejects competing readers, remembers
  errors and finalizes its source on completion, failure or explicit cancellation.
- HTTP cancellation handles pre-aborted requests, pending reads, early iterator
  exit and unused bodies. Regression tests include a real localhost HTTP server.
- HTTP waits have header and per-chunk idle deadlines. Long healthy generations
  do not hit a total deadline unless the caller explicitly configured one.
- Credential locks share the Python/Rust kernel primitive and `.lock` path.
  The short-lived `flock` utility acquires a lock on Node's inherited open file
  description; Node holds it until close or process death. No helper stays alive,
  no lock-file deletion is needed, and callbacks are never run without a lock.
  Tests check Python exclusion, callback failure, process death, symlinked paths,
  and a missing utility. Atomic-write failure also cleans up its temporary file.
- Live connection/setup failure, closure, cancellation, timeout, decode failure
  and bounded close settle callers rather than leaving promises pending. Receivers
  are installed before setup is sent. `lm.live(config, options)` and byte-valued
  `sendAudio` / `sendImage` are available alongside `LiveSession.open`.
- `responseToEvents(response)` implements the Python/Rust replay conversion and
  refuses parts without a delta representation. It does not invent new deltas.
- `lm15/testing` ships `FakeLM`, `FakeTransport`, `FakeResponse` and a minimal
  `LanguageModel` interface. These do not read credentials or make network calls.
- The smoke-tool import is corrected; the full TypeScript check includes tools.

## Stream ownership

```ts
const stream = new ResponseStream(lm.stream(request, { signal }), request);
try {
  for await (const text of stream) {
    show(text);
    if (enoughPreview()) break; // pause; does not cancel the request
  }
  const response = await stream.response(); // consumes everything remaining
} finally {
  await stream.close(); // cancels if unfinished; no-op after completion
}
```

Only one iterator/drainer can own a ResponseStream at a time. Stop that iterator
before closing it. Abort the request's signal to interrupt a read already in
progress; an arbitrary AsyncIterator has no standard interrupt-pending-read API.
Do not abandon a paused stream without closing or draining it.

Live sessions are full-duplex and may span many turns. Breaking live iteration
also leaves the session open. Close it explicitly (or use `await using`).
`LiveSessionOptions.signal` cancels both setup and the lifetime of the session;
`timeoutMs` bounds setup and `closeTimeoutMs` bounds waiting for close acknowledgement.

For a raw transport response, consume `bytes()` or `chunks()`, or call `cancel()`
if the body is not needed. The built-in transport's bodies are single-consumption.

## Compatibility decisions

- Stored credential mutation/refresh currently requires Linux plus util-linux
  `flock` on PATH. Other platforms can use explicit API keys or credential
  providers. A portable native locking backend remains future work. Stop older
  `.node.lock`-using processes when upgrading; they cannot coordinate with this
  kernel-lock implementation. Never delete a lock file to resolve contention.
- Factory identity is local to a package instance. Use type-specific serializers
  or the explicit generic kind after object spread, cloning or package boundaries.
- Typed integers are numbers, not a new number/bigint union. Rejecting unsafe
  input preserves the existing public type while making loss explicit.
- Fetch has no separate connection/TLS handshake control. `headersTimeoutMs`
  includes connect and request write, rather than pretending to be a connection
  timeout. Request `readTimeout` is in seconds; transport options are milliseconds.
  Proxy and TLS customization remain the injected fetch/Transport's responsibility.
- No automatic retries or tool execution were added. Callers own both policies.

## Still unfinished

- A complete source audit of Python, Rust and TypeScript.
- Python's BatchJob/VideoJob polling handles and live Turn collection helpers.
  The lower-level batch/video/live operations remain available.
- Python-style automatic discovery of installed model catalogs and function
  signature-to-schema derivation; no implicit package scanning was added.
- Broad live-provider verification for files, batches, caches, generation,
  cloud credential resolution, OAuth refresh/login and OpenAI Realtime.
- A broader public-API, platform, security, packaging and release review.

Passing corpus vectors, differential tests and runtime tests is evidence for
those tested behaviors only. It is not proof of complete provider support.
