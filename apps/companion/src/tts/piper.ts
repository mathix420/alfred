/**
 * Local text-to-speech via Piper. Piper reads text on stdin and writes raw
 * little-endian 16-bit PCM to stdout (`--output_raw`); we stream those chunks
 * straight onto the wire as binary frames. The subprocess is isolated behind an
 * injectable `PiperEngine` so the adapter is testable without the binary.
 */

import type { SynthesizeOptions, TextToSpeech } from "../ports";
import type { AudioFormat } from "../protocol";

export type PiperEngine = (
  text: string,
  opts: { model: string; voice?: string; signal?: AbortSignal },
) => AsyncIterable<Uint8Array>;

export interface PiperConfig {
  binary: string;
  model: string;
  /** Output PCM sample rate the voice model produces (e.g. 22050). */
  sampleRate: number;
}

/** The default engine: spawn Piper, feed text on stdin, stream PCM from stdout. */
export function bunPiperEngine(binary: string): PiperEngine {
  return async function* piper(text, { model, voice, signal }) {
    const args = [binary, "--model", model, "--output_raw"];
    if (voice) args.push("--speaker", voice);
    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", signal });
    try {
      proc.stdin.write(text);
      await proc.stdin.end();
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        yield chunk;
      }
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`${binary} exited ${exitCode}: ${stderr.trim()}`);
      }
    } finally {
      // If the consumer broke out early (supersede, disconnect, throw), the
      // child is still running — reap it so the process and its pipes are freed.
      if (proc.exitCode === null) proc.kill();
    }
  };
}

export class PiperTts implements TextToSpeech {
  readonly format: AudioFormat;
  private readonly engine: PiperEngine;

  constructor(
    private readonly config: PiperConfig,
    engine?: PiperEngine,
  ) {
    this.format = { encoding: "pcm_s16le", sampleRate: config.sampleRate, channels: 1 };
    this.engine = engine ?? bunPiperEngine(config.binary);
  }

  synthesize(text: string, opts?: SynthesizeOptions): AsyncIterable<Uint8Array> {
    return this.engine(text, {
      model: this.config.model,
      ...(opts?.voice ? { voice: opts.voice } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}
