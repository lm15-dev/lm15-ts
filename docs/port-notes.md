# Port notes

Details for contributors and for readers comparing lm15 languages. The
[README](../README.md) is the user-facing overview.

## Where things are

| Path | What |
|---|---|
| `src/json.ts` | JSON with number fidelity: `RawNumber`, `parseJson`, `stringifyJson`, `float` |
| `src/types/` | every canonical type: interface, validating constructor, `fromJSON`/`toJSON` |
| `src/vocab.ts`, `src/errors.ts` | the closed vocabularies; the error hierarchy |
| `src/platform.ts`, `src/platform_node.ts` | the host boundary: the `Platform` interface and the web default; Node's services, installed by the `lm15` entry |
| `src/browser.ts`, `src/bytes.ts` | the web entry point (`@lm15/lm15/browser`); base64/UTF-8 without `Buffer` |
| `src/auth/` | access policies (AUTH-10), stored credentials and the lock (AUTH-3/4/8/9), the doctor (AUTH-7), JWT claims (`jwt.ts`) |
| `src/cloud/` | the three cloud chains (AUTH-1/11), SigV4, RS256, host rewrites |
| `src/compat.ts`, `src/registry.ts` | compat presets and the provider table, copied as data |
| `src/adapter.ts`, `src/dialects/` | the shared adapter base; OpenAI Responses, OpenAI Chat (with the MAP-14 token-trie driver, `token_trie.ts`), Anthropic, Gemini, xAI, TypeSafe |
| `src/adaptation.ts`, `src/types/adaptation.ts` | MAP-13: the `Adaptation` record, the three policies, the synchronous build scope, `plan()` |
| `src/judgments.ts` | MAP-14: the judgment convention read off a schema and emitted by `choice` / `yesNo` / `score` / `judgments`; the two wire rewrites; the `DataPart` fold |
| `src/stream.ts`, `src/stop.ts` | SSE, the MAP-3/4 coalescer, the MAP-9 accumulator, `ResponseStream`; the client-side stop with score preservation |
| `src/router.ts`, `src/live.ts` | `LMRouter`; `LiveSession` over the platform WebSocket |
| `src/testing.ts` | `@lm15/lm15/testing`: `FakeLM`, `FakeTransport`, `FakeResponse` |
| `src/canonical.ts` | Out-of-band type identity for generic serialization |
| `src/vet.ts`, `src/vet_*.ts` | the vet shim (`node dist/vet.js`) |
| `examples/openrouter-page/` | the browser example: PKCE sign-in, models, streaming, cancel; its README lists what building it surfaced |
| `tools/` | surface generator, differential probes, live smoke, the headless harness (`headless.ts`), the SDK and example browser smokes, the static server |
| `receipts/` | live evidence, secrets redacted (`tools/check_secrecy.py` passes) |

## Stated deviations

Each row names the rule it deviates from (playbooks/port.md rule 8).

- **Integral floats inside opaque payloads authored in JavaScript** (docs/
  serde-rules.md, Number rule 4). JavaScript has one number type: a literal
  `{ extensions: { x: 1.0 } }` is `1` by the time lm15 sees it and is emitted
  as the integer `1`. Wire-originated payloads keep their form: `parseJson`
  preserves integral-float and big-integer lexemes as `RawNumber`, so
  `serde_roundtrip` and every response are byte-exact. Typed float fields
  (`temperature`, `top_p`, `logprob`, pricing) are always emitted as floats.
  Use `new RawNumber("1.0")` to force a float lexeme by hand.
- **Shared credential locking uses kernel locks** (spec/auth.md AUTH-4).
  Linux retains the existing util-linux `flock` descriptor protocol. The optional
  Node-API backend uses POSIX `flock` / Windows `LockFileEx`; it must be built and
  packaged for that host. Missing helpers fail explicitly; no stale-lockfile
  stealing or unlocked writes. Native portability/interoperability is unverified
  in this pass. See [credential locking](docs/credential-locking.md).
- **Typed integers must fit JavaScript's safe integer range.** Larger counters
  and overflowing computed totals are rejected, never rounded. Opaque JSON
  payloads still preserve arbitrarily large integer lexemes using `RawNumber`.
- **Generic serialization does not guess a plain object's type.** Factory-made
  canonical values remember their kind out of band. Use `toJSON(value, "delta")`
  or `Delta.toJSON(value)` for literals, copied objects, or values from another
  package instance. A text part, text delta and live text event can share a shape.
- **Connection budgets are host-appropriate.** Node's transport exposes
  `Timeouts({ connect: 10, read: 600, write: 600, pool: 600 })` (seconds),
  `maxConnections: 100`, pooling and explicit close. Fetch exposes 600-second
  header/read deadlines and bounded request concurrency; it refuses explicit
  socket connect/write/pool controls it cannot honor. It never re-inflates a
  body Fetch already decoded. See [transport budgets](docs/transport.md).
- **No schema derivation from a function signature** (api-family.md § Tools):
  `tool(name, { parameters })` takes the JSON Schema you write. Stated once
  for all three non-Python ports.
