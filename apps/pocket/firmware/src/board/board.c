/* Board support for Waveshare ESP32-S3-Touch-AMOLED-1.8 V1.
 * Register references: waveshareteam/ESP32-S3-Touch-AMOLED-1.8 examples,
 * Arduino_FT3x68 and XPowersAXP2101. Keep the working SH8601 path intact.
 * Power rail and charger settings are retained from the board configuration.
 */

#include "board.h"
#include "pins.h"
#include "audio/audio.h"

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/sdmmc_host.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"
#include <string.h>

#if BOARD_VERSION == BOARD_VERSION_V1
#include "esp_lcd_sh8601.h"
#endif

static const char *TAG = "board";

/* Display handles, populated by board_display_init() (V1 path). NULL until then
 * and on the V2 stub build. The UI layer reads these via board_display_*(). */
static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_panel_io;

/* microSD mount point. LVGL's filesystem driver (lv_conf.h LV_FS_STDIO_*) maps
 * drive "S:" onto this exact path — keep the two in sync. */
#define BOARD_SD_MOUNT_POINT "/sdcard"
static sdmmc_card_t *s_sdcard;

#if BOARD_VERSION == BOARD_VERSION_V1
/* SH8601 init sequence for the Waveshare 1.8" AMOLED. esp_lcd_sh8601's built-in
 * default list is a placeholder ("consult the LCD supplier") that OMITS Sleep
 * Out (0x11): the panel powers up, accepts display-on + brightness, yet stays
 * asleep, so the screen reads pure black. This list prepends 0x11, matching the
 * Arduino_GFX Arduino_SH8601 sequence the reference firmware uses. MADCTL +
 * COLMOD (pixel format) are still sent by the driver before this list. */
static const sh8601_lcd_init_cmd_t s_sh8601_init_cmds[] = {
    {0x11, (uint8_t[]){0x00}, 0, 120},      /* Sleep Out, 120 ms settle */
    {0x44, (uint8_t[]){0x00, 0xC8}, 2, 0},  /* set tear scanline */
    {0x35, (uint8_t[]){0x00}, 0, 0},        /* tearing-effect line on */
    {0x53, (uint8_t[]){0x20}, 1, 10},       /* CTRL display: brightness control (BCTRL) on */
};
#endif

/* Input callbacks are dispatched from a task, never an ISR. */
static board_raise_cb_t s_raise_cb;
static void *s_raise_user;
static board_ptt_cb_t s_ptt_cb;
static void *s_ptt_user;
static board_raise_cb_t s_action_cb;
static void *s_action_user;
static TaskHandle_t s_input_task;
static bool s_touch_ready;

#define AXP2101_STATUS1 0x00
#define AXP2101_STATUS2 0x01
#define AXP2101_ADC_ENABLE 0x30
#define AXP2101_BAT_VOLTAGE 0x34
#define AXP2101_IRQ_ENABLE2 0x41
#define AXP2101_IRQ_STATUS2 0x49
#define AXP2101_BAT_DETECT 0x68
#define AXP2101_BAT_PERCENT 0xA4
#define AXP2101_PKEY_SHORT (1U << 3)

/* --------------------------------------------------------------------------
 * Small I2C register helpers — every device on the shared bus uses these.
 * -------------------------------------------------------------------------- */

/* Write one register byte to an I2C device on the shared bus. */
static esp_err_t i2c_write_reg(uint8_t addr, uint8_t reg, uint8_t val) {
  uint8_t buf[2] = {reg, val};
  return i2c_master_write_to_device(BOARD_I2C_PORT, addr, buf, sizeof(buf),
                                    pdMS_TO_TICKS(100));
}

/* Read `len` bytes starting at `reg` from an I2C device on the shared bus. */
static esp_err_t i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *out, size_t len) {
  return i2c_master_write_read_device(BOARD_I2C_PORT, addr, &reg, 1, out, len,
                                      pdMS_TO_TICKS(100));
}

/* Preserve unrelated PMIC flags and all rail/charger/power-key timings. */
static esp_err_t pmic_enable_bits(uint8_t reg, uint8_t bits) {
  uint8_t value;
  ESP_RETURN_ON_ERROR(i2c_read_reg(BOARD_I2C_ADDR_AXP2101, reg, &value, 1),
                      TAG, "PMIC read");
  return i2c_write_reg(BOARD_I2C_ADDR_AXP2101, reg, value | bits);
}

