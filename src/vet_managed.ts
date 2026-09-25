/**
 * The vet shim's `managed_run` op (lm15-contract harness/PROTOCOL.md §
 * managed_run): one scripted program against the public managed-auth API,
 * every seam injected — the store file the harness created, a fake wall and
 * monotonic clock (waits advance them), a scripted auth server behind
 * `fetch`, a scripted UI. Reports one outcome per step, the ordered trace and
 * the store file afterwards; the harness compares.
 */

import * as fs from "node:fs";
import { explainAuth } from "./auth/doctor.ts";
import { AuthOperationError, LM15Error } from "./errors.ts";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import { FileStore } from "./login/file_store.ts";
import { LoginCancelled } from "./login/engine.ts";
import { Auth, type Connection, type ConnectionStatus } from "./login/manager.ts";
import type { AuthUI, LoginMethod, Notice, Prompt } from "./login/types.ts";
import { registerOps } from "./vet_ops.ts";

const TRANSPORT_HEADERS = new Set(["accept", "accept-encoding", "connection", "content-length", "content-type", "host"]);

function headersOf(init: RequestInit | undefined): JsonObject {
  const out: JsonObject = {};
  for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    const key = name.toLowerCase();
    if (TRANSPORT_HEADERS.has(key)) continue;
    out[key] = key === "user-agent" && value.startsWith("lm15/") ? "lm15" : value;
  }
  return out;
}

function contentTypeOf(init: RequestInit | undefined): string | null {
  for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    if (name.toLowerCase() === "content-type") return value.split(";")[0]!.trim();
  }
  return null;
}

function bodyOf(init: RequestInit | undefined, contentType: string | null): JsonValue {
  if (typeof init?.body !== "string") return null;
  if (contentType === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(init.body));
  try {
    return parseJson(init.body);
  } catch {
    return init.body;
  }
}

function connection(c: Connection | null): JsonValue {
  if (c === null) return null;
  return {
    id: c.id, provider: c.provider, instance_id: c.instanceId, kind: c.kind, method_id: c.methodId, routes: [...c.routes], label: c.label,
    created_at: c.createdAt, identity_generation: c.identityGeneration, credential_revision: c.credentialRevision, settings: { ...c.settings },
    ...(c.accountLabel !== undefined ? { account_label: c.accountLabel } : {}),
  };
}

function status(s: ConnectionStatus): JsonValue {
  return {
    provider: s.provider, presence: s.presence, usability: s.usability, connection: connection(s.connection), expires_at: s.expiresAt,
    logged_out: s.loggedOut, verification: s.verification ? { result: s.verification.result, check: s.verification.check ?? null } : null,
  };
}

function method(m: LoginMethod): JsonValue {
  return {
    id: m.id, kind: m.kind, flow: m.flow, availability: m.availability, subscription: m.subscription, delivery: [...m.delivery],
    fields: m.fields.map((f) => ({ id: f.id, type: f.type, required: f.required, options: (f.options ?? []).map((o) => o.id) })),
  };
}

function errorOf(error: unknown): JsonObject {
  if (error instanceof LoginCancelled || (error instanceof Error && error.name === "AbortError")) return { type: "cancelled" };
  if (error instanceof AuthOperationError) {
    return { type: "AuthOperationError", code: error.code, reason: error.reason, stage: error.stage, commit_state: error.commitState, recovery: error.recovery };
  }
  if (error instanceof LM15Error) return { type: error.name, code: error.code };
  return { type: error instanceof Error ? error.name : "Error" };
}

function noticeEvent(notice: Notice): JsonObject {
  if (notice.type === "auth_url") return { type: "auth_url", url: notice.url };
  if (notice.type === "device_code") return { type: "device_code", user_code: notice.userCode, verification_url: notice.verificationUrl, expires_in_s: notice.expiresInS, interval_s: notice.intervalS };
  if (notice.type === "progress") return { type: "progress", stage: notice.stage };
  return { type: "info" };
}

