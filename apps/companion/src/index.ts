/**
 * `@alfred/companion` — the bridge surface for the ESP32-S3 pocket device.
 *
 * Re-exports the public building blocks and provides `main()`, the runnable
 * entrypoint (`bun run dev` / `bun run start`). See SCOPE.md for the full
 * architecture; the device firmware lives under `firmware/`.
 */

export * from "./config";
export * from "./persona";
export * from "./ports";
export * from "./protocol";
export * from "./reminders";
export * from "./session";
export * from "./server";
export * from "./stt";
export * from "./tools";
export * from "./tts";

import { loadConfig } from "./config";
import { createCompanionServer } from "./server";

export async function main(): Promise<void> {
  const config = loadConfig();
  const server = await createCompanionServer(config);
  console.log(
    `Alfred companion bridge listening on ws://${config.hostname}:${server.port} ` +
      `(model: ${config.model}, memory: ${config.memory ? "on" : "off"})`,
  );
}

if (import.meta.main) {
  await main();
}
