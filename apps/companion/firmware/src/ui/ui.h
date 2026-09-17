// SPDX-License-Identifier: MIT
#pragma once
#include "esp_err.h"
#include "net/protocol.h"
#include <stdbool.h>

typedef enum {
  UI_COMPLETE,
  UI_REFRESH,
  UI_CANCEL,
  UI_PTT_DOWN,
  UI_PTT_UP
} ui_action_t;
// Called from LVGL; enqueue work, never block on network/audio here.
typedef void (*ui_action_cb_t)(ui_action_t action, const char *id,
                               const char *request_id, void *user);
esp_err_t ui_init(void);
void ui_register_actions(ui_action_cb_t callback, void *user);
void ui_lock(void);
void ui_unlock(void);
void ui_set_state(alfred_device_state_t state);
void ui_set_transcript(const char *text, bool final);
void ui_set_reply(const char *text, bool final);
void ui_set_focus(const alfred_focus_snapshot_t *snapshot);
void ui_task_completed(const alfred_task_completed_t *ack);
void ui_set_connection(bool connected);
void ui_set_configured(bool configured);
void ui_set_battery(int percent, bool charging);
void ui_show_error(const alfred_error_t *error);
void ui_handle_back(void);
void ui_handle_ptt(bool pressed);
bool ui_is_demo(void);
