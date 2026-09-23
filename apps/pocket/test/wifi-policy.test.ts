import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Compile the actual firmware policy. No ESP-IDF, Wi-Fi scan, credentials,
// device, network service, or duplicated TypeScript policy is involved.
const compiler = Bun.which("cc") ?? Bun.which("clang") ?? Bun.which("gcc");
const native = compiler ? describe : describe.skip;

native("native Wi-Fi fallback policy (requires a C compiler)", () => {
  let directory = "";
  let binary = "";

  async function run(command: string[]): Promise<string> {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Wi-Fi policy command failed (${code}): ${stdout}${stderr}`);
    return stdout;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pocket-wifi-policy-"));
    binary = join(directory, "wifi-policy");
    const firmware = resolve(import.meta.dir, "../firmware/src");
    await run([
      compiler!,
      "-std=gnu11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      firmware,
      resolve(import.meta.dir, "native/wifi-policy.c"),
      join(firmware, "net/wifi_policy.c"),
      "-o",
      binary,
    ]);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves full credentials and recovers across repeated six-profile outages", async () => {
    expect(await run([binary])).toContain("Wi-Fi fallback policy regressions pass");
  });
});
