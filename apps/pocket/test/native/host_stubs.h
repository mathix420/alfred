#pragma once
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM -2
#define ESP_ERR_INVALID_STATE -3
#define MALLOC_CAP_DMA 1
#define MALLOC_CAP_INTERNAL 2
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_RETURN_ON_ERROR(expr, ...)                                         \
  do {                                                                         \
    int _err = (expr);                                                         \
    if (_err)                                                                  \
      return _err;                                                             \
  } while (0)
static uint32_t fake_ms;
static uint16_t pointer_x, pointer_y;
static bool pointer_down;
static inline int64_t esp_timer_get_time(void) {
  return (int64_t)fake_ms * 1000;
}
static inline void *heap_caps_malloc(size_t n, unsigned caps) {
  (void)caps;
  return malloc(n);
}
typedef void *SemaphoreHandle_t;
#define portMAX_DELAY 0
#define pdPASS 1
#define pdMS_TO_TICKS(x) (x)
static inline SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) {
  return (void *)1;
}
static inline int xSemaphoreTakeRecursive(SemaphoreHandle_t x, int t) {
  (void)x;
  (void)t;
  return 1;
}
static inline int xSemaphoreGiveRecursive(SemaphoreHandle_t x) {
  (void)x;
  return 1;
}
static inline int xTaskCreate(void (*fn)(void *), const char *n, int stack,
                              void *arg, int pri, void *out) {
  (void)fn;
  (void)n;
  (void)stack;
  (void)arg;
  (void)pri;
  (void)out;
  return 1;
}
static inline void vTaskDelay(int ms) { (void)ms; }
typedef void *esp_lcd_panel_io_handle_t;
typedef void *esp_lcd_panel_handle_t;
typedef void *esp_lcd_panel_io_event_data_t;
typedef struct {
  bool (*on_color_trans_done)(esp_lcd_panel_io_handle_t,
                              esp_lcd_panel_io_event_data_t *, void *);
} esp_lcd_panel_io_callbacks_t;
static inline int
esp_lcd_panel_io_register_event_callbacks(esp_lcd_panel_io_handle_t h,
                                          const esp_lcd_panel_io_callbacks_t *c,
                                          void *u) {
  (void)h;
  (void)c;
  (void)u;
  return 0;
}
static inline int esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t h, int x,
                                            int y, int ex, int ey, void *p) {
  (void)h;
  (void)x;
  (void)y;
  (void)ex;
  (void)ey;
  (void)p;
  return 0;
}
static inline esp_lcd_panel_handle_t board_display_panel(void) { return NULL; }
static inline esp_lcd_panel_io_handle_t board_display_io(void) { return NULL; }
static inline int board_touch_read(uint16_t *x, uint16_t *y, bool *pressed) {
  *x = pointer_x;
  *y = pointer_y;
  *pressed = pointer_down;
  return 0;
}
// Only NVS/RTOS/board I/O are mocked; widgets, events and layout use real LVGL.
typedef int nvs_handle_t;
#define NVS_READONLY 0
#define NVS_READWRITE 1
#define ESP_ERR_NVS_NOT_FOUND -4
#define ESP_ERR_NVS_INVALID_LENGTH -5
static char saved_focus[64], staged_focus[64];
static unsigned nvs_commits;
static bool nvs_pending;
static inline int nvs_open(const char *name, int mode, nvs_handle_t *handle) {
  assert(!strcmp(name, "pocket"));
  *handle = mode + 1;
  if (mode == NVS_READWRITE) {
    strcpy(staged_focus, saved_focus);
    nvs_pending = false;
  }
  return ESP_OK;
}
static inline int nvs_get_str(nvs_handle_t handle, const char *key, char *value,
                              size_t *size) {
  (void)handle;
  assert(!strcmp(key, "focus_task"));
  if (!saved_focus[0])
    return ESP_ERR_NVS_NOT_FOUND;
  size_t needed = strlen(saved_focus) + 1;
  if (value && *size < needed) {
    *size = needed;
    return ESP_ERR_NVS_INVALID_LENGTH;
  }
  *size = needed;
  if (value)
    memcpy(value, saved_focus, needed);
  return ESP_OK;
}
static inline int nvs_set_str(nvs_handle_t handle, const char *key,
                              const char *value) {
  assert(handle == NVS_READWRITE + 1 && !strcmp(key, "focus_task"));
  assert(strlen(value) < sizeof(staged_focus));
  strcpy(staged_focus, value);
  nvs_pending = true;
  return ESP_OK;
}
static inline int nvs_erase_key(nvs_handle_t handle, const char *key) {
  assert(handle == NVS_READWRITE + 1 && !strcmp(key, "focus_task"));
  if (!staged_focus[0])
    return ESP_ERR_NVS_NOT_FOUND;
  staged_focus[0] = 0;
  nvs_pending = true;
  return ESP_OK;
}
static inline int nvs_get_u32(nvs_handle_t h, const char *k, uint32_t *v) {
  (void)h;
  (void)k;
  (void)v;
  return ESP_ERR_NVS_NOT_FOUND;
}
static inline int nvs_set_u32(nvs_handle_t h, const char *k, uint32_t v) {
  (void)h;
  (void)k;
  (void)v;
  return ESP_OK;
}
static inline int nvs_commit(nvs_handle_t handle) {
  assert(handle == NVS_READWRITE + 1);
  if (nvs_pending) {
    strcpy(saved_focus, staged_focus);
    nvs_pending = false;
    nvs_commits++;
  }
  return ESP_OK;
}
static inline void nvs_close(nvs_handle_t h) { (void)h; }
