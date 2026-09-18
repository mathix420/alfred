// SPDX-License-Identifier: MIT
//
// protocol.c — cJSON-backed encode/parse for the Alfred wire protocol.
// Mirrors apps/pocket/src/types.ts exactly; see protocol.h.

#include "protocol.h"

#include <string.h>

#include "cJSON.h" // bundled with ESP-IDF (components/json)

// -----------------------------------------------------------------------------
// Small local helpers
// -----------------------------------------------------------------------------

// Copy a NUL-terminated source into a fixed buffer, always NUL-terminating.
// Truncates silently if the source is longer than the destination.
static void copy_str(char *dst, size_t dst_size, const char *src) {
  if (dst_size == 0)
    return;
  if (src == NULL) {
    dst[0] = '\0';
    return;
  }
  size_t n = strnlen(src, dst_size - 1);
  if (src[n])
    while (n && (((uint8_t)src[n] & 0xC0) == 0x80))
      n--;
  memcpy(dst, src, n);
  dst[n] = '\0';
}

// Fetch a required string field; returns false if absent or not a string.
static bool get_str_field(const cJSON *obj, const char *key, char *dst,
                          size_t dst_size) {
  const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (!cJSON_IsString(item) || item->valuestring == NULL)
    return false;
  copy_str(dst, dst_size, item->valuestring);
  return true;
}

// Category identifiers must match exactly; truncation could merge two lists.
static bool get_bounded_string(const cJSON *obj, const char *key, char *dst,
                               size_t capacity) {
  const cJSON *value = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (!cJSON_IsString(value) || !value->valuestring ||
      !value->valuestring[0] || strlen(value->valuestring) >= capacity)
    return false;
  copy_str(dst, capacity, value->valuestring);
  return true;
}
static bool category_identifier(const char *id) {
  if (!((id[0] >= 'a' && id[0] <= 'z') ||
        (id[0] >= 'A' && id[0] <= 'Z') ||
        (id[0] >= '0' && id[0] <= '9')))
    return false;
  for (const unsigned char *p = (const unsigned char *)id; *p; ++p)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '_' || *p == '-' ||
          *p == '.' || *p == ':'))
      return false;
  return id[0] != 0;
}
static bool category_hex_color(const char *hex) {
  if (strlen(hex) != 7 || hex[0] != '#')
    return false;
  for (size_t i = 1; i < 7; ++i)
    if (!((hex[i] >= '0' && hex[i] <= '9') ||
          (hex[i] >= 'a' && hex[i] <= 'f') ||
          (hex[i] >= 'A' && hex[i] <= 'F')))
      return false;
  return true;
}

// -----------------------------------------------------------------------------
// String tables (kept in lockstep with the TS literal unions)
// -----------------------------------------------------------------------------

static const char *const k_state_names[ALFRED_STATE__COUNT] = {
    [ALFRED_STATE_IDLE] = "idle",
    [ALFRED_STATE_LISTENING] = "listening",
    [ALFRED_STATE_THINKING] = "thinking",
    [ALFRED_STATE_SPEAKING] = "speaking",
    [ALFRED_STATE_SENT] = "sent",
};

const char *alfred_device_state_str(alfred_device_state_t state) {
  if (state < 0 || state >= ALFRED_STATE__COUNT)
    return "idle";
  return k_state_names[state];
}

bool alfred_device_state_parse(const char *s, alfred_device_state_t *out) {
  if (s == NULL || out == NULL)
    return false;
  for (int i = 0; i < ALFRED_STATE__COUNT; i++) {
    if (strcmp(s, k_state_names[i]) == 0) {
      *out = (alfred_device_state_t)i;
      return true;
    }
  }
  return false;
}

const char *alfred_audio_encoding_str(alfred_audio_encoding_t enc) {
  return enc == ALFRED_AUDIO_ENC_OPUS ? "opus" : "pcm_s16le";
}

static bool audio_encoding_parse(const char *s, alfred_audio_encoding_t *out) {
  if (s == NULL || out == NULL)
    return false;
  if (strcmp(s, "pcm_s16le") == 0) {
    *out = ALFRED_AUDIO_ENC_PCM_S16LE;
    return true;
  }
  if (strcmp(s, "opus") == 0) {
    *out = ALFRED_AUDIO_ENC_OPUS;
    return true;
  }
  return false;
}

