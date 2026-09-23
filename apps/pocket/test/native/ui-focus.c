#include "../../firmware/src/ui/ui.c"
#include <assert.h>
#include <stdio.h>
static uint16_t capture_pixels[448][368];
static void capture_flush(lv_display_t *display, const lv_area_t *area,
                            uint8_t *pixels) {
  const uint16_t *source = (const uint16_t *)pixels;
  for (int y = area->y1; y <= area->y2; ++y)
    for (int x = area->x1; x <= area->x2; ++x)
      capture_pixels[y][x] = *source++;
  lv_display_flush_ready(display);
}
static void capture_screen(const char *name) {
  const char *directory = getenv("ALFRED_NATIVE_CAPTURE_DIR");
  if (!directory)
    return;
  lv_display_set_flush_cb(s_display, capture_flush);
  lv_obj_invalidate(s.root);
  lv_refr_now(s_display);
  lv_display_set_flush_cb(s_display, flush);
  char filename[512];
  snprintf(filename, sizeof(filename), "%s/%s.ppm", directory, name);
  FILE *output = fopen(filename, "wb");
  assert(output);
  fprintf(output, "P6\n368 448\n255\n");
  for (unsigned y = 0; y < 448; ++y)
    for (unsigned x = 0; x < 368; ++x) {
      uint16_t pixel = capture_pixels[y][x];
      uint8_t rgb[] = {(uint8_t)(((pixel >> 11) & 31) * 255 / 31),
                       (uint8_t)(((pixel >> 5) & 63) * 255 / 63),
                       (uint8_t)((pixel & 31) * 255 / 31)};
      assert(fwrite(rgb, 1, sizeof(rgb), output) == sizeof(rgb));
    }
  fclose(output);
}
static void advance(unsigned ms) {
  for (unsigned t = 0; t < ms; t += 10) {
    fake_ms += 10;
    lv_timer_handler();
  }
  lv_obj_update_layout(s.root);
}
static unsigned completions, reopenings;
static unsigned timer_requests[3];
static void action(ui_action_t type, const char *id, const char *request,
                   void *user) {
  (void)id;
  (void)request;
  (void)user;
  if (type == UI_COMPLETE)
    completions++;
  else if (type == UI_REOPEN)
    reopenings++;
  else if (type == UI_TIMER_START)
    timer_requests[ALFRED_TIMER_START]++;
  else if (type == UI_TIMER_PAUSE)
    timer_requests[ALFRED_TIMER_PAUSE]++;
  else if (type == UI_TIMER_STOP)
    timer_requests[ALFRED_TIMER_STOP]++;
}
static bool has_label(lv_obj_t *obj, const char *text) {
  if (lv_obj_check_type(obj, &lv_label_class) &&
      !strcmp(lv_label_get_text(obj), text))
    return true;
  for (unsigned i = 0; i < lv_obj_get_child_count(obj); i++)
    if (has_label(lv_obj_get_child(obj, i), text))
      return true;
  return false;
}
static lv_obj_t *find_row(const char *title) {
  assert(s.page == PAGE_TODAY && s.scroll);
  for (unsigned i = 0; i < lv_obj_get_child_count(s.scroll); i++) {
    lv_obj_t *row = lv_obj_get_child(s.scroll, i);
    if (lv_obj_get_height(row) == 60 && has_label(row, title))
      return row;
  }
  assert(!"Today row missing");
  return NULL;
}
static void choose_task(const char *title) {
  show_page(PAGE_TODAY);
  advance(300);
  s.gesture_moved = false;
  lv_obj_send_event(find_row(title), LV_EVENT_SHORT_CLICKED, NULL);
  advance(300);
}
static void assert_focus(const char *id) {
  assert(active_task() && !strcmp(active_task()->id, id));
  assert(s.page == PAGE_FOCUS && s.title);
  assert(!strcmp(lv_label_get_text(s.title), active_task()->title));
}
static void restart_ui(void) {
  // Simulate RAM loss; the committed NVS mock survives the new initialization.
  pointer_down = false;
  lv_deinit();
  free(s.snapshot);
  free(s.deferred);
  free(s_buf1);
  free(s_buf2);
  s_display = NULL;
  s_touch = NULL;
  s_mutex = NULL;
  s_buf1 = NULL;
  s_buf2 = NULL;
  assert(ui_init() == ESP_OK);
  advance(100);
  ui_register_actions(action, NULL);
  ui_set_configured(true);
}
static void acknowledge_current(void) {
  alfred_task_completed_t ack = {0};
  copy(ack.id, sizeof(ack.id), s.pending_id);
  copy(ack.request_id, sizeof(ack.request_id), s.request_id);
  ui_task_completed(&ack);
  advance(1300);
}
static void selection_checks(void) {
  static alfred_focus_snapshot_t frame;
  frame.online = true;
  frame.configured = true;
  frame.count = 4;
  for (unsigned i = 0; i < 4; i++) {
    snprintf(frame.tasks[i].id, sizeof(frame.tasks[i].id), "chosen-%u", i);
    snprintf(frame.tasks[i].title, sizeof(frame.tasks[i].title),
             "Choose task %u", i);
    frame.tasks[i].category = TASK_WORK;
  }
  frame.tasks[3].completed = true;
  copy(frame.focus_id, sizeof(frame.focus_id), frame.tasks[0].id);
  ui_set_state(ALFRED_STATE_IDLE);
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  choose_task("Choose task 1");
  assert_focus("chosen-1");
  assert(!strcmp(saved_focus, "chosen-1"));
  unsigned committed = nvs_commits;
  // Repeated updates and a new server default must not steal a manual choice.
  ui_set_focus(&frame);
  advance(100);
  assert_focus("chosen-1");
  copy(frame.focus_id, sizeof(frame.focus_id), "chosen-2");
  alfred_focus_task_t swap = frame.tasks[0];
  frame.tasks[0] = frame.tasks[1];
  frame.tasks[1] = swap;
  ui_set_focus(&frame);
  advance(100);
  assert_focus("chosen-1");
  assert(nvs_commits == committed);
  choose_task("Choose task 1");
  assert(nvs_commits == committed);
  // A rendered row retains its task identity until the pending rebuild happens.
  show_page(PAGE_TODAY);
  advance(300);
  lv_obj_t *old_row = find_row("Choose task 0");
  swap = frame.tasks[1];
  frame.tasks[1] = frame.tasks[2];
  frame.tasks[2] = swap;
  ui_set_focus(&frame);
  s.gesture_moved = false;
  lv_obj_send_event(old_row, LV_EVENT_SHORT_CLICKED, NULL);
  advance(300);
  assert_focus("chosen-0");
  assert(!strcmp(saved_focus, "chosen-0"));
  choose_task("Choose task 2");
  assert_focus("chosen-2");
  assert(!strcmp(saved_focus, "chosen-2"));
  choose_task("Choose task 3");
  assert_focus("chosen-3");
  assert(active_task()->completed && saved_focus_done);
  // Return to a pending task for the original completion/selection regressions.
  choose_task("Choose task 2");
  assert(!saved_focus_done);
  static alfred_focus_snapshot_t offline;
  offline.configured = true;
  ui_set_connection(false);
  ui_set_focus(&offline);
  advance(100);
  assert(!strcmp(saved_focus, "chosen-2"));
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  assert_focus("chosen-2");
  // Selection is restored by ui_init before any task snapshot has arrived.
  restart_ui();
  assert(!strcmp(s.selected_id, "chosen-2"));
  ui_set_focus(&offline);
  advance(100);
  assert(!strcmp(saved_focus, "chosen-2"));
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  assert_focus("chosen-2");
  // A failed save, timeout, or dropped connection must preserve the choice.
  begin_complete();
  advance(100);
  assert(s.pending);
  alfred_error_t failure = {0};
  copy(failure.code, sizeof(failure.code), "task_failed");
  copy(failure.message, sizeof(failure.message), "Task save failed");
  copy(failure.request_id, sizeof(failure.request_id), s.request_id);
  ui_show_error(&failure);
  advance(100);
  assert(!s.pending && !strcmp(saved_focus, "chosen-2"));
  assert_focus("chosen-2");
  begin_complete();
  advance(ACK_TIMEOUT_MS + 100);
  assert(!s.pending && !strcmp(saved_focus, "chosen-2"));
  assert_focus("chosen-2");
  begin_complete();
  advance(100);
  ui_set_connection(false);
  advance(100);
  assert(!s.pending && !strcmp(saved_focus, "chosen-2"));
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(100);
  // Acknowledgement clears the saved pin and selects the next eligible task.
  begin_complete();
  advance(100);
  assert(s.pending);
  // A stale snapshot can arrive before the ACK; it must not resurrect the task.
  assert(!frame.tasks[1].completed);
  ui_set_focus(&frame);
  assert(s.has_deferred);
  acknowledge_current();
  assert(!s.pending && !saved_focus[0] && !s.has_deferred);
  assert(active_task() && strcmp(active_task()->id, "chosen-2"));
  // External authoritative completion and deletion clear the pin as well.
  ui_set_focus(&frame);
  advance(100);
  choose_task("Choose task 1");
  frame.tasks[0].completed = true;
  ui_set_focus(&frame);
  advance(100);
  assert(!saved_focus[0]);
  choose_task("Choose task 0");
  assert(!strcmp(saved_focus, "chosen-0"));
  frame.tasks[2] = frame.tasks[3];
  frame.count = 3;
  ui_set_focus(&frame);
  advance(100);
  assert(!saved_focus[0]);
  assert(active_task() && strcmp(active_task()->id, "chosen-0"));
  // Snapshot arriving during an optimistic completion is applied after ACK.
  frame.tasks[0].completed = false;
  ui_set_focus(&frame);
  advance(100);
  choose_task("Choose task 1");
  begin_complete();
  advance(100);
  frame.tasks[0].completed = true;
  ui_set_focus(&frame);
  advance(100);
  assert(s.has_deferred);
  acknowledge_current();
  assert(!saved_focus[0] && !s.has_deferred);
  assert(active_task() && strcmp(active_task()->id, "chosen-1"));
  // A failed local request still honors a deferred authoritative deletion.
  frame.tasks[0].completed = false;
  ui_set_focus(&frame);
  advance(100);
  choose_task("Choose task 1");
  begin_complete();
  advance(100);
  frame.tasks[0] = frame.tasks[1];
  frame.count = 1;
  ui_set_focus(&frame);
  copy(failure.request_id, sizeof(failure.request_id), s.request_id);
  ui_show_error(&failure);
  advance(100);
  assert(!saved_focus[0] && !s.has_deferred);
  restart_ui();
  assert(!s.selected_id[0]);
  puts("Manual focus survives snapshots, reorder, stale row clicks, offline "
       "updates and restart; changes or clears only after valid "
       "selection/completion/removal: PASS");
}

