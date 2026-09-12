/** Chat UX and its live code example, using the same connection settings. */
import { Message, ResponseStream, type Request } from "lm15/browser";
import { CONNECTIONS } from "./connections.ts";
import { createClient, example, fuzzyScore, slashCommand, type Connection, type ExampleMode, type PickerKind } from "./experience.ts";
import { Picker, type PickOption, type PickResult } from "./picker.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const prompt = $<HTMLTextAreaElement>("prompt");
const send = $<HTMLButtonElement>("send");
const stop = $<HTMLButtonElement>("stop");
const settings = $<HTMLDialogElement>("settings");
const keyInput = $<HTMLInputElement>("key");
const endpoint = $<HTMLInputElement>("endpoint");
const automatic = $<HTMLInputElement>("automatic-models");
const connection: Connection = { provider: "openai", model: "gpt-4.1-mini", endpoint: "http://localhost:1234/v1" };
const keys = new Map<string, string>();
const keyRevision = new Map<string, number>();
interface Catalogue { ids: string[]; status: string; loading: boolean; error?: string }
const catalogues = new Map<string, Catalogue>();
let messages: Message[] = [];
let generation = 0;
let active: AbortController | undefined;
let mode: ExampleMode = "stream";
let lastPrompt = "Hello!";

const picker = new Picker(options, (kind, id) => {
  if (kind === "commands") {
    if (id === "settings") openSettings();
    else if (id === "provider") showCode("connect");
    else { showCode("models"); if (automatic.checked) void discover(); }
    return;
  }
  if (kind === "provider") selectProvider(id);
  else selectModel(id);
  updateExample();
  prompt.focus();
});

function notify(text = "") { $("alert").textContent = text; $("alert").hidden = !text; }
function redact(text: string): string {
  for (const key of keys.values()) text = text.split(key).join("[redacted]");
  return text;
}
function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
    + "\nBrowser access depends on the provider. A network failure may be CORS or connectivity; requests are not proxied.";
}
function currentChoice() { return CONNECTIONS.find((choice) => choice.id === connection.provider)!; }
function cacheKey(): string { return `${connection.provider}:${connection.endpoint}:${keyRevision.get(connection.provider) ?? 0}`; }
function updateExample() {
  const draft = prompt.value.trim();
  const next = draft && !slashCommand(draft) ? draft : messages.length ? "Your next message" : lastPrompt;
  $("code").textContent = example(connection, redact(next), mode, messages);
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-example]")) tab.setAttribute("aria-pressed", String(tab.dataset.example === mode));
  $("code-purpose").textContent = {
    connect: "The provider chip chooses this client. Credentials are always placeholders here.",
    models: "The model picker calls listModels(). Listing is not proof of account access.",
    request: "Exactly what Send builds: the whole conversation so far, then your next message. Inspects it without inference.",
    stream: "Exactly what Send does: replay every earlier turn, stream the reply, keep it for the next turn. Stop aborts.",
  }[mode];
}
function showCode(next: ExampleMode) { mode = next; updateExample(); }
function refreshStatus() {
  $("provider-name").textContent = currentChoice().label;
  $("settings-provider").textContent = currentChoice().label;
  $("model-name").textContent = connection.model || "Choose model";
  const hasKey = keys.has(connection.provider);
  $("key-state").textContent = hasKey ? "Key ready" : ["ollama", "custom"].includes(connection.provider) ? "Local connection" : "Add key in Settings";
  $("key-state").dataset.ready = String(hasKey);
  $("loaded").textContent = [...keys.keys()].map((id) => CONNECTIONS.find((choice) => choice.id === id)?.label ?? id).join(", ") || "None";
  $("custom-endpoint").hidden = connection.provider !== "custom";
  endpoint.value = connection.endpoint;
  const catalogue = catalogues.get(cacheKey());
  $("model-status").textContent = catalogue?.status ?? (automatic.checked ? "Model IDs load when this connection is ready." : "Automatic model discovery is off.");
  $("model-status").title = catalogue?.error ?? "";
  updateExample(); picker.update();
}
function reset() {
  generation++; active?.abort(); active = undefined; messages = [];
  $("transcript").replaceChildren(); $("usage").textContent = "";
  $("empty").hidden = false; send.disabled = false; stop.disabled = true;
}
function credentialsChanged() {
  keyRevision.set(connection.provider, (keyRevision.get(connection.provider) ?? 0) + 1);
  reset(); refreshStatus();
}
function selectProvider(id: string) {
  const choice = CONNECTIONS.find((candidate) => candidate.id === id);
  if (!choice) return;
  if (id !== connection.provider) {
    connection.provider = id; connection.model = choice.model; keyInput.value = "";
    reset(); notify(); lastPrompt = "Hello!";
  }
  showCode("connect"); refreshStatus();
  if (automatic.checked) void discover();
}
function selectModel(id: string) {
  if (connection.model !== id) { connection.model = id; reset(); notify(); }
  showCode("request"); refreshStatus();
}
function openSettings() { refreshStatus(); settings.showModal(); keyInput.focus(); }