const char *alfred_parse_result_str(alfred_parse_result_t r) {
  switch (r) {
  case ALFRED_PARSE_OK:
    return "ok";
  case ALFRED_PARSE_BAD_JSON:
    return "bad_json";
  case ALFRED_PARSE_NO_TYPE:
    return "no_type";
  case ALFRED_PARSE_UNKNOWN_TYPE:
    return "unknown_type";
  case ALFRED_PARSE_BAD_FIELD:
    return "bad_field";
  }
  return "?";
}

// -----------------------------------------------------------------------------
// Encoders (device -> bridge)
// -----------------------------------------------------------------------------

// Finalise a cJSON object into an unformatted string and free the object.
// Returns NULL (and frees) on any allocation failure.
static char *finish(cJSON *root) {
  if (root == NULL)
    return NULL;
  char *s = cJSON_PrintUnformatted(root); // matches JSON.stringify (no spaces)
  cJSON_Delete(root);
  return s; // caller frees
}

// Bare { "type": <t> } envelope used by ptt_down / ptt_up / ping.
static char *encode_bare(const char *type) {
  cJSON *root = cJSON_CreateObject();
  if (root == NULL)
    return NULL;
  if (cJSON_AddStringToObject(root, "type", type) == NULL) {
    cJSON_Delete(root);
    return NULL;
  }
  return finish(root);
}

char *alfred_encode_hello(const char *device_id, int protocol,
                          const char *firmware) {
  cJSON *root = cJSON_CreateObject();
  if (root == NULL)
    return NULL;
  bool ok = cJSON_AddStringToObject(root, "type", "hello") != NULL &&
            cJSON_AddStringToObject(root, "deviceId",
                                    device_id ? device_id : "") != NULL &&
            cJSON_AddNumberToObject(root, "protocol", protocol) != NULL;
  // firmware is optional; only emit when present (mirrors the TS spread).
  if (ok && firmware != NULL && firmware[0] != '\0') {
    ok = cJSON_AddStringToObject(root, "firmware", firmware) != NULL;
  }
  if (!ok) {
    cJSON_Delete(root);
    return NULL;
  }
  return finish(root);
}

char *alfred_encode_ptt_down(void) {
  cJSON *root = cJSON_CreateObject();
  if (!root)
    return NULL;
  cJSON_AddStringToObject(root, "type", "ptt_down");
  cJSON_AddNumberToObject(root, "sampleRate", 16000);
  cJSON_AddNumberToObject(root, "channels", 1);
  return finish(root);
}
char *alfred_encode_refresh(void) { return encode_bare("refresh"); }
char *alfred_encode_cancel(void) { return encode_bare("cancel"); }
char *alfred_encode_complete_task(const char *id, const char *request_id) {
  if (!id || !request_id)
    return NULL;
  cJSON *root = cJSON_CreateObject();
  if (!root)
    return NULL;
  if (!cJSON_AddStringToObject(root, "type", "complete_task") ||
      !cJSON_AddStringToObject(root, "id", id) ||
      !cJSON_AddStringToObject(root, "requestId", request_id)) {
    cJSON_Delete(root);
    return NULL;
  }
  return finish(root);
}
char *alfred_encode_ptt_up(void) { return encode_bare("ptt_up"); }
char *alfred_encode_ping(void) { return encode_bare("ping"); }

char *alfred_encode_telemetry(const alfred_telemetry_t *t) {
  cJSON *root = cJSON_CreateObject();
  if (root == NULL)
    return NULL;
  bool ok = cJSON_AddStringToObject(root, "type", "telemetry") != NULL;
  // All fields optional — only emit the ones the caller marked present.
  if (ok && t != NULL && t->has_battery) {
    ok = cJSON_AddNumberToObject(root, "battery", t->battery) != NULL;
  }
  if (ok && t != NULL && t->has_charging) {
    ok = cJSON_AddBoolToObject(root, "charging", t->charging) != NULL;
  }
  if (ok && t != NULL && t->has_rssi) {
    ok = cJSON_AddNumberToObject(root, "rssi", t->rssi) != NULL;
  }
  if (!ok) {
    cJSON_Delete(root);
    return NULL;
  }
  return finish(root);
}

// -----------------------------------------------------------------------------
// Parser (bridge -> device)
// -----------------------------------------------------------------------------

