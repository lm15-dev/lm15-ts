/** A provider-neutral, browser-only client. Credentials and conversations stay in memory. */
import { Message, OpenAIChatLM, ResponseStream, adapterFor, access, type ProviderLM, type Request } from "lm15/browser";
import { CONNECTIONS } from "./connections.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const provider = $<HTMLSelectElement>("provider");
const model = $<HTMLInputElement>("model");
const endpoint = $<HTMLInputElement>("endpoint");
const keyInput = $<HTMLInputElement>("key");
const status = $("status");
const alert = $("alert");
const send = $<HTMLButtonElement>("send");
const stop = $<HTMLButtonElement>("stop");
const prompt = $<HTMLTextAreaElement>("prompt");
const transcript = $("transcript");
const keys = new Map<string, string>();
let messages: Message[] = [];
let generation = 0;
let active: AbortController | undefined;

function notify(text = "") { alert.textContent = text; alert.hidden = !text; }
function reset() {
  generation++;
  active?.abort();
  active = undefined;
  messages = [];
  transcript.replaceChildren();
  $("usage").textContent = "";
  send.disabled = false;
  stop.disabled = true;
}
function refreshStatus() {
  const hasKey = keys.has(provider.value);
  status.textContent = hasKey ? "Key loaded for this provider (memory only). No request sent yet." : "Enter your own key, or use a keyless local endpoint.";
  $("loaded").textContent = [...keys.keys()].map((id) => CONNECTIONS.find((c) => c.id === id)?.label ?? id).join(", ") || "None";
}
function select() {
  reset(); notify(); keyInput.value = "";
  const choice = CONNECTIONS.find((c) => c.id === provider.value)!;
  model.value = choice.model;
  endpoint.value = provider.value === "custom" ? "http://localhost:1234/v1" : "";
  endpoint.disabled = provider.value !== "custom";
  $("models").replaceChildren();
  refreshStatus();
}
function client(): ProviderLM {
  const id = provider.value;
  const key = keys.get(id);
  if (!key && !["ollama", "custom"].includes(id)) throw new Error("Enter an API key for this provider first.");
  if (id === "custom") {
    const url = new URL(endpoint.value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) API root without credentials, query parameters, or fragments.");
    }
    return new OpenAIChatLM({ apiKey: key ?? "unused", baseUrl: url.href.replace(/\/$/, "") });
  }
  return adapterFor(id, {
    apiKey: key ?? "unused",
    // Anthropic requires an explicit opt-in header for a browser-owned credential.
    ...(id === "anthropic" ? { access: access.withHeaders(access.ANTHROPIC_API, { "anthropic-dangerous-direct-browser-access": "true" }) } : {}),
  });
}
function errorMessage(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const key of keys.values()) text = text.split(key).join("[redacted]");
  return text + "\nIf the browser blocks the connection, this may be a network or CORS restriction. This demo does not proxy requests or bypass browser protections.";
}
function turn(who: string, text: string) {
  const article = document.createElement("article");
  const label = document.createElement("b"); label.textContent = who;
  const body = document.createElement("p"); body.textContent = text;
  article.append(label, body); transcript.append(article);
  return body;
}

for (const choice of CONNECTIONS) provider.add(new Option(choice.label, choice.id));
provider.addEventListener("change", select);
model.addEventListener("change", reset);
endpoint.addEventListener("change", () => {
  // An old custom-server key must never silently follow a new address.
  keys.delete("custom"); keyInput.value = ""; reset(); refreshStatus();
});
$("credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = keyInput.value.trim(); keyInput.value = "";
  if (!key) return;
  keys.set(provider.value, key); reset(); notify(); refreshStatus();
});
$("forget").addEventListener("click", () => { reset(); keys.clear(); keyInput.value = ""; notify(); refreshStatus(); });
$("clear").addEventListener("click", reset);
$("list").addEventListener("click", async () => {
  const version = generation;
  try {
    const lm = client();
    if (!lm.supports.models) throw new Error("This connection does not support model listing. Enter the model ID directly.");
    notify("Loading model IDs; this does not validate your key or model access.");
    const models = await lm.listModels();
    if (version !== generation) return;
    $("models").replaceChildren(...models.map((m) => new Option(m.id, m.id)));
    notify(`${models.length} model IDs listed. Availability and charges depend on your account.`);
  } catch (error) { if (version === generation) notify(errorMessage(error)); }
});
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (active) return;
  const text = prompt.value.trim();
  if (!text || !model.value.trim()) { notify("Enter a model ID and a message."); return; }
  const version = generation;
  const controller = new AbortController();
  active = controller; send.disabled = true; stop.disabled = false; notify();
  let body: HTMLElement | undefined;
  try {
    const lm = client();
    const request: Request = { model: model.value.trim(), messages: [...messages, Message.user(text)], config: { maxTokens: 400 } };
    const stream = new ResponseStream(lm.stream(request, { signal: controller.signal }), request);
    turn("You", text); body = turn("Model", ""); prompt.value = "";
    for await (const piece of stream) {
      if (version !== generation) break;
      body.textContent += piece;
    }
    if (version !== generation) return;
    const response = await stream.response();
    messages = [...request.messages, response.message];
    $("usage").textContent = `${response.finishReason} · input ${response.usage?.inputTokens ?? "unreported"} · output ${response.usage?.outputTokens ?? "unreported"}`;
  } catch (error) {
    if (version === generation) {
      if (controller.signal.aborted) notify("Stopped. This incomplete turn is not included in the next request.");
      else notify(errorMessage(error));
      if (body) body.parentElement?.setAttribute("data-incomplete", "true");
    }
  } finally {
    if (version === generation) { active = undefined; send.disabled = false; stop.disabled = true; }
  }
});
stop.addEventListener("click", () => active?.abort());
select();

// Opt-in development session: a fragment capability authorizes one loopback-only
// credential fetch. No keys in the document, URLs, logs, or persistent storage.
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get("local-test");
if (token) {
  history.replaceState(null, "", location.pathname + location.search);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
    notify("Local test credentials can only be loaded from localhost.");
  } else {
    void (async () => {
      try {
        const response = await fetch("/__lm15_test_credentials", { headers: { "X-LM15-Test-Token": token }, cache: "no-store" });
        if (!response.ok) throw new Error("Local test session expired or is not authorized. Restart the local demo.");
        const data = await response.json() as Record<string, string>;
        for (const choice of CONNECTIONS) {
          const key = data[choice.id];
          if (typeof key === "string" && key) keys.set(choice.id, key);
        }
        refreshStatus();
        notify(`${keys.size} provider keys loaded from the private local test session. Nothing has been sent to a provider. Reloading clears the keys.`);
      } catch (error) { notify(errorMessage(error)); }
    })();
  }
}