static void tap_flower(void) {
  pointer_x = 90;
  pointer_y = 200;
  pointer_down = true;
  advance(80);
  pointer_down = false;
  advance(80);
}

static void assert_checked(bool checked) {
  assert(s.hero);
  uintptr_t drawing = (uintptr_t)lv_obj_get_user_data(s.hero);
  assert(((drawing & 0x1000000) != 0) == checked);
  if (checked)
    assert((drawing & 0xffffff) == task_color(active_task()));
}

static void completed_inspection_checks(void) {
  static alfred_focus_snapshot_t frame;
  frame.online = true;
  frame.configured = true;
  frame.count = 2;
  frame.tasks[0].category = TASK_HEALTH;
  copy(frame.tasks[0].id, sizeof(frame.tasks[0].id), "undo-task");
  copy(frame.tasks[0].title, sizeof(frame.tasks[0].title), "Accidentally completed");
  frame.tasks[0].completed = true;
  copy(frame.tasks[1].id, sizeof(frame.tasks[1].id), "other-task");
  copy(frame.tasks[1].title, sizeof(frame.tasks[1].title), "Other pending task");
  copy(frame.focus_id, sizeof(frame.focus_id), "other-task");
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  choose_task("Accidentally completed");
  assert_focus("undo-task");
  assert(active_task()->completed && s.selected_completed && saved_focus_done);
  assert_checked(true);
  capture_screen("completed-inspection");
  unsigned committed = nvs_commits;
  ui_set_focus(&frame);
  advance(100);
  assert_focus("undo-task");
  assert_checked(true);
  assert(nvs_commits == committed);
  restart_ui();
  assert(s.selected_completed && !strcmp(s.selected_id, "undo-task"));
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  assert_focus("undo-task");
  assert_checked(true);

  unsigned requests = reopenings;
  unsigned completed_requests = completions;
  tap_flower();
  assert(s.pending && s.reopening && !s.completing);
  assert(reopenings == requests + 1 && completions == completed_requests);
  assert_checked(true); // No optimistic untick before confirmation.
  tap_flower();
  assert(reopenings == requests + 1);
  alfred_task_reopened_t ack = {0};
  copy(ack.id, sizeof(ack.id), s.pending_id);
  copy(ack.request_id, sizeof(ack.request_id), s.request_id);
  ui_task_completed(&ack); // A completion ACK cannot satisfy a reopen request.
  assert(s.pending && !s.acknowledged);
  alfred_task_reopened_t wrong = ack;
  copy(wrong.request_id, sizeof(wrong.request_id), "unrelated");
  ui_task_reopened(&wrong);
  assert(s.pending);
  wrong = ack;
  copy(wrong.id, sizeof(wrong.id), "other-task");
  ui_task_reopened(&wrong);
  assert(s.pending);

  alfred_error_t failure = {0};
  copy(failure.request_id, sizeof(failure.request_id), s.request_id);
  ui_show_error(&failure);
  advance(100);
  assert(!s.pending && s.selected_completed && saved_focus_done);
  assert_checked(true);
  tap_flower();
  advance(ACK_TIMEOUT_MS + 100);
  assert(!s.pending && s.selected_completed);
  assert_checked(true);
  tap_flower();
  ui_set_connection(false);
  advance(100);
  assert(!s.pending && s.selected_completed);
  assert_checked(true);
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(100);
  tap_flower();
  copy(ack.id, sizeof(ack.id), s.pending_id);
  copy(ack.request_id, sizeof(ack.request_id), s.request_id);
  // A stale checked snapshot already in flight cannot overrule a matching ACK.
  ui_set_focus(&frame);
  assert(s.has_deferred);
  ui_task_reopened(&ack);
  advance(100);
  assert(!s.pending && !s.has_deferred && !s.selected_completed);
  assert(!saved_focus_done && !strcmp(saved_focus, "undo-task"));
  assert_focus("undo-task");
  assert(!active_task()->completed);
  assert_checked(false);
  committed = nvs_commits;
  ui_task_reopened(&ack); // Duplicate/late acknowledgements are harmless.
  assert(nvs_commits == committed);
  frame.tasks[0].completed = false;
  ui_set_focus(&frame);
  advance(100);
  assert_focus("undo-task");
  // Once reopened, normal later completion releases the pending-task pin.
  frame.tasks[0].completed = true;
  ui_set_focus(&frame);
  advance(100);
  assert(!saved_focus[0] && !s.selected_completed);
  assert_focus("other-task");

  choose_task("Accidentally completed");
  frame.tasks[0].completed = false; // Reopened from another client.
  ui_set_focus(&frame);
  advance(100);
  assert_focus("undo-task");
  assert(!s.selected_completed && !saved_focus_done);
  assert_checked(false);
  frame.tasks[0].completed = true;
  ui_set_focus(&frame);
  advance(100);
  choose_task("Accidentally completed");
  frame.tasks[0] = frame.tasks[1]; // Removed from the authoritative task list.
  frame.count = 1;
  ui_set_focus(&frame);
  advance(100);
  assert(!saved_focus[0] && !s.selected_completed);
  assert_focus("other-task");
  puts("Completed inspection persists; verified reopen stays focused, errors "
       "stay checked, repeated taps and mismatched ACKs are ignored: PASS");
}

