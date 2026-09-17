// SPDX-License-Identifier: MIT
// ES8311 control values follow Waveshare's 15_ES8311 example (Espressif driver)
// at waveshareteam/ESP32-S3-Touch-AMOLED-1.8, and Espressif esp_codec_dev's
// ES8311 suspend sequence. I2S MCLK is always sample_rate * 256.
#include "audio/audio.h"

#include <stdatomic.h>
#include "board/board.h"
#include "board/pins.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "audio";
#define PLAYBACK_RING_BYTES (32 * 1024)
#define DMA_FRAME_SAMPLES 320
#define DMA_DESCRIPTORS 4

static i2s_chan_handle_t s_tx_chan;
static i2s_chan_handle_t s_rx_chan;
static bool s_tx_enabled;
static bool s_rx_enabled;
static uint32_t s_sample_rate;
static bool s_initialized;
static SemaphoreHandle_t s_control;
static RingbufHandle_t s_play_ring;
static atomic_bool s_recording;
static atomic_bool s_playing;
static atomic_bool s_capture_running;
static atomic_bool s_play_running;
static atomic_bool s_play_finish;
static atomic_bool s_play_abort;
static alfred_mic_cb_t s_mic_cb;
static void *s_mic_user;

static esp_err_t codec_write(uint8_t reg, uint8_t value) {
  const uint8_t data[] = {reg, value};
  return i2c_master_write_to_device(BOARD_I2C_PORT, BOARD_I2C_ADDR_ES8311,
                                    data, sizeof(data), pdMS_TO_TICKS(100));
}

/* The following rates all use the same 256fs divider row in Waveshare's
 * coefficient table. Reject unknown rates instead of producing wrong audio. */
static bool supported_rate(uint32_t rate) {
  switch (rate) {
    case 8000: case 11025: case 12000: case 16000: case 22050:
    case 24000: case 32000: case 44100: case 48000: return true;
    default: return false;
  }
}

static esp_err_t codec_init(void) {
  static const uint8_t init[][2] = {
      {0x00, 0x1F}, {0x00, 0x00}, {0x00, 0x80}, // reset, slave mode
      {0x01, 0x3F}, // MCLK pin, normal polarity, clocks enabled
      {0x02, 0x00}, {0x03, 0x10}, {0x04, 0x10}, {0x05, 0x00},
      {0x06, 0x03}, {0x07, 0x00}, {0x08, 0xFF}, // 256fs dividers
      {0x09, 0x0C}, {0x0A, 0x0C}, // Philips I2S, 16-bit ADC and DAC
      {0x0D, 0x01}, {0x0E, 0xFF}, // analog on; ADC/PGA powered down at rest
      {0x12, 0x02}, {0x13, 0x10}, {0x14, 0x00}, // DAC and mic off at rest
      {0x16, 0x03}, {0x17, 0x00}, {0x1C, 0x6A}, // 18dB ADC gain; DC filter
      {0x31, 0x60}, {0x32, 0xBF}, {0x37, 0x08}, // muted, 75% volume
  };
  for (size_t i = 0; i < sizeof(init) / sizeof(init[0]); ++i)
    ESP_RETURN_ON_ERROR(codec_write(init[i][0], init[i][1]), TAG, "codec init");
  return ESP_OK;
}

static esp_err_t codec_mic(bool enabled) {
  /* Disable the analog PGA/ADC and mic bias between PTT sessions, as in the
   * Espressif ES8311 suspend path. The physical mic supply is board-wired. */
  esp_err_t err = codec_write(0x17, enabled ? 0xC8 : 0x00);
  esp_err_t power_err = codec_write(0x0E, enabled ? 0x02 : 0xFF);
  esp_err_t bias_err = codec_write(0x14, enabled ? 0x1A : 0x00);
  return err != ESP_OK ? err : power_err != ESP_OK ? power_err : bias_err;
}

static esp_err_t codec_speaker(bool enabled) {
  if (!enabled) gpio_set_level(BOARD_AUDIO_PA_EN_GPIO, 0);
  esp_err_t err = codec_write(0x31, enabled ? 0x00 : 0x60);
  esp_err_t power_err = codec_write(0x12, enabled ? 0x00 : 0x02);
  if (err == ESP_OK && power_err == ESP_OK && enabled)
    gpio_set_level(BOARD_AUDIO_PA_EN_GPIO, 1);
  return err != ESP_OK ? err : power_err;
}

