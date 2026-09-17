/**
 * Resolve a `TtsConfig` to a `TextToSpeech`. Only Piper is implemented today;
 * Kokoro or a cloud voice can be added as another `case`.
 */

import type { TtsConfig } from "../config";
import type { TextToSpeech } from "../ports";
import { PiperTts } from "./piper";

export function resolveTts(config: TtsConfig): TextToSpeech {
  switch (config.engine) {
    case "piper":
      return new PiperTts({
        binary: config.binary,
        model: config.model,
        sampleRate: config.sampleRate,
      });
    default:
      throw new Error(`Unknown TTS engine "${config.engine}". Known: piper.`);
  }
}

export { bunPiperEngine, PiperTts } from "./piper";
export type { PiperConfig, PiperEngine } from "./piper";
