/**
 * In-memory reminder list for one device session. The device's RTC fires
 * reminders locally (SCOPE §5, Tier 1); the bridge owns the canonical list and
 * syncs it down, so this only stores, orders, and notifies on change.
 *
 * TODO(tier-2): persist across reconnects — today the list is per-connection.
 */

import type { ReminderItem } from "./protocol";

export type Reminder = ReminderItem;

export class ReminderService {
  private readonly items: Reminder[] = [];
  /** Set by the owner to be notified after any mutation (to resync the device). */
  onChange: (() => void) | undefined;

  add(text: string, dueAt: number): Reminder {
    const reminder: Reminder = { id: crypto.randomUUID(), text, dueAt };
    this.items.push(reminder);
    this.items.sort((a, b) => a.dueAt - b.dueAt);
    this.onChange?.();
    return reminder;
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.onChange?.();
    return true;
  }

  list(): Reminder[] {
    return this.items.map((r) => ({ ...r }));
  }

  /** The soonest still-pending reminder, else the soonest overall, else none.
   * Returns a copy so callers cannot mutate the stored item. */
  next(nowMs: number): Reminder | undefined {
    const found = this.items.find((r) => r.dueAt >= nowMs) ?? this.items[0];
    return found ? { ...found } : undefined;
  }
}
