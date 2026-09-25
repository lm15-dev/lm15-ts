/**
 * The Node host's sign-in services (installed by `platform_node.ts`): the
 * private file store for `Auth.local()`, other tools' logins used in place by
 * `external:` connections, the loopback return listener and the terminal UI.
 */

import { extractChatgptAccountId, getClaudeCodeAccessToken, getCodexCliCredential, getXaiAccessToken, loadClaudeCodeCredential, loadCodexCliCredential, loadXaiCredential, piAgentAuthPath } from "../auth/stores.ts";
import type { ExternalLogins } from "../platform.ts";
import { LoginDenied } from "./engine.ts";

export const nodeExternalLogins: ExternalLogins = Object.freeze({
  probe(source: string): void {
    // A missing login fails now, typed (NotConfiguredError names the tool's own sign-in).
    if (source === "claude-code-cli") loadClaudeCodeCredential();
    else if (source === "codex-cli") loadCodexCliCredential();
    else if (source === "pi-xai") loadXaiCredential(piAgentAuthPath());
    else throw new LoginDenied(`unknown external source ${JSON.stringify(source)}`);
  },

  async requestAuth(source: string) {
    if (source === "claude-code-cli") return { token: await getClaudeCodeAccessToken(), headers: {} };
    if (source === "codex-cli") {
      const credential = await getCodexCliCredential();
      const accountId = credential.accountId ?? extractChatgptAccountId(credential.accessToken);
      return { token: credential.accessToken, headers: accountId ? { "chatgpt-account-id": accountId } : {}, accountId };
    }
    if (source === "pi-xai") return { token: await getXaiAccessToken(piAgentAuthPath()), headers: {} };
    throw new LoginDenied(`unknown external source ${JSON.stringify(source)}`);
  },

  peek(source: string) {
    if (source !== "codex-cli") return { headers: {} };
    const credential = loadCodexCliCredential();
    const accountId = credential.accountId ?? extractChatgptAccountId(credential.accessToken);
    return { headers: accountId ? { "chatgpt-account-id": accountId } : {}, accountId };
  },
});
