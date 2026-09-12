# The lm15 playground

A chat page, provider-neutral, with the exact request beside it in
JavaScript, Python, Rust, JSON and curl — and a **Run in** switch that
sends the turn through the real SDK of the language you pick:

- **JavaScript** — `lm15/browser`, the TypeScript SDK's web entry, in this page.
- **Python** — lm15-python under [Pyodide](https://pyodide.org) (CPython
  compiled to WebAssembly), executing the Python text the panel shows,
  over `lm15.transports.FetchTransport`.
- **Rust** — the lm15-rs crate compiled to `wasm32` with its `wasm`
  feature, building the request and decoding the stream; the page does the
  fetch (the codec has no network by design, like `lm15/browser` has none
  of the host).

After each turn the page builds the same request in every loaded runtime
and says whether the bytes are identical: *Same request bytes from
JavaScript, Python, Rust ✓ — three SDKs, one wire.* That line is the
family's promise, checked live.

```sh
npm run build          # dist/browser.js, this page, the Python wheel and the Rust codec (see below)
npm run example        # opens the page; enter your own key
npm run example:local  # opt in to the private, one-use localhost handoff of keys from ../.env
```

## Keys

Pick a provider → **Settings → Get a key ↗** opens that provider's key
page (the address comes from lm15's provider registry, `consoleUrl`; the
same table the router reads) → paste it → **Use key**.

- By default the key lives in memory for the tab. Refresh, and it is gone.
- **Remember on this device** keeps it in this site's IndexedDB, encrypted
  with AES-GCM under a key the browser generates as non-extractable — the
  plaintext never sits on disk or in a backup, and no script can read the
  AES key's bytes. A reload decrypts it back. **Forget** deletes it.
- What that does *not* protect against, stated in the settings panel
  itself: a script running on this page can ask for the key. No browser
  storage prevents that. The page's Content Security Policy (no
  third-party script, no inline script) and Forget are the protections
  that exist. lm15 never puts a key in a URL, a log, or the code panel.
- Keys are never in the code panel: every snippet says `"YOUR_API_KEY"`,
  and the Python runtime substitutes the real one only in the text it
  executes.

## Settings

Settings stay in a visible sidebar beside the chat and code. System prompt,
temperature, max tokens and reasoning effort update the selected code tab as
you edit, without sending a request. They apply to the next message, not an
already-running turn. **Settings** (or `/settings`) focuses the sidebar.
On tablets, settings and code sit together above the chat; phones stack the
panels to keep them readable.

**Use provider default** removes the explicit temperature from the request.
Invalid max-token values are shown as errors rather than silently replaced.
System prompt is a `Request` field; the other controls are `Config` fields.
The code panel shows how each language spells them, and JSON shows the bytes. A model that lacks a dial refuses it
loudly — lm15 never drops a setting to make a call succeed (see *What
building it surfaced*, below).

## The code panel

Every snippet is a complete program: connect, replay the whole transcript
so far — verbatim, in canonical JSON, thinking parts and continuation
state included — send the next message, stream the reply, keep it for the
next turn. The Rust and Python texts use each SDK's public API
(`LMRouter` + `RouterConfig`; `AsyncOpenAIChatLM(compat=…)` and friends).
Only the transport line differs between a page and a terminal, and the
Python text says so.

## What is proven, and how

`npm test` (from the repository root) includes:

- `tests/provider_examples.test.ts` — for 11 providers × {first turn,
  with a replayed transcript} × {default, full settings}: the JavaScript
  text type-checks against the built package, executes, and builds the
  page's own request; the Python text executes under Pyodide (Node-hosted,
  fetch faked) and builds the same bytes and headers; the Rust codec builds
  the same bytes; and `lm15-rs/examples/playground.rs` equals the
  generator's output, so `cargo check --examples` in lm15-rs compiles
  every Rust snippet shown.
- `tests/pyodide.test.ts` — lm15-python's `FetchTransport` streams,
  cancels (the server-side body sees it) and surfaces a 401 as the typed
  error; and every request case in the contract corpus builds identically
  in Python-under-Pyodide and TypeScript (342 identical, 24 refused
  identically).
