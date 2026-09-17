import { describe, expect, it } from "bun:test";
import { resolveStt } from "../src/stt";
import { pcmToWav, WhisperStt } from "../src/stt/whisper";

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

describe("pcmToWav", () => {
  it("writes a canonical 44-byte header", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = pcmToWav(pcm, 16000, 1);
    expect(wav.byteLength).toBe(48);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");

    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(4); // data size
  });
});

describe("WhisperStt", () => {
  it("frames PCM as WAV, calls the engine, and trims output", async () => {
    let seenWav: Uint8Array | undefined;
    let seenModel: string | undefined;
    const stt = new WhisperStt({ binary: "whisper-cli", model: "m.bin" }, async (wav, opts) => {
      seenWav = wav;
      seenModel = opts.model;
      return "  hello sir \n";
    });

    const result = await stt.transcribe(new Uint8Array([0, 0, 0, 0]), {
      sampleRate: 16000,
      channels: 1,
    });

    expect(result.text).toBe("hello sir");
    expect(seenModel).toBe("m.bin");
    expect(seenWav && ascii(seenWav, 0, 4)).toBe("RIFF");
  });
});

describe("resolveStt", () => {
  it("builds a WhisperStt for whisper-cpp", () => {
    expect(resolveStt({ engine: "whisper-cpp", binary: "w", model: "m" })).toBeInstanceOf(
      WhisperStt,
    );
  });

  it("throws for unknown engines", () => {
    expect(() => resolveStt({ engine: "vosk", binary: "w", model: "m" })).toThrow();
  });
});
