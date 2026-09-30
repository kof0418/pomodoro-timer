import { describe, it, expect } from "vitest";
import { fresh, finish, secondsLeft, validate } from "./model";
describe("timer", () => {
  it("uses wall clock across suspension", () => {
    const s = fresh();
    s.deadline = 10000;
    expect(secondsLeft(s, 7500)).toBe(3);
    expect(secondsLeft(s, 20000)).toBe(0);
  });
  it("long break after four completed sessions", () => {
    const s = fresh();
    s.cycle = 3;
    finish(s, 100);
    expect(s.mode).toBe("long");
    expect(s.sessions).toHaveLength(1);
  });
  it("skip never earns a session", () => {
    const s = fresh();
    finish(s, 100, false);
    expect(s.sessions).toHaveLength(0);
    expect(s.cycle).toBe(0);
  });
  it("credits the task that began the session", () => {
    const s = fresh();
    s.tasks = [
      {
        id: "a",
        title: "A",
        project: "P",
        estimate: 1,
        done: 0,
        completed: false,
        priority: "一般",
        due: "",
        notes: "",
      },
    ];
    s.sessionTask = "a";
    s.active = "b";
    finish(s);
    expect(s.tasks[0].done).toBe(1);
  });
  it("auto starts from current time without inventing overnight sessions", () => {
    const s = fresh();
    s.settings.autoBreak = true;
    finish(s, 9000000);
    expect(s.deadline).toBe(9300000);
    expect(s.sessions).toHaveLength(1);
  });
  it("validates backup", () => {
    expect(validate(fresh())).toBeTruthy();
    const s = fresh();
    s.settings.focus = -1;
    expect(() => validate(s)).toThrow();
  });
});
