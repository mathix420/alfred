/**
 * Wire protocol between the companion device (firmware) and the bridge.
 *
 * Two planes share one WebSocket:
 *   - control plane: JSON text frames, modelled here as discriminated unions.
 *   - audio plane:   binary frames. Mic audio (device→bridge) flows between a
 *     `ptt_down`/`ptt_up` pair; TTS audio (bridge→device) flows between a
 *     `tts_begin`/`tts_end` pair. Binary frames are carried by the transport,
 *     not parsed here.
 *
 * Pure and dependency-free — the protocol analogue of `models/registry.ts`, and
 * the most heavily unit-tested piece. The firmware re-implements the same
 * grammar in C; keep the two in lockstep and bump `PROTOCOL_VERSION` on change.
 */

export const PROTOCOL_VERSION = 1;

/** The four visual states the device renders (see SCOPE.md §6). */
export type DeviceState = "idle" | "listening" | "thinking" | "speaking";

export const DEVICE_STATES: readonly DeviceState[] = ["idle", "listening", "thinking", "speaking"];

export interface AudioFormat {
  encoding: "pcm_s16le" | "opus";
  /** Hz, e.g. 16000 for mic capture, 22050 for Piper output. */
  sampleRate: number;
  channels: number;
}

export interface ReminderItem {
  id: string;
  text: string;
  /** epoch ms */
  dueAt: number;
}

/** Glanceable home-face payload. The device RTC owns the clock when offline. */
export interface AmbientFace {
  /** epoch ms the bridge believes it is, for clock sync. */
  now: number;
  nextReminder?: ReminderItem;
  /** 0..100 */
  battery?: number;
  charging?: boolean;
}

/* ----------------------------- device → bridge ---------------------------- */

export type DeviceMessage =
  | { type: "hello"; deviceId: string; protocol: number; firmware?: string }
  | { type: "ptt_down" }
  | { type: "ptt_up" }
  | { type: "telemetry"; battery?: number; charging?: boolean; rssi?: number }
  | { type: "ping" };

export type DeviceMessageType = DeviceMessage["type"];

/* ----------------------------- bridge → device ---------------------------- */

export type ServerMessage =
  | { type: "welcome"; sessionId: string; protocol: number }
  | { type: "state"; state: DeviceState }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "reply"; text: string; final: boolean }
  | { type: "tts_begin"; format: AudioFormat }
  | { type: "tts_end" }
  | { type: "reminders"; items: ReminderItem[] }
  | { type: "ambient"; face: AmbientFace }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export type ServerMessageType = ServerMessage["type"];

/**
 * A bridge→device frame whose envelope (`type`) is validated but whose variant
 * fields are NOT. Shallow by design: server frames originate from the trusted
 * bridge, so `parseServerMessage` earns only the `type`; callers must narrow on
 * `type` before touching variant fields.
 */
export type ParsedServerFrame = { type: ServerMessageType } & Record<string, unknown>;

const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set<ServerMessageType>([
  "welcome",
  "state",
  "transcript",
  "reply",
  "tts_begin",
  "tts_end",
  "reminders",
  "ambient",
  "error",
  "pong",
]);

/** Thrown when an inbound frame violates the protocol. Catch at the transport. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function isDeviceState(value: unknown): value is DeviceState {
  return typeof value === "string" && (DEVICE_STATES as readonly string[]).includes(value);
}

function asObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError(`${label} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Parse + validate a device→bridge frame. Throws `ProtocolError` on anything off. */
export function parseDeviceMessage(raw: string): DeviceMessage {
  const msg = asObject(raw, "device message");
  const type = msg["type"];
  if (typeof type !== "string") {
    throw new ProtocolError('device message is missing a string "type"');
  }

  switch (type) {
    case "hello": {
      const deviceId = msg["deviceId"];
      const protocol = msg["protocol"];
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        throw new ProtocolError('"hello" requires a non-empty string "deviceId"');
      }
      if (typeof protocol !== "number" || !Number.isFinite(protocol)) {
        throw new ProtocolError('"hello" requires a numeric "protocol"');
      }
      const firmware = msg["firmware"];
      return {
        type,
        deviceId,
        protocol,
        ...(typeof firmware === "string" ? { firmware } : {}),
      };
    }
    case "ptt_down":
    case "ptt_up":
    case "ping":
      return { type };
    case "telemetry": {
      const out: Extract<DeviceMessage, { type: "telemetry" }> = { type };
      const battery = msg["battery"];
      if (typeof battery === "number") out.battery = battery;
      const charging = msg["charging"];
      if (typeof charging === "boolean") out.charging = charging;
      const rssi = msg["rssi"];
      if (typeof rssi === "number") out.rssi = rssi;
      return out;
    }
    default:
      throw new ProtocolError(`unknown device message type "${type}"`);
  }
}

export function encodeDeviceMessage(message: DeviceMessage): string {
  return JSON.stringify(message);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Shallow-parse a bridge→device frame: validate the envelope (object + known
 * `type`) but not per-variant fields. Returns a `ParsedServerFrame`, not a
 * `ServerMessage`, so the type does not over-promise; it exists so a TS client
 * (tests, tooling) can read the stream and narrow on `type` itself.
 */
export function parseServerMessage(raw: string): ParsedServerFrame {
  const msg = asObject(raw, "server message");
  const type = msg["type"];
  if (typeof type !== "string" || !SERVER_MESSAGE_TYPES.has(type)) {
    throw new ProtocolError(`unknown server message type "${String(type)}"`);
  }
  return { ...msg, type: type as ServerMessageType };
}
