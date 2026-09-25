/**
 * `Auth`: one scope's connections and their lifecycle (spec/auth-managed.md
 * AUTH-14 construction is inert, AUTH-17 what each operation may touch,
 * AUTH-19 generations, replacement, logout and cancellation ordered against
 * commit, AUTH-20 renewal under the lock with a durable in-flight marker and
 * uncertainty never retried blind, AUTH-24 typed outcomes).
 *
 * Port of lm15-python `lm15/login/manager.py`, graded by the same cases
 * (lm15-contract `harness/managed.py`). The store layout is store-layout.md:
 * a slot per provider route, each with an identity generation (bumped on
 * every new connection and on logout, never reused) and a credential
 * revision (bumped on every renewal). A bound client pins
 * `(connectionId, generation)`; a managed router reads the slot per request.
 *
 * Legacy entries: a provider entry without a slot record (an xAI login made
 * before 2026-09-22, or by Pi) reads as generation 1 with id `legacy-<provider>`;
 * the record is written on the first managed commit that touches the slot,
 * so a file the manager never changed is never rewritten.
 */

import { AuthError, AuthOperationError, LM15Error, RateLimitError, ServerError, TransportError, type AuthOperationReason, type AuthOperationRecovery, type AuthOperationStage, type AuthCommitState } from "../errors.ts";
import { isJsonObject, RawNumber, type JsonObject, type JsonValue } from "../json.ts";
import { getDefaultPlatform } from "../platform.ts";
import { PROVIDERS, canonicalProvider } from "../registry.ts";
import { ATTEMPT_LIFETIME_MS, exchangeUncertain, LoginCancelled, LoginContext, LoginDenied, LoginExpired, randomBase64Url, type LoginRouting } from "./engine.ts";
import type { LoginMaterial } from "./types.ts";
import { recipeExpiry, recipeLogin, recipeRequestAuth, type Material, type RequestAuth } from "./recipes.ts";
import { MemoryStore, META_KEY, STORE_VERSION, Store, type Transaction } from "./store.ts";
import { ACCOUNT_FLOWS, descriptorFor, isAccountMethod, providerIds } from "./table.ts";
import type { AuthUI, ConnectionKind, LoginMethod, Prompt, ProviderDescriptor } from "./types.ts";

export const RENEWAL_LEAD_MS = 300_000; // AUTH-20.3: min(300 s, lifetime / 10)

// ─── Public, secret-free values (AUTH-12, AUTH-24) ────────────────────

export interface Connection {
  readonly id: string;
  readonly provider: string;
  readonly instanceId: string;
  readonly kind: ConnectionKind;
  readonly methodId: string;
  readonly routes: readonly string[];
  readonly label: string;
  readonly createdAt: string;
  readonly identityGeneration: string;
  readonly credentialRevision: string;
  readonly settings: Readonly<Record<string, string>>;
  /** Untrusted display text (AUTH-12); never proof of identity. */
  readonly accountLabel?: string;
}

export interface Verification {
  readonly result: "valid" | "rejected" | "unverified";
  readonly checkedAt?: string;
  readonly check?: string;
  readonly detail?: string;
}

export type Usability = "ready" | "renewal_due" | "needs_login" | "indeterminate" | "unknown";

/** AUTH-24: presence, usability and last verification are separate. */
export interface ConnectionStatus {
  readonly provider: string;
  readonly presence: "saved" | "absent";
  readonly usability: Usability;
  readonly connection: Connection | null;
  /** RFC 3339, `"never"`, `"unknown"`, or null when there is nothing to expire. */
  readonly expiresAt: string | null;
  readonly loggedOut: boolean;
  readonly verification: Verification | null;
  readonly detail: string | null;
  /** `usability` is `ready` or `renewal_due`. */
  readonly ready: boolean;
}

export interface ForgetResult {
  readonly provider: string;
  readonly forgot: boolean;
  readonly routes: readonly string[];
  readonly identityGeneration: string;
}

export type { RequestAuth } from "./recipes.ts";

export interface LoginOptions {
  /** A method id; omitted, the UI is asked when more than one selectable method remains (AUTH-13.6). */
  readonly method?: string;
  readonly ui: AuthUI;
  readonly settings?: Readonly<Record<string, string>>;
  readonly answers?: Readonly<Record<string, string>>;
  /** The connection id being replaced; without it an occupied slot is `connection_exists`. */
  readonly replace?: string;
  readonly signal?: AbortSignal;
  /** Attempt budget (default 15 minutes, AUTH-18). */
  readonly lifetimeMs?: number;
  /** Unverified methods run only with this (AUTH-13.5). */
  readonly allowUnverified?: boolean;
}

export interface ConfigureOptions {
  readonly method: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, string>>;
  readonly replace?: string;
}

export interface AuthOptions {
  /** Epoch milliseconds (tests). */
  readonly clock?: () => number;
  /** Monotonic milliseconds (tests). */
  readonly monotonic?: () => number;
  /** The fetch auth exchanges use (tests). */
  readonly fetch?: typeof fetch;
  /** A wait that honors the signal (tests). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Where logins run; default: the host platform (`native` under Node). */
  readonly routing?: LoginRouting;
}

// ─── Slots ───────────────────────────────────────────────────────────

interface Slot {
  provider: string;
  generation: number;
  connectionId: string | null;
  revision: number;
  kind: string;
  methodId: string;
  instanceId: string;
  label: string;
  accountLabel: string | null;
  createdAt: string;
  routes: string[];
  settings: Record<string, string>;
  state: string; // ready | needs_login | indeterminate
  renewal: string;
  loggedOut: boolean;
  renewalInFlight: JsonObject | null;
  attempt: JsonObject | null;
  verification: JsonObject | null;
  previousIds: string[];
  legacy: boolean;
}

function emptySlot(provider: string): Slot {
  return {
    provider, generation: 0, connectionId: null, revision: 0, kind: "account", methodId: "", instanceId: "public", label: "",
    accountLabel: null, createdAt: "", routes: [], settings: {}, state: "ready", renewal: "refresh_token", loggedOut: false,
    renewalInFlight: null, attempt: null, verification: null, previousIds: [], legacy: false,
  };
}

function text(value: JsonValue | undefined, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (value instanceof RawNumber) return value.raw;
  return typeof value === "string" ? value : String(value);
}