/** Fetch only after an explicit connection choice or local credential opt-in; cache per connection. */
async function discover(force = false) {
  const selected = { ...connection };
  const cache = cacheKey();
  const existing = catalogues.get(cache);
  if (existing?.loading || (existing && !force)) return;
  const key = keys.get(selected.provider);
  if (!key && !["ollama", "custom"].includes(selected.provider)) { refreshStatus(); return; }
  const catalogue: Catalogue = { ids: [], status: "Loading model IDs…", loading: true };
  catalogues.set(cache, catalogue); refreshStatus();
  try {
    const lm = createClient(selected, key);
    if (!lm.supports.models) {
      catalogue.status = "This provider doesn't list models here. Type an exact model ID instead.";
    } else {
      const models = await lm.listModels();
      catalogue.ids = [...new Set(models.map((model) => model.id))];
      catalogue.status = `${catalogue.ids.length} model IDs listed · account access may differ`;
    }
  } catch (error) {
    catalogue.status = "Model discovery failed. You can still enter an exact model ID.";
    // A background discovery failure must not erase a draft or block chat.
    catalogue.error = errorMessage(error);
  } finally {
    catalogue.loading = false;
    if (cacheKey() === cache) refreshStatus(); // a stale provider's response never updates the active picker
  }
}

function options(kind: PickerKind, query: string): PickResult {
  let entries: PickOption[];
  let status: string;
  if (kind === "commands") {
    entries = [
      { id: "provider", label: "/provider", detail: "Change provider" },
      { id: "model", label: "/model", detail: "Search models or enter an ID" },
      { id: "settings", label: "/settings", detail: "Keys and connection options" },
    ];
    status = "Commands configure the app. They are never sent to a model.";
  } else if (kind === "provider") {
    entries = CONNECTIONS.map((choice) => ({ id: choice.id, label: choice.label, detail: keys.has(choice.id) ? "Key loaded" : choice.env ? "Add key in Settings" : "Local / custom endpoint" }));
    status = "Choose a provider · switching starts a new conversation";
  } else {
    const catalogue = catalogues.get(cacheKey());
    const listed = new Set(catalogue?.ids ?? []);
    entries = [...new Set([connection.model, ...listed, currentChoice().model])].filter(Boolean).map((id) => ({ id, label: id, detail: `${listed.has(id) ? "Listed by provider" : "Example or entered ID · unverified"}${id === connection.model ? " · current" : ""}` }));
    status = catalogue?.status ?? (keys.has(connection.provider) ? "Type to search, or enter an exact model ID" : "Add a key in Settings to discover models, or enter an ID");
  }
  const filtered = entries.map((entry, index) => ({ entry, index, score: Math.max(fuzzyScore(query, entry.id), fuzzyScore(query, entry.label)) }))
    .filter((hit) => Number.isFinite(hit.score)).sort((a, b) => b.score - a.score || a.index - b.index);
  const shown = filtered.slice(0, 30).map((hit) => hit.entry);
  if (kind === "model" && query.trim() && !entries.some((entry) => entry.id === query.trim())) {
    shown.push({ id: query.trim(), label: `Use exact ID: ${query.trim()}`, detail: "Custom model ID · not verified" });
  }
  if (filtered.length > 30) status += ` · showing 30 of ${filtered.length}; type to narrow`;
  if (!shown.length) status += " · no matches";
  return { options: shown, status };
}

