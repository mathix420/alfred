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
#include "net/wifi_policy.h"
#include "net/ws_client.h"

#include "board/board.h"
#include "ui/ui.h"

static const char *TAG = "main";

#ifndef ALFRED_ENABLE_DEMO
#define ALFRED_ENABLE_DEMO 0
#endif

// Reported in the hello frame; distinguish the opt-in demo from real devices.
#if ALFRED_ENABLE_DEMO
#define ALFRED_FIRMWARE_VERSION "0.3.4-demo"
#else
#define ALFRED_FIRMWARE_VERSION "0.3.4-production"
#endif

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
  alfred_wifi_profile_t wifi[ALFRED_WIFI_PROFILES_MAX];
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

static bool has_wifi_profile(const app_config_t *cfg) {
  for (size_t i = 0; i < ALFRED_WIFI_PROFILES_MAX; ++i)
    if (alfred_wifi_profile_valid(cfg->wifi[i].ssid, cfg->wifi[i].password))
      return true;
  return false;
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
  // Read every field independently: one missing key must not hide the rest.
  bool uri =
      nvs_get_str_into(h, NVS_KEY_WS_URI, cfg->ws_uri, sizeof(cfg->ws_uri));
  bool id = nvs_get_str_into(h, NVS_KEY_DEVICE_ID, cfg->device_id,
                             sizeof(cfg->device_id));
  bool ssid = false, password = false;
  for (size_t i = 0; i < ALFRED_WIFI_PROFILES_MAX; ++i) {
    char ssid_key[16], password_key[16];
    if (i) {
      snprintf(ssid_key, sizeof(ssid_key), "wifi_ssid_%u", (unsigned)i);
      snprintf(password_key, sizeof(password_key), "wifi_pass_%u", (unsigned)i);
    } else {
      strcpy(ssid_key, NVS_KEY_WIFI_SSID);
      strcpy(password_key, NVS_KEY_WIFI_PASS);
    }
    alfred_wifi_profile_t *profile = &cfg->wifi[i];
    bool has_ssid =
        nvs_get_str_into(h, ssid_key, profile->ssid, sizeof(profile->ssid));
    bool has_password = nvs_get_str_into(h, password_key, profile->password,
                                         sizeof(profile->password));
    if (!i) {
      ssid = has_ssid && profile->ssid[0];
      password = has_password;
    }
    if (!has_ssid || !has_password ||
        !alfred_wifi_profile_valid(profile->ssid, profile->password))
      memset(profile, 0, sizeof(*profile));
  }
  nvs_get_str_into(h, "device_token", cfg->device_token,
                   sizeof(cfg->device_token));
  nvs_get_str_into(h, "timezone", cfg->timezone, sizeof(cfg->timezone));
  nvs_close(h);
  cfg->provisioned = uri && id && has_wifi_profile(cfg);
  ESP_LOGI(TAG,
           "saved settings: endpoint=%d id=%d wifi=%d password=%d token=%d",
           uri && cfg->ws_uri[0], id && cfg->device_id[0], ssid, password,
           cfg->device_token[0] != 0);
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

static bool copy_wifi_field(char *dst, size_t capacity, const char *value) {
  // Reject overlong values rather than connecting to a silently truncated SSID.
  size_t length = strlen(value);
  if (length >= capacity) {
    memset(dst, 0, capacity);
    return false;
  }
  memcpy(dst, value, length + 1);
  return true;
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
  bool secondary_ssid[ALFRED_WIFI_PROFILES_MAX] = {0};
  bool secondary_password[ALFRED_WIFI_PROFILES_MAX] = {0};
  bool invalid_wifi[ALFRED_WIFI_PROFILES_MAX] = {0};
  while (fgets(line, sizeof(line), f) != NULL) {
    char *eq = strchr(line, '=');
    if (eq == NULL)
      continue;
    *eq = '\0';
    char *key = trim_ws(line);
    char *val = trim_ws(eq + 1);
    if (strcasecmp(key, "SSID") == 0) {
      invalid_wifi[0] |=
          !copy_wifi_field(cfg->wifi[0].ssid, sizeof(cfg->wifi[0].ssid), val);
    } else if (strcasecmp(key, "PASSWORD") == 0) {
      invalid_wifi[0] |= !copy_wifi_field(cfg->wifi[0].password,
                                          sizeof(cfg->wifi[0].password), val);
    } else if (strcasecmp(key, "TIMEZONE") == 0) {
      strlcpy(cfg->timezone, val, sizeof(cfg->timezone));
    } else if (strcasecmp(key, "WS_URI") == 0) {
      strlcpy(cfg->ws_uri, val, sizeof(cfg->ws_uri));
    } else if (strcasecmp(key, "DEVICE_TOKEN") == 0) {
      strlcpy(cfg->device_token, val, sizeof(cfg->device_token));
    } else if (strcasecmp(key, "DEVICE_ID") == 0) {
      strlcpy(cfg->device_id, val, sizeof(cfg->device_id));
    } else {
      for (size_t i = 1; i < ALFRED_WIFI_PROFILES_MAX; ++i) {
        char ssid_key[16], password_key[16];
        snprintf(ssid_key, sizeof(ssid_key), "SSID_%u", (unsigned)i);
        snprintf(password_key, sizeof(password_key), "PASSWORD_%u",
                 (unsigned)i);
        bool is_ssid = strcasecmp(key, ssid_key) == 0;
        bool is_password = strcasecmp(key, password_key) == 0;
        if (!is_ssid && !is_password)
          continue;
        if (!secondary_ssid[i] && !secondary_password[i])
          memset(&cfg->wifi[i], 0, sizeof(cfg->wifi[i]));
        if (is_ssid) {
          secondary_ssid[i] = true;
          invalid_wifi[i] |= !copy_wifi_field(cfg->wifi[i].ssid,
                                              sizeof(cfg->wifi[i].ssid), val);
        } else {
          secondary_password[i] = true;
          invalid_wifi[i] |= !copy_wifi_field(
              cfg->wifi[i].password, sizeof(cfg->wifi[i].password), val);
        }
        break;
      }
    }
  }
  fclose(f);
  for (size_t i = 0; i < ALFRED_WIFI_PROFILES_MAX; ++i)
    if (invalid_wifi[i] || (i && secondary_ssid[i] != secondary_password[i]) ||
        !alfred_wifi_profile_valid(cfg->wifi[i].ssid, cfg->wifi[i].password))
      memset(&cfg->wifi[i], 0, sizeof(cfg->wifi[i]));
  cfg->provisioned = has_wifi_profile(cfg);
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
// Wi-Fi station. The default event loop owns profile selection and retries;
// the timer only posts an event so Wi-Fi state never races a timer callback.
// -----------------------------------------------------------------------------

ESP_EVENT_DEFINE_BASE(POCKET_WIFI_EVENT);
enum { WIFI_RETRY_EVENT };
static alfred_wifi_profiles_t s_wifi_profiles;
static alfred_wifi_policy_t s_wifi_policy;
static esp_timer_handle_t s_wifi_retry_timer;
static bool s_wifi_started, s_wifi_retry_pending;
static int64_t s_wifi_retry_due;

static void wifi_retry_timer(void *arg) {
  (void)arg;
  if (esp_event_post(POCKET_WIFI_EVENT, WIFI_RETRY_EVENT, NULL, 0, 0) !=
      ESP_OK) {
    // A temporarily full event queue must not permanently stop reconnection.
    // Reposting is harmless if GOT_IP has already cancelled the retry.
    esp_timer_start_once(s_wifi_retry_timer, 100000);
  }
}

static void wifi_attempt_failed(void) {
  if (!s_wifi_started || s_wifi_retry_pending)
    return;
  uint32_t delay_ms = alfred_wifi_policy_failed(&s_wifi_policy);
  s_wifi_retry_pending = true;
  s_wifi_retry_due = esp_timer_get_time() + (int64_t)delay_ms * 1000;
  esp_timer_stop(s_wifi_retry_timer);
  esp_err_t err =
      esp_timer_start_once(s_wifi_retry_timer, (uint64_t)delay_ms * 1000);
  ESP_LOGI(TAG, "wifi retry: profile %u/%u in %lu ms",
           (unsigned)s_wifi_policy.current + 1, (unsigned)s_wifi_profiles.count,
           (unsigned long)delay_ms);
  if (err != ESP_OK)
    ESP_LOGE(TAG, "wifi retry timer: %s", esp_err_to_name(err));
}

static void wifi_attempt(void) {
  const alfred_wifi_profile_t *profile =
      &s_wifi_profiles.items[s_wifi_policy.current];
  wifi_config_t config = {0};
  // IDF accepts all 32 SSID bytes and all 64 PSK bytes without a terminator.
  memcpy(config.sta.ssid, profile->ssid, strlen(profile->ssid));
  memcpy(config.sta.password, profile->password, strlen(profile->password));
  esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &config);
  if (err == ESP_OK)
    err = esp_wifi_connect();
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "wifi connection attempt failed: %s", esp_err_to_name(err));
    wifi_attempt_failed();
  }
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id,
                               void *data) {
  (void)arg;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    s_wifi_started = true;
    s_wifi_retry_pending = false;
    wifi_attempt();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_STOP) {
    s_wifi_started = false;
    s_wifi_retry_pending = false;
    s_wifi_policy.connected = false;
    esp_timer_stop(s_wifi_retry_timer);
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
    ESP_LOGW(TAG, "wifi disconnected (reason %d)", d ? d->reason : -1);
    wifi_attempt_failed();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    alfred_wifi_policy_connected(&s_wifi_policy);
    s_wifi_retry_pending = false;
    esp_timer_stop(s_wifi_retry_timer);
    ESP_LOGI(TAG, "wifi connected (profile %u/%u)",
             (unsigned)s_wifi_policy.current + 1,
             (unsigned)s_wifi_profiles.count);
  } else if (base == POCKET_WIFI_EVENT && id == WIFI_RETRY_EVENT) {
    if (!s_wifi_started || !s_wifi_retry_pending || s_wifi_policy.connected)
      return; // Ignore an expired event from a cancelled/replaced retry.
    int64_t remaining = s_wifi_retry_due - esp_timer_get_time();
    if (remaining > 0) {
      // A queue-full repost may arrive before a newer retry's deadline. Keep
      // its wakeup instead of consuming the only pending timer event.
      esp_timer_stop(s_wifi_retry_timer);
      esp_timer_start_once(s_wifi_retry_timer, (uint64_t)remaining);
      return;
    }
    s_wifi_retry_pending = false;
    wifi_attempt();
  }
}

