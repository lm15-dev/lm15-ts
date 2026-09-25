/**
 * One-shot loopback listener for an authorization-code return (AUTH-18),
 * Node only. Port of lm15-python `CallbackListener`:
 *
 * - binds loopback only (`127.0.0.1`, or `::1`), never a wildcard or a LAN
 *   address; the registered redirect URI (which may say `localhost`) is a
 *   separate value and is never rewritten;
 * - answers only the exact path; the state is checked on success **and**
 *   error returns; a wrong state, both a code and an error, neither, or a
 *   repeated parameter gets a generic rejection and the wait goes on;
 * - bounded request target (8 KiB) and headers (32 KiB); no access log
 *   (return URLs carry codes); pages are `no-store` and `no-referrer`;
 * - a registered fixed port that is busy is `method_unavailable`, so the
 *   flow can offer manual return instead.
 */

import * as http from "node:http";
import { AuthOperationError } from "../errors.ts";
import type { CallbackListener, CallbackListenerOptions } from "../platform.ts";
import { LoginDenied } from "./engine.ts";

const TARGET_LIMIT = 8 * 1024;
const HEADER_LIMIT = 32 * 1024;

function page(title: string, message: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset='utf-8'><meta name='referrer' content='no-referrer'><title>${esc(title)}</title><p>${esc(message)}</p>`;
}

export async function openCallbackListener(opts: CallbackListenerOptions): Promise<CallbackListener> {
  const bindHost = opts.bindHost ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    throw new AuthOperationError(`callback listener may bind loopback only, not ${JSON.stringify(bindHost)}`, { reason: "method_unavailable", stage: "reservation", recovery: "operator_action" });
  }
  if (!opts.path.startsWith("/")) throw new TypeError("callback path must start with '/'");
  let settled = false;
  let resolveWait!: (value: { code: string; state: string | null } | null) => void;
  let rejectWait!: (error: unknown) => void;
  const waiting = new Promise<{ code: string; state: string | null } | null>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  waiting.catch(() => undefined); // observed through wait(); never an unhandled rejection

  const server = http.createServer({ maxHeaderSize: HEADER_LIMIT }, (req, res) => {
    const reply = (status: number, title: string, message: string): void => {
      const body = page(title, message);
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      });
      res.end(body);
    };
    const target = req.url ?? "";
    if (req.method !== "GET" || target.length > TARGET_LIMIT) return reply(414, "Rejected", "Request too large.");
    const url = new URL(target, "http://callback.invalid");
    if (url.pathname !== opts.path) return reply(404, "Not found", "Callback route not found.");
    if (settled) return reply(409, "Already used", "This sign-in return was already handled.");
    const names = [...url.searchParams.keys()];
    if (new Set(names).size !== names.length) return reply(400, "Rejected", "Sign-in return was not accepted.");
    const state = url.searchParams.get("state");
    // Wrong state on a success OR an error return: generic rejection; the legitimate wait continues.
    if (opts.expectedState !== null && state !== opts.expectedState) return reply(400, "Rejected", "Sign-in return was not accepted.");
    const code = url.searchParams.get("code");
    const hasError = url.searchParams.has("error");
    if (Boolean(code) === hasError) return reply(400, "Rejected", "Sign-in return was not accepted.");
    settled = true;
    if (hasError) {
      reply(400, "Not completed", "Sign-in was not completed.");
      rejectWait(new LoginDenied("the provider returned an error to the sign-in callback"));
    } else {
      reply(200, "Signed in", "Sign-in completed. You can close this window.");
      resolveWait({ code: code!, state });
    }
    stop();
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: bindHost, port: opts.port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    throw new AuthOperationError(
      `could not listen on ${bindHost}:${opts.port || "ephemeral"} for the sign-in return (${error.code ?? error.name}); another program may be using the port`,
      { reason: "method_unavailable", stage: "reservation", recovery: "choose_method" },
    );
  });
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  let host = opts.redirectHost ?? bindHost;
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const redirectUri = `http://${host}:${port}${opts.path}`;

  function stop(): void {
    if (!settled) {
      settled = true;
      resolveWait(null);
    }
    server.close();
    server.closeAllConnections?.();
  }

  return {
    redirectUri,
    get done() {
      return settled;
    },
    wait: () => waiting,
    stop,
  };
}
