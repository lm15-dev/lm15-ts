/**
 * The page. Wires the three modules to the DOM and nothing more: state is
 * the key store and one `Chat`; every network byte goes through lm15.
 * Rendering is text nodes only — a model's reply is never HTML here.
 */

import { Chat, describeError, isCancellation } from "./chat.ts";
import { KeyStore } from "./keys.ts";
import { LoginError, beginLogin, completeLogin, keyInfo, manageUrl, pendingCode } from "./login.ts";

const TITLE = "lm15 browser example";
const DEFAULT_MODEL = "openai/gpt-4.1-mini";
const MAX_TOKENS = 400;
const REMEMBER_CHOICE = "lm15-example.remember-choice"; // parked for the return leg of a sign-in; the page reloads in between

const $ = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

const ui = {
  status: $<HTMLElement>("#status"),
  alert: $<HTMLElement>("#alert"),
  signedOut: $<HTMLElement>("#signed-out"),
  signedIn: $<HTMLElement>("#signed-in"),
  login: $<HTMLButtonElement>("#login"),
  pasteForm: $<HTMLFormElement>("#paste"),
  pasteKey: $<HTMLInputElement>("#paste-key"),
  remember: $<HTMLInputElement>("#remember"),
  manage: $<HTMLAnchorElement>("#manage"),
  forget: $<HTMLButtonElement>("#forget"),
  model: $<HTMLInputElement>("#model"),
  models: $<HTMLDataListElement>("#models"),
  modelCount: $<HTMLElement>("#model-count"),
  transcript: $<HTMLOListElement>("#transcript"),
  form: $<HTMLFormElement>("#composer"),
  prompt: $<HTMLTextAreaElement>("#prompt"),
  send: $<HTMLButtonElement>("#send"),
  stop: $<HTMLButtonElement>("#stop"),
  meta: $<HTMLElement>("#meta"),
  preview: $<HTMLPreElement>("#preview"),
  previewToggle: $<HTMLDetailsElement>("#preview-toggle"),
};

const keys = new KeyStore();
let chat: Chat | undefined;
let inFlight: AbortController | undefined;

function say(text: string): void {
  ui.alert.textContent = text;
  ui.alert.hidden = text === "";
}

function setStatus(text: string): void {
  ui.status.textContent = text;
}

async function signIn(key: string, remember: boolean): Promise<void> {
  // Verify first: OpenRouter lists models to anyone, so only its key endpoint says whether this is a key.
  setStatus("Checking the key…");
  const info = await keyInfo(key); // throws LoginError; the key is not kept
  keys.set(key, remember);
  chat = new Chat({ key, referer: location.origin, title: TITLE });
  ui.signedOut.hidden = true;
  ui.signedIn.hidden = false;
  ui.manage.href = await manageUrl(key);
  const credit = info.limitRemaining !== null ? `$${info.limitRemaining.toFixed(2)} left` : info.limit === null ? "no limit" : `$${(info.limit - info.usage).toFixed(2)} left`;
  setStatus(`Signed in as ${info.label} · ${credit}${info.isFreeTier ? " · free tier" : ""}${remember ? " · remembered on this device" : " · this tab"}`);
  say("");
  await loadModels();
  ui.prompt.focus();
}

function signOut(): void {
  inFlight?.abort();
  keys.forget();
  chat = undefined;
  ui.signedIn.hidden = true;
  ui.signedOut.hidden = false;
  ui.transcript.replaceChildren();
  ui.models.replaceChildren();
  ui.meta.textContent = "";
  setStatus("Signed out");
}

async function loadModels(): Promise<void> {
  if (!chat) return;
  ui.modelCount.textContent = "loading models…";
  try {
    const models = await chat.models();
    ui.models.replaceChildren(...models.map((m) => Object.assign(document.createElement("option"), { value: m.id })));
    ui.modelCount.textContent = `${models.length} models`;
    if (!ui.model.value) ui.model.value = models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : (models[0]?.id ?? "");
  } catch (e) {
    ui.modelCount.textContent = "model list unavailable";
    say(describeError(e));
  }
}

