# Provider-neutral browser demo

Choose a provider, supply its API key, enter a model ID, and stream a reply
through `lm15/browser`. No OpenRouter account or shared gateway is required.
The earlier OpenRouter OAuth demo remains a separate protocol test.

```sh
npm run build
npm run example
```

The server opens the page in your browser. Enter your own key; it is held
only in memory, never in localStorage or sessionStorage. Switching providers
keeps their keys separate and starts a new conversation. Changing a custom
server's address clears its old key. Refreshing clears all keys.

Supported demo choices: OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek,
Z.AI, Meta, Moonshot/Kimi, Ollama, and a custom Chat Completions endpoint.
The SDK supplies the provider mappings; model suggestions are examples, not
promises that your account can access them. Model listing is optional and
does not prove authentication or inference access.

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
site. No request goes to a provider just because keys were loaded. Only
List models and Send contact the selected provider. Hosted inference can cost
money; Stop cancels the browser request but does not guarantee a billing refund.

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
key entry, clearing and reload. Server tests check opt-in, Host/Origin checks,
one-use authorization, no caching, and refusal to serve unrelated files.
These tests establish application behavior, not live availability of all nine
providers. They do not spend credits or use the developer's real keys.

The package tests and the existing protocol examples remain separate checks.
