/**
 * The providers a manager can connect (AUTH-13), from definitions only:
 * port of lm15-python `lm15/login/flows/__init__.py`. Account flows are
 * hand-written per provider; key, env, external, cloud and local recipes are
 * generated from the provider registry, so every route the router knows can
 * be connected the same way. Nothing here reads a credential, the network or
 * the environment.
 */

import { isCloudChain } from "../auth/policy.ts";
import { PROVIDERS, canonicalProvider } from "../registry.ts";
import { claudeFlow } from "./flows/claude.ts";
import { codexFlow } from "./flows/codex.ts";
import { copilotFlow } from "./flows/copilot.ts";
import { kimiFlow } from "./flows/kimi.ts";
import { metaFlow } from "./flows/meta.ts";
import { openrouterFlow } from "./flows/openrouter.ts";
import { xaiFlow } from "./flows/xai.ts";
import type { ProviderFlow } from "./flows/base.ts";
import { apiKeyMethod, cloudMethod, envMethod, EXTERNAL_SOURCES, externalMethod, localMethod } from "./recipes.ts";
import { loginMethods, type LoginEnvironment } from "./run.ts";
import type { LoginMethod, ProviderDescriptor } from "./types.ts";

export const RADIUS_ID = "radius";

/** Providers whose account login lm15 implements (R11's inventory). */
export const ACCOUNT_FLOWS: Readonly<Record<string, ProviderFlow>> = Object.freeze({
  xai: xaiFlow,
  "claude-code": claudeFlow,
  "openai-codex": codexFlow,
  openrouter: openrouterFlow,
  meta: metaFlow,
  "kimi-code": kimiFlow,
  "github-copilot": copilotFlow,
});

const SERVICE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "Anthropic", "claude-code": "Anthropic", openai: "OpenAI", "openai-chat": "OpenAI",
  "openai-codex": "OpenAI", gemini: "Google", vertex: "Google Cloud", "vertex-anthropic": "Google Cloud",
  "vertex-express": "Google Cloud", azure: "Microsoft Azure", "azure-chat": "Microsoft Azure",
  "azure-anthropic": "Microsoft Azure", "aws-anthropic": "AWS", "bedrock-anthropic": "AWS",
  "bedrock-chat": "AWS", "bedrock-mantle-chat": "AWS", meta: "Meta", "meta-chat": "Meta",
  "meta-anthropic": "Meta", moonshotai: "Moonshot AI", "moonshotai-anthropic": "Moonshot AI",
  "moonshotai-responses": "Moonshot AI", "kimi-code": "Moonshot AI", deepseek: "DeepSeek",
  "deepseek-anthropic": "DeepSeek", groq: "Groq", openrouter: "OpenRouter", xai: "xAI",
  zai: "Z.AI", typesafe: "TypeSafe", ollama: "Local", vllm: "Local", sglang: "Local",
  "github-copilot": "GitHub",
});

function recipeMethods(provider: string): LoginMethod[] {
  const methods: LoginMethod[] = [];
  for (const [source, [route]] of Object.entries(EXTERNAL_SOURCES)) if (route === provider) methods.push(externalMethod(source));
  const definition = PROVIDERS.get(provider);
  if (!definition) return methods;
  const access = definition.access;
  if (isCloudChain(access)) methods.push(cloudMethod());
  if (definition.placeholderKey !== undefined) {
    methods.push(localMethod());
    return methods;
  }
  const policy = access.credentialPolicy as string;
  if (["key", "oauth-unless-explicit", "connection", "aws-chain", "azure-chain", "gcp-chain"].includes(policy)) {
    if (policy !== "connection" || provider in ACCOUNT_FLOWS) methods.push(apiKeyMethod(definition.consoleUrl));
    if (access.envKeys.length > 0) methods.push(envMethod(access.envKeys));
  }
  return methods;
}

const RADIUS: ProviderDescriptor = Object.freeze({
  id: RADIUS_ID, label: "Radius", service: "Radius", routes: [],
  methods: [Object.freeze({
    id: "browser", label: "Sign in with Radius", kind: "account", flow: "authorization_code", availability: "unavailable",
    reason: "Radius's model protocol is not implemented in lm15; login without inference would be a false 'supported' claim",
    fields: [], delivery: [], subscription: false, needsRelay: [],
  }) as LoginMethod],
});

export function providerIds(): string[] {
  return [...new Set([...PROVIDERS.keys(), ...Object.keys(ACCOUNT_FLOWS), RADIUS_ID])].sort();
}

/** The AUTH-13 descriptor for a provider on this platform, or `undefined` for one lm15 cannot connect. */
export function descriptorFor(provider: string, env: LoginEnvironment = {}): ProviderDescriptor | undefined {
  const id = canonicalProvider(provider);
  if (id === RADIUS_ID) return RADIUS;
  const flow = ACCOUNT_FLOWS[id];
  const recipes = recipeMethods(id);
  if (flow) {
    const own = loginMethods(id, env).filter((m) => m.kind === "account" && !m.id.startsWith("external:"));
    const consoleUrl = flow.descriptor.consoleUrl ?? PROVIDERS.get(id)?.consoleUrl;
    return Object.freeze({
      id, label: flow.descriptor.label, service: flow.descriptor.service, routes: flow.descriptor.routes,
      methods: Object.freeze([...own, ...recipes]), ...(consoleUrl ? { consoleUrl } : {}),
    });
  }
  const definition = PROVIDERS.get(id);
  if (!definition) return undefined;
  return Object.freeze({
    id, label: id, service: SERVICE_LABELS[id] ?? id, routes: [id], methods: Object.freeze(recipes),
    ...(definition.consoleUrl ? { consoleUrl: definition.consoleUrl } : {}),
  });
}

/** Whether `methodId` is one of the provider's own account methods (not a recipe). */
export function isAccountMethod(provider: string, methodId: string): boolean {
  const flow = ACCOUNT_FLOWS[provider];
  return flow !== undefined && flow.descriptor.methods.some((m) => m.id === methodId && m.kind === "account");
}