/* Both directions share clocks and are used exclusively. Handles stay alive;
 * change the clock only after the old audio task and channels have stopped. */
static esp_err_t set_sample_rate(uint32_t rate) {
  if (!supported_rate(rate)) return ESP_ERR_NOT_SUPPORTED;
  if (rate == s_sample_rate) return ESP_OK;
  const i2s_std_clk_config_t clock = I2S_STD_CLK_DEFAULT_CONFIG(rate);
  ESP_RETURN_ON_ERROR(i2s_channel_reconfig_std_clock(s_tx_chan, &clock), TAG, "TX clock");
  ESP_RETURN_ON_ERROR(i2s_channel_reconfig_std_clock(s_rx_chan, &clock), TAG, "RX clock");
  s_sample_rate = rate;
  return ESP_OK;
}

static void capture_task(void *arg) {
  (void)arg;
  uint8_t pcm[ALFRED_MIC_FRAME_SAMPLES * sizeof(int16_t)];
  while (atomic_load(&s_recording)) {
    size_t got = 0;
    // ESP-IDF I2S timeout is milliseconds, not FreeRTOS ticks.
    esp_err_t err = i2s_channel_read(s_rx_chan, pcm, sizeof(pcm), &got, 100);
    if (err == ESP_OK && got && atomic_load(&s_recording) && s_mic_cb)
      s_mic_cb(pcm, got, s_mic_user);
    else if (err != ESP_OK && err != ESP_ERR_TIMEOUT)
      ESP_LOGW(TAG, "capture: %s", esp_err_to_name(err));
  }
  atomic_store(&s_capture_running, false);
  vTaskDelete(NULL);
}

static void play_task(void *arg) {
  (void)arg;
  for (;;) {
    size_t len = 0;
    uint8_t *pcm = xRingbufferReceiveUpTo(s_play_ring, &len,
                                         pdMS_TO_TICKS(20), 1024);
    if (pcm == NULL) {
      if (atomic_load(&s_play_finish) || atomic_load(&s_play_abort)) break;
      continue;
    }
    size_t offset = 0;
    while (offset < len && !atomic_load(&s_play_abort)) {
      size_t written = 0;
      esp_err_t err = i2s_channel_write(s_tx_chan, pcm + offset, len - offset,
                                       &written, 100);
      offset += written;
      if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
        ESP_LOGW(TAG, "playback: %s", esp_err_to_name(err));
        atomic_store(&s_play_abort, true);
      }
    }
    vRingbufferReturnItem(s_play_ring, pcm);
    if (atomic_load(&s_play_abort)) break;
  }
  if (!atomic_load(&s_play_abort)) {
    /* channel_write queues DMA, so give its final descriptors time to reach
     * the DAC before muting. Padding is generated by auto_clear. */
    uint32_t tail_ms = DMA_DESCRIPTORS * DMA_FRAME_SAMPLES * 1000 / s_sample_rate + 10;
    vTaskDelay(pdMS_TO_TICKS(tail_ms));
  }
  atomic_store(&s_play_running, false);
  vTaskDelete(NULL);
}

static void discard_playback(void) {
  size_t len;
  void *item;
  while ((item = xRingbufferReceive(s_play_ring, &len, 0)) != NULL)
    vRingbufferReturnItem(s_play_ring, item);
}

static esp_err_t stop_playback(bool abort) {
  if (!atomic_load(&s_playing)) return ESP_OK;
  atomic_store(&s_play_abort, abort);
  atomic_store(&s_play_finish, true);
  while (atomic_load(&s_play_running)) vTaskDelay(pdMS_TO_TICKS(5));
  esp_err_t err = codec_speaker(false);
  if (s_tx_enabled) {
    i2s_channel_disable(s_tx_chan);
    s_tx_enabled = false;
  }
  discard_playback();
  atomic_store(&s_playing, false);
  return err;
}

