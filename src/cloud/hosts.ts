/**
 * A dialect reaches a cloud door through a host (spec/auth.md AUTH-10).
 * Three pure functions: `resolveSettings`, `renderBaseUrl`, `finishRequest`
 * (rewrites before serialization), then `signRequest` (SigV4 after, through
 * the host platform's signer: `node:crypto` on Node, none on the web).
 */

import { NotConfiguredError, UnsupportedFeatureError } from "../errors.ts";
import type { JsonObject } from "../json.ts";
import { ApiKey, AwsCredentials, type CredentialValue } from "../types/credential.ts";
import { ValueError } from "../types/validate.ts";
import { selectScheme, type AccessPolicy, type HostSpec } from "../auth/policy.ts";
import { percentEncode } from "../wire.ts";
import { getDefaultPlatform, noSigV4 } from "../platform.ts";

export type Clock = () => Date;

export function utcNow(): Date {
  return new Date();
}

/** Explicit values, then `env` (when given), then the cloud profile, then defaults. Required settings raise. */
export function resolveSettings(
  hostSpec: HostSpec | undefined,
  given: Readonly<Record<string, string>> | undefined,
  env?: Readonly<Record<string, string>>,
  opts: { provider?: string; profile?: (name: string) => string | undefined; endpoint?: string | undefined } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!hostSpec) return { ...(given ?? {}) };
  const remaining = { ...(given ?? {}) };
  const relaxed = opts.endpoint !== undefined ? urlOnlySettings(hostSpec) : new Set<string>();
  if (opts.endpoint !== undefined) joinEndpoint(opts.endpoint, "", opts.provider);
  for (const setting of hostSpec.settings) {
    let value: string | undefined = remaining[setting.name];
    delete remaining[setting.name];
    if (!value && env) {
      for (const v of setting.env) {
        const candidate = env[v];
        if (candidate) {
          value = candidate;
          break;
        }
      }
    }
    if (!value && opts.profile) value = opts.profile(setting.name);
    if (!value) value = setting.default;
    if (!value) {
      if (relaxed.has(setting.name)) continue;
      const hint = setting.env.length > 0 ? `set ${setting.env.join(" or ")}` : `pass settings={'${setting.name}': ...}`;
      throw new NotConfiguredError(`${opts.provider ?? "host"}: setting '${setting.name}' is required and has no default; ${hint}`, {
        provider: opts.provider ?? null,
        credentialHint: hint,
      });
    }
    out[setting.name] = value;
  }
  const unknown = Object.keys(remaining).sort();
  if (unknown.length > 0) {
    throw new ValueError(`${opts.provider ?? "host"}: unknown host setting(s) ${JSON.stringify(unknown)}; known: ${JSON.stringify(hostSpec.settings.map((s) => s.name))}`);
  }
  return out;
}

/** Vertex host for a location. */
export function locationHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

/** The root and door path stay separate so an endpoint never replaces the dialect. */
export function hostTemplates(hostSpec: HostSpec): { root: string; path: string } {
  const at = hostSpec.baseUrl.indexOf("/", hostSpec.baseUrl.indexOf("://") + 3);
  return at < 0 ? { root: hostSpec.baseUrl, path: "" } : { root: hostSpec.baseUrl.slice(0, at), path: hostSpec.baseUrl.slice(at) };
}

export function urlOnlySettings(hostSpec: HostSpec): Set<string> {
  const templates = hostTemplates(hostSpec);
  const fields = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const root = new Set(fields(templates.root));
  if (root.delete("location_host")) root.add("location");
  for (const name of fields(templates.path)) root.delete(name);
  for (const [, name] of hostSpec.requiredHeaders) root.delete(name);
  if (hostSpec.sigv4Service) root.delete("region");
  return root;
}

