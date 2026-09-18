// SPDX-License-Identifier: MIT
// Native 368 x 448 Hermes pocket surface. All coordinates come from design.pen.
// No bitmap assets, SD card or cloud credentials are required to render the UI.
#include "ui/ui.h"
#include "board/board.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#if ALFRED_ENABLE_DEMO
#include "nvs.h"
#endif
#include "ui/theme.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const char *TAG = "pocket_ui";
#define DRAW_LINES 40
#define ACK_TIMEOUT_MS 10000
#define COMPLETE_HOLD_MS 1250
#define SENT_HOLD_MS 1000
#define PAGE_SLIDE_MS 220
#define PAGE_HEIGHT 448
#define HEADER_END_Y 92

typedef enum {
  PAGE_FOCUS,
  PAGE_TODAY,
  PAGE_MEMO,
  PAGE_LISTENING,
  PAGE_THINKING,
  PAGE_SENT,
  PAGE_OFFLINE
} page_t;
typedef struct {
  lv_obj_t *root, *body, *clock, *link, *status, *battery, *footer, *hint,
      *grabber;
  lv_obj_t *hero, *title, *wave[5], *dots[3], *particles[9];
  lv_obj_t *outgoing, *scroll, *memo_fade;
  alfred_focus_snapshot_t *snapshot, *deferred;
  bool has_deferred, connected, configured, demo, touch_down, touch_hold;
  bool pending, acknowledged, completing, rebuild, focus_received;
  bool connection_failed, server_demo;
  bool gesture_moved, transition, ignore_touch, press_at_top, press_at_bottom;
  page_t page, rendered_page;
  int slide_direction;
  int selected, battery_pct;
  bool charging;
  char pending_id[ALFRED_TASK_ID_MAX], request_id[ALFRED_REQUEST_ID_MAX];
  char note[128];
  uint32_t request_counter, pending_since, complete_since, touch_since,
      last_clock, sent_since;
  int16_t press_x, press_y, last_x, last_y;
  ui_action_cb_t action;
  void *action_user;
} ui_ctx_t;
static ui_ctx_t s;
static SemaphoreHandle_t s_mutex;
static lv_display_t *s_display;
static lv_indev_t *s_touch;
static uint8_t *s_buf1, *s_buf2;

