/**
 * The Node host: the process environment, the filesystem, the CLI login
 * stores (AUTH-8), the three cloud chains (AUTH-11) and SigV4 over
 * `node:crypto`. The one module that binds the core to `node:*` — installed
 * by the Node entry point, never loaded by the web one.
 */

import { readFileSync } from "node:fs";
import { expandHome, hasStoredCredential, loadStoredCredential } from "./auth/stores.ts";
import { describeStoredCredential } from "./auth/stores_doctor.ts";
import { ChainContext, credentialProvider, explain, profileSettings } from "./cloud/chains.ts";
import { sign } from "./cloud/sigv4.ts";
import { setDefaultPlatform, type CloudChain, type CloudChainOptions, type Platform, type SigV4Input } from "./platform.ts";

function openCloudChain(opts: CloudChainOptions): CloudChain {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) values[k] = v;
  const home = opts.home !== undefined ? expandHome(opts.home) : undefined;
  const ctx = opts.online
    ? ChainContext.online(values, home !== undefined ? { home } : {})
    : new ChainContext({ env: values, home: home ?? (values["HOME"] || undefined), files: opts.files ? { ...opts.files } : undefined });
  return {
    profile: (policy) => profileSettings(policy, ctx),
    get settings() {
      return ctx.settings;
    },
    set settings(value) {
      ctx.settings = { ...value };
    },
    credentialProvider: (policy) => credentialProvider(policy, ctx),
    explain: (policy, explicit) => explain(policy, ctx, explicit),
  };
}

function signSigV4(input: SigV4Input): Readonly<Record<string, string>> {
  return sign({
    method: input.method,
    url: input.url,
    headers: { ...input.headers },
    payload: input.payload,
    credentials: input.credentials,
    region: input.region,
    service: input.service,
    now: input.now,
  }).headers;
}

export const nodePlatform: Platform = Object.freeze({
  name: "node",
  env: () => process.env,
  readFile: (path: string) => new Uint8Array(readFileSync(path)),
  storedCredentials: Object.freeze({ load: loadStoredCredential, has: hasStoredCredential, describe: describeStoredCredential }),
  openCloudChain,
  signSigV4,
  webSocketHeaders: true,
});

/** Make Node's services the process default. Idempotent; the Node entry point calls it on import. */
export function installNodePlatform(): void {
  setDefaultPlatform(nodePlatform);
}
