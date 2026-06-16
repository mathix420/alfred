import { describe, expect, it } from "bun:test";
import { parseModelId } from "../src/models/registry";

describe("parseModelId", () => {
  it("parses provider/model", () => {
    expect(parseModelId("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it("keeps slashes in the model name (local tags)", () => {
    expect(parseModelId("local/library/llama3.1:8b").model).toBe("library/llama3.1:8b");
  });

  it("rejects unknown providers", () => {
    expect(() => parseModelId("openai/gpt-4")).toThrow();
  });

  it("rejects ids without a provider", () => {
    expect(() => parseModelId("claude-opus-4-8")).toThrow();
  });
});