static void board_input_task(void *arg) {
  (void)arg;
  bool stable = false;
  bool previous = false;
  unsigned debounce = 0;
  unsigned pmic_poll = 0;
  for (;;) {
    bool pressed = gpio_get_level(BOARD_BTN_BOOT_GPIO) == BOARD_BTN_BOOT_ACTIVE;
    if (pressed != previous) {
      previous = pressed;
      debounce = 0;
    } else if (debounce < 3) {
      ++debounce;
    }
    if (debounce == 3 && stable != pressed) {
      stable = pressed;
      if (s_ptt_cb != NULL) s_ptt_cb(pressed, s_ptt_user);
    }
    /* The PMIC IRQ is routed through an IO expander. Poll its latched status
     * instead of inventing a direct ESP GPIO. W1C only the consumed short press. */
    if (++pmic_poll >= 5) {
      pmic_poll = 0;
      uint8_t status = 0;
      if (i2c_read_reg(BOARD_I2C_ADDR_AXP2101, AXP2101_IRQ_STATUS2, &status, 1)
              == ESP_OK && (status & AXP2101_PKEY_SHORT)) {
        if (i2c_write_reg(BOARD_I2C_ADDR_AXP2101, AXP2101_IRQ_STATUS2,
                          AXP2101_PKEY_SHORT) == ESP_OK && s_action_cb != NULL)
          s_action_cb(s_action_user);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

esp_err_t board_power_init(void) {
  if (s_input_task != NULL) return ESP_OK;
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "i2c for PMIC");
  ESP_RETURN_ON_ERROR(pmic_enable_bits(AXP2101_ADC_ENABLE, 1U), TAG,
                      "battery voltage measurement");
  ESP_RETURN_ON_ERROR(pmic_enable_bits(AXP2101_BAT_DETECT, 1U), TAG,
                      "battery detection");
  ESP_RETURN_ON_ERROR(pmic_enable_bits(AXP2101_IRQ_ENABLE2, AXP2101_PKEY_SHORT),
                      TAG, "PWR short-press interrupt");
  ESP_RETURN_ON_ERROR(i2c_write_reg(BOARD_I2C_ADDR_AXP2101,
                                   AXP2101_IRQ_STATUS2, AXP2101_PKEY_SHORT),
                      TAG, "clear stale PWR event");
  const gpio_config_t boot = {
      .pin_bit_mask = 1ULL << BOARD_BTN_BOOT_GPIO,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  ESP_RETURN_ON_ERROR(gpio_config(&boot), TAG, "BOOT input");
  ESP_RETURN_ON_FALSE(xTaskCreate(board_input_task, "board_input", 4096, NULL,
                                  4, &s_input_task) == pdPASS,
                      ESP_ERR_NO_MEM, TAG, "input task");
  ESP_LOGI(TAG, "BOOT hold-to-talk and PWR short press ready");
  return ESP_OK;
}

esp_err_t board_power_read(board_power_status_t *out) {
  if (out == NULL) return ESP_ERR_INVALID_ARG;
  memset(out, 0, sizeof(*out));
  uint8_t status[2];
  ESP_RETURN_ON_ERROR(i2c_read_reg(BOARD_I2C_ADDR_AXP2101, AXP2101_STATUS1,
                                  status, sizeof(status)), TAG, "battery status");
  out->present = (status[0] & (1U << 3)) != 0;
  out->charging = out->present && (status[1] >> 5) == 1;
  if (!out->present) return ESP_OK;
  uint8_t percent, voltage[2];
  ESP_RETURN_ON_ERROR(i2c_read_reg(BOARD_I2C_ADDR_AXP2101, AXP2101_BAT_PERCENT,
                                  &percent, 1), TAG, "battery percentage");
  ESP_RETURN_ON_FALSE(percent <= 100, ESP_ERR_INVALID_RESPONSE, TAG,
                      "battery gauge not ready");
  ESP_RETURN_ON_ERROR(i2c_read_reg(BOARD_I2C_ADDR_AXP2101, AXP2101_BAT_VOLTAGE,
                                  voltage, sizeof(voltage)), TAG, "battery voltage");
  out->percent = percent;
  out->millivolts = ((uint16_t)(voltage[0] & 0x1F) << 8) | voltage[1];
  return ESP_OK;
}

/* Convenience accessor: battery percentage (0..100), or <0 if unreadable. */
float board_battery_percent(void) {
  board_power_status_t s;
  if (board_power_read(&s) != ESP_OK || !s.present) {
    return -1.0f;
  }
  return (float)s.percent;
}

/* Convenience accessor: charging / VBUS-present state. */
bool board_is_charging(void) {
  board_power_status_t s;
  if (board_power_read(&s) != ESP_OK) {
    return false;
  }
  return s.charging;
}

/* --------------------------------------------------------------------------
 * Input registration — store the app-supplied edge callbacks. The actual
 * dispatch happens from board_input_task for BOOT/PWR.
 * -------------------------------------------------------------------------- */

void board_register_ptt(board_ptt_cb_t cb, void *user) {
  s_ptt_cb = cb;
  s_ptt_user = user;
  ESP_LOGI(TAG, "ptt callback %s", cb ? "registered" : "cleared");

}

void board_register_action(board_raise_cb_t cb, void *user) {
  s_action_cb = cb;
  s_action_user = user;
}

void board_register_raise(board_raise_cb_t cb, void *user) {
  s_raise_cb = cb;
  s_raise_user = user;
  ESP_LOGI(TAG, "raise callback %s", cb ? "registered" : "cleared");
  /* The IMU INT ISR (imu_int_isr) already dispatches through s_raise_cb. If
   * board_imu_init ran with on_raise == NULL (as board_init does), this is how
   * the app wires the wake hook after the fact. */
}

/* --------------------------------------------------------------------------
 * board_i2c_init — shared 400kHz bus (touch + IMU + RTC + PMIC + codec ctrl).
 * Idempotent: safe to call from multiple peripheral inits.
 * -------------------------------------------------------------------------- */
esp_err_t board_i2c_init(void) {
  static bool installed = false;
  if (installed) {
    return ESP_OK;
  }

  ESP_LOGI(TAG, "i2c: port %d sda=%d scl=%d @%dHz", BOARD_I2C_PORT,
           BOARD_I2C_SDA_GPIO, BOARD_I2C_SCL_GPIO, BOARD_I2C_FREQ_HZ);

  const i2c_config_t cfg = {
      .mode = I2C_MODE_MASTER,
      .sda_io_num = BOARD_I2C_SDA_GPIO,
      .scl_io_num = BOARD_I2C_SCL_GPIO,
      .sda_pullup_en = GPIO_PULLUP_ENABLE,
      .scl_pullup_en = GPIO_PULLUP_ENABLE,
      .master.clk_speed = BOARD_I2C_FREQ_HZ,
  };
  ESP_RETURN_ON_ERROR(i2c_param_config(BOARD_I2C_PORT, &cfg), TAG, "i2c cfg");
  ESP_RETURN_ON_ERROR(i2c_driver_install(BOARD_I2C_PORT, cfg.mode, 0, 0, 0), TAG,
                      "i2c install");

  installed = true;
  return ESP_OK;
}

/* --------------------------------------------------------------------------
 * board_display_init — AMOLED over QSPI; V1=SH8601, V2=CO5300.
 * -------------------------------------------------------------------------- */
esp_err_t board_display_init(void) {
  ESP_LOGI(TAG, "display: %dx%d QSPI driver=%s", BOARD_LCD_PANEL_WIDTH,
           BOARD_LCD_PANEL_HEIGHT,
#if BOARD_VERSION == BOARD_VERSION_V1
           "SH8601 (V1)"
#else
           "CO5300 (V2)"
#endif
  );

  /* QSPI bus: one clock + four data lines (SDIO0..SDIO3). CS is owned by the
   * panel IO config below, not the bus. */
  const spi_bus_config_t bus = {
      .sclk_io_num = BOARD_LCD_QSPI_CLK_GPIO,
      .data0_io_num = BOARD_LCD_QSPI_D0_GPIO,
      .data1_io_num = BOARD_LCD_QSPI_D1_GPIO,
      .data2_io_num = BOARD_LCD_QSPI_D2_GPIO,
      .data3_io_num = BOARD_LCD_QSPI_D3_GPIO,
      .max_transfer_sz = BOARD_LCD_PANEL_WIDTH * BOARD_LCD_PANEL_HEIGHT *
                         (BOARD_LCD_BITS_PER_PX / 8),
      .flags = SPICOMMON_BUSFLAG_QUAD,
  };
  ESP_RETURN_ON_ERROR(spi_bus_initialize(BOARD_LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO),
                      TAG, "qspi bus");

#if BOARD_VERSION == BOARD_VERSION_V1
  /* SH8601 over QSPI via the esp_lcd_sh8601 managed component. The driver pushes
   * the vendor init list (sleep-out, RGB565 pixel format, gamma, display-on),
   * so we only describe the bus + panel and then reset/init/brighten/turn-on.
   * The reference (app-pixels Arduino_SH8601) uses no MCU reset GPIO and a 0,0
   * column/row offset for the full 368x448 panel — mirrored here.
   *
   * The on_color_trans_done callback is left NULL: the UI layer registers its
   * own (to signal lv_display_flush_ready) via esp_lcd_panel_io_register_event_
   * callbacks() once it owns the LVGL display. */
  esp_lcd_panel_io_spi_config_t io_config =
      SH8601_PANEL_IO_QSPI_CONFIG(BOARD_LCD_QSPI_CS_GPIO, NULL, NULL);
  ESP_RETURN_ON_ERROR(
      esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)BOARD_LCD_SPI_HOST,
                               &io_config, &s_panel_io),
      TAG, "panel io");

  sh8601_vendor_config_t vendor_config = {
      .init_cmds = s_sh8601_init_cmds, /* adds Sleep Out (0x11) — see above */
      .init_cmds_size = sizeof(s_sh8601_init_cmds) / sizeof(s_sh8601_init_cmds[0]),
      .flags = {.use_qspi_interface = 1},
  };
  const esp_lcd_panel_dev_config_t panel_config = {
      .reset_gpio_num = BOARD_LCD_RESET_GPIO, /* -1 => software reset (0x01) */
      .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
      .bits_per_pixel = BOARD_LCD_BITS_PER_PX,
      .vendor_config = &vendor_config,
  };
  ESP_RETURN_ON_ERROR(esp_lcd_new_panel_sh8601(s_panel_io, &panel_config, &s_panel),
                      TAG, "sh8601 panel");
  ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "panel reset");
  ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "panel init");

  /* Write Display Brightness (SH8601 cmd 0x51). 0x00 is fully dark — a common
   * "it works but the screen is black" trap — so drive it to max here. */
  const uint8_t brightness = 0xFF;
  ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(s_panel_io, 0x51, &brightness, 1),
                      TAG, "brightness");

  ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "disp on");
  ESP_LOGI(TAG, "display: SH8601 up, panel=%p io=%p", (void *)s_panel,
           (void *)s_panel_io);
  return ESP_OK;