// Map a server "type" string to the enum; ALFRED_SRV__UNKNOWN if not found.
static alfred_server_msg_type_t server_type_of(const char *type) {
  static const struct {
    const char *name;
    alfred_server_msg_type_t type;
  } table[] = {
      {"hello", ALFRED_SRV_WELCOME},
      {"focus", ALFRED_SRV_FOCUS},
      {"task_completed", ALFRED_SRV_TASK_COMPLETED},
      {"welcome", ALFRED_SRV_WELCOME},
      {"state", ALFRED_SRV_STATE},
      {"transcript", ALFRED_SRV_TRANSCRIPT},
      {"reply", ALFRED_SRV_REPLY},
      {"tts_start", ALFRED_SRV_TTS_BEGIN},
      {"tts_begin", ALFRED_SRV_TTS_BEGIN},
      {"tts_end", ALFRED_SRV_TTS_END},
      {"reminders", ALFRED_SRV_REMINDERS},
      {"ambient", ALFRED_SRV_AMBIENT},
      {"error", ALFRED_SRV_ERROR},
      {"pong", ALFRED_SRV_PONG},
  };
  for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
    if (strcmp(type, table[i].name) == 0)
      return table[i].type;
  }
  return ALFRED_SRV__UNKNOWN;
}

// Parse one ReminderItem object into *out. Returns false on a bad shape.
static bool parse_reminder(const cJSON *obj, alfred_reminder_item_t *out) {
  if (!cJSON_IsObject(obj))
    return false;
  if (!get_str_field(obj, "id", out->id, sizeof(out->id)))
    return false;
  if (!get_str_field(obj, "text", out->text, sizeof(out->text)))
    return false;
  const cJSON *due = cJSON_GetObjectItemCaseSensitive(obj, "dueAt");
  if (!cJSON_IsNumber(due))
    return false;
  out->due_at = (int64_t)due->valuedouble; // epoch ms; double is exact to 2^53
  return true;
}

// tts_begin { format: AudioFormat }
static alfred_parse_result_t parse_tts_begin(const cJSON *root,
                                             alfred_audio_format_t *out) {
  const cJSON *fmt = cJSON_GetObjectItemCaseSensitive(root, "format");
  if (!cJSON_IsObject(fmt))
    fmt = root;
  const cJSON *enc = cJSON_GetObjectItemCaseSensitive(fmt, "encoding");
  if (!enc)
    enc = cJSON_GetObjectItemCaseSensitive(fmt, "codec");
  const cJSON *rate = cJSON_GetObjectItemCaseSensitive(fmt, "sampleRate");
  const cJSON *chans = cJSON_GetObjectItemCaseSensitive(fmt, "channels");
  if (!cJSON_IsString(enc) || !cJSON_IsNumber(rate) || !cJSON_IsNumber(chans)) {
    return ALFRED_PARSE_BAD_FIELD;
  }
  if (!audio_encoding_parse(enc->valuestring, &out->encoding))
    return ALFRED_PARSE_BAD_FIELD;
  out->sample_rate = (uint32_t)rate->valuedouble;
  out->channels = (uint8_t)chans->valuedouble;
  return ALFRED_PARSE_OK;
}

// transcript/reply { text, final } share this body.
static alfred_parse_result_t parse_text_chunk(const cJSON *root,
                                              alfred_text_chunk_t *out) {
  if (!get_str_field(root, "text", out->text, sizeof(out->text)))
    return ALFRED_PARSE_BAD_FIELD;
  const cJSON *fin = cJSON_GetObjectItemCaseSensitive(root, "final");
  if (!cJSON_IsBool(fin))
    return ALFRED_PARSE_BAD_FIELD;
  out->final = cJSON_IsTrue(fin);
  return ALFRED_PARSE_OK;
}

// ambient { face: AmbientFace }
static alfred_parse_result_t parse_ambient(const cJSON *root,
                                           alfred_ambient_face_t *out) {
  const cJSON *face = cJSON_GetObjectItemCaseSensitive(root, "face");
  if (!cJSON_IsObject(face))
    return ALFRED_PARSE_BAD_FIELD;

  const cJSON *now = cJSON_GetObjectItemCaseSensitive(face, "now");
  if (!cJSON_IsNumber(now))
    return ALFRED_PARSE_BAD_FIELD;
  out->now = (int64_t)now->valuedouble;

  const cJSON *next = cJSON_GetObjectItemCaseSensitive(face, "nextReminder");
  if (cJSON_IsObject(next)) {
    out->has_next_reminder = parse_reminder(next, &out->next_reminder);
  }

  const cJSON *battery = cJSON_GetObjectItemCaseSensitive(face, "battery");
  if (cJSON_IsNumber(battery)) {
    out->has_battery = true;
    out->battery = battery->valuedouble;
  }
  const cJSON *charging = cJSON_GetObjectItemCaseSensitive(face, "charging");
  if (cJSON_IsBool(charging)) {
    out->has_charging = true;
    out->charging = cJSON_IsTrue(charging);
  }
  return ALFRED_PARSE_OK;
}

