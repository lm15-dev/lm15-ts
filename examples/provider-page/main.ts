/** The playground: a chat, its settings, and the same request in three languages that actually run. */
import { Message, type Request } from "lm15/browser";
import { CONNECTIONS } from "./connections.ts";
import { Credentials } from "./credentials.ts";
import { DEFAULT_SETTINGS, LANGUAGES, buildRequest, createClient, exampleCurl, exampleJavascript, exampleJson, examplePython, exampleRust, fuzzyScore, keyPage, keyless, slashCommand, type Connection, type Language, type PickerKind, type Settings, type Wire } from "./experience.ts";
import { Picker, type PickOption, type PickResult } from "./picker.ts";
import { javascriptRuntime } from "./runtimes/javascript.ts";
import type { Runtime, RuntimeId } from "./runtimes/index.ts";
import { pythonRuntime } from "./runtimes/python.ts";
import { rustRuntime } from "./runtimes/rust.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const prompt = $<HTMLTextAreaElement>("prompt");
const send = $<HTMLButtonElement>("send");
const stop = $<HTMLButtonElement>("stop");
const keyInput = $<HTMLInputElement>("key");
const remember = $<HTMLInputElement>("remember");
const endpoint = $<HTMLInputElement>("endpoint");
const automatic = $<HTMLInputElement>("automatic-models");
const systemInput = $<HTMLTextAreaElement>("system");
const temperatureInput = $<HTMLInputElement>("temperature");
const temperatureReset = $<HTMLButtonElement>("temperature-reset");
const maxTokensInput = $<HTMLInputElement>("max-tokens");
const reasoningInput = $<HTMLSelectElement>("reasoning");

const RUNTIMES: Record<RuntimeId, Runtime> = { javascript: javascriptRuntime, python: pythonRuntime, rust: rustRuntime };
const connection: Connection = { provider: "openai", model: "gpt-4.1-mini", endpoint: "http://localhost:1234/v1" };
const settings: Settings = { ...DEFAULT_SETTINGS };
const credentials = new Credentials();
const keyRevision = new Map<string, number>();
interface Catalogue { ids: string[]; status: string; loading: boolean; error?: string }
const catalogues = new Map<string, Catalogue>();
let messages: Message[] = [];
let generation = 0;
let active: AbortController | undefined;
let runtime: RuntimeId = "javascript";
let language: Language = "javascript";
let lastPrompt = "Hello!";

const picker = new Picker(options, (kind, id) => {
  if (kind === "commands") {
    if (id === "settings") openSettings();
    else if (id === "model" && automatic.checked) void discover();
    return;
  }
  if (kind === "provider") selectProvider(id);
  else selectModel(id);
  prompt.focus();
});

// ─── Rendering ────────────────────────────────────────────────────────

function notify(text = "") { $("alert").textContent = text; $("alert").hidden = !text; }
function redact(text: string): string {
  for (const key of credentials.providers().map((p) => credentials.get(p)!)) if (key.length > 3) text = text.split(key).join("[redacted]");
  return text;
}
function errorMessage(error: unknown): string {
  const named = error instanceof Error && error.name !== "Error" ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : String(error);
  return redact(named) + "\nBrowser access depends on the provider: a network failure may be CORS or connectivity. Requests are not proxied.";
}
function currentChoice() { return CONNECTIONS.find((choice) => choice.id === connection.provider)!; }
function cacheKey(): string { return `${connection.provider}:${connection.endpoint}:${keyRevision.get(connection.provider) ?? 0}`; }
function draft(): string {
  const text = prompt.value.trim();
  return text && !slashCommand(text) ? text : messages.length ? "Your next message" : lastPrompt;
}

