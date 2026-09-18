// SPDX-License-Identifier: MIT
// Hermes pocket firmware: presentation + input, cloud reasoning stays on the
// bridge.
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/time.h>
#include <time.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "audio/audio.h"
#include "net/protocol.h"
#include "net/ws_client.h"

#include "board/board.h"
#include "ui/ui.h"

static const char *TAG = "main";

// Reported in the hello frame; bump on release.
#define ALFRED_FIRMWARE_VERSION "0.2.0-pocket"

// NVS namespace/keys for device config (provisioned over BLE/SoftAP on first
// run).
#define NVS_NS "alfred"
#define NVS_KEY_WS_URI "ws_uri"
#define NVS_KEY_DEVICE_ID "device_id"
#define NVS_KEY_WIFI_SSID "wifi_ssid"
#define NVS_KEY_WIFI_PASS "wifi_pass"

// Idle policy: dim/sleep after this long with no interaction (Tier 1).
#define IDLE_LIGHT_SLEEP_MS 30000
#define TELEMETRY_PERIOD_MS 60000

// -----------------------------------------------------------------------------
// Config loaded from NVS
// -----------------------------------------------------------------------------

typedef struct {
  char ws_uri[256];
  char device_token[193];
  char device_id[ALFRED_DEVICE_ID_MAX];
  char wifi_ssid[33];
  char wifi_pass[65];
  char timezone[64]; // POSIX TZ string (e.g. "CET-1CEST,M3.5.0,M10.5.0/3")
  bool provisioned;
} app_config_t;

static app_config_t s_config;
static atomic_bool s_ptt_active; // mic currently streaming
static volatile int64_t s_last_interaction_ms;

// Read one string key from NVS into a fixed buffer. Returns false if absent.
static bool nvs_get_str_into(nvs_handle_t h, const char *key, char *dst,
                             size_t cap) {
  size_t len = cap;
  return nvs_get_str(h, key, dst, &len) == ESP_OK;
}

// Load device config from NVS. Marks provisioned=false if essentials are
// missing so app_main can route into BLE/SoftAP provisioning.
static void load_config(app_config_t *cfg) {
  memset(cfg, 0, sizeof(*cfg));
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
    ESP_LOGW(TAG, "no NVS config namespace; needs provisioning");
    return;
  }
  bool ok =
      nvs_get_str_into(h, NVS_KEY_WS_URI, cfg->ws_uri, sizeof(cfg->ws_uri)) &&
      nvs_get_str_into(h, NVS_KEY_DEVICE_ID, cfg->device_id,
                       sizeof(cfg->device_id)) &&
      nvs_get_str_into(h, NVS_KEY_WIFI_SSID, cfg->wifi_ssid,
                       sizeof(cfg->wifi_ssid)) &&
      nvs_get_str_into(h, NVS_KEY_WIFI_PASS, cfg->wifi_pass,
                       sizeof(cfg->wifi_pass));
  nvs_get_str_into(h, "device_token", cfg->device_token,
                   sizeof(cfg->device_token));
  nvs_get_str_into(h, "timezone", cfg->timezone, sizeof(cfg->timezone));
  nvs_close(h);
  cfg->provisioned = ok;
}

// Trim leading/trailing whitespace (incl. CR/LF) in place; returns trimmed
// start.
static char *trim_ws(char *s) {
  while (*s == ' ' || *s == '\t')
    s++;
  char *end = s + strlen(s);
  while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' ||
                     end[-1] == '\n')) {
    *--end = '\0';
  }
  return s;
}