export function endpointFromEnv(hostSpec: HostSpec | undefined, env: Readonly<Record<string, string | undefined>> | undefined): string | undefined {
  for (const key of hostSpec?.endpointEnv ?? []) {
    const value = env?.[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Join a trusted endpoint with the door, merging an already-present leading door path. */
export function joinEndpoint(endpoint: string, path: string, provider = "host"): string {
  let parsed: URL;
  try {
    if (typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint.trim()) || /[\\\r\n\t]/.test(endpoint)) throw new Error();
    parsed = new URL(endpoint.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    throw new NotConfiguredError(`${provider}: endpoint must be an http(s) URL with a host`, { provider });
  }
  if (parsed.username || parsed.password || /[?#]/.test(endpoint) || endpoint.slice(endpoint.indexOf("://") + 3).split("/")[0]!.includes("@")) {
    throw new NotConfiguredError(`${provider}: endpoint must not carry a query, fragment or userinfo`, { provider });
  }
  const given = parsed.pathname.split("/").filter(Boolean);
  const door = path.split("/").filter(Boolean);
  let base = given;
  for (let k = Math.min(given.length, door.length); k > 0; k--) {
    if (given.slice(-k).every((s, i) => s === door[i])) { base = given.slice(0, -k); break; }
  }
  const joined = [...base, ...door].join("/");
  return parsed.origin + (joined ? `/${joined}` : "");
}

export function renderBaseUrl(hostSpec: HostSpec, settings: Readonly<Record<string, string>>, endpoint?: string, provider = "host"): string {
  const values: Record<string, string> = { ...settings };
  for (const name of ["region", "resource", "location"]) {
    const v = values[name];
    if (v !== undefined && !/^[A-Za-z0-9-]+$/.test(v)) throw new NotConfiguredError(`host setting '${name}' must be a DNS label`);
  }
  if (values["project"] !== undefined) values["project"] = percentEncode(values["project"]);
  if (values["location"] !== undefined && values["location_host"] === undefined) values["location_host"] = locationHost(values["location"]);
  const template = endpoint === undefined ? hostSpec.baseUrl : hostTemplates(hostSpec).path;
  const rendered = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new NotConfiguredError(`host base URL needs setting '${name}'`);
    return v;
  });
  return endpoint === undefined ? rendered : joinEndpoint(endpoint, rendered, provider);
}

export interface FinishedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload: unknown;
  readonly params: Record<string, string>;
}

export interface FinishOptions {
  readonly baseUrl: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly params?: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined;
  readonly endpoint?: string | undefined;
  readonly stream: boolean;
  readonly model?: string | undefined;
  readonly credential?: CredentialValue | undefined;
}

/** The host's closed set of rewrites before serialization. */
export function finishRequest(policy: AccessPolicy, settings: Readonly<Record<string, string>>, opts: FinishOptions): FinishedRequest {
  const hostSpec = policy.host;
  const outHeaders: Record<string, string> = { ...opts.headers };
  const outParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined && v !== null) outParams[k] = String(v);
  let url = opts.url;
  let payload = opts.payload;
  if (!hostSpec) return { url, headers: outHeaders, payload, params: outParams };

  if (hostSpec.streamFraming !== "sse" && opts.stream) {
    throw new UnsupportedFeatureError(`${policy.provider}: ${hostSpec.streamFraming} stream framing is not implemented yet (phase 2)`, {
      provider: policy.provider,
    });
  }

  const endpoint = opts.endpoint;
  const key = endpoint && opts.stream && `${endpoint}/stream` in hostSpec.paths ? `${endpoint}/stream` : endpoint;
  if (key !== undefined && key in hostSpec.paths) {
    const template = hostSpec.paths[key]!;
    if (template.includes("{model}") && !opts.model) throw new ValueError(`${policy.provider}: endpoint '${endpoint}' needs the model in the path`);
    let pathModel = opts.model ?? "";
    if (endpoint === "generateContent" && pathModel.startsWith("models/")) pathModel = pathModel.slice("models/".length);
    url = opts.baseUrl.replace(/\/+$/, "") + template.replace("{model}", percentEncode(pathModel, ":@"));
  }

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const p: JsonObject = { ...(payload as JsonObject) };
    if (hostSpec.modelIn === "path") delete p["model"];
    if (hostSpec.anthropicVersionIn.startsWith("body:")) {
      p["anthropic_version"] = hostSpec.anthropicVersionIn.slice("body:".length);
      for (const k of Object.keys(outHeaders)) if (k.toLowerCase() === "anthropic-version") delete outHeaders[k];
    }
    payload = p;
  }

  for (const [name, setting] of hostSpec.requiredHeaders) {
    const value = settings[setting];
    if (!value) throw new NotConfiguredError(`${policy.provider}: header ${name} needs setting '${setting}'`, { provider: policy.provider });
    outHeaders[name] = value;
  }

  if (opts.credential instanceof ApiKey && policy.authScheme.includes("query-key") && selectScheme(policy, opts.credential) === "query-key") {
    outParams["key"] = opts.credential.value;
  }
  return { url, headers: outHeaders, payload, params: outParams };
}

/** The headers to send: `sigv4` replaces them with the signed set; other schemes were applied already. */
export async function signRequest(
  policy: AccessPolicy,
  settings: Readonly<Record<string, string>>,
  opts: { method: string; url: string; headers: ReadonlyArray<readonly [string, string]>; body: Uint8Array; credential?: CredentialValue | undefined; now: Date },
): Promise<ReadonlyArray<readonly [string, string]>> {
  if (!(opts.credential instanceof AwsCredentials)) return opts.headers;
  const hostSpec = policy.host;
  if (!hostSpec?.sigv4Service) throw new NotConfiguredError(`${policy.provider}: AWS credentials need a sigv4 host`, { provider: policy.provider });
  const region = settings["region"];
  if (!region) throw new NotConfiguredError(`${policy.provider}: sigv4 needs the region setting`, { provider: policy.provider });
  const platform = getDefaultPlatform();
  if (!platform.signSigV4) throw noSigV4(platform, policy);
  const headers: Record<string, string> = {};
  for (const [k, v] of opts.headers) if (!["authorization", "x-api-key"].includes(k.toLowerCase())) headers[k] = v;
  const signed = await platform.signSigV4({
    method: opts.method,
    url: opts.url,
    headers,
    payload: opts.body,
    credentials: opts.credential,
    region,
    service: hostSpec.sigv4Service,
    now: opts.now,
  });
  return Object.entries(signed);
}
