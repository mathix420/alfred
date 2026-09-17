/**
 * Local speech-to-text via whisper.cpp (`whisper-cli`). The actual subprocess
 * call is isolated behind an injectable `WhisperEngine` so the testable logic —
 * PCM→WAV framing, argv construction, output trimming — is exercised without a
 * binary present. Mirrors the lazy/swappable spirit of `@alfred/core`'s
 * resolvers; Kokoro/faster-whisper can slot in as alternative engines later.
 */

import { unlink } from "node:fs/promises";
import type { SpeechToText, TranscribeOptions, TranscriptResult } from "../ports";

export type WhisperEngine = (
  wav: Uint8Array,
  opts: { model: string; language?: string; signal?: AbortSignal },
) => Promise<string>;

export interface WhisperConfig {
  binary: string;
  model: string;
  language?: string;
}

/** Wrap raw little-endian 16-bit PCM in a canonical 44-byte WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(buffer);
  out.set(pcm, 44);
  return out;
}

/** The default engine: spawn whisper.cpp over a temp WAV file and read stdout. */
export function bunWhisperEngine(binary: string): WhisperEngine {
  return async (wav, { model, language, signal }) => {
    const path = `/tmp/alfred-stt-${crypto.randomUUID()}.wav`;
    await Bun.write(path, wav);
    try {
      const args = [binary, "-m", model, "-f", path, "-nt"];
      if (language) args.push("-l", language);
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`${binary} exited ${exitCode}: ${stderr.trim()}`);
      }
      // Exit 0 with no transcript usually means a misconfigured model or audio
      // below the VAD threshold. Surface stderr so it is not silently read as
      // "you said nothing" by the empty-transcript short-circuit upstream.
      if (stdout.trim().length === 0) {
        const stderr = await new Response(proc.stderr).text();
        if (stderr.trim().length > 0) {
          console.warn(
            `[companion:stt] ${binary} produced no transcript; stderr: ${stderr.trim()}`,
          );
        }
      }
      return stdout;
    } finally {
      await unlink(path).catch(() => undefined);
    }
  };
}

export class WhisperStt implements SpeechToText {
  private readonly engine: WhisperEngine;

  constructor(
    private readonly config: WhisperConfig,
    engine?: WhisperEngine,
  ) {
    this.engine = engine ?? bunWhisperEngine(config.binary);
  }

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscriptResult> {
    const wav = pcmToWav(audio, opts.sampleRate, opts.channels);
    const language = opts.language ?? this.config.language;
    const raw = await this.engine(wav, {
      model: this.config.model,
      ...(language ? { language } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { text: raw.trim() };
  }
}