// reminders { items: ReminderItem[] }
static alfred_parse_result_t parse_reminders(const cJSON *root,
                                             alfred_reminders_t *out) {
  const cJSON *items = cJSON_GetObjectItemCaseSensitive(root, "items");
  if (!cJSON_IsArray(items))
    return ALFRED_PARSE_BAD_FIELD;
  const cJSON *item = NULL;
  cJSON_ArrayForEach(item, items) {
    if (out->count >= ALFRED_REMINDERS_MAX)
      break; // drop overflow; bridge owns full list
    if (parse_reminder(item, &out->items[out->count]))
      out->count++;
  }
  return ALFRED_PARSE_OK;
}

static alfred_parse_result_t parse_focus(const cJSON *root,
                                         alfred_focus_snapshot_t *out) {
  const cJSON *snap = cJSON_GetObjectItemCaseSensitive(root, "snapshot");
  const cJSON *tasks = cJSON_GetObjectItemCaseSensitive(snap, "tasks");
  const cJSON *revision = cJSON_GetObjectItemCaseSensitive(snap, "revision");
  const cJSON *mode = cJSON_GetObjectItemCaseSensitive(snap, "mode");
  const cJSON *connection =
      cJSON_GetObjectItemCaseSensitive(snap, "connection");
  if (!cJSON_IsObject(snap) || !cJSON_IsArray(tasks) ||
      !cJSON_IsNumber(revision) || !cJSON_IsString(mode) ||
      !cJSON_IsString(connection))
    return ALFRED_PARSE_BAD_FIELD;
  out->revision = (uint32_t)revision->valuedouble;
  out->demo = strcmp(mode->valuestring, "demo") == 0;
  out->online = strcmp(connection->valuestring, "online") == 0;
  out->configured = strcmp(connection->valuestring, "unconfigured") != 0;
  get_str_field(snap, "focusId", out->focus_id, sizeof(out->focus_id));
  const cJSON *categories = cJSON_GetObjectItemCaseSensitive(snap, "categories");
  const cJSON *item;
  if (categories) {
    if (!cJSON_IsArray(categories))
      return ALFRED_PARSE_BAD_FIELD;
    out->has_categories = true;
    cJSON_ArrayForEach(item, categories) {
      if (out->category_count >= ALFRED_CATEGORIES_MAX)
        return ALFRED_PARSE_BAD_FIELD;
      alfred_focus_category_t *category =
          &out->categories[out->category_count];
      if (!get_bounded_string(item, "id", category->id, sizeof(category->id)) ||
          !category_identifier(category->id) ||
          !get_bounded_string(item, "title", category->title,
                              sizeof(category->title)) ||
          !get_bounded_string(item, "color", category->color,
                              sizeof(category->color)) ||
          !category_hex_color(category->color))
        return ALFRED_PARSE_BAD_FIELD;
      for (size_t i = 0; i < out->category_count; ++i)
        if (!strcmp(out->categories[i].id, category->id))
          return ALFRED_PARSE_BAD_FIELD;
      out->category_count++;
    }
  }
  cJSON_ArrayForEach(item, tasks) {
    if (out->count >= ALFRED_TASKS_MAX)
      return ALFRED_PARSE_BAD_FIELD;
    alfred_focus_task_t *task = &out->tasks[out->count];
    char category[16];
    const cJSON *completed =
        cJSON_GetObjectItemCaseSensitive(item, "completed");
    if (!get_str_field(item, "id", task->id, sizeof(task->id)) ||
        !task->id[0] ||
        !get_str_field(item, "title", task->title, sizeof(task->title)) ||
        !get_str_field(item, "category", category, sizeof(category)) ||
        !cJSON_IsBool(completed))
      return ALFRED_PARSE_BAD_FIELD;
    if (!strcmp(category, "work"))
      task->category = TASK_WORK;
    else if (!strcmp(category, "health"))
      task->category = TASK_HEALTH;
    else if (!strcmp(category, "personal"))
      task->category = TASK_PERSONAL;
    else
      return ALFRED_PARSE_BAD_FIELD;
    if (cJSON_GetObjectItemCaseSensitive(item, "categoryId") &&
        (!get_bounded_string(item, "categoryId", task->category_id,
                              sizeof(task->category_id)) ||
         !category_identifier(task->category_id)))
      return ALFRED_PARSE_BAD_FIELD;
    get_str_field(item, "memo", task->memo, sizeof(task->memo));
    get_str_field(item, "dueAt", task->due_at, sizeof(task->due_at));
    task->completed = cJSON_IsTrue(completed);
    out->count++;
  }
  return ALFRED_PARSE_OK;
}