// Load WiFi + timezone from the SD card's setup.txt (the app-pixels reference
// format: `KEY=value` lines). We only read SSID/PASSWORD/TIMEZONE plus optional
// WS_URI/DEVICE_ID; the file's CLAUDE_KEY/GROQ_KEY belong to the other firmware
// and are ignored. Returns true if a usable WiFi SSID + password were found.
static bool load_config_from_sd(app_config_t *cfg) {
  FILE *f = fopen("/sdcard/setup/setup.txt", "r");
  if (f == NULL) {
    ESP_LOGW(TAG,
             "no /sdcard/setup/setup.txt — cannot read WiFi config from SD");
    return false;
  }
  char line[256];
  while (fgets(line, sizeof(line), f) != NULL) {
    char *eq = strchr(line, '=');
    if (eq == NULL)
      continue;
    *eq = '\0';
    char *key = trim_ws(line);
    char *val = trim_ws(eq + 1);
    if (strcasecmp(key, "SSID") == 0) {
      strlcpy(cfg->wifi_ssid, val, sizeof(cfg->wifi_ssid));
    } else if (strcasecmp(key, "PASSWORD") == 0) {
      strlcpy(cfg->wifi_pass, val, sizeof(cfg->wifi_pass));
    } else if (strcasecmp(key, "TIMEZONE") == 0) {
      strlcpy(cfg->timezone, val, sizeof(cfg->timezone));
    } else if (strcasecmp(key, "WS_URI") == 0) {
      strlcpy(cfg->ws_uri, val, sizeof(cfg->ws_uri));
    } else if (strcasecmp(key, "DEVICE_TOKEN") == 0) {
      strlcpy(cfg->device_token, val, sizeof(cfg->device_token));
    } else if (strcasecmp(key, "DEVICE_ID") == 0) {
      strlcpy(cfg->device_id, val, sizeof(cfg->device_id));
    }
  }
  fclose(f);
  cfg->provisioned = cfg->wifi_ssid[0] != '\0';
  // Never log the SSID/password values — just whether they were found.
  ESP_LOGI(TAG, "SD setup.txt: WiFi creds %s, timezone %s",
           cfg->provisioned ? "found" : "MISSING",
           cfg->timezone[0] ? "set" : "default(UTC)");
  return cfg->provisioned;
}

// Start SNTP so the system clock corrects to real wall-clock once WiFi is up.
// Non-blocking: the ambient face reads the system clock each tick, so the time
// snaps in when the first sync lands (a few seconds after the network is up).
static void sntp_start(void) {
  esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  esp_err_t err = esp_netif_sntp_init(&sntp_cfg);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "SNTP init failed: %s", esp_err_to_name(err));
    return;
  }
  ESP_LOGI(TAG, "SNTP started (pool.ntp.org); clock corrects once online");
}

// Give the device a stable id from its WiFi MAC if neither setup.txt nor NVS
// set one, so the `hello` handshake carries a real deviceId for the bridge to
// pair.
static void ensure_device_id(app_config_t *cfg) {
  if (cfg->device_id[0] != '\0')
    return;
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(cfg->device_id, sizeof(cfg->device_id), "alfred-%02x%02x%02x",
           mac[3], mac[4], mac[5]);
  ESP_LOGI(TAG, "device id defaulted to %s", cfg->device_id);
}

// -----------------------------------------------------------------------------
// WiFi (station) — minimal connect using NVS credentials.
// -----------------------------------------------------------------------------

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id,
                               void *data) {
  (void)arg;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
    ESP_LOGW(TAG, "wifi disconnected (reason %d); retrying",
             d ? d->reason : -1);
    esp_wifi_connect(); // ws_client backoff handles the bridge side
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
    // Compare this subnet to the bridge's (ws_uri) — they must match (or
    // route).
    ESP_LOGI(TAG,
             "wifi got IP " IPSTR
             " (bridge ws_uri must be reachable from here)",
             IP2STR(&e->ip_info.ip));
  }
}

static esp_err_t wifi_connect(const app_config_t *cfg) {
  ESP_ERROR_CHECK(esp_netif_init());
  esp_netif_create_default_wifi_sta();

  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL, NULL));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL, NULL));

  wifi_config_t wc = {0};
  strncpy((char *)wc.sta.ssid, cfg->wifi_ssid, sizeof(wc.sta.ssid) - 1);
  strncpy((char *)wc.sta.password, cfg->wifi_pass, sizeof(wc.sta.password) - 1);

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  ESP_ERROR_CHECK(esp_wifi_start());
  return ESP_OK;
}

// Input callbacks never block the board/LVGL task. The application queue owns
// microphone transitions, task requests and network control messages.
typedef enum {
  CMD_UI,
  CMD_BUTTON_DOWN,
  CMD_BUTTON_UP,
  CMD_BACK,
  CMD_DISCONNECT,
  CMD_MIC_FAILED,
  CMD_SERVER_ERROR
} command_type_t;
typedef struct {
  command_type_t type;
  ui_action_t action;
  char id[ALFRED_TASK_ID_MAX], request_id[ALFRED_REQUEST_ID_MAX];
} command_t;
static QueueHandle_t s_commands;
static atomic_bool s_voice_active, s_mic_failed;
static bool s_audio_ready;
static int64_t s_record_started;

