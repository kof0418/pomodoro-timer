export type Mode = "focus" | "short" | "long";
export interface Task {
  id: string;
  title: string;
  project: string;
  estimate: number;
  done: number;
  completed: boolean;
  priority: string;
  due: string;
  notes: string;
}
export interface Session {
  id: string;
  at: number;
  minutes: number;
  task: string;
  project: string;
}
export interface Settings {
  focus: number;
  short: number;
  long: number;
  interval: number;
  goal: number;
  autoBreak: boolean;
  autoFocus: boolean;
  sound: boolean;
  volume: number;
  theme: "dark" | "light" | "system";
  alarm: string;
}
export interface State {
  settings: Settings;
  tasks: Task[];
  sessions: Session[];
  templates: Task[];
  active: string;
  mode: Mode;
  remaining: number;
  duration: number;
  deadline: number | null;
  cycle: number;
  sessionTask: string;
  distractions: number;
}
export const defaults: Settings = {
  focus: 25,
  short: 5,
  long: 15,
  interval: 4,
  goal: 8,
  autoBreak: false,
  autoFocus: false,
  sound: true,
  volume: 0.5,
  theme: "dark",
  alarm: "bell",
};
export function fresh(): State {
  return {
    settings: { ...defaults },
    tasks: [],
    sessions: [],
    templates: [],
    active: "",
    mode: "focus",
    remaining: 1500,
    duration: 1500,
    deadline: null,
    cycle: 0,
    sessionTask: "",
    distractions: 0,
  };
}
export function secondsLeft(s: State, now = Date.now()) {
  return s.deadline === null
    ? s.remaining
    : Math.max(0, Math.ceil((s.deadline - now) / 1000));
}
export function setMode(s: State, mode: Mode) {
  s.mode = mode;
  s.remaining = s.settings[mode] * 60;
  s.duration = s.remaining;
  s.deadline = null;
  s.sessionTask = "";
}
export function finish(s: State, now = Date.now(), completed = true) {
  if (completed && s.mode === "focus") {
    const task = s.tasks.find((t) => t.id === s.sessionTask);
    s.sessions.push({
      id: crypto.randomUUID(),
      at: now,
      minutes: s.duration / 60,
      task: task?.title ?? "自由專注",
      project: task?.project ?? "個人",
    });
    if (task) task.done++;
    s.cycle++;
  }
  const next: Mode =
    s.mode === "focus"
      ? s.cycle > 0 && s.cycle % s.settings.interval === 0
        ? "long"
        : "short"
      : "focus";
  setMode(s, next);
  if (
    completed &&
    (next === "focus" ? s.settings.autoFocus : s.settings.autoBreak)
  ) {
    s.deadline = now + s.remaining * 1000;
    s.sessionTask = s.active;
  }
}
export function dayKey(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function validate(value: unknown): State {
  const s = value as State;
  if (!s || typeof s !== "object" || !s.settings) throw Error("無效的備份格式");
  for (const k of [
    "focus",
    "short",
    "long",
    "interval",
    "goal",
    "volume",
  ] as const) {
    const n = s.settings[k];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      n < (k === "volume" ? 0 : 1) ||
      n > (k === "volume" ? 1 : k === "interval" ? 12 : k === "goal" ? 50 : 180)
    )
      throw Error("設定超出範圍");
  }
  if (
    !["dark", "light", "system"].includes(s.settings.theme) ||
    !["bell", "soft"].includes(s.settings.alarm)
  )
    throw Error("無效設定");
  for (const k of ["autoBreak", "autoFocus", "sound"] as const)
    if (typeof s.settings[k] !== "boolean") throw Error("無效設定");
  for (const a of [s.tasks, s.templates])
    if (
      !Array.isArray(a) ||
      a.length > 10000 ||
      a.some(
        (t) =>
          !t ||
          ["id", "title", "project", "priority", "due", "notes"].some(
            (k) =>
              typeof (t as unknown as Record<string, unknown>)[k] !== "string",
          ) ||
          !Number.isInteger(t.estimate) ||
          t.estimate < 1 ||
          t.estimate > 99 ||
          !Number.isInteger(t.done) ||
          t.done < 0 ||
          typeof t.completed !== "boolean",
      )
    )
      throw Error("任務資料不正確");
  for (const a of [s.tasks, s.templates])
    if (
      a.some((t) => !/^[a-zA-Z0-9_-]+$/.test(t.id)) ||
      new Set(a.map((t) => t.id)).size !== a.length
    )
      throw Error("任務識別碼不正確");
  if (
    !Array.isArray(s.sessions) ||
    s.sessions.some(
      (x) =>
        !x ||
        typeof x.id !== "string" ||
        typeof x.task !== "string" ||
        typeof x.project !== "string" ||
        !Number.isFinite(x.at) ||
        Math.abs(x.at) > 8.64e15 ||
        !Number.isFinite(x.minutes) ||
        x.minutes <= 0,
    )
  )
    throw Error("紀錄資料不正確");
  if (
    !["focus", "short", "long"].includes(s.mode) ||
    !Number.isFinite(s.remaining) ||
    s.remaining < 0 ||
    !Number.isFinite(s.duration) ||
    s.duration <= 0 ||
    s.remaining > s.duration ||
    !(s.deadline === null || Number.isFinite(s.deadline)) ||
    !Number.isInteger(s.cycle) ||
    s.cycle < 0 ||
    typeof s.active !== "string" ||
    typeof s.sessionTask !== "string" ||
    !Number.isInteger(s.distractions) ||
    s.distractions < 0
  )
    throw Error("計時器資料不正確");
  return s;
}
