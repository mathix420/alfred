import { resolve } from "node:path";

export interface MatrixConfig {
  enabled: boolean;
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  hermesUserId: string;
  roomId: string;
  pickleKey: string;
  trustedDevices: string;
  storeDirectory: string;
  voiceDirectory: string;
  python: string;
  replyTimeoutMs: number;
}

export interface PocketConfig {
  deviceToken: string;
  publicOrigin: string;
  todomateBaseUrl: string;
  todomateAccessToken: string;
  matrix: MatrixConfig;
  hostname: string;
  port: number;
  hermesBaseUrl: string;
  hermesApiKey: string;
  hermesModel: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  dataFile: string | null;
  webDirectory: string;
  sttModel: string;
  sttBinary: string;
  sttLanguage: string;
  ttsModel: string;
  ttsBinary: string;
  ttsSampleRate: number;
}

type Env = Record<string, string | undefined>;
const pocketDirectory = resolve(import.meta.dir, "..");

export function loadPocketConfig(env: Env = process.env): PocketConfig {
  const hermesBaseUrl = (env.ALFRED_HERMES_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (hermesBaseUrl) {
    const url = new URL(hermesBaseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "ALFRED_HERMES_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.",
      );
    }
  }
  const todomateBaseUrl = (env.ALFRED_TODOMATE_API_URL ?? "").trim().replace(/\/+$/, "");
  if (todomateBaseUrl) {
    const parsed = new URL(todomateBaseUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        "ALFRED_TODOMATE_API_URL must be an HTTP(S) URL without credentials, query, or fragment.",
      );
  }
  const publicOrigin = (env.ALFRED_POCKET_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (
    publicOrigin &&
    (!/^https?:$/.test(new URL(publicOrigin).protocol) ||
      new URL(publicOrigin).origin !== publicOrigin)
  )
    throw new Error("ALFRED_POCKET_PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
  const matrixHomeserver = (env.ALFRED_MATRIX_HOMESERVER ?? "").trim().replace(/\/+$/, "");
  if (matrixHomeserver) {
    const parsed = new URL(matrixHomeserver);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        "ALFRED_MATRIX_HOMESERVER must be an HTTPS URL without credentials, query, or fragment.",
      );
    }
  }
  return {
    publicOrigin,
    todomateBaseUrl,
    todomateAccessToken: (env.TODOMATE_MCP_ACCESS_TOKEN ?? "").trim(),
    deviceToken: (env.ALFRED_DEVICE_TOKEN ?? "").trim(),
    matrix: {
      enabled: env.ALFRED_MATRIX_ENABLED === "true",
      homeserver: matrixHomeserver,
      userId: (env.ALFRED_MATRIX_USER_ID ?? "").trim(),
      accessToken: (env.ALFRED_MATRIX_ACCESS_TOKEN ?? "").trim(),
      deviceId: (env.ALFRED_MATRIX_DEVICE_ID ?? "").trim(),
      hermesUserId: (env.ALFRED_MATRIX_HERMES_USER_ID ?? "").trim(),
      roomId: (env.ALFRED_MATRIX_ROOM_ID ?? "").trim(),
      pickleKey: env.ALFRED_MATRIX_PICKLE_KEY ?? "",
      trustedDevices: (env.ALFRED_MATRIX_TRUSTED_DEVICES ?? "").trim(),
      storeDirectory: resolve(env.ALFRED_MATRIX_STORE_DIR || `${pocketDirectory}/.data/matrix`),
      voiceDirectory: resolve(env.ALFRED_POCKET_VOICE_DIR || `${pocketDirectory}/.data/voice`),
      python: env.ALFRED_MATRIX_PYTHON?.trim() || "python3",
      replyTimeoutMs: integer(env, "ALFRED_MATRIX_REPLY_TIMEOUT_MS", 180000, 1000, 900000),
    },
    hostname: env.ALFRED_POCKET_HOST?.trim() || "127.0.0.1",
    port: integer(env, "ALFRED_POCKET_PORT", 9191, 0, 65535),
    hermesBaseUrl,
    hermesApiKey: (env.ALFRED_HERMES_API_KEY ?? "").trim(),
    hermesModel: env.ALFRED_HERMES_MODEL?.trim() || "hermes-agent",
    requestTimeoutMs: integer(env, "ALFRED_HERMES_TIMEOUT_MS", 60000, 100, 180000),
    pollIntervalMs: integer(env, "ALFRED_POCKET_POLL_MS", 60000, 1000, 3600000),
    dataFile:
      env.ALFRED_POCKET_DATA_FILE === ""
        ? null
        : resolve(env.ALFRED_POCKET_DATA_FILE ?? `${pocketDirectory}/.data/tasks.json`),
    webDirectory: resolve(pocketDirectory, "web"),
    sttModel: env.ALFRED_STT_MODEL?.trim() || "",
    sttBinary: env.ALFRED_STT_BINARY?.trim() || "whisper-cli",
    sttLanguage: env.ALFRED_STT_LANGUAGE?.trim() || "",
    ttsModel: env.ALFRED_TTS_MODEL?.trim() || "",
    ttsBinary: env.ALFRED_TTS_BINARY?.trim() || "piper",
    ttsSampleRate: integer(env, "ALFRED_TTS_SAMPLE_RATE", 22050, 8000, 48000),
  };
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${key} is out of range.`);
  return number;
}

export function isLive(config: PocketConfig): boolean {
  return Boolean(config.hermesBaseUrl && config.hermesApiKey);
}

export function matrixConfigured(config: MatrixConfig): boolean {
  return (
    config.enabled &&
    Boolean(
      config.homeserver &&
      config.userId &&
      config.accessToken &&
      config.deviceId &&
      config.hermesUserId &&
      config.roomId &&
      config.pickleKey &&
      config.trustedDevices,
    ) &&
    config.userId !== config.hermesUserId
  );
}
