/**
 * Running a login on this platform: the pieces the managed `Auth` (the
 * TypeScript port of lm15-python `lm15.login.Auth`) will be built on, usable
 * on their own today for the browser exploration. What is here:
 *
 * - `loginProviders()` / `loginMethods()`: descriptors adjusted to the
 *   platform and routing (AUTH-13, AUTH-22). A page never inherits a native
 *   `supported`; a method whose sign-in endpoints a page cannot reach, with no
 *   relay configured for sign-in traffic, is `unavailable` before anything is
 *   clicked.
 * - `runLogin()` / `runRenewal()`: one attempt, errors mapped to AUTH-24.
 * - `renewalDue()`: the ratified lead, `min(5 min, lifetime / 10)`.
 * - `loginAdapter()`: the model adapter for a login's route, with its
 *   credential, and the relay for inference when the evidence says a page
 *   needs one and the person agreed.
 *
 * What is not here yet: the store, generations, reservations, bound clients
 * and `connect()`. Those are the managed-Auth port (store-layout.md). Nothing
 * here persists anything: the caller holds the outcome.
 */

import type { ProviderLM } from "../adapter.ts";
import { AuthOperationError, NotConfiguredError, ServerError, type AuthOperationStage } from "../errors.ts";
import { getDefaultPlatform } from "../platform.ts";
import { adapterFor, adapterForDefinition } from "../providers.ts";
import type { Transport } from "../transport.ts";
import { ApiKey, BearerToken } from "../types/credential.ts";
import { GITHUB_COPILOT_DEFINITION, KIMI_CODE_DEFINITION } from "./declared.ts";
import { LoginCancelled, LoginContext, LoginDenied, LoginExpired, relayCovers, type ExchangeRecord, type LoginRouting, type RelayConfig } from "./engine.ts";
import { claudeFlow } from "./flows/claude.ts";
import { codexFlow } from "./flows/codex.ts";
import { copilotFlow } from "./flows/copilot.ts";
import { kimiFlow } from "./flows/kimi.ts";
import { metaFlow } from "./flows/meta.ts";
import { openrouterFlow } from "./flows/openrouter.ts";
import { xaiFlow } from "./flows/xai.ts";
import type { MethodDefinition, ProviderFlow } from "./flows/base.ts";
import { ROUTE_DIRECTNESS } from "./profiles.ts";
import type {
  AuthUI, Delivery, LoginMaterial, LoginMethod, LoginOutcome, LoginPlatform, LoginRequestAuth, ProviderDescriptor, RelayStage,
} from "./types.ts";

const FLOWS: Readonly<Record<string, ProviderFlow>> = Object.freeze({
  xai: xaiFlow,
  "claude-code": claudeFlow,
  "openai-codex": codexFlow,
  "github-copilot": copilotFlow,
  openrouter: openrouterFlow,
  "kimi-code": kimiFlow,
  meta: metaFlow,
});

/** Where a login runs and which way its requests may travel. */
export interface LoginEnvironment {
  /** Default: `browser` unless the Node entry point installed its platform. */
  readonly platform?: LoginPlatform;
  /** A relay the person agreed to, for the stages it lists (proposed AUTH-21 promotion). Absent: everything direct. */
  readonly relay?: RelayConfig;
}

function routing(env: LoginEnvironment = {}): LoginRouting {
  const platform = env.platform ?? (getDefaultPlatform().name === "node" ? "native" : "browser");
  return env.relay ? { platform, relay: env.relay } : { platform };
}

/** Deliveries this build can run on this platform. The native loopback listener arrives with the managed-Auth port. */
function runnable(platform: LoginPlatform, delivery: readonly Delivery[]): Delivery[] {
  return delivery.filter((d) => d !== "loopback" && (platform === "browser" || d !== "page_redirect"));
}

