import { describe, expect, it } from "bun:test";
import {
  DEVICE_STATES,
  encodeDeviceMessage,
  encodeServerMessage,
  isDeviceState,
  parseDeviceMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
} from "../src/protocol";

describe("parseDeviceMessage", () => {
  it("parses hello with required and optional fields", () => {
    expect(parseDeviceMessage('{"type":"hello","deviceId":"abc","protocol":1}')).toEqual({
      type: "hello",
      deviceId: "abc",
      protocol: 1,
    });
    expect(
      parseDeviceMessage('{"type":"hello","deviceId":"abc","protocol":1,"firmware":"0.1.0"}'),
    ).toEqual({ type: "hello", deviceId: "abc", protocol: 1, firmware: "0.1.0" });
  });

  it("parses bare control frames", () => {
    expect(parseDeviceMessage('{"type":"ptt_down"}')).toEqual({ type: "ptt_down" });
    expect(parseDeviceMessage('{"type":"ptt_up"}')).toEqual({ type: "ptt_up" });
    expect(parseDeviceMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("parses telemetry, keeping only well-typed fields", () => {
    expect(
      parseDeviceMessage('{"type":"telemetry","battery":80,"charging":true,"rssi":-50}'),
    ).toEqual({ type: "telemetry", battery: 80, charging: true, rssi: -50 });
    // Wrong-typed fields are dropped, not fatal.
    expect(parseDeviceMessage('{"type":"telemetry","battery":"high"}')).toEqual({
      type: "telemetry",
    });
  });

  it("rejects malformed input", () => {
    expect(() => parseDeviceMessage("not json")).toThrow(ProtocolError);
    expect(() => parseDeviceMessage("[]")).toThrow(ProtocolError);
    expect(() => parseDeviceMessage('"a string"')).toThrow(ProtocolError);
    expect(() => parseDeviceMessage("{}")).toThrow(ProtocolError);
    expect(() => parseDeviceMessage('{"type":"nope"}')).toThrow(ProtocolError);
    expect(() => parseDeviceMessage('{"type":"hello","protocol":1}')).toThrow(ProtocolError);
    expect(() => parseDeviceMessage('{"type":"hello","deviceId":"a"}')).toThrow(ProtocolError);
  });
});

describe("server messages", () => {
  it("round-trips through encode + parse", () => {
    const msg = { type: "state", state: "listening" } as const;
    expect(parseServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it("rejects unknown server types", () => {
    expect(() => parseServerMessage('{"type":"bogus"}')).toThrow(ProtocolError);
  });
});

describe("helpers", () => {
  it("encodeDeviceMessage round-trips", () => {
    const msg = { type: "telemetry", battery: 42 } as const;
    expect(parseDeviceMessage(encodeDeviceMessage(msg))).toEqual(msg);
  });

  it("isDeviceState narrows known states", () => {
    expect(isDeviceState("idle")).toBe(true);
    expect(isDeviceState("nope")).toBe(false);
    expect(DEVICE_STATES).toContain("speaking");
  });

  it("exposes the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
