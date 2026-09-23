import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Uses the real LVGL widgets, renderer, timers and event dispatch. Only the
// ESP32 board/RTOS/NVS boundary is mocked. No hardware or network is accessed.
const firmware = resolve(import.meta.dir, "../firmware");
const lvgl = [process.env.LVGL_SOURCE_DIR, join(firmware, ".pio/libdeps/companion_v1/lvgl")].find(
  (path) => path && existsSync(join(path, "CMakeLists.txt")),
);
const compiler = Bun.which("cc") ?? Bun.which("clang") ?? Bun.which("gcc");
const cmake = Bun.which("cmake");
const native = lvgl && compiler && cmake ? describe : describe.skip;

native("native LVGL manual focus (requires LVGL source, CMake and a C compiler)", () => {
  let directory = "";
  let binary = "";

  async function run(command: string[]): Promise<string> {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0)
      throw new Error(
        `Native UI command failed (${code}): ${stdout.slice(-2000)}${stderr.slice(-4000)}`,
      );
    return stdout;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pocket-native-ui-"));
    binary = join(directory, "ui-focus");
    const stubs = join(directory, "stubs");
    await mkdir(stubs);
    await copyFile(join(import.meta.dir, "native/host_stubs.h"), join(stubs, "host_stubs.h"));
    const headers = [
      "board/board.h",
      "esp_check.h",
      "esp_err.h",
      "esp_heap_caps.h",
      "esp_lcd_panel_io.h",
      "esp_lcd_panel_ops.h",
      "esp_log.h",
      "esp_timer.h",
      "freertos/FreeRTOS.h",
      "freertos/semphr.h",
      "freertos/task.h",
      "nvs.h",
    ];
    for (const header of headers) {
      await mkdir(dirname(join(stubs, header)), { recursive: true });
      await writeFile(join(stubs, header), '#include "host_stubs.h"\n');
    }

    // CMake tracks the source/config dependencies; reuse its ignored local
    // build cache instead of rebuilding LVGL for each application test run.
    const build = join(firmware, ".pio/native-ui-host");
    await run([
      cmake!,
      "-S",
      lvgl!,
      "-B",
      build,
      `-DCMAKE_C_COMPILER=${compiler!}`,
      "-DCMAKE_BUILD_TYPE=Debug",
      `-DLV_BUILD_CONF_PATH=${join(firmware, "src/lv_conf.h")}`,
      "-DCONFIG_LV_BUILD_DEMOS=OFF",
      "-DCONFIG_LV_BUILD_EXAMPLES=OFF",
      "-DCONFIG_LV_USE_THORVG_INTERNAL=OFF",
      "-DBUILD_SHARED_LIBS=OFF",
    ]);
    await run([cmake!, "--build", build, "--target", "lvgl", "--parallel", "4"]);
    const fonts = (await readdir(join(firmware, "src/ui/fonts")))
      .filter((file) => /^inter_\d+\.c$/.test(file))
      .map((file) => join(firmware, "src/ui/fonts", file));
    await run([
      compiler!,
      "-std=gnu11",
      "-DLV_CONF_INCLUDE_SIMPLE",
      "-DALFRED_ENABLE_DEMO=0",
      "-I",
      stubs,
      "-I",
      join(firmware, "src"),
      "-I",
      lvgl!,
      join(import.meta.dir, "native/ui-focus.c"),
      ...fonts,
      join(build, "lib/liblvgl.a"),
      "-lm",
      "-o",
      binary,
    ]);
  }, 180_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("retains the selected task through updates and restart until completion or replacement", async () => {
    expect(await run([binary])).toContain("Manual focus survives");
  });
});