#else
  /* TODO(hw): CO5300 (V2) — same shape via the esp_lcd_co5300 component
   * (add it to idf_component.yml + the BOARD_VERSION_V1 include guard). Left a
   * stub: s_panel stays NULL, so ui_init() skips the LVGL display binding and
   * logs rather than crashing. The user's board is V1, so V1 is implemented
   * first; build/flash `companion_v1`. */
  (void)bus;
  ESP_LOGW(TAG, "display: CO5300 (V2) init is still a TODO(hw) stub");
  return ESP_OK;
#endif
}

/* Display handle accessors for the UI/LVGL binding (NULL until brought up). */
esp_lcd_panel_handle_t board_display_panel(void) { return s_panel; }
esp_lcd_panel_io_handle_t board_display_io(void) { return s_panel_io; }

/* FT3168 native portrait coordinates, polled by the LVGL input driver.
 * Source: Waveshare examples/arduino/libraries/Arduino_DriveBus/src/touch_chip/
 * Arduino_FT3x68.{h,cpp}. No coordinate swap or rotation on the V1 panel. */
esp_err_t board_touch_init(void) {
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "i2c for touch");
#if BOARD_VERSION == BOARD_VERSION_V1
  uint8_t chip_id;
  ESP_RETURN_ON_ERROR(i2c_read_reg(BOARD_I2C_ADDR_FT3168, 0xA0, &chip_id, 1),
                      TAG, "FT3168 probe");
  /* Active mode continuously reports contact/release for touch-and-hold. */
  ESP_RETURN_ON_ERROR(i2c_write_reg(BOARD_I2C_ADDR_FT3168, 0xA5, 0x00),
                      TAG, "FT3168 active mode");
  vTaskDelay(pdMS_TO_TICKS(20));
  s_touch_ready = true;
  ESP_LOGI(TAG, "touch: FT3168 @0x%02x id=0x%02x", BOARD_I2C_ADDR_FT3168, chip_id);
  return ESP_OK;
