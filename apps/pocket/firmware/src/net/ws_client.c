// SPDX-License-Identifier: MIT
//
// ws_client.c — esp_websocket_client wrapper. See ws_client.h.

#include "net/ws_client.h"

#include "esp_crt_bundle.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ws";

// esp_websocket_client already does exponential reconnect; these mirror its
// knobs so the policy is explicit in one place.
#define WS_RECONNECT_TIMEOUT_MS 10000
#define WS_NETWORK_TIMEOUT_MS 5000
#define WS_MAX_TEXT_BYTES (64 * 1024)
// Bound the firmware identity so hello never exceeds our protocol buffers.
#define WS_FIRMWARE_MAX ALFRED_FIRMWARE_MAX

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

static esp_websocket_client_handle_t s_client;
static ws_client_callbacks_t s_cb; // retained by reference
static char s_device_id[ALFRED_DEVICE_ID_MAX];
static char s_firmware[WS_FIRMWARE_MAX];
static bool s_have_firmware;
static char s_auth_header[256];
static uint8_t s_frame_opcode;
static volatile bool s_connected; // socket open (set true on WS_CONNECTED)

// Reassembly buffer for fragmented inbound text frames. esp_websocket_client
// delivers large payloads in pieces (data_len < payload_len); we accumulate.
static char *s_text_acc;
static size_t s_text_acc_len;
static size_t s_text_acc_cap;

// -----------------------------------------------------------------------------
// Outbound: send a heap JSON string produced by an encoder, then free it.
// -----------------------------------------------------------------------------

static esp_err_t send_text_owned(char *json) {
  if (json == NULL)
    return ESP_ERR_NO_MEM;
  if (s_client == NULL || !esp_websocket_client_is_connected(s_client)) {
    free(json);
    return ESP_ERR_INVALID_STATE;
  }
  int sent = esp_websocket_client_send_text(
      s_client, json, (int)strlen(json), pdMS_TO_TICKS(WS_NETWORK_TIMEOUT_MS));
  free(json);
  return sent >= 0 ? ESP_OK : ESP_FAIL;
}

static esp_err_t send_hello(void) {
  // hello { type, deviceId, protocol[, firmware] } — protocol.c owns the shape.
  return send_text_owned(
      alfred_encode_hello(s_device_id, ALFRED_PROTOCOL_VERSION,
                          s_have_firmware ? s_firmware : NULL));
}

// -----------------------------------------------------------------------------
// Inbound text dispatch: parse one complete frame and fan out to callbacks.
// -----------------------------------------------------------------------------

static void dispatch_text(const char *json) {
  alfred_server_msg_t *msg = calloc(1, sizeof(*msg));
  if (!msg)
    return;
  alfred_parse_result_t r = alfred_parse_server_msg(json, msg);
  if (r != ALFRED_PARSE_OK) {
    ESP_LOGW(TAG, "drop inbound frame: %s", alfred_parse_result_str(r));
    free(msg);
    return;
  }

  void *u = s_cb.user;
  switch (msg->type) {
  case ALFRED_SRV_FOCUS:
    if (s_cb.on_focus)
      s_cb.on_focus(&msg->as.focus, u);
    break;
  case ALFRED_SRV_TASK_COMPLETED:
    if (s_cb.on_task_completed)
      s_cb.on_task_completed(&msg->as.task_completed, u);
    break;
  case ALFRED_SRV_TASK_REOPENED:
    if (s_cb.on_task_reopened)
      s_cb.on_task_reopened(&msg->as.task_reopened, u);
    break;
  case ALFRED_SRV_TASK_TIMER_UPDATED:
    if (s_cb.on_task_timer_updated)
      s_cb.on_task_timer_updated(&msg->as.task_timer_updated, u);
    break;
  case ALFRED_SRV_WELCOME:
    if (msg->as.welcome.protocol != ALFRED_PROTOCOL_VERSION) {
      ESP_LOGW(TAG, "protocol mismatch: bridge=%d device=%d",
               msg->as.welcome.protocol, ALFRED_PROTOCOL_VERSION);
      if (s_cb.on_disconnected)
        s_cb.on_disconnected(u);
      break;
    }
    s_connected = true;
    if (s_cb.on_connected)
      s_cb.on_connected(u);
    if (s_cb.on_welcome)
      s_cb.on_welcome(&msg->as.welcome, u);
    break;
  case ALFRED_SRV_STATE:
    if (s_cb.on_state)
      s_cb.on_state(msg->as.state, u);
    break;
  case ALFRED_SRV_TRANSCRIPT:
    if (s_cb.on_transcript)
      s_cb.on_transcript(&msg->as.transcript, u);
    break;
  case ALFRED_SRV_REPLY:
    if (s_cb.on_reply)
      s_cb.on_reply(&msg->as.reply, u);
    break;
  case ALFRED_SRV_TTS_BEGIN:
    if (s_cb.on_tts_begin)
      s_cb.on_tts_begin(&msg->as.tts_begin, u);
    break;
  case ALFRED_SRV_TTS_END:
    if (s_cb.on_tts_end)
      s_cb.on_tts_end(u);
    break;
  case ALFRED_SRV_REMINDERS:
    if (s_cb.on_reminders)
      s_cb.on_reminders(&msg->as.reminders, u);
    break;
  case ALFRED_SRV_AMBIENT:
    if (s_cb.on_ambient)
      s_cb.on_ambient(&msg->as.ambient, u);
    break;
  case ALFRED_SRV_ERROR:
    ESP_LOGW(TAG, "bridge error %s: %s", msg->as.error.code,
             msg->as.error.message);
    if (s_cb.on_error)
      s_cb.on_error(&msg->as.error, u);
    break;
  case ALFRED_SRV_PONG:
    if (s_cb.on_pong)
      s_cb.on_pong(u);
    break;
  case ALFRED_SRV__UNKNOWN:
    break; // already logged by the parser
  }
  free(msg);
}

