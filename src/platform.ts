/**
 * The host boundary. Everything in lm15 that is not the wire — reading a
 * login the user's CLI stored, a file named by path, the process
 * environment, a cloud credential chain, SigV4 over the platform's crypto —
 * is a *host service*, reached only through this interface. The core never
 * imports `node:*`; the Node entry point (`lm15`) installs `nodePlatform`,
 * and the web entry point (`@lm15/lm15/browser`) runs on `webPlatform`, which
 * offers none of those services and says so in every error it raises.
 *
 * The boundary is the essence of lm15 stated as code: faithful
 * communication is universal; where a credential or a file comes from is
 * the host's business, never guessed.
 *
 * The default platform is process-wide and settable, exactly like the
 * default transport: a process is one host. Nothing reads it before a
 * request is built, so an application can install its own (an Electron
 * renderer with a preload bridge, a test) at any time before the first call.
 */

import type { AccessPolicy } from "./auth/policy.ts";
import { NotConfiguredError, UnsupportedFeatureError } from "./errors.ts";
import type { AwsCredentials, CredentialLike, CredentialValue, NamedCredential, SourcedCredentialProvider } from "./types/credential.ts";
import type { AuthStepState } from "./vocab.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** What `loadCredential` resolves: the credential to send and where it came from (AUTH-7). */
export interface LoadedCredential {
  readonly credential: CredentialLike | undefined;
  readonly accountId?: string;
  readonly source: "explicit" | "stored";
}

/**
 * A stored subscription login's state for the `oauth-unless-explicit` rung (AUTH-1, R3):
 * `usable` wins over env keys; `unusable` (expired, no refresh) and `logged_out` block them;
 * `absent` leaves the ordinary key chain.
 */
export type StoredCredentialState = "usable" | "unusable" | "logged_out" | "absent";

/** AUTH-8: logins a CLI stored on this host (Claude Code, Codex, lm15's own store). */
export interface StoredCredentials {
  /** The stored login for `policy`, re-read per call so rotations are seen. Throws `NotConfiguredError` when there is none. */
  load(policy: AccessPolicy, credentialsPath?: string): LoadedCredential;
  /** Offline probe for the router's `oauth-unless-explicit` rung: is a usable login stored? */
  has(policy: AccessPolicy): boolean;
  /** The stored login's state; a platform without it is read as `has() ? "usable" : "absent"`. */
  state?(policy: AccessPolicy, credentialsPath?: string): StoredCredentialState;
  /** The doctor's rung for the store (AUTH-7): where it looked, what it found, never the value. */
  describe(policy: AccessPolicy, opts: { readonly env: Env; readonly credentialsPath?: string | undefined; readonly shadowed: boolean }): ChainStep;
}

/** One rung of a credential chain, as the doctor reports it (AUTH-7). */
export interface ChainStep {
  readonly kind: string;
  readonly source: string;
  readonly detail: string;
  readonly state: AuthStepState;
}

/** AUTH-11: a cloud SDK's credential chain (AWS, Azure, Google Cloud), opened over one environment. */
export interface CloudChain {
  /**
   * Settings the cloud's own configuration supplies (AWS profile region; the
   * Google project from the credential file, gcloud, the ADC file), as
   * `[value, from]`, after explicit and env values. `[undefined, "metadata"]`
   * means only the metadata server could answer: see `deferredSetting`.
   */
  profile(policy: AccessPolicy): (name: string) => readonly [string | undefined, string] | undefined;
  /** Ask a network source for a setting before the first request (the Google project from the metadata server). */
  deferredSetting?(policy: AccessPolicy, name: string): () => Promise<string | undefined>;
  /** The resolved host settings, handed back once known; the chain's rungs read them. */
  settings: Readonly<Record<string, string>>;
  /** The chain's credential provider: resolved once, cached until the skew window, re-resolved after. */
  credentialProvider(policy: AccessPolicy, named?: NamedCredential): (() => Promise<CredentialValue>) | SourcedCredentialProvider;
  /** The rung-by-rung walk, no network: `explicit` says an api_keys entry exists (rung 0). */
  explain(policy: AccessPolicy, explicit: boolean, named?: NamedCredential): [ChainStep[], boolean];
}

export interface CloudChainOptions {
  readonly env: Env;
  /** Offline: the doctor. Online: the router (may run CLIs and call metadata endpoints). */
  readonly online: boolean;
  readonly home?: string | undefined;
  /** Harness-materialised files under a sandbox HOME (`~/...` keys). */
  readonly files?: Readonly<Record<string, string>> | undefined;
}

export interface SigV4Input {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Uint8Array;
  /** The credential object itself: its secret never leaves the class's private field for a plain record. */
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  readonly now: Date;
}

/**
 * Logins other tools own on this host (Claude Code CLI, Codex CLI, the Pi
 * agent's xAI store), used in place by a managed `external:` connection
 * (AUTH-15, R1): read, renewed under that tool's lock, never copied.
 */
export interface ExternalLogins {
  /** Throw a typed error now if that tool has no login here. No network. */
  probe(source: string): void;
  /** The current token (renewed in place when due), extra headers and the account id. Secret: `token`. */
  requestAuth(source: string): Promise<{ readonly token: string; readonly headers: Readonly<Record<string, string>>; readonly accountId?: string | undefined }>;
  /** The login's non-secret request shape, read without renewal (a router's synchronous `lm()`). */
  peek?(source: string): { readonly headers: Readonly<Record<string, string>>; readonly accountId?: string | undefined };
}

