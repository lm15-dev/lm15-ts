/**
 * `connect()`: get ready to make model requests (AUTH-23). Port of
 * lm15-python `lm15/interactive.py`.
 *
 * ```ts
 * import { connect } from "@lm15/lm15";
 * const lm = await connect();            // pickers in the terminal
 * console.log((await lm.complete("Explain drought stress.")).text);
 * await lm.close();
 * ```
 *
 * In order: says where connections are saved; offers the saved connections
 * and "connect another" (subscriptions first; an ambient environment key is
 * offered only as an explicit choice, never taken silently: R2/R3); runs the
 * chosen login or setup; lists the account's models (or takes `model`) and
 * asks; returns a `BoundClient` pinned to that connection and model. A
 * completed login is saved before the model picker runs: cancel the picker
 * and the login stays (R6).
 *
 * Never: send a prompt, set a process-wide default, change another router,
 * fall back to a different account when one fails. Without a UI and without
 * a terminal it fails before reading any secret: a server attaches an `Auth`
 * with saved connections to its router instead.
 */

import { AuthOperationError, LM15Error } from "../errors.ts";
import { getDefaultPlatform } from "../platform.ts";
import type { RouterConfig } from "../router.ts";
import { BoundClient, modelChoices, routed, type Capability, type ModelChoice, type ModelSelection } from "./bound.ts";
import { Auth, type Connection } from "./manager.ts";
import type { AuthUI, LoginMethod, Prompt, ProviderDescriptor, SelectOption } from "./types.ts";

const NEW = "__new__";
const MANUAL = "__manual__";

export interface ConnectOptions {
  /** Skip the provider picker. */
  readonly provider?: string;
  /** Skip the model picker. */
  readonly model?: string;
  /** Default: `Auth.local()` (the private file). */
  readonly auth?: Auth;
  /** Default: a terminal UI when stdin and stderr are a terminal. */
  readonly ui?: AuthUI;
  /** Offer only models known to support it; unknown ones are not offered. */
  readonly capability?: Capability;
  /** Terminal UI only: open authorization URLs in the browser. */
  readonly openBrowser?: boolean;
  readonly routerConfig?: RouterConfig;
  /** Offer login methods that exist but have no live receipt yet, labelled as such. */
  readonly allowUnverified?: boolean;
  readonly signal?: AbortSignal;
}

function cancelledError(): AuthOperationError {
  return new AuthOperationError("cancelled", { reason: "interaction_required", stage: "interaction", recovery: "restart_login" });
}

async function ask(ui: AuthUI, prompt: Prompt, signal?: AbortSignal): Promise<string> {
  try {
    return await ui.prompt(prompt, { signal: signal ?? new AbortController().signal });
  } catch (error) {
    if (error instanceof LM15Error) throw error;
    throw cancelledError();
  }
}

export async function connect(opts: ConnectOptions = {}): Promise<BoundClient> {
  let ui = opts.ui;
  if (ui === undefined) {
    ui = getDefaultPlatform().terminalUI?.({ ...(opts.openBrowser !== undefined ? { openBrowser: opts.openBrowser } : {}) });
    if (ui === undefined) {
      throw new AuthOperationError(
        "connect() needs a person: no interactive terminal here and no ui was supplied. On a server, attach an Auth with saved connections (new LMRouter({ auth })) instead of calling connect().",
        { reason: "interaction_required", stage: "interaction", recovery: "provide_input" },
      );
    }
  }
  const auth = opts.auth ?? Auth.local();
  ui.notify({ type: "info", message: `Connections are saved privately in ${auth.store.description}.` });
  const connection = await chooseConnection(auth, ui, opts);
  const selection = await chooseModel(auth, ui, connection, opts);
  ui.notify({ type: "info", message: `Ready: ${routed(selection)} through ${connection.label}.` });
  return new BoundClient(auth, selection, opts.routerConfig ? { routerConfig: opts.routerConfig } : {});
}

async function chooseConnection(auth: Auth, ui: AuthUI, opts: ConnectOptions): Promise<Connection> {
  const wanted = opts.provider !== undefined ? auth.descriptor(opts.provider).id : undefined;
  const saved = (await auth.connections()).filter((c) => wanted === undefined || c.provider === wanted);
  // Subscriptions first (R2): account connections before keys.
  saved.sort((a, b) => (a.kind === "account" ? 0 : 1) - (b.kind === "account" ? 0 : 1) || a.provider.localeCompare(b.provider));
  const usable: Connection[] = [];
  for (const connection of saved) {
    const status = await auth.status(connection.provider);
    if (status.usability === "ready" || status.usability === "renewal_due" || status.usability === "unknown") usable.push(connection);
  }
  if (wanted !== undefined && usable.length === 1) return usable[0]!;
  const options: SelectOption[] = usable.map((c) => ({ id: c.id, label: c.label, description: `${c.provider} · saved` }));
  options.push({ id: NEW, label: "Connect another account or API key" });
  if (options.length === 1) return newConnection(auth, ui, wanted, opts);
  const answer = await ask(ui, { type: "select", fieldId: "connection", label: "Use a saved connection, or connect another?", options }, opts.signal);
  if (answer === NEW) return newConnection(auth, ui, wanted, opts);
  const found = usable.find((c) => c.id === answer);
  if (!found) throw new AuthOperationError("the UI answered with an unknown connection id", { reason: "invalid_login_state", stage: "interaction", recovery: "select_connection" });
  return found;
}

