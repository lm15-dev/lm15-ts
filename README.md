# lm15 for TypeScript and JavaScript

One request and response model for every model provider: OpenAI, Anthropic,
Google Gemini, xAI, Groq, DeepSeek, OpenRouter, Z.AI, Moonshot, Meta, the
cloud hosts (AWS Bedrock, Azure, Vertex) and any OpenAI-compatible server,
local or remote. The same program talks to any of them; when a provider can't
take a setting as you asked, lm15 adapts the request and tells you what it
changed. Zero runtime dependencies. Node 22+, and a browser entry point
(`@lm15/lm15/browser`) for pages, workers, PWAs and Electron renderers.

Guides and reference: **[lm15.dev](https://lm15.dev)**. The same library
exists for Python, Rust, Go, R and Julia, all written against one shared
[contract](https://github.com/lm15-dev/lm15-contract).

## Install

```bash
npm install @lm15/lm15
```

This is a **release candidate** (`1.0.0-rc.1`): the API is the one intended
for 1.0, and may still change before 1.0 if testing shows it must. Pin the
exact version in applications.

## First request

```ts
import { LMRouter, Message } from "@lm15/lm15";

const request = {
  model: "anthropic:claude-haiku-4-5",
  messages: [Message.user(
      "What might be eating the acorns under our oak trees at night?",
  )],
};

const router = new LMRouter();
const response = await router.complete(request);
console.log(response.text);
```

The key comes from `ANTHROPIC_API_KEY`; change the model string to reach
another provider (`openai:gpt-5-mini`, `gemini:gemini-2.5-flash`, ...). See
[Make your first request](https://lm15.dev/docs/first-request/).

ESM and CommonJS, with type declarations. Stored-credential refresh uses
Linux util-linux `flock`, or the optional native kernel-lock backend on other
hosts ([packaging and limitations](docs/credential-locking.md)); explicit
credentials need neither.

## Status

Release candidate, checked 2026-09-26 against the pinned contract
(`CONTRACT_PIN`): **1,583 of 1,583** contract checks pass
(`harness/check.py --shim typescript --direction all`; 40 skips are corpus
gaps shared with the Python reference), and the package's own 457 tests pass (3 skipped).

| Direction | Pass |
|---|---|
| request | 400 (1 skip) |
| response | 310 (23 skips) |
| stream | 40 (16 skips) |
| error | 90 |
| serde | 129 |
| auth, token | 43, 43 |
| models, live, router | 36, 24, 22 |
| files, batch, generation, video, cache | 48, 41, 20, 27, 11 |
| ingest | 169 |
| mapping (Gemini schema fields, MAP-16) | 87 |
| managed (sign-in) | 43 |

Sign in once, use everywhere: `Auth`, `connect()` and `BoundClient` are the
managed authentication lm15-python has, on the same store file, graded by the
same contract runs ([managed login](docs/managed-login.md)). The encrypted
relay tunnel is a prototype and its TLS module is not shipped.
Provisional surfaces (files, batches, media generation, live sessions, stored
caches) may change during 1.x, as in every lm15 language.

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

## Development

The contract commit this port is built against is in `CONTRACT_PIN`;
`harness/check.py` refuses to grade the port against any other commit.

### Gates

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

## Quick start

```ts
import { LMRouter, Message, ResponseStream, tool } from "@lm15/lm15";

const router = new LMRouter(); // keys from the environment (AUTH-1)
const request = {
  model: "groq:openai/gpt-oss-20b", // or "claude-haiku-4-5", "gpt-4.1-mini", "gemini-2.5-flash"
  messages: [Message.user("hi")],
  config: { maxTokens: 100 },
};

// One call.
const response = await router.complete(request);
console.log(response.text);

// Streamed: text as it arrives, then the same Response `complete` returns.
const rs = new ResponseStream(router.stream(request), request);
for await (const text of rs) process.stdout.write(text);
const streamed = await rs.response();

// How was it routed? `resolve` is pure: no network, no files, no secrets.
console.log(router.resolve("grok-4"));

// Tools: the schema is written by you; the loop is yours.
const weather = tool("get_weather", {
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
});
const turn = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("Weather in Oslo?")], tools: [weather] });
for (const call of turn.toolCalls) {
  const result = await lookUp(call.input);
  const next = await router.complete({
    model: "claude-haiku-4-5",
    messages: [Message.user("Weather in Oslo?"), turn.message, Message.tool(call.id, JSON.stringify(result))],
    tools: [weather],
  });
}

// Explicit configuration.
const configured = new LMRouter({
  apiKeys: { anthropic: process.env.MY_KEY! },
  settings: { "bedrock-chat": { region: "us-east-1" } },
});

// Providers, direct.
import { OpenAILM, AnthropicLM, GeminiLM, OpenAIChatLM, XaiLM, ClaudeCodeLM, OpenAICodexLM } from "@lm15/lm15";
const lm = new AnthropicLM({ apiKey: process.env.ANTHROPIC_API_KEY! });
await lm.listModels();

// Why is my key (not) being used? No secrets are printed.
import { explainAuth, describeReport } from "@lm15/lm15";
console.log(describeReport(explainAuth("groq")));

// MAP-13: change the model and the program keeps working; what the wire
// could not take as asked is on the response, never printed, never hidden.
const r = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("hi")], config: { seed: 7, temperature: 1.5 } });
for (const a of r.adaptations) console.log(a.field, a.action, a.asked, "→", a.applied, "—", a.reason);
// → config.seed dropped 7 → undefined — the Messages API has no seed field
// → config.temperature clamped 1.5 → 1.0 — the Messages API accepts temperature in [0, 1] ...
await router.plan(request); // the same record with no network and no credential
new LMRouter({ adaptations: "refuse" }); // the old strictness: every deviation throws before the wire, with `error.feature`

// MAP-14: judgments — declared keys in, a distribution out.
import { judgments, choice, yesNo, score } from "@lm15/lm15";
const verdict = await router.complete({
  model: "typesafe:jev-latest", // or any chat model: the pick without the numbers
  messages: [Message.user("Ripe blackberry, firm tannins, long finish.")],
  config: { responseFormat: judgments({ style: choice("Dominant style?", ["fruit", "oak", "mineral"]), ages: yesNo("Will it improve with age?") }), probabilities: "if_available" },
});
verdict.data; // { style: "fruit", ages: true }
verdict.probabilities; // { style: { fruit: 0.9, oak: 0.08, mineral: 0.02 }, ages: { true: 0.97, false: 0.03 } } — typesafe, or a vLLM server that scores tokens
```

Plain JavaScript users import the same package; the types are optional.

## In a browser

```ts
import { OpenAIChatLM, Message, ResponseStream } from "@lm15/lm15/browser";

const lm = new OpenAIChatLM({ apiKey: userKey, baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
const request = { model: "your-model-id", messages: [Message.user("hi")] };
const rs = new ResponseStream(lm.stream(request, { signal }), request);
for await (const text of rs) render(text);
```

The web entry is the Node entry minus the host services: no `process.env`,
no files, no CLI login stores, no cloud credential chains, no SigV4. Each of
those refuses by name (`NotConfiguredError` / `UnsupportedFeatureError`
naming the web platform and the fix) rather than being skipped. A
credential is explicit — the user's own, from an OAuth/PKCE exchange, or a
short-lived token from your backend; a file is bytes you supply. A bundler
resolving the `browser` condition gets this entry from `import "lm15"`.
The line, what a page cannot promise (CORS; a key in a page is not a
secret), and the evidence behind the claim — the corpus replayed in a
web-only realm, Chromium and Firefox headless — are in
[docs/browser.md](docs/browser.md). The
[playground](https://github.com/lm15-dev/website/tree/main/src/playground) takes your own API key,
connects directly to your chosen provider, shows the exact request in
JavaScript, Python, Rust, JSON and curl, and runs it through the real SDK
of each language — this one, lm15-python under Pyodide, lm15-rs under
wasm — confirming the bytes match. The separate
[OpenRouter OAuth example](examples/openrouter-page/README.md) tests PKCE
sign-in; it is not required to use lm15.

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

## Layout

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