alfred_parse_result_t alfred_parse_server_msg(const char *json,
                                              alfred_server_msg_t *out) {
  if (json == NULL || out == NULL)
    return ALFRED_PARSE_BAD_JSON;
  memset(out, 0, sizeof(*out));
  out->type = ALFRED_SRV__UNKNOWN;

  cJSON *root = cJSON_ParseWithOpts(json, NULL, true);
  if (root == NULL || !cJSON_IsObject(root)) {
    cJSON_Delete(root); // safe on NULL
    return ALFRED_PARSE_BAD_JSON;
  }

  const cJSON *type_item = cJSON_GetObjectItemCaseSensitive(root, "type");
  if (!cJSON_IsString(type_item) || type_item->valuestring == NULL) {
    cJSON_Delete(root);
    return ALFRED_PARSE_NO_TYPE;
  }

  alfred_server_msg_type_t type = server_type_of(type_item->valuestring);
  if (type == ALFRED_SRV__UNKNOWN) {
    cJSON_Delete(root);
    return ALFRED_PARSE_UNKNOWN_TYPE;
  }
  out->type = type; // set early so the caller can log on a later BAD_FIELD

  alfred_parse_result_t res = ALFRED_PARSE_OK;
  switch (type) {
  case ALFRED_SRV_FOCUS:
    res = parse_focus(root, &out->as.focus);
    break;
  case ALFRED_SRV_TASK_COMPLETED:
    if (!get_str_field(root, "id", out->as.task_completed.id,
                       sizeof(out->as.task_completed.id)) ||
        !get_str_field(root, "requestId", out->as.task_completed.request_id,
                       sizeof(out->as.task_completed.request_id)))
      res = ALFRED_PARSE_BAD_FIELD;
    break;
  case ALFRED_SRV_WELCOME: {
    get_str_field(root, "sessionId", out->as.welcome.session_id,
                  sizeof(out->as.welcome.session_id));
    const cJSON *proto = cJSON_GetObjectItemCaseSensitive(root, "protocol");
    if (!cJSON_IsNumber(proto)) {
      res = ALFRED_PARSE_BAD_FIELD;
      break;
    }
    out->as.welcome.protocol = (int)proto->valuedouble;
    break;
  }
  case ALFRED_SRV_STATE: {
    const cJSON *st = cJSON_GetObjectItemCaseSensitive(root, "state");
    if (!cJSON_IsString(st) ||
        !alfred_device_state_parse(st->valuestring, &out->as.state)) {
      res = ALFRED_PARSE_BAD_FIELD;
    }
    break;
  }
  case ALFRED_SRV_TRANSCRIPT:
    res = parse_text_chunk(root, &out->as.transcript);
    break;
  case ALFRED_SRV_REPLY:
    res = parse_text_chunk(root, &out->as.reply);
    break;
  case ALFRED_SRV_TTS_BEGIN:
    res = parse_tts_begin(root, &out->as.tts_begin);
    break;
  case ALFRED_SRV_REMINDERS:
    res = parse_reminders(root, &out->as.reminders);
    break;
  case ALFRED_SRV_AMBIENT:
    res = parse_ambient(root, &out->as.ambient);
    break;
  case ALFRED_SRV_ERROR: {
    bool ok = get_str_field(root, "code", out->as.error.code,
                            sizeof(out->as.error.code)) &&
              get_str_field(root, "message", out->as.error.message,
                            sizeof(out->as.error.message));
    get_str_field(root, "requestId", out->as.error.request_id,
                  sizeof(out->as.error.request_id));
    if (!ok)
      res = ALFRED_PARSE_BAD_FIELD;
    break;
  }
  case ALFRED_SRV_TTS_END:
  case ALFRED_SRV_PONG:
    // No payload to read.
    break;
  case ALFRED_SRV__UNKNOWN:
    res = ALFRED_PARSE_UNKNOWN_TYPE; // unreachable; handled above
    break;
  }

  cJSON_Delete(root);
  return res;
}