async function newConnection(auth: Auth, ui: AuthUI, provider: string | undefined, opts: ConnectOptions): Promise<Connection> {
  if (provider === undefined) {
    const descriptors = auth.providers().filter((d) => d.methods.some((m) => m.availability !== "unavailable"));
    const subscription = (d: ProviderDescriptor) => (d.methods.some((m) => m.subscription && m.availability === "supported") ? 0 : 1);
    descriptors.sort((a, b) => subscription(a) - subscription(b) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    provider = await ask(ui, {
      type: "select", fieldId: "provider", label: "Which provider?",
      options: descriptors.map((d) => ({ id: d.id, label: d.label, ...(d.service !== d.label ? { description: d.service } : {}) })),
    }, opts.signal);
  }
  const descriptor = auth.descriptor(provider);
  const existing = (await auth.status(descriptor.id)).connection;
  const method = await chooseMethod(ui, descriptor, opts);
  let replace: string | undefined;
  if (existing) {
    const answer = await ask(ui, {
      type: "select", fieldId: "replace", label: `${descriptor.label} already has a saved connection (${existing.label}).`,
      options: [{ id: "keep", label: "Keep it" }, { id: "replace", label: "Replace it" }],
    }, opts.signal);
    if (answer === "keep") return existing;
    replace = existing.id;
  }
  if (method.flow === "form" || method.flow === "source_recipe") {
    const answers: Record<string, string> = {};
    for (const field of method.fields) {
      const choices = field.options ?? [];
      if (field.type === "select" && choices.length === 1) answers[field.id] = choices[0]!.id;
      else if (field.type === "select") answers[field.id] = await ask(ui, { type: "select", fieldId: field.id, label: field.label, options: choices }, opts.signal);
      else if (field.type === "secret") answers[field.id] = await ask(ui, { type: "secret", fieldId: field.id, label: field.label }, opts.signal);
      else answers[field.id] = await ask(ui, { type: "text", fieldId: field.id, label: field.label }, opts.signal);
    }
    return auth.configure(descriptor.id, { method: method.id, answers, ...(replace !== undefined ? { replace } : {}) });
  }
  try {
    return await auth.login(descriptor.id, {
      method: method.id, ui, ...(replace !== undefined ? { replace } : {}), ...(opts.allowUnverified ? { allowUnverified: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AuthOperationError("sign-in cancelled", { reason: "interaction_required", stage: "interaction", recovery: "restart_login", provider: descriptor.id });
    }
    throw error;
  }
}

async function chooseMethod(ui: AuthUI, descriptor: ProviderDescriptor, opts: ConnectOptions): Promise<LoginMethod> {
  const methods = descriptor.methods.filter((m) => m.availability === "supported" || (opts.allowUnverified && m.availability === "unverified"));
  if (methods.length === 0) {
    throw new AuthOperationError(`${descriptor.id}: no login method is available here`, { reason: "method_unavailable", stage: "discovery", recovery: "choose_method", provider: descriptor.id });
  }
  // Subscriptions first; an ambient key is offered, never assumed (R2).
  const rank = (m: LoginMethod) => (m.subscription ? 0 : 2) + (m.kind === "account" ? 0 : 1);
  methods.sort((a, b) => rank(a) - rank(b));
  const env = getDefaultPlatform().env();
  const options: SelectOption[] = [];
  for (const method of methods) {
    let note = method.billingNote;
    if (method.availability === "unverified") note = `UNVERIFIED — ${method.reason ?? ""}`;
    if (method.id === "env") {
      const set = (method.fields[0]?.options ?? []).map((o) => o.id).filter((name) => env[name]);
      if (set.length === 0) continue; // nothing to offer
      note = `$${set[0]} is set in this environment; using it is your explicit choice`;
    }
    options.push({ id: method.id, label: method.label, ...(note ? { description: note } : {}) });
  }
  const chosen = options.length === 1 ? options[0]!.id : await ask(ui, { type: "select", fieldId: "method", label: `How do you want to connect to ${descriptor.label}?`, options }, opts.signal);
  const method = descriptor.methods.find((m) => m.id === chosen);
  if (!method) throw new AuthOperationError("the UI answered with an unknown method id", { reason: "invalid_login_state", stage: "interaction", recovery: "choose_method", provider: descriptor.id });
  return method;
}

async function chooseModel(auth: Auth, ui: AuthUI, connection: Connection, opts: ConnectOptions): Promise<ModelSelection> {
  const selection = (model: string): ModelSelection => ({ provider: connection.provider, model, connectionId: connection.id, identityGeneration: connection.identityGeneration });
  if (opts.model !== undefined) return selection(opts.model);
  let choices: ModelChoice[] = [];
  let note = "";
  try {
    choices = await modelChoices(auth, connection.provider, {
      refresh: true, ...(opts.capability ? { capability: opts.capability } : {}), ...(opts.routerConfig ? { routerConfig: opts.routerConfig } : {}),
    });
    note = "listed by your account just now";
  } catch (error) {
    if (error instanceof AuthOperationError) throw error;
    // The catalog is a convenience: say why it is missing, do not pretend.
    ui.notify({ type: "info", message: `Could not list models for ${connection.provider} (${error instanceof Error ? error.name : "error"}); type a model id.` });
  }
  const options: SelectOption[] = choices.map((c) => ({ id: c.model, label: c.model, ...(note ? { description: note } : {}) }));
  options.push({ id: MANUAL, label: "Type a model id (not verified against your account)" });
  if (opts.capability && choices.length === 0) ui.notify({ type: "info", message: `No model in the list is known to support ${JSON.stringify(opts.capability)}; you can still type one.` });
  let answer = await ask(ui, { type: "select", fieldId: "model", label: `Which ${connection.provider} model?`, options }, opts.signal);
  if (answer === MANUAL) {
    answer = (await ask(ui, { type: "text", fieldId: "model", label: "Model id" }, opts.signal)).trim();
    if (!answer) throw new AuthOperationError("no model id given", { reason: "interaction_required", stage: "interaction", recovery: "provide_input", provider: connection.provider });
  }
  return selection(answer);
}
