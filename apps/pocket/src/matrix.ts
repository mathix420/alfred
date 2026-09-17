import { Database } from "bun:sqlite";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { MatrixConfig } from "./config";
import { identifier, PocketError } from "./types";

export type VoiceJobState = "queued" | "sending" | "sent" | "failed";
export interface VoiceJob {
  id: string;
  deviceId: string;
  state: VoiceJobState;
  createdAt: number;
  updatedAt: number;
  matrixEventId: string | null;
  error: string | null;
}
interface JobRow extends VoiceJob {
  audioPath: string;
  audioHash: string;
  requestKey: string;
  durationMs: number;
}
export type MatrixWorkerEvent =
  | { type: "ready" }
  | { type: "identity"; deviceId: string; ed25519: string }
  | { type: "retry"; jobId: string; code: string }
  | { type: "offline"; code: string }
  | { type: "sent"; jobId: string; eventId: string }
  | { type: "failed"; jobId: string; code: string };
export interface MatrixTransport {
  start(receive: (event: MatrixWorkerEvent) => void): void;
  submit(job: { id: string; path: string; durationMs: number }): void;
  stop(): Promise<void>;
}

export class PythonMatrixTransport implements MatrixTransport {
  private process: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
  private stopped = false;
  private restart: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly config: MatrixConfig) {}

  start(receive: (event: MatrixWorkerEvent) => void): void {
    if (this.stopped) return;
    try {
      this.process = Bun.spawn(
        [this.config.python, resolve(import.meta.dir, "../matrix/worker.py")],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ALFRED_MATRIX_HOMESERVER: this.config.homeserver,
            ALFRED_MATRIX_USER_ID: this.config.userId,
            ALFRED_MATRIX_ACCESS_TOKEN: this.config.accessToken,
            ALFRED_MATRIX_DEVICE_ID: this.config.deviceId,
            ALFRED_MATRIX_HERMES_USER_ID: this.config.hermesUserId,
            ALFRED_MATRIX_ROOM_ID: this.config.roomId,
            ALFRED_MATRIX_STORE_DIR: this.config.storeDirectory,
            ALFRED_MATRIX_PICKLE_KEY: this.config.pickleKey,
            ALFRED_MATRIX_TRUSTED_DEVICES: this.config.trustedDevices,
            ALFRED_POCKET_VOICE_DIR: this.config.voiceDirectory,
            PYTHONUNBUFFERED: "1",
          },
        },
      );
    } catch {
      receive({ type: "offline", code: "matrix_worker_unavailable" });
      return;
    }
    const child = this.process;
    let lastProblem: string | undefined;
    void (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 262144) {
          child.kill();
          break;
        }
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const event = JSON.parse(line) as MatrixWorkerEvent;
            if (
              event.type === "ready" ||
              event.type === "identity" ||
              event.type === "offline" ||
              ((event.type === "sent" || event.type === "retry" || event.type === "failed") &&
                identifier(event.jobId))
            ) {
              if (event.type === "offline") lastProblem = safeCode(event.code);
              receive(event);
            }
          } catch {
            /* Never expose raw worker output or credentials. */
          }
        }
      }
    })().catch(() => undefined);
    // Drain stderr without logging third-party exception payloads, which may contain tokens.
    void (async () => {
      for await (const _chunk of child.stderr) {
        /* drained */
      }
    })().catch(() => undefined);
    void child.exited.then(() => {
      receive({ type: "offline", code: lastProblem ?? "matrix_worker_stopped" });
      if (!this.stopped) this.restart = setTimeout(() => this.start(receive), 5000);
    });
  }

  submit(job: { id: string; path: string; durationMs: number }): void {
    if (!this.process || this.process.exitCode !== null) throw new Error("worker offline");
    this.process.stdin.write(`${JSON.stringify({ type: "send_voice", ...job })}\n`);
    this.process.stdin.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restart) clearTimeout(this.restart);
    this.process?.kill();
    await this.process?.exited;
  }
}

