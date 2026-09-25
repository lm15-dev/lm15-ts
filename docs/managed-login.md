# Sign in once, use everywhere (managed login)

`Auth`, `connect()` and `BoundClient` implement lm15-contract's managed
authentication (`spec/auth-managed.md`, AUTH-12–26). They are the same
component as lm15-python's `lm15.login` — same rules, same store file, graded
by the same cases (the contract harness's `managed` direction) — so a login
made from Python is used, renewed and signed out from TypeScript, and the
other way round.

**What it gives you.** One place that remembers how you connect to each
provider — a subscription login, a pasted key, "use `$GROQ_API_KEY`", "use my
Claude Code login" — and one rule for which identity a request uses. Nothing
is picked silently; nothing falls back to a paid key behind your back.

**What it is not.** Not a framework, not an agent loop, not a global "current
account". It never starts a login during an ordinary request.

## The short path

```ts
import { connect } from "@lm15/lm15";

const lm = await connect();                 // asks: which connection? which model?
const answer = await lm.complete("Explain drought stress.");
console.log(answer.text);
await lm.close();
```

`connect()` says where connections are saved (`~/.config/lm15/credentials.json`
by default), offers saved connections first, then "connect another". For a new
connection it lists providers, then how to connect — subscriptions first, then
keys. A key already set in your environment is *offered* as an explicit choice,
never taken automatically. After a login it lists the account's models and asks
which one. It returns a client pinned to that connection and model.

It refuses to run without a person: with no terminal and no `ui`, it fails
before reading anything. On a server, attach an `Auth` to a router instead.

## The explicit pieces underneath

```ts
import { Auth, LMRouter, Message, TerminalUI } from "@lm15/lm15";

const auth = Auth.local();                                   // reads nothing yet
auth.providers();                                            // what can be connected
auth.methods("xai");                                         // how; each says supported / unverified / unavailable

await auth.login("xai", { method: "device", ui: new TerminalUI() });   // device code in the terminal; saved on success
await auth.setApiKey("groq", "gsk-…");                                // a literal key, no verification
await auth.configure("gemini", { method: "env", answers: { name: "GEMINI_API_KEY" } });   // use $GEMINI_API_KEY at request time
await auth.configure("claude-code", { method: "external:claude-code-cli" });            // your Claude Code login, read in place

await auth.status("xai");        // saved? ready / renewal_due / needs_login; expiry; no secrets
await auth.connections();
await auth.verify("xai");        // explicit non-inference check (lists models); may be metered
await auth.logout("xai");        // local forgetting, remembered across restarts

const router = new LMRouter({ auth });
await router.complete({ model: "xai:grok-4", messages: [Message.user("hi")] });
```

or bind one model:

```ts
import { BoundClient } from "@lm15/lm15";

const c = (await auth.status("xai")).connection!;
const lm = new BoundClient(auth, { provider: "xai", model: "grok-4", connectionId: c.id, identityGeneration: c.identityGeneration });
```

Every operation that touches the store or the network returns a promise.
`auth.login` takes a `signal`; aborting it ends the attempt with the
platform's `AbortError` and releases its reservation.

## Which identity a request uses

With `new LMRouter({ auth })`, in this order (AUTH-15):

1. An explicit `apiKeys` entry for the provider — deliberate authority, always wins.
2. An explicit named cloud identity (`credentials: { azure: "platform" }`).
3. The saved connection for that provider in this scope, renewed if due.
4. For keyless local servers only: the placeholder key.

**Never:** an environment variable, another tool's login file, or the
machine's cloud identity. A missing, expired-unrenewable, rejected or
signed-out connection is an `AuthOperationError` with a `reason`
(`login_required`, `credential_rejected`, `indeterminate`, …), never a silent
switch to a metered key. A managed router also routes the two
connection-only providers, `kimi-code` and `github-copilot`.

`router.lm()` is synchronous: it reads the saved connection (a file or memory
store reads synchronously) to learn the account's host and headers; the
credential itself is resolved — and renewed if due — at each request. A store
of your own that cannot read synchronously is consulted at the first request
instead.

## A bound client stays bound

The client `connect()` returns is pinned to one connection *id* and one model.
It follows that connection's token renewals. If you later replace the account
or sign out, the old client fails with `connection_changed` / `login_required`;
it never follows the new identity.

## Renewal, precisely

- A token is renewed within `min(5 minutes, lifetime / 10)` of its actual expiry.
- Renewal runs under the store's cross-process lock (the lock lm15-python
  uses). The winner re-reads the file first; if a sibling already renewed, it
  uses that result instead of spending the refresh token twice.
- A durable "renewal in flight" marker is written before the exchange. If the
  process dies mid-exchange, the next reader reports `indeterminate` — sign in
  again — rather than replaying a one-use token.
- A provider's definite rejection marks the connection `needs_login` and
  clears the unusable material. A server error, a rate limit or a refused
  connection keeps everything and fails only this request.

## Sign-in returns

Device-code logins show a code to enter on the provider's page. Browser logins
return either to a local listener (Node; loopback only, exact path, state
checked, one use) or by pasting the return URL or `code#state` — whichever
comes first. A paste that does not belong to this sign-in is rejected and you
are asked again; the attempt is not ended. In a web page there is no listener:
the page is the return target itself (`docs/browser.md`).

## Which logins are proven

`auth.methods(provider)` says so per method, with the same verdicts as
lm15-python: xAI's device login and the `external:*` CLI logins are
**supported**; the LM15-owned Claude, ChatGPT, Copilot, OpenRouter, Kimi Code
and Meta logins are **unverified** (implemented; no live receipt yet, or
provider permission and billing still unknown) and run only with
`allowUnverified: true`; Radius is **unavailable**. Live receipts recorded
from Python cover the protocol, not this package's run of it.

## Errors

`AuthOperationError` (`code: "auth_operation"`) is never auto-retried. Match
on `.reason`; read `.commitState` before deciding whether the store changed;
`.recovery` says what a person can do. Provider text is never copied into it.