void ui_lock(void) {
  if (s_mutex)
    xSemaphoreTakeRecursive(s_mutex, portMAX_DELAY);
}
void ui_unlock(void) {
  if (s_mutex)
    xSemaphoreGiveRecursive(s_mutex);
}
static uint32_t ticks(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static void copy(char *dst, size_t cap, const char *src) {
  if (!src)
    src = "";
  size_t n = strnlen(src, cap - 1);
  // Never leave a truncated UTF-8 sequence at the end of a device label.
  if (src[n])
    while (n && (((uint8_t)src[n] & 0xC0) == 0x80))
      n--;
  memcpy(dst, src, n);
  dst[n] = 0;
}
static void emit(ui_action_t action, const char *id, const char *request) {
  if (s.action)
    s.action(action, id, request, s.action_user);
}
static lv_color_t color(uint32_t hex) { return lv_color_hex(hex); }
static uint32_t category_color(alfred_task_category_t c) {
  return c == TASK_HEALTH     ? POCKET_HEALTH
         : c == TASK_PERSONAL ? POCKET_PERSONAL
                              : POCKET_WORK;
}
static const char *category_name(alfred_task_category_t c) {
  return c == TASK_HEALTH ? "Health" : c == TASK_PERSONAL ? "Personal" : "Work";
}
static int find_task(const char *id) {
  for (size_t i = 0; i < s.snapshot->count; ++i)
    if (!strcmp(id, s.snapshot->tasks[i].id))
      return (int)i;
  return -1;
}
static int active_index(void) {
  if (s.selected >= 0 && s.selected < (int)s.snapshot->count &&
      !s.snapshot->tasks[s.selected].completed)
    return s.selected;
  int idx = find_task(s.snapshot->focus_id);
  if (idx >= 0 && !s.snapshot->tasks[idx].completed)
    return idx;
  for (size_t i = 0; i < s.snapshot->count; ++i)
    if (!s.snapshot->tasks[i].completed)
      return (int)i;
  return -1;
}
static alfred_focus_task_t *active_task(void) {
  int idx = active_index();
  return idx >= 0 ? &s.snapshot->tasks[idx] : NULL;
}
static bool has_focus_data(void) {
  return s.focus_received || s.demo;
}
static bool live_actions_ready(void) {
  return s.focus_received && !s.server_demo && s.connected &&
         s.snapshot->online;
}

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_remove_style_all(o);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_size(o, w, h);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
  return o;
}
static lv_obj_t *scroll_view(lv_obj_t *parent, int x, int y, int w, int h) {
  lv_obj_t *view = box(parent, x, y, w, h);
  lv_obj_add_flag(view, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE |
                            LV_OBJ_FLAG_SCROLL_MOMENTUM);
  lv_obj_remove_flag(view, LV_OBJ_FLAG_SCROLL_CHAIN_HOR |
                               LV_OBJ_FLAG_SCROLL_CHAIN_VER |
                               LV_OBJ_FLAG_SCROLL_ELASTIC);
  lv_obj_set_scroll_dir(view, LV_DIR_VER);
  lv_obj_set_scrollbar_mode(view, LV_SCROLLBAR_MODE_AUTO);
  lv_obj_set_style_bg_color(view, color(0x4C4C54), LV_PART_SCROLLBAR);
  lv_obj_set_style_bg_opa(view, LV_OPA_COVER, LV_PART_SCROLLBAR);
  lv_obj_set_style_width(view, 3, LV_PART_SCROLLBAR);
  lv_obj_set_style_radius(view, 2, LV_PART_SCROLLBAR);
  lv_obj_set_style_pad_right(view, 3, LV_PART_SCROLLBAR);
  return view;
}
static lv_obj_t *label(lv_obj_t *parent, int x, int y, int w, const char *text,
                       const lv_font_t *font, uint32_t hex) {
  lv_obj_t *o = lv_label_create(parent);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_width(o, w);
  lv_obj_set_style_text_font(o, font, 0);
  lv_obj_set_style_text_color(o, color(hex), 0);
  lv_obj_set_style_text_line_space(o, 3, 0);
  lv_label_set_text(o, text);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
  return o;
}
static void draw_line(lv_layer_t *layer, int x1, int y1, int x2, int y2,
                      int width, uint32_t hex) {
  lv_draw_line_dsc_t d;
  lv_draw_line_dsc_init(&d);
  d.p1.x = x1;
  d.p1.y = y1;
  d.p2.x = x2;
  d.p2.y = y2;
  d.width = width;
  d.color = color(hex);
  d.round_start = 1;
  d.round_end = 1;
  lv_draw_line(layer, &d);
}
// Exactly the four overlapping circular lobes from the Todomate flower path.
// Lower 24 bits: fill. Bit 24: check. Bit 25: sleepy eyes.
static void flower_draw(lv_event_t *e) {
  lv_obj_t *o = lv_event_get_target(e);
  uintptr_t style = (uintptr_t)lv_obj_get_user_data(o);
  lv_area_t a;
  lv_obj_get_coords(o, &a);
  int size = lv_area_get_width(&a);
  lv_layer_t *layer = lv_event_get_layer(e);
  lv_draw_rect_dsc_t d;
  lv_draw_rect_dsc_init(&d);
  d.bg_color = color(style & 0xFFFFFF);
  d.bg_opa = LV_OPA_COVER;
  d.radius = LV_RADIUS_CIRCLE;
  for (int row = 0; row < 2; row++)
    for (int col = 0; col < 2; col++) {
      lv_area_t circle = {a.x1 + size * (2 + col * 36) / 100,
                          a.y1 + size * (2 + row * 36) / 100,
                          a.x1 + size * (62 + col * 36) / 100 - 1,
                          a.y1 + size * (62 + row * 36) / 100 - 1};
      lv_draw_rect(layer, &d, &circle);
    }
  if (style & 0x1000000) {
    int w = size / 16;
    if (w < 2)
      w = 2;
    draw_line(layer, a.x1 + size * 35 / 100, a.y1 + size * 51 / 100,
              a.x1 + size * 46 / 100, a.y1 + size * 61 / 100, w, POCKET_TEXT);
    draw_line(layer, a.x1 + size * 46 / 100, a.y1 + size * 61 / 100,
              a.x1 + size * 65 / 100, a.y1 + size * 41 / 100, w, POCKET_TEXT);
  }
  if (style & 0x2000000)
    for (int i = 0; i < 2; i++) {
      int x = a.x1 + size * (30 + i * 27) / 100, y = a.y1 + size * 47 / 100;
      draw_line(layer, x, y, x + size * 6 / 100, y + size * 3 / 100, 3,
                0xA6A6AE);
      draw_line(layer, x + size * 6 / 100, y + size * 3 / 100,
                x + size * 12 / 100, y, 3, 0xA6A6AE);
    }
}
static lv_obj_t *flower(lv_obj_t *parent, int x, int y, int size, uint32_t hex,
                        bool checked) {
  lv_obj_t *o = box(parent, x, y, size, size);
  lv_obj_set_user_data(o, (void *)(uintptr_t)(hex | (checked ? 0x1000000 : 0)));
  lv_obj_add_event_cb(o, flower_draw, LV_EVENT_DRAW_MAIN, NULL);
  return o;
}
static void mic_draw(lv_event_t *e) {
  lv_area_t a;
  lv_obj_get_coords(lv_event_get_target(e), &a);
  lv_layer_t *layer = lv_event_get_layer(e);
  lv_draw_rect_dsc_t d;
  lv_draw_rect_dsc_init(&d);
  d.bg_opa = 0;
  d.border_width = 1;
  d.border_color = color(POCKET_DIM);
  d.radius = 4;
  lv_area_t r = {a.x1 + 5, a.y1 + 1, a.x1 + 10, a.y1 + 10};
  lv_draw_rect(layer, &d, &r);
  draw_line(layer, a.x1 + 2, a.y1 + 7, a.x1 + 3, a.y1 + 12, 1, POCKET_DIM);
  draw_line(layer, a.x1 + 3, a.y1 + 12, a.x1 + 7, a.y1 + 14, 1, POCKET_DIM);
  draw_line(layer, a.x1 + 7, a.y1 + 14, a.x1 + 12, a.y1 + 12, 1, POCKET_DIM);
  draw_line(layer, a.x1 + 12, a.y1 + 12, a.x1 + 13, a.y1 + 7, 1, POCKET_DIM);
  draw_line(layer, a.x1 + 7, a.y1 + 14, a.x1 + 7, a.y1 + 17, 1, POCKET_DIM);
}
static void battery_draw(lv_event_t *e) {
  lv_area_t a;
  lv_obj_get_coords(lv_event_get_target(e), &a);
  lv_layer_t *layer = lv_event_get_layer(e);
  lv_draw_rect_dsc_t d;
  lv_draw_rect_dsc_init(&d);
  d.bg_opa = 0;
  d.border_width = 1;
  d.border_color = color(POCKET_SECONDARY);
  d.radius = 2;
  lv_area_t r = {a.x1, a.y1 + 5, a.x1 + 17, a.y1 + 16};
  lv_draw_rect(layer, &d, &r);
  draw_line(layer, a.x1 + 20, a.y1 + 8, a.x1 + 20, a.y1 + 12, 2,
            POCKET_SECONDARY);
  if (s.battery_pct >= 0) {
    int fill = (s.battery_pct * 12) / 100;
    if (fill > 0) {
      d.border_width = 0;
      d.bg_opa = LV_OPA_COVER;
      d.bg_color = color(s.charging ? POCKET_GREEN : POCKET_SECONDARY);
      r = (lv_area_t){a.x1 + 3, a.y1 + 8, a.x1 + 2 + fill, a.y1 + 13};
      lv_draw_rect(layer, &d, &r);
    }
  } else
    draw_line(layer, a.x1 + 6, a.y1 + 10, a.x1 + 11, a.y1 + 10, 1, POCKET_DIM);
}
static int pill(lv_obj_t *parent, int x, int y, alfred_task_category_t category,
                bool small) {
  int width = category == TASK_PERSONAL ? 115
              : category == TASK_HEALTH ? 101
                                        : 91;
  int height = small ? 30 : 38;
  lv_obj_t *o = box(parent, x, y, width, height);
  lv_obj_set_style_bg_color(o, color(POCKET_SURFACE), 0);
  lv_obj_set_style_bg_opa(o, 255, 0);
  lv_obj_set_style_radius(o, LV_RADIUS_CIRCLE, 0);
  flower(o, 13, small ? 9 : 12, 13, category_color(category), false);
  label(o, 33, small ? 5 : 8, width - 37, category_name(category), &inter_17,
        category_color(category));
  return width;
}
static void set_hint(const char *text, uint32_t hex, bool microphone) {
  lv_obj_clean(s.footer);
  lv_obj_t *l = label(s.footer, 0, 0, 320, text, &inter_14, hex);
  lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
  if (microphone) {
    lv_obj_t *m = box(s.footer, 113 - 22, 1, 16, 18);
    lv_obj_add_event_cb(m, mic_draw, LV_EVENT_DRAW_MAIN, NULL);
  }
  s.hint = l;
}
static void format_due(const char *iso, char *out, size_t cap) {
  if (!iso || !iso[0]) {
    out[0] = 0;
    return;
  }
  int y, mo, d, h, mi;
  if (sscanf(iso, "%d-%d-%dT%d:%d", &y, &mo, &d, &h, &mi) == 5) {
    struct tm parsed = {.tm_year = y - 1900,
                        .tm_mon = mo - 1,
                        .tm_mday = d,
                        .tm_hour = h,
                        .tm_min = mi,
                        .tm_isdst = -1};
    const char *zone = strlen(iso) > 19 ? strpbrk(iso + 19, "Zz+-") : NULL;
    time_t due;
    if (zone) {
      // Gregorian civil date to Unix days, independent of the configured TZ.
      int year = y - (mo <= 2), era = (year >= 0 ? year : year - 399) / 400;
      unsigned yoe = year - era * 400;
      unsigned doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
      unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
      int64_t days = (int64_t)era * 146097 + doe - 719468;
      due = (time_t)(days * 86400 + h * 3600 + mi * 60);
      int oh = 0, om = 0;
      if ((*zone == '+' || *zone == '-') &&
          sscanf(zone + 1, "%d:%d", &oh, &om) == 2)
        due -= (*zone == '+' ? 1 : -1) * (oh * 3600 + om * 60);
    } else {
      due = mktime(&parsed);
    }
    struct tm local_due, now_local;
    localtime_r(&due, &local_due);
    time_t now = time(NULL);
    localtime_r(&now, &now_local);
    if (now_local.tm_yday == local_due.tm_yday &&
        now_local.tm_year == local_due.tm_year)
      snprintf(out, cap, "Today %02d:%02d", local_due.tm_hour,
               local_due.tm_min);
    else
      snprintf(out, cap, "%02d/%02d %02d:%02d", local_due.tm_mday,
               local_due.tm_mon + 1, local_due.tm_hour, local_due.tm_min);
  } else
    copy(out, cap, iso);
}
static void update_status(void) {
  time_t now = time(NULL);
  struct tm local;
  localtime_r(&now, &local);
  char clock[16];
  if (local.tm_year < 120)
    strcpy(clock, "--:--");
  else
    strftime(clock, sizeof(clock), "%H:%M", &local);
  lv_label_set_text(s.clock, clock);
  lv_obj_set_style_bg_color(s.link,
                            color(s.demo ? POCKET_PERSONAL
                                  : live_actions_ready()
                                      ? POCKET_GREEN
                                      : 0xE8927C),
                            0);
  lv_label_set_text(s.status, s.demo ? "Demo"
                              : !s.configured || s.server_demo ? "Setup"
                              : !has_focus_data() && !s.connection_failed
                                  ? "Connecting"
                              : (!s.connected || !s.snapshot->online)
                                  ? "Offline"
                                  : "");
  lv_obj_invalidate(s.battery);
}