static esp_err_t stop_capture(void) {
  if (!atomic_load(&s_recording)) return ESP_OK;
  atomic_store(&s_recording, false);
  while (atomic_load(&s_capture_running)) vTaskDelay(pdMS_TO_TICKS(5));
  esp_err_t err = codec_mic(false);
  if (s_rx_enabled) {
    i2s_channel_disable(s_rx_chan);
    s_rx_enabled = false;
  }
  if (s_tx_enabled) {
    i2s_channel_disable(s_tx_chan);
    s_tx_enabled = false;
  }
  s_mic_cb = NULL;
  s_mic_user = NULL;
  return err;
}

esp_err_t audio_init(void) {
  if (s_initialized) return ESP_OK;
  ESP_RETURN_ON_ERROR(board_i2c_init(), TAG, "shared I2C");
  const gpio_config_t pa = {
      .pin_bit_mask = 1ULL << BOARD_AUDIO_PA_EN_GPIO,
      .mode = GPIO_MODE_OUTPUT,
  };
  ESP_RETURN_ON_ERROR(gpio_config(&pa), TAG, "speaker amp GPIO");
  gpio_set_level(BOARD_AUDIO_PA_EN_GPIO, 0);
  s_control = xSemaphoreCreateMutex();
  s_play_ring = xRingbufferCreate(PLAYBACK_RING_BYTES, RINGBUF_TYPE_BYTEBUF);
  if (!s_control || !s_play_ring) goto fail;

  i2s_chan_config_t channels = I2S_CHANNEL_DEFAULT_CONFIG(BOARD_I2S_PORT, I2S_ROLE_MASTER);
  channels.dma_frame_num = DMA_FRAME_SAMPLES;
  channels.dma_desc_num = DMA_DESCRIPTORS;
  channels.auto_clear = true;
  if (i2s_new_channel(&channels, &s_tx_chan, &s_rx_chan) != ESP_OK) goto fail;
  const i2s_std_config_t config = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(ALFRED_MIC_SAMPLE_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                     I2S_SLOT_MODE_MONO),
      .gpio_cfg = {
          .mclk = BOARD_I2S_MCLK_GPIO, .bclk = BOARD_I2S_BCLK_GPIO,
          .ws = BOARD_I2S_LRCK_GPIO, .dout = BOARD_I2S_DOUT_GPIO,
          .din = BOARD_I2S_DIN_GPIO,
      },
  };
  if (i2s_channel_init_std_mode(s_tx_chan, &config) != ESP_OK ||
      i2s_channel_init_std_mode(s_rx_chan, &config) != ESP_OK ||
      codec_init() != ESP_OK) goto fail;
  s_sample_rate = ALFRED_MIC_SAMPLE_RATE;
  s_initialized = true;
  ESP_LOGI(TAG, "ES8311 ready: mic GPIO%d, speaker GPIO%d, PTT capture 16kHz mono",
           BOARD_I2S_DIN_GPIO, BOARD_I2S_DOUT_GPIO);
  return ESP_OK;
fail:
  if (s_tx_chan) { i2s_del_channel(s_tx_chan); s_tx_chan = NULL; }
  if (s_rx_chan) { i2s_del_channel(s_rx_chan); s_rx_chan = NULL; }
  if (s_play_ring) { vRingbufferDelete(s_play_ring); s_play_ring = NULL; }
  if (s_control) { vSemaphoreDelete(s_control); s_control = NULL; }
  return ESP_FAIL;
}

esp_err_t audio_record_start(alfred_mic_cb_t cb, void *user) {
  if (!s_initialized) return ESP_ERR_INVALID_STATE;
  if (!cb) return ESP_ERR_INVALID_ARG;
  xSemaphoreTake(s_control, portMAX_DELAY);
  esp_err_t err = ESP_OK;
  if (atomic_load(&s_recording)) goto done;
  err = stop_playback(true); // BOOT may interrupt a spoken reply immediately.
  if (err != ESP_OK) goto done;
  if ((err = set_sample_rate(ALFRED_MIC_SAMPLE_RATE)) != ESP_OK) goto done;
  if ((err = codec_mic(true)) != ESP_OK) goto cleanup;
  /* In IDF full-duplex mode RX is a clock slave of TX. Keep TX running with
   * zero-filled DMA while recording; the DAC and speaker amp stay off. */
  if ((err = i2s_channel_enable(s_tx_chan)) != ESP_OK) goto cleanup;
  s_tx_enabled = true;
  if ((err = i2s_channel_enable(s_rx_chan)) != ESP_OK) goto cleanup;
  s_rx_enabled = true;
  s_mic_cb = cb;
  s_mic_user = user;
  atomic_store(&s_recording, true);
  atomic_store(&s_capture_running, true);
  if (xTaskCreate(capture_task, "audio_capture", 4096, NULL, 6, NULL) != pdPASS) {
    atomic_store(&s_capture_running, false);
    stop_capture();
    err = ESP_ERR_NO_MEM;
  }
  goto done;
cleanup:
  codec_mic(false);
  if (s_tx_enabled) {
    i2s_channel_disable(s_tx_chan);
    s_tx_enabled = false;
  }
done:
  xSemaphoreGive(s_control);
  return err;
}