function methodFor(flow: ProviderFlow, def: MethodDefinition, route: LoginRouting, settings: Readonly<Record<string, string>> = {}): LoginMethod {
  const delivery = runnable(route.platform, def.delivery);
  const needsRelay: RelayStage[] = [];
  if (route.platform === "browser") {
    if (flow.requests(def.id, settings).some((r) => r.browser === "relay")) needsRelay.push("auth");
    const direct = ROUTE_DIRECTNESS[flow.descriptor.id];
    if (direct?.catalog === "relay") needsRelay.push("catalog");
    if (direct?.inference === "relay") needsRelay.push("inference");
  }
  let availability: LoginMethod["availability"] = def.nativeAvailability;
  let reason = def.reason;
  if (availability !== "unavailable") {
    if (delivery.length === 0) {
      availability = "unavailable";
      reason = route.platform === "browser"
        ? "needs a local callback listener, which a web page cannot open"
        : "needs a callback this build does not provide yet (native listener: managed-Auth port)";
    } else if (needsRelay.includes("auth") && !relayCovers(route, "auth")) {
      availability = "unavailable";
      const hosts = [...new Set(flow.requests(def.id, settings).filter((r) => r.browser === "relay").map((r) => new URL(r.url).host))];
      reason = `in a web page, ${hosts.join(" and ")} ${hosts.length > 1 ? "need" : "needs"} a relay for sign-in traffic, and none is configured`;
    } else if (route.platform === "browser") {
      // AUTH-22: a native pass is not a browser pass.
      availability = "unverified";
      reason = `no browser receipt yet (lm15-contract auth/managed/browser.json)${def.reason ? `; natively: ${def.reason}` : ""}`;
    }
  }
  return Object.freeze({
    id: def.id, label: def.label, kind: def.kind, flow: def.flow, availability,
    ...(reason ? { reason } : {}),
    fields: def.fields ?? [], delivery, subscription: def.subscription,
    ...(def.billingNote ? { billingNote: def.billingNote } : {}),
    needsRelay,
  });
}

/** Every provider an account login exists for, with methods as this platform and routing can run them. No I/O. */
export function loginProviders(env: LoginEnvironment = {}): ProviderDescriptor[] {
  const route = routing(env);
  return Object.values(FLOWS).map((flow) => Object.freeze({
    id: flow.descriptor.id, label: flow.descriptor.label, service: flow.descriptor.service, routes: flow.descriptor.routes,
    methods: flow.descriptor.methods.map((m) => methodFor(flow, m, route)),
    ...(flow.descriptor.consoleUrl ? { consoleUrl: flow.descriptor.consoleUrl } : {}),
  }));
}

export function loginMethods(provider: string, env: LoginEnvironment = {}, settings: Readonly<Record<string, string>> = {}): LoginMethod[] {
  const flow = FLOWS[provider];
  if (!flow) throw new NotConfiguredError(`no account login is defined for provider ${JSON.stringify(provider)}`, { provider });
  const route = routing(env);
  return flow.descriptor.methods.map((m) => methodFor(flow, m, route, settings));
}