export class MatrixVoiceService {
  private database: Database | undefined;
  private readonly subscribers = new Set<(job: VoiceJob) => void>();
  private active = false;
  private problem: string | null = null;
  private identity: { deviceId: string; ed25519: string } | null = null;
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly statusSubscribers = new Set<() => void>();
  private submitting: Promise<unknown> = Promise.resolve();
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly transport: MatrixTransport,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.database = new Database(resolve(this.directory, "jobs.sqlite"), { create: true });
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, requestKey TEXT NOT NULL, audioHash TEXT NOT NULL,
        audioPath TEXT NOT NULL, durationMs INTEGER NOT NULL, state TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, matrixEventId TEXT, error TEXT,
        UNIQUE(deviceId, requestKey)
      );`);
    // Remove message history from older two-way bridge stores.
    this.database.exec("UPDATE jobs SET state='sent' WHERE state='replied'");
    const columns = this.database.query<{ name: string }, []>("PRAGMA table_info(jobs)").all();
    if (columns.some((column) => column.name === "reply"))
      this.database.exec("ALTER TABLE jobs DROP COLUMN reply");
    for (const row of this.database
      .query<{ audioPath: string }, []>("SELECT audioPath FROM jobs WHERE state='sent'")
      .all())
      await unlink(row.audioPath).catch(() => undefined);
    await chmod(resolve(this.directory, "jobs.sqlite"), 0o600);
    this.transport.start((event) => this.receive(event));
  }

  status(): {
    ready: boolean;
    error: string | null;
    identity: { deviceId: string; ed25519: string } | null;
  } {
    return { ready: this.active, error: this.problem, identity: this.identity };
  }
  subscribeStatus(listener: () => void): () => void {
    this.statusSubscribers.add(listener);
    return () => this.statusSubscribers.delete(listener);
  }
  private changedStatus(): void {
    for (const listener of this.statusSubscribers) listener();
  }

  async submit(deviceId: string, requestKey: string, pcm: Uint8Array): Promise<VoiceJob> {
    if (!identifier(deviceId) || !identifier(requestKey))
      throw new PocketError("invalid_request", "Valid device and idempotency IDs are required.");
    if (pcm.byteLength < 2 || pcm.byteLength % 2 || pcm.byteLength > 960000)
      throw new PocketError("audio_format", "Send 16 kHz mono PCM16 audio, up to 30 seconds.");
    const operation = this.submitting.then(async () => {
      const db = this.database!;
      const audioHash = createHash("sha256").update(pcm).digest("hex");
      const existing = db
        .query<JobRow, [string, string]>("SELECT * FROM jobs WHERE deviceId=? AND requestKey=?")
        .get(deviceId, requestKey);
      if (existing) {
        if (existing.audioHash !== audioHash)
          throw new PocketError(
            "request_conflict",
            "That idempotency key belongs to another recording.",
            409,
          );
        return publicJob(existing);
      }
      const pending = db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM jobs WHERE state IN ('queued','sending')",
        )
        .get()!.count;
      if (pending >= 32)
        throw new PocketError(
          "queue_full",
          "The voice queue is full. Wait for Hermes before sending another message.",
          429,
        );
      const id = crypto.randomUUID();
      const audioPath = resolve(this.directory, `${id}.pcm`);
      const temporary = `${audioPath}.tmp`;
      await Bun.write(temporary, pcm);
      await chmod(temporary, 0o600);
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, audioPath);
      const folder = await open(this.directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      const now = Date.now();
      try {
        db.query(`INSERT INTO jobs (id,deviceId,requestKey,audioHash,audioPath,durationMs,state,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,'queued',?,?)`).run(
          id,
          deviceId,
          requestKey,
          audioHash,
          audioPath,
          pcm.byteLength / 32,
          now,
          now,
        );
      } catch (error) {
        await unlink(audioPath).catch(() => undefined);
        throw error;
      }
      const job = this.get(id, deviceId)!;
      this.publish(job);
      this.dispatch();
      return this.get(id, deviceId)!;
    });
    this.submitting = operation.catch(() => undefined);
    return operation;
  }

  get(id: string, deviceId?: string): VoiceJob | null {
    const row = this.database?.query<JobRow, [string]>("SELECT * FROM jobs WHERE id=?").get(id);
    return row && (!deviceId || row.deviceId === deviceId) ? publicJob(row) : null;
  }

  list(deviceId: string): VoiceJob[] {
    return (
      this.database
        ?.query<JobRow, [string]>(
          "SELECT * FROM jobs WHERE deviceId=? ORDER BY createdAt DESC LIMIT 20",
        )
        .all(deviceId) ?? []
    ).map(publicJob);
  }

  subscribe(listener: (job: VoiceJob) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  waitForSent(id: string, signal: AbortSignal): Promise<VoiceJob> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error, job?: VoiceJob) => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(job!);
      };
      const check = (job: VoiceJob | null) => {
        if (!job || job.id !== id) return;
        if (job.state === "sent") finish(undefined, job);
        else if (job.state === "failed")
          finish(
            new PocketError(
              job.error ?? "matrix_failed",
              "The Matrix voice message could not be delivered. Check the connection and device trust.",
              502,
            ),
          );
      };
      const abort = () =>
        finish(
          new PocketError(
            "cancelled",
            "Stopped waiting. The recording remains queued for delivery.",
            499,
          ),
        );
      unsubscribe = this.subscribe(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check(this.get(id));
    });
  }

  private receive(event: MatrixWorkerEvent): void {
    if (this.stopped || !this.database) return;
    if (event.type === "identity") {
      if (
        typeof event.deviceId === "string" &&
        event.deviceId.length <= 255 &&
        typeof event.ed25519 === "string" &&
        /^[A-Za-z0-9+/]{43}=?$/.test(event.ed25519)
      ) {
        this.identity = { deviceId: event.deviceId, ed25519: event.ed25519 };
        this.changedStatus();
      }
      return;
    }
    if (event.type === "ready") {
      this.active = true;
      this.problem = null;
      this.dispatched.clear();
      this.dispatch();
      this.changedStatus();
      return;
    }
    if (event.type === "offline") {
      this.active = false;
      this.problem = safeCode(event.code);
      this.dispatched.clear();
      this.changedStatus();
      return;
    }
    const row = this.database
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE id=?")
      .get(event.jobId);
    if (!row) return;
    if (event.type === "retry") {
      if (row.state === "sent" || row.state === "failed" || this.retries.has(row.id)) return;
      this.database
        .query("UPDATE jobs SET state='queued',error=?,updatedAt=? WHERE id=?")
        .run(safeCode(event.code), Date.now(), row.id);
      this.retries.set(
        row.id,
        setTimeout(() => {
          this.retries.delete(row.id);
          this.dispatched.delete(row.id);
          this.dispatch();
        }, 5000),
      );
      this.publish(this.get(row.id)!);
      return;
    }
    if (
      event.type === "sent" &&
      typeof event.eventId === "string" &&
      event.eventId.startsWith("$")
    ) {
      this.database
        .query("UPDATE jobs SET state='sent',matrixEventId=?,error=NULL,updatedAt=? WHERE id=?")
        .run(event.eventId, Date.now(), row.id);
      void unlink(row.audioPath).catch(() => undefined);
    } else if (event.type === "failed" && row.state !== "sent") {
      this.database
        .query("UPDATE jobs SET state='failed',error=?,updatedAt=? WHERE id=?")
        .run(safeCode(event.code), Date.now(), row.id);
    } else return;
    this.publish(this.get(row.id)!);
  }

  private dispatch(): void {
    if (!this.active || !this.database || this.stopped) return;
    const rows = this.database
      .query<JobRow, []>(
        "SELECT * FROM jobs WHERE state IN ('queued','sending') ORDER BY createdAt",
      )
      .all();
    for (const row of rows) {
      if (this.dispatched.has(row.id) || this.retries.has(row.id)) continue;
      try {
        this.transport.submit({ id: row.id, path: row.audioPath, durationMs: row.durationMs });
        this.dispatched.add(row.id);
        if (row.state === "queued")
          this.database
            .query("UPDATE jobs SET state='sending', updatedAt=? WHERE id=?")
            .run(Date.now(), row.id);
      } catch {
        this.active = false;
        this.problem = "matrix_worker_unavailable";
        break;
      }
    }
  }

  private publish(job: VoiceJob): void {
    for (const listener of this.subscribers) listener(job);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await this.transport.stop();
    await this.submitting;
    this.database?.close();
    this.database = undefined;
  }
}

function publicJob(row: JobRow): VoiceJob {
  return {
    id: row.id,
    deviceId: row.deviceId,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    matrixEventId: row.matrixEventId,
    error: row.error,
  };
}
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,48}$/.test(value) ? value : "matrix_unavailable";
}
