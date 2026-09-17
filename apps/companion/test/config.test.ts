import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("applies defaults from an empty env", () => {
    const c = loadConfig({});
    expect(c.port).toBe(9191);
    expect(c.hostname).toBe("0.0.0.0");
    expect(c.model).toBe("anthropic/claude-opus-4-8");
    expect(c.stt.engine).toBe("whisper-cpp");
    expect(c.tts.engine).toBe("piper");
    expect(c.tts.sampleRate).toBe(22050);
    expect(c.memory).toBeUndefined();
  });

  it("wires memory only when a Neo4j URI is present", () => {
    const c = loadConfig({
      ALFRED_NEO4J_URI: "bolt://localhost:7687",
      ALFRED_NEO4J_DATABASE: "brain",
      ALFRED_EMBEDDING_DIMENSIONS: "1024",
    });
    expect(c.memory).toBeDefined();
    expect(c.memory?.storeId).toBe("neo4j/brain");
    expect(c.memory?.dimensions).toBe(1024);
    expect(c.memory?.uri).toBe("bolt://localhost:7687");
  });

  it("honours explicit overrides", () => {
    const c = loadConfig({
      ALFRED_COMPANION_PORT: "9000",
      ALFRED_COMPANION_MODEL: "local/llama3.1:8b",
      ALFRED_STT_LANGUAGE: "en",
    });
    expect(c.port).toBe(9000);
    expect(c.model).toBe("local/llama3.1:8b");
    expect(c.stt.language).toBe("en");
  });

  it("throws on a non-integer port", () => {
    expect(() => loadConfig({ ALFRED_COMPANION_PORT: "abc" })).toThrow();
  });

  it("throws on an out-of-range port", () => {
    expect(() => loadConfig({ ALFRED_COMPANION_PORT: "70000" })).toThrow();
  });
});