$("provider-button").addEventListener("click", () => { showCode("connect"); picker.open("provider"); });
$("model-button").addEventListener("click", () => { showCode("models"); picker.open("model"); if (automatic.checked) void discover(); });
$("settings-button").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => settings.close());
$("credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = keyInput.value.trim(); keyInput.value = "";
  if (!key) return;
  keys.set(connection.provider, key); credentialsChanged(); notify(); settings.close();
  if (automatic.checked) void discover();
});
endpoint.addEventListener("change", () => {
  if (connection.endpoint === endpoint.value.trim()) return;
  connection.endpoint = endpoint.value.trim(); keys.delete("custom"); keyInput.value = "";
  credentialsChanged(); if (automatic.checked) void discover();
});
automatic.addEventListener("change", () => { refreshStatus(); if (automatic.checked) void discover(); });
$("list").addEventListener("click", () => { showCode("models"); void discover(true); });
$("forget").addEventListener("click", () => {
  for (const id of keys.keys()) keyRevision.set(id, (keyRevision.get(id) ?? 0) + 1);
  keys.clear(); keyInput.value = ""; catalogues.clear(); reset(); notify(); refreshStatus();
});
$("clear").addEventListener("click", () => { reset(); notify(); prompt.focus(); });
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-example]")) tab.addEventListener("click", () => showCode(tab.dataset.example as ExampleMode));
prompt.addEventListener("input", () => {
  updateExample();
  if (slashCommand(prompt.value)?.kind === "model" && automatic.checked) void discover();
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.defaultPrevented) {
    event.preventDefault(); $<HTMLFormElement>("composer").requestSubmit();
  }
});
$("copy-code").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("code").textContent ?? ""); $("copy-status").textContent = "Copied"; }
  catch { $("copy-status").textContent = "Clipboard unavailable; select the code to copy it."; }
});

function turn(who: string, text: string) {
  $("empty").hidden = true;
  const article = document.createElement("article");
  const label = document.createElement("b"); label.textContent = who;
  const body = document.createElement("p"); body.textContent = text;
  article.append(label, body); $("transcript").append(article);
  return body;
}
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (picker.consume()) { updateExample(); return; }
  if (active) return;
  const text = prompt.value.trim();
  if (!text || !connection.model.trim()) { notify("Choose a model and enter a message."); return; }
  const version = generation;
  const controller = new AbortController();
  active = controller; send.disabled = true; stop.disabled = false; notify();
  lastPrompt = text; showCode("stream");
  let body: HTMLElement | undefined;
  try {
    const lm = createClient({ ...connection }, keys.get(connection.provider));
    const request: Request = { model: connection.model.trim(), messages: [...messages, Message.user(text)], config: { maxTokens: 400 } };
    const stream = new ResponseStream(lm.stream(request, { signal: controller.signal }), request);
    turn("You", text); body = turn(currentChoice().label, ""); prompt.value = "";
    for await (const piece of stream) {
      if (version !== generation) break;
      body.textContent += piece;
    }
    if (version !== generation) return;
    const response = await stream.response(); messages = [...request.messages, response.message];
    $("usage").textContent = `${response.finishReason} · input ${response.usage?.inputTokens ?? "unreported"} · output ${response.usage?.outputTokens ?? "unreported"}`;
    updateExample(); // the code now replays this turn too
  } catch (error) {
    if (version === generation) {
      notify(controller.signal.aborted ? "Stopped. This incomplete turn is not included in the next request." : errorMessage(error));
      if (body) body.parentElement?.setAttribute("data-incomplete", "true");
    }
  } finally { if (version === generation) { active = undefined; send.disabled = false; stop.disabled = true; } }
});
stop.addEventListener("click", () => { showCode("stream"); active?.abort(); });
refreshStatus();

// Explicit, one-use local test handoff. Keys never enter code examples or persistent storage.
const token = new URLSearchParams(location.hash.slice(1)).get("local-test");
if (token) {
  history.replaceState(null, "", location.pathname + location.search);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) notify("Local test credentials can only be loaded from localhost.");
  else void (async () => {
    try {
      const response = await fetch("/__lm15_test_credentials", { headers: { "X-LM15-Test-Token": token }, cache: "no-store" });
      if (!response.ok) throw new Error("Local test session expired. Restart the local demo to load keys.");
      const data = await response.json() as Record<string, string>;
      for (const choice of CONNECTIONS) { const key = data[choice.id]; if (typeof key === "string" && key) keys.set(choice.id, key); }
      refreshStatus(); if (automatic.checked) void discover();
    } catch (error) { notify(errorMessage(error)); }
  })();
}
