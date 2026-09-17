# =============================================================================
# Alfred companion — "main" component registration
# =============================================================================
#
# Registers every firmware translation unit as the IDF `main` component.
#
# Sources are split across subsystem folders, each owned by a different part of
# the firmware:
#   .       app entry / glue        (main.c, app_*.c)
#   board/  hardware bring-up       (display, touch, audio codec, IMU, RTC, PMIC,
#                                     SD) — BOARD_VERSION selects V1 vs V2 drivers
#   ui/     LVGL screens + theme    (ambient face, listening/thinking/speaking)
#   net/    Wi-Fi, WebSocket client, protocol codec (mirrors src/protocol.ts)
#   audio/  I2S record-on-PTT + TTS playback
#
# We glob the .c files so adding a source in any of these folders doesn't require
# editing this file. (CMake doesn't re-glob automatically; re-run a clean build —
# or `idf.py reconfigure` / `pio run -t menuconfig` — after adding/removing a
# file.)
# =============================================================================

file(GLOB_RECURSE app_sources
  "${CMAKE_CURRENT_SOURCE_DIR}/*.c"
)

idf_component_register(
  SRCS ${app_sources}
  INCLUDE_DIRS
    "."
    "board"
    "ui"
    "net"
    "audio"
  REQUIRES
    esp_wifi      # station + scan for provisioning
    nvs_flash     # Wi-Fi creds, device id, pairing token
    esp_event     # wifi/ip event loop
    esp-tls       # wss:// to the bridge
    json          # cJSON — control-plane frame codec (mirrors protocol.ts)
    driver        # i2c / i2s / gpio (codec, touch, IMU, RTC, PMIC, buttons)
    esp_driver_sdmmc # SDMMC host for the microSD slot (board_sdcard_init)
    fatfs         # microSD: FAT mount (esp_vfs_fat_sdmmc_mount), assets + capture queue
    esp_lcd       # AMOLED panel IO/ops (board_display_init, ui flush)
)

# BOARD_VERSION (1 = SH8601/FT3168, 2 = CO5300/CST816) is injected by
# platformio.ini build_flags; the board/ drivers #ifdef on it. Surface a clear
# error if someone builds with a bare `idf.py build` and forgets to define it.
# TODO(hw): if building via plain idf.py, pass -DBOARD_VERSION=2 on the cmake
# command line or add it to sdkconfig as an app-defined option.