let codeVersion = 0;
async function updateCode(): Promise<void> {
  const version = ++codeVersion;
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-language]")) tab.setAttribute("aria-pressed", String(tab.dataset.language === language));
  const text = redact(draft());
  let code = "";
  let note = "";
  try {
    if (!maxTokensInput.validity.valid) throw new Error("Max tokens must be a whole number from 1 to 100000.");
    if (language === "javascript") { code = exampleJavascript(connection, settings, messages, text); note = "Runs here as the JavaScript runtime: lm15/browser in this page."; }
    else if (language === "python") { code = examplePython(connection, settings, messages, text); note = "Runs here as the Python runtime: this text, under Pyodide. On CPython drop the FetchTransport line."; }
    else if (language === "rust") { code = exampleRust(connection, settings, messages, text); note = "The Rust runtime here is lm15-rs compiled to WebAssembly building this same request; the fetch is the page's."; }
    else {
      const wire = await javascriptRuntime.wire(connection, credentials.get(connection.provider) ?? "YOUR_API_KEY", buildRequest(connection, settings, messages, text));
      if (version !== codeVersion) return;
      const safe: Wire = { ...wire, headers: wire.headers.map(([k, v]) => [k, /authorization|api-key/i.test(k) ? v.replace(/\S+$/, "YOUR_API_KEY") : v]) };
      code = language === "json" ? exampleJson(safe) : exampleCurl(safe);
      note = language === "json" ? "The request body, byte for byte, as lm15 puts it on the wire." : "The same request from a shell.";
    }
  } catch (error) {
    code = `// ${redact(error instanceof Error ? error.message : String(error))}`;
  }
  if (version !== codeVersion) return;
  $("code").textContent = code;
  $("code-note").textContent = note;
}

function refreshStatus(): void {
  $("provider-name").textContent = currentChoice().label;
  $("model-name").textContent = connection.model || "Choose model";
  $("settings-provider").textContent = currentChoice().label;
  const hasKey = credentials.get(connection.provider) !== undefined;
  $("key-state").textContent = hasKey ? (credentials.remembered(connection.provider) ? "Key ready (remembered on this device)" : "Key ready (this tab)") : keyless(connection.provider) ? "Local connection" : "Add key in Settings";
  const page = keyPage(connection.provider);
  const link = $<HTMLAnchorElement>("get-key");
  link.hidden = !page;
  if (page) link.href = page;
  $("key-field").hidden = keyless(connection.provider);
  $("custom-endpoint").hidden = connection.provider !== "custom";
  endpoint.value = connection.endpoint;
  $("loaded").textContent = credentials.providers().map((id) => `${CONNECTIONS.find((c) => c.id === id)?.label ?? id}${credentials.remembered(id) ? " (remembered)" : ""}`).join(", ") || "None";
  const catalogue = catalogues.get(cacheKey());
  $("model-status").textContent = catalogue?.status ?? (automatic.checked ? "Model IDs load when this connection is ready." : "Automatic model discovery is off.");
  $("model-status").title = catalogue?.error ?? "";
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="runtime"]')) {
    input.checked = input.value === runtime;
    const loaded = RUNTIMES[input.value as RuntimeId].loaded();
    input.parentElement!.dataset.loaded = String(loaded);
  }
  $("runtime-claim").textContent = RUNTIMES[runtime].claim;
  void updateCode();
  picker.update();
}

function reset(): void {
  generation++; active?.abort(); active = undefined; messages = [];
  $("transcript").replaceChildren(); $("usage").textContent = ""; $("fidelity").textContent = "";
  $("empty").hidden = false; send.disabled = false; stop.disabled = true;
}

// ─── Connection ───────────────────────────────────────────────────────

function credentialsChanged(): void {
  keyRevision.set(connection.provider, (keyRevision.get(connection.provider) ?? 0) + 1);
  reset(); refreshStatus();
}
function selectProvider(id: string): void {
  const choice = CONNECTIONS.find((candidate) => candidate.id === id);
  if (!choice) return;
  if (id !== connection.provider) { connection.provider = id; connection.model = choice.model; keyInput.value = ""; reset(); notify(); lastPrompt = "Hello!"; }
  refreshStatus();
  if (automatic.checked) void discover();
}
function selectModel(id: string): void {
  if (connection.model !== id) { connection.model = id; reset(); notify(); }
  refreshStatus();
}
function openSettings(): void { systemInput.focus(); systemInput.scrollIntoView({ block: "nearest" }); }