// Accumulate a (possibly fragmented) text payload; dispatch on the last chunk.
static void accumulate_text(const char *data, int data_len, int payload_len,
                            int payload_off) {
  if (data_len < 0 || payload_len < 0 || payload_off < 0 ||
      payload_len > WS_MAX_TEXT_BYTES || payload_off > payload_len ||
      data_len > payload_len - payload_off) {
    s_text_acc_len = 0;
    return;
  }
  if (payload_off == 0)
    s_text_acc_len = 0;
  if ((size_t)payload_off != s_text_acc_len) {
    s_text_acc_len = 0;
    return;
  }
  size_t needed = (size_t)payload_len + 1;
  if (needed > s_text_acc_cap) {
    char *grown = realloc(s_text_acc, needed);
    if (!grown) {
      s_text_acc_len = 0;
      return;
    }
    s_text_acc = grown;
    s_text_acc_cap = needed;
  }
  memcpy(s_text_acc + payload_off, data, (size_t)data_len);
  s_text_acc_len += data_len;
  if (s_text_acc_len == (size_t)payload_len) {
    s_text_acc[payload_len] = '\0';
    dispatch_text(s_text_acc);
    s_text_acc_len = 0;
  }
}

// -----------------------------------------------------------------------------
// WebSocket event handler
// -----------------------------------------------------------------------------

