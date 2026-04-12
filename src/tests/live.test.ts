import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketLiveSession } from "../live.js";
import type { LiveClientEvent, LiveServerEvent, JsonObject } from "../types.js";
import { EventEmitter } from "node:events";

/** Minimal mock WebSocket for testing. */
class MockWebSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;

  constructor() {
    super();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  addEventListener(event: string, handler: (...args: unknown[]) => void) {
    this.on(event, handler);
  }

  // Simulate receiving a message from the "server"
  simulateMessage(data: string) {
    this.emit("message", { data } as MessageEvent);
  }
}

describe("WebSocketLiveSession", () => {
  it("sends text events", () => {
    const ws = new MockWebSocket();
    const session = new WebSocketLiveSession({
      ws: ws as unknown as WebSocket,
      encodeEvent: (evt) => {
        if (evt.type === "text") return [{ type: "text", text: evt.text ?? "" }];
        return [];
      },
      decodeEvent: () => [],
    });

    session.send(undefined, { text: "hello" });
    assert.equal(ws.sent.length, 1);
    const parsed = JSON.parse(ws.sent[0]);
    assert.equal(parsed.type, "text");
    assert.equal(parsed.text, "hello");
  });

  it("receives server events", async () => {
    const ws = new MockWebSocket();
    const session = new WebSocketLiveSession({
      ws: ws as unknown as WebSocket,
      encodeEvent: () => [],
      decodeEvent: (raw) => {
        const data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        if (data.type === "text") return [{ type: "text" as const, text: data.text } as LiveServerEvent];
        return [];
      },
    });

    // Simulate server sending a message
    setTimeout(() => ws.simulateMessage(JSON.stringify({ type: "text", text: "hi" })), 10);

    const event = await session.recv();
    assert.equal(event.type, "text");
    assert.equal(event.text, "hi");
  });

  it("closes cleanly", () => {
    const ws = new MockWebSocket();
    const session = new WebSocketLiveSession({
      ws: ws as unknown as WebSocket,
      encodeEvent: () => [],
      decodeEvent: () => [],
    });

    session.close();
    assert.ok(ws.closed);

    // Sending after close should throw
    assert.throws(() => session.send(undefined, { text: "hi" }), /closed/);
  });

  it("auto-executes tools", async () => {
    const ws = new MockWebSocket();
    let toolCalled = false;

    const session = new WebSocketLiveSession({
      ws: ws as unknown as WebSocket,
      encodeEvent: (evt) => {
        if (evt.type === "tool_result") {
          return [{ type: "tool_result", id: evt.id ?? "", content: "result" }];
        }
        return [];
      },
      decodeEvent: (raw) => {
        const data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        if (data.type === "tool_call") {
          return [{
            type: "tool_call" as const,
            id: data.id,
            name: data.name,
            input: data.input ?? {},
          } as LiveServerEvent];
        }
        return [];
      },
      callableRegistry: {
        greet: () => { toolCalled = true; return "Hello!"; },
      },
    });

    // Simulate a tool call from the server
    setTimeout(() => ws.simulateMessage(JSON.stringify({
      type: "tool_call",
      id: "tc1",
      name: "greet",
      input: {},
    })), 10);

    const event = await session.recv();
    assert.equal(event.type, "tool_call");
    assert.ok(toolCalled);
    // Should have sent a tool result back
    assert.ok(ws.sent.length > 0);
  });
});
