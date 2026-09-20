import assert from "node:assert/strict";
import test from "node:test";
import * as browser from "../src/browser.ts";
import { RawNumber } from "../src/json.ts";

test("browser public surface exposes data, provider declarations and honest transport budgets", () => {
  assert.equal(typeof browser.ProviderDefinition.chat, "function");
  assert.equal(typeof browser.ProviderDefinition.responses, "function");
  assert.equal(typeof browser.ProviderDefinition.anthropic, "function");
  assert.equal(typeof browser.CredentialSource, "function");
  assert.equal(typeof browser.ProtocolError, "function");
  assert.equal(typeof browser.BatchJob, "function");
  assert.equal(typeof browser.VideoJob, "function");
  assert.equal("NodeTransport" in browser, false);
  const timeouts = new browser.Timeouts();
  assert.equal(timeouts.connect, 10);
  assert.equal(timeouts.read, 600);
  assert.equal(timeouts.write, 600);
  assert.equal(timeouts.pool, 600);
});

test("public data factory preserves opaque number precision and canonical serde", () => {
  const value = { amount: new RawNumber("9007199254740993"), ratio: new RawNumber("1.0") };
  const part = browser.data(value);
  assert.equal(part.value, value);
  assert.equal(browser.stringifyJson(browser.Part.toJSON(part)), '{"type":"data","value":{"amount":9007199254740993,"ratio":1.0}}');
  assert.equal(browser.Message.user(part).parts[0], part);
});