static void ws_event_handler(void *handler_arg, esp_event_base_t base,
                             int32_t event_id, void *event_data) {
  (void)handler_arg;
  (void)base;
  esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;

  switch (event_id) {
  case WEBSOCKET_EVENT_CONNECTED:
    ESP_LOGI(TAG, "connected; sending hello");
    s_connected = false;
    send_hello();
    break;

  case WEBSOCKET_EVENT_DISCONNECTED:
    ESP_LOGW(TAG, "disconnected; backoff reconnect");
    s_connected = false;
    s_text_acc_len = 0; // drop any partial frame
    if (s_cb.on_disconnected)
      s_cb.on_disconnected(s_cb.user);
    break;

  case WEBSOCKET_EVENT_DATA:
    if (d->op_code == 0x01 || d->op_code == 0x02)
      s_frame_opcode = d->op_code;
    if (d->op_code == 0x08) { // close frame
      break;
    } else if ((d->op_code == 0x02 ||
                (d->op_code == 0 &&
                 s_frame_opcode == 0x02))) { // BINARY → TTS audio plane
      if (d->data_len > 0 && s_cb.on_audio) {
        s_cb.on_audio((const uint8_t *)d->data_ptr, (size_t)d->data_len,
                      s_cb.user);
      }
    } else if ((d->op_code == 0x01 ||
                (d->op_code == 0 &&
                 s_frame_opcode == 0x01))) { // TEXT → control plane
      accumulate_text(d->data_ptr, d->data_len, d->payload_len,
                      d->payload_offset);
    }
    // op_code 0x09/0x0A (ping/pong) handled by the client internally.
    break;

  case WEBSOCKET_EVENT_ERROR:
    ESP_LOGW(TAG, "websocket transport error");
    break;

  default:
    break;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

esp_err_t ws_client_start(const ws_client_config_t *config) {
  if (config == NULL || config->uri == NULL || config->device_id == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (s_client != NULL)
    return ESP_OK; // already started

  // Copy the identity strings; keep callbacks by reference.
  s_cb = config->cb;
  strncpy(s_device_id, config->device_id, sizeof(s_device_id) - 1);
  s_device_id[sizeof(s_device_id) - 1] = '\0';
  s_have_firmware = config->firmware != NULL && config->firmware[0] != '\0';
  if (s_have_firmware) {
    strncpy(s_firmware, config->firmware, sizeof(s_firmware) - 1);
    s_firmware[sizeof(s_firmware) - 1] = '\0';
  }

  s_auth_header[0] = '\0';
  if (config->auth_token && config->auth_token[0]) {
    if (strpbrk(config->auth_token, "\r\n") || strlen(config->auth_token) > 192)
      return ESP_ERR_INVALID_ARG;
    snprintf(s_auth_header, sizeof(s_auth_header),
             "Authorization: Bearer %s\r\n", config->auth_token);
  }
  esp_websocket_client_config_t ws_cfg = {
      .uri = config->uri,
      .reconnect_timeout_ms = WS_RECONNECT_TIMEOUT_MS,
      .network_timeout_ms = WS_NETWORK_TIMEOUT_MS,
      .crt_bundle_attach = esp_crt_bundle_attach,
      .headers = s_auth_header[0] ? s_auth_header : NULL,
      .task_stack = 8192,
      .buffer_size = 2048,
  };
  s_client = esp_websocket_client_init(&ws_cfg);
  if (s_client == NULL)
    return ESP_FAIL;

  ESP_ERROR_CHECK(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY,
                                                ws_event_handler, NULL));
  esp_err_t err = esp_websocket_client_start(s_client);
  if (err != ESP_OK) {
    esp_websocket_client_destroy(s_client);
    s_client = NULL;
  }
  return err;
}

esp_err_t ws_client_stop(void) {
  if (s_client == NULL)
    return ESP_OK;
  esp_websocket_client_close(s_client, pdMS_TO_TICKS(WS_NETWORK_TIMEOUT_MS));
  esp_websocket_client_destroy(s_client);
  s_client = NULL;
  s_connected = false;
  free(s_text_acc);
  s_text_acc = NULL;
  s_text_acc_cap = 0;
  s_text_acc_len = 0;
  return ESP_OK;
}

bool ws_client_is_connected(void) { return s_connected; }

esp_err_t ws_client_send_ptt_down(void) {
  return send_text_owned(alfred_encode_ptt_down());
}
esp_err_t ws_client_send_ptt_up(void) {
  return send_text_owned(alfred_encode_ptt_up());
}
esp_err_t ws_client_send_ping(void) {
  return send_text_owned(alfred_encode_ping());
}
esp_err_t ws_client_send_refresh(void) {
  return send_text_owned(alfred_encode_refresh());
}
esp_err_t ws_client_send_cancel(void) {
  return send_text_owned(alfred_encode_cancel());
}
esp_err_t ws_client_send_complete_task(const char *id, const char *request_id) {
  return send_text_owned(alfred_encode_complete_task(id, request_id));
}
esp_err_t ws_client_send_reopen_task(const char *id, const char *request_id) {
  return send_text_owned(alfred_encode_reopen_task(id, request_id));
}
esp_err_t ws_client_send_task_timer(const char *id, const char *request_id,
                                    alfred_task_timer_action_t action) {
  return send_text_owned(alfred_encode_task_timer(id, request_id, action));
}

esp_err_t ws_client_send_telemetry(const alfred_telemetry_t *t) {
  return send_text_owned(alfred_encode_telemetry(t));
}

// Offline audio is never queued: voice requires a live session.
esp_err_t ws_client_send_audio(const uint8_t *pcm, size_t len) {
  if (pcm == NULL || len == 0)
    return ESP_ERR_INVALID_ARG;
  if (!s_connected || !s_client)
    return ESP_ERR_INVALID_STATE;
  int sent = esp_websocket_client_send_bin(s_client, (const char *)pcm,
                                           (int)len, pdMS_TO_TICKS(250));
  return sent == (int)len ? ESP_OK : ESP_FAIL;
}