- `tests/rust_wasm.test.ts` — the same corpus through the wasm codec: 342
  requests identical (SigV4 signs inside wasm — pure Rust), 337 bodies
  parse identically, 39 streams decoded incrementally equal their
  whole-body replay.

`npm run test:providers` builds the page and drives it in Chromium:
settings reaching the code and the wire; a remembered key stored as
ciphertext and decrypted after a reload; the key page from the registry;
the private local handoff's refusals; discovery failures and stale replies
isolated; and — the point — one conversation carried across turns sent by
Rust, then Python, then JavaScript, with the fidelity line confirming
identical bytes.

Not proven here: live availability of any provider from a browser (CORS
is the provider's choice; the page says so), and the JavaScript text
under a bundler other than the import map used here.

## What building it surfaced

1. **The reference dropped a setting silently.** With `reasoning.effort`
   set on a server whose compat has no reasoning field (`ollama`, LM
   Studio), Python and TypeScript sent the request with the dial omitted;
   Rust refused, citing the rule (MAP-5, MAP-7 rule 2: a raise or an
   extensions door, never omission). A Python test even pinned the drop.
   Found by building one request in three languages side by side. Fixed
   in the reference and TypeScript; pinned by
   `cases/ollama/reasoning_effort_refused.json` (contract change
   `2026-09-11-reasoning-dial-without-a-field.md`, pending ratification).
2. **`import lm15` failed under Pyodide.** `_authlock` imported `fcntl`
   and the socket transports imported `ssl` at module level; neither
   exists there (nor `fcntl` on Windows). Both are optional now and refuse
   by name at use.
3. **A `Reasoning` literal does not type-check in TypeScript.** `{ effort:
   "low" }` widens to `string`; the shown code now uses `Request.create({…})`,
   the validating constructor, which is the API anyway.
4. **`Reasoning` has no `Default` in Rust.** The first `cargo check
   --examples` over the generated snippets said so; the snippet spells
   `Reasoning::new(effort)`.
5. **An unknown continuation kind replays differently.** A hidden
   thinking part carrying a continuation state no dialect recognises
   becomes an empty text block in TypeScript and is dropped by Rust. The
   contract pins neither (no such shape exists on any wire); recorded here
   as a divergence for the parity ledger, not fixed in either port.
6. **The wasm toolchain gap.** The build server ships the wasm32 std but no
   wasm-ld; `lm15-rs/tools/wasm-ld` finds one through nix so the crate's
   config names no machine-specific path.
7. **`fetch` as a method** (from the earlier SDK smoke): still the one bug
   only a real browser can find; the Rust runtime here calls `fetch`
   bare for the same reason.
8. **`JSON.stringify` is the wrong serializer for a transcript.** Numbers
   parsed off a provider's wire are `RawNumber` (the lexeme, kept exact —
   `1.0` stays `1.0`, a 20-digit id is not rounded); the page's first
   real multi-turn Rust run threw on one. Every path that writes a
   transcript out — the three renderers, the codec ABI — now uses lm15's
   `stringifyJson`, and a test replays a wire-parsed transcript through
   all of them.

## Layout

| Path | What |
|---|---|
| `index.html`, `app.css` | the page: CSP (`wasm-unsafe-eval` for the two wasm runtimes; no inline script but the hash-allowed import map) |
| `experience.ts` | the connection, settings, request builder, and the five renderers (JavaScript, Python, Rust, JSON, curl) |
| `runtimes/` | the `Runtime` interface and its three implementations |
| `credentials.ts` | memory by default; encrypted IndexedDB on request |
| `picker.ts`, `connections.ts` | the fuzzy picker and the provider list |
| `main.ts` | DOM glue; text nodes only, never HTML from a model |
| `../../vendor/` | the Python wheel and the Rust codec, built from the sibling checkouts (`npm run python:wheel`, `npm run rust:wasm`); Pyodide comes from `node_modules` — the demo server serves all three under `/vendor/` |