async function discover(force = false): Promise<void> {
  const selected = { ...connection };
  const cache = cacheKey();
  const existing = catalogues.get(cache);
  if (existing?.loading || (existing && !force)) return;
  const key = credentials.get(selected.provider);
  if (!key && !keyless(selected.provider)) { refreshStatus(); return; }
  const catalogue: Catalogue = { ids: [], status: "Loading model IDs…", loading: true };
  catalogues.set(cache, catalogue); refreshStatus();
  try {
    const lm = createClient(selected, key);
    if (!lm.supports.models) catalogue.status = "This provider doesn't list models here. Type an exact model ID instead.";
    else {
      const models = await lm.listModels();
      catalogue.ids = [...new Set(models.map((model) => model.id))];
      catalogue.status = `${catalogue.ids.length} model IDs listed · account access may differ`;
    }
  } catch (error) {
    catalogue.status = "Model discovery failed. You can still enter an exact model ID.";
    catalogue.error = errorMessage(error);
  } finally {
    catalogue.loading = false;
    if (cacheKey() === cache) refreshStatus();
  }
}

function options(kind: PickerKind, query: string): PickResult {
  let entries: PickOption[];
  let status: string;
  if (kind === "commands") {
    entries = [
      { id: "provider", label: "/provider", detail: "Change provider" },
      { id: "model", label: "/model", detail: "Search models or enter an ID" },
      { id: "settings", label: "/settings", detail: "Keys, system prompt, sampling" },
    ];
    status = "Commands configure the app. They are never sent to a model.";
  } else if (kind === "provider") {
    entries = CONNECTIONS.map((choice) => ({ id: choice.id, label: choice.label, detail: credentials.get(choice.id) ? "Key loaded" : choice.env ? "Add key in Settings" : "Local / custom endpoint" }));
    status = "Choose a provider · switching starts a new conversation";
  } else {
    const catalogue = catalogues.get(cacheKey());
    const listed = new Set(catalogue?.ids ?? []);
    entries = [...new Set([connection.model, ...listed, currentChoice().model])].filter(Boolean).map((id) => ({ id, label: id, detail: `${listed.has(id) ? "Listed by provider" : "Example or entered ID · unverified"}${id === connection.model ? " · current" : ""}` }));
    status = catalogue?.status ?? (credentials.get(connection.provider) ? "Type to search, or enter an exact model ID" : "Add a key in Settings to discover models, or enter an ID");
  }
  const filtered = entries.map((entry, index) => ({ entry, index, score: Math.max(fuzzyScore(query, entry.id), fuzzyScore(query, entry.label)) }))
    .filter((hit) => Number.isFinite(hit.score)).sort((a, b) => b.score - a.score || a.index - b.index);
  const shown = filtered.slice(0, 30).map((hit) => hit.entry);
  if (kind === "model" && query.trim() && !entries.some((entry) => entry.id === query.trim())) shown.push({ id: query.trim(), label: `Use exact ID: ${query.trim()}`, detail: "Custom model ID · not verified" });
  if (filtered.length > 30) status += ` · showing 30 of ${filtered.length}; type to narrow`;
  if (!shown.length) status += " · no matches";
  return { options: shown, status };
}

// ─── Runtimes ─────────────────────────────────────────────────────────

async function selectRuntime(id: RuntimeId): Promise<void> {
  runtime = id;
  refreshStatus();
  const chosen = RUNTIMES[id];
  if (!chosen.loaded()) {
    send.disabled = true;
    try {
      await chosen.load((status) => { $("runtime-status").textContent = status; });
    } catch (error) {
      $("runtime-status").textContent = `Could not load the ${chosen.label} runtime: ${redact(error instanceof Error ? error.message : String(error))}`;
      runtime = "javascript";
    } finally { send.disabled = Boolean(active); refreshStatus(); }
  }
}

