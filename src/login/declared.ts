/**
 * Routes that exist only for a managed connection (port of lm15-python
 * `lm15/login/declared.py`): `kimi-code` (Anthropic Messages at
 * api.kimi.com/coding) and `github-copilot` (Chat Completions at the
 * account's Copilot host). They have no contract wire receipt, so they are not
 * registry rows (a row is a support claim, AUTH-26); they are declared
 * providers, the mechanism an application uses for a server lm15 has never
 * seen, and a router lists them only when it can hold their credential.
 */

import { tablePolicy } from "../auth/policy.ts";
import type { AnthropicCompat, OpenAIChatCompat } from "../compat.ts";
import { DECLARED_LOGIN_ROWS } from "../generated/tables.ts";
import { ProviderDefinition } from "../registry.ts";

/** One managed-login declared provider from the reference's table (src/generated/tables.ts). */
function declared(id: string): ProviderDefinition {
  const row = DECLARED_LOGIN_ROWS.find((r) => r.id === id);
  if (!row || row.compat === undefined || typeof row.compat === "string") throw new Error(`${id}: no declared-login row with a compat object in the generated table`);
  const policy = tablePolicy(id);
  if (row.dialect === "anthropic") return ProviderDefinition.anthropic(policy, { compat: row.compat as AnthropicCompat, note: row.note });
  if (row.dialect === "openai-chat") return ProviderDefinition.chat(policy, { compat: row.compat as OpenAIChatCompat, note: row.note });
  throw new Error(`${id}: a declared-login row on dialect ${row.dialect} has no declaration factory`);
}

export const KIMI_CODE_DEFINITION: ProviderDefinition = declared("kimi-code");

export const GITHUB_COPILOT_DEFINITION: ProviderDefinition = declared("github-copilot");

export const DECLARED_LOGIN_PROVIDERS: readonly ProviderDefinition[] = Object.freeze([KIMI_CODE_DEFINITION, GITHUB_COPILOT_DEFINITION]);