/** A one-shot loopback listener for an authorization-code return (AUTH-18); see `login/listener_node.ts`. */
export interface CallbackListener {
  /** The registered return URI the provider was told (it may say `localhost`). */
  readonly redirectUri: string;
  /** Resolves with the validated return, or `null` once stopped; rejects on a validated provider error. */
  wait(): Promise<{ readonly code: string; readonly state: string | null } | null>;
  /** True once a return arrived (or the listener was stopped). */
  readonly done: boolean;
  stop(): void;
}

export interface CallbackListenerOptions {
  readonly path: string;
  readonly expectedState: string | null;
  /** 0 = ephemeral. A fixed registered port that is busy is `method_unavailable`. */
  readonly port: number;
  /** Loopback only: `127.0.0.1` (default) or `::1`. */
  readonly bindHost?: "127.0.0.1" | "::1";
  /** The host in the registered redirect URI (`localhost` for some providers); never rewritten. */
  readonly redirectHost?: string;
}

export interface Platform {
  /** `"node"`, `"web"`, or an application's own name. Appears in errors so a report says which host refused. */
  readonly name: string;
  /** The process environment (`process.env` on Node; empty on the web — a page has none). */
  env(): Env;
  /** Bytes of a file named by path (path-addressed media, uploads). Absent where there is no filesystem. */
  readonly readFile?: (path: string) => Uint8Array;
  /** AUTH-8 stored logins. Absent where no CLI could have stored one. */
  readonly storedCredentials?: StoredCredentials;
  /** AUTH-11 cloud credential chains. Absent where there are no profile files, CLIs or metadata endpoints. */
  readonly openCloudChain?: (opts: CloudChainOptions) => CloudChain;
  /** AUTH-11 SigV4 over the host's crypto. May be async (Web Crypto is). Absent = AWS credentials cannot travel from this host. */
  readonly signSigV4?: (input: SigV4Input) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** Whether the host's `WebSocket` constructor accepts `{ headers }` (Node's does; a browser's does not). */
  readonly webSocketHeaders: boolean;
  /** The managed store for `Auth.local()` (AUTH-8 private file). Absent where there is no filesystem. */
  readonly openCredentialStore?: (path?: string) => import("./login/store.ts").Store;
  /** Other tools' logins, used in place by `external:` connections. Absent where no CLI could have stored one. */
  readonly externalLogins?: ExternalLogins;
  /** Loopback return listener for authorization-code logins. Absent in a page (it is the redirect target itself). */
  readonly openCallbackListener?: (opts: CallbackListenerOptions) => Promise<CallbackListener>;
  /** An interactive terminal for `connect()` when no UI is given; `undefined` when stdin/stderr are not a TTY. */
  readonly terminalUI?: (opts: { readonly openBrowser?: boolean }) => import("./login/types.ts").AuthUI | undefined;
}

/**
 * The platform with no host services: what a page, a worker or a PWA is.
 * Also the core's default, so a bundle that never loads the Node entry
 * cannot read a file or a stored login by accident — the safe direction.
 */
const EMPTY_ENV: Env = Object.freeze({});

export const webPlatform: Platform = Object.freeze({
  name: "web",
  env: () => EMPTY_ENV,
  webSocketHeaders: false,
});

let current: Platform = webPlatform;

export function getDefaultPlatform(): Platform {
  return current;
}

/** Install the host's services process-wide. The Node entry point does this on import. */
export function setDefaultPlatform(platform: Platform): void {
  current = platform;
}

// ─── The refusals, worded once ───────────────────────────────────────

/** A stored login was asked for on a host that cannot have one. */
export function noStoredCredentials(platform: Platform, policy: AccessPolicy): NotConfiguredError {
  const hint = policy.envKeys.length > 0 ? `; set ${policy.envKeys.join(" or ")} or pass apiKey` : "; pass apiKey";
  return new NotConfiguredError(
    `${policy.provider}: no credential given, and stored logins are not available on the ${platform.name} platform (a CLI login lives on the host's disk)${hint}`,
    { provider: policy.provider, envKeys: policy.envKeys, credentialHint: policy.loginHint ?? null },
  );
}

export function noFilesystem(platform: Platform, what: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    `${what}: the ${platform.name} platform has no filesystem; supply the bytes (a File, a Blob's bytes, an IndexedDB or OPFS read) instead of a path`,
  );
}

export function noCloudChain(platform: Platform, policy: AccessPolicy, named?: NamedCredential): NotConfiguredError {
  return new NotConfiguredError(
    `${policy.provider}: ${named ? `named credential "${named}" in the ` : "the "}${policy.credentialPolicy} credential chain is not available on the ${platform.name} platform (it reads profile files, runs CLIs and calls metadata endpoints); pass an explicit credential (apiKeys, a BearerToken from your own token endpoint)`,
    { provider: policy.provider, envKeys: policy.envKeys },
  );
}

export function noSigV4(platform: Platform, policy: AccessPolicy): NotConfiguredError {
  return new NotConfiguredError(
    `${policy.provider}: SigV4 signing is not available on the ${platform.name} platform; sign on a host with AWS credentials, or pass a BearerToken this door accepts`,
    { provider: policy.provider, envKeys: policy.envKeys },
  );
}