/** The same request, built by every loaded runtime: identical bytes or a named difference. */
async function fidelity(request: Request): Promise<void> {
  const key = credentials.get(connection.provider);
  const wires: Array<[string, Wire]> = [];
  for (const rt of Object.values(RUNTIMES)) {
    if (!rt.loaded()) continue;
    try { wires.push([rt.label, await rt.wire(connection, key, request)]); } catch { /* an unloaded or refused runtime says nothing */ }
  }
  if (wires.length < 2) { $("fidelity").textContent = wires.length === 1 ? `Request built by ${wires[0]![0]}. Load another runtime to compare bytes.` : ""; return; }
  const norm = (w: Wire) => JSON.stringify({ m: w.method, u: w.url, h: Object.fromEntries(w.headers.map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => k !== "user-agent" && k !== "anthropic-dangerous-direct-browser-access")), b: tryJson(w.body) });
  const first = norm(wires[0]![1]);
  const differing = wires.filter(([, w]) => norm(w) !== first).map(([name]) => name);
  $("fidelity").textContent = differing.length === 0
    ? `Same request bytes from ${wires.map(([n]) => n).join(", ")} ✓ — three SDKs, one wire.`
    : `Request bytes differ in ${differing.join(", ")} — that is a bug in lm15; the JSON tab shows JavaScript's.`;
}
function tryJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }

// ─── Chat ─────────────────────────────────────────────────────────────

function turn(who: string, text: string): HTMLElement {
  $("empty").hidden = true;
  const article = document.createElement("article");
  const label = document.createElement("b"); label.textContent = who;
  const body = document.createElement("p"); body.textContent = text;
  article.append(label, body); $("transcript").append(article);
  return body;
}

async function sendTurn(text: string): Promise<void> {
  if (active) return;
  if (!maxTokensInput.reportValidity()) { openSettings(); maxTokensInput.focus(); return; }
  if (!connection.model.trim()) { notify("Choose a model first."); return; }
  const version = generation;
  const controller = new AbortController();
  active = controller; send.disabled = true; stop.disabled = false; notify();
  lastPrompt = text;
  const request = buildRequest(connection, settings, messages, text);
  const chosen = RUNTIMES[runtime];
  const body = (turn("You", text), turn(`${currentChoice().label} · ${chosen.label}`, ""));
  body.parentElement!.classList.add("streaming");
  prompt.value = "";
  const started = performance.now();
  try {
    const response = await chosen.stream(connection, credentials.get(connection.provider), request, controller.signal, (piece) => { if (version === generation) body.textContent += piece; });
    if (version !== generation) return;
    messages = [...request.messages, response.message];
    const usage = response.usage;
    $("usage").textContent = `${response.finishReason} · input ${usage?.inputTokens ?? "unreported"} · output ${usage?.outputTokens ?? "unreported"} · ${Math.round(performance.now() - started)} ms · ${chosen.label}`;
    void fidelity(request);
  } catch (error) {
    if (version !== generation) return;
    notify(controller.signal.aborted ? "Stopped. This incomplete turn is not included in the next request." : errorMessage(error));
    body.parentElement?.setAttribute("data-incomplete", "true");
  } finally {
    body.parentElement?.classList.remove("streaming");
    if (version === generation) { active = undefined; send.disabled = false; stop.disabled = true; void updateCode(); }
  }
}

// ─── Wiring ───────────────────────────────────────────────────────────

