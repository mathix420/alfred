// SPDX-License-Identifier: MIT
#pragma once

// -----------------------------------------------------------------------------
// protocol.h — C mirror of apps/pocket/src/types.ts (PROTOCOL_VERSION 2).
//
// Two planes share one WebSocket:
//   - control plane: JSON text frames (encoded/parsed here via cJSON).
//   - audio plane:   binary frames. Mic audio (device->bridge) flows between a
//     ptt_down/ptt_up pair; TTS audio (bridge->device) flows between a
//     tts_begin/tts_end pair. Binary frames are NOT parsed here — ws_client.c
//     hands them straight to audio.c.
//
// Field names are kept byte-identical to the TypeScript so the two ends stay in
// lockstep. Bump ALFRED_PROTOCOL_VERSION on any wire change (and bump it in the
// TS at the same time).
// -----------------------------------------------------------------------------

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Mirror of `export const PROTOCOL_VERSION = 2;`
#define ALFRED_PROTOCOL_VERSION 2

// -----------------------------------------------------------------------------
// Shared enums / value objects
// -----------------------------------------------------------------------------

// Mirror of DeviceState = "idle" | "listening" | "thinking" | "speaking".
typedef enum {
  ALFRED_STATE_IDLE = 0,
  ALFRED_STATE_LISTENING,
  ALFRED_STATE_THINKING,
  ALFRED_STATE_SPEAKING,
  ALFRED_STATE_SENT,
  ALFRED_STATE__COUNT,
} alfred_device_state_t;

// "pcm_s16le" | "opus"
typedef enum {
  ALFRED_AUDIO_ENC_PCM_S16LE = 0,
  ALFRED_AUDIO_ENC_OPUS,
} alfred_audio_encoding_t;

// Mirror of AudioFormat { encoding, sampleRate, channels }.
typedef struct {
  alfred_audio_encoding_t encoding;
  uint32_t sample_rate; // Hz, e.g. 16000 mic / 22050 Piper TTS
  uint8_t channels;
} alfred_audio_format_t;

// Mirror of ReminderItem { id, text, dueAt }.
// `id`/`text` are NUL-terminated; sizes are generous but bounded for an MCU.
#define ALFRED_REMINDER_ID_MAX 64
#define ALFRED_REMINDER_TEXT_MAX 192
typedef struct {
  char id[ALFRED_REMINDER_ID_MAX];
  char text[ALFRED_REMINDER_TEXT_MAX];
  int64_t due_at; // epoch ms
} alfred_reminder_item_t;

// How many reminders we keep in a single `reminders`/`ambient.nextReminder`
// payload. The bridge owns the full list; the device only renders the next few.
#define ALFRED_REMINDERS_MAX 8

// Focus snapshots are bounded to fit a pocket device. Strings remain UTF-8.
#define ALFRED_TASKS_MAX 16
#define ALFRED_TASK_ID_MAX 64
#define ALFRED_TASK_TITLE_MAX 192
#define ALFRED_TASK_MEMO_MAX 1536
#define ALFRED_REQUEST_ID_MAX 64

typedef enum { TASK_WORK, TASK_HEALTH, TASK_PERSONAL } alfred_task_category_t;
typedef struct {
  char id[ALFRED_TASK_ID_MAX];
  char title[ALFRED_TASK_TITLE_MAX];
  char memo[ALFRED_TASK_MEMO_MAX];
  char due_at[40];
  alfred_task_category_t category;
  bool completed;
} alfred_focus_task_t;
typedef struct {
  alfred_focus_task_t tasks[ALFRED_TASKS_MAX];
  size_t count;
  char focus_id[ALFRED_TASK_ID_MAX];
  uint32_t revision;
  bool demo;
  bool online;
  bool configured;
} alfred_focus_snapshot_t;
typedef struct {
  char id[ALFRED_TASK_ID_MAX];
  char request_id[ALFRED_REQUEST_ID_MAX];
} alfred_task_completed_t;

// -----------------------------------------------------------------------------
// device -> bridge messages
// -----------------------------------------------------------------------------

typedef enum {
  ALFRED_DEV_HELLO = 0,
  ALFRED_DEV_PTT_DOWN,
  ALFRED_DEV_PTT_UP,
  ALFRED_DEV_TELEMETRY,
  ALFRED_DEV_PING,
} alfred_device_msg_type_t;

#define ALFRED_DEVICE_ID_MAX 64
#define ALFRED_FIRMWARE_MAX 32

// hello { deviceId, protocol, firmware? }
typedef struct {
  char device_id[ALFRED_DEVICE_ID_MAX];
  int protocol;
  bool has_firmware;
  char firmware[ALFRED_FIRMWARE_MAX];
} alfred_hello_t;

// telemetry { battery?, charging?, rssi? } — every field is optional.
typedef struct {
  bool has_battery;
  double battery; // 0..100
  bool has_charging;
  bool charging;
  bool has_rssi;
  double rssi; // dBm
} alfred_telemetry_t;

// -----------------------------------------------------------------------------
// bridge -> device messages
// -----------------------------------------------------------------------------