function turn(role: "user" | "assistant", text: string): HTMLElement {
  const li = document.createElement("li");
  li.className = role;
  const who = document.createElement("b");
  who.textContent = role === "user" ? "You" : "Model";
  const body = document.createElement("p");
  body.textContent = text;
  li.append(who, body);
  ui.transcript.append(li);
  li.scrollIntoView({ block: "end" });
  return body;
}

async function sendTurn(text: string): Promise<void> {
  if (!chat || inFlight) return;
  const model = ui.model.value.trim();
  if (!model) {
    say("Pick a model first.");
    ui.model.focus();
    return;
  }
  const request = chat.request(model, text, MAX_TOKENS);
  say("");
  try {
    const preview = await chat.preview(request);
    ui.preview.textContent = JSON.stringify(preview, null, 2);
  } catch (e) {
    say(describeError(e));
    return;
  }
  turn("user", text);
  const reply = turn("assistant", "");
  reply.parentElement!.classList.add("streaming");
  inFlight = new AbortController();
  ui.send.disabled = true;
  ui.stop.disabled = false;
  ui.meta.textContent = "";
  const started = performance.now();
  let firstAt: number | undefined;
  try {
    const rs = chat.send(request, inFlight.signal);
    for await (const piece of rs) {
      firstAt ??= performance.now();
      reply.textContent += piece;
    }
    const response = await rs.response();
    chat.commit(request, response);
    const usage = response.usage;
    const tokens = usage?.totalTokens != null ? `${usage.inputTokens ?? "?"} in, ${usage.outputTokens ?? "?"} out` : "usage not reported";
    ui.meta.textContent = `${response.model ?? model} · ${response.finishReason} · ${tokens} · first token ${Math.round((firstAt ?? performance.now()) - started)} ms · total ${Math.round(performance.now() - started)} ms`;
  } catch (e) {
    if (isCancellation(e, inFlight.signal)) {
      ui.meta.textContent = `stopped after ${Math.round(performance.now() - started)} ms · this turn is not kept`;
      reply.textContent += " ▮";
    } else {
      say(describeError(e));
      reply.parentElement!.remove();
      ui.transcript.lastElementChild?.remove();
    }
  } finally {
    reply.parentElement?.classList.remove("streaming");
    inFlight = undefined;
    ui.send.disabled = false;
    ui.stop.disabled = true;
    ui.prompt.focus();
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────

ui.login.addEventListener("click", async () => {
  try {
    sessionStorage.setItem(REMEMBER_CHOICE, ui.remember.checked ? "1" : "0");
    const url = await beginLogin(location.origin + location.pathname);
    location.assign(url);
  } catch (e) {
    say(describeError(e));
  }
});

ui.pasteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = ui.pasteKey.value.trim();
  ui.pasteKey.value = "";
  if (!key) return;
  try {
    await signIn(key, ui.remember.checked);
  } catch (e) {
    setStatus("Signed out");
    say(e instanceof LoginError ? e.message : describeError(e));
  }
});

ui.forget.addEventListener("click", signOut);

ui.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = ui.prompt.value.trim();
  if (!text) return;
  ui.prompt.value = "";
  await sendTurn(text);
});

ui.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    ui.form.requestSubmit();
  }
});

ui.stop.addEventListener("click", () => inFlight?.abort());

// ─── Boot: the return leg of a sign-in, a remembered key, or nothing ────

(async () => {
  const code = pendingCode(location.search);
  if (code) {
    history.replaceState(null, "", location.pathname); // the code is one-time; keep it out of history and reloads
    const remember = sessionStorage.getItem(REMEMBER_CHOICE) === "1";
    sessionStorage.removeItem(REMEMBER_CHOICE);
    ui.remember.checked = remember;
    try {
      setStatus("Finishing sign-in…");
      await signIn(await completeLogin(code), remember);
    } catch (e) {
      setStatus("Signed out");
      say(e instanceof LoginError ? e.message : describeError(e));
    }
    return;
  }
  const remembered = keys.load();
  if (!remembered) {
    setStatus("Signed out");
    return;
  }
  try {
    await signIn(remembered, true);
  } catch (e) {
    keys.forget(); // a remembered key OpenRouter no longer recognises is not worth keeping
    setStatus("Signed out");
    say(e instanceof LoginError ? `The remembered key was dropped: ${e.message}` : describeError(e));
  }
})();
