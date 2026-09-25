# Cloud identity and endpoints

The endpoint selects where a request goes; the credential selects who pays.
Neither changes the selected door's protocol, auth scheme or error mapping.

```ts
import { LMRouter } from "@lm15/lm15";

// Laptop: default cloud chain, with its concrete source available for diagnosis.
const laptop = new LMRouter();

// Deployment: only the selected identity mechanisms, never developer fallback.
const deployed = new LMRouter({
  credentials: { azure: "platform" },
  baseUrls: { azure: "https://acme.services.ai.azure.com" },
});

// Expert: a caller-owned provider; invoked for requests, never by plan().
const ownIdentity = new LMRouter({
  apiKeys: { azure: async () => getTokenFromYourIdentityService() },
  baseUrls: { azure: "https://acme.services.ai.azure.com" },
});
```

`getTokenFromYourIdentityService` above is application code, not an SDK helper.
A compact JWT string uses bearer auth on a door accepting both keys and bearer
tokens. `BearerToken` remains the explicit spelling. Identity behind an
application callback is not inspected.

## Named credentials

`RouterConfig.credentials` maps a cloud provider to `platform`, `workload`,
`environment` or `cli`. Direct adapters take `credential`. A name runs only its
listed rungs; it never falls through to an unrelated identity.

| Name | Azure | AWS | Google Cloud |
|---|---|---|---|
| `platform` | managed identity | container credentials, then IMDS | metadata service account |
| `workload` | workload identity | web identity | external-account ADC file |
| `environment` | service principal environment | access-key environment | service-account or impersonated-service-account ADC file |
| `cli` | Azure CLI, PowerShell, Azure Developer CLI | active profile (role, SSO, files, login, credential process) | local ADC file, then gcloud |

See the exact rung table exported as `NAMED_RUNGS`. A named selection combined
with an explicit `apiKeys` entry is an error, including a shared sibling key.
Unknown names and names on non-cloud doors are rejected at construction.

`lm.credentialOrigin()` describes the selected source without revealing its
value. Cloud provider callbacks expose a `CredentialSource` after acquisition,
including concrete rung, label, selected name and expiry when known. Auth errors
include provenance once, before repair guidance. `explainAuth` and
`router.doctor(model)` inspect configuration without obtaining a token.

## Endpoint roots

Precedence is explicit `baseUrls` / `baseUrl`, vendor endpoint environment,
then the door's template. The door appends its path unless already present,
including partial path overlap. Only HTTP(S) roots without userinfo, query or
fragment are accepted. An explicit root makes Azure `resource` optional; it
does not remove AWS signing `region` or settings used in request paths.

Supported vendor variables:

- Azure OpenAI doors: `AZURE_OPENAI_ENDPOINT`.
- Azure Anthropic: `ANTHROPIC_FOUNDRY_BASE_URL`.
- AWS: the door's `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`,
  `AWS_ENDPOINT_URL_BEDROCK_MANTLE` or
  `AWS_ENDPOINT_URL_AWS_EXTERNAL_ANTHROPIC`, then `AWS_ENDPOINT_URL`.
- Vertex: explicit endpoints only; no invented vendor variable.

The Azure template remains `openai.azure.com`: changing it would break classic
OpenAI resources. Paste the Foundry console root when using
`services.ai.azure.com`. Azure scope defaults to `https://ai.azure.com/.default`;
the `scope` setting can select the cognitive-services scope instead.

## Browsers

Use `@lm15/lm15/browser` with explicit credentials and endpoint roots. Named cloud
chains are unavailable without a custom `Platform.openCloudChain`; browsers
have no CLI profiles or metadata identity discovery. Never bundle server
credentials into a page. CORS still governs which requests and diagnostic
headers the browser can expose.

This implementation pass added regression sources but did not run them or
perform live cloud verification.
