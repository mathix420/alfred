import { describe, expect, it } from "bun:test";
import { resolveTts } from "../src/tts";
import { PiperTts } from "../src/tts/piper";

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("PiperTts", () => {
  it("derives its wire format from the sample rate", () => {
    const tts = new PiperTts({ binary: "piper", model: "v.onnx", sampleRate: 22050 });
    expect(tts.format).toEqual({ encoding: "pcm_s16le", sampleRate: 22050, channels: 1 });
  });

  it("delegates synthesis to the injected engine", async () => {
    let seenText: string | undefined;
    const tts = new PiperTts(
      { binary: "piper", model: "v.onnx", sampleRate: 22050 },
      async function* fake(text) {
        seenText = text;
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      },
    );

    const chunks = await collect(tts.synthesize("good evening"));
    expect(seenText).toBe("good evening");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(new Uint8Array([1, 2]));
  });
});

describe("resolveTts", () => {
  it("builds a PiperTts for piper", () => {
    expect(
      resolveTts({ engine: "piper", binary: "piper", model: "v", sampleRate: 22050 }),
    ).toBeInstanceOf(PiperTts);
  });

  it("throws for unknown engines", () => {
    expect(() =>
      resolveTts({ engine: "say", binary: "say", model: "v", sampleRate: 22050 }),
    ).toThrow();
  });
});
