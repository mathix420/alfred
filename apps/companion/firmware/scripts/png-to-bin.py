#!/usr/bin/env python3
"""Convert a 368x448 PNG into the LVGL-native study_bg.bin the firmware loads.

The companion firmware blits S:/alfred/backplate/study_bg.bin straight to the
AMOLED as the baked study scene. This wraps LVGL's official v9 converter
(LVGLImage.py, vendored under .pio/libdeps) with the correct flags:

  --cf RGB565   native LVGL RGB565. NOT RGB565_SWAPPED: ui.c's flush callback
                already byte-swaps once for the panel, so a pre-swapped image
                would double-swap and come out with wrong colors.

Usage:
  scripts/png-to-bin.py <input.png> [output_dir]      # default output_dir = .

One-time setup (the converter's dependencies):
  pip install pypng lz4

Then copy the result to the card at /alfred/backplate/study_bg.bin and reboot
the device — no reflash needed (ui_init loads it at boot).
"""
import os
import struct
import subprocess
import sys

SCREEN_W, SCREEN_H = 368, 448
HERE = os.path.dirname(os.path.abspath(__file__))
CONVERTER = os.path.join(
    HERE, "..", ".pio", "libdeps", "companion", "lvgl", "scripts", "LVGLImage.py"
)


def png_dimensions(path: str) -> tuple[int, int]:
    with open(path, "rb") as f:
        header = f.read(24)
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{path}: not a PNG. Export your art as PNG first.")
    width, height = struct.unpack(">II", header[16:24])
    return width, height


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: png-to-bin.py <input.png> [output_dir]")
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    if not os.path.exists(CONVERTER):
        sys.exit(f"LVGLImage.py not found at {CONVERTER}\nRun `pio run` once to fetch LVGL.")

    width, height = png_dimensions(src)
    if (width, height) != (SCREEN_W, SCREEN_H):
        print(
            f"WARNING: {src} is {width}x{height}, expected {SCREEN_W}x{SCREEN_H}. "
            "The backplate will be cropped/misaligned on the panel."
        )

    os.makedirs(out_dir, exist_ok=True)
    subprocess.run(
        [sys.executable, CONVERTER, "--ofmt", "BIN", "--cf", "RGB565",
         "-o", out_dir, src],
        check=True,
    )

    # LVGLImage.py names the BIN after the input file (it ignores --name for BIN),
    # so normalise it to study_bg.bin.
    produced = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + ".bin")
    result = os.path.join(out_dir, "study_bg.bin")
    if os.path.abspath(produced) != os.path.abspath(result):
        os.replace(produced, result)
    print(f"\nWrote {result}")
    print("Copy it to the SD card at:  /alfred/backplate/study_bg.bin")
    print("Then reboot the device (no reflash needed).")


if __name__ == "__main__":
    main()
