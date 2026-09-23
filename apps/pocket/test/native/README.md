Run `bun test apps/pocket/test/native-ui.test.ts` from the repository root.

The test compiles the actual firmware UI with real LVGL and Inter fonts. Board
I/O, task scheduling, and NVS use in-memory substitutes; it never opens USB,
records audio, or contacts a server. It exercises rendered Today rows, task
snapshots, completion responses, and a fresh `ui_init()` with committed NVS
state preserved.

Install the firmware dependencies with `pio pkg install -d apps/pocket/firmware
-e companion_v1`, or set `LVGL_SOURCE_DIR` to an LVGL 9.5 source checkout. The
test also requires CMake and a host C/C++ toolchain. It skips when the local
dependencies are absent. LVGL's build cache lives in the ignored firmware
`.pio/native-ui-host` directory.
