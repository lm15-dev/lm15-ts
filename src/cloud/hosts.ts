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
  opts: { provider?: string; profile?: (name: string) => string | undefined } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!hostSpec) return { ...(given ?? {}) };
  const remaining = { ...(given ?? {}) };
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

export function renderBaseUrl(hostSpec: HostSpec, settings: Readonly<Record<string, string>>): string {
  const values: Record<string, string> = { ...settings };
  for (const name of ["region", "resource", "location"]) {
    const v = values[name];
    if (v !== undefined && !/^[A-Za-z0-9-]+$/.test(v)) throw new NotConfiguredError(`host setting '${name}' must be a DNS label`);
  }
  if (values["project"] !== undefined) values["project"] = percentEncode(values["project"]);
  if (values["location"] !== undefined && values["location_host"] === undefined) values["location_host"] = locationHost(values["location"]);
  return hostSpec.baseUrl.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new NotConfiguredError(`host base URL needs setting '${name}'`);
    return v;
  });
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
