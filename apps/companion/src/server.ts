/**
 * The transport: a Bun WebSocket server that gives each device connection a
 * `Session` and shuttles frames between the wire and that session. This is the
 * only "surface" concern (I/O + transport); all behaviour lives in the session
 * and in `@alfred/core`. Dependencies are injectable via `overrides` so the
 * server is integration-testable without providers, a Neo4j, or audio binaries.
 */

import type { Server, ServerWebSocket } from "bun";
import { Assistant } from "@alfred/core";
import type { CompanionConfig } from "./config";
import { ALFRED_PERSONA } from "./persona";
import type { AssistantLike, MemoryLike, SpeechToText, TextToSpeech } from "./ports";
import {
  encodeServerMessage,
  parseDeviceMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  type ServerMessage,
} from "./protocol";
import { ReminderService } from "./reminders";
import { Session } from "./session";
import { resolveStt } from "./stt";
import { resolveTts } from "./tts";

export interface ServerOverrides {
  assistant?: AssistantLike;
  stt?: SpeechToText;
  tts?: TextToSpeech;
  /** A store to use, or `null` to explicitly disable memory. */
  memory?: MemoryLike | null;
}

interface ConnectionData {
  session: Session | null;
  deviceId: string | null;
  helloReceived: boolean;
  /** Resolvers awaiting an outbound-buffer drain (backpressure). */
  drainWaiters: Array<() => void>;
}

// Mic/control frames are small; cap per-frame size and the outbound buffer so a
// hostile or wedged device cannot exhaust memory. Combined with drain-aware
// sending, audio is paced; a device past the hard limit is dropped (detectable).
const MAX_PAYLOAD_BYTES = 1 << 20; // 1 MiB
const BACKPRESSURE_LIMIT_BYTES = 8 << 20; // 8 MiB
const IDLE_TIMEOUT_SECONDS = 120;

let sessionCounter = 0;

export async function createCompanionServer(
  config: CompanionConfig,
  overrides: ServerOverrides = {},
): Promise<Server<ConnectionData>> {
  const assistant: AssistantLike =
    overrides.assistant ?? new Assistant({ model: config.model, system: ALFRED_PERSONA });
  const stt = overrides.stt ?? resolveStt(config.stt);
  const tts = overrides.tts ?? resolveTts(config.tts);
  const memory = await resolveMemory(config, overrides);

  const makeSession = (ws: ServerWebSocket<ConnectionData>): Session =>
    new Session({
      assistant,
      stt,
      tts,
      ...(memory ? { memory } : {}),
      reminders: new ReminderService(),
      send: (message) => send(ws, message),
      sendAudio: (chunk) => {
        let result: number;
        try {
          result = ws.send(chunk);
        } catch (error) {
          console.error("[companion] audio send failed", error);
          return undefined;
        }
        // -1 = enqueued under backpressure: pause until the socket drains.
        if (result === -1) {
          return new Promise<void>((resolve) => ws.data.drainWaiters.push(resolve));
        }
        return undefined;
      },
      micFormat: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    });

  return Bun.serve<ConnectionData>({
    hostname: config.hostname,
    port: config.port,
    fetch(req, server) {
      const data: ConnectionData = {
        session: null,
        deviceId: null,
        helloReceived: false,
        drainWaiters: [],
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("Alfred companion bridge — connect via WebSocket.", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      idleTimeout: IDLE_TIMEOUT_SECONDS,
      open(ws) {
        ws.data.session = makeSession(ws);
      },
      message(ws, message) {
        const session = ws.data.session;
        if (!session) return;
        if (typeof message !== "string") {
          // Binary = mic audio; honour only after a successful handshake.
          if (ws.data.helloReceived) session.pushAudio(new Uint8Array(message));
          return;
        }
        handleControl(ws, session, message).catch((error: unknown) => {
          // Log the real fault server-side; never leak raw error text to the device.
          console.error("[companion] unhandled control error", error);
          send(ws, { type: "error", code: "internal", message: "internal error" });
        });
      },
      drain(ws) {
        const waiters = ws.data.drainWaiters;
        ws.data.drainWaiters = [];
        for (const resolve of waiters) resolve();
      },
      close(ws) {
        // Release any send paused on drain, then cancel the in-flight turn.
        const waiters = ws.data.drainWaiters;
        ws.data.drainWaiters = [];
        for (const resolve of waiters) resolve();
        ws.data.session?.close();
        ws.data.session = null;
      },
    },
  });
}

function send(ws: ServerWebSocket<ConnectionData>, message: ServerMessage): void {
  try {
    ws.send(encodeServerMessage(message));
  } catch (error) {
    console.error("[companion] send failed", error);
  }
}

/** Reject a frame that arrived before a successful hello handshake. */
function requireHello(ws: ServerWebSocket<ConnectionData>): boolean {
  if (ws.data.helloReceived) return true;
  send(ws, { type: "error", code: "handshake_required", message: "send hello first" });
  return false;
}

async function handleControl(
  ws: ServerWebSocket<ConnectionData>,
  session: Session,
  raw: string,
): Promise<void> {
  let message;
  try {
    message = parseDeviceMessage(raw);
  } catch (error) {
    if (error instanceof ProtocolError) {
      send(ws, { type: "error", code: "protocol", message: error.message });
      return;
    }
    throw error;
  }

  switch (message.type) {
    case "hello": {
      if (message.protocol !== PROTOCOL_VERSION) {
        console.warn(
          `[companion] device ${message.deviceId} speaks protocol ${message.protocol}, ` +
            `bridge speaks ${PROTOCOL_VERSION}`,
        );
        send(ws, {
          type: "error",
          code: "protocol_version",
          message: `unsupported protocol version ${message.protocol}; bridge requires ${PROTOCOL_VERSION}`,
        });
        return;
      }
      ws.data.deviceId = message.deviceId;
      ws.data.helloReceived = true;
      send(ws, { type: "welcome", sessionId: `s${++sessionCounter}`, protocol: PROTOCOL_VERSION });
      session.syncDevice(); // push initial reminders + ambient face
      return;
    }
    case "ping":
      send(ws, { type: "pong" });
      return;
    case "ptt_down":
      if (requireHello(ws)) session.pttDown();
      return;
    case "ptt_up":
      if (requireHello(ws)) await session.pttUp();
      return;
    case "telemetry":
      if (!ws.data.helloReceived) return;
      session.applyTelemetry({
        ...(message.battery !== undefined ? { battery: message.battery } : {}),
        ...(message.charging !== undefined ? { charging: message.charging } : {}),
      });
      return;
  }
}

/**
 * Resolve memory: an explicit override wins (a store, or `null` to disable);
 * otherwise build from config. Config/validation errors (bad store id, module
 * resolution) fail startup loudly — only a live connection failure degrades to
 * no memory, since Tier 0 is allowed to run brainless.
 */
async function resolveMemory(
  config: CompanionConfig,
  overrides: ServerOverrides,
): Promise<MemoryLike | undefined> {
  if (overrides.memory !== undefined) return overrides.memory ?? undefined;
  if (!config.memory) return undefined;

  const m = config.memory;
  const { memoryStoreConfig, resolveMemoryStore } = await import("@alfred/core/memory");
  // Validates the store id; a bad config throws here and is NOT swallowed.
  const storeConfig = memoryStoreConfig(m.storeId, {
    uri: m.uri,
    username: m.username,
    password: m.password,
    embeddingModel: m.embeddingModel,
    dimensions: m.dimensions,
  });

  try {
    return await resolveMemoryStore(storeConfig);
  } catch (error) {
    console.error("[companion:memory] could not connect; running without memory.", error);
    return undefined;
  }
}
