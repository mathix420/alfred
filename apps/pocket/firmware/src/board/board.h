#pragma once

/*
 * board.h — board bring-up API for the Waveshare ESP32-S3-Touch-AMOLED-1.8.
 *
 * One `board_init()` entry point brings every peripheral up in dependency
 * order (shared I2C, PMIC telemetry/input, then the other peripherals). Each
 * peripheral also exposes its own init so a surface can bring up only what it
 * needs (e.g. a power-only diagnostic build).
 *
 * The board ships in two hardware revisions that differ ONLY in the display and
 * touch controllers (SCOPE.md §2):
 *   - V1: SH8601 AMOLED + FT3168 touch
 *   - V2: CO5300 AMOLED + CST820 touch (not implemented here)
 * Select the target at build time with -DBOARD_VERSION=1 (or =2). Everything
 * else (I2C, I2S, IMU, RTC, PMIC, SD) is common across revisions.
 */

#include "esp_err.h"
#include "esp_lcd_types.h" /* esp_lcd_panel_handle_t / esp_lcd_panel_io_handle_t */
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ----------------------------------------------------------------------------
 * Board revision selection
 * ------------------------------------------------------------------------- */
#define BOARD_VERSION_V1 1
#define BOARD_VERSION_V2 2

/* Default to V2 (newer silicon) if the build did not pin a revision. */
#ifndef BOARD_VERSION
#define BOARD_VERSION BOARD_VERSION_V2
#endif

#if (BOARD_VERSION != BOARD_VERSION_V1) && (BOARD_VERSION != BOARD_VERSION_V2)
#error "BOARD_VERSION must be BOARD_VERSION_V1 (1) or BOARD_VERSION_V2 (2)"
#endif

/* Human-readable name for logs / the `hello` firmware string. */
#if BOARD_VERSION == BOARD_VERSION_V1
#define BOARD_VERSION_NAME "v1"
#else
#define BOARD_VERSION_NAME "v2"
#endif

/* ----------------------------------------------------------------------------
 * Battery / power snapshot (filled by board_power_read)
 * ------------------------------------------------------------------------- */
typedef struct {
  uint8_t percent;     /* 0..100, mirrors AmbientFace.battery in protocol.ts */
  bool charging;       /* mirrors AmbientFace.charging / telemetry.charging */
  uint16_t millivolts; /* raw battery voltage, for finer logging */
  bool present;        /* false if no battery pack is connected */
} board_power_status_t;

/* Callback invoked from the IMU ISR-deferred context on a raise gesture.
 * Used to wake the ambient face (SCOPE.md §3 "wake on IMU raise"). */
typedef void (*board_raise_cb_t)(void *user);

/* PTT edge callback: the board layer debounces the BOOT key and
 * reports each edge (pressed = true on down, false on up). */
typedef void (*board_ptt_cb_t)(bool pressed, void *user);

/* ----------------------------------------------------------------------------
 * Top-level bring-up
 * ------------------------------------------------------------------------- */

/* Bring up the whole board in dependency order. Returns the first failure. */
esp_err_t board_init(void);

/* ----------------------------------------------------------------------------
 * Per-peripheral init (call individually for partial / diagnostic builds)
 * ------------------------------------------------------------------------- */

/* Shared 400kHz I2C bus — must run before any I2C peripheral below. */
esp_err_t board_i2c_init(void);

/* AMOLED over QSPI; branches on BOARD_VERSION for SH8601 (V1) / CO5300 (V2). */
esp_err_t board_display_init(void);

/* Handles to the panel brought up by board_display_init(), for the UI layer to
 * bind LVGL to. Both return NULL until board_display_init() has run successfully
 * (e.g. the V2 path is still a stub, so these are NULL on a V2 build). The UI
 * registers its flush-ready callback on the io handle and blits frames to the
 * panel handle. */
esp_lcd_panel_handle_t board_display_panel(void);
esp_lcd_panel_io_handle_t board_display_io(void);

/* FT3168 touch controller (V1); V2 returns ESP_ERR_NOT_SUPPORTED. */
esp_err_t board_touch_init(void);

/* Poll the first touch point in native portrait coordinates (368 x 448).
 * No touch or a read failure sets pressed=false; coordinates change only for
 * a valid point. Call from the LVGL input reader, outside interrupt context. */
esp_err_t board_touch_read(uint16_t *x, uint16_t *y, bool *pressed);

/* ES8311 codec over I2C control + I2S data (mic capture + speaker playback). */
esp_err_t board_audio_init(void);

/* QMI8658 6-axis IMU. Optionally arms a raise-to-wake interrupt; pass NULL to
 * skip the wake hook and just bring the sensor up. */
esp_err_t board_imu_init(board_raise_cb_t on_raise, void *user);

/* PCF85063 battery-backed RTC (owns the clock when the bridge is offline). */
esp_err_t board_rtc_init(void);

/* AXP2101 battery reporting and PWR-key input. Preserves existing power rails,
 * charging configuration and hardware long-press power-off behavior. */
esp_err_t board_power_init(void);

/* microSD (TF) slot — backs the offline capture queue + LVGL asset store. */
esp_err_t board_sdcard_init(void);

/* ----------------------------------------------------------------------------
 * Runtime helpers
 * ------------------------------------------------------------------------- */

/* Snapshot battery state from the AXP2101 (for telemetry / the ambient face). */
esp_err_t board_power_read(board_power_status_t *out);

/* Convenience accessors over board_power_read(), for telemetry frames. */
float board_battery_percent(void); /* 0..100; <0 if unknown */
bool board_is_charging(void);      /* true when a battery is charging */

/* ----------------------------------------------------------------------------
 * Input registration
 * ------------------------------------------------------------------------- */

/* Register BOOT hold-to-talk edges, dispatched from the board input task.
 * Callbacks should enqueue work; they must not block the input task. */
void board_register_ptt(board_ptt_cb_t cb, void *user);

/* PWR short press, dispatched from the input task. Long press remains the
 * PMIC's hardware power-off action. Pass NULL to clear. */
void board_register_action(board_raise_cb_t cb, void *user);

/* Register the IMU raise-to-wake callback (fires once per raise gesture).
 * Wraps the raise hook armed by board_imu_init(). Pass NULL to clear. */
void board_register_raise(board_raise_cb_t cb, void *user);

#ifdef __cplusplus
}
#endif
