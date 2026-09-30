import "./style.css";
import { createIcons, icons } from "lucide";
import {
  fresh,
  finish,
  setMode,
  secondsLeft,
  dayKey,
  validate,
  type State,
  type Mode,
  type Task,
} from "./model";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { save as saveFile, open as openFile } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

const KEY = "still-v1";
let state: State = fresh();
let loadError = false;
try {
  const saved = localStorage.getItem(KEY);
  if (saved) state = validate(JSON.parse(saved));
} catch {
  loadError = true;
  try {
    const original = localStorage.getItem(KEY);
    if (original) localStorage.setItem(KEY + "-recovery", original);
  } catch {
    /* Keep the original key if storage is unavailable. */
  }
}
let page = "timer",
  filter = "all",
  query = "",
  mini = false,
  pinned = false;
let ambient: AudioBufferSourceNode | null = null;
let audio: AudioContext | undefined;
let resizing = false;
let expandedSize = new LogicalSize(1200, 850);
let expandedMaximized = false;
const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const labels: Record<Mode, string> = {
  focus: "專注",
  short: "短休息",
  long: "長休息",
};
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const today = () =>
  state.sessions.filter((s) => dayKey(s.at) === dayKey(Date.now()));
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    toast("儲存失敗，請匯出備份以保留資料");
  }
}
function toast(message: string) {
  document.querySelector(".toast")?.remove();
  const e = document.createElement("div");
  e.className = "toast";
  e.role = "status";
  e.textContent = message;
  document.body.append(e);
  setTimeout(() => e.remove(), 4500);
}
function theme() {
  document.documentElement.dataset.theme =
    state.settings.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.settings.theme;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
function render() {
  // Finishing a timer must never destroy an in-progress task draft.
  if (document.querySelector("dialog[open]")) return;
  theme();
  if (mini) {
    const task = state.tasks.find(
      (t) => t.id === (state.sessionTask || state.active),
    );
    app.innerHTML = `<section class="mini-widget" aria-label="番茄鐘小浮窗">
      <div class="mini-top"><div id="mini-drag" class="mini-drag" title="拖曳移動浮窗">${icon("grip-vertical")}<span>${labels[state.mode]} · 第 ${(state.cycle % state.settings.interval) + 1} 回合</span></div>
      <button id="pin" class="icon-btn ${pinned ? "accent" : ""}" aria-label="視窗置頂" aria-pressed="${pinned}" title="${pinned ? "取消置頂" : "視窗置頂"}">${icon("pin")}</button>
      <button id="expand" class="icon-btn" aria-label="展開完整視窗" title="展開完整視窗 (Esc)">${icon("maximize-2")}</button></div>
      <div class="mini-center"><div id="countdown" class="mini-countdown" role="timer">${time(secondsLeft(state))}</div>
      <button id="toggle" class="mini-toggle" aria-label="${state.deadline ? "暫停計時" : "開始或繼續計時"}" title="${state.deadline ? "暫停" : "開始 / 繼續"} (Space)">${icon(state.deadline ? "pause" : "play")}</button></div>
      <div class="mini-bottom"><span class="mini-task" title="${esc(task?.title ?? "自由專注")}">${esc(task?.title ?? "自由專注")}</span><span>${state.deadline ? "計時中" : "已暫停"}</span></div>
      <div class="mini-progress" aria-hidden="true"><b></b></div>
    </section>`;
    createIcons({ icons });
    bind();
    tickDisplay();
    return;
  }
  const done = today().length;
  const minutes = today().reduce((n, s) => n + s.minutes, 0);
  const active = state.tasks.find((t) => t.id === state.active);
  app.innerHTML = `
 <aside class="sidebar"><a class="brand" href="#" aria-label="Still 首頁"><span class="brand-icon">${icon("sprout")}</span>still<span class="brand-dot">.</span></a><div class="workspace-label">你的專注空間</div>
 <nav>${[
   ["timer", "timer", "專注計時"],
   ["tasks", "list-todo", "任務清單"],
   ["stats", "chart-no-axes-combined", "專注洞察"],
 ]
   .map(
     ([id, ic, label]) =>
       `<button data-page="${id}" class="nav-item ${page === id ? "selected" : ""}">${icon(ic)}${label}${id === "tasks" ? `<span class="badge">${state.tasks.filter((t) => !t.completed).length}</span>` : ""}</button>`,
   )
   .join("")}</nav>
 <div class="sidebar-bottom"><div class="goal-card"><div>${icon("flame")}每日目標<span>${done} / ${state.settings.goal}</span></div><div class="track"><b style="width:${Math.min(100, (done / state.settings.goal) * 100)}%"></b></div><p>${done >= state.settings.goal ? "今天的目標達成了，做得很好。" : "一點一滴，累積你想要的生活。"}</p></div><button data-page="settings" class="nav-item ${page === "settings" ? "selected" : ""}">${icon("settings-2")}偏好設定</button><div class="local-status"><span></span>本機儲存 · 安心專注</div></div></aside>
 <main><header><div class="breadcrumb">我的空間 <span>/</span> ${{ timer: "專注計時", tasks: "任務清單", stats: "專注洞察", settings: "偏好設定" }[page]}</div><div class="header-actions"><span class="date">${new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric", weekday: "short" }).format(Date.now())}</span><button class="icon-btn" id="theme" title="切換深色／淺色模式" aria-label="切換深色／淺色模式">${icon("sun-moon")}</button><button class="icon-btn ${pinned ? "accent" : ""}" id="pin" title="視窗置頂" aria-label="視窗置頂">${icon("pin")}</button></div></header>
 <div class="content ${mini ? "minimal" : ""}">${
   page === "timer"
     ? `
 <section class="page-heading"><div><div class="eyebrow">MAKE ROOM FOR WHAT MATTERS</div><h1>把時間，留給重要的事。</h1><p>不急著完成所有事。先專注眼前這一件。</p></div><button class="quiet-btn" id="mini">${icon("minimize-2")}精簡模式</button></section>
 <div class="dashboard"><section class="timer-card"><div class="timer-top"><span class="live-label"><b></b> ${state.deadline ? "正在專注當下" : "準備好，進入心流"}</span><button class="icon-btn" id="expand" aria-label="切換精簡模式" title="切換精簡模式">${icon("maximize-2")}</button></div>
 <div class="mode-tabs" role="group" aria-label="計時模式">${(Object.keys(labels) as Mode[]).map((m) => `<button data-mode="${m}" class="${state.mode === m ? "active" : ""}">${labels[m]}</button>`).join("")}</div>
 <div class="timer-ring" style="--progress:${(secondsLeft(state) / state.duration) * 100}%"><div class="ring-inner"><span class="session-label">${state.mode === "focus" ? "TIME TO FOCUS" : "TAKE A BREATH"}</span><div class="countdown" id="countdown" role="timer">${time(secondsLeft(state))}</div><span class="end-time" id="end-time"></span></div></div>
 <div class="timer-controls"><button class="icon-btn" id="reset" title="重設 (R)" aria-label="重設計時器">${icon("rotate-ccw")}</button><button class="start-btn" id="toggle">${icon(state.deadline ? "pause" : "play")}<span>${state.deadline ? "暫停專注" : secondsLeft(state) < state.duration ? "繼續計時" : "開始" + labels[state.mode]}</span></button><button class="icon-btn" id="skip" title="跳過此階段" aria-label="跳過此階段">${icon("skip-forward")}</button></div>
 <div class="cycles">${Array.from({ length: state.settings.interval }, (_, i) => `<span class="${i < state.cycle % state.settings.interval ? "filled" : ""}"></span>`).join("")}<small>第 ${(state.cycle % state.settings.interval) + 1} / ${state.settings.interval} 回合</small></div>
 <div class="current-task">${icon("crosshair")}<div><small>當前專注任務</small><strong>${esc(active?.title ?? "自由專注，讓想法慢慢成形")}</strong></div>${active ? `<span>${active.done}/${active.estimate}</span>` : ""}</div>
 <div class="timer-footer"><button id="ambient" class="text-btn">${icon("audio-lines")}${ambient ? "關閉白噪音" : "白噪音"}</button><button id="distraction" class="text-btn" title="記下分心次數，再回到當下">${icon("wind")}記錄分心 ${state.distractions || ""}</button><span>空白鍵 開始 / 暫停</span></div></section>
 <aside class="right-column"><div class="summary-card"><div class="section-kicker">TODAY'S FOCUS ${icon("sparkles")}</div><h2>今天的每一點努力</h2><div class="today-metrics"><div><strong>${done}<small>個</small></strong><span>完成番茄鐘</span></div><div><strong>${minutes}<small>分鐘</small></strong><span>累積專注</span></div></div><div class="daily-target"><span>每日目標</span><strong>${Math.round((done / state.settings.goal) * 100)}%</strong></div><div class="track"><b style="width:${Math.min(100, (done / state.settings.goal) * 100)}%"></b></div><p>再一個小步，就離目標更近一點。</p></div>
 <section class="tasks-card"><div class="section-title"><h2>接下來的任務 <span>${state.tasks.filter((t) => !t.completed).length}</span></h2><button data-page="tasks" class="text-btn" title="所有任務">${icon("arrow-up-right")}</button></div>${taskRows(state.tasks.filter((t) => !t.completed).slice(0, 3))}<button id="add-task" class="add-task">${icon("plus")}新增任務</button><div class="task-estimate">${icon("clock-3")}剩餘預估 ${state.tasks.filter((t) => !t.completed).reduce((a, t) => a + Math.max(0, t.estimate - t.done) * state.settings.focus, 0)} 分鐘（不含休息）</div></section>
 <div class="quote-card"><span>“</span><p>專注不是把世界關在門外，<br>是把自己帶回當下。</p><small>ONE THING AT A TIME.</small><div class="leaf-art">${icon("sprout")}</div></div></aside></div>
 <footer>${icon("leaf")} 給自己一段不被打擾的時間。<span>STILL · FIND YOUR FLOW</span></footer>
 `
     : page === "tasks"
       ? tasksPage()
       : page === "stats"
         ? statsPage()
         : settingsPage()
 }</div></main><dialog id="task-dialog"></dialog>`;
  createIcons({ icons });
  bind();
  tickDisplay();
}
function taskRows(tasks: Task[]) {
  return tasks.length
    ? tasks
        .map(
          (t) =>
            `<div class="task-row ${t.id === state.active ? "is-active" : ""} ${t.completed ? "completed" : ""}"><button class="check-btn" data-complete="${t.id}" title="${t.completed ? "還原任務" : "完成任務"}" aria-label="${t.completed ? "還原" : "完成"} ${esc(t.title)}">${t.completed ? icon("check") : ""}</button><button class="task-text" data-select="${t.id}"><strong>${esc(t.title)}</strong><span><b>${esc(t.project || "個人")}</b> · ${t.done}/${t.estimate} 番茄${t.due ? ` · ${esc(t.due)}` : ""}${t.priority === "高" ? " · 高優先" : ""}</span></button><button class="icon-btn" data-edit="${t.id}" aria-label="編輯 ${esc(t.title)}">${icon("ellipsis")}</button></div>`,
        )
        .join("")
    : `<div class="empty-state">${icon("notebook-pen")}<p>為今天留下一個小目標</p><small>新增任務，或直接開始自由專注。</small></div>`;
}
function tasksPage() {
  const list = state.tasks.filter(
    (t) =>
      (filter === "all" || (filter === "done" ? t.completed : !t.completed)) &&
      `${t.title} ${t.project}`.toLowerCase().includes(query.toLowerCase()),
  );
  return `<section class="page-heading"><div><div class="eyebrow">A LITTLE CLARITY GOES A LONG WAY</div><h1>讓想做的事，有個位置。</h1><p>拆成小步驟，一顆番茄一顆番茄地完成。</p></div><button class="primary" id="add-task">${icon("plus")}新增任務</button></section><div class="toolbar"><div class="mode-tabs">${[
    ["all", "全部"],
    ["open", "進行中"],
    ["done", "已完成"],
  ]
    .map(
      ([v, l]) =>
        `<button data-filter="${v}" class="${filter === v ? "active" : ""}">${l}</button>`,
    )
    .join(
      "",
    )}</div><input id="search" placeholder="搜尋任務或專案…" aria-label="搜尋任務或專案" value="${esc(query)}"/></div><section class="panel">${taskRows(list)}</section><section class="panel templates"><h2>任務範本</h2><p>在編輯任務中儲存範本，重複的工作一鍵加入。</p>${state.templates.map((t) => `<div class="template"><button data-template="${t.id}" class="quiet-btn">${icon("plus")}${esc(t.title)}</button><button data-delete-template="${t.id}" class="icon-btn" aria-label="刪除範本 ${esc(t.title)}">${icon("trash-2")}</button></div>`).join("")}</section>`;
}
let statsRange = 7;
function statsPage() {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - statsRange + 1);
  const sessions = state.sessions.filter((s) => s.at >= cutoff.getTime());
  const total = sessions.reduce((a, s) => a + s.minutes, 0);
  const projects = new Map<string, number>();
  sessions.forEach((s) =>
    projects.set(s.project, (projects.get(s.project) ?? 0) + s.minutes),
  );
  const days = Array.from({ length: Math.min(statsRange, 31) }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (Math.min(statsRange, 31) - 1 - i));
    return {
      d,
      key: dayKey(d.getTime()),
      n: state.sessions
        .filter((s) => dayKey(s.at) === dayKey(d.getTime()))
        .reduce((a, s) => a + s.minutes, 0),
    };
  });
  const max = Math.max(25, ...days.map((d) => d.n));
  return `<section class="page-heading"><div><div class="eyebrow">SMALL STEPS. REAL PROGRESS.</div><h1>每一次專注，都算數。</h1><p>看見自己的節奏，找到適合你的步調。</p></div><button id="csv" class="quiet-btn">${icon("download")}匯出 CSV</button></section><div class="toolbar"><select id="range" aria-label="統計期間">${[
    [1, "今天"],
    [7, "最近 7 天"],
    [30, "最近 30 天"],
    [365, "最近一年"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${statsRange === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="stat-grid"><section class="panel"><small>累積專注</small><h1>${total}<small> 分鐘</small></h1></section><section class="panel"><small>完成番茄鐘</small><h1>${sessions.length}<small> 個</small></h1></section><section class="panel"><small>有專注的日子</small><h1>${new Set(sessions.map((s) => dayKey(s.at))).size}<small> 天</small></h1></section></div><section class="panel"><h2>專注節奏 <small>${statsRange > 31 ? "最近 31 天" : ""}</small></h2><div class="chart">${days.map((d) => `<div class="bar-column" title="${d.key}：${d.n} 分鐘"><small>${d.n || ""}</small><div class="bar" style="height:${Math.max(2, (d.n / max) * 140)}px"></div><span>${d.d.getDate()}</span></div>`).join("")}</div></section><section class="panel"><h2>專案時間分配</h2>${projects.size ? [...projects].map(([p, n]) => `<div class="project-stat"><span>${esc(p)}</span><div class="track"><b style="width:${(n / total) * 100}%"></b></div><strong>${n} 分鐘</strong></div>`).join("") : '<p class="muted">完成第一個番茄鐘後，這裡就會留下你的足跡。</p>'}</section><section class="panel"><h2>專注紀錄</h2>${
    sessions
      .slice()
      .reverse()
      .slice(0, 100)
      .map(
        (s) =>
          `<div class="history-row"><span>${esc(s.task)}<small>${esc(s.project)}</small></span><span>${new Date(s.at).toLocaleString("zh-TW")}</span><strong>${s.minutes} 分鐘</strong></div>`,
      )
      .join("") || '<p class="muted">尚無完成紀錄</p>'
  }</section>`;
}
function settingsPage() {
  const s = state.settings;
  return `<section class="page-heading"><div><div class="eyebrow">YOUR FOCUS, YOUR WAY</div><h1>找到你的專注節奏。</h1><p>設定自動儲存；時間調整會從下一個階段生效。</p></div></section><div class="settings-grid"><section class="panel"><h2>計時與循環</h2>${[
    ["focus", "專注時間（分鐘）", 180],
    ["short", "短休息（分鐘）", 180],
    ["long", "長休息（分鐘）", 180],
    ["interval", "長休息間隔（回合）", 12],
    ["goal", "每日目標（番茄）", 50],
  ]
    .map(
      ([k, l, max]) =>
        `<label class="setting-row">${l}<input data-setting="${k}" type="number" min="1" max="${max}" value="${s[k as "focus"]}"/></label>`,
    )
    .join("")}${[
    ["autoBreak", "自動開始休息"],
    ["autoFocus", "自動開始下一次專注"],
    ["sound", "完成時播放提示音"],
  ]
    .map(
      ([k, l]) =>
        `<label class="setting-row">${l}<input data-setting="${k}" type="checkbox" ${s[k as "sound"] ? "checked" : ""}/></label>`,
    )
    .join(
      "",
    )}</section><section class="panel"><h2>外觀與聲音</h2><label class="setting-row">顯示模式<select data-setting="theme">${[
    ["dark", "深色"],
    ["light", "淺色"],
    ["system", "跟隨系統"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${s.theme === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></label><label class="setting-row">提示音<select data-setting="alarm"><option value="bell" ${s.alarm === "bell" ? "selected" : ""}>清亮鐘聲</option><option value="soft" ${s.alarm === "soft" ? "selected" : ""}>柔和提醒</option></select></label><label class="setting-row">音量<input data-setting="volume" type="range" min="0" max="1" step="0.1" value="${s.volume}"/></label><button id="test-sound" class="quiet-btn">${icon("volume-2")}試聽提示音</button><button id="notifications" class="quiet-btn">${icon("bell")}啟用系統通知</button><p class="muted">休息時提醒起身、喝水，讓眼睛放鬆。通知需系統授權。</p><h2>快捷鍵</h2><div class="setting-row">開始 / 暫停 <kbd>Space</kbd></div><div class="setting-row">重設計時器 <kbd>R</kbd></div><div class="setting-row">離開精簡模式 <kbd>Esc</kbd></div></section><section class="panel"><h2>資料與備份</h2><p class="muted">任務、設定與紀錄儲存在這台裝置，不需要登入。</p><div class="button-row"><button id="export" class="quiet-btn">${icon("download")}匯出 JSON</button><button id="import" class="quiet-btn">${icon("upload")}還原備份</button><button id="csv" class="quiet-btn">匯出紀錄 CSV</button></div><input type="file" id="backup-file" accept="application/json,.json" hidden/></section></div>`;
}
function bind() {
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page!;
        render();
      }),
  );
  document.querySelector(".brand")?.addEventListener("click", (e) => {
    e.preventDefault();
    page = "timer";
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        if (
          state.deadline &&
          !confirm("切換模式會放棄這次尚未完成的計時，確定切換？")
        )
          return;
        setMode(state, b.dataset.mode as Mode);
        save();
        render();
      }),
  );
  on("toggle", toggle);
  on("reset", reset);
  on("skip", () => {
    if (confirm("跳過此階段？未完成的專注不會計入紀錄。")) {
      finish(state, Date.now(), false);
      save();
      render();
    }
  });
  on("theme", () => {
    state.settings.theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    save();
    render();
  });
  on("pin", async () => {
    if (!isTauri()) {
      toast("視窗置頂可在桌面版使用");
      return;
    }
    try {
      await getCurrentWindow().setAlwaysOnTop(!pinned);
      pinned = !pinned;
      render();
    } catch {
      toast("無法設定視窗置頂");
    }
  });
  on("mini", toggleMini);
  on("expand", toggleMini);
  document
    .getElementById("mini-drag")
    ?.addEventListener("pointerdown", async (e) => {
      if (e.button !== 0 || !isTauri() || resizing) return;
      try {
        await getCurrentWindow().startDragging();
      } catch {
        toast("無法拖曳視窗，請重試");
      }
    });
  on("ambient", toggleAmbient);
  on("distraction", () => {
    state.distractions++;
    save();
    toast("已記下，深呼吸，回到當下。");
    render();
  });
  on("add-task", () => taskDialog());
  document.querySelectorAll<HTMLButtonElement>("[data-select]").forEach(
    (b) =>
      (b.onclick = () => {
        state.active = b.dataset.select!;
        save();
        render();
        if (state.deadline) toast("已選取；目前回合仍計入開始時的任務。");
      }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-complete]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = state.tasks.find((t) => t.id === b.dataset.complete)!;
        t.completed = !t.completed;
        if (t.completed && state.active === t.id) state.active = "";
        save();
        render();
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          taskDialog(state.tasks.find((t) => t.id === b.dataset.edit))),
    );
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter!;
        render();
      }),
  );
  const search = document.querySelector<HTMLInputElement>("#search");
  if (search)
    search.oninput = () => {
      const pos = search.selectionStart;
      query = search.value;
      render();
      const n = document.querySelector<HTMLInputElement>("#search")!;
      n.focus();
      n.setSelectionRange(pos, pos);
    };
  document.querySelectorAll<HTMLButtonElement>("[data-template]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = state.templates.find((t) => t.id === b.dataset.template)!;
        state.tasks.push({
          ...t,
          id: crypto.randomUUID(),
          done: 0,
          completed: false,
          due: "",
        });
        save();
        render();
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-delete-template]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          state.templates = state.templates.filter(
            (t) => t.id !== b.dataset.deleteTemplate,
          );
          save();
          render();
        }),
    );
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]")
    .forEach(
      (el) =>
        (el.onchange = () => {
          const k = el.dataset.setting as keyof State["settings"];
          let v: unknown = el.value;
          if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox") v = el.checked;
            else {
              if (!el.checkValidity() || el.value === "") {
                el.reportValidity();
                return;
              }
              v = Number(el.value);
              if (k !== "volume" && !Number.isInteger(v)) {
                toast("請輸入整數");
                return;
              }
            }
          }
          Object.assign(state.settings, { [k]: v });
          save();
          theme();
        }),
    );
  on("test-sound", () => bell());
  on("notifications", async () => {
    try {
      const permission = isTauri()
        ? await requestPermission()
        : "Notification" in window
          ? await Notification.requestPermission()
          : "denied";
      toast(
        permission === "granted"
          ? "系統通知已啟用"
          : "通知未獲授權，可至系統設定開啟",
      );
    } catch {
      toast("無法啟用通知");
    }
  });
  on("export", () =>
    download(
      "still-backup.json",
      JSON.stringify(state, null, 2),
      "application/json",
    ),
  );
  on("csv", exportCSV);
  on("import", async () => {
    if (!isTauri()) {
      document.querySelector<HTMLInputElement>("#backup-file")?.click();
      return;
    }
    try {
      const path = await openFile({
        multiple: false,
        filters: [{ name: "Still 備份", extensions: ["json"] }],
      });
      if (typeof path === "string") restore(await readTextFile(path));
    } catch {
      toast("無法讀取備份");
    }
  });
  const file = document.querySelector<HTMLInputElement>("#backup-file");
  if (file)
    file.onchange = async () => {
      try {
        const f = file.files?.[0];
        if (!f) return;
        if (f.size > 10_000_000) throw Error("備份檔案過大");
        const imported = validate(JSON.parse(await f.text()));
        if (!confirm("以備份取代目前資料？建議先匯出目前資料。")) return;
        imported.remaining = secondsLeft(imported);
        imported.deadline = null;
        state = imported;
        save();
        render();
        toast("備份已還原，計時器已暫停");
      } catch (e) {
        toast(e instanceof Error ? e.message : "無法讀取備份");
      }
    };
  const range = document.querySelector<HTMLSelectElement>("#range");
  if (range)
    range.onchange = () => {
      statsRange = Number(range.value);
      render();
    };
}
function on(id: string, fn: () => unknown) {
  document.getElementById(id)?.addEventListener("click", fn);
}
function taskDialog(task?: Task) {
  const dialog = document.querySelector<HTMLDialogElement>("#task-dialog")!;
  dialog.innerHTML = `<form id="task-form"><div class="section-title"><h2>${task ? "編輯任務" : "一個新的小目標"}</h2><button type="button" id="close-dialog" class="icon-btn" aria-label="關閉">${icon("x")}</button></div><label>任務名稱<input name="title" maxlength="160" required value="${esc(task?.title ?? "")}" placeholder="想把專注留給什麼？"/></label><div class="form-grid"><label>專案<input name="project" maxlength="60" value="${esc(task?.project ?? "個人")}"/></label><label>預估番茄數<input name="estimate" type="number" min="1" max="99" required value="${task?.estimate ?? 1}"/></label><label>優先順序<select name="priority">${["一般", "高", "低"].map((p) => `<option ${task?.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></label><label>到期日期<input name="due" type="date" value="${esc(task?.due ?? "")}"/></label></div><label>備註 / 子步驟<textarea name="notes" maxlength="4000" rows="3" placeholder="把大任務拆成小步驟…">${esc(task?.notes ?? "")}</textarea></label><div class="button-row">${task ? '<button type="button" id="delete-task" class="danger">刪除</button><button type="button" id="save-template" class="quiet-btn">儲存為範本</button>' : ""}<button type="submit" class="primary">${task ? "儲存變更" : "新增任務"}</button></div></form>`;
  createIcons({ icons });
  dialog.showModal();
  dialog.addEventListener("close", () => render(), { once: true });
  on("close-dialog", () => dialog.close());
  const form = document.querySelector<HTMLFormElement>("#task-form")!;
  const read = (): Task => {
    const d = new FormData(form);
    return {
      id: task?.id ?? crypto.randomUUID(),
      title: String(d.get("title")).trim(),
      project: String(d.get("project")).trim() || "個人",
      estimate: Number(d.get("estimate")),
      priority: String(d.get("priority")),
      due: String(d.get("due")),
      notes: String(d.get("notes")),
      done: task?.done ?? 0,
      completed: task?.completed ?? false,
    };
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const t = read();
    if (!t.title) return;
    task ? Object.assign(task, t) : state.tasks.push(t);
    if (!state.active && !t.completed) state.active = t.id;
    save();
    dialog.close();
    render();
  };
  on("delete-task", () => {
    if (confirm("刪除這項任務？已完成的專注紀錄會保留。")) {
      state.tasks = state.tasks.filter((t) => t.id !== task!.id);
      if (state.active === task!.id) state.active = "";
      save();
      dialog.close();
      render();
    }
  });
  on("save-template", () => {
    if (!form.reportValidity()) return;
    const t = read();
    if (!t.title) return;
    state.templates.push({ ...t, id: crypto.randomUUID() });
    save();
    toast("已儲存為範本");
  });
}
function toggle() {
  audio ??= new AudioContext();
  void audio.resume();
  if (state.deadline) {
    state.remaining = secondsLeft(state);
    state.deadline = null;
  } else {
    if (state.remaining <= 0) setMode(state, state.mode);
    if (state.remaining === state.duration) state.sessionTask = state.active;
    state.deadline = Date.now() + state.remaining * 1000;
  }
  save();
  render();
}
function reset() {
  if (
    secondsLeft(state) < state.duration &&
    !confirm("重設這次計時？尚未完成的時間不會計入紀錄。")
  )
    return;
  setMode(state, state.mode);
  save();
  render();
}
async function toggleMini() {
  if (resizing) return;
  resizing = true;
  const next = !mini;
  try {
    if (isTauri()) {
      const win = getCurrentWindow();
      if (next) {
        expandedMaximized = await win.isMaximized();
        if (expandedMaximized) await win.unmaximize();
        expandedSize = (await win.innerSize()).toLogical(
          await win.scaleFactor(),
        );
      }
      // Lower the full window's minimum before requesting the small size.
      await win.setMinSize(new LogicalSize(280, 160));
      await win.setResizable(true);
      await win.setDecorations(!next);
      await win.setSize(next ? new LogicalSize(280, 160) : expandedSize);
      await win.setResizable(!next);
      if (!next) {
        await win.setMinSize(new LogicalSize(500, 700));
        if (expandedMaximized) await win.maximize();
      }
    }
    mini = next;
    document.body.classList.toggle("mini", mini);
    render();
  } catch {
    // Return to a usable decorated window if any platform operation fails.
    if (isTauri()) {
      const win = getCurrentWindow();
      try {
        await win.setResizable(true);
        await win.setDecorations(true);
        await win.setSize(expandedSize);
        await win.setMinSize(new LogicalSize(500, 700));
        mini = false;
        document.body.classList.remove("mini");
        render();
      } catch {
        /* Surface the failure below; retain the expand control. */
      }
    }
    toast("無法切換視窗大小，請重試");
  } finally {
    resizing = false;
  }
}
function tickDisplay() {
  const left = secondsLeft(state);
  const el = document.getElementById("countdown");
  if (el) el.textContent = time(left);
  const progress = document.querySelector<HTMLElement>(".mini-progress b");
  if (progress)
    progress.style.width = `${Math.min(100, (left / state.duration) * 100)}%`;
  document
    .querySelector<HTMLElement>(".timer-ring")
    ?.style.setProperty(
      "--progress",
      `${Math.min(100, (left / state.duration) * 100)}%`,
    );
  const end = document.getElementById("end-time");
  if (end)
    end.textContent = state.deadline
      ? `預計 ${new Date(state.deadline).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })} 結束`
      : "讓注意力，回到這裡";
  document.title = `${time(left)} · ${labels[state.mode]} · Still`;
}
async function notify(message: string) {
  try {
    if (isTauri()) {
      if (await isPermissionGranted())
        sendNotification({ title: "Still · 專注當下", body: message });
    } else if (
      "Notification" in window &&
      Notification.permission === "granted"
    )
      new Notification("Still · 專注當下", { body: message });
  } catch {
    toast("系統通知傳送失敗");
  }
}
function bell() {
  audio ??= new AudioContext();
  void audio.resume();
  const now = audio.currentTime;
  [0, 0.3, 0.6].forEach((delay, i) => {
    const o = audio!.createOscillator(),
      g = audio!.createGain();
    o.frequency.value =
      (state.settings.alarm === "soft" ? 440 : 660) * (i === 1 ? 1.25 : 1);
    g.gain.setValueAtTime(0, now + delay);
    g.gain.linearRampToValueAtTime(
      state.settings.volume * 0.2,
      now + delay + 0.02,
    );
    g.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.6);
    o.connect(g);
    g.connect(audio!.destination);
    o.start(now + delay);
    o.stop(now + delay + 0.7);
  });
}
function toggleAmbient() {
  if (ambient) {
    ambient.stop();
    ambient = null;
  } else {
    audio ??= new AudioContext();
    void audio.resume();
    const buffer = audio.createBuffer(
      1,
      audio.sampleRate * 3,
      audio.sampleRate,
    );
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 1.5 * state.settings.volume;
    }
    ambient = audio.createBufferSource();
    ambient.buffer = buffer;
    ambient.loop = true;
    ambient.connect(audio.destination);
    ambient.start();
  }
  render();
}
function restore(text: string) {
  try {
    if (text.length > 10_000_000) throw Error("備份檔案過大");
    const imported = validate(JSON.parse(text));
    if (!confirm("以備份取代目前資料？建議先匯出目前資料。")) return;
    imported.remaining = secondsLeft(imported);
    imported.deadline = null;
    state = imported;
    save();
    render();
    toast("備份已還原，計時器已暫停");
  } catch (e) {
    toast(e instanceof Error ? e.message : "無法讀取備份");
  }
}
async function download(name: string, data: string, type: string) {
  if (isTauri()) {
    try {
      const path = await saveFile({
        defaultPath: name,
        filters: [
          {
            name: "Still 資料",
            extensions: [name.endsWith(".json") ? "json" : "csv"],
          },
        ],
      });
      if (path) {
        await writeTextFile(path, data);
        toast("已匯出資料");
      }
    } catch {
      toast("匯出失敗，請重試");
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function exportCSV() {
  const cell = (v: string) =>
    `"${(/^[=+\-@\t\r]/.test(v) ? "'" : "") + v.replace(/"/g, '""')}"`;
  download(
    "still-focus.csv",
    "\uFEFF日期,任務,專案,分鐘\r\n" +
      state.sessions
        .map((s) =>
          [new Date(s.at).toISOString(), s.task, s.project, String(s.minutes)]
            .map(cell)
            .join(","),
        )
        .join("\r\n"),
    "text/csv;charset=utf-8",
  );
}
setInterval(() => {
  if (state.deadline && secondsLeft(state) === 0) {
    const wasFocus = state.mode === "focus";
    finish(state);
    save();
    if (state.settings.sound) bell();
    const message = wasFocus
      ? "專注完成！起身走走、喝杯水，讓眼睛休息一下。"
      : "休息結束，準備開始下一段專注。";
    void notify(message);
    render();
    toast(message);
  }
  tickDisplay();
}, 250);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mini) {
    e.preventDefault();
    void toggleMini();
    return;
  }
  if (
    (e.target as HTMLElement).matches("input,textarea,select,button") ||
    document.querySelector("dialog[open]")
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  }
  if (e.key.toLowerCase() === "r") reset();
});
document.addEventListener("visibilitychange", () => tickDisplay());
render();
if (loadError)
  toast("儲存資料無法讀取；已嘗試保留原始資料於 still-v1-recovery。");
