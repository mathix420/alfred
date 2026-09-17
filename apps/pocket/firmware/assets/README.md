# companion assets — the microSD art pack

The companion's look is **100% firmware + assets** — the bridge never ships
pixels, it only pushes semantic state. Per the locked decision in
[`../../SCOPE.md`](../../SCOPE.md) §4 and the visual direction in §6, the art is
authored in **Aseprite**, exported to the **microSD (TF) card**, and loaded at
runtime via **LVGL's filesystem driver**. This decouples the look from the
firmware: you can refresh art by re-provisioning the card, no reflash.

> **Assets are NOT committed to this repo.** Source `.aseprite` files and the
> exported binaries are large and iterate independently of code. This directory
> holds only this spec and a `.gitkeep`. The card is provisioned separately
> (see _Provisioning the card_ below).

## The metaphor — chrome is the study, content is the hologram

The physical world — dark wood panels, the frame, the **raven crest**, the
warm **lantern** — is a single **baked, full-fidelity static backplate**. The
only animated layer is the holographic content (cyan panels, terminal text) and
a few small foreground sprites. AMOLED true-black renders the dark study for
free, so the on-brand look is also the most power-efficient. Target portrait
**368×448**.

**Constraint (SCOPE §6):** baked backplate + _selective_ animation only — sprite
playback at ~**8–12 fps**, a glow pulse, and streaming text. A live 30 fps
full-screen scene is explicitly out of scope.

## Palette (AMOLED-tuned)

Author and export with **exactly** these hex values — the firmware's accent
colors (`lv_color_hex(...)`) are defined to match, and an indexed PNG that
drifts off-palette will look wrong against the baked plate.

| Role                      | Hex       |
| ------------------------- | --------- |
| Background (true black)   | `#000000` |
| Chrome — wood brown       | `#2A211A` |
| Chrome — dark green       | `#16221C` |
| Hologram — cyan           | `#3FE0FF` |
| Hologram — magenta/violet | `#C84BFF` |
| Lantern amber (alerts)    | `#FFB454` |
| Text                      | `#DCEFF5` |

Keep a shared Aseprite palette file (`palette.gpl` / `.ase` swatch) so every
asset indexes against the same table. Glows are **baked into the sprites** as
pixels — there is no real-time blur on-device.

## On-card directory layout

LVGL is configured with a filesystem driver mapped to the SD card under a drive
letter (commonly `S:`); the SD mount point and the LVGL drive letter are set in
the firmware. All asset paths are relative to the card root:

```
/alfred/
  backplate/
    study_bg.bin            # baked static study backplate, full 368x448
    raven_crest.bin         # raven crest motif (status-bar small + faint center large)
    lantern_glow.bin        # warm lantern glow, corner overlay (semi-transparent)
    scanline.bin            # translucent scanline/flicker overlay tile
  sprite/
    alfred_idle.bin         # ambient: subtle, mostly static (colon blink handled in UI)
    alfred_listening.bin    # leans toward panel; used with reactive mic waveform
    alfred_thinking.bin     # strokes moustache; small raven circles as the spinner
    alfred_speaking.bin     # gestures at the panel; subtle hand/mouth anim
    alfred_capture.bin      # note collapses into the raven crest ("Noted, sir.")
  font/
    label_24.bin            # elegant Edwardian label font (bitmap)
    label_16.bin            # smaller label / status-bar font
    mono_18.bin             # monospace holographic terminal font (transcript/reply)
  icon/
    batt.bin                # battery glyph(s) / sprite for charge levels
    wifi.bin                # connection-strength glyph(s)
  manifest.json             # optional: version + frame counts/fps per sprite sheet
```

Each `DeviceState` (`idle | listening | thinking | speaking`) maps to one Alfred
sprite sheet; `capture` is a transient overlay played after a memory capture.
The status bar (battery, WiFi, small raven crest) sits on top of the backplate;
central holographic content and streaming terminal text render over it.

## Authoring & export pipeline

1. **Author in Aseprite** at 368×448 (backplate) or the sprite's native cell
   size, all layers indexed to the shared palette above. Animate sprite sheets
   on a timeline at the target 8–12 fps; keep frame counts modest.
2. **Export indexed PNGs.** Use _File → Export Sprite Sheet_ for animated
   sprites (one horizontal or grid strip per state) and a flat PNG for static
   art. Indexed color (≤256, ideally just the palette) keeps files small and
   on-palette. Note the frame count, columns, and fps — the UI needs them to
   drive the LVGL animation timer.
3. **Convert to an LVGL `.bin`.** The firmware loads LVGL-native binary images
   (its built-in `.bin` decoder — no runtime PNG codec). Convert the exported
   368×448 PNG with the bundled wrapper:

   ```sh
   pip install pypng                      # one-time — LVGL's converter reads PNG via pypng
   ./scripts/png-to-bin.py study_bg.png   # -> ./study_bg.bin
   ```

   which invokes LVGL's official converter
   (`.pio/libdeps/companion/lvgl/scripts/LVGLImage.py`) as:

   ```sh
   LVGLImage.py --ofmt BIN --cf RGB565 --name study_bg -o <out> study_bg.png
   ```

   Use **`--cf RGB565`** (native), NOT `RGB565_SWAPPED`: `ui.c`'s flush callback
   already byte-swaps once for the panel, so a pre-swapped image double-swaps and
   the colours come out wrong. Fonts use LVGL's font converter the same way and
   load via `lv_binfont_create("S:/alfred/font/mono_18.bin")`.

4. **Copy onto the card** preserving the `/alfred/...` tree above, then reboot —
   the firmware loads `study_bg.bin` at boot, no reflash.

## How LVGL loads them at runtime

The firmware registers an LVGL filesystem driver bound to the SD card (FATFS
mount + `lv_fs_drv` under a drive letter, e.g. `S:`). Assets are then referenced
by path, for example:

```c
// backplate: load once, set as the screen background image
lv_image_set_src(backplate_img, "S:/alfred/backplate/study_bg.bin");

// state sprite: an animation timer advances frames at ~10 fps (SCOPE: 8-12)
lv_image_set_src(alfred_sprite, "S:/alfred/sprite/alfred_thinking.bin");

// terminal text uses the on-card monospace font for streaming reply/transcript
static lv_font_t *mono = lv_binfont_create("S:/alfred/font/mono_18.bin");
```

> The exact LVGL drive letter, color formats, sprite-sheet frame geometry and
> font load API depend on the firmware's LVGL config and version — see the
> `// TODO(hw):` markers in the UI/asset-loader source for the values that must
> be reconciled against the actual `lv_conf.h` and the chosen Aseprite exports.

## Provisioning the card

1. Format the microSD as **FAT32** (the firmware mounts it via ESP-IDF FATFS).
2. Create the `/alfred/...` tree above and copy the exported assets in.
3. Insert the card before boot. With no card (or missing files) the device logs
   a warning and falls back to a black screen with text-only chrome.

## See also

- [`../README.md`](../README.md) — building and flashing the firmware.
- [`../../SCOPE.md`](../../SCOPE.md) — §6 visual direction (state scenes, palette,
  layout) this asset pack realizes.
