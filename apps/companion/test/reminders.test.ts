import { describe, expect, it } from "bun:test";
import { ReminderService } from "../src/reminders";

describe("ReminderService", () => {
  it("adds, orders by dueAt, and lists copies", () => {
    const s = new ReminderService();
    s.add("later", 200);
    s.add("sooner", 100);

    const list = s.list();
    expect(list.map((r) => r.text)).toEqual(["sooner", "later"]);

    const first = list[0];
    if (first) first.text = "mutated"; // mutating the copy must not affect the store
    expect(s.list().map((r) => r.text)[0]).toBe("sooner");
  });

  it("notifies onChange for add and remove", () => {
    const s = new ReminderService();
    let count = 0;
    s.onChange = () => {
      count++;
    };

    const r = s.add("x", 1);
    expect(count).toBe(1);
    expect(s.remove(r.id)).toBe(true);
    expect(count).toBe(2);
    expect(s.remove("nope")).toBe(false);
    expect(count).toBe(2);
  });

  it("next() prefers the soonest pending, else the soonest overall", () => {
    const s = new ReminderService();
    s.add("past", 100);
    s.add("future", 500);
    expect(s.next(300)?.text).toBe("future");
    expect(s.next(50)?.text).toBe("past");
    expect(s.next(1000)?.text).toBe("past");
  });
});
