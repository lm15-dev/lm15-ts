import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Part, Message, createDataSource, dataSourceBytes,
  type TextPart, type ToolCallPart, type ImagePart,
  EMPTY_USAGE,
} from "../types.js";

describe("Part factories", () => {
  it("creates text parts", () => {
    const p = Part.text("hello");
    assert.equal(p.type, "text");
    assert.equal(p.text, "hello");
  });

  it("creates thinking parts", () => {
    const p = Part.thinking("hmm", { redacted: false });
    assert.equal(p.type, "thinking");
    assert.equal(p.text, "hmm");
    assert.equal(p.redacted, false);
  });

  it("creates refusal parts", () => {
    const p = Part.refusal("no");
    assert.equal(p.type, "refusal");
    assert.equal(p.text, "no");
  });

  it("creates citation parts", () => {
    const p = Part.citation({ text: "src", url: "https://x.com", title: "X" });
    assert.equal(p.type, "citation");
    assert.equal(p.url, "https://x.com");
  });

  it("creates image parts from URL", () => {
    const p = Part.image({ url: "https://example.com/img.png" });
    assert.equal(p.type, "image");
    assert.equal(p.source.type, "url");
    assert.equal(p.source.url, "https://example.com/img.png");
  });

  it("creates image parts from base64", () => {
    const p = Part.image({ data: "iVBOR", media_type: "image/png" });
    assert.equal(p.source.type, "base64");
    assert.equal(p.source.data, "iVBOR");
  });

  it("creates audio parts", () => {
    const p = Part.audio({ data: "AAAA", media_type: "audio/wav" });
    assert.equal(p.type, "audio");
    assert.equal(p.source.type, "base64");
  });

  it("creates tool call parts", () => {
    const p = Part.toolCall("c1", "get_weather", { city: "Montreal" });
    assert.equal(p.type, "tool_call");
    assert.equal(p.id, "c1");
    assert.equal(p.name, "get_weather");
    assert.deepEqual(p.input, { city: "Montreal" });
  });

  it("creates tool result parts", () => {
    const p = Part.toolResult("c1", [Part.text("22°C")], { name: "weather" });
    assert.equal(p.type, "tool_result");
    assert.equal(p.id, "c1");
    assert.equal(p.content.length, 1);
  });

  it("rejects media parts with no source", () => {
    assert.throws(() => Part.image({}), /exactly one/);
  });

  it("rejects media parts with multiple sources", () => {
    assert.throws(() => Part.image({ url: "x", data: "y" }), /exactly one/);
  });
});

describe("DataSource", () => {
  it("validates base64 requires data and media_type", () => {
    assert.throws(() => createDataSource({ type: "base64" }), /requires data/);
    assert.throws(() => createDataSource({ type: "base64", data: "x" }), /requires media_type/);
  });

  it("validates url requires url", () => {
    assert.throws(() => createDataSource({ type: "url" }), /requires url/);
  });

  it("validates file requires file_id", () => {
    assert.throws(() => createDataSource({ type: "file" }), /requires file_id/);
  });

  it("decodes bytes from base64", () => {
    const ds = createDataSource({ type: "base64", data: "AQID", media_type: "application/octet-stream" });
    const bytes = dataSourceBytes(ds);
    assert.deepEqual([...bytes], [1, 2, 3]);
  });
});

describe("Message factories", () => {
  it("creates user messages", () => {
    const m = Message.user("hello");
    assert.equal(m.role, "user");
    assert.equal(m.parts.length, 1);
    assert.equal((m.parts[0] as TextPart).text, "hello");
  });

  it("creates assistant messages", () => {
    const m = Message.assistant("hi");
    assert.equal(m.role, "assistant");
  });

  it("creates tool result messages", () => {
    const m = Message.toolResults({ c1: "22°C", c2: [Part.text("sunny")] });
    assert.equal(m.role, "tool");
    assert.equal(m.parts.length, 2);
  });
});

describe("Usage", () => {
  it("has zero defaults", () => {
    assert.equal(EMPTY_USAGE.input_tokens, 0);
    assert.equal(EMPTY_USAGE.output_tokens, 0);
    assert.equal(EMPTY_USAGE.total_tokens, 0);
    assert.equal(EMPTY_USAGE.cache_read_tokens, undefined);
  });
});
