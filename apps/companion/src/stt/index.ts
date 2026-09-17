/**
 * Resolve an `SttConfig` to a `SpeechToText`. The switch mirrors
 * `resolveLanguageModel` in core: add a backend by adding a `case`. Only
 * whisper.cpp is implemented today.
 */

import type { SttConfig } from "../config";
import type { SpeechToText } from "../ports";
import { WhisperStt } from "./whisper";

export function resolveStt(config: SttConfig): SpeechToText {
  switch (config.engine) {
    case "whisper":
    case "whisper-cpp":
      return new WhisperStt({
        binary: config.binary,
        model: config.model,
        ...(config.language ? { language: config.language } : {}),
      });
    default:
      throw new Error(`Unknown STT engine "${config.engine}". Known: whisper-cpp.`);
  }
}

export { WhisperStt, bunWhisperEngine, pcmToWav } from "./whisper";
export type { WhisperConfig, WhisperEngine } from "./whisper";
