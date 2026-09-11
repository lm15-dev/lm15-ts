# lm15 in a page: OpenRouter, no backend

A static page that signs a user in to OpenRouter with PKCE, lists the
models their key can use, streams replies through `lm15/browser`, and can
stop a reply mid-stream. Three files of application logic, one of DOM glue,
one HTML page, one stylesheet. No framework, no bundler, no server of ours.

It exists to prove the browser entry point against a real endpoint from a
real page — the thing a fake server cannot prove — and to be the shape a
browser lm15 application takes. It is a test, kept small; not a product.

## Run it

```bash
npm run build      # dist/browser.js and this example's build/
npm run example    # serves the repository on the loopback; open the printed URL
```

Click **Sign in with OpenRouter**. You are sent to openrouter.ai, which makes
a key for this page and sends you back; the page exchanges the one-time
code for that key and keeps it for the tab (or for the device, if you
ticked *Remember*). Pick a model, type, send; **Stop** cancels; **Forget
key** removes it. **The request lm15 built** shows the exact wire request,
credential redacted, before it was sent.

Any static host serves the same files: copy `dist/` and this directory,
keeping their relative layout (the page's import map points at
`../../dist/browser.js`). OpenRouter accepts any `localhost` port as a
callback; a public URL gets app attribution on OpenRouter's side.

## What it proves

Run `npm run test:example`. A loopback server plays OpenRouter under
`/fake/` — the authorization page (a real HTTP redirect back with a code
bound to the PKCE challenge), the code exchange (which verifies the
verifier against that challenge as RFC 7636 says, and refuses a second
use), the model list, streamed Chat Completions with usage, a slow stream
to cancel, a 401 for a wrong key, and the attribution headers recorded —
and drives this app's modules through it in Chromium and Firefox, headless,
through the real redirect. Then it loads the built `index.html` in Chromium
and reads the DOM back: the boot ran under the page's CSP.

Fourteen checks per browser, plus the page boot. As of 2026-09-11, all pass
in Chromium 152 and Firefox 155.

With `npm run test:example -- --live` and `OPENROUTER_API_KEY` set, the same
chat runs against the real openrouter.ai from the page — the CORS preflight,
the model list, a streamed reply, a cancel, a wrong key — and a receipt goes
under `receipts/` with the key redacted. The PKCE login itself cannot run
headless: it needs a person at OpenRouter's page.

## What it does not prove, stated

- **Other providers from a page.** OpenRouter answers the CORS preflight
  for any origin on the three endpoints this page uses (observed
  2026-09-11). That is OpenRouter's choice, not a property of lm15 or of
  browsers; another provider may refuse. `docs/browser.md` has the line.
- **A secret in a page.** There is none here: the key is the user's own,
  made by OpenRouter for this page, revocable at *Manage this key*. The
  page never embeds a key of ours. *Remember on this device* puts the
  user's key in `localStorage`, readable by any script on this origin —
  their trade, made by them, undone by *Forget*.
- **The login UX under automation.** The smoke test drives the modules
  through the real redirect; the buttons and boxes in `main.ts` are glue,
  loaded once for the boot check and otherwise exercised by hand.

## What building it surfaced

The findings that fed back into the SDK, in the order they appeared:

1. **No PKCE in the TypeScript SDK.** Python's `lm15.authkit` had it; the
   web entry now has `generatePkce` / `pkceChallenge` over Web Crypto,
   pinned by RFC 7636's own vector.
2. **`fetch` called as a method.** The transport stored `globalThis.fetch`
   on the instance and called `this.fetchImpl(...)`: an "Illegal
   invocation" in every browser, fine in Node. Found by the SDK smoke the
   day before; this app is the first thing that would have hit it for real.
3. **Advice written for a terminal.** The auth error told a page user to
   "set OPENROUTER_API_KEY in your environment". Now: pass the key
   explicitly, or set the variable on a host that has an environment.
4. **Cancellation is recognisable, but only by convention.** An abort
   surfaces as a `TransportError` whose `cause` is the signal's reason;
   the app checks `signal.aborted` beside it. That works and is what
   `isCancellation` does; a typed cancellation would be cleaner and is
   noted, not added.
5. **App attribution is a policy, not a knob.** OpenRouter's
   `HTTP-Referer` / `X-Title` ride on `access.withHeaders(access.OPENROUTER,
   {...})` — the right place (a header is part of *how you reach a
   provider*), and easy to miss; this README is where a reader learns it.
6. **`listModels` from a page works** against OpenRouter's `/models`:
   every model comes back as `provider: "openrouter"` with its id, which
   is what a picker needs. OpenRouter's pricing and context length arrive
   too, but only as the raw entry under `origin.providerData`; nothing lifts
   them onto `inference` for this door yet, so a picker that wants to show
   a price reads the raw entry.

## Layout

| File | What |
|---|---|
| `index.html`, `app.css` | the page: CSP (`connect-src` is this origin and openrouter.ai; the import map is hash-allowed), no inline script otherwise |
| `src/login.ts` | PKCE begin/complete against OpenRouter's documented flow; the verifier in `sessionStorage`; the key hash for the manage link |
| `src/keys.ts` | the key for the tab, or the device on request; Forget |
| `src/chat.ts` | one `OpenAIChatLM` on OpenRouter's access policy plus attribution; models, wire preview, send, commit; typed errors to one line |
| `src/main.ts` | DOM glue: text nodes only, never HTML from a model |
| `build/` | `tsc -p tsconfig.examples.json` output, ignored by git; `npm run build` makes it |
