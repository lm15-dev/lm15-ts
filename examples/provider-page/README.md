# Provider-neutral browser demo

Choose a provider, supply its API key, enter a model ID, and stream a reply
through `lm15/browser`. No OpenRouter account or shared gateway is required.
The earlier OpenRouter OAuth demo remains a separate protocol test.

```sh
npm run build
npm run example
```

The server opens a split view: chat on the left, runnable JavaScript on the
right. Keys and advanced options live in **Settings**. Enter your own key;
it is held only in memory, never in localStorage or sessionStorage. Switching providers
keeps their keys separate and starts a new conversation. Changing a custom
server's address clears its old key. Refreshing clears all keys.

Supported demo choices: OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek,
Z.AI, Meta, Moonshot/Kimi, Ollama, and a custom Chat Completions endpoint.
The SDK supplies the provider mappings; model suggestions are examples, not
promises that your account can access them. Model listing is optional and
does not prove authentication or inference access.

## Pickers and the code panel

Click the provider or model chip, or type a command in the message box:

- `/provider anth` fuzzy-filters provider IDs and names.
- `/model gpt4mini` fuzzy-filters the current provider's model IDs.
- `/settings` opens keys and connection options.
- `/` lists the commands. Arrow keys move, Enter chooses, Escape dismisses.
  Shift+Enter inserts a newline. Commands never become inference requests.

Model IDs are discovered automatically once the selected connection has a
key (or is a keyless local connection). Lists are cached per connection and
credential revision. Typing and filtering do not make more requests; an old
provider's delayed response cannot replace the active picker. Turn discovery
off or refresh its list in Settings. When listing fails or isn't supported,
enter an exact model ID; it is explicitly marked unverified.

Connection, Models, Request, and Streaming tabs show JavaScript examples for
the same selected provider, model, and prompt. UI actions focus the relevant
example. The examples contain placeholder keys only. Request and Streaming
replay every completed turn exactly as the page holds it, in canonical JSON
through `Message.fromJSON`, including thinking parts and continuation state,
then append your next message. Stopped or failed turns are not replayed. Copy
code copies the example, not your credentials. On narrow screens code stacks
below chat.

**Trade-off:** a shared example renderer maintains a small set of idiomatic
JavaScript patterns, rather than translating arbitrary application code. Tests
execute the actual generated examples and compare their requests with the
interface's shared connection helper. Other languages are not claimed yet.

## Private local test keys

```sh
npm run example:local
```

This explicitly reads the sibling `../.env` using Node's dotenv parser
(including `export KEY=...`). Only the nine named provider-key variables
listed in `connections.ts` are selected; unrelated secrets are excluded.

The server binds to `127.0.0.1`. The browser is opened with a random,
one-use capability in the URL fragment, never a provider key. The page
removes the fragment and fetches the keys from a protected same-origin route.
The capability expires after 30 minutes if unused. The server deletes its
credential handoff data after use. Requests without the capability, with
another Host/Origin, or repeating a consumed capability are refused.
No permissive CORS headers are returned. The dotenv file itself is not served.

The printed ordinary URL carries no capability and cannot automatically load
keys. Restart `npm run example:local` to open a fresh authorized test session
if you refresh or close the page. Do not expose this development server to
the network. Local software running as you can still inspect your process;
this feature is not a secret vault or a production credential-delivery service.

**Trade-off:** loading the keys gives this page's JavaScript access to them.
It is explicit local test functionality, never part of the public static
site. With automatic discovery enabled, loading keys fetches only the selected
provider's model IDs; switching connections may fetch another list. Your prompt
is never sent by discovery or by a selector. Only Send starts inference. Hosted
inference can cost money; Stop cancels the browser request but does not guarantee
a billing refund. Discovery can fail independently of chat and is optional.

## Browser connectivity

Requests go directly to each endpoint. Some permit browser origins; others
may refuse due to CORS or other network restrictions. This example does not
silently proxy requests or bypass browser protections. Anthropic connections
include its explicit direct-browser-access opt-in header. Custom endpoints
use the default Chat Completions policy; configure server-specific differences
in the SDK rather than claiming universal compatibility.

## Checks

`npm run test:providers` builds the actual page and runs Chromium interface
tests with dummy keys and intercepted provider replies. It checks all nine
provider selections, their credential isolation, real stream parsing, manual
key entry, clearing and reload. It also exercises fuzzy slash commands, model
caching, failed discovery with manual entry, stale-response isolation, keyboard
dismissal, and mobile layout. Server tests check opt-in, Host/Origin checks,
one-use authorization, no caching, and refusal to serve unrelated files.
These tests establish application behavior, not live availability of all nine
providers. They do not spend credits or use the developer's real keys.

`tests/provider_examples.test.ts` type-checks all 88 generated code variants
(with and without replayed history, including continuation state) against the
browser package, runs them with fake network responses, and checks that their
request bodies match the interface's. It also checks fuzzy ranking
and slash-command parsing. The package tests and existing protocol examples
remain separate checks.
