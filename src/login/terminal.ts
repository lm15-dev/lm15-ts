/**
 * The terminal adapter for AUTH-16 (Node only): port of lm15-python
 * `lm15/login/terminal.py`. Notices go to stderr; answers come from stdin;
 * a secret is read without echo. A browser opens only when the application
 * says so (`openBrowser: true`): otherwise the URL is printed for the person
 * to open, which is what a machine reached over SSH needs. Ctrl-C or a
 * closed input at a prompt cancels the login; nothing is retried.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { LoginCancelled } from "./engine.ts";
import type { AuthUI, Notice, Prompt } from "./types.ts";

export interface TerminalUIOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  /** Open authorization URLs in the default browser (https only). Default: print them. */
  readonly openBrowser?: boolean;
}

export class TerminalUI implements AuthUI {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #openBrowser: boolean;

  constructor(opts: TerminalUIOptions = {}) {
    this.#input = opts.input ?? process.stdin;
    this.#output = opts.output ?? process.stderr;
    this.#openBrowser = opts.openBrowser ?? false;
  }

  #say(text: string): void {
    this.#output.write(`${text}\n`);
  }

  notify(notice: Notice): void {
    if (notice.type === "auth_url") {
      this.#say(`\nOpen this link to sign in:\n  ${notice.url}\n${notice.instructions}`);
      if (this.#openBrowser) open(notice.url);
    } else if (notice.type === "device_code") {
      this.#say(`\nOpen ${notice.verificationUrl}\nand enter this code:  ${notice.userCode}\n(the code is valid for about ${Math.trunc(notice.expiresInS / 60)} minutes)`);
      if (this.#openBrowser) open(notice.verificationUrl);
    } else if (notice.type === "progress") {
      this.#say(`… ${notice.message}`);
    } else {
      this.#say(notice.message + (notice.links ?? []).map(([label, url]) => `\n  ${label}: ${url}`).join(""));
    }
  }

  async prompt(prompt: Prompt, opts: { readonly signal: AbortSignal }): Promise<string> {
    if (prompt.type === "select") {
      this.#say(`\n${prompt.label}`);
      prompt.options.forEach((option, i) => this.#say(`  ${i + 1}. ${option.label}${option.description ? `  — ${option.description}` : ""}`));
      for (;;) {
        const raw = (await this.#ask("Choose a number: ", opts.signal, false)).trim();
        const n = Number.parseInt(raw, 10);
        if (/^\d+$/.test(raw) && n >= 1 && n <= prompt.options.length) return prompt.options[n - 1]!.id;
        const byId = prompt.options.find((o) => o.id === raw);
        if (byId) return byId.id;
        this.#say("Not one of the choices.");
      }
    }
    if (prompt.type === "secret") return this.#ask(`${prompt.label}: `, opts.signal, true);
    if (prompt.type === "manual_code") return this.#ask(`${prompt.label}\n> `, opts.signal, false);
    return this.#ask(`${prompt.label}${prompt.placeholder ? ` [${prompt.placeholder}]` : ""}: `, opts.signal, false);
  }

  /** Nothing to clear: a prompt the attempt no longer needs was already closed through its signal. */
  dismiss(_prompt: Prompt): void {}

  #ask(question: string, signal: AbortSignal, secret: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new LoginCancelled("login cancelled at the prompt"));
      const rl = readline.createInterface({ input: this.#input, output: this.#output, terminal: (this.#input as { isTTY?: boolean }).isTTY === true });
      if (secret) {
        // Echo nothing while the secret is typed (the question itself is written first).
        const write = (rl as unknown as { _writeToOutput?: (s: string) => void });
        let asked = false;
        write._writeToOutput = (s: string) => {
          if (!asked) {
            asked = true;
            this.#output.write(s);
          }
        };
      }
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rl.close();
        if (secret) this.#output.write("\n");
        fn();
      };
      const onAbort = () => finish(() => reject(new LoginCancelled("login cancelled at the prompt")));
      signal.addEventListener("abort", onAbort, { once: true });
      rl.on("close", () => finish(() => reject(new LoginCancelled("the input was closed"))));
      rl.on("SIGINT", () => finish(() => reject(new LoginCancelled("login cancelled at the prompt"))));
      rl.question(question, (answer) => finish(() => resolve(answer)));
    });
  }
}

/** AUTH-18: never launch a scheme a provider chose; https only. Failure to open is not an error (the URL was printed). */
function open(url: string): void {
  if (!url.startsWith("https://")) return;
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // printed above; the person can open it
  }
}

/** A terminal UI when stdin and stderr are both a terminal; `undefined` otherwise (AUTH-23: never prompt a server). */
export function terminalUI(opts: { readonly openBrowser?: boolean } = {}): AuthUI | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;
  return new TerminalUI({ ...(opts.openBrowser !== undefined ? { openBrowser: opts.openBrowser } : {}) });
}