$("provider-button").addEventListener("click", () => picker.open("provider"));
$("model-button").addEventListener("click", () => { picker.open("model"); if (automatic.checked) void discover(); });
$("settings-button").addEventListener("click", openSettings);
$("credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = keyInput.value.trim(); keyInput.value = "";
  if (!key) return;
  void credentials.set(connection.provider, key, remember.checked).then(() => { credentialsChanged(); notify(); if (automatic.checked) void discover(); });
});
$("forget-key").addEventListener("click", () => { void credentials.forget(connection.provider).then(() => { keyInput.value = ""; credentialsChanged(); }); });
$("forget").addEventListener("click", () => {
  for (const id of credentials.providers()) keyRevision.set(id, (keyRevision.get(id) ?? 0) + 1);
  void credentials.forgetAll().then(() => { keyInput.value = ""; catalogues.clear(); reset(); notify(); refreshStatus(); });
});
endpoint.addEventListener("change", () => {
  if (connection.endpoint === endpoint.value.trim()) return;
  connection.endpoint = endpoint.value.trim();
  void credentials.forget("custom").then(() => { keyInput.value = ""; credentialsChanged(); });
});
automatic.addEventListener("change", () => { refreshStatus(); if (automatic.checked) void discover(); });
$("list").addEventListener("click", () => void discover(true));
systemInput.addEventListener("input", () => { settings.system = systemInput.value; void updateCode(); });
temperatureInput.addEventListener("input", () => { settings.temperature = Number(temperatureInput.value); temperatureReset.disabled = false; $("temperature-value").textContent = String(settings.temperature); void updateCode(); });
temperatureReset.addEventListener("click", () => { settings.temperature = null; temperatureInput.value = "1"; temperatureReset.disabled = true; $("temperature-value").textContent = "provider default"; void updateCode(); });
maxTokensInput.addEventListener("input", () => { if (maxTokensInput.validity.valid) settings.maxTokens = maxTokensInput.valueAsNumber; void updateCode(); });
reasoningInput.addEventListener("change", () => { settings.reasoning = reasoningInput.value as Settings["reasoning"]; void updateCode(); });
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="runtime"]')) input.addEventListener("change", () => void selectRuntime(input.value as RuntimeId));
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-language]")) tab.addEventListener("click", () => { language = tab.dataset.language as Language; void updateCode(); });
$("clear").addEventListener("click", () => { reset(); notify(); refreshStatus(); prompt.focus(); });
$("copy-code").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("code").textContent ?? ""); $("copy-status").textContent = "Copied"; }
  catch { $("copy-status").textContent = "Clipboard unavailable; select the code to copy it."; }
});
prompt.addEventListener("input", () => { void updateCode(); if (slashCommand(prompt.value)?.kind === "model" && automatic.checked) void discover(); });
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.defaultPrevented) { event.preventDefault(); $<HTMLFormElement>("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (picker.consume()) { void updateCode(); return; }
  const text = prompt.value.trim();
  if (text) void sendTurn(text);
});
stop.addEventListener("click", () => active?.abort());

// ─── Boot ─────────────────────────────────────────────────────────────

for (const { id, label } of LANGUAGES) {
  const tab = document.createElement("button"); tab.type = "button"; tab.dataset.language = id; tab.textContent = label; tab.setAttribute("aria-pressed", "false");
  tab.addEventListener("click", () => { language = id; void updateCode(); });
  $("code-tabs").append(tab);
}
$("remember-note").hidden = Credentials.available();
void credentials.load().then(() => { refreshStatus(); if (automatic.checked) void discover(); });
refreshStatus();

// Explicit, one-use local test handoff (npm run example:local). Keys never enter the code panel or persistent storage.
const token = new URLSearchParams(location.hash.slice(1)).get("local-test");
if (token) {
  history.replaceState(null, "", location.pathname + location.search);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) notify("Local test credentials can only be loaded from localhost.");
  else void (async () => {
    try {
      const response = await fetch("/__lm15_test_credentials", { headers: { "X-LM15-Test-Token": token }, cache: "no-store" });
      if (!response.ok) throw new Error("Local test session expired. Restart the local demo to load keys.");
      const data = await response.json() as Record<string, string>;
      for (const choice of CONNECTIONS) { const key = data[choice.id]; if (typeof key === "string" && key) await credentials.set(choice.id, key, false); }
      refreshStatus(); if (automatic.checked) void discover();
    } catch (error) { notify(errorMessage(error)); }
  })();
}