function int(value: JsonValue | undefined): number {
  const n = Number.parseInt(text(value, "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function slotFromRecord(provider: string, record: JsonObject): Slot {
  const settings: Record<string, string> = {};
  if (isJsonObject(record["settings"])) for (const [k, v] of Object.entries(record["settings"])) settings[k] = text(v);
  const routes = Array.isArray(record["routes"]) ? record["routes"].map((r) => text(r)) : [];
  const previous = Array.isArray(record["previous_ids"]) ? record["previous_ids"].map((r) => text(r)) : [];
  return {
    provider, generation: int(record["generation"]), connectionId: typeof record["connection_id"] === "string" ? record["connection_id"] : null,
    revision: int(record["revision"]), kind: text(record["kind"], "account"), methodId: text(record["method_id"]),
    instanceId: text(record["instance_id"], "public"), label: text(record["label"]),
    accountLabel: typeof record["account_label"] === "string" ? record["account_label"] : null,
    createdAt: text(record["created_at"]), routes, settings, state: text(record["state"], "ready"),
    renewal: text(record["renewal"], "refresh_token"), loggedOut: Boolean(record["logged_out"]),
    renewalInFlight: isJsonObject(record["renewal_in_flight"]) ? record["renewal_in_flight"] : null,
    attempt: isJsonObject(record["attempt"]) ? record["attempt"] : null,
    verification: isJsonObject(record["verification"]) ? record["verification"] : null,
    previousIds: previous, legacy: false,
  };
}

function slotRecord(slot: Slot): JsonObject {
  const record: JsonObject = {
    generation: String(slot.generation), connection_id: slot.connectionId, revision: String(slot.revision), kind: slot.kind,
    method_id: slot.methodId, instance_id: slot.instanceId, label: slot.label, created_at: slot.createdAt,
    routes: [...slot.routes], settings: { ...slot.settings }, state: slot.state, renewal: slot.renewal,
  };
  if (slot.accountLabel) record["account_label"] = slot.accountLabel;
  if (slot.loggedOut) record["logged_out"] = true;
  if (slot.renewalInFlight) record["renewal_in_flight"] = slot.renewalInFlight;
  if (slot.attempt) record["attempt"] = slot.attempt;
  if (slot.verification) record["verification"] = slot.verification;
  if (slot.previousIds.length > 0) record["previous_ids"] = slot.previousIds.slice(-8);
  return record;
}

function slotConnection(slot: Slot): Connection | null {
  if (!slot.connectionId) return null;
  return Object.freeze({
    id: slot.connectionId, provider: slot.provider, instanceId: slot.instanceId, kind: slot.kind as ConnectionKind,
    methodId: slot.methodId, routes: Object.freeze(slot.routes.length > 0 ? [...slot.routes] : [slot.provider]),
    label: slot.label || slot.provider, createdAt: slot.createdAt, identityGeneration: String(slot.generation),
    credentialRevision: String(slot.revision), settings: Object.freeze({ ...slot.settings }),
    ...(slot.accountLabel ? { accountLabel: slot.accountLabel } : {}),
  });
}

const LEGACY_METHOD: Readonly<Record<string, string>> = { xai: "device", "claude-code": "external:claude-code-cli", "openai-codex": "external:codex-cli" };

function view(document: JsonObject, provider: string): [Slot, JsonObject | null] {
  const meta = isJsonObject(document[META_KEY]) ? document[META_KEY] : {};
  const slots = isJsonObject(meta["slots"]) ? meta["slots"] : {};
  const record = slots[provider];
  const material = isJsonObject(document[provider]) ? document[provider] : null;
  if (isJsonObject(record)) return [slotFromRecord(provider, record), material];
  if (material !== null) {
    const oauth = material["type"] === "oauth";
    return [{
      ...emptySlot(provider), generation: 1, connectionId: `legacy-${provider}`, revision: 1, kind: oauth ? "account" : "api_key",
      methodId: LEGACY_METHOD[provider] ?? "api_key", label: `${provider} (existing login)`, routes: [provider], legacy: true,
      renewal: oauth ? "refresh_token" : "none",
    }, material];
  }
  return [emptySlot(provider), null];
}

function put(document: JsonObject, slot: Slot, material: JsonObject | null): JsonObject {
  if (!isJsonObject(document[META_KEY])) document[META_KEY] = { version: STORE_VERSION, slots: {} };
  const meta = document[META_KEY] as JsonObject;
  if (meta["version"] === undefined) meta["version"] = STORE_VERSION;
  if (!isJsonObject(meta["slots"])) meta["slots"] = {};
  (meta["slots"] as JsonObject)[slot.provider] = slotRecord(slot);
  if (material === null) delete document[slot.provider];
  else document[slot.provider] = material;
  return document;
}

// ─── Time ────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(Math.trunc(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function numberOf(value: unknown): number | undefined {
  if (value instanceof RawNumber) return Number(value.raw);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMinted(material: Material): boolean {
  return material["minted"] === true;
}

const RECIPE_TYPES = new Set(["api_key", "env", "external", "local", "cloud"]);

/** Which implementation owns this material: an account flow, or the recipes (store-layout.md). */
function accountFor(provider: string, material: Material): (typeof ACCOUNT_FLOWS)[string] | undefined {
  const kind = String(material["type"]);
  if (RECIPE_TYPES.has(kind) && !isMinted(material)) return undefined;
  return ACCOUNT_FLOWS[provider];
}

function expiryOf(provider: string, material: Material): number | "never" | null {
  const account = accountFor(provider, material);
  if (!account) return recipeExpiry(material);
  if (material["type"] === "api_key") return "never"; // a minted key (OpenRouter) is permanent
  const expires = numberOf(material["expires"]);
  return expires === undefined || typeof material["expires"] === "boolean" ? null : Math.trunc(expires);
}

function lifetimeMs(material: Material): number | undefined {
  const lifetime = numberOf(material["lifetime_s"]);
  if (lifetime !== undefined && lifetime > 0) return lifetime * 1000;
  const issued = numberOf(material["issued_at"]);
  const expires = numberOf(material["expires"]);
  if (issued !== undefined && expires) return Math.max(expires - Math.trunc(issued), 0);
  return undefined;
}

function leadMs(material: Material): number {
  const lifetime = lifetimeMs(material);
  return Math.trunc(lifetime === undefined ? RENEWAL_LEAD_MS : Math.min(RENEWAL_LEAD_MS, lifetime / 10));
}

function renewable(slot: Slot, material: Material): boolean {
  if (slot.renewal === "none" || slot.renewal === "recipe") return false;
  return Boolean(material["refresh"]);
}

// ─── Errors ──────────────────────────────────────────────────────────

function authError(message: string, fields: {
  reason: AuthOperationReason; stage: AuthOperationStage; recovery: AuthOperationRecovery; commitState?: AuthCommitState;
  provider?: string; connectionId?: string | null; attemptId?: string; methodId?: string; status?: number | null; providerCode?: string | null; operation?: string;
}): AuthOperationError {
  return new AuthOperationError(message, {
    reason: fields.reason, stage: fields.stage, recovery: fields.recovery, commitState: fields.commitState ?? "not_committed",
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.connectionId ? { connectionId: fields.connectionId } : {}),
    ...(fields.attemptId !== undefined ? { attemptId: fields.attemptId } : {}),
    ...(fields.methodId !== undefined ? { methodId: fields.methodId } : {}),
    ...(fields.status !== undefined ? { status: fields.status } : {}),
    ...(fields.providerCode !== undefined ? { providerCode: fields.providerCode } : {}),
    ...(fields.operation !== undefined ? { operation: fields.operation } : {}),
  });
}

/** A UI that cannot answer: any prompt is `interaction_required`. */
const NO_UI: AuthUI = {
  prompt: () => Promise.reject(authError("this operation needs a choice or input and no UI was supplied", { reason: "interaction_required", stage: "interaction", recovery: "provide_input" })),
  notify: () => undefined,
};

function isCancellation(error: unknown): boolean {
  return error instanceof LoginCancelled || (error instanceof Error && error.name === "AbortError");
}

// ─── The manager ─────────────────────────────────────────────────────

/**
 * A scope's connections. `Auth.local()` for the private file, `Auth.memory()`
 * for a process-lifetime store, `new Auth(store)` for an application's own.
 * Construction reads nothing (AUTH-14).
 */
/** What a manager and its pinned views share: seams, running attempts, the closed flag. */
interface AuthCore {
  readonly clock: () => number;
  readonly monotonic: () => number;
  readonly fetch: typeof fetch | undefined;
  readonly sleep: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly routing: LoginRouting | undefined;
  readonly active: Map<string, AbortController>;
  closed: boolean;
}

export class Auth {
  readonly store: Store;
  private readonly core: AuthCore;
  /** Set on a pinned view (`withPin`): every request-time resolution checks it. */
  private readonly pin: readonly [string, string] | undefined;

  constructor(store: Store, opts: AuthOptions = {}) {
    if (!(store instanceof Store)) throw new TypeError("new Auth(store) takes a lm15 login Store");
    this.store = store;
    this.core = {
      clock: opts.clock ?? (() => Date.now()),
      monotonic: opts.monotonic ?? (() => performance.now()),
      fetch: opts.fetch, sleep: opts.sleep, routing: opts.routing,
      active: new Map(), closed: false,
    };
    this.pin = undefined;
  }

  get #clock(): () => number { return this.core.clock; }
  get #monotonic(): () => number { return this.core.monotonic; }
  get #fetch(): typeof fetch | undefined { return this.core.fetch; }
  get #sleep(): ((ms: number, signal: AbortSignal) => Promise<void>) | undefined { return this.core.sleep; }
  get #routing(): LoginRouting | undefined { return this.core.routing; }
  get #active(): Map<string, AbortController> { return this.core.active; }

  /** The private file (AUTH-8 path, or `path`). Hosts without a filesystem refuse: use `Auth.memory()` or a store of your own. */
  static local(path?: string, opts: AuthOptions = {}): Auth {
    const open = getDefaultPlatform().openCredentialStore;
    if (!open) {
      throw authError(
        `the ${getDefaultPlatform().name} platform has no private file for saved connections; use Auth.memory() or pass a Store backed by the host's own storage`,
        { reason: "storage_unavailable", stage: "resolution", recovery: "operator_action" },
      );
    }
    return new Auth(open(path), opts);
  }

  static memory(opts: AuthOptions = {}): Auth {
    return new Auth(new MemoryStore(), opts);
  }

  toString(): string {
    return `Auth(${this.store.toString()})`;
  }

  /**
   * The same scope with every request-time resolution checked against one
   * `[connectionId, identityGeneration]` (a bound client's, AUTH-20.1).
   * Shares the store, seams and running attempts; owns nothing.
   */
  withPin(pin: readonly [string, string]): Auth {
    const view = new Auth(this.store);
    (view as unknown as { core: AuthCore }).core = this.core;
    (view as unknown as { pin: readonly [string, string] }).pin = Object.freeze([pin[0], pin[1]] as const);
    return view;
  }

  /** The pin of a view made by `withPin`, if any. */
  get pinned(): readonly [string, string] | undefined {
    return this.pin;
  }

  // ─── discovery (AUTH-13): definitions only ─────────────────────────

  providers(): ProviderDescriptor[] {
    return providerIds().map((p) => descriptorFor(p, this.#loginEnv())!);
  }

  methods(provider: string): readonly LoginMethod[] {
    return this.descriptor(provider).methods;
  }

  descriptor(provider: string): ProviderDescriptor {
    const descriptor = descriptorFor(provider, this.#loginEnv());
    if (!descriptor) {
      throw authError(`${JSON.stringify(provider)} is not a provider lm15 can connect; see auth.providers()`, {
        reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider,
      });
    }
    return descriptor;
  }

  #loginEnv() {
    return this.#routing ? { platform: this.#routing.platform, ...(this.#routing.relay ? { relay: this.#routing.relay } : {}) } : {};
  }

  // ─── inspection (AUTH-17: store reads only) ────────────────────────

  async connections(): Promise<Connection[]> {
    const document = await this.store.read();
    const known = new Set(providerIds());
    const found: Connection[] = [];
    for (const key of Object.keys(document).sort()) {
      if (key === META_KEY || !known.has(key)) continue;
      const connection = slotConnection(view(document, key)[0]);
      if (connection) found.push(connection);
    }
    const meta = isJsonObject(document[META_KEY]) ? document[META_KEY] : {};
    const slots = isJsonObject(meta["slots"]) ? meta["slots"] : {};
    for (const [key, record] of Object.entries(slots)) {
      if (key in document || !isJsonObject(record)) continue;
      const connection = slotConnection(slotFromRecord(key, record));
      if (connection) found.push(connection);
    }
    return found;
  }

  async status(provider: string): Promise<ConnectionStatus> {
    provider = this.descriptor(provider).id;
    return this.#statusFrom(await this.store.read(), provider);
  }

  /** @internal `status` over a store that reads synchronously (the doctor, a router's `lm()`); `undefined` for one that cannot. */
  statusSync(provider: string): ConnectionStatus | undefined {
    if (!this.store.readSync) return undefined;
    provider = this.descriptor(provider).id;
    return this.#statusFrom(this.store.readSync(), provider);
  }

  #statusFrom(document: JsonObject, provider: string): ConnectionStatus {
    const [slot, material] = view(document, provider);
    const connection = slotConnection(slot);
    const verification = slot.verification ? {
      result: text(slot.verification["result"]) as Verification["result"],
      ...(slot.verification["checked_at"] ? { checkedAt: text(slot.verification["checked_at"]) } : {}),
      ...(slot.verification["check"] ? { check: text(slot.verification["check"]) } : {}),
      ...(slot.verification["detail"] ? { detail: text(slot.verification["detail"]) } : {}),
    } : null;
    if (!connection) {
      return Object.freeze({
        provider, presence: "absent", usability: "unknown", connection: null, expiresAt: null, loggedOut: slot.loggedOut,
        verification: null, detail: slot.loggedOut ? "signed out; sign in again or pass a key explicitly" : null, ready: false,
      });
    }
    const [usability, expiresAt, detail] = this.#usability(slot, material);
    return Object.freeze({
      provider, presence: "saved", usability, connection, expiresAt, loggedOut: false, verification, detail,
      ready: usability === "ready" || usability === "renewal_due",
    });
  }

  #usability(slot: Slot, material: JsonObject | null): [Usability, string | null, string | null] {
    if (slot.state === "needs_login") return ["needs_login", null, "the provider rejected the saved credential; sign in again"];
    if (slot.state === "indeterminate" || slot.renewalInFlight) return ["indeterminate", null, "a renewal was interrupted; sign in again to be safe"];
    if (material === null) return ["needs_login", null, "credential material is missing"];
    const expiry = expiryOf(slot.provider, material);
    if (expiry === "never") return ["ready", "never", null];
    if (expiry === null) return material["type"] === "external" ? ["ready", "unknown", null] : ["unknown", "unknown", null];
    if (this.#clock() >= expiry - leadMs(material)) {
      if (!renewable(slot, material)) return ["needs_login", iso(expiry), "expired and not renewable"];
      return ["renewal_due", iso(expiry), null];
    }
    return ["ready", iso(expiry), null];
  }

  // ─── login (AUTH-16/17/18/19) ──────────────────────────────────────

  /**
   * Run one login to completion and save the connection. The login is saved
   * before this resolves; a later failure elsewhere never undoes it.
   * Cancelling `signal` rejects with the platform's `AbortError`.
   */
  async login(provider: string, opts: LoginOptions): Promise<Connection> {
    this.#checkOpen();
    const descriptor = this.descriptor(provider);
    provider = descriptor.id;
    const lifetime = opts.lifetimeMs ?? ATTEMPT_LIFETIME_MS;
    if (!(typeof lifetime === "number" && lifetime > 0)) throw new RangeError("lifetimeMs must be a positive number of milliseconds");
    let chosen: LoginMethod;
    try {
      chosen = await this.#chooseMethod(descriptor, opts.method, opts.ui, opts.allowUnverified === true);
    } catch (error) {
      if (isCancellation(error)) throw cancelled(opts.signal);
      throw error;
    }
    const answers: Record<string, string> = { ...(opts.answers ?? {}) };
    const settings: Record<string, string> = { ...(opts.settings ?? {}) };
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) controller.abort(opts.signal.reason);
    const ctx = this.#context(provider, opts.ui, controller.signal, lifetime);
    const attemptId = `at_${randomBase64Url(16)}`;
    // Reservation (AUTH-17/18): storage proven writable, one active attempt
    // per slot, generation observed — before any browser opens.
    await this.store.reserve();
    const expected = await this.#reserve(provider, attemptId, opts.replace, lifetime);
    this.#active.set(provider, controller);
    try {
      for (const field of chosen.fields) {
        if (answers[field.id] !== undefined) continue;
        let prompt: Prompt;
        if (!field.required && field.type !== "select") prompt = { type: "text", fieldId: field.id, label: field.label };
        else if (field.type === "secret") prompt = { type: "secret", fieldId: field.id, label: field.label };
        else if (field.type === "select") prompt = { type: "select", fieldId: field.id, label: field.label, options: field.options ?? [] };
        else prompt = { type: "text", fieldId: field.id, label: field.label };
        answers[field.id] = await ctx.prompt(prompt);
      }
      let result: { material: Material; label: string; renewal: string; settings?: Readonly<Record<string, string>>; accountLabel?: string };
      try {
        result = await this.#runMethod(provider, chosen, ctx, answers, settings);
        ctx.check(); // AUTH-18: a result received before expiry cannot be kept after it
      } catch (error) {
        throw this.#loginFailure(error, provider, attemptId, chosen.id, lifetime, opts.signal);
      }
      return await this.#commit(provider, attemptId, expected, chosen, result, settings);
    } catch (error) {
      // Any exit without a saved connection ends the attempt, so its
      // reservation must not outlive it. Releasing an attempt that is no
      // longer this one's is a no-op.
      await this.#release(provider, attemptId);
      if (isCancellation(error)) throw cancelled(opts.signal);
      throw error;
    } finally {
      this.#active.delete(provider);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  #context(provider: string, ui: AuthUI, signal: AbortSignal, lifetimeMs: number): LoginContext {
    const platform = this.#routing?.platform ?? (getDefaultPlatform().name === "node" ? "native" : "browser");
    return new LoginContext({
      ui, provider, signal, lifetimeMs,
      routing: this.#routing ?? { platform },
      clock: this.#monotonic, wallClock: this.#clock,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      ...(this.#sleep ? { sleep: this.#sleep } : {}),
    });
  }

  async #runMethod(provider: string, method: LoginMethod, ctx: LoginContext, answers: Record<string, string>, settings: Record<string, string>) {
    if (isAccountMethod(provider, method.id)) {
      const flow = ACCOUNT_FLOWS[provider]!;
      const result = await flow.login(ctx, method.id, { settings, answers });
      return { material: result.material as unknown as Material, label: result.label, renewal: result.renewal, ...(result.settings ? { settings: result.settings } : {}), ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}) };
    }
    return recipeLogin(provider, method.id, answers, settings);
  }

  #loginFailure(error: unknown, provider: string, attemptId: string, methodId: string, lifetime: number, signal?: AbortSignal): unknown {
    if (isCancellation(error)) return error;
    if (error instanceof LoginExpired) {
      return authError(`${provider}: the sign-in was not completed within ${Math.trunc(lifetime / 60_000)} minutes; start again`, {
        reason: "login_expired", stage: "polling", recovery: "restart_login", provider, attemptId, methodId,
      });
    }
    if (error instanceof LoginDenied) {
      return authError(`${provider}: ${error.message}`, {
        reason: "login_denied", stage: error.stage === "polling" ? "authorization" : error.stage, recovery: "restart_login", provider, attemptId, methodId,
        status: error.status, providerCode: error.providerCode,
      });
    }
    if (exchangeUncertain(error) || (error instanceof AuthOperationError && error.reason === "indeterminate")) {
      return authError(`${provider}: the network failed after the authorization code may have been sent; the code is one-use, so sign in again rather than retry`, {
        reason: "indeterminate", stage: "exchange", recovery: "restart_login", provider, attemptId, methodId,
      });
    }
    void signal;
    return error;
  }

  async #chooseMethod(descriptor: ProviderDescriptor, method: string | undefined, ui: AuthUI, allowUnverified: boolean): Promise<LoginMethod> {
    const unavailable = (message: string, methodId?: string) => authError(message, {
      reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider: descriptor.id, ...(methodId ? { methodId } : {}),
    });
    if (method !== undefined) {
      const chosen = descriptor.methods.find((m) => m.id === method);
      if (!chosen) throw unavailable(`${descriptor.id}: no login method ${JSON.stringify(method)}; see auth.methods(${JSON.stringify(descriptor.id)})`);
      if (chosen.availability === "unavailable") throw unavailable(`${descriptor.id}: method ${JSON.stringify(method)} is unavailable: ${chosen.reason ?? ""}`, method);
      if (chosen.availability === "unverified" && !allowUnverified) {
        throw unavailable(`${descriptor.id}: method ${JSON.stringify(method)} has no live receipt yet (${chosen.reason ?? ""}); pass allowUnverified: true to try it knowing that`, method);
      }
      return chosen;
    }
    const candidates = descriptor.methods.filter((m) => m.availability === "supported" || (allowUnverified && m.availability === "unverified"));
    if (candidates.length === 0) throw unavailable(`${descriptor.id}: no selectable login method here`);
    if (candidates.length === 1) return candidates[0]!;
    let answer: string;
    try {
      answer = await ui.prompt({
        type: "select", fieldId: "method", label: `How do you want to connect to ${descriptor.label}?`,
        options: candidates.map((m) => ({ id: m.id, label: m.label, ...(m.billingNote ?? m.reason ? { description: (m.billingNote ?? m.reason)! } : {}) })),
      }, { signal: new AbortController().signal });
    } catch (error) {
      if (error instanceof LM15Error) throw error;
      throw new LoginCancelled("login cancelled at the method prompt");
    }
    const found = candidates.find((m) => m.id === answer);
    if (!found) {
      throw authError(`${descriptor.id}: the UI answered ${JSON.stringify(answer)}, which is not one of the offered method ids`, {
        reason: "invalid_login_state", stage: "interaction", recovery: "choose_method", provider: descriptor.id,
      });
    }
    return found;
  }

  /** Reserve the slot's single active attempt; resolve with the generation the commit must find. */
  async #reserve(provider: string, attemptId: string, replace: string | undefined, lifetimeMs: number): Promise<number> {
    const now = this.#clock() / 1000;
    const document = await this.store.mutate((doc) => {
      const [slot, material] = view(doc, provider);
      const pending = slot.attempt;
      if (pending && pending["id"] !== attemptId) {
        const started = numberOf(pending["started_at_s"]) ?? 0;
        const budget = numberOf(pending["lifetime_s"]) ?? ATTEMPT_LIFETIME_MS / 1000;
        if (now - started < budget) {
          throw authError(`${provider}: another sign-in is already in progress in this scope; finish it or cancel it (auth.cancelLogin)`, {
            reason: "login_in_progress", stage: "reservation", recovery: "inspect_attempt", provider, attemptId: text(pending["id"]),
          });
        }
      }
      if (slot.connectionId && !replace) {
        throw authError(`${provider}: a connection is already saved (${slot.connectionId}); pass replace with that id to replace it, or logout first`, {
          reason: "connection_exists", stage: "reservation", recovery: "select_connection", provider, connectionId: slot.connectionId,
        });
      }
      if (replace && slot.connectionId !== replace) {
        throw authError(`${provider}: replace=${JSON.stringify(replace)} does not name the current connection; select again`, {
          reason: "connection_changed", stage: "reservation", recovery: "select_connection", provider, connectionId: slot.connectionId,
        });
      }
      slot.attempt = { id: attemptId, expected_generation: String(slot.generation), started_at_s: now, lifetime_s: lifetimeMs / 1000 };
      return put(doc, slot, material);
    });
    return view(document, provider)[0].generation;
  }

  async #release(provider: string, attemptId: string): Promise<void> {
    try {
      await this.store.mutate((doc) => {
        const [slot, material] = view(doc, provider);
        if (!slot.attempt || slot.attempt["id"] !== attemptId) return undefined;
        slot.attempt = null;
        return put(doc, slot, material);
      });
    } catch {
      // releasing a reservation must not mask the real failure
    }
  }

  async #commit(provider: string, attemptId: string, expected: number, method: LoginMethod,
    result: { material: Material; label: string; renewal: string; settings?: Readonly<Record<string, string>>; accountLabel?: string },
    settings: Record<string, string>): Promise<Connection> {
    const created = iso(this.#clock());
    const connectionId = `cn_${randomBase64Url(12)}`;
    const routes = [...this.descriptor(provider).routes];
    let document: JsonObject;
    try {
      document = await this.store.mutate((doc) => {
        const [slot] = view(doc, provider);
        if (!slot.attempt || slot.attempt["id"] !== attemptId) {
          throw authError(`${provider}: this sign-in was cancelled before it could be saved`, {
            reason: "invalid_login_state", stage: "persistence", recovery: "restart_login", provider, attemptId,
          });
        }
        if (slot.generation !== expected) {
          throw authError(`${provider}: the saved connection changed while you were signing in; select again`, {
            reason: "connection_changed", stage: "persistence", recovery: "select_connection", provider, attemptId,
          });
        }
        const merged = slot.connectionId ? { ...slot.settings, ...settings, ...(result.settings ?? {}) } : { ...settings, ...(result.settings ?? {}) };
        const next: Slot = {
          ...emptySlot(provider), generation: slot.generation + 1, connectionId, revision: 1, kind: method.kind, methodId: method.id,
          label: result.label, accountLabel: result.accountLabel ?? null, createdAt: created, routes: routes.length > 0 ? routes : [provider],
          settings: merged, state: "ready", renewal: result.renewal,
          previousIds: [...slot.previousIds, ...(slot.connectionId ? [slot.connectionId] : [])],
        };
        return put(doc, next, { ...result.material } as JsonObject);
      });
    } catch (error) {
      if (error instanceof AuthOperationError || !(error instanceof LM15Error)) throw error;
      // A grant may exist at the provider; nothing usable is returned and nothing is revoked as compensation (AUTH-19).
      throw authError(`${provider}: signed in, but the credential could not be saved (${error.code}); repair the store and sign in again`, {
        reason: "storage_unavailable", stage: "persistence", recovery: "repair_storage", provider, attemptId,
      });
    }
    return slotConnection(view(document, provider)[0])!;
  }

  /** Durably cancel the slot's active attempt: `cancelled`, `complete` when a commit already won (undo is logout), or `none`. */
  async cancelLogin(provider: string): Promise<"cancelled" | "complete" | "none"> {
    provider = this.descriptor(provider).id;
    let outcome: "cancelled" | "complete" | "none" = "none";
    await this.store.mutate((doc) => {
      const [slot, material] = view(doc, provider);
      if (!slot.attempt) {
        outcome = slot.connectionId ? "complete" : "none";
        return undefined;
      }
      slot.attempt = null;
      outcome = "cancelled";
      return put(doc, slot, material);
    });
    this.#active.get(provider)?.abort(); // the durable record first (AUTH-19), then the running attempt here
    return outcome;
  }

  // ─── setup without a provider round-trip (AUTH-17) ─────────────────

  /** Save a literal key (no interpolation, no verification). */
  async setApiKey(provider: string, key: string, opts: { replace?: string } = {}): Promise<Connection> {
    if (typeof key !== "string" || !key.trim()) {
      throw authError("setApiKey: the key is empty", { reason: "interaction_required", stage: "interaction", recovery: "provide_input", provider });
    }
    return this.configure(provider, { method: "api_key", answers: { key }, ...(opts.replace !== undefined ? { replace: opts.replace } : {}) });
  }

  /**
   * Save a recipe connection: `env` (use `$VAR` at request time),
   * `external:<source>` (another tool's login, read in place), `cloud` (a
   * named cloud identity), `local` (a keyless server), or `api_key`. No
   * credential is acquired and nothing is verified.
   */
  async configure(provider: string, opts: ConfigureOptions): Promise<Connection> {
    this.#checkOpen();
    const descriptor = this.descriptor(provider);
    provider = descriptor.id;
    const chosen = descriptor.methods.find((m) => m.id === opts.method);
    if (!chosen) {
      throw authError(`${provider}: no setup method ${JSON.stringify(opts.method)}; see auth.methods(${JSON.stringify(provider)})`, {
        reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider,
      });
    }
    if (chosen.flow !== "form" && chosen.flow !== "source_recipe") {
      throw authError(`${provider}: ${JSON.stringify(opts.method)} is an interactive login; use auth.login`, {
        reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider,
      });
    }
    const answers = { ...(opts.answers ?? {}) };
    const settings = { ...(opts.settings ?? {}) };
    for (const field of chosen.fields) {
      if (field.required && !answers[field.id]) {
        throw authError(`${provider}: ${JSON.stringify(opts.method)} needs ${JSON.stringify(field.id)}`, {
          reason: "interaction_required", stage: "interaction", recovery: "provide_input", provider,
        });
      }
    }
    const attemptId = `at_${randomBase64Url(16)}`;
    await this.store.reserve();
    const expected = await this.#reserve(provider, attemptId, opts.replace, 60_000);
    let result;
    try {
      result = recipeLogin(provider, opts.method, answers, settings);
    } catch (error) {
      await this.#release(provider, attemptId);
      if (error instanceof LoginDenied) {
        throw authError(`${provider}: ${error.message}`, { reason: "login_denied", stage: "interaction", recovery: "provide_input", provider });
      }
      throw error;
    }
    return this.#commit(provider, attemptId, expected, chosen, result, settings);
  }

  // ─── logout (AUTH-19) ──────────────────────────────────────────────

  /**
   * Forget the connection locally: material removed, generation bumped,
   * pending attempt cancelled, a marker kept so a restart cannot fall back
   * to an ambient key (R3). Never calls a provider's revoke endpoint; never
   * touches another tool's file.
   */
  async logout(providerOrConnection: string): Promise<ForgetResult> {
    this.#checkOpen();
    const [provider, targetId] = await this.#resolveTarget(providerOrConnection);
    let outcome = { forgot: false, generation: 0, routes: [] as string[] };
    await this.store.mutate((doc) => {
      const [slot] = view(doc, provider);
      if (targetId !== null && slot.connectionId !== targetId) {
        outcome = { forgot: false, generation: slot.generation, routes: slot.routes };
        return undefined; // idempotent: a newer id occupying the slot is untouched
      }
      if (slot.connectionId === null && !slot.attempt) {
        outcome = { forgot: false, generation: slot.generation, routes: slot.routes };
        return undefined;
      }
      const next: Slot = {
        ...emptySlot(provider), generation: slot.generation + 1, revision: 0, kind: slot.kind, methodId: slot.methodId,
        routes: slot.routes.length > 0 ? slot.routes : [provider], state: "ready", renewal: "none", loggedOut: true,
        previousIds: [...slot.previousIds, ...(slot.connectionId ? [slot.connectionId] : [])],
      };
      outcome = { forgot: true, generation: next.generation, routes: next.routes };
      this.#active.get(provider)?.abort();
      return put(doc, next, null);
    });
    return Object.freeze({
      provider, forgot: outcome.forgot, routes: Object.freeze(outcome.routes.length > 0 ? outcome.routes : [provider]),
      identityGeneration: String(outcome.generation),
    });
  }

  async #resolveTarget(target: string): Promise<[string, string | null]> {
    if (target.startsWith("cn_") || target.startsWith("legacy-")) {
      for (const connection of await this.connections()) if (connection.id === target) return [connection.provider, connection.id];
      const document = await this.store.read();
      const meta = isJsonObject(document[META_KEY]) ? document[META_KEY] : {};
      const slots = isJsonObject(meta["slots"]) ? meta["slots"] : {};
      for (const [key, record] of Object.entries(slots)) {
        if (isJsonObject(record) && Array.isArray(record["previous_ids"]) && record["previous_ids"].includes(target)) return [key, target];
      }
      throw authError("no saved connection has that id", { reason: "attempt_unavailable", stage: "resolution", recovery: "select_connection" });
    }
    return [this.descriptor(target).id, null];
  }

  // ─── verification (AUTH-17) ────────────────────────────────────────

  /**
   * An explicit, non-inference check: resolve (renewing if due) and list
   * models on the route. Not universal, and possibly metered by the provider.
   */
  async verify(provider: string, opts: { routerConfig?: import("../router.ts").RouterConfig } = {}): Promise<Verification> {
    this.#checkOpen();
    provider = this.descriptor(provider).id;
    const definition = PROVIDERS.get(provider);
    if (!definition || !definition.access.supports.models) {
      return Object.freeze({ result: "unverified", check: "models", detail: "this route has no safe non-inference check" });
    }
    const { LMRouter } = await import("../router.ts");
    const router = new LMRouter({ ...(opts.routerConfig ?? {}), auth: this });
    const checkedAt = iso(this.#clock());
    let result: Verification;
    try {
      await router.lm(`${provider}:verify`).listModels();
      result = { result: "valid", checkedAt, check: "models" };
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      result = { result: "rejected", checkedAt, check: "models", detail: error.code };
    } finally {
      await router.close();
    }
    try {
      await this.store.mutate((doc) => {
        const [slot, material] = view(doc, provider);
        if (slot.connectionId === null) return undefined;
        slot.verification = { result: result.result, checked_at: result.checkedAt ?? null, check: result.check ?? null, detail: result.detail ?? null };
        return put(doc, slot, material);
      });
    } catch {
      // recording a check never fails the check
    }
    return Object.freeze(result);
  }

  // ─── request-time resolution (AUTH-15/20) ──────────────────────────

  /**
   * What a request on `provider` sends now: the saved connection's
   * credential, renewed under the lock if due. `pinned` is a bound client's
   * `[connectionId, generation]`; a mismatch is `connection_changed`, never
   * a silent rebind (AUTH-20.1).
   */
  async requestAuth(provider: string, opts: { pinned?: readonly [string, string] } = {}): Promise<RequestAuth> {
    provider = this.descriptor(provider).id;
    const pinned = this.pin ?? opts.pinned;
    const [slot, material] = view(await this.store.read(), provider);
    this.#checkSelected(provider, slot, material, pinned);
    const expiry = expiryOf(provider, material!);
    if (expiry === "never" || expiry === null || this.#clock() < expiry - leadMs(material!)) return this.#authFrom(provider, material!, slot);
    return this.#renew(provider, pinned);
  }

  #checkSelected(provider: string, slot: Slot, material: JsonObject | null, pinned: readonly [string, string] | undefined): void {
    if (pinned !== undefined && (slot.connectionId !== pinned[0] || String(slot.generation) !== pinned[1])) {
      if (slot.connectionId === null) {
        throw authError(`${provider}: the connection this client was bound to was signed out; connect again`, {
          reason: "login_required", stage: "resolution", recovery: "restart_login", provider, connectionId: pinned[0],
        });
      }
      throw authError(`${provider}: the saved connection was replaced after this client was bound; connect again`, {
        reason: "connection_changed", stage: "resolution", recovery: "select_connection", provider, connectionId: pinned[0],
      });
    }
    if (slot.connectionId === null || material === null) {
      const message = slot.loggedOut
        ? `${provider}: signed out; sign in again (auth.login) or pass a key explicitly (apiKeys)`
        : `${provider}: no saved connection in this scope; sign in with auth.login or connect()`;
      throw authError(message, { reason: "login_required", stage: "resolution", recovery: "restart_login", provider });
    }
    if (slot.state === "needs_login") {
      throw authError(`${provider}: the saved credential was rejected by the provider; sign in again`, {
        reason: "login_required", stage: "resolution", recovery: "restart_login", provider, connectionId: slot.connectionId,
      });
    }
    if (slot.state === "indeterminate" || slot.renewalInFlight) {
      throw authError(`${provider}: a credential renewal was interrupted and its outcome is unknown; sign in again rather than reuse a possibly consumed token`, {
        reason: "indeterminate", stage: "resolution", commitState: "unknown", recovery: "restart_login", provider, connectionId: slot.connectionId,
      });
    }
  }

  async #authFrom(provider: string, material: JsonObject, slot: Slot): Promise<RequestAuth> {
    try {
      const account = accountFor(provider, material);
      if (!account) return await recipeRequestAuth(material);
      const auth = account.requestAuth(material as unknown as LoginMaterial, slot.settings);
      return Object.freeze({
        credential: { kind: auth.credential.kind, value: auth.credential.value }, headers: { ...auth.headers },
        baseUrl: auth.baseUrl ?? null, accountId: auth.accountId ?? null, named: null,
      });
    } catch (error) {
      if (error instanceof LoginDenied) {
        throw authError(`${provider}: ${error.message}`, { reason: "login_required", stage: "resolution", recovery: "restart_login", provider, connectionId: slot.connectionId });
      }
      throw error;
    }
  }

  /**
   * @internal What a router needs to build this provider's LM, read
   * synchronously and without renewal: the selection checks of
   * `requestAuth`, then the saved connection's non-secret request shape
   * (base URL, headers, account id, or the named cloud identity). The
   * credential itself stays per request (`credentialProvider`). `undefined`
   * when the store cannot read synchronously.
   */
  selectionSync(provider: string): { readonly connection: Connection; readonly named: string | null; readonly baseUrl: string | null; readonly headers: Readonly<Record<string, string>>; readonly accountId: string | null } | undefined {
    if (!this.store.readSync) return undefined;
    provider = this.descriptor(provider).id;
    const [slot, material] = view(this.store.readSync(), provider);
    this.#checkSelected(provider, slot, material, this.pin);
    const connection = slotConnection(slot)!;
    const kind = material!["type"];
    if (kind === "cloud") return { connection, named: text(material!["named"] as JsonValue), baseUrl: null, headers: {}, accountId: null };
    if (kind === "local") return { connection, named: null, baseUrl: text(material!["base_url"] as JsonValue) || null, headers: {}, accountId: null };
    if (kind === "external") {
      const peek = getDefaultPlatform().externalLogins?.peek?.(text(material!["source"] as JsonValue));
      return { connection, named: null, baseUrl: null, headers: peek?.headers ?? {}, accountId: peek?.accountId ?? null };
    }
    const account = accountFor(provider, material!);
    if (!account) return { connection, named: null, baseUrl: null, headers: {}, accountId: null };
    try {
      const auth = account.requestAuth(material as unknown as LoginMaterial, slot.settings);
      return { connection, named: null, baseUrl: auth.baseUrl ?? null, headers: { ...auth.headers }, accountId: auth.accountId ?? null };
    } catch (error) {
      if (error instanceof LoginDenied) {
        throw authError(`${provider}: ${error.message}`, { reason: "login_required", stage: "resolution", recovery: "restart_login", provider, connectionId: slot.connectionId });
      }
      throw error;
    }
  }

  /** AUTH-20.4: lock, re-read, reuse a sibling's fresh result, else mark in flight, exchange, write — all under the lock. */
  async #renew(provider: string, pinned: readonly [string, string] | undefined): Promise<RequestAuth> {
    const ctx = this.#context(provider, NO_UI, new AbortController().signal, 60_000);
    return this.store.transaction(async (txn) => {
      const document = await txn.read();
      const [slot, material] = view(document, provider);
      this.#checkSelected(provider, slot, material, pinned);
      const expiry = expiryOf(provider, material!);
      if (expiry === "never" || expiry === null || this.#clock() < expiry - leadMs(material!)) return this.#authFrom(provider, material!, slot); // a sibling renewed while we waited
      const mark = async (state: string, opts: { drop?: boolean; keepMarker?: boolean } = {}) => {
        slot.state = state;
        if (!opts.keepMarker) slot.renewalInFlight = null;
        await txn.write(put(document, slot, opts.drop ? null : material));
      };
      if (!renewable(slot, material!)) {
        await mark("needs_login", { drop: true });
        throw authError(`${provider}: the saved credential expired and cannot be renewed; sign in again`, {
          reason: "credential_rejected", stage: "renewal", commitState: "committed", recovery: "restart_login", provider, connectionId: slot.connectionId,
        });
      }
      // Durable in-flight marker before the possibly rotating exchange.
      slot.renewalInFlight = { started_at: iso(this.#clock()), revision: String(slot.revision) };
      await txn.write(put(document, slot, material));
      const account = accountFor(provider, material!);
      let renewed: { material: Material; accountLabel?: string };
      try {
        if (!account) throw new LoginDenied(`${provider}: this connection has nothing to renew`);
        const result = await account.renew(ctx, material as unknown as LoginMaterial, slot.settings);
        renewed = { material: result.material as unknown as Material, ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}) };
      } catch (error) {
        if (error instanceof LoginDenied) {
          await mark("needs_login", { drop: true });
          throw authError(`${provider}: renewal failed (${error.message}); sign in again`, {
            reason: "credential_rejected", stage: "renewal", commitState: "committed", recovery: "restart_login", provider,
            connectionId: slot.connectionId, status: error.status, providerCode: error.providerCode,
          });
        }
        if (error instanceof RateLimitError || error instanceof ServerError) {
          await mark("ready"); // known safe: keep the credential
          throw error;
        }
        if (exchangeUncertain(error) || (error instanceof AuthOperationError && error.reason === "indeterminate")) {
          await mark("indeterminate", { keepMarker: true });
          throw authError(`${provider}: the renewal exchange timed out after it may have reached the provider; a rotated token cannot be spent twice, so sign in again`, {
            reason: "indeterminate", stage: "renewal", commitState: "unknown", recovery: "restart_login", provider, connectionId: slot.connectionId,
          });
        }
        if (error instanceof TransportError || error instanceof AuthOperationError) {
          await mark("ready");
          throw error;
        }
        await mark("indeterminate", { keepMarker: true });
        throw error;
      }
      slot.renewalInFlight = null;
      slot.revision += 1;
      slot.state = "ready";
      if (renewed.accountLabel) slot.accountLabel = renewed.accountLabel;
      const next = { ...renewed.material } as JsonObject;
      await txn.write(put(document, slot, next));
      return this.#authFrom(provider, next, slot);
    });
  }

  /** A per-request credential for the adapters (AUTH-2): each call is `requestAuth`. */
  credentialProvider(provider: string, opts: { pinned?: readonly [string, string] } = {}): () => Promise<string> {
    provider = this.descriptor(provider).id;
    return async () => {
      const auth = await this.requestAuth(provider, opts);
      if (!auth.credential) throw authError(`${provider}: this connection names a cloud identity, not a credential`, { reason: "method_unavailable", stage: "resolution", recovery: "operator_action", provider });
      return auth.credential.value;
    };
  }

  // ─── housekeeping ─────────────────────────────────────────────────

  /** Cancel logins this manager is running; never a logout. */
  close(): void {
    this.core.closed = true;
    for (const controller of this.#active.values()) controller.abort();
  }

  #checkOpen(): void {
    if (this.core.closed) throw authError("this Auth was closed", { reason: "storage_unavailable", stage: "resolution", recovery: "operator_action" });
  }
}

function cancelled(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error && reason.name === "AbortError" ? reason : new DOMException("login cancelled", "AbortError");
}

// keep the unused-type import honest for declaration output
export type { Transaction };
