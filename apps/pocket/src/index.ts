import { loadPocketConfig } from "./config";
import { createPocketServer } from "./server";

export { loadPocketConfig } from "./config";
export { createPocketServer } from "./server";
export { TaskStore } from "./tasks";
export type { FocusTask, FocusSnapshot } from "./types";

if (import.meta.main) {
  const app = await createPocketServer(loadPocketConfig());
  console.log(
    `Pocket assistant: http://${app.server.hostname}:${app.server.port} (${app.store.snapshot().mode})`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.stop().finally(() => process.exit(0));
    });
  }
}
