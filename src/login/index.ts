/**
 * Managed login, the mechanics (spec/auth-managed.md AUTH-12–26). Browser-safe:
 * nothing here imports a Node module. The managed `Auth` (store, generations,
 * bound clients, `connect()`) is built on these and is not in this build yet.
 */

export { loginProviders, loginMethods, runLogin, runRenewal, renewalDue, loginRequestAuth, loginAdapter, loginBaseUrl, RENEWAL_LEAD_MS } from "./run.ts";
export type { LoginEnvironment, RunLoginOptions, RunRenewalOptions, LoginAdapterOptions } from "./run.ts";
export { pathRelay, parseManualReturn, failureSummary, OAUTH_ERROR_CODES } from "./engine.ts";
export type { RelayConfig, LoginRouting, HttpReply, CallbackReturn, ReturnContext } from "./engine.ts";
export { GITHUB_COPILOT_DEFINITION, KIMI_CODE_DEFINITION, DECLARED_LOGIN_PROVIDERS } from "./declared.ts";
export { ROUTE_DIRECTNESS } from "./profiles.ts";
export type {
  Availability, AuthUI, AuthUrlNotice, ConnectionKind, Delivery, DeviceCodeNotice, InfoNotice, LoginFlow, LoginMaterial, LoginMethod,
  LoginOutcome, LoginPlatform, LoginRequestAuth, ManualCodePrompt, MethodField, Notice, OAuthMaterial, ApiKeyMaterial, ProgressNotice,
  Prompt, ProviderDescriptor, RelayStage, RenewalKind, SecretPrompt, SelectPrompt, TextPrompt,
} from "./types.ts";
