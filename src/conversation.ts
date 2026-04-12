/**
 * Conversation — stateless message accumulator.
 */

import type { LMResponse, Message, Part } from "./types.js";
import { Part as PartFactory, Message as MessageFactory } from "./types.js";

export class Conversation {
  system: string | undefined;
  private _messages: Message[] = [];

  constructor(opts?: { system?: string }) {
    this.system = opts?.system;
  }

  user(content: string | (string | Part)[]): void {
    if (typeof content === "string") {
      this._messages.push({ role: "user", parts: [PartFactory.text(content)] });
      return;
    }
    const parts = content.map(item =>
      typeof item === "string" ? PartFactory.text(item) : item,
    );
    this._messages.push({ role: "user", parts });
  }

  assistant(response: LMResponse): void {
    this._messages.push(response.message);
  }

  toolResults(results: Record<string, string | Part | Part[]>): void {
    this._messages.push(MessageFactory.toolResults(results));
  }

  prefill(text: string): void {
    this._messages.push({ role: "assistant", parts: [PartFactory.text(text)] });
  }

  get messages(): readonly Message[] {
    return [...this._messages];
  }

  clear(): void {
    this._messages = [];
  }
}
