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

## Google Cloud

Three doors: `vertex` (Gemini in your project), `vertex-anthropic` (Claude in
your project) and `vertex-express` (Gemini with only an API key).

```ts
// Laptop: `gcloud auth application-default login` and
// `gcloud config set project my-project`, then nothing else.
const router = new LMRouter();
await router.complete({ model: "vertex:gemini-2.5-flash", messages: [Message.user("hi")] });

// Cloud Run, GKE, a VM: the attached service account; set nothing.
const deployed = new LMRouter({ credentials: { vertex: "platform" } });

// A Vertex API key in your project, in a region you choose.
const keyed = new LMRouter({
  apiKeys: { vertex: process.env.MY_VERTEX_KEY! },
  settings: { vertex: { location: "europe-west4" } },
});
```

The project is found the way Google's own libraries find it, first answer
wins: `settings`, `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT`, the
`GOOGLE_APPLICATION_CREDENTIALS` file's `project_id`, gcloud's active
configuration (`CLOUDSDK_CORE_PROJECT`, then `gcloud config set project`), the
ADC file's `quota_project_id`, then the metadata server on Google Cloud. The
metadata server is asked once, before the first request is built (the
constructor is synchronous); `plan()`, which sends nothing, shows a
`{project}` placeholder until then. `explainAuth("vertex")`
prints which source answered.

On `vertex` a string is a Vertex API key (`x-goog-api-key`) unless it looks
like a sign-in token (`ya29.…` or a JWT), which goes as bearer; wrap any other
token in `new BearerToken(value)`. `vertex` never reads `GOOGLE_API_KEY`: that
variable belongs to the Gemini API and `vertex-express`. Claude on Vertex takes
no keys, and a new project has no Claude quota until you request it.

A refused sign-in names its fix (`gcloud auth application-default login`, the
missing IAM role, an expired federation token) and shows only the status and a
standard OAuth error word from Google's reply. Verified live on 2026-09-26
through every Google identity above; see
`lm15-contract/changes/2026-09-26-vertex-live.md`.

## Browsers

Use `@lm15/lm15/browser` with explicit credentials and endpoint roots. Named cloud
chains are unavailable without a custom `Platform.openCloudChain`; browsers
have no CLI profiles or metadata identity discovery. Never bundle server
credentials into a page. CORS still governs which requests and diagnostic
headers the browser can expose.

Azure and AWS identities here are verified by the contract's recorded cases,
not yet by a live TypeScript run; Google Cloud was verified live (above).