function promptEvent(prompt: Prompt): JsonObject {
  const out: JsonObject = { type: prompt.type, field_id: prompt.fieldId };
  if (prompt.type === "select") out["options"] = prompt.options.map((o) => o.id);
  return out;
}

async function managedRun(msg: JsonObject): Promise<JsonValue> {
  const events: JsonObject[] = [];
  const start = Number(msg["clock_ms"]);
  let elapsed = 0;
  const sentinel = String(msg["sentinel"]);
  const script = Array.isArray(msg["http"]) ? [...msg["http"]] : [];
  const answers = Array.isArray(msg["ui"]) ? [...msg["ui"]] : [];
  let lastAuthUrl = "";

  const fakeFetch: typeof fetch = async (input, init) => {
    const contentType = contentTypeOf(init);
    events.push({ http: { method: init?.method ?? "GET", url: String(input), content_type: contentType, headers: headersOf(init), body: bodyOf(init, contentType) } });
    const reply = script.shift();
    if (isJsonObject(reply) && reply["delay_ms"]) await new Promise((r) => setTimeout(r, Number(reply["delay_ms"]))); // real time: another process may race this exchange
    if (!isJsonObject(reply)) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    if (reply["network"] === "timeout") throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    if (reply["network"] === "refused") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const statusCode = Number(reply["status"] ?? 200);
    if ("json" in reply) return new Response(JSON.stringify(reply["json"]), { status: statusCode, headers: { "content-type": "application/json" } });
    return new Response(String(reply["text"] ?? ""), { status: statusCode, headers: { "content-type": String(reply["content_type"] ?? "text/plain") } });
  };

  const ui: AuthUI = {
    notify(notice) {
      if (notice.type === "auth_url") lastAuthUrl = notice.url;
      events.push({ notice: noticeEvent(notice) });
    },
    async prompt(prompt) {
      events.push({ prompt: promptEvent(prompt) });
      const answer = answers.shift();
      if (answer === undefined) throw new LoginCancelled("the script has no more answers");
      if (typeof answer === "string") return answer;
      if (!isJsonObject(answer) || answer["cancel"]) throw new LoginCancelled("the script cancels here");
      const query = lastAuthUrl ? new URL(lastAuthUrl).searchParams : new URLSearchParams();
      const state = query.get("state") ?? "";
      if ("paste" in answer) return `${String(answer["paste"])}#${state}`;
      if ("paste_wrong_state" in answer) return `${String(answer["paste_wrong_state"])}#not-the-state-of-this-attempt`;
      if ("paste_url" in answer) return `${query.get("redirect_uri") ?? ""}?${new URLSearchParams({ code: String(answer["paste_url"]), state })}`;
      throw new TypeError(`unknown scripted answer ${JSON.stringify(answer)}`);
    },
  };

  const env = isJsonObject(msg["env"]) ? Object.fromEntries(Object.entries(msg["env"]).map(([k, v]) => [k, String(v)])) : {};
  const storePath = String(msg["store_path"]);
  const auth = new Auth(new FileStore(storePath), {
    clock: () => start + elapsed,
    monotonic: () => elapsed,
    fetch: fakeFetch,
    sleep: async (ms) => {
      elapsed += ms;
      events.push({ sleep_ms: Math.round(ms) });
    },
  });

  const steps: JsonObject[] = [];
  const refer = (step: JsonObject): JsonObject => {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(step)) {
      const target = (n: JsonValue | undefined) => {
        const outcome = steps[Number(n)];
        if (!outcome?.["ok"] || !isJsonObject(outcome["value"])) throw new TypeError(`step ${String(n)} returned no connection to refer to`);
        return outcome["value"];
      };
      if (isJsonObject(value) && "id_of_step" in value) out[key] = target(value["id_of_step"])["id"]!;
      else if (isJsonObject(value) && "of_step" in value) {
        const c = target(value["of_step"]);
        out[key] = [c["id"]!, c["identity_generation"]!];
      } else out[key] = value;
    }
    return out;
  };
  const str = (v: JsonValue | undefined) => (v === undefined || v === null ? undefined : String(v));
  const map = (v: JsonValue | undefined) => (isJsonObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined);

  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const list = Array.isArray(msg["steps"]) ? msg["steps"] : [];
    for (let i = 0; i < list.length; i++) {
      events.push({ step: i });
      try {
        const step = refer(list[i] as JsonObject);
        const provider = String(step["provider"] ?? "");
        let value: JsonValue = null;
        switch (step["do"]) {
          case "advance":
            elapsed += Number(step["ms"]);
            break;
          case "login": {
            const answersIn = map(step["answers"]);
            const settings = map(step["settings"]);
            value = connection(await auth.login(provider, {
              ui, ...(str(step["method"]) !== undefined ? { method: str(step["method"])! } : {}),
              ...(answersIn ? { answers: answersIn } : {}), ...(settings ? { settings } : {}),
              ...(str(step["replace"]) !== undefined ? { replace: str(step["replace"])! } : {}),
              ...(step["allow_unverified"] ? { allowUnverified: true } : {}),
            }));
            break;
          }
          case "configure": {
            const answersIn = map(step["answers"]);
            const settings = map(step["settings"]);
            value = connection(await auth.configure(provider, {
              method: String(step["method"]), ...(answersIn ? { answers: answersIn } : {}), ...(settings ? { settings } : {}),
              ...(str(step["replace"]) !== undefined ? { replace: str(step["replace"])! } : {}),
            }));
            break;
          }
          case "set_api_key":
            value = connection(await auth.setApiKey(provider, String(step["key"]), str(step["replace"]) !== undefined ? { replace: str(step["replace"])! } : {}));
            break;
          case "status":
            value = status(await auth.status(provider));
            break;
          case "connections":
            value = (await auth.connections()).map(connection);
            break;
          case "logout": {
            const result = await auth.logout(String(step["target"]));
            value = { provider: result.provider, forgot: result.forgot, routes: [...result.routes], identity_generation: result.identityGeneration };
            break;
          }
          case "cancel_login":
            value = await auth.cancelLogin(provider);
            break;
          case "request_auth": {
            const pinned = Array.isArray(step["pinned"]) ? [String(step["pinned"][0]), String(step["pinned"][1])] as const : undefined;
            const result = await auth.requestAuth(provider, pinned ? { pinned } : {});
            value = {
              credential: result.credential ? { kind: result.credential.kind, value: result.credential.value } : null,
              headers: { ...result.headers }, base_url: result.baseUrl, account_id: result.accountId, named: result.named,
            };
            break;
          }
          case "methods":
            value = auth.methods(provider).map(method);
            break;
          case "providers":
            value = auth.providers().map((d) => d.id).sort();
            break;
          case "explain": {
            const keys = Array.isArray(step["api_keys"]) ? step["api_keys"].map(String) : [];
            const report = explainAuth(provider, { auth, env, ...(keys.length > 0 ? { apiKeys: Object.fromEntries(keys.map((k) => [k, `${sentinel}-explicit`])) } : {}) });
            value = { configured: report.configured, steps: report.steps.map((s) => ({ kind: s.kind, state: s.state })) };
            break;
          }
          default:
            throw new TypeError(`unknown managed step ${JSON.stringify(step["do"])}`);
        }
        steps.push({ ok: true, value });
      } catch (error) {
        steps.push({ ok: false, error: errorOf(error) });
      }
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  let store: JsonValue = null;
  if (fs.existsSync(storePath)) {
    const text = fs.readFileSync(storePath, "utf8");
    try {
      store = { document: parseJson(text) };
    } catch {
      store = { raw: text };
    }
  }
  return { steps, events, store };
}

registerOps({ managed_run: managedRun });
