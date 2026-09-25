# lm15 in a page: OpenRouter, no backend

A static page that signs a user in to OpenRouter with PKCE, lists the
models their key can use, streams replies through `@lm15/lm15/browser`, and can
stop a reply mid-stream. Three files of application logic, one of DOM glue,
one HTML page, one stylesheet. No framework, no bundler, no server of ours.

It exists to prove the browser entry point against a real endpoint from a
real page — the thing a fake server cannot prove — and to be the shape a
browser lm15 application takes. It is a test, kept small; not a product.

## Run it

```bash
npm run build      # dist/browser.js and this example's build/
npm run example:openrouter  # serves this OAuth example; open the printed URL
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

Run `npm run test:example`. It first builds the package and page, then runs
`tools/example_ui.test.ts` using Playwright with the installed Chromium.
These tests open the actual page, check that sign-in controls are visible,
click the login button, simulate provider authorization, return to chat,
forget the key, and exercise failed-login recovery. All provider traffic in
these UI tests is intercepted; they need no account or real key. Playwright
is a development-only dependency, not part of the SDK or the static page.

Next, a loopback server plays OpenRouter under
`/fake/` — the authorization page (a real HTTP redirect back with a code
bound to the PKCE challenge), the code exchange (which verifies the
verifier against that challenge as RFC 7636 says, and refuses a second
use), the model list, streamed Chat Completions with usage, a slow stream
to cancel, a 401 for a wrong key, and the attribution headers recorded —
and drives this app's modules through it in Chromium and Firefox, headless,
through the real redirect. Then it loads the built `index.html` in Chromium
and reads the DOM back: the boot ran under the page's CSP.

Sixteen checks per browser, plus the page boot. With
`npm run test:example -- --live` and `OPENROUTER_API_KEY` set, eight more
run against the real openrouter.ai from the page — the CORS preflights,
the key verified (label, credit), 443 models listed, a streamed reply, a
second turn carrying the first, a cancel, a wrong key on a completion —
and a receipt goes under `receipts/` with the key redacted.

As of 2026-09-11 all 24 pass in Chromium 152 and Firefox 155
(`receipts/2026-09-11-browser-openrouter-live/`). The PKCE login itself
cannot run headless: it needs a person at OpenRouter's page.

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
- **OpenRouter's own consent screen.** The UI tests exercise this page's
  actual controls and callback, but simulate OpenRouter's authorization
  screen and responses. A person still needs to verify the real consent
  flow; automated checks must not be presented as that evidence.

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
6. **`listModels` from a page works** against OpenRouter's `/models`
   (443 models, live): every model comes back as `provider: "openrouter"`
   with its id, which is what a picker needs. OpenRouter's pricing and context length arrive
   too, but only as the raw entry under `origin.providerData`; nothing lifts
   them onto `inference` for this door yet, so a picker that wants to show
   a price reads the raw entry.
7. **Listing models proves nothing about the key.** Found live, not by the
   fake: OpenRouter's `/models` is public, so the first version of this
   page "signed in" a wrong key happily and only failed at the first
   message. The fake had required auth there — it mirrored an assumption,
   not the provider. Now the fake is public too, the page verifies a key
   against `/auth/key` (authenticated, CORS-open, answers with the key's
   label and remaining credit) before keeping it, and the wrong-key check
   is a completion. The general lesson for the docs site: a fixture
   written from an assumption is a fixture that agrees with you.
8. **A booted page can still be unusable.** The first boot check saw
   "Signed out" and passed, while both the sign-in and chat sections stayed
   hidden. A user could see only the informational OpenRouter homepage
   link. Signed-out states now restore the actual controls, and UI tests
   exercise their visibility and clicks. Testing the modules and a status
   string did not substitute for testing the user's path.

## Layout

| File | What |
|---|---|
| `index.html`, `app.css` | the page: CSP (`connect-src` is this origin and openrouter.ai; the import map is hash-allowed), no inline script otherwise |
| `src/login.ts` | PKCE begin/complete against OpenRouter's documented flow; the verifier in `sessionStorage`; the key hash for the manage link |
| `src/keys.ts` | the key for the tab, or the device on request; Forget |
| `src/chat.ts` | one `OpenAIChatLM` on OpenRouter's access policy plus attribution; models, wire preview, send, commit; typed errors to one line |
| `src/main.ts` | DOM glue: text nodes only, never HTML from a model |
| `build/` | `tsc -p tsconfig.examples.json` output, ignored by git; `npm run build` makes it |