#else
  return ESP_ERR_NOT_SUPPORTED;
#endif
}

esp_err_t board_touch_read(uint16_t *x, uint16_t *y, bool *pressed) {
  if (x == NULL || y == NULL || pressed == NULL) return ESP_ERR_INVALID_ARG;
  *pressed = false;
  if (!s_touch_ready) return ESP_ERR_INVALID_STATE;
#if BOARD_VERSION == BOARD_VERSION_V1
  /* Finger count plus first contact's X/Y; one transaction avoids torn points. */
  uint8_t report[5];
  esp_err_t err = i2c_read_reg(BOARD_I2C_ADDR_FT3168, 0x02, report, sizeof(report));
  if (err != ESP_OK) return err;
  unsigned contacts = report[0] & 0x0F;
  if (contacts == 0 || contacts > 2) return ESP_OK;
  uint16_t tx = ((uint16_t)(report[1] & 0x0F) << 8) | report[2];
  uint16_t ty = ((uint16_t)(report[3] & 0x0F) << 8) | report[4];
  if (tx >= BOARD_LCD_PANEL_WIDTH || ty >= BOARD_LCD_PANEL_HEIGHT) return ESP_OK;
  *x = tx;
  *y = ty;
  *pressed = true;
  return ESP_OK;
#else
  return ESP_ERR_NOT_SUPPORTED;
#endif
}