static void swipe(int x1, int y1, int x2, int y2) {
  pointer_x = x1;
  pointer_y = y1;
  pointer_down = true;
  advance(60);
  pointer_x = (x1 + x2) / 2;
  pointer_y = (y1 + y2) / 2;
  advance(40);
  pointer_x = x2;
  pointer_y = y2;
  advance(40);
  pointer_down = false;
  advance(340);
}

static void click_timer(unsigned index) {
  assert(s.dock_open && s.timer_buttons[index]);
  lv_area_t area;
  lv_obj_get_coords(s.timer_buttons[index], &area);
  pointer_x = (area.x1 + area.x2) / 2;
  pointer_y = (area.y1 + area.y2) / 2;
  pointer_down = true;
  advance(80);
  pointer_down = false;
  advance(80);
}

static void acknowledge_timer(void) {
  alfred_task_timer_updated_t ack = {0};
  copy(ack.id, sizeof(ack.id), s.pending_id);
  copy(ack.request_id, sizeof(ack.request_id), s.request_id);
  ack.action = s.timer_action;
  ui_task_timer_updated(&ack);
  advance(100);
}

static void timer_dock_checks(void) {
  static alfred_focus_snapshot_t frame;
  frame.online = true;
  frame.configured = true;
  frame.count = 2;
  for (unsigned i = 0; i < 2; ++i) {
    snprintf(frame.tasks[i].id, sizeof(frame.tasks[i].id), "timer-%u", i);
    copy(frame.tasks[i].title, sizeof(frame.tasks[i].title),
         i ? "Another pending task" : "Take a short walk");
    frame.tasks[i].category = TASK_HEALTH;
  }
  frame.tasks[0].has_spent_time = true;
  frame.tasks[0].spent_time_seconds = 40;
  copy(frame.focus_id, sizeof(frame.focus_id), "timer-0");
  ui_set_connection(true);
  ui_set_focus(&frame);
  advance(300);
  assert_focus("timer-0");
  assert(!s.elapsed); // Old saved time alone does not show an active timer.
  unsigned completed = completions;
  swipe(210, 200, 120, 200);
  assert(!s.dock_open && completions == completed);
  swipe(358, 200, 270, 200);
  assert(s.dock_open && s.timer_dock && s.page == PAGE_FOCUS);
  assert(lv_obj_get_width(s.timer_dock) == 64);
  assert(completions == completed);
  click_timer(1);
  click_timer(2);
  assert(!s.pending && !timer_requests[ALFRED_TIMER_PAUSE] &&
         !timer_requests[ALFRED_TIMER_STOP]);
  click_timer(0);
  assert(s.pending && s.timer_pending && timer_requests[ALFRED_TIMER_START] == 1);
  click_timer(0);
  assert(timer_requests[ALFRED_TIMER_START] == 1);
  alfred_task_timer_updated_t wrong = {0};
  copy(wrong.id, sizeof(wrong.id), s.pending_id);
  copy(wrong.request_id, sizeof(wrong.request_id), s.request_id);
  wrong.action = ALFRED_TIMER_PAUSE;
  ui_task_timer_updated(&wrong);
  assert(!s.acknowledged);
  ui_task_completed((const alfred_task_completed_t *)&wrong);
  assert(!s.acknowledged);
  // Neither ACK alone nor a pre-action snapshot fabricates a running clock.
  ui_set_focus(&frame);
  acknowledge_timer();
  assert(s.pending && s.timer_pending && !s.elapsed);
  frame.tasks[0].has_timer = true;
  frame.tasks[0].timer_started_at_ms = (int64_t)time(NULL) * 1000;
  frame.tasks[0].timer_elapsed_seconds = 0;
  ui_set_focus(&frame);
  advance(100);
  assert(!s.pending && s.dock_open && s.elapsed);
  assert_focus("timer-0");
  assert(!strcmp(saved_focus, "timer-0"));
  assert(!strcmp(lv_label_get_text(s.elapsed), "00:00"));
  advance(2100);
  // The display refreshes once a second, independently of the start instant.
  assert(!strcmp(lv_label_get_text(s.elapsed), "00:01") ||
         !strcmp(lv_label_get_text(s.elapsed), "00:02"));
  capture_screen("timer-running-dock");

  click_timer(1);
  assert(s.pending && timer_requests[ALFRED_TIMER_PAUSE] == 1);
  frame.tasks[0].timer_started_at_ms = 0;
  frame.tasks[0].timer_elapsed_seconds = 2;
  ui_set_focus(&frame); // Snapshot before ACK must also work.
  assert(s.pending);
  acknowledge_timer();
  assert(!s.pending && s.elapsed && has_label(s.body, "Paused"));
  advance(3200);
  assert(!strcmp(lv_label_get_text(s.elapsed), "00:02"));
  capture_screen("timer-paused-dock");
  click_timer(1); // Already paused: no redundant request.
  assert(timer_requests[ALFRED_TIMER_PAUSE] == 1);
  click_timer(0);
  acknowledge_timer();
  frame.tasks[0].timer_started_at_ms = (int64_t)time(NULL) * 1000;
  ui_set_focus(&frame);
  advance(2100);
  assert(!s.pending && has_label(s.body, "Focusing"));
  assert(!strcmp(lv_label_get_text(s.elapsed), "00:03") ||
         !strcmp(lv_label_get_text(s.elapsed), "00:04"));
  swipe(306, 200, 365, 200);
  assert(!s.dock_open && !s.timer_dock && completions == completed);
  swipe(358, 200, 270, 200);
  swipe(330, 250, 330, 150);
  assert(s.dock_open && s.page == PAGE_FOCUS); // No vertical page leak.
  tap_flower();
  assert(!s.dock_open && completions == completed); // Outside tap only closes.
  swipe(180, 270, 180, 150);
  assert(s.page == PAGE_TODAY);
  swipe(180, 35, 180, 115);
  assert(s.page == PAGE_FOCUS && completions == completed);
  swipe(358, 200, 270, 200);

  click_timer(1);
  acknowledge_timer();
  assert(s.pending && s.timer_pending);
  advance(ACK_TIMEOUT_MS + 100);
  assert(!s.pending && active_task()->timer_started_at_ms > 0);
  // A failed stop leaves the live timer and task untouched.
  click_timer(2);
  alfred_error_t failure = {0};
  copy(failure.request_id, sizeof(failure.request_id), s.request_id);
  ui_show_error(&failure);
  advance(100);
  assert(!s.pending && active_task()->has_timer && !active_task()->completed);
  click_timer(2);
  acknowledge_timer();
  frame.tasks[0].has_timer = false;
  frame.tasks[0].timer_started_at_ms = 0;
  frame.tasks[0].completed = true;
  frame.tasks[0].spent_time_seconds = 4;
  ui_set_focus(&frame);
  advance(100);
  assert(s.completing && !s.dock_open && !s.elapsed);
  assert_focus("timer-0");
  assert_checked(true);
  advance(COMPLETE_HOLD_MS + 100);
  assert(!s.pending && !s.completing && !saved_focus[0]);
  assert_focus("timer-1");
  choose_task("Take a short walk");
  swipe(358, 200, 270, 200);
  unsigned starts = timer_requests[ALFRED_TIMER_START];
  click_timer(0);
  assert(timer_requests[ALFRED_TIMER_START] == starts && !s.pending);
  assert_checked(true); // Completed tasks must be reopened first.

  alfred_focus_task_t clock_task = {0};
  clock_task.has_timer = true;
  clock_task.timer_elapsed_seconds = 3598;
  clock_task.timer_started_at_ms = 100000;
  assert(timer_seconds(&clock_task, 102999) == 3600);
  assert(timer_seconds(&clock_task, 99000) == 3598); // Clock not synchronized yet.
  assert(timer_seconds(&clock_task, 999999999) == 72000);
  clock_task.timer_started_at_ms = 0;
  assert(timer_seconds(&clock_task, 999999999) == 3598);
  // UI starts before SNTP has set wall time. Show only known saved intervals
  // until a real clock arrives, then advance from the server's start timestamp.
  frame.tasks[0].completed = false;
  frame.tasks[0].has_timer = true;
  frame.tasks[0].timer_elapsed_seconds = 42;
  frame.tasks[0].timer_started_at_ms = (int64_t)time(NULL) * 1000;
  time_t valid_epoch = fake_wall_epoch;
  fake_wall_epoch = 0;
  ui_set_focus(&frame);
  advance(1100);
  assert_focus("timer-0");
  assert(s.elapsed && !strcmp(lv_label_get_text(s.elapsed), "00:42"));
  assert(has_label(s.root, "--:--"));
  fake_wall_epoch = valid_epoch;
  advance(1100);
  assert(strcmp(lv_label_get_text(s.elapsed), "00:42"));
  puts("Timer dock isolates horizontal gestures; confirmed Start/Pause/Resume/Stop "
       "updates elapsed time, preserves focus, and completes only after Stop: PASS");
}

int main(void) {
  assert(ui_init() == ESP_OK);
  new_request_id();
  char first_request[ALFRED_REQUEST_ID_MAX];
  copy(first_request, sizeof(first_request), s.request_id);
  s.request_counter = 0;
  new_request_id();
  assert(strcmp(first_request, s.request_id)); // Same uptime/counter, fresh nonce.
  advance(100);
  ui_register_actions(action, NULL);
  ui_set_configured(true);
  selection_checks();
  completed_inspection_checks();
  timer_dock_checks();
  return 0;
}
