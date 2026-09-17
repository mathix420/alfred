import { afterEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPocketConfig } from "../src/config";
import { MatrixVoiceService, type MatrixTransport, type MatrixWorkerEvent } from "../src/matrix";
import { createPocketServer, type PocketApplication } from "../src/server";

class FakeTransport implements MatrixTransport {
  receive: (event: MatrixWorkerEvent) => void = () => {};
  sent: { id: string; path: string; durationMs: number }[] = [];
  start(receive: (event: MatrixWorkerEvent) => void) {
    this.receive = receive;
  }
  submit(job: { id: string; path: string; durationMs: number }) {
    this.sent.push(job);
  }
  async stop() {}
}
const directories: string[] = [];
const services: MatrixVoiceService[] = [];
const apps: PocketApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const service of services.splice(0)) await service.stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pocket-matrix-"));
  directories.push(path);
  return path;
}
function config() {
  const value = loadPocketConfig({
    ALFRED_MATRIX_ENABLED: "true",
    ALFRED_DEVICE_TOKEN: "test-device-secret",
  });
  return { ...value, port: 0, dataFile: null };
}
const base = (app: PocketApplication) => `http://127.0.0.1:${app.server.port}`;
const headers = {
  Authorization: "Bearer test-device-secret",
  "X-Device-Id": "device-a",
  "Idempotency-Key": "recording-a",
  "Content-Type": "application/octet-stream",
};

it("durably deduplicates recordings, isolates devices, and resumes the same job after restart", async () => {
  const path = await directory();
  const transport = new FakeTransport();
  const service = new MatrixVoiceService(path, transport);
  await service.start();
  const audio = new Uint8Array([0, 1, 2, 3]);
  const job = await service.submit("device-a", "request-a", audio);
  expect(job.state).toBe("queued");
  expect(transport.sent).toHaveLength(0);
  expect((await service.submit("device-a", "request-a", audio)).id).toBe(job.id);
  await expect(service.submit("device-a", "request-a", new Uint8Array([4, 5]))).rejects.toThrow(
    "another recording",
  );
  expect(service.get(job.id, "device-b")).toBeNull();
  transport.receive({ type: "ready" });
  expect(transport.sent).toHaveLength(1);
  transport.receive({ type: "retry", jobId: job.id, code: "matrix_delivery_retry" });
  expect(service.get(job.id)?.state).toBe("queued");
  await service.stop();

  const nextTransport = new FakeTransport();
  const next = new MatrixVoiceService(path, nextTransport);
  services.push(next);
  await next.start();
  nextTransport.receive({ type: "ready" });
  expect(nextTransport.sent.map((item) => item.id)).toEqual([job.id]);
  nextTransport.receive({ type: "sent", jobId: job.id, eventId: "$event" });
  const reply = next.waitForReply(job.id, AbortSignal.timeout(2000));
  nextTransport.receive({ type: "reply", jobId: job.id, eventId: "$reply", text: "Your reply" });
  expect(await reply).toBe("Your reply");
  expect(next.get(job.id)?.state).toBe("replied");
  expect((await next.submit("device-a", "request-a", audio)).id).toBe(job.id);
  expect(nextTransport.sent).toHaveLength(1);
});

it("aborting the device wait preserves the queued message and accepts its later reply", async () => {
  const transport = new FakeTransport();
  const service = new MatrixVoiceService(await directory(), transport);
  services.push(service);
  await service.start();
  const job = await service.submit("device-a", "request-a", new Uint8Array([0, 0]));
  const controller = new AbortController();
  const wait = service.waitForReply(job.id, controller.signal);
  controller.abort();
  await expect(wait).rejects.toThrow("remains available");
  expect(service.get(job.id)?.state).toBe("queued");
  transport.receive({
    type: "reply",
    jobId: job.id,
    eventId: "$reply",
    text: "Recovered response",
  });
  transport.receive({ type: "sent", jobId: job.id, eventId: "$sent" });
  expect(service.get(job.id)).toMatchObject({
    state: "replied",
    matrixEventId: "$sent",
    reply: "Recovered response",
  });
});

it("authenticates reads and async uploads and never exposes private worker configuration", async () => {
  const transport = new FakeTransport();
  const matrix = new MatrixVoiceService(await directory(), transport);
  const app = await createPocketServer(config(), { matrix, poll: false });
  apps.push(app);
  expect((await fetch(`${base(app)}/healthz`)).status).toBe(200);
  expect((await fetch(`${base(app)}/api/focus`)).status).toBe(401);
  expect(
    (await fetch(`${base(app)}/api/status`, { headers: { Authorization: "Bearer wrong" } })).status,
  ).toBe(401);
  expect(
    (await fetch(`${base(app)}/`, { headers: { Origin: "https://elsewhere.example" } })).status,
  ).toBe(200);
  const posted = await fetch(`${base(app)}/device/voice`, {
    method: "POST",
    headers,
    body: new Uint8Array([0, 0, 1, 1]),
  });
  expect(posted.status).toBe(202);
  const response = await posted.json();
  expect(response.job.state).toBe("queued");
  const repeated = await fetch(`${base(app)}/device/voice`, {
    method: "POST",
    headers,
    body: new Uint8Array([0, 0, 1, 1]),
  });
  expect((await repeated.json()).job.id).toBe(response.job.id);
  expect(
    (
      await fetch(`${base(app)}${response.statusUrl}`, {
        headers: { ...headers, "X-Device-Id": "device-b" },
      })
    ).status,
  ).toBe(404);
  expect((await fetch(`${base(app)}${response.statusUrl}`, { headers })).status).toBe(200);
  transport.receive({ type: "identity", deviceId: "MATRIX_DEVICE", ed25519: "a".repeat(43) });
  const status = await (await fetch(`${base(app)}/api/status`, { headers })).json();
  expect(status.matrix.identity.deviceId).toBe("MATRIX_DEVICE");
  expect(JSON.stringify(status)).not.toContain("test-device-secret");
  expect(JSON.stringify(status)).not.toContain("accessToken");
  expect(
    (
      await fetch(`${base(app)}/device/voice`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: new Uint8Array([0, 0]),
      })
    ).status,
  ).toBe(403);
});

