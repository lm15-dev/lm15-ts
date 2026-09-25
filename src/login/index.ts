/**
 * Managed authentication (spec/auth-managed.md AUTH-12–26). Browser-safe:
 * nothing here imports a Node module. `Auth` owns a scope's connections
 * (store, generations, renewal, logout); `connect()` and `BoundClient` are
 * the interactive short path; the mechanics below them (`runLogin`, relays,
 * the flows) stay usable on their own. The Node entry adds the private file
 * store (`Auth.local()`), the loopback listener and the terminal UI.
 */

export { Auth, RENEWAL_LEAD_MS as MANAGED_RENEWAL_LEAD_MS } from "./manager.ts";
export type { AuthOptions, ConfigureOptions, Connection, ConnectionStatus, ForgetResult, LoginOptions, RequestAuth, Usability, Verification } from "./manager.ts";
export { Store, MemoryStore, META_KEY, STORE_VERSION, validateDocument } from "./store.ts";
export type { Transaction } from "./store.ts";
export { BoundClient, modelChoices, routed } from "./bound.ts";
export type { BoundRequestFields, Capability, CapabilityState, ModelChoice, ModelSelection } from "./bound.ts";
export { connect } from "./connect.ts";
export type { ConnectOptions } from "./connect.ts";
export { EXTERNAL_SOURCES } from "./recipes.ts";
export { LoginCancelled } from "./engine.ts";

export { loginProviders, loginMethods, runLogin, runRenewal, renewalDue, loginRequestAuth, loginAdapter, loginBaseUrl, loginWay, RENEWAL_LEAD_MS } from "./run.ts";
export type { LoginEnvironment, RunLoginOptions, RunRenewalOptions, LoginAdapterOptions } from "./run.ts";
export { pathRelay, tunnelRelay, parseManualReturn, failureSummary, OAUTH_ERROR_CODES } from "./engine.ts";
export { TlsEngine, TlsError } from "../tunnel/tls.ts";
export type { TlsSession } from "../tunnel/tls.ts";
export { tunnelFetch } from "../tunnel/tunnel.ts";
export type { TunnelOptions } from "../tunnel/tunnel.ts";
export type { RelayConfig, LoginRouting, HttpReply, CallbackReturn, ReturnContext, ExchangeRecord } from "./engine.ts";
export { GITHUB_COPILOT_DEFINITION, KIMI_CODE_DEFINITION, DECLARED_LOGIN_PROVIDERS } from "./declared.ts";
export { ROUTE_DIRECTNESS } from "./profiles.ts";
export type {
  Availability, AuthUI, AuthUrlNotice, ConnectionKind, Delivery, DeviceCodeNotice, InfoNotice, LoginFlow, LoginMaterial, LoginMethod,
  LoginOutcome, LoginPlatform, LoginRequestAuth, ManualCodePrompt, MethodField, Notice, OAuthMaterial, ApiKeyMaterial, ProgressNotice,
  Prompt, ProviderDescriptor, RelayStage, RenewalKind, SecretPrompt, SelectOption, SelectPrompt, TextPrompt,
} from "./types.ts";
