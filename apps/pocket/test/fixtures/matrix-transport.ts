import type { MatrixTransport, MatrixWorkerEvent } from "../../src/matrix";

/** In-process encrypted transport boundary; never connects an external account. */
export class TestMatrixTransport implements MatrixTransport {
  receive: (event: MatrixWorkerEvent) => void = () => {};
  submitted: { id: string; path: string; durationMs: number }[] = [];
  constructor(private readonly autoAcknowledge = true) {}
  start(receive: (event: MatrixWorkerEvent) => void): void {
    this.receive = receive;
    receive({ type: "ready" });
  }
  submit(job: { id: string; path: string; durationMs: number }): void {
    this.submitted.push(job);
    if (this.autoAcknowledge) queueMicrotask(() => this.confirm(job.id));
  }
  confirm(jobId: string): void {
    this.receive({ type: "sent", jobId, eventId: `$sent-${jobId}` });
  }
  async stop(): Promise<void> {}
}

/** Bun accepts authentication headers in its WebSocket constructor. */
export function authenticatedSocket(url: string, token: string): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  return new BunWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
}