/* One owner for I2S and codec initialization, including diagnostic callers. */
esp_err_t board_audio_init(void) { return audio_init(); }

/* --------------------------------------------------------------------------
 * board_imu_init — QMI8658 6-axis IMU + raise-to-wake interrupt hook.
 * -------------------------------------------------------------------------- */

/* ISR for the IMU INT line. Kept tiny: it just defers to the registered
 * callback. A real build should notify a task rather than call user code in
 * ISR context, but the shape documents the wake path. */
#if BOARD_IMU_INT_GPIO >= 0
static void IRAM_ATTR imu_int_isr(void *arg) {
  (void)arg;
  if (s_raise_cb != NULL) {
    /* TODO(hw): in ISR context, prefer xTaskNotifyFromISR / a queue and run
     * s_raise_cb from a task. Calling it directly here is a placeholder. */
    s_raise_cb(s_raise_user);
  }
}
#endif

esp_err_t board_imu_init(board_raise_cb_t on_raise, void *user) {
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "i2c for imu");

  ESP_LOGI(TAG, "imu: QMI8658 @0x%02x", BOARD_I2C_ADDR_QMI8658);

  /* TODO(hw): verify WHO_AM_I, then configure accel/gyro ODR + ranges. For
   * raise-to-wake, configure the QMI8658 "wake on motion" / any-motion engine
   * and route it to INT1 so the device can stay in light sleep until raised. */
  uint8_t whoami = 0;
  (void)i2c_read_reg(BOARD_I2C_ADDR_QMI8658, /*WHO_AM_I*/ 0x00, &whoami, 1);
  ESP_LOGI(TAG, "imu: WHO_AM_I=0x%02x (TODO(hw): assert expected id)", whoami);

  s_raise_cb = on_raise;
  s_raise_user = user;

  /* Arm the raise-to-wake interrupt only if the caller asked for it. */
#if BOARD_IMU_INT_GPIO >= 0
  if (on_raise != NULL) {
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BOARD_IMU_INT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&io), TAG, "imu int gpio");

    /* gpio_install_isr_service may already be installed by another peripheral;
     * ESP_ERR_INVALID_STATE in that case is benign. */
    esp_err_t isr_err = gpio_install_isr_service(0);
    if (isr_err != ESP_OK && isr_err != ESP_ERR_INVALID_STATE) {
      return isr_err;
    }
    ESP_RETURN_ON_ERROR(
        gpio_isr_handler_add(BOARD_IMU_INT_GPIO, imu_int_isr, NULL), TAG,
        "imu isr");
    ESP_LOGI(TAG, "imu: raise-to-wake armed on GPIO%d", BOARD_IMU_INT_GPIO);
  }
#endif

  ESP_LOGW(TAG, "imu: QMI8658 register config is a TODO(hw) stub");
  return ESP_OK;
}

/* --------------------------------------------------------------------------
 * board_rtc_init — PCF85063 battery-backed RTC (owns the offline clock).
 * -------------------------------------------------------------------------- */
