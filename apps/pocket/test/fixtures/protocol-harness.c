// Host adapter for exercising the real ESP32 protocol parser from Bun tests.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "protocol.h"

static void text(cJSON *object, const char *key, const char *value) {
  cJSON_AddStringToObject(object, key, value);
}

int main(int argc, char **argv) {
  if (argc == 2) {
    char *json = !strcmp(argv[1], "reopen")
      ? alfred_encode_reopen_task("contract-task", "contract-request")
      : alfred_encode_task_timer("contract-task", "contract-request",
          !strcmp(argv[1], "start") ? ALFRED_TIMER_START : !strcmp(argv[1], "pause") ? ALFRED_TIMER_PAUSE : ALFRED_TIMER_STOP);
    if (!json) return 2;
    puts(json);
    free(json);
    return 0;
  }
  char *input = calloc(131073, 1);
  alfred_server_msg_t *message = calloc(1, sizeof(*message));
  if (!input || !message) return 2;
  size_t size = fread(input, 1, 131072, stdin);
  if (!feof(stdin) || size == 131072) return 3;
  alfred_parse_result_t result = alfred_parse_server_msg(input, message);
  cJSON *output = cJSON_CreateObject();
  text(output, "result", alfred_parse_result_str(result));
  if (result == ALFRED_PARSE_OK) {
    switch (message->type) {
      case ALFRED_SRV_WELCOME:
        text(output, "type", "hello");
        cJSON_AddNumberToObject(output, "protocol", message->as.welcome.protocol);
        text(output, "sessionId", message->as.welcome.session_id);
        break;
      case ALFRED_SRV_FOCUS: {
        const alfred_focus_snapshot_t *snapshot = &message->as.focus;
        text(output, "type", "focus");
        text(output, "focusId", snapshot->focus_id);
        cJSON_AddNumberToObject(output, "revision", snapshot->revision);
        cJSON_AddBoolToObject(output, "demo", snapshot->demo);
        cJSON_AddBoolToObject(output, "online", snapshot->online);
        cJSON_AddBoolToObject(output, "configured", snapshot->configured);
        if (snapshot->has_categories) {
          cJSON *categories = cJSON_AddArrayToObject(output, "categories");
          for (size_t index = 0; index < snapshot->category_count; ++index) {
            const alfred_focus_category_t *category = &snapshot->categories[index];
            cJSON *item = cJSON_CreateObject();
            text(item, "id", category->id);
            text(item, "title", category->title);
            text(item, "color", category->color);
            cJSON_AddItemToArray(categories, item);
          }
        }
        cJSON *tasks = cJSON_AddArrayToObject(output, "tasks");
        for (size_t index = 0; index < snapshot->count; ++index) {
          const alfred_focus_task_t *task = &snapshot->tasks[index];
          cJSON *item = cJSON_CreateObject();
          text(item, "id", task->id);
          text(item, "title", task->title);
          text(item, "memo", task->memo);
          text(item, "dueAt", task->due_at);
          text(item, "category", task->category == TASK_WORK ? "work" : task->category == TASK_HEALTH ? "health" : "personal");
          if (task->category_id[0]) text(item, "categoryId", task->category_id);
          cJSON_AddBoolToObject(item, "completed", task->completed);
          if (task->has_timer) {
            cJSON *timer = cJSON_AddObjectToObject(item, "timer");
            cJSON_AddNumberToObject(timer, "startedAtMs", task->timer_started_at_ms);
            cJSON_AddNumberToObject(timer, "elapsedSeconds", task->timer_elapsed_seconds);
          }
          if (task->has_spent_time) cJSON_AddNumberToObject(item, "spentTimeSeconds", task->spent_time_seconds);
          cJSON_AddItemToArray(tasks, item);
        }
        break;
      }
      case ALFRED_SRV_TASK_COMPLETED:
      case ALFRED_SRV_TASK_REOPENED:
        text(output, "type", message->type == ALFRED_SRV_TASK_COMPLETED ? "task_completed" : "task_reopened");
        text(output, "id", message->as.task_completed.id);
        text(output, "requestId", message->as.task_completed.request_id);
        break;
      case ALFRED_SRV_TTS_BEGIN:
        text(output, "type", "tts_start");
        text(output, "codec", alfred_audio_encoding_str(message->as.tts_begin.encoding));
        cJSON_AddNumberToObject(output, "sampleRate", message->as.tts_begin.sample_rate);
        cJSON_AddNumberToObject(output, "channels", message->as.tts_begin.channels);
        break;
      case ALFRED_SRV_TASK_TIMER_UPDATED:
        text(output, "type", "task_timer_updated");
        text(output, "id", message->as.task_timer_updated.id);
        text(output, "requestId", message->as.task_timer_updated.request_id);
        text(output, "action", alfred_task_timer_action_str(message->as.task_timer_updated.action));
        break;
      case ALFRED_SRV_TRANSCRIPT:
      case ALFRED_SRV_REPLY: {
        const alfred_text_chunk_t *chunk = message->type == ALFRED_SRV_REPLY ? &message->as.reply : &message->as.transcript;
        text(output, "type", message->type == ALFRED_SRV_REPLY ? "reply" : "transcript");
        text(output, "text", chunk->text);
        cJSON_AddBoolToObject(output, "final", chunk->final);
        break;
      }
      case ALFRED_SRV_ERROR:
        text(output, "type", "error");
        text(output, "code", message->as.error.code);
        text(output, "message", message->as.error.message);
        text(output, "requestId", message->as.error.request_id);
        break;
      case ALFRED_SRV_STATE:
        text(output, "type", "state");
        text(output, "state", alfred_device_state_str(message->as.state));
        break;
      case ALFRED_SRV_TTS_END:
        text(output, "type", "tts_end");
        break;
      case ALFRED_SRV_PONG:
        text(output, "type", "pong");
        break;
      default:
        break;
    }
  }
  char *json = cJSON_PrintUnformatted(output);
  if (!json) return 4;
  puts(json);
  free(json);
  cJSON_Delete(output);
  free(message);
  free(input);
  return 0;
}