typedef enum {
  ALFRED_SRV_WELCOME = 0,
  ALFRED_SRV_FOCUS,
  ALFRED_SRV_TASK_COMPLETED,
  ALFRED_SRV_STATE,
  ALFRED_SRV_TRANSCRIPT,
  ALFRED_SRV_REPLY,
  ALFRED_SRV_TTS_BEGIN,
  ALFRED_SRV_TTS_END,
  ALFRED_SRV_REMINDERS,
  ALFRED_SRV_AMBIENT,
  ALFRED_SRV_ERROR,
  ALFRED_SRV_PONG,
  ALFRED_SRV__UNKNOWN, // not on the wire; returned by the parser on a bad type
} alfred_server_msg_type_t;

#define ALFRED_SESSION_ID_MAX 64
// transcript/reply text can be long; cap it for the device and let the bridge
// chunk anything bigger across multiple non-final frames.
#define ALFRED_TEXT_MAX 3072
#define ALFRED_ERROR_CODE_MAX 48
#define ALFRED_ERROR_MSG_MAX 192

// welcome { sessionId, protocol }
typedef struct {
  char session_id[ALFRED_SESSION_ID_MAX];
  int protocol;
} alfred_welcome_t;

// transcript { text, final } and reply { text, final } share this shape.
typedef struct {
  char text[ALFRED_TEXT_MAX];
  bool final;
} alfred_text_chunk_t;

// AmbientFace { now, nextReminder?, battery?, charging? }
typedef struct {
  int64_t now; // epoch ms the bridge believes it is, for clock sync
  bool has_next_reminder;
  alfred_reminder_item_t next_reminder;
  bool has_battery;
  double battery; // 0..100
  bool has_charging;
  bool charging;
} alfred_ambient_face_t;

// reminders { items[] }
typedef struct {
  alfred_reminder_item_t items[ALFRED_REMINDERS_MAX];
  size_t count;
} alfred_reminders_t;

// error { code, message }
typedef struct {
  char code[ALFRED_ERROR_CODE_MAX];
  char message[ALFRED_ERROR_MSG_MAX];
  char request_id[ALFRED_REQUEST_ID_MAX];
} alfred_error_t;

// A parsed server frame: a tagged union over the payload shapes above.
typedef struct {
  alfred_server_msg_type_t type;
  union {
    alfred_welcome_t welcome;
    alfred_focus_snapshot_t focus;
    alfred_task_completed_t task_completed;
    alfred_device_state_t state;     // ALFRED_SRV_STATE
    alfred_text_chunk_t transcript;  // ALFRED_SRV_TRANSCRIPT
    alfred_text_chunk_t reply;       // ALFRED_SRV_REPLY
    alfred_audio_format_t tts_begin; // ALFRED_SRV_TTS_BEGIN
    alfred_reminders_t reminders;    // ALFRED_SRV_REMINDERS
    alfred_ambient_face_t ambient;   // ALFRED_SRV_AMBIENT
    alfred_error_t error;            // ALFRED_SRV_ERROR
    // tts_end / pong carry no payload.
  } as;
} alfred_server_msg_t;

// -----------------------------------------------------------------------------
// String helpers (mirror the TS literal unions)
// -----------------------------------------------------------------------------

// "idle" | "listening" | "thinking" | "speaking"; never NULL.
const char *alfred_device_state_str(alfred_device_state_t state);
// Returns true and fills *out on a known literal; false otherwise.
bool alfred_device_state_parse(const char *s, alfred_device_state_t *out);

// "pcm_s16le" | "opus"
const char *alfred_audio_encoding_str(alfred_audio_encoding_t enc);

// -----------------------------------------------------------------------------
// Encoders (device -> bridge). Each returns a heap-allocated, NUL-terminated
// JSON string the caller must free() (cJSON_PrintUnformatted under the hood),
// or NULL on allocation failure. ws_client.c frees after sending.
// -----------------------------------------------------------------------------

// hello { type, deviceId, protocol[, firmware] }
char *alfred_encode_hello(const char *device_id, int protocol,
                          const char *firmware /* nullable */);
// ptt_down / ptt_up / ping carry only { type }.
char *alfred_encode_ptt_down(void);
char *alfred_encode_ptt_up(void);
char *alfred_encode_ping(void);
char *alfred_encode_refresh(void);
char *alfred_encode_cancel(void);
char *alfred_encode_complete_task(const char *id, const char *request_id);
// telemetry { type[, battery][, charging][, rssi] }.
char *alfred_encode_telemetry(const alfred_telemetry_t *t);

// -----------------------------------------------------------------------------
// Parser (bridge -> device)
// -----------------------------------------------------------------------------

typedef enum {
  ALFRED_PARSE_OK = 0,
  ALFRED_PARSE_BAD_JSON,     // not valid JSON / not an object
  ALFRED_PARSE_NO_TYPE,      // missing string "type"
  ALFRED_PARSE_UNKNOWN_TYPE, // type not in the server set
  ALFRED_PARSE_BAD_FIELD,    // a required field was missing/wrong type
} alfred_parse_result_t;

// Parse + validate a NUL-terminated bridge->device text frame into *out.
// On success returns ALFRED_PARSE_OK and out->type is set; on a recognised but
// malformed frame out->type is still set so callers can log context.
alfred_parse_result_t alfred_parse_server_msg(const char *json,
                                              alfred_server_msg_t *out);

// Human-readable label for a parse result (logging).
const char *alfred_parse_result_str(alfred_parse_result_t r);

#ifdef __cplusplus
}
#endif