esp_err_t board_rtc_init(void) {
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "i2c for rtc");

  ESP_LOGI(TAG, "rtc: PCF85063 @0x%02x", BOARD_I2C_ADDR_PCF85063);

  /* TODO(hw): read Control_1; if the oscillator-stop flag is set the RTC lost
   * power and the time is invalid — surface that so the bridge re-syncs the
   * clock via the AmbientFace.now field (protocol.ts). Otherwise leave the
   * running time intact. Optionally configure the alarm registers to back
   * on-device reminders (SCOPE.md §4 "RTC-backed reminders fire offline"). */
  uint8_t ctrl1 = 0;
  (void)i2c_read_reg(BOARD_I2C_ADDR_PCF85063, /*Control_1*/ 0x00, &ctrl1, 1);
  ESP_LOGI(TAG, "rtc: Control_1=0x%02x (TODO(hw): check OS/clock-integrity bit)",
           ctrl1);

  ESP_LOGW(TAG, "rtc: PCF85063 time/alarm config is a TODO(hw) stub");
  return ESP_OK;
}

/* --------------------------------------------------------------------------
 * board_sdcard_init — microSD (TF) slot: offline capture queue + LVGL assets.
 * -------------------------------------------------------------------------- */
esp_err_t board_sdcard_init(void) {
  ESP_LOGI(TAG, "sdcard: SDMMC 1-bit clk=%d cmd=%d d0=%d -> %s", BOARD_SD_CLK_GPIO,
           BOARD_SD_CMD_GPIO, BOARD_SD_D0_GPIO, BOARD_SD_MOUNT_POINT);

  /* SDMMC host in 1-bit mode (only D0 is wired on this board — the reference
   * exposes a single SDMMC_DATA line). The ESP32-S3 routes the SDMMC slot
   * through the GPIO matrix, so clk/cmd/d0 may be the board's 2/1/3. */
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.flags = SDMMC_HOST_FLAG_1BIT;
  host.max_freq_khz = SDMMC_FREQ_DEFAULT;

  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.width = 1;
  slot.clk = BOARD_SD_CLK_GPIO;
  slot.cmd = BOARD_SD_CMD_GPIO;
  slot.d0 = BOARD_SD_D0_GPIO;
  slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP; /* belt-and-braces; externals expected */

  const esp_vfs_fat_sdmmc_mount_config_t mount_cfg = {
      .format_if_mount_failed = false, /* never reformat the user's card */
      .max_files = 5,
      .allocation_unit_size = 16 * 1024,
  };

  sdmmc_card_t *card = NULL;
  esp_err_t err =
      esp_vfs_fat_sdmmc_mount(BOARD_SD_MOUNT_POINT, &host, &slot, &mount_cfg, &card);
  if (err != ESP_OK) {
    /* No card inserted / unformatted / wiring issue. Non-fatal by design: the
     * device still boots and shows the ambient face; only the SD-backed art and
     * the offline capture queue (SCOPE §3 Tier 2) are unavailable. Do NOT abort
     * board_init over a missing card. */
    ESP_LOGW(TAG, "sdcard: mount failed (%s) — continuing without SD assets",
             esp_err_to_name(err));
    return ESP_OK;
  }

  s_sdcard = card;
  ESP_LOGI(TAG, "sdcard: mounted at %s (%llu MB, name '%s')", BOARD_SD_MOUNT_POINT,
           ((uint64_t)card->csd.capacity * card->csd.sector_size) / (1024ULL * 1024ULL),
           card->cid.name);
  return ESP_OK;
}

/* --------------------------------------------------------------------------
 * board_init — full bring-up in dependency order.
 * -------------------------------------------------------------------------- */
esp_err_t board_init(void) {
  ESP_LOGI(TAG, "board_init: Waveshare ESP32-S3-Touch-AMOLED-1.8 (%s)",
           BOARD_VERSION_NAME);

  /* The factory power configuration already powers this board. Bring up the
   * shared I2C bus and PMIC input/telemetry before the display and touch. */
  ESP_RETURN_ON_ERROR(board_power_init(), TAG, "power");
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "i2c");
  ESP_RETURN_ON_ERROR(board_rtc_init(), TAG, "rtc");
  ESP_RETURN_ON_ERROR(board_imu_init(NULL, NULL), TAG, "imu");
  ESP_RETURN_ON_ERROR(board_display_init(), TAG, "display");
  ESP_RETURN_ON_ERROR(board_touch_init(), TAG, "touch");
  /* Main initializes audio separately so a codec failure can be reported
   * without hiding the focus task. audio.c is the single I2S/codec owner;
   * board_audio_init() delegates to the same idempotent entry point. */
  ESP_RETURN_ON_ERROR(board_sdcard_init(), TAG, "sdcard");

  ESP_LOGI(TAG, "board_init: complete");
  return ESP_OK;
}
