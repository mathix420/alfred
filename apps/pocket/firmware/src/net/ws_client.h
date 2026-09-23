// SPDX-License-Identifier: MIT
#pragma once

// -----------------------------------------------------------------------------
// ws_client.h — esp_websocket_client wrapper for the bridge connection.
//
// Owns the single WebSocket carrying both planes (see protocol.h):
//   - inbound TEXT frames → parsed via protocol.c → dispatched to the
//     ws_client_callbacks_t the app registers (focus and recording state).
//   - inbound BINARY frames → optional legacy audio callback; the one-way
//     pocket app leaves it unset and ignores these frames.
//   - outbound: hello on open, then ptt_down/ptt_up/telemetry/ping and the mic
//     binary frames (ws_client_send_audio) while PTT is held.
//
// Reconnects with a fixed backoff. When offline, captured utterances are
// rejected without recording or pretending to send them.
// -----------------------------------------------------------------------------

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "net/protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

// Dispatch surface the app fills in (see main.c). All callbacks run on the
// WebSocket event task — keep them short; hand heavy work to UI/audio tasks.
typedef struct {
  // Connection lifecycle.
  void (*on_connected)(void *user);    // socket open; hello has been sent
  void (*on_disconnected)(void *user); // dropped; backoff reconnect pending

  // Parsed control-plane messages (one per inbound text frame).
  void (*on_focus)(const alfred_focus_snapshot_t *snapshot, void *user);
  void (*on_task_completed)(const alfred_task_completed_t *ack, void *user);
  void (*on_task_reopened)(const alfred_task_reopened_t *ack, void *user);
  void (*on_task_timer_updated)(const alfred_task_timer_updated_t *ack, void *user);
  void (*on_welcome)(const alfred_welcome_t *w, void *user);
  void (*on_state)(alfred_device_state_t state, void *user);
  void (*on_transcript)(const alfred_text_chunk_t *t, void *user);
  void (*on_reply)(const alfred_text_chunk_t *r, void *user);
  void (*on_tts_begin)(const alfred_audio_format_t *fmt, void *user);
  void (*on_tts_end)(void *user);
  void (*on_reminders)(const alfred_reminders_t *r, void *user);
  void (*on_ambient)(const alfred_ambient_face_t *a, void *user);
  void (*on_error)(const alfred_error_t *e, void *user);
  void (*on_pong)(void *user);

  // Inbound binary audio chunk (TTS PCM). Valid only between tts_begin/tts_end.
  void (*on_audio)(const uint8_t *data, size_t len, void *user);

  void *user; // opaque cookie passed back to every callback
} ws_client_callbacks_t;

typedef struct {
  const char *uri; // e.g. "ws://10.0.0.2:8787/device" (from NVS)
  const char
      *auth_token;       // optional device bearer token; never a Hermes API key
  const char *device_id; // stable id sent in hello
  const char *firmware;  // optional firmware version string in hello (nullable)
  ws_client_callbacks_t cb;
} ws_client_config_t;

// Start the client: spins up esp_websocket_client and begins connecting. The
// config's string fields are copied; callbacks/user are retained by reference.
// Safe to call once after WiFi is up.
esp_err_t ws_client_start(const ws_client_config_t *config);

// Stop and tear down the client (e.g. before deep sleep).
esp_err_t ws_client_stop(void);

// True once the socket is open and the welcome handshake completed.
bool ws_client_is_connected(void);

// -------- outbound control-plane helpers (device → bridge) --------
esp_err_t ws_client_send_ptt_down(void);
esp_err_t ws_client_send_ptt_up(void);
esp_err_t ws_client_send_ping(void);
esp_err_t ws_client_send_refresh(void);
esp_err_t ws_client_send_cancel(void);
esp_err_t ws_client_send_complete_task(const char *id, const char *request_id);
esp_err_t ws_client_send_reopen_task(const char *id, const char *request_id);
esp_err_t ws_client_send_task_timer(const char *id, const char *request_id, alfred_task_timer_action_t action);
esp_err_t ws_client_send_telemetry(const alfred_telemetry_t *t);

// -------- outbound audio plane (device → bridge) --------
// Send one mic PCM chunk as a binary frame. Call between ptt_down/ptt_up. If
// offline, the chunk is rejected; callers should stop capture and show the
// offline state.
esp_err_t ws_client_send_audio(const uint8_t *pcm, size_t len);

#ifdef __cplusplus
}
#endif
