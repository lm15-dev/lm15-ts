/**
 * The public vocabulary of managed login (spec/auth-managed.md AUTH-12,
 * AUTH-13, AUTH-16, AUTH-22). Every value here is secret-free except the
 * types named `*Material`, which only flows, stores and the request path
 * touch. Mirrors lm15-python `lm15/login/types.py`; TypeScript mechanics
 * (promises, AbortSignal) replace Python's.
 */

export type ConnectionKind = "account" | "api_key" | "cloud_identity" | "local_server";
export type LoginFlow = "authorization_code" | "device_code" | "form" | "source_recipe";
export type Availability = "supported" | "unavailable" | "unverified";
/** How the authorization result comes back (AUTH-13.4). `page_redirect` is a browser page receiving the return itself. */
export type Delivery = "loopback" | "manual" | "device" | "page_redirect";
/** Where the SDK is running (AUTH-22). Declared by the host, never probed during discovery. */
export type LoginPlatform = "native" | "browser";

/**
 * The stages a request belongs to, for routing and relay consent (proposed
 * AUTH-21 promotion, changes/2026-09-24): `auth` covers authorization,
 * device start and polling, code exchange, renewal and key mint; `catalog`
 * a model list; `inference` a model call.
 */
export type RelayStage = "auth" | "catalog" | "inference";

export interface SelectOption { readonly id: string; readonly label: string; readonly description?: string }

export interface MethodField {
  readonly id: string;
  readonly label: string;
  readonly type: "text" | "secret" | "select";
  readonly required: boolean;
  /** The choices of a `select` field. */
  readonly options?: readonly SelectOption[];
  readonly help?: string;
}

export interface LoginMethod {
  readonly id: string;
  readonly label: string;
  readonly kind: ConnectionKind;
  readonly flow: LoginFlow;
  /** On this platform, with this routing: `supported` has evidence; `unverified` needs explicit opt-in; `unavailable` cannot start. */
  readonly availability: Availability;
  readonly reason?: string;
  readonly fields: readonly MethodField[];
  /** Delivery modes implemented here and accepted by the provider's registration. */
  readonly delivery: readonly Delivery[];
  /** Backed by a provider subscription, per provider docs; never an entitlement promise. */
  readonly subscription: boolean;
  readonly billingNote?: string;
  /** Where to get what the method needs (a console URL); display only. */
  readonly guidance?: string;
  /**
   * Browser only: which request stages this method's endpoints cannot reach
   * directly from a page (browser.json evidence), so need a relay the
   * application configured. Empty on native.
   */
  readonly needsRelay: readonly RelayStage[];
}

export interface ProviderDescriptor {
  /** The LM15 route. */
  readonly id: string;
  readonly label: string;
  readonly service: string;
  readonly routes: readonly string[];
  readonly methods: readonly LoginMethod[];
  readonly consoleUrl?: string;
}

// ─── The UI boundary (AUTH-16) ──────────────────────────────────────

export interface TextPrompt { readonly type: "text"; readonly fieldId: string; readonly label: string; readonly placeholder?: string }
export interface SecretPrompt { readonly type: "secret"; readonly fieldId: string; readonly label: string; readonly placeholder?: string }
export interface SelectPrompt {
  readonly type: "select";
  readonly fieldId: string;
  readonly label: string;
  readonly options: readonly SelectOption[];
}
/**
 * Paste the return: a URL, `code#state`, or a code. A page that receives the
 * return itself (`page_redirect`) answers this prompt with the URL it was
 * given; the flow validates it exactly as a pasted one.
 */
export interface ManualCodePrompt {
  readonly type: "manual_code";
  readonly fieldId: string;
  readonly label: string;
  readonly accepted: string;
  /** Set for `page_redirect`: the page the provider sends the person back to (origin + path). Not secret. */
  readonly pageReturn?: { readonly url: string };
}
export type Prompt = TextPrompt | SecretPrompt | SelectPrompt | ManualCodePrompt;

/** Open this URL (a navigation, never fetched by the SDK). Session-sensitive: contains state and a PKCE challenge. */
export interface AuthUrlNotice { readonly type: "auth_url"; readonly url: string; readonly instructions: string }
/** Session-sensitive display material (AUTH-21): show it to the person, never log it. */
export interface DeviceCodeNotice {
  readonly type: "device_code";
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInS: number;
  readonly intervalS: number;
}
export interface ProgressNotice { readonly type: "progress"; readonly stage: string; readonly message: string }
export interface InfoNotice { readonly type: "info"; readonly message: string; readonly links?: ReadonlyArray<readonly [label: string, url: string]> }
export type Notice = AuthUrlNotice | DeviceCodeNotice | ProgressNotice | InfoNotice;

/**
 * What an application supplies so a login can talk to a person. `prompt`
 * resolves with the answer (a select answers the option id) and must honor
 * `signal` (reject when it aborts). A UI never opens anything unless that is
 * the application's own choice.
 */
export interface AuthUI {
  prompt(prompt: Prompt, options: { readonly signal: AbortSignal }): Promise<string>;
  notify(notice: Notice): void;
  /** A displayed prompt became stale (the attempt ended). Optional. */
  dismiss?(prompt: Prompt): void;
}

// ─── Material (private) and results ─────────────────────────────────

/** `expires` and `issued_at` are epoch milliseconds; `expires` is the actual expiry, never pre-skewed (store-layout.md). */
export interface OAuthMaterial {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh?: string;
  readonly expires?: number;
  readonly issued_at?: number;
  readonly lifetime_s?: number;
  /** Codex. */
  readonly accountId?: string;
  readonly id_token?: string;
}
export interface ApiKeyMaterial { readonly type: "api_key"; readonly key: string; readonly minted?: boolean }
export type LoginMaterial = OAuthMaterial | ApiKeyMaterial;

export type RenewalKind = "refresh_token" | "remint" | "none";

export interface LoginOutcome {
  readonly provider: string;
  readonly methodId: string;
  /** Secret. Store it deliberately (store-layout.md shapes); never log it. */
  readonly material: LoginMaterial;
  readonly label: string;
  readonly renewal: RenewalKind;
  /** Non-secret method settings (`enterprise_domain`, `oauth_host`). */
  readonly settings: Readonly<Record<string, string>>;
}

/** What a model request needs from valid material. `credential` is secret. */
export interface LoginRequestAuth {
  readonly route: string;
  readonly credential: { readonly kind: "bearer" | "api_key"; readonly value: string };
  readonly headers: Readonly<Record<string, string>>;
  /** Set when the credential decides the host (Copilot) or the route has no registry entry (Kimi Code). */
  readonly baseUrl?: string;
  readonly accountId?: string;
}
