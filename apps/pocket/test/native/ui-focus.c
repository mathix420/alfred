#include "../../firmware/src/ui/ui.c"
#include <assert.h>
#include <stdio.h>
static void advance(unsigned ms) {
  for (unsigned t = 0; t < ms; t += 10) {
    fake_ms += 10;
    lv_timer_handler();
  }
  lv_obj_update_layout(s.root);
}
static unsigned completions;
static void action(ui_action_t type, const char *id, const char *request,
                   void *user) {
  (void)id;
  (void)request;
  (void)user;
  if (type == UI_COMPLETE)
    completions++;
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
  assert(s.page == PAGE_TODAY);
  show_page(PAGE_FOCUS);
  advance(300);
  assert_focus("chosen-2");
  assert(!strcmp(saved_focus, "chosen-2")); // Completed rows cannot pin a task.
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

int main(void) {
  assert(ui_init() == ESP_OK);
  advance(100);
  ui_register_actions(action, NULL);
  ui_set_configured(true);
  selection_checks();
  return 0;
}