static void show_page(page_t page) {
  s.page = page;
  s.rebuild = true;
}
static void pop_scale(void *obj, int32_t scale) {
  lv_obj_set_style_transform_scale_x(obj, scale, 0);
  lv_obj_set_style_transform_scale_y(obj, scale, 0);
}
static void animate_pop(lv_obj_t *obj) {
  lv_obj_set_style_transform_pivot_x(obj, 60, 0);
  lv_obj_set_style_transform_pivot_y(obj, 60, 0);
  lv_anim_t a;
  lv_anim_init(&a);
  lv_anim_set_var(&a, obj);
  lv_anim_set_values(&a, 210, 256);
  lv_anim_set_duration(&a, 420);
  lv_anim_set_exec_cb(&a, pop_scale);
  lv_anim_set_path_cb(&a, lv_anim_path_overshoot);
  lv_anim_start(&a);
}
#if ALFRED_ENABLE_DEMO
static void seed_demo(void) {
  memset(s.snapshot, 0, sizeof(*s.snapshot));
  s.snapshot->count = 5;
  s.snapshot->demo = true;
  static const alfred_focus_task_t tasks[] = {
      {.id = "demo-investor",
       .due_at = "Today 16:15",
       .title = "Prep Friday's investor demo",
       .category = TASK_WORK,
       .memo =
           "Storyboard the recall demo, export the deck to the iPad, and "
           "rehearse the pitch end to end.\n\nCheck the demo account has fresh "
           "data and clear the browser profile before going on stage.\n\nOpen "
           "with the memory question: ask Hermes what changed since Monday and "
           "let it answer live on screen.\n\nIf the connection drops, skip to "
           "the screenshots and keep the story moving."},
      {.id = "demo-term-sheet",
       .due_at = "Today 16:15",
       .title = "Reply to the term sheet",
       .category = TASK_WORK,
       .memo = "Read through the final terms and send a considered reply. Keep "
               "any open questions together."},
      {.id = "demo-fruit",
       .title = "Eat a fruit",
       .category = TASK_HEALTH,
       .completed = true},
      {.id = "demo-walk",
       .title = "Walk 20 min after lunch",
       .category = TASK_HEALTH,
       .memo = "Take a break outside. Leave your phone in your pocket and "
               "enjoy a little fresh air."},
      {.id = "demo-notary",
       .title = "Call the notary",
       .category = TASK_PERSONAL,
       .memo = "Confirm the appointment and ask which documents to bring."}};
  memcpy(s.snapshot->tasks, tasks, sizeof(tasks));
  copy(s.snapshot->focus_id, sizeof(s.snapshot->focus_id), tasks[0].id);
  nvs_handle_t h;
  uint32_t mask = 0;
  if (nvs_open("pocket", NVS_READONLY, &h) == ESP_OK) {
    nvs_get_u32(h, "demo_done", &mask);
    nvs_close(h);
  }
  for (size_t i = 0; i < s.snapshot->count; i++)
    if (mask & (1u << i))
      s.snapshot->tasks[i].completed = true;
  s.demo = true;
}
static void save_demo(void) {
  uint32_t mask = 0;
  for (size_t i = 0; i < s.snapshot->count; i++)
    if (s.snapshot->tasks[i].completed)
      mask |= 1u << i;
  nvs_handle_t h;
  if (nvs_open("pocket", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_u32(h, "demo_done", mask);
    nvs_commit(h);
    nvs_close(h);
  }
}
#endif
static void begin_complete(void) {
  if (s.pending || s.completing)
    return;
  if (!has_focus_data()) {
    if (s.configured)
      emit(UI_REFRESH, NULL, NULL);
    return;
  }
  alfred_focus_task_t *task = active_task();
  if (!task)
    return;
  if (!s.demo && !live_actions_ready()) {
    show_page(PAGE_OFFLINE);
    return;
  }
  s.note[0] = 0;
  copy(s.pending_id, sizeof(s.pending_id), task->id);
  snprintf(s.request_id, sizeof(s.request_id), "device-%08lx-%lu",
           (unsigned long)ticks(), (unsigned long)++s.request_counter);
  s.pending = true;
  s.completing = true;
  s.pending_since = ticks();
  s.complete_since = ticks();
  s.acknowledged = false;
#if ALFRED_ENABLE_DEMO
  s.acknowledged = s.demo && !s.connected;
#endif
  if (!s.acknowledged)
    emit(UI_COMPLETE, s.pending_id, s.request_id);
  s.rebuild = true;
}
static void cancel_pending(const char *note) {
  s.pending = false;
  s.completing = false;
  s.acknowledged = false;
  copy(s.note, sizeof(s.note), note);
  s.pending_id[0] = 0;
  s.request_id[0] = 0;
  if (s.has_deferred) {
    memcpy(s.snapshot, s.deferred, sizeof(*s.snapshot));
    s.has_deferred = false;
  }
  s.rebuild = true;
}
static void finish_complete(void) {
  int idx = find_task(s.pending_id);
  if (idx >= 0)
    s.snapshot->tasks[idx].completed = true;
  if (s.has_deferred) {
    memcpy(s.snapshot, s.deferred, sizeof(*s.snapshot));
    s.has_deferred = false;
  }
#if ALFRED_ENABLE_DEMO
  if (s.demo && !s.connected)
    save_demo();
#endif
  s.pending = false;
  s.completing = false;
  s.acknowledged = false;
  s.pending_id[0] = 0;
  s.request_id[0] = 0;
  s.selected = -1;
  s.note[0] = 0;
  show_page(PAGE_FOCUS);
}
static void build_offline(void);
static void build_focus(void) {
  if (!has_focus_data()) {
    build_offline();
    return;
  }
  alfred_focus_task_t *task = active_task();
  if (!task) {
    s.hero = flower(s.body, 124, 137, 120, POCKET_UNCHECKED, false);
    lv_obj_set_user_data(s.hero,
                         (void *)(uintptr_t)(POCKET_UNCHECKED | 0x2000000));
    label(s.body, 231, 126, 25, "z", &inter_17, 0x5E5E66);
    label(s.body, 247, 112, 20, "z", &inter_14, 0x4C4C54);
    lv_obj_t *l = label(s.body, 24, 286, 320, "Good job, enjoy the calm.",
                        &inter_17, POCKET_SECONDARY);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
  } else {
    int pw = pill(s.body, 24, 78, task->category, false);
    if (!s.completing) {
      char due[48];
      format_due(task->due_at, due, sizeof(due));
      label(s.body, 24 + pw + 12, 89, 202, due, &inter_14, POCKET_SECONDARY);
    }
    s.hero =
        flower(s.body, 32, 146, 120,
               s.completing ? category_color(task->category) : POCKET_UNCHECKED,
               s.completing);
    s.title = label(s.body, 24, 297, 320, task->title, &inter_34, POCKET_TEXT);
    lv_obj_set_style_text_letter_space(s.title, -1, 0);
    lv_obj_set_style_text_line_space(s.title, -3, 0);
    if (strlen(task->title) > 50) {
      lv_obj_set_style_text_font(s.title, &inter_28, 0);
      lv_obj_set_style_text_line_space(s.title, 0, 0);
    }
    lv_obj_set_height(s.title, 108);
    lv_label_set_long_mode(s.title, LV_LABEL_LONG_DOT);
    if (s.completing) {
      animate_pop(s.hero);
      const uint32_t colors[] = {0xE8927C,     POCKET_PERSONAL, POCKET_GREEN,
                                 POCKET_WORK,  POCKET_PERSONAL, POCKET_TEXT,
                                 POCKET_GREEN, 0xEFC743,        POCKET_WORK};
      for (int i = 0; i < 9; i++)
        s.particles[i] =
            flower(s.body, 92, 206, (i % 3) * 3 + 4, colors[i], false);
    }
  }
  if (s.completing)
    set_hint(s.acknowledged ? "Nice." : "Saving...",
             task ? category_color(task->category) : POCKET_SECONDARY, false);
  else if (s.note[0]) {
    set_hint(s.note, 0xE8927C, false);
    lv_label_set_long_mode(s.hint, LV_LABEL_LONG_SCROLL_CIRCULAR);
  } else
    set_hint("Hold to talk", POCKET_DIM, true);
}
static void row_clicked(lv_event_t *e) {
  if (s.gesture_moved)
    return;
  s.selected = (int)(intptr_t)lv_event_get_user_data(e);
  show_page(PAGE_FOCUS);
}
static void build_today(void) {
  label(s.body, 24, 49, 200, "Today", &inter_23, POCKET_TEXT);
  unsigned done = 0;
  for (size_t i = 0; i < s.snapshot->count; i++)
    if (s.snapshot->tasks[i].completed)
      done++;
  char count[20];
  snprintf(count, sizeof(count), "%u/%u", done, (unsigned)s.snapshot->count);
  flower(s.body, 305, 55, 12, POCKET_GREEN, false);
  label(s.body, 324, 52, 40, count, &inter_14, POCKET_SECONDARY);
  lv_obj_t *list = scroll_view(s.body, 24, 84, 344, 348);
  s.scroll = list;
  int y = 0;
  for (int category = TASK_WORK; category <= TASK_PERSONAL; category++) {
    bool any = false;
    for (size_t i = 0; i < s.snapshot->count; i++)
      if (s.snapshot->tasks[i].category == category)
        any = true;
    if (!any)
      continue;
    pill(list, 10, y, category, true);
    y += 34;
    for (size_t i = 0; i < s.snapshot->count; i++) {
      alfred_focus_task_t *task = &s.snapshot->tasks[i];
      if (task->category != category)
        continue;
      bool active = (int)i == active_index();
      lv_obj_t *row = box(list, 0, y, 320, 60);
      lv_obj_add_flag(row, LV_OBJ_FLAG_CLICKABLE);
      if (active) {
        lv_obj_set_style_bg_color(row, color(0x161618), 0);
        lv_obj_set_style_bg_opa(row, 255, 0);
        lv_obj_set_style_radius(row, 14, 0);
      }
      flower(row, 10, 9, 38,
             task->completed ? category_color(task->category) : POCKET_UNCHECKED,
             task->completed);
      lv_obj_t *l = label(row, 60, 6, active ? 220 : 253, task->title,
                          &inter_20, POCKET_TEXT);
      lv_obj_set_height(l, 50);
      lv_label_set_long_mode(l, LV_LABEL_LONG_DOT);
      if (active)
        label(row, 283, 22, 36, "now", &inter_14, category_color(task->category));
      lv_obj_add_event_cb(row, row_clicked, LV_EVENT_SHORT_CLICKED,
                          (void *)(intptr_t)i);
      y += 62;
    }
    y += 10;
  }
  lv_obj_add_flag(s.footer, LV_OBJ_FLAG_HIDDEN);
}
static void update_memo_affordances(void) {
  if (!s.scroll || !s.memo_fade || s.page != PAGE_MEMO)
    return;
  bool more_below = lv_obj_get_scroll_bottom(s.scroll) > 2;
  if (more_below)
    lv_obj_remove_flag(s.memo_fade, LV_OBJ_FLAG_HIDDEN);
  else
    lv_obj_add_flag(s.memo_fade, LV_OBJ_FLAG_HIDDEN);
}
static void memo_scrolled(lv_event_t *event) {
  if (lv_event_get_target(event) == s.scroll)
    update_memo_affordances();
}
static void build_memo(void) {
  alfred_focus_task_t *task = active_task();
  lv_obj_t *badge = box(s.body, 24, 59, 24, 24);
  lv_obj_set_style_bg_color(badge, color(0xF4C63F), 0);
  lv_obj_set_style_bg_opa(badge, 255, 0);
  lv_obj_set_style_radius(badge, 12, 0);
  label(badge, 7, 3, 14, "=", &inter_14, POCKET_TEXT);
  label(s.body, 57, 62, 240, "Memo", &inter_17, POCKET_SECONDARY);
  lv_obj_t *scroll = scroll_view(s.body, 24, 101, 344, 331);
  s.scroll = scroll;
  lv_obj_t *l =
      label(scroll, 0, 0, 312,
            task && task->memo[0] ? task->memo : "No memo for this task yet.",
            &inter_17, 0xC7C7CD);
  lv_obj_set_style_text_line_space(l, 4, 0);
  s.memo_fade = box(s.body, 24, 404, 320, 28);
  lv_obj_set_style_bg_color(s.memo_fade, color(0), 0);
  lv_obj_set_style_bg_grad_color(s.memo_fade, color(0), 0);
  lv_obj_set_style_bg_grad_dir(s.memo_fade, LV_GRAD_DIR_VER, 0);
  lv_obj_set_style_bg_opa(s.memo_fade, LV_OPA_TRANSP, 0);
  lv_obj_set_style_bg_grad_opa(s.memo_fade, LV_OPA_COVER, 0);
  lv_obj_add_event_cb(scroll, memo_scrolled, LV_EVENT_SCROLL, NULL);
  lv_obj_add_flag(s.footer, LV_OBJ_FLAG_HIDDEN);
  lv_obj_update_layout(scroll);
  update_memo_affordances();
}
static void build_voice(void) {
  if (s.page == PAGE_LISTENING) {
    const int heights[] = {26, 58, 88, 44, 30};
    for (int i = 0; i < 5; i++) {
      s.wave[i] =
          box(s.body, 144 + i * 18, 158 + (88 - heights[i]) / 2, 9, heights[i]);
      lv_obj_set_style_bg_color(s.wave[i], color(POCKET_TEXT), 0);
      lv_obj_set_style_bg_opa(s.wave[i], 255, 0);
      lv_obj_set_style_radius(s.wave[i], 5, 0);
    }
    lv_obj_t *dot = box(s.body, 116, 283, 8, 8);
    lv_obj_set_style_radius(dot, 4, 0);
    lv_obj_set_style_bg_color(dot, color(POCKET_GREEN), 0);
    lv_obj_set_style_bg_opa(dot, 255, 0);
    label(s.body, 135, 273, 160, "Listening", &inter_23, POCKET_TEXT);
    set_hint("Release to send", POCKET_DIM, false);
  } else if (s.page == PAGE_THINKING) {
    for (int i = 0; i < 3; i++)
      s.dots[i] = flower(s.body, 140 + i * 34, 192, 20,
                         i == 2 ? POCKET_GREEN : POCKET_UNCHECKED, false);
    lv_obj_t *l =
        label(s.body, 24, 239, 320, "Sending", &inter_23, POCKET_TEXT);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    set_hint("Tap to cancel", POCKET_DIM, false);
  } else if (s.page == PAGE_SENT) {
    s.hero = flower(s.body, 124, 136, 120, POCKET_GREEN, true);
    animate_pop(s.hero);
    s.title = label(s.body, 24, 278, 320, "Sent!", &inter_28, POCKET_TEXT);
    lv_obj_set_style_text_align(s.title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_add_flag(s.footer, LV_OBJ_FLAG_HIDDEN);
  }
}
static void build_offline(void) {
  flower(s.body, 32, 101, 120, 0x161618, false);
  label(s.body, 72, 143, 48, "~", &inter_34, 0x54545C);
  const char *title = s.demo ? "Meet Hermes soon"
                      : s.server_demo ? "Server setup"
                      : !s.configured ? "Setup needed"
                      : !has_focus_data() && !s.connection_failed
                          ? "Connecting"
                          : "Offline";
  const char *description =
      s.demo ? "This is a demo. Connect Hermes to talk and sync your real tasks."
      : s.server_demo
          ? "The server is in demo mode. Connect it to TodoMate to load your tasks."
      : !s.configured
          ? "Connect Wi-Fi and add your server settings to load your tasks."
      : !has_focus_data() && s.connected && !s.connection_failed
          ? "Connected. Waiting for your tasks."
      : !has_focus_data() && !s.connection_failed
          ? "Connecting to your server to load your tasks."
      : !has_focus_data()
          ? "Can't reach your server. Retrying automatically."
          : "Can't reach your server. Your focus is kept here while we reconnect.";
  label(s.body, 24, 246, 320, title,
        &inter_34, POCKET_TEXT);
  label(s.body, 24, 302, 320, description,
        &inter_17, POCKET_SECONDARY);
  set_hint(s.demo ? "Tap to return"
           : !s.configured ? "Setup needed"
                          : "Tap to retry", POCKET_DIM, false);
}
static void update_handle(void) {
  bool main_or_sheet =
      s.page == PAGE_FOCUS || s.page == PAGE_TODAY || s.page == PAGE_MEMO;
  if (!main_or_sheet || s.transition || !has_focus_data())
    lv_obj_add_flag(s.grabber, LV_OBJ_FLAG_HIDDEN);
  else {
    lv_obj_set_y(s.grabber, s.page == PAGE_FOCUS ? 439 : 7);
    lv_obj_remove_flag(s.grabber, LV_OBJ_FLAG_HIDDEN);
  }
}
static void slide_step(void *context, int32_t progress) {
  (void)context;
  lv_obj_set_y(s.body, s.slide_direction * (PAGE_HEIGHT - progress));
  if (s.outgoing)
    lv_obj_set_y(s.outgoing, -s.slide_direction * progress);
}
static void finish_slide(void) {
  lv_anim_delete(&s, slide_step);
  if (s.outgoing) {
    lv_obj_delete(s.outgoing);
    s.outgoing = NULL;
  }
  if (s.body)
    lv_obj_set_y(s.body, 0);
  s.transition = false;
  update_handle();
}
static void slide_finished(lv_anim_t *animation) {
  (void)animation;
  // This callback already runs after the animation was removed from LVGL.
  if (s.outgoing) {
    lv_obj_delete(s.outgoing);
    s.outgoing = NULL;
  }
  lv_obj_set_y(s.body, 0);
  s.transition = false;
  update_handle();
}
static int slide_direction(page_t from, page_t to) {
  if ((from == PAGE_FOCUS && to == PAGE_TODAY) ||
      (from == PAGE_MEMO && to == PAGE_FOCUS))
    return 1;
  if ((from == PAGE_TODAY && to == PAGE_FOCUS) ||
      (from == PAGE_FOCUS && to == PAGE_MEMO))
    return -1;
  return 0;
}
static void rebuild(void) {
  int direction = s.body ? slide_direction(s.rendered_page, s.page) : 0;
  int saved_scroll =
      s.scroll && s.page == s.rendered_page ? lv_obj_get_scroll_y(s.scroll) : 0;
  if (s.transition)
    finish_slide();
  lv_obj_t *previous = s.body;
  // Build the replacement in one locked pass. The old tree is kept until the
  // slide finishes; the display never sees an empty intermediate frame.
  s.body = box(s.root, 0, 0, 368, PAGE_HEIGHT);
  lv_obj_set_style_bg_color(s.body, color(POCKET_BG), 0);
  lv_obj_set_style_bg_opa(s.body, LV_OPA_COVER, 0);
  lv_obj_move_to_index(s.body, 0);
  s.footer = box(s.body, 24, 417, 320, 23);
  if (s.page == PAGE_FOCUS)
    lv_obj_add_flag(s.footer, LV_OBJ_FLAG_CLICKABLE);
  memset(s.wave, 0, sizeof(s.wave));
  memset(s.dots, 0, sizeof(s.dots));
  memset(s.particles, 0, sizeof(s.particles));
  s.hero = NULL;
  s.title = NULL;
  s.hint = NULL;
  s.scroll = NULL;
  s.memo_fade = NULL;
  if (s.page == PAGE_FOCUS)
    build_focus();
  else if (s.page == PAGE_TODAY)
    build_today();
  else if (s.page == PAGE_MEMO)
    build_memo();
  else if (s.page == PAGE_OFFLINE)
    build_offline();
  else
    build_voice();
  if (s.scroll && saved_scroll > 0) {
    lv_obj_update_layout(s.scroll);
    lv_obj_scroll_to_y(s.scroll, saved_scroll, LV_ANIM_OFF);
    update_memo_affordances();
  }
  s.rendered_page = s.page;
  if (direction && previous) {
    s.outgoing = previous;
    s.transition = true;
    s.slide_direction = direction;
    lv_anim_t animation;
    lv_anim_init(&animation);
    lv_anim_set_var(&animation, &s);
    lv_anim_set_values(&animation, 0, PAGE_HEIGHT);
    lv_anim_set_duration(&animation, PAGE_SLIDE_MS);
    lv_anim_set_exec_cb(&animation, slide_step);
    lv_anim_set_path_cb(&animation, lv_anim_path_ease_out);
    lv_anim_set_completed_cb(&animation, slide_finished);
    lv_anim_start(&animation);
  } else if (previous)
    lv_obj_delete(previous);
  update_handle();
  update_status();
  s.rebuild = false;
}
static bool vertical_swipe(int dx, int dy) {
  if (abs(dy) <= abs(dx) * 1.25f)
    return false;
  uint32_t duration = ticks() - s.touch_since;
  return abs(dy) >= 56 || (abs(dy) >= 28 && duration <= 220);
}
static void touch_release_action(int dx, int dy) {
  if (s.touch_hold) {
    s.touch_hold = false;
    ui_handle_ptt(false);
    return;
  }
  if (vertical_swipe(dx, dy)) {
    if (!has_focus_data())
      return;
    bool header = s.press_y < HEADER_END_Y;
    if (s.page == PAGE_FOCUS && !s.pending)
      show_page(dy < 0 ? PAGE_TODAY : PAGE_MEMO);
    else if (s.page == PAGE_TODAY && dy > 0 && (header || s.press_at_top))
      show_page(PAGE_FOCUS);
    else if (s.page == PAGE_MEMO && dy < 0 && (header || s.press_at_bottom))
      show_page(PAGE_FOCUS);
    // Article/list drags otherwise belong exclusively to LVGL, including the
    // gesture that first reaches an edge. A separate outward swipe can dismiss.
    return;
  }
  if (s.gesture_moved)
    return;
  if ((s.page == PAGE_TODAY || s.page == PAGE_MEMO) && s.press_y < HEADER_END_Y)
    show_page(PAGE_FOCUS);
  else if (s.page == PAGE_FOCUS && s.press_y >= 60 && s.press_y < 402)
    begin_complete();
  else if (s.page == PAGE_THINKING) {
    emit(UI_CANCEL, NULL, NULL);
    show_page(PAGE_FOCUS);
  } else if (s.page == PAGE_OFFLINE) {
    if (!s.demo)
      emit(UI_REFRESH, NULL, NULL);
    show_page(PAGE_FOCUS);
  }
}
static void touch_read(lv_indev_t *indev, lv_indev_data_t *data) {
  (void)indev;
  uint16_t x = 0, y = 0;
  bool pressed = false;
  if (board_touch_read(&x, &y, &pressed) != ESP_OK)
    pressed = false;
  if (s.transition || s.ignore_touch) {
    s.ignore_touch = pressed;
    s.touch_down = false;
    data->point.x = s.last_x;
    data->point.y = s.last_y;
    data->state = LV_INDEV_STATE_RELEASED;
    return;
  }
  if (pressed && x < 368 && y < 448) {
    if (!s.touch_down) {
      s.touch_down = true;
      s.touch_hold = false;
      s.gesture_moved = false;
      s.press_x = x;
      s.press_y = y;
      s.touch_since = ticks();
      s.press_at_top = !s.scroll || lv_obj_get_scroll_top(s.scroll) <= 2;
      s.press_at_bottom = !s.scroll || lv_obj_get_scroll_bottom(s.scroll) <= 2;
    }
    s.last_x = x;
    s.last_y = y;
    if (abs((int)x - s.press_x) > 12 || abs((int)y - s.press_y) > 12)
      s.gesture_moved = true;
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PRESSED;
  } else {
    data->point.x = s.last_x;
    data->point.y = s.last_y;
    data->state = LV_INDEV_STATE_RELEASED;
    if (s.touch_down) {
      s.touch_down = false;
      touch_release_action(s.last_x - s.press_x, s.last_y - s.press_y);
    }
  }
}
static void ui_tick(lv_timer_t *timer) {
  (void)timer;
  uint32_t now = ticks();
  if (s.touch_down && !s.touch_hold && !s.gesture_moved && s.press_y > 402 &&
      s.page == PAGE_FOCUS && now - s.touch_since > 420) {
    s.touch_hold = true;
    ui_handle_ptt(true);
  }
  if (s.pending && !s.acknowledged && now - s.pending_since > ACK_TIMEOUT_MS)
    cancel_pending("Not saved. Tap to try again.");
  if (s.completing && s.acknowledged &&
      now - s.complete_since >= COMPLETE_HOLD_MS)
    finish_complete();
  // Matrix has already acknowledged delivery. Return even if its subsequent
  // idle packet is lost while the device disconnects.
  if (s.page == PAGE_SENT && now - s.sent_since >= SENT_HOLD_MS)
    show_page(PAGE_FOCUS);
  // A same-page cloud update must not delete the viewport under a finger.
  if (s.rebuild && (!s.touch_down || s.page != s.rendered_page))
    rebuild();
  if (now - s.last_clock > 1000) {
    update_status();
    s.last_clock = now;
  }
  if (s.completing && s.hero) {
    uint32_t elapsed = now - s.complete_since;
    const int dx[] = {-79, 55, 68, 64, -75, 42, -40, 18, 90};
    const int dy[] = {-56, -79, -20, 42, 47, -88, 69, 77, 28};
    int p = elapsed > 640 ? 640 : elapsed;
    for (int i = 0; i < 9; i++)
      if (s.particles[i]) {
        lv_obj_set_pos(s.particles[i], 92 + dx[i] * p / 640,
                       206 + dy[i] * p / 640);
        lv_obj_set_style_opa(s.particles[i],
                             elapsed < 700 ? 255
                             : elapsed > 1100
                                 ? 0
                                 : 255 - (elapsed - 700) * 255 / 400,
                             0);
      }
  }
  if (s.page == PAGE_LISTENING) {
    for (int i = 0; i < 5; i++)
      if (s.wave[i]) {
        int phase = (now / 18 + i * 21) % 100;
        int h = 18 + (phase < 50 ? phase : 100 - phase) * (i == 2 ? 2 : 1);
        lv_obj_set_height(s.wave[i], h);
        lv_obj_set_y(s.wave[i], 201 - h / 2);
      }
  }
  if (s.page == PAGE_THINKING) {
    for (int i = 0; i < 3; i++)
      if (s.dots[i]) {
        lv_obj_set_user_data(s.dots[i],
                             (void *)(uintptr_t)((now / 280) % 3 == i
                                                     ? POCKET_GREEN
                                                     : POCKET_UNCHECKED));
        lv_obj_invalidate(s.dots[i]);
      }
  }
}
static bool flush_done(esp_lcd_panel_io_handle_t io,
                       esp_lcd_panel_io_event_data_t *event, void *user) {
  (void)io;
  (void)event;
  lv_display_flush_ready(user);
  return false;
}
static void flush(lv_display_t *display, const lv_area_t *area,
                  uint8_t *pixels) {
  esp_lcd_panel_handle_t panel = board_display_panel();
  if (!panel) {
    lv_display_flush_ready(display);
    return;
  }
  lv_draw_sw_rgb565_swap(pixels,
                         lv_area_get_width(area) * lv_area_get_height(area));
  if (esp_lcd_panel_draw_bitmap(panel, area->x1, area->y1, area->x2 + 1,
                                area->y2 + 1, pixels) != ESP_OK)
    lv_display_flush_ready(display);
}
static void render_task(void *arg) {
  (void)arg;
  for (;;) {
    ui_lock();
    uint32_t wait = lv_timer_handler();
    ui_unlock();
    if (wait > 33)
      wait = 33;
    if (wait < 2)
      wait = 2;
    vTaskDelay(pdMS_TO_TICKS(wait));
  }
}
esp_err_t ui_init(void) {
  memset(&s, 0, sizeof(s));
  s.selected = -1;
  s.battery_pct = -1;
  s.snapshot = calloc(1, sizeof(*s.snapshot));
  s.deferred = calloc(1, sizeof(*s.deferred));
  if (!s.snapshot || !s.deferred)
    return ESP_ERR_NO_MEM;
#if ALFRED_ENABLE_DEMO
  seed_demo();
#endif
  lv_init();
  lv_tick_set_cb(ticks);
  s_mutex = xSemaphoreCreateRecursiveMutex();
  if (!s_mutex)
    return ESP_ERR_NO_MEM;
  s_display = lv_display_create(368, 448);
  if (!s_display)
    return ESP_ERR_NO_MEM;
  size_t bytes = 368 * DRAW_LINES * 2;
  s_buf1 = heap_caps_malloc(bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  s_buf2 = heap_caps_malloc(bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  if (!s_buf1 || !s_buf2)
    return ESP_ERR_NO_MEM;
  lv_display_set_buffers(s_display, s_buf1, s_buf2, bytes,
                         LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(s_display, flush);
  esp_lcd_panel_io_handle_t io = board_display_io();
  if (io) {
    esp_lcd_panel_io_callbacks_t cb = {.on_color_trans_done = flush_done};
    ESP_RETURN_ON_ERROR(
        esp_lcd_panel_io_register_event_callbacks(io, &cb, s_display), TAG,
        "flush callback");
  }
  s.root = lv_screen_active();
  lv_obj_remove_style_all(s.root);
  lv_obj_set_style_bg_color(s.root, color(0), 0);
  lv_obj_set_style_bg_opa(s.root, 255, 0);
  lv_obj_remove_flag(s.root, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *status_background = box(s.root, 0, 0, 368, 44);
  lv_obj_set_style_bg_color(status_background, color(0), 0);
  lv_obj_set_style_bg_opa(status_background, LV_OPA_COVER, 0);
  s.clock = label(s.root, 24, 18, 110, "--:--", &inter_17, POCKET_SECONDARY);
  s.status = label(s.root, 220, 20, 80, "", &inter_14, POCKET_DIM);
  lv_obj_set_style_text_align(s.status, LV_TEXT_ALIGN_RIGHT, 0);
  s.link = box(s.root, 306, 25, 7, 7);
  lv_obj_set_style_radius(s.link, 4, 0);
  lv_obj_set_style_bg_opa(s.link, 255, 0);
  s.battery = box(s.root, 322, 17, 22, 22);
  lv_obj_add_event_cb(s.battery, battery_draw, LV_EVENT_DRAW_MAIN, NULL);
  s.grabber = box(s.root, 168, 439, 32, 4);
  lv_obj_set_style_radius(s.grabber, 2, 0);
  lv_obj_set_style_bg_color(s.grabber, color(0x2E2E31), 0);
  lv_obj_set_style_bg_opa(s.grabber, 255, 0);
  s_touch = lv_indev_create();
  lv_indev_set_type(s_touch, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(s_touch, touch_read);
  lv_indev_set_display(s_touch, s_display);
  lv_timer_set_period(lv_indev_get_read_timer(s_touch), 16);
  lv_timer_set_period(lv_display_get_refr_timer(s_display), 20);
  s.page = PAGE_FOCUS;
  rebuild();
  lv_timer_create(ui_tick, 33, NULL);
  if (xTaskCreate(render_task, "pocket_ui", 8192, NULL, 5, NULL) != pdPASS)
    return ESP_ERR_NO_MEM;
  ESP_LOGI(TAG, "native focus UI ready (368x448, %s)",
           ALFRED_ENABLE_DEMO ? "demo enabled" : "production");
  return ESP_OK;
}
void ui_register_actions(ui_action_cb_t cb, void *user) {
  ui_lock();
  s.action = cb;
  s.action_user = user;
  ui_unlock();
}
void ui_set_configured(bool configured) {
  ui_lock();
  s.configured = configured;
  s.rebuild = true;
  update_status();
  ui_unlock();
}
void ui_set_connection(bool connected) {
  ui_lock();
  s.connected = connected;
  s.connection_failed = !connected;
  if (!connected && s.pending)
    cancel_pending("Not saved. Reconnect to try again.");
  if (!connected && (s.page == PAGE_LISTENING || s.page == PAGE_THINKING))
    show_page(PAGE_OFFLINE);
  if (!has_focus_data() || s.page == PAGE_OFFLINE)
    s.rebuild = true;
  update_status();
  ui_unlock();
}
void ui_set_battery(int percent, bool charging) {
  ui_lock();
  s.battery_pct = percent;
  s.charging = charging;
  lv_obj_invalidate(s.battery);
  ui_unlock();
}
bool ui_is_demo(void) {
  ui_lock();
  bool demo = s.demo;
  ui_unlock();
  return demo;
}
void ui_set_focus(const alfred_focus_snapshot_t *snapshot) {
  if (!snapshot)
    return;
  ui_lock();
#if !ALFRED_ENABLE_DEMO
  if (snapshot->demo) {
    s.server_demo = true;
    s.snapshot->online = false;
    if (s.pending)
      cancel_pending("Server is in demo mode. Task not saved.");
    show_page(PAGE_OFFLINE);
    update_status();
    ui_unlock();
    return;
  }
#endif
  s.server_demo = false;
  // An offline, empty initial frame is not confirmation of an empty task list.
  s.focus_received = s.focus_received || snapshot->online || snapshot->count > 0;
  s.connection_failed = !snapshot->online;
  s.demo = snapshot->demo;
  if (s.pending) {
    memcpy(s.deferred, snapshot, sizeof(*snapshot));
    s.has_deferred = true;
  } else {
    memcpy(s.snapshot, snapshot, sizeof(*snapshot));
    s.selected = -1;
    if (s.page == PAGE_OFFLINE && snapshot->online)
      show_page(PAGE_FOCUS);
    else
      s.rebuild = true;
  }
  update_status();
  ui_unlock();
}
void ui_task_completed(const alfred_task_completed_t *ack) {
  ui_lock();
  if (s.pending && !strcmp(s.pending_id, ack->id) &&
      !strcmp(s.request_id, ack->request_id)) {
    s.acknowledged = true;
    if (s.page == PAGE_FOCUS && s.hint)
      lv_label_set_text(s.hint, "Nice.");
  }
  ui_unlock();
}
void ui_set_state(alfred_device_state_t state) {
  // The pocket records voice messages only; legacy spoken-reply states have no UI.
  if (state == ALFRED_STATE_SPEAKING)
    return;
  ui_lock();
  page_t page = state == ALFRED_STATE_LISTENING  ? PAGE_LISTENING
                : state == ALFRED_STATE_THINKING ? PAGE_THINKING
                : state == ALFRED_STATE_SENT ? PAGE_SENT
                                                 : PAGE_FOCUS;
  if (page == PAGE_SENT && s.page != PAGE_SENT)
    s.sent_since = ticks();
  if (s.page != page)
    show_page(page);
  ui_unlock();
}
void ui_show_error(const alfred_error_t *error) {
  ui_lock();
  if (s.pending &&
      (!error->request_id[0] || !strcmp(error->request_id, s.request_id)))
    cancel_pending("Not saved. Tap to try again.");
  else {
    copy(s.note, sizeof(s.note), error->message);
    show_page(PAGE_FOCUS);
  }
  ui_unlock();
}
void ui_handle_back(void) {
  ui_lock();
  if (s.page == PAGE_LISTENING) {
    s.touch_hold = false;
    emit(UI_CANCEL, NULL, NULL);
  } else if (s.page == PAGE_THINKING)
    emit(UI_CANCEL, NULL, NULL);
  show_page(has_focus_data() && s.page == PAGE_FOCUS ? PAGE_TODAY : PAGE_FOCUS);
  ui_unlock();
}
void ui_handle_ptt(bool pressed) {
  ui_lock();
  if (pressed) {
    if (s.pending) {
      ui_unlock();
      return;
    }
    if (s.demo || !live_actions_ready()) {
      show_page(PAGE_OFFLINE);
      ui_unlock();
      return;
    }
    s.note[0] = 0;
    show_page(PAGE_LISTENING);
    emit(UI_PTT_DOWN, NULL, NULL);
  } else {
    if (s.page == PAGE_LISTENING)
      show_page(PAGE_THINKING);
    emit(UI_PTT_UP, NULL, NULL);
  }
  ui_unlock();
}