static void enqueue(command_type_t type) {
  command_t command = {.type = type};
  if (s_commands)
    xQueueSend(s_commands, &command, 0);
}
static void action_requested(ui_action_t action, const char *id,
                             const char *request_id, void *user) {
  (void)user;
  command_t command = {.type = CMD_UI, .action = action};
  if (id)
    strlcpy(command.id, id, sizeof(command.id));
  if (request_id)
    strlcpy(command.request_id, request_id, sizeof(command.request_id));
  if (xQueueSend(s_commands, &command, 0) != pdTRUE)
    ESP_LOGW(TAG, "input queue full");
}
static void on_mic_frame(const uint8_t *pcm, size_t len, void *user) {
  (void)user;
  if (ws_client_send_audio(pcm, len) != ESP_OK &&
      !atomic_exchange(&s_mic_failed, true))
    enqueue(CMD_MIC_FAILED);
}
static void stop_voice(bool send_cancel) {
  atomic_store(&s_voice_active, false);
  if (atomic_exchange(&s_ptt_active, false))
    audio_record_stop();
  audio_play_cancel();
  if (send_cancel && ws_client_is_connected())
    ws_client_send_cancel();
}
static void show_problem(const char *code, const char *message,
                         const char *request) {
  alfred_error_t error = {0};
  strlcpy(error.code, code, sizeof(error.code));
  strlcpy(error.message, message, sizeof(error.message));
  if (request)
    strlcpy(error.request_id, request, sizeof(error.request_id));
  ui_show_error(&error);
}
static void command_task(void *arg) {
  (void)arg;
  command_t command;
  for (;;) {
    if (xQueueReceive(s_commands, &command, pdMS_TO_TICKS(250)) != pdTRUE) {
      if (atomic_load(&s_ptt_active) &&
          esp_timer_get_time() / 1000 - s_record_started > 30000)
        ui_handle_ptt(false);
      continue;
    }
    s_last_interaction_ms = esp_timer_get_time() / 1000;
    switch (command.type) {
    case CMD_BUTTON_DOWN:
      ui_handle_ptt(true);
      break;
    case CMD_BUTTON_UP:
      ui_handle_ptt(false);
      break;
    case CMD_BACK:
      ui_handle_back();
      break;
    case CMD_DISCONNECT:
      stop_voice(false);
      ui_set_connection(false);
      break;
    case CMD_SERVER_ERROR:
      stop_voice(false);
      break;
    case CMD_MIC_FAILED:
      stop_voice(true);
      show_problem("audio_send_failed", "Connection lost. Please try again.",
                   NULL);
      break;
    case CMD_UI:
      switch (command.action) {
      case UI_COMPLETE:
        if (ws_client_send_complete_task(command.id, command.request_id) !=
            ESP_OK)
          show_problem("send_failed", "Could not save this task.",
                       command.request_id);
        break;
      case UI_REFRESH:
        if (ws_client_is_connected())
          ws_client_send_refresh();
        else
          ui_set_connection(false);
        break;
      case UI_CANCEL:
        stop_voice(true);
        break;
      case UI_PTT_DOWN:
        // ptt_down cancels the previous bridge turn without a stale idle frame.
        stop_voice(false);
        if (!s_audio_ready) {
          show_problem("audio_unavailable",
                       "Microphone unavailable. Focus still works.", NULL);
          break;
        }
        if (!ws_client_is_connected() || ws_client_send_ptt_down() != ESP_OK) {
          show_problem("offline", "Can't reach Hermes. Try again shortly.",
                       NULL);
          break;
        }
        atomic_store(&s_mic_failed, false);
        atomic_store(&s_voice_active, true);
        if (audio_record_start(on_mic_frame, NULL) != ESP_OK) {
          stop_voice(true);
          show_problem("audio_start", "Microphone could not start.", NULL);
          break;
        }
        atomic_store(&s_ptt_active, true);
        s_record_started = esp_timer_get_time() / 1000;
        break;
      case UI_PTT_UP:
        if (atomic_exchange(&s_ptt_active, false)) {
          audio_record_stop();
          if (ws_client_send_ptt_up() != ESP_OK) {
            stop_voice(false);
            show_problem("offline", "Can't reach Hermes. Try again shortly.",
                         NULL);
          }
        }
        break;
      }
      break;
    }
  }
}
static void on_connected(void *user) {
  (void)user;
  ui_set_connection(true);
}
static void on_disconnected(void *user) {
  (void)user;
  enqueue(CMD_DISCONNECT);
}
static void on_welcome(const alfred_welcome_t *welcome, void *user) {
  (void)user;
  ESP_LOGI(TAG, "pocket protocol %d connected", welcome->protocol);
}
static void on_focus(const alfred_focus_snapshot_t *snapshot, void *user) {
  (void)user;
  ui_set_focus(snapshot);
}
static void on_task_completed(const alfred_task_completed_t *ack, void *user) {
  (void)user;
  ui_task_completed(ack);
}
static void on_state(alfred_device_state_t state, void *user) {
  (void)user;
  if (state == ALFRED_STATE_IDLE && atomic_load(&s_ptt_active))
    return;
  if (state == ALFRED_STATE_IDLE) {
    atomic_store(&s_voice_active, false);
    ui_set_state(state);
  } else if (atomic_load(&s_voice_active))
    ui_set_state(state);
}
static void on_error(const alfred_error_t *error, void *user) {
  (void)user;
  ui_show_error(error);
  if (atomic_load(&s_voice_active))
    enqueue(CMD_SERVER_ERROR);
}
static void on_ptt(bool pressed, void *user) {
  (void)user;
  enqueue(pressed ? CMD_BUTTON_DOWN : CMD_BUTTON_UP);
}
static void on_action(void *user) {
  (void)user;
  enqueue(CMD_BACK);
}
static void housekeeping_task(void *arg) {
  (void)arg;
  for (;;) {
    float battery = board_battery_percent();
    bool charging = board_is_charging();
    ui_set_battery((int)battery, charging);
    if (ws_client_is_connected()) {
      alfred_telemetry_t telemetry = {.has_battery = battery >= 0,
                                      .battery = battery,
                                      .has_charging = true,
                                      .charging = charging};
      wifi_ap_record_t ap;
      if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        telemetry.has_rssi = true;
        telemetry.rssi = ap.rssi;
      }
      ws_client_send_telemetry(&telemetry);
    }
    vTaskDelay(pdMS_TO_TICKS(30000));
  }
}
void app_main(void) {
  ESP_LOGI(TAG, "Hermes pocket %s / protocol %d", ALFRED_FIRMWARE_VERSION,
           ALFRED_PROTOCOL_VERSION);
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
      err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  ESP_ERROR_CHECK(board_init());
  ESP_ERROR_CHECK(ui_init());
  s_commands = xQueueCreate(16, sizeof(command_t));
  if (!s_commands) {
    ESP_LOGE(TAG, "command queue allocation failed");
    return;
  }
  s_audio_ready = audio_init() == ESP_OK;
  if (!s_audio_ready)
    ESP_LOGW(TAG, "audio unavailable; focus UI remains usable");
  if (xTaskCreate(command_task, "pocket_app", 6144, NULL, 5, NULL) != pdPASS) {
    ESP_LOGE(TAG, "command task allocation failed");
    return;
  }
  ui_register_actions(action_requested, NULL);
  board_register_ptt(on_ptt, NULL);
  board_register_action(on_action, NULL);
  load_config(&s_config);
  if (!s_config.provisioned)
    load_config_from_sd(&s_config);
  if (s_config.timezone[0]) {
    setenv("TZ", s_config.timezone, 1);
    tzset();
  }
  bool bridge_configured = s_config.provisioned && s_config.ws_uri[0];
  ui_set_configured(bridge_configured);
  if (s_config.provisioned) {
    ensure_device_id(&s_config);
    ESP_ERROR_CHECK(wifi_connect(&s_config));
    sntp_start();
    if (bridge_configured) {
      ws_client_config_t config = {
          .uri = s_config.ws_uri,
          .auth_token = s_config.device_token,
          .device_id = s_config.device_id,
          .firmware = ALFRED_FIRMWARE_VERSION,
          .cb = {.on_connected = on_connected,
                 .on_disconnected = on_disconnected,
                 .on_welcome = on_welcome,
                 .on_focus = on_focus,
                 .on_task_completed = on_task_completed,
                 .on_state = on_state,
                 // Voice is outbound only: no transcript/reply/TTS callbacks.
                 .on_error = on_error}};
      if (ws_client_start(&config) != ESP_OK)
        ESP_LOGW(TAG, "bridge could not start; retry after configuring WS_URI");
    }
  } else
    ESP_LOGI(TAG, "No WiFi setup: running the labeled local demo. Use SD "
                  "setup/setup.txt to connect.");
  xTaskCreate(housekeeping_task, "pocket_status", 4096, NULL, 3, NULL);
  ESP_LOGI(TAG, "pocket ready: touch focus to complete, swipe for Today/Memo, "
                "hold BOOT to talk, PWR to return");
}
