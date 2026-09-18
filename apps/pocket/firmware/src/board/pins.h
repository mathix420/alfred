#pragma once

/*
 * pins.h — GPIO pin map for the Waveshare ESP32-S3-Touch-AMOLED-1.8.
 *
 * Pins below are taken from a VERIFIED reference for this exact board
 * (app-pixels/ai-assistant-claude, pin_config.h @ v1.1.0), which boots the
 * panel + touch + audio on real hardware. They are board-level (shared by the
 * V1 and V2 revisions — only the display/touch *controller chips* differ, not
 * their wiring). Earlier values in this file were guesses and were wrong on
 * essentially every bus; if you see a black screen after editing, re-check
 * against the schematic before anything else.
 *
 * Conventions:
 *   - A value of -1 marks "not connected / not present on this board".
 *   - Buses are grouped; peripherals on a shared bus reference the bus pins.
 */

#include "driver/gpio.h"

/* ----------------------------------------------------------------------------
 * Shared I2C bus (touch + IMU + RTC + AXP2101 PMIC all hang off this one bus)
 * Reference: IIC_SDA=15, IIC_SCL=14.
 * ------------------------------------------------------------------------- */
#define BOARD_I2C_PORT          0           /* I2C peripheral 0 */
#define BOARD_I2C_SDA_GPIO      15
#define BOARD_I2C_SCL_GPIO      14
#define BOARD_I2C_FREQ_HZ       400000      /* 400kHz fast-mode; drop to 100k if unstable */

/* 7-bit device addresses on the shared bus. */
#define BOARD_I2C_ADDR_AXP2101  0x34        /* PMIC / battery gauge */
#define BOARD_I2C_ADDR_PCF85063 0x51        /* RTC */
#define BOARD_I2C_ADDR_QMI8658  0x6B        /* IMU (0x6A if SA0 strapped low) */
#define BOARD_I2C_ADDR_FT3168   0x38        /* V1 touch controller (FT6x36 family) */
#define BOARD_I2C_ADDR_CST816   0x15        /* V2 touch controller */
#define BOARD_I2C_ADDR_ES8311   0x18        /* audio codec control */
#define BOARD_I2C_ADDR_TCA9554  0x20        /* peripheral reset / interrupt expander */

/* ----------------------------------------------------------------------------
 * AMOLED display — QSPI (368x448). V1 = SH8601, V2 = CO5300.
 * QSPI uses one clock + chip-select + four data lines (SDIO0..SDIO3).
 * Reference: SCLK=11, CS=12, SDIO0..3 = 4,5,6,7. NO MCU reset GPIO (the
 * reference constructs the panel with GFX_NOT_DEFINED for reset — the panel is
 * reset via power-on / the PMIC, not an ESP GPIO), so RESET = -1.
 * ------------------------------------------------------------------------- */
#define BOARD_LCD_SPI_HOST      1           /* SPI2_HOST */
#define BOARD_LCD_QSPI_CLK_GPIO 11
#define BOARD_LCD_QSPI_CS_GPIO  12
#define BOARD_LCD_QSPI_D0_GPIO  4
#define BOARD_LCD_QSPI_D1_GPIO  5
#define BOARD_LCD_QSPI_D2_GPIO  6
#define BOARD_LCD_QSPI_D3_GPIO  7
#define BOARD_LCD_RESET_GPIO    -1          /* no MCU reset line on this board */
#define BOARD_LCD_TE_GPIO       -1          /* tearing-effect line; -1 if unused */
#define BOARD_LCD_PANEL_WIDTH   368
#define BOARD_LCD_PANEL_HEIGHT  448
#define BOARD_LCD_BITS_PER_PX   16          /* RGB565 */

/* Touch interrupt is a direct ESP GPIO. V1 TP_RESET is TCA9554 P2 (EXIO2),
 * not a direct GPIO: see the official board schematic's LCD pin table.
 * P0 resets the display and P1 enables its power; never toggle them here. */
#define BOARD_TOUCH_INT_GPIO    21
#define BOARD_TOUCH_RST_GPIO    -1
#define BOARD_TOUCH_RST_EXIO    2

/* ----------------------------------------------------------------------------
 * Audio — ES8311 codec over I2S (control plane is on the shared I2C bus above)
 * Reference: MCLK=16, BCLK=9, WS/LRCK=45, plus a speaker-amp enable (PA) on 46.
 * Official Waveshare schematic: GPIO8 -> ES8311 DSDIN (speaker),
 * GPIO10 <- ES8311 ASDOUT (microphone). This matches the 15_ES8311 demo.
 * ------------------------------------------------------------------------- */
#define BOARD_I2S_PORT          0           /* I2S peripheral 0 */
#define BOARD_I2S_MCLK_GPIO     16          /* master clock to codec */
#define BOARD_I2S_BCLK_GPIO     9           /* bit clock */
#define BOARD_I2S_LRCK_GPIO     45          /* word/LR clock */
#define BOARD_I2S_DOUT_GPIO     8           /* ESP -> codec (speaker / TTS playback) */
#define BOARD_I2S_DIN_GPIO      10          /* codec -> ESP (onboard mic / PTT capture) */
#define BOARD_AUDIO_PA_EN_GPIO  46          /* speaker amp enable (PA) */

/* ----------------------------------------------------------------------------
 * microSD (TF) slot — SDMMC 1-bit. Offline capture queue + LVGL assets.
 * Reference: CLK=2, CMD=1, D0=3.
 * ------------------------------------------------------------------------- */
#define BOARD_SD_CLK_GPIO       2
#define BOARD_SD_CMD_GPIO       1
#define BOARD_SD_D0_GPIO        3
#define BOARD_SD_DET_GPIO       -1          /* card-detect; -1 if not wired */

/* ----------------------------------------------------------------------------
 * Buttons — BOOT (GPIO0, hold-to-talk) + PWR (PMIC short press action).
 * PWR is read from AXP2101 IRQ status over I2C. Its hardware long-press
 * power-off timing and behavior remain configured by the PMIC.
 * ------------------------------------------------------------------------- */
#define BOARD_BTN_BOOT_GPIO     0
#define BOARD_BTN_BOOT_ACTIVE   0           /* active-low */
#define BOARD_BTN_PWR_GPIO      -1          /* -1 => sampled via AXP2101 IRQ, see board_power_init */

/* QMI8658 INT1 is on expander EXIO6, not an ESP GPIO. No direct IRQ. */
#define BOARD_IMU_INT_GPIO      -1

/* AXP2101 IRQB is on expander EXIO5, not an ESP GPIO. Poll latched PMIC
 * status over I2C for PWR short presses; -1 deliberately skips a GPIO IRQ. */
#define BOARD_PMIC_INT_GPIO     -1
