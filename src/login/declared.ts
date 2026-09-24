/**
 * Routes that exist only for a managed connection (port of lm15-python
 * `lm15/login/declared.py`): `kimi-code` (Anthropic Messages at
 * api.kimi.com/coding) and `github-copilot` (Chat Completions at the
 * account's Copilot host). They have no contract wire receipt, so they are not
 * registry rows (a row is a support claim, AUTH-26); they are declared
 * providers, the mechanism an application uses for a server lm15 has never
 * seen, and a router lists them only when it can hold their credential.
 */

import { GITHUB_COPILOT, KIMI_CODE } from "../auth/policy.ts";
import { ProviderDefinition } from "../registry.ts";

export const KIMI_CODE_DEFINITION: ProviderDefinition = ProviderDefinition.anthropic(KIMI_CODE, {
  compat: {},
  note: "Kimi Code subscription over the Anthropic Messages wire (managed login only; no lm15 wire receipt yet)",
});

export const GITHUB_COPILOT_DEFINITION: ProviderDefinition = ProviderDefinition.chat(GITHUB_COPILOT, {
  compat: { instructionRole: "system", maxTokensField: "max_completion_tokens", streamUsage: "include", thinkingFormat: "reasoning_effort" },
  note: "GitHub Copilot over the Chat Completions wire (managed login only; the account's host comes from the token; no lm15 wire receipt yet)",
});

export const DECLARED_LOGIN_PROVIDERS: readonly ProviderDefinition[] = Object.freeze([KIMI_CODE_DEFINITION, GITHUB_COPILOT_DEFINITION]);