static esp_err_t wifi_connect(const app_config_t *cfg) {
  memset(&s_wifi_profiles, 0, sizeof(s_wifi_profiles));
  for (size_t i = 0; i < ALFRED_WIFI_PROFILES_MAX; ++i)
    alfred_wifi_profiles_add(&s_wifi_profiles, cfg->wifi[i].ssid,
                             cfg->wifi[i].password);
  if (!alfred_wifi_policy_init(&s_wifi_policy, s_wifi_profiles.count))
    return ESP_ERR_INVALID_ARG;
  ESP_ERROR_CHECK(esp_netif_init());
  esp_netif_create_default_wifi_sta();

  // Avoid the driver's verbose connection log exposing an SSID.
  esp_log_level_set("wifi", ESP_LOG_WARN);
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  // Switching profiles must never replace the saved primary network in NVS.
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
  const esp_timer_create_args_t timer = {.callback = wifi_retry_timer,
                                         .name = "wifi_retry"};
  ESP_ERROR_CHECK(esp_timer_create(&timer, &s_wifi_retry_timer));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL, NULL));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL, NULL));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      POCKET_WIFI_EVENT, WIFI_RETRY_EVENT, wifi_event_handler, NULL, NULL));

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
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
      case UI_REOPEN:
        if (ws_client_send_reopen_task(command.id, command.request_id) !=
            ESP_OK)
          show_problem("send_failed", "Could not reopen this task.",
                       command.request_id);
        break;
      case UI_TIMER_START:
      case UI_TIMER_PAUSE:
      case UI_TIMER_STOP: {
        alfred_task_timer_action_t action =
            command.action == UI_TIMER_START   ? ALFRED_TIMER_START
            : command.action == UI_TIMER_PAUSE ? ALFRED_TIMER_PAUSE
                                               : ALFRED_TIMER_STOP;
        if (ws_client_send_task_timer(command.id, command.request_id, action) !=
            ESP_OK)
          show_problem("send_failed", "Could not update this timer.",
                       command.request_id);
        break;
      }
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
  ESP_LOGI(TAG, "focus snapshot: tasks=%d online=%d demo=%d",
           (int)snapshot->count, snapshot->online, snapshot->demo);
  ui_set_focus(snapshot);
}
static void on_task_completed(const alfred_task_completed_t *ack, void *user) {
  (void)user;
  ui_task_completed(ack);
}
static void on_task_reopened(const alfred_task_reopened_t *ack, void *user) {
  (void)user;
  ui_task_reopened(ack);
}
static void on_task_timer_updated(const alfred_task_timer_updated_t *ack,
                                  void *user) {
  (void)user;
  ui_task_timer_updated(ack);
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
  // A failed configuration read must never erase a provisioned device.
  if (err != ESP_OK)
    ESP_LOGE(TAG, "NVS init failed; preserving saved settings: %s",
             esp_err_to_name(err));
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
  bool bridge_configured =
      s_config.provisioned && s_config.ws_uri[0] && s_config.device_token[0];
  ui_set_configured(bridge_configured);
  ESP_LOGI(TAG, "connection configuration: wifi=%d backend=%d demo=%d",
           s_config.provisioned, bridge_configured, ALFRED_ENABLE_DEMO);
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
                 .on_task_reopened = on_task_reopened,
                 .on_task_timer_updated = on_task_timer_updated,
                 .on_state = on_state,
                 // Voice is outbound only: no transcript/reply/TTS callbacks.
                 .on_error = on_error}};
      if (ws_client_start(&config) != ESP_OK)
        ESP_LOGW(TAG, "bridge could not start; retry after configuring WS_URI");
    }
  } else
    ESP_LOGW(TAG, "WiFi setup required; configure NVS or SD setup/setup.txt");
  xTaskCreate(housekeeping_task, "pocket_status", 4096, NULL, 3, NULL);
  ESP_LOGI(TAG, "pocket ready: touch focus to complete, swipe for Today/Memo, "
                "hold BOOT to talk, PWR to return");
}
