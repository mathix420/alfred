import type { Server, ServerWebSocket } from "bun";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { matrixConfigured, type PocketConfig } from "./config";
import type { TaskAdapter } from "./types";
import { TodoMateApiAdapter } from "./todomate";
import { MatrixVoiceService, PythonMatrixTransport } from "./matrix";
import { TaskStore } from "./tasks";
import { identifier, taskTimerAction, PocketError, publicError } from "./types";

interface Connection {
  authenticated: boolean;
  deviceId: string;
  requestId: string | null;
  ready: boolean;
  turn: AbortController | null;
  audio: Uint8Array[];
  audioBytes: number;
  recording: boolean;
  captureTimer: ReturnType<typeof setTimeout> | null;
}

export interface PocketServerOverrides {
  adapter?: TaskAdapter | null;
  store?: TaskStore;
  poll?: boolean;
  matrix?: MatrixVoiceService;
}

export interface PocketApplication {
  server: Server<Connection>;
  store: TaskStore;
  stop(): Promise<void>;
}

const MAX_AUDIO_BYTES = 16000 * 2 * 30;
const MAX_CONTROL_BYTES = 8192;

export async function createPocketServer(
  config: PocketConfig,
  overrides: PocketServerOverrides = {},
): Promise<PocketApplication> {
  const adapter =
    overrides.adapter !== undefined
      ? overrides.adapter
      : config.todomateBaseUrl && config.todomateAccessToken
        ? new TodoMateApiAdapter({
            baseUrl: config.todomateBaseUrl,
            accessToken: config.todomateAccessToken,
            timeoutMs: config.requestTimeoutMs,
          })
        : null;
  const matrix =
    overrides.matrix ??
    (config.deviceToken && matrixConfigured(config.matrix)
      ? new MatrixVoiceService(
          config.matrix.voiceDirectory,
          new PythonMatrixTransport(config.matrix),
        )
      : undefined);
  if (matrix) await matrix.start();
  const store =
    overrides.store ??
    new TaskStore(
      adapter,
      config.dataFile,
      config.matrix.enabled ? "live" : adapter ? "live" : "demo",
    );
  await store.initialize();
  const mode = adapter || config.matrix.enabled ? "live" : "demo";
  const focusSnapshot = () => {
    const snapshot = store.snapshot();
    if (config.matrix.enabled && !adapter)
      return {
        ...snapshot,
        mode: "live" as const,
        connection: matrix?.status().ready ? ("online" as const) : ("offline" as const),
      };
    return snapshot;
  };
  const clients = new Set<ServerWebSocket<Connection>>();
  const shutdown = new AbortController();
  let browserBundle: Promise<string> | undefined;

  function send(ws: ServerWebSocket<Connection>, message: Record<string, unknown>): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function fail(ws: ServerWebSocket<Connection>, error: unknown, requestId?: string): void {
    const safe = publicError(error);
    send(ws, {
      type: "error",
      code: safe.code,
      message: safe.message,
      ...(requestId ? { requestId } : {}),
    });
  }

  function clearCapture(ws: ServerWebSocket<Connection>): void {
    if (ws.data.captureTimer) clearTimeout(ws.data.captureTimer);
    ws.data.captureTimer = null;
    ws.data.recording = false;
    ws.data.audio = [];
    ws.data.audioBytes = 0;
  }

  function cancel(ws: ServerWebSocket<Connection>, notify = true): void {
    ws.data.turn?.abort();
    ws.data.turn = null;
    clearCapture(ws);
    if (notify) send(ws, { type: "state", state: "idle" });
  }

  async function voice(ws: ServerWebSocket<Connection>): Promise<void> {
    if (!ws.data.recording || !ws.data.turn) return;
    const controller = ws.data.turn;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(config.requestTimeoutMs),
    ]);
    const chunks = ws.data.audio;
    const bytes = ws.data.audioBytes;
    clearCapture(ws);
    const current = () =>
      ws.data.turn === controller && !controller.signal.aborted && ws.readyState === 1;
    try {
      send(ws, { type: "state", state: "thinking" });
      if (config.matrix.enabled) {
        if (!matrix)
          throw new PocketError("matrix_unconfigured", "Matrix voice is not configured yet.", 503);
        if (!bytes)
          throw new PocketError("empty_audio", "No audio was captured. Please try again.");
        const audio = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          audio.set(chunk, offset);
          offset += chunk.length;
        }
        const job = await matrix.submit(
          ws.data.deviceId,
          ws.data.requestId ?? crypto.randomUUID(),
          audio,
        );
        send(ws, { type: "voice_job", job });
        await matrix.waitForSent(job.id, signal);
      } else if (mode === "demo") {
        await pause(700, signal);
      } else {
        throw new PocketError(
          "voice_unconfigured",
          "Connect Matrix to send voice messages to Hermes.",
          503,
        );
      }
      if (!current()) return;
      send(ws, { type: "state", state: "sent" });
      await pause(1000, controller.signal);
    } catch (error) {
      if (current())
        fail(
          ws,
          signal.aborted
            ? new PocketError(
                "timeout",
                "Still waiting for delivery. Check the recording status before sending it again.",
                504,
              )
            : error,
        );
    } finally {
      if (current()) {
        send(ws, { type: "state", state: "idle" });
        ws.data.turn = null;
      }
    }
  }

  async function control(ws: ServerWebSocket<Connection>, raw: string): Promise<void> {
    let requestId: string | undefined;
    try {
      if (raw.length > MAX_CONTROL_BYTES)
        throw new PocketError("invalid_request", "Message is too large.");
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        message = parsed as Record<string, unknown>;
      } catch {
        throw new PocketError("invalid_request", "Message must be a JSON object.");
      }
      requestId = identifier(message.requestId) ? message.requestId : undefined;
      if (message.type === "hello") {
        if (!ws.data.authenticated) {
          if (!tokenMatches(message.token, config.deviceToken))
            throw new PocketError("unauthorized", "A valid device token is required.", 401);
          ws.data.authenticated = true;
        }
        if (message.protocol !== 2 || !identifier(message.deviceId))
          throw new PocketError("protocol_version", "Use pocket protocol 2 and a valid device ID.");
        ws.data.ready = true;
        ws.data.deviceId = message.deviceId;
        send(ws, { type: "hello", protocol: 2, mode, sessionId: crypto.randomUUID() });
        send(ws, { type: "focus", snapshot: focusSnapshot() });
        for (const job of matrix?.list(ws.data.deviceId) ?? [])
          send(ws, { type: "voice_job", job });
        return;
      }
      if (!ws.data.ready) throw new PocketError("handshake_required", "Send hello first.");
      switch (message.type) {
        case "ping":
          send(ws, { type: "pong" });
          return;
        case "telemetry":
          return;
        case "refresh": {
          await store.refresh(shutdown.signal);
          send(ws, { type: "focus", snapshot: focusSnapshot() });
          return;
        }
        case "complete_task":
        case "reopen_task": {
          if (!identifier(message.id) || !requestId)
            throw new PocketError("invalid_request", "A valid task and request ID are required.");
          const id = message.id;
          const completed = message.type === "complete_task";
          await store[completed ? "complete" : "reopen"](id, requestId, () =>
            send(ws, { type: completed ? "task_completed" : "task_reopened", id, requestId }),
          );
          send(ws, { type: "focus", snapshot: focusSnapshot() });
          return;
        }
        case "task_timer": {
          if (!identifier(message.id) || !requestId || !taskTimerAction(message.action))
            throw new PocketError(
              "invalid_request",
              "A task, request ID and timer action are required.",
            );
          const { id, action } = message;
          await store.updateTimer(id, requestId, action, () =>
            send(ws, { type: "task_timer_updated", id, requestId, action }),
          );
          send(ws, { type: "focus", snapshot: focusSnapshot() });
          return;
        }
        case "cancel":
          cancel(ws);
          return;
        case "ptt_down": {
          if (message.sampleRate !== 16000 || message.channels !== 1)
            throw new PocketError("audio_format", "Microphone audio must be 16 kHz mono PCM16.");
          cancel(ws, false);
          if (mode === "live" && !config.matrix.enabled)
            throw new PocketError(
              "voice_unconfigured",
              "Connect Matrix to send voice messages to Hermes.",
              503,
            );
          if (config.matrix.enabled && !matrix)
            throw new PocketError(
              "matrix_unconfigured",
              "Matrix voice is not configured yet.",
              503,
            );
          ws.data.requestId = identifier(message.requestId)
            ? message.requestId
            : crypto.randomUUID();
          ws.data.turn = new AbortController();
          ws.data.recording = true;
          ws.data.captureTimer = setTimeout(() => {
            cancel(ws);
            fail(
              ws,
              new PocketError("utterance_too_long", "Try a shorter message, up to 30 seconds."),
            );
          }, 31000);
          send(ws, { type: "state", state: "listening" });
          return;
        }
        case "ptt_up":
          await voice(ws);
          return;
        default:
          throw new PocketError("invalid_request", "Unknown pocket message.");
      }
    } catch (error) {
      fail(ws, error, requestId);
    }
  }

  const server = Bun.serve<Connection>({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: 1 << 20,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/device/"))
          requireRequestAuth(req, config);
        if (
          (url.pathname === "/ws" || req.method !== "GET") &&
          !sameOrigin(req, config.publicOrigin)
        ) {
          throw new PocketError(
            "origin_forbidden",
            "This request must come from the pocket app.",
            403,
          );
        }
        if (url.pathname === "/ws") {
          const authenticated = config.deviceToken
            ? tokenMatches(bearer(req), config.deviceToken)
            : !requiresToken(config);
          if (requiresToken(config) && !config.deviceToken)
            throw new PocketError(
              "device_auth_unconfigured",
              "Configure the device token before enabling Matrix.",
              503,
            );
          if (!authenticated && (!req.headers.get("origin") || req.headers.has("authorization"))) {
            throw new PocketError("unauthorized", "A valid device token is required.", 401);
          }
          if (
            server.upgrade(req, {
              data: {
                authenticated,
                deviceId: "",
                requestId: null,
                ready: false,
                turn: null,
                audio: [],
                audioBytes: 0,
                recording: false,
                captureTimer: null,
              },
            })
          )
            return undefined;
          return new Response("WebSocket required", { status: 426 });
        }
        if (req.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
        if (req.method === "GET" && url.pathname === "/api/status") {
          return json({
            mode,
            requestTimeoutMs: config.requestTimeoutMs,
            voiceTransport: config.matrix.enabled
              ? "matrix"
              : mode === "live"
                ? "unconfigured"
                : "demo",
            matrix: config.matrix.enabled
              ? {
                  configured: Boolean(matrix),
                  ...(matrix?.status() ?? { ready: false, error: "matrix_unconfigured" }),
                }
              : undefined,
            configured: {
              todomate: Boolean(config.todomateBaseUrl && config.todomateAccessToken),
            },
          });
        }
        if (req.method === "GET" && url.pathname === "/api/focus") return json(focusSnapshot());
        if (url.pathname === "/device/voice" && req.method === "POST") {
          requireRequestAuth(req, config, true);
          if (!matrix)
            throw new PocketError(
              "matrix_unconfigured",
              "Matrix voice is not configured yet.",
              503,
            );
          const deviceId = req.headers.get("x-device-id");
          const key = req.headers.get("idempotency-key");
          if (!identifier(deviceId) || !identifier(key))
            throw new PocketError(
              "invalid_request",
              "X-Device-Id and Idempotency-Key are required.",
            );
          const pcm = await readPcmRequest(req);
          const job = await matrix.submit(deviceId, key, pcm);
          return json({ job, statusUrl: `/device/voice/${job.id}` }, 202);
        }
        const voiceJob = /^\/device\/voice\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
        if (req.method === "GET" && (voiceJob || url.pathname === "/device/voice")) {
          requireRequestAuth(req, config, true);
          if (!matrix)
            throw new PocketError(
              "matrix_unconfigured",
              "Matrix voice is not configured yet.",
              503,
            );
          const deviceId = req.headers.get("x-device-id");
          if (!identifier(deviceId))
            throw new PocketError("invalid_request", "X-Device-Id is required.");
          if (!voiceJob) return json({ jobs: matrix.list(deviceId) });
          const job = matrix.get(voiceJob[1]!, deviceId);
          if (!job) throw new PocketError("job_missing", "Voice job not found.", 404);
          return json(job);
        }
        const completion = /^\/api\/tasks\/([A-Za-z0-9_.:-]+)\/(complete|reopen)$/.exec(
          url.pathname,
        );
        if (req.method === "POST" && completion) {
          const body = await bodyObject(req);
          if (!identifier(body.requestId))
            throw new PocketError("invalid_request", "A valid request ID is required.");
          return json(
            await store[completion[2] === "complete" ? "complete" : "reopen"](
              completion[1]!,
              body.requestId,
            ),
          );
        }
        const timer = /^\/api\/tasks\/([A-Za-z0-9_.:-]+)\/timer$/.exec(url.pathname);
        if (req.method === "POST" && timer) {
          const body = await bodyObject(req);
          if (!identifier(body.requestId) || !taskTimerAction(body.action))
            throw new PocketError("invalid_request", "A request ID and timer action are required.");
          return json(await store.updateTimer(timer[1]!, body.requestId, body.action));
        }
        if (req.method === "GET" && url.pathname === "/app.js") {
          browserBundle ??= buildBrowser(config.webDirectory).catch((error: unknown) => {
            browserBundle = undefined;
            throw error;
          });
          return new Response(await browserBundle, {
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
        const assets: Record<string, [string, string]> = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/styles.css": ["styles.css", "text/css; charset=utf-8"],
          "/assets/inter.woff2": ["assets/inter.woff2", "font/woff2"],
        };
        const asset = assets[url.pathname];
        if (req.method === "GET" && asset) {
          const file = Bun.file(resolve(config.webDirectory, asset[0]));
          if (!(await file.exists())) return new Response("App asset not found", { status: 404 });
          return new Response(file, {
            headers: {
              "Content-Type": asset[1],
              "Cache-Control": "no-cache",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        const safe = publicError(error);
        return json({ error: { code: safe.code, message: safe.message } }, safe.status);
      }
    },
    websocket: {
      maxPayloadLength: 1 << 20,
      backpressureLimit: 8 << 20,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      open(ws) {
        clients.add(ws);
      },
      message(ws, message) {
        if (typeof message === "string") {
          void control(ws, message);
          return;
        }
        if (!ws.data.ready || !ws.data.recording) return;
        if (message.byteLength % 2 !== 0) {
          cancel(ws);
          fail(
            ws,
            new PocketError("audio_format", "Audio frames must contain complete PCM16 samples."),
          );
          return;
        }
        ws.data.audioBytes += message.byteLength;
        if (ws.data.audioBytes > MAX_AUDIO_BYTES) {
          cancel(ws);
          fail(
            ws,
            new PocketError("utterance_too_long", "Try a shorter message, up to 30 seconds."),
          );
          return;
        }
        ws.data.audio.push(new Uint8Array(message));
      },
      close(ws) {
        cancel(ws, false);
        clients.delete(ws);
      },
    },
  });
  const unsubscribe = store.subscribe(() => {
    const snapshot = focusSnapshot();
    for (const ws of clients) if (ws.data.ready) send(ws, { type: "focus", snapshot });
  });
  const stopMatrixJobs = matrix?.subscribe((job) => {
    for (const ws of clients)
      if (ws.data.ready && ws.data.deviceId === job.deviceId) send(ws, { type: "voice_job", job });
  });
  const stopMatrixStatus = matrix?.subscribeStatus(() => {
    for (const ws of clients)
      if (ws.data.ready) send(ws, { type: "focus", snapshot: focusSnapshot() });
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  if (adapter && overrides.poll !== false) {
    void store.refresh(shutdown.signal).catch(() => undefined);
    interval = setInterval(
      () => void store.refresh(shutdown.signal).catch(() => undefined),
      config.pollIntervalMs,
    );
    interval.unref();
  }
  return {
    server,
    store,
    async stop() {
      shutdown.abort();
      if (interval) clearInterval(interval);
      unsubscribe();
      stopMatrixJobs?.();
      stopMatrixStatus?.();
      for (const ws of clients) cancel(ws, false);
      await server.stop(true);
      await matrix?.stop();
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function sameOrigin(req: Request, publicOrigin: string): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  return origin === (publicOrigin || new URL(req.url).origin);
}

async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > 8192) throw new Error();
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new PocketError("invalid_request", "Request body must be a JSON object.");
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function buildBrowser(directory: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(directory, "app.ts")],
    target: "browser",
    minify: true,
  });
  if (!result.success || !result.outputs[0])
    throw new PocketError("app_build_failed", "The app could not be built.", 503);
  return result.outputs[0].text();
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}
function tokenMatches(value: unknown, expected: string): boolean {
  if (!expected || typeof value !== "string") return false;
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
function requireRequestAuth(req: Request, config: PocketConfig, always = false): void {
  if (!config.deviceToken) {
    if (requiresToken(config) || always)
      throw new PocketError(
        "device_auth_unconfigured",
        "Configure the device token before using the device API.",
        503,
      );
    return;
  }
  if (!tokenMatches(bearer(req), config.deviceToken))
    throw new PocketError("unauthorized", "A valid device token is required.", 401);
}
async function readPcmRequest(req: Request): Promise<Uint8Array> {
  if (
    (req.headers.get("x-audio-sample-rate") ?? "16000") !== "16000" ||
    (req.headers.get("x-audio-channels") ?? "1") !== "1"
  )
    throw new PocketError("audio_format", "Audio must be 16 kHz mono PCM16.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType === "application/octet-stream" || contentType === "audio/pcm") return bytes;
  if (contentType !== "audio/wav" && contentType !== "audio/x-wav")
    throw new PocketError("audio_format", "Send application/octet-stream PCM16 or audio/wav.");
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.subarray(start, end));
  if (bytes.length < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE")
    throw new PocketError("audio_format", "Invalid PCM WAV file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let formatValid = false,
    pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = ascii(offset, offset + 4),
      size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > bytes.length) throw new PocketError("audio_format", "Invalid WAV chunk.");
    if (kind === "fmt ")
      formatValid =
        size >= 16 &&
        view.getUint16(start, true) === 1 &&
        view.getUint16(start + 2, true) === 1 &&
        view.getUint32(start + 4, true) === 16000 &&
        view.getUint16(start + 14, true) === 16;
    if (kind === "data") {
      if (pcm) throw new PocketError("audio_format", "WAV has multiple audio streams.");
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!formatValid || !pcm) throw new PocketError("audio_format", "WAV must be 16 kHz mono PCM16.");
  return pcm;
}

function requiresToken(config: PocketConfig): boolean {
  return config.matrix.enabled || Boolean(config.todomateBaseUrl && config.todomateAccessToken);
}