esp_err_t audio_record_stop(void) {
  if (!s_initialized) return ESP_OK;
  xSemaphoreTake(s_control, portMAX_DELAY);
  esp_err_t err = stop_capture();
  xSemaphoreGive(s_control);
  return err;
}

bool audio_is_recording(void) { return atomic_load(&s_recording); }

esp_err_t audio_play_begin(const alfred_audio_format_t *fmt) {
  if (!s_initialized) return ESP_ERR_INVALID_STATE;
  if (!fmt) return ESP_ERR_INVALID_ARG;
  if (fmt->encoding != ALFRED_AUDIO_ENC_PCM_S16LE || fmt->channels != 1 ||
      !supported_rate(fmt->sample_rate)) return ESP_ERR_NOT_SUPPORTED;
  xSemaphoreTake(s_control, portMAX_DELAY);
  esp_err_t err = ESP_ERR_INVALID_STATE;
  if (atomic_load(&s_recording)) goto done; // Ignore a late reply during PTT.
  if ((err = stop_playback(true)) != ESP_OK) goto done;
  if ((err = set_sample_rate(fmt->sample_rate)) != ESP_OK) goto done;
  discard_playback();
  if ((err = i2s_channel_enable(s_tx_chan)) != ESP_OK) goto done;
  s_tx_enabled = true;
  if ((err = codec_speaker(true)) != ESP_OK) goto cleanup;
  atomic_store(&s_play_finish, false);
  atomic_store(&s_play_abort, false);
  atomic_store(&s_playing, true);
  atomic_store(&s_play_running, true);
  if (xTaskCreate(play_task, "audio_play", 4096, NULL, 6, NULL) != pdPASS) {
    atomic_store(&s_play_running, false);
    stop_playback(true);
    err = ESP_ERR_NO_MEM;
  }
  goto done;
cleanup:
  codec_speaker(false);
  i2s_channel_disable(s_tx_chan);
  s_tx_enabled = false;
done:
  xSemaphoreGive(s_control);
  return err;
}

esp_err_t audio_play_pcm(const uint8_t *pcm, size_t len, uint32_t timeout_ms) {
  if (!s_initialized) return ESP_ERR_INVALID_STATE;
  if (!pcm || !len || (len & 1) || len > PLAYBACK_RING_BYTES) return ESP_ERR_INVALID_ARG;
  if (xSemaphoreTake(s_control, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) return ESP_ERR_TIMEOUT;
  esp_err_t err = ESP_ERR_INVALID_STATE;
  if (atomic_load(&s_playing) && !atomic_load(&s_play_finish) && !atomic_load(&s_play_abort))
    err = xRingbufferSend(s_play_ring, pcm, len, pdMS_TO_TICKS(timeout_ms)) == pdTRUE
              ? ESP_OK : ESP_ERR_TIMEOUT;
  xSemaphoreGive(s_control);
  return err;
}

static esp_err_t finish_playback(bool abort) {
  if (!s_initialized) return ESP_OK;
  xSemaphoreTake(s_control, portMAX_DELAY);
  esp_err_t err = stop_playback(abort);
  xSemaphoreGive(s_control);
  return err;
}

esp_err_t audio_play_end(void) { return finish_playback(false); }
esp_err_t audio_play_cancel(void) { return finish_playback(true); }
bool audio_is_playing(void) { return atomic_load(&s_playing); }