it("fails closed for configured live backends without a device token", async () => {
  for (const env of [
    { ALFRED_MATRIX_ENABLED: "true" },
    { ALFRED_TODOMATE_API_URL: "https://tasks.example", TODOMATE_MCP_ACCESS_TOKEN: "secret" },
    { ALFRED_HERMES_BASE_URL: "https://hermes.example", ALFRED_HERMES_API_KEY: "secret" },
  ]) {
    const app = await createPocketServer(
      { ...loadPocketConfig(env), port: 0, dataFile: null },
      { poll: false },
    );
    apps.push(app);
    expect((await fetch(`${base(app)}/api/focus`)).status).toBe(503);
    expect((await fetch(`${base(app)}/healthz`)).status).toBe(200);
  }
});

it("accepts the explicitly configured reverse-proxy origin and rejects others", async () => {
  const app = await createPocketServer(
    {
      ...loadPocketConfig({
        ALFRED_POCKET_PUBLIC_ORIGIN: "https://pocket.example",
        ALFRED_DEVICE_TOKEN: "test-device-secret",
      }),
      port: 0,
      dataFile: null,
    },
    { poll: false },
  );
  apps.push(app);
  const body = JSON.stringify({ requestId: "completion-a" });
  expect(
    (
      await fetch(`${base(app)}/api/tasks/investor-demo/complete`, {
        method: "POST",
        headers: { ...headers, Origin: "https://pocket.example" },
        body,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${base(app)}/api/tasks/walk/complete`, {
        method: "POST",
        headers: { ...headers, Origin: "https://wrong.example" },
        body,
      })
    ).status,
  ).toBe(403);
});

it("authenticates the browser hello and routes encrypted voice job replies only to the sending device", async () => {
  const transport = new FakeTransport();
  const matrix = new MatrixVoiceService(await directory(), transport);
  const app = await createPocketServer(config(), { matrix, poll: false });
  apps.push(app);
  transport.receive({ type: "ready" });
  const connect = async (deviceId: string) => {
    // Bun supports handshake headers; the app's DOM lib intentionally retains browser typings.
    const BunWebSocket = WebSocket as unknown as {
      new (url: string, options: { headers: Record<string, string> }): WebSocket;
    };
    const ws = new BunWebSocket(`${base(app).replace("http", "ws")}/ws`, {
      headers: { Origin: base(app) },
    });
    const frames: Record<string, any>[] = [];
    ws.onmessage = (event) => {
      if (typeof event.data === "string") frames.push(JSON.parse(event.data));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed"));
    });
    ws.send(JSON.stringify({ type: "hello", protocol: 2, deviceId, token: "wrong" }));
    await until(() => frames.some((frame) => frame.code === "unauthorized"));
    expect(frames.some((frame) => frame.type === "focus")).toBe(false);
    ws.send(JSON.stringify({ type: "hello", protocol: 2, deviceId, token: "test-device-secret" }));
    await until(() => frames.some((frame) => frame.type === "focus"));
    expect(frames.find((frame) => frame.type === "focus")?.snapshot).toMatchObject({
      mode: "live",
      connection: "online",
      tasks: [],
    });
    return { ws, frames };
  };
  const sender = await connect("device-a");
  const other = await connect("device-b");
  sender.ws.send(JSON.stringify({ type: "refresh" }));
  await until(() => sender.frames.filter((frame) => frame.type === "focus").length >= 2);
  expect(sender.frames.filter((frame) => frame.type === "focus").at(-1)?.snapshot.connection).toBe(
    "online",
  );
  sender.ws.send(
    JSON.stringify({ type: "ptt_down", sampleRate: 16000, channels: 1, requestId: "voice-a" }),
  );
  sender.ws.send(new Uint8Array([0, 0, 1, 1]));
  sender.ws.send(JSON.stringify({ type: "ptt_up" }));
  await until(() => transport.sent.length === 1);
  const id = transport.sent[0]!.id;
  transport.receive({ type: "sent", jobId: id, eventId: "$voice" });
  transport.receive({ type: "reply", jobId: id, eventId: "$reply", text: "Hello from Hermes" });
  await until(() => sender.frames.some((frame) => frame.type === "reply"));
  expect(sender.frames.find((frame) => frame.type === "reply")?.text).toBe("Hello from Hermes");
  transport.receive({
    type: "reply",
    jobId: id,
    eventId: "$reply-edit",
    text: "Hello from Hermes. Here is the final answer.",
  });
  await until(() =>
    sender.frames.some(
      (frame) =>
        frame.type === "reply" && frame.text === "Hello from Hermes. Here is the final answer.",
    ),
  );
  expect(sender.frames.filter((frame) => frame.type === "reply").at(-1)?.final).toBe(true);
  expect(other.frames.some((frame) => frame.type === "voice_job" || frame.type === "reply")).toBe(
    false,
  );
  sender.ws.send(JSON.stringify({ type: "cancel" }));
  sender.ws.close();
  other.ws.close();
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test transport");
    await Bun.sleep(5);
  }
}
