/**
 * What a provider login flow is (port of lm15-python `lm15/login/flows/base.py`).
 * A flow describes one provider's protocol and nothing else: the engine owns
 * deadlines, cancellation, UI, HTTP bounds and routing; the runner owns
 * platform availability and error mapping. A flow answers:
 *
 * - `login`: run a method, return material;
 * - `renew`: fresh material from saved material, or `LoginDenied` (permanent);
 * - `requestAuth`: what a model request needs from valid material;
 * - `requests`: the auth requests a method makes (browser routing evidence).
 */

import type { LoginContext } from "../engine.ts";
import type { RequestProfile } from "../profiles.ts";
import type { ConnectionKind, Delivery, LoginFlow, LoginMaterial, LoginRequestAuth, MethodField, OAuthMaterial, RenewalKind } from "../types.ts";

/** A method as the provider's registration defines it, before any platform says what it can run. */
export interface MethodDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: ConnectionKind;
  readonly flow: LoginFlow;
  /** Native evidence (profiles.json `availability`). A page never inherits `supported` from it (AUTH-22). */
  readonly nativeAvailability: "supported" | "unverified" | "unavailable";
  readonly reason?: string;
  readonly fields?: readonly MethodField[];
  /** Every delivery the registration accepts; the runner keeps the ones this platform can run. */
  readonly delivery: readonly Delivery[];
  readonly subscription: boolean;
  readonly billingNote?: string;
}

export interface FlowDescriptor {
  readonly id: string;
  readonly label: string;
  readonly service: string;
  readonly routes: readonly string[];
  readonly methods: readonly MethodDefinition[];
  readonly consoleUrl?: string;
}

export interface FlowResult {
  readonly material: LoginMaterial;
  readonly label: string;
  readonly renewal: RenewalKind;
  readonly settings?: Readonly<Record<string, string>>;
}

/** What `login` is given besides the context. */
export interface LoginInputs {
  readonly settings: Readonly<Record<string, string>>;
  readonly answers: Readonly<Record<string, string>>;
  /** Browser `page_redirect`: the page (origin + path) the provider sends the person back to. */
  readonly pageReturnUrl?: string;
}

export interface ProviderFlow {
  readonly descriptor: FlowDescriptor;
  login(ctx: LoginContext, methodId: string, inputs: LoginInputs): Promise<FlowResult>;
  renew(ctx: LoginContext, material: LoginMaterial, settings: Readonly<Record<string, string>>): Promise<FlowResult>;
  requestAuth(material: LoginMaterial, settings: Readonly<Record<string, string>>): LoginRequestAuth;
  requests(methodId: string, settings: Readonly<Record<string, string>>): readonly RequestProfile[];
}

/** OAuth material with the actual expiry and the numbers the renewal lead needs (store-layout.md). */
export function oauthMaterial(fields: { access: string; refresh?: string | undefined; expiresInS?: number | undefined; nowMs: number; extra?: Partial<OAuthMaterial> }): OAuthMaterial {
  const material: Record<string, unknown> = { type: "oauth", access: fields.access };
  if (fields.refresh) material["refresh"] = fields.refresh;
  material["issued_at"] = fields.nowMs;
  if (fields.expiresInS !== undefined && fields.expiresInS > 0) {
    material["lifetime_s"] = fields.expiresInS;
    material["expires"] = Math.trunc(fields.nowMs + fields.expiresInS * 1000);
  }
  Object.assign(material, fields.extra ?? {});
  return Object.freeze(material) as unknown as OAuthMaterial;
}

export function oauth(material: LoginMaterial, provider: string): OAuthMaterial {
  if (material.type !== "oauth" || typeof material.access !== "string" || !material.access) throw new TypeError(`${provider}: expected OAuth material`);
  return material;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
