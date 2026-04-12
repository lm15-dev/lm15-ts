import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, CapabilityResolver } from "../capabilities.js";
import { UnsupportedModelError } from "../errors.js";

describe("resolveProvider", () => {
  it("resolves claude to anthropic", () => {
    assert.equal(resolveProvider("claude-sonnet-4-5"), "anthropic");
  });

  it("resolves gpt to openai", () => {
    assert.equal(resolveProvider("gpt-4.1-mini"), "openai");
  });

  it("resolves gemini to gemini", () => {
    assert.equal(resolveProvider("gemini-2.5-flash"), "gemini");
  });

  it("resolves o1/o3/o4 to openai", () => {
    assert.equal(resolveProvider("o1-preview"), "openai");
    assert.equal(resolveProvider("o3-mini"), "openai");
    assert.equal(resolveProvider("o4-mini"), "openai");
  });

  it("throws on unknown model", () => {
    assert.throws(() => resolveProvider("llama-3"), UnsupportedModelError);
  });
});

describe("CapabilityResolver", () => {
  it("resolves provider from pattern", () => {
    const r = new CapabilityResolver();
    assert.equal(r.resolveProvider("claude-sonnet-4-5"), "anthropic");
  });

  it("resolves capabilities", () => {
    const r = new CapabilityResolver();
    const caps = r.resolveCapabilities("gpt-4.1-mini");
    assert.ok(caps.features.has("streaming"));
    assert.ok(caps.features.has("tools"));
  });
});
