/**
 * Bridge configuration, loaded from the environment with sane defaults.
 *
 * Mirrors the env grammar already established in `.env.example` (the
 * `ALFRED_*` namespace) and reuses the `"<provider>/<model>"` /
 * `"<backend>/<database>"` id conventions from `@alfred/core`. Pure: takes the
 * env record as an argument so it is fully unit-testable.
 */

type Env = Record<string, string | undefined>;

export interface SttConfig {
  /** Only "whisper-cpp" is implemented today; see `stt/index.ts`. */
  engine: string;
  /** Executable name or path, e.g. "whisper-cli". */
  binary: string;
  /** Path to the ggml model, e.g. "models/ggml-base.en.bin". */
  model: string;
  language?: string;
}

export interface TtsConfig {
  /** Only "piper" is implemented today; see `tts/index.ts`. */
  engine: string;
  binary: string;
  /** Path to the Piper voice model (.onnx). A British voice fits Alfred. */
  model: string;
  /** Output PCM sample rate the voice model produces. */
  sampleRate: number;
}

export interface MemoryConfig {
  /** "<backend>/<database>", e.g. "neo4j/neo4j". */
  storeId: string;
  /** bolt:// only — never neo4j:// (Bun routing bug). */
  uri: string;
  username: string;
  password: string;
  /** "<provider>/<model>" for the embedder. */
  embeddingModel: string;
  /** MUST equal the embedding model's output width. */
  dimensions: number;
}

export interface CompanionConfig {
  hostname: string;
  port: number;
  /** "<provider>/<model>" for the Assistant. */
  model: string;
  stt: SttConfig;
  tts: TtsConfig;
  /** Present only when Neo4j is configured; absent => stateless (Tier 0). */
  memory?: MemoryConfig;
}

function intFromEnv(
  env: Env,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  // Strict: reject "1e3", "0x10", floats, whitespace — Number() would coerce them.
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid integer for ${key}: "${raw}".`);
  }
  const value = Number(trimmed);
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${key} must be >= ${bounds.min}, got ${value}.`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${key} must be <= ${bounds.max}, got ${value}.`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): CompanionConfig {
  const port = intFromEnv(env, "ALFRED_COMPANION_PORT", 9191, { min: 0, max: 65535 });

  const config: CompanionConfig = {
    hostname: env["ALFRED_COMPANION_HOST"] ?? "0.0.0.0",
    port,
    model: env["ALFRED_COMPANION_MODEL"] ?? "anthropic/claude-opus-4-8",
    stt: {
      engine: env["ALFRED_STT_ENGINE"] ?? "whisper-cpp",
      binary: env["ALFRED_STT_BINARY"] ?? "whisper-cli",
      model: env["ALFRED_STT_MODEL"] ?? "models/ggml-base.en.bin",
      ...(env["ALFRED_STT_LANGUAGE"] ? { language: env["ALFRED_STT_LANGUAGE"] } : {}),
    },
    tts: {
      engine: env["ALFRED_TTS_ENGINE"] ?? "piper",
      binary: env["ALFRED_TTS_BINARY"] ?? "piper",
      model: env["ALFRED_TTS_MODEL"] ?? "voices/en_GB-alan-medium.onnx",
      sampleRate: intFromEnv(env, "ALFRED_TTS_SAMPLE_RATE", 22050, { min: 1 }),
    },
  };

  // Memory is opt-in: only wire it when a Neo4j endpoint is configured.
  const uri = env["ALFRED_NEO4J_URI"];
  if (uri) {
    config.memory = {
      storeId: `neo4j/${env["ALFRED_NEO4J_DATABASE"] ?? "neo4j"}`,
      uri,
      username: env["ALFRED_NEO4J_USER"] ?? "neo4j",
      password: env["ALFRED_NEO4J_PASSWORD"] ?? "",
      embeddingModel: env["ALFRED_EMBEDDING_MODEL"] ?? "local/nomic-embed-text",
      dimensions: intFromEnv(env, "ALFRED_EMBEDDING_DIMENSIONS", 768, { min: 1 }),
    };
  }

  return config;
}