export interface RunLoginOptions extends LoginEnvironment {
  readonly ui: AuthUI;
  readonly signal?: AbortSignal;
  /** Attempt budget (default 15 minutes, AUTH-18). */
  readonly lifetimeMs?: number;
  /** Answers to the method's fields; missing required ones are asked through the UI. */
  readonly answers?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, string>>;
  /** Unverified methods run only with this (AUTH-13.5). */
  readonly allowUnverified?: boolean;
  /** Browser page redirect: the page the provider returns the person to (origin + path). */
  readonly pageReturnUrl?: string;
  /** Called once per auth exchange with a secret-free record. */
  readonly onExchange?: (record: ExchangeRecord) => void;
  /** Test seams. */
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  readonly wallClock?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function context(provider: string, opts: RunLoginOptions): LoginContext {
  return new LoginContext({
    ui: opts.ui, provider, routing: routing(opts),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.lifetimeMs !== undefined ? { lifetimeMs: opts.lifetimeMs } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.onExchange ? { onExchange: opts.onExchange } : {}),
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  // AUTH-24: cancellation stays native; never copy an arbitrary reason (it may carry anything) into a message.
  return reason instanceof Error && reason.name === "AbortError" ? reason : new DOMException("login cancelled", "AbortError");
}

function mapFailure(error: unknown, provider: string, methodId: string, operation: "login" | "renewal", signal?: AbortSignal): unknown {
  if (error instanceof LoginCancelled) return abortError(signal);
  if (error instanceof LoginExpired) {
    return new AuthOperationError(`${provider}: ${error.message}`, { reason: "login_expired", stage: operation === "login" ? "polling" : "renewal", recovery: "restart_login", provider, methodId, operation });
  }
  if (error instanceof LoginDenied) {
    const stage: AuthOperationStage = operation === "renewal" ? "renewal" : error.stage;
    return new AuthOperationError(`${provider}: ${error.message}${error.summary ? ` (${error.summary})` : ""}`, {
      reason: operation === "renewal" ? "credential_rejected" : "login_denied", stage, recovery: "restart_login",
      provider, methodId, operation, status: error.status, providerCode: error.providerCode,
      responseFormat: error.responseFormat, securityChallenge: error.securityChallenge,
    });
  }
  return error;
}

/** Run one login attempt to completion. Resolves with secret material the caller must store deliberately. */
export async function runLogin(provider: string, methodId: string, opts: RunLoginOptions): Promise<LoginOutcome> {
  const flow = FLOWS[provider];
  if (!flow) throw new NotConfiguredError(`no account login is defined for provider ${JSON.stringify(provider)}`, { provider });
  const settings = opts.settings ?? {};
  const method = loginMethods(provider, opts, settings).find((m) => m.id === methodId);
  if (!method) throw new AuthOperationError(`${provider}: no login method ${JSON.stringify(methodId)}`, { reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider });
  if (method.availability === "unavailable") {
    throw new AuthOperationError(`${provider}: method ${methodId} is unavailable here: ${method.reason ?? "no reason recorded"}`, { reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider, methodId });
  }
  if (method.availability === "unverified" && !opts.allowUnverified) {
    throw new AuthOperationError(`${provider}: method ${methodId} is unverified (${method.reason ?? ""}); pass allowUnverified: true to try it knowing that`, { reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider, methodId });
  }
  const ctx = context(provider, opts);
  try {
    const answers: Record<string, string> = { ...(opts.answers ?? {}) };
    for (const field of method.fields) {
      if (answers[field.id] !== undefined || !field.required) continue;
      answers[field.id] = await ctx.prompt(field.type === "secret" ? { type: "secret", fieldId: field.id, label: field.label } : { type: "text", fieldId: field.id, label: field.label });
    }
    const result = await flow.login(ctx, methodId, { settings, answers, ...(opts.pageReturnUrl ? { pageReturnUrl: opts.pageReturnUrl } : {}) });
    ctx.check(); // AUTH-18: a result received before expiry cannot be kept after it
    return Object.freeze({ provider, methodId, material: result.material, label: result.label, renewal: result.renewal, settings: Object.freeze({ ...settings, ...(result.settings ?? {}) }) });
  } catch (error) {
    throw mapFailure(error, provider, methodId, "login", opts.signal);
  }
}

export interface RunRenewalOptions extends Omit<RunLoginOptions, "ui" | "answers" | "allowUnverified" | "pageReturnUrl"> {
  /** Renewal never prompts; a UI is optional and only receives progress notices. */
  readonly ui?: AuthUI;
}

const SILENT_UI: AuthUI = {
  prompt: () => Promise.reject(new AuthOperationError("renewal never asks a person", { reason: "interaction_required", stage: "renewal", recovery: "restart_login" })),
  notify: () => undefined,
};

/** Renew now. A definite rejection is `credential_rejected` (sign in again); a lost reply on a one-use exchange is `indeterminate`. */
export async function runRenewal(outcome: LoginOutcome, opts: RunRenewalOptions = {}): Promise<LoginOutcome> {
  const flow = FLOWS[outcome.provider];
  if (!flow) throw new NotConfiguredError(`no account login is defined for provider ${JSON.stringify(outcome.provider)}`, { provider: outcome.provider });
  const ctx = context(outcome.provider, { ...opts, ui: opts.ui ?? SILENT_UI, lifetimeMs: opts.lifetimeMs ?? 60_000 });
  try {
    const result = await flow.renew(ctx, outcome.material, outcome.settings);
    return Object.freeze({ ...outcome, material: result.material, renewal: result.renewal });
  } catch (error) {
    if (error instanceof ServerError) throw error; // known safe: keep the credential, fail this renewal
    throw mapFailure(error, outcome.provider, outcome.methodId, "renewal", opts.signal);
  }
}

export const RENEWAL_LEAD_MS = 300_000;

/** AUTH-20: due within `min(5 min, lifetime / 10)` of the actual expiry. Unknown expiry is never due. */
export function renewalDue(material: LoginMaterial, nowMs: number = Date.now()): boolean {
  if (material.type !== "oauth" || typeof material.expires !== "number") return false;
  let lifetimeMs = typeof material.lifetime_s === "number" && material.lifetime_s > 0 ? material.lifetime_s * 1000 : undefined;
  if (lifetimeMs === undefined && typeof material.issued_at === "number") lifetimeMs = Math.max(material.expires - material.issued_at, 0);
  const lead = lifetimeMs === undefined ? RENEWAL_LEAD_MS : Math.min(RENEWAL_LEAD_MS, lifetimeMs / 10);
  return nowMs >= material.expires - lead;
}

/** What a model request needs from this login (secret: the credential). */
export function loginRequestAuth(outcome: LoginOutcome): LoginRequestAuth {
  const flow = FLOWS[outcome.provider];
  if (!flow) throw new NotConfiguredError(`no account login is defined for provider ${JSON.stringify(outcome.provider)}`, { provider: outcome.provider });
  return flow.requestAuth(outcome.material, outcome.settings);
}

export interface LoginAdapterOptions extends LoginEnvironment {
  readonly transport?: Transport;
  /** What the adapter will be used for: a model list (`catalog`) or model calls (`inference`, default). Relay consent is per stage. */
  readonly stage?: "catalog" | "inference";
}

function build(auth: LoginRequestAuth, baseUrl: string | undefined, transport: Transport | undefined): ProviderLM {
  const credential = auth.credential.kind === "bearer" ? new BearerToken(auth.credential.value) : new ApiKey(auth.credential.value);
  const opts = {
    apiKey: credential,
    ...(baseUrl ? { baseUrl } : {}),
    ...(auth.accountId ? { accountId: auth.accountId } : {}),
    ...(transport ? { transport } : {}),
  };
  if (auth.route === "github-copilot") return adapterForDefinition(GITHUB_COPILOT_DEFINITION, opts);
  if (auth.route === "kimi-code") return adapterForDefinition(KIMI_CODE_DEFINITION, opts);
  return adapterFor(auth.route, opts);
}

/** The API root model calls for this login go to, before any relay. Constructing an adapter sends nothing. */
export function loginBaseUrl(outcome: LoginOutcome): string {
  const auth = loginRequestAuth(outcome);
  return auth.baseUrl ?? build(auth, undefined, undefined).baseUrl;
}

/**
 * The model adapter for a login's route, carrying its credential. In a page,
 * a route the evidence says a page cannot call directly goes through the
 * relay only if the person agreed to relay inference; otherwise this refuses
 * before any request, naming why.
 */
export function loginAdapter(outcome: LoginOutcome, opts: LoginAdapterOptions = {}): ProviderLM {
  const auth = loginRequestAuth(outcome);
  const route = routing(opts);
  const stage = opts.stage ?? "inference";
  let baseUrl = loginBaseUrl(outcome);
  if (route.platform === "browser" && ROUTE_DIRECTNESS[auth.route]?.[stage] === "relay") {
    const host = new URL(baseUrl).host;
    if (!relayCovers(route, stage)) {
      throw new AuthOperationError(
        `${auth.route}: ${host} does not let a web page read its replies (lm15-contract auth/managed/browser.json); ${stage === "catalog" ? "model lists" : "model calls"} need a relay the person agreed to for ${stage}`,
        { reason: "method_unavailable", stage: "dispatch", recovery: "choose_method", provider: auth.route, delivery: "not_sent", host },
      );
    }
    baseUrl = route.relay!.rewrite(new URL(baseUrl)).toString().replace(/\/$/, "");
  }
  return build(auth, baseUrl, opts.transport);
}
