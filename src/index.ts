/**
 * lm15 — one canonical request/response model over every provider the
 * lm15-contract names, byte-exact against its corpus.
 *
 * ```ts
 * import { LMRouter, Message } from "lm15";
 *
 * const router = new LMRouter(); // keys from the environment (AUTH-1)
 * const response = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("hi")] });
 * console.log(response.text);
 * ```
 */

// The Node host's services (process env, files, CLI login stores, cloud
// chains, SigV4) become the process default the moment this entry loads.
// `lm15/browser` is the same surface minus these, and never installs them.
import { installNodePlatform } from "./platform_node.ts";
import { NodeTransport } from "./transport_node.ts";
import { installTransportFactory } from "./transport.ts";

installNodePlatform();
installTransportFactory((options) => new NodeTransport(options));

export * from "./browser.ts";
export { nodePlatform } from "./platform_node.ts";
export { NodeTransport } from "./transport_node.ts";
export { login, loginXai, LocalOAuthCredential, CredentialFileStore, defaultCredentialsPath, withFileLock } from "./auth/stores.ts";
export { ChainContext, explain as explainChain, credentialProvider } from "./cloud/chains.ts";