- **Job handles and live turns** (api-family § Beyond chat, 2026-09-11): `lm.batch(...)` / `batchJob(id)` / `batches()` →
  `BatchJob`; `lm.videoGenerate(...)` / `videoJob(id)` / `videoJobs()` →
  `VideoJob`; `wait({ pollEveryMs, timeoutMs, signal })` is the only thing
  that waits, and a deadline that elapses throws a `DOMException` named
  `TimeoutError` (the caller's own deadline; no lm15 code). `session.turn()`
  iterates one turn (LIVE-1) and `await turn.result()` materializes it with
  the bill summed per LIVE-2. The pure verbs are unchanged and are what the
  harness pins.
- **Post-completion stream failures are reported with `process.emitWarning`**
  (contract `changes/2026-09-11-stream-completion-and-error-metadata.md` § 2;
  Python: `StreamCleanupWarning`). The warning's `type` is
  `StreamCleanupWarning`; `ResponseStream.cleanupErrors` holds the failures.
  Outside Node (no `process.emitWarning`) it falls back to `console.warn`.
- **The router's rung 0** (a `provider` attribute on a `str` subclass) is a
  Python idiom with no TypeScript equivalent; `provider:model` and catalogs
  cover the same ground (spec/vocabularies.md names only the three rungs the
  harness pins).
- **`surface_dump` is reflection at build time**, not at call time
  (harness/PROTOCOL.md): TypeScript erases types, so `tools/gen_surface.ts`
  reads the compiler's view of `src/types/*.ts` and writes `src/surface.ts`
  on every build. It is never edited by hand.
- **`aws-event-stream` framing** (phase 2, `bedrock` Converse) is not
  implemented, exactly as in the reference; the request refuses with
  `UnsupportedFeatureError` and `replay_stream` refuses the framing.
- **The MAP-13 record reaches the response through a synchronous build
  scope, not a context variable** (Python: `contextvars`). Every dialect's
  `wireRequest` is synchronous by design and runs inside `collecting(scope,
  fn)`; `fn` returning a promise is a `TypeError`. `AsyncLocalStorage` was
  rejected because the browser entry has no `node:async_hooks`. Same
  behaviour, same records, same policies; `plan()` invokes no credential.
- **`Adaptation.asked` / `applied` keep the field's JSON type**: a clamped
  temperature is the float `1.0` (a `RawNumber`), never the integer `1`, so
  the record round-trips byte-exact and matches the reference.
- **`endedBy: "incomplete"`** on a `Turn` whose collection stopped before a
  boundary (a closed view, a `CollectionLimitError`), as in the reference
  since 2026-09-15; before, the port said `"error"`. A session that closes
  before a boundary is a `TransportError` when iterated as a turn, never a
  silent empty turn.

## Cloud identity and local provider declarations

Named cloud credentials, endpoint roots, provenance and browser usage are in
[cloud identity](docs/cloud-identity.md). Router-local `ProviderDefinition`
values declare chat, Responses or Anthropic doors without modifying the global
registry. `plan()` builds a standalone offline binding: it needs no credentials,
reads no host environment/profile and never allocates a transport.

Judgment distributions validate every declared measurement and selected answer.
**INV-052 does not validate sums or normalize distributions**: providers round.
Absent usage remains unknown, never zero; schema copies preserve `RawNumber`.

## Rate-limit diagnostics

Errors retain `rateLimitHeaders`, a bounded, immutable snapshot of the
provider's reported limits, balances, resets and retry headers. `String(error)`
shows advisory details alongside the provider message; `retryAfter` remains
seconds or null, never a promise of success. HTTP-200 stream errors preserve
handshake evidence through saving and replay. Browser CORS may hide headers.
No automatic retry or endpoint switch is added.

See [Rate and capacity errors](docs/error-diagnostics.md).

## Cached-prefix routing

`router.cache(prefix)` stores its resolved destination as optional canonical
`CachedPrefix.provider`, including router-local provider names. `prefix.model`
and `resource.model` remain matching wire model names; `CachedPrefix.request(c, ...)`
emits `provider:wiremodel`. The route survives `toJSON`/`fromJSON`. Reuse it with
the same router configuration/account: it carries no credentials, endpoint or
provider declaration. The router's bound `router.lm(...)` also accepts that
qualified request and strips only its own provider prefix, once.

Direct `lm.cache` with bare input does not invent a router destination. Explicit
own-provider prefixes retain their route; underscore input aliases canonicalize
to hyphens. Suffix Requests may name the wire model or the same destination, not
another provider. Old values without `provider` keep unqualified behavior and
unchanged canonical output (the absent field is omitted). Pinned by the contract's
`cached_prefix.routed` serde case (passing).

## Development gates


```bash
npm install                    # dev tooling only: typescript, @types/node
npm run build                  # regenerates src/surface.ts, emits dist/ (ESM + CJS + d.ts)
npm test                       # node:test; replays ../lm15-contract when present
npm run differential           # both probes against ../lm15-python
npm run test:browser           # the web entry in Chromium and Firefox, headless (needs the browsers)
npm run test:example           # the example page's modules through a real PKCE redirect, same browsers
npm run example:openrouter     # the OpenRouter OAuth protocol example
cd ../lm15-contract && python3 harness/check.py --shim typescript --direction all
```

`npm test` also evaluates the web entry inside a realm with only web globals
and replays the corpus through it (`tests/web_realm.test.ts`).

The website, documentation hub, playground, and cross-language browser tests
live in the separate [website repository](https://github.com/lm15-dev/website).
To work on them locally, use `cd ../website && npm run dev` after `npm ci`
in that repository. This SDK no longer builds or deploys the website.

