/** The phone remote (remote.html), served by loom.exe (remote.rs). It keeps
 * nothing of its own: every action is a loomctl command posted to /api/cli,
 * so what the phone does happens in the desktop window, through the functions
 * its buttons call. See docs/phone-remote-study.md. */
import { icon } from "./icons";
import type { Agent } from "./agent";

type Pane = { id: string; ref: string; threadId: string; agent: Agent; title: string; state: string; lastOutput: string | null };
type Thread = { id: string; name: string; repo: string; dir: string; branch: string; state: string; zoomed: string | null; panes: Pane[] };
type Run = { x: number; text: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; fg?: number | string; bg?: number | string };
type Screen = { text: string; cols: number; rows: { runs: Run[] }[] };
type Menu = { question: string[]; options: string[]; keys?: string[]; rev: string };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GROUPS: [string, string[]][] = [["Waiting for you", ["waiting"]], ["Working", ["working", "starting"]], ["Idle", ["idle"]], ["Exited", ["exited"]]];

let token = pref("loom-token", "");
let threads: Thread[] = [];
// This phone's own choices, kept in its browser.
let listView = pref("loom-list", "threads"); // "threads", as on the PC, or "state"
const folded = new Set(pref("loom-folded", "").split("\n").filter(Boolean)); // thread ids and "repo:<path>"
let keysOpen = pref("loom-keys", "") === "1";
let wrap = pref("loom-wrap", "1") === "1";
let agents = ["claude", "codex", "opencode"];
let phoneSize = false;
let open: string | null = null;
let openState = "";
let shown: string | null = null; // the last screen drawn, to skip redrawing an unchanged one
let question = "";
let older = false; // older lines on screen: the live view waits
let pushed = false; // this page put the open pane in the history, so Back can pop it

function pref(name: string, fallback: string) {
  try { return localStorage.getItem(name) ?? fallback; } catch { return fallback; }
}
// A private window may refuse: the phone then forgets when the tab closes.
function setPref(name: string, value: string) {
  try { if (value) localStorage.setItem(name, value); else localStorage.removeItem(name); } catch { /* see above */ }
}
function store(t: string) {
  token = t;
  setPref("loom-token", t);
}

class Offline extends Error {}

/** One loomctl command. A change carries a key, so the retry after a dropped
 * connection gets the first run's answer instead of running it again. */
async function run<T>(cmd: string, argv: string[] = [], opts: { stdin?: string; change?: boolean; timeout?: number } = {}): Promise<T> {
  const key = opts.change ? `phone-${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}` : null;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cmd, argv, stdin: opts.stdin ?? null, key, timeout: opts.timeout ?? 30 }),
      });
    } catch {
      if (key && attempt < 3) { await sleep(1500); continue; }
      throw new Offline("Can't reach Loom. Is the PC on, and Tailscale connected on both?");
    }
    // Not JSON: tailscale serve answering for a Loom that isn't running, or has the remote off.
    const reply = await res.json().catch(() => null);
    if (!reply) throw new Offline(`Loom isn't answering (${res.status}). Is it running, with the remote on?`);
    if (res.status === 401) {
      store("");
      pairing();
    }
    $("#offline").hidden = true;
    if (!reply.ok) throw new Error(reply.error ?? "Loom refused that.");
    return reply.data as T;
  }
}

/** Runs an action and says how it went. */
async function act(work: () => Promise<unknown>, done = "") {
  try {
    await work();
    if (done) toast(done);
    shown = null;
    setTimeout(reread, 300);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

let toastTimer = 0;
function toast(text: string, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 7000 : 2500);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
function button(text: string, onclick: () => void, className = "") {
  const b = el("button", className, text);
  b.type = "button";
  b.onclick = onclick;
  return b;
}

const panes = () => threads.flatMap((t) => t.panes);
const find = (id: string | null) => panes().find((p) => p.id === id);
const threadOf = (p: Pane) => threads.find((t) => t.id === p.threadId);

function age(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 10 ? "now" : s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// --- The list -------------------------------------------------------------

let listKey = "";
function drawList() {
  const all = panes();
  const waiting = all.filter((p) => p.state === "waiting");
  $("#counts").hidden = !waiting.length;
  $("#counts span").textContent = `${waiting.length} waiting`;
  $("#counts").onclick = () => waiting[0] && go(waiting[0].id);
  // Rebuilt only when something besides the ages changed, so a tap never lands on a row being replaced.
  const key = JSON.stringify([open, listView, [...folded], threads.map((t) => [t.id, t.name, t.branch, t.state, t.panes.map((p) => [p.id, p.ref, p.state, p.title, p.agent])])]);
  if (key !== listKey) {
    listKey = key;
    for (const b of document.querySelectorAll<HTMLElement>("#views button")) b.setAttribute("aria-pressed", String(b.dataset.list === listView));
    const rows = $("#rows");
    if (listView === "threads") rows.replaceChildren(...(threads.length ? byThread() : [el("p", "none", "No threads. Start one with + New.")]));
    else if (!all.length) rows.replaceChildren(el("p", "none", "No agents. Start a thread with + New."));
    else rows.replaceChildren(...GROUPS.flatMap(([title, states]) => {
      const group = all.filter((p) => states.includes(p.state));
      if (!group.length) return [];
      return [el("h2", states[0], `${title} · ${group.length}`), ...group.map((p) => paneRow(p, `${p.ref} · ${p.agent}`))];
    }));
  }
  const latest = (id: string) => threads.find((t) => t.id === id)?.panes.map((p) => p.lastOutput ?? "").sort().pop() || null;
  for (const a of document.querySelectorAll<HTMLElement>("#rows .age")) a.textContent = age(a.dataset.thread ? latest(a.dataset.thread) : find(a.dataset.pane!)?.lastOutput ?? null);
}

function paneRow(p: Pane, name: string, chip = false) {
  const row = button("", () => go(p.id), `row ${p.state}`);
  row.dataset.id = p.id;
  row.setAttribute("aria-current", String(p.id === open));
  const head = el("span", "name");
  head.append(el("span", "", name));
  if (chip && p.state !== "idle") head.append(el("span", `chip ${p.state}`, p.state));
  const when = el("span", "age");
  when.dataset.pane = p.id;
  row.append(icon(p.agent), head, when, el("span", "title", p.title || " "));
  return row;
}

/** As on the PC: each project, its threads, and their agents. A tap on a
 * project or a thread folds it; a folded thread still shows its agents' states. */
function byThread() {
  return [...new Set(threads.map((t) => t.repo))].flatMap((repo) => {
    const group = threads.filter((t) => t.repo === repo);
    const key = `repo:${repo}`;
    const head = button("", () => fold(key), "project");
    head.setAttribute("aria-expanded", String(!folded.has(key)));
    head.append(el("span", "chev"), el("span", "grow", base(repo)), el("span", "n", String(group.length)));
    return folded.has(key) ? [head] : [head, ...group.map(threadBlock)];
  });
}

function threadBlock(t: Thread) {
  const shut = folded.has(t.id);
  const head = button("", () => fold(t.id), "thread-head");
  head.setAttribute("aria-expanded", String(!shut));
  const who = el("span", "who");
  who.append(el("span", "thread-name", t.name), el("span", "branch", t.branch || base(t.dir)));
  const pips = el("span", "pips");
  if (shut) {
    // Waiting and working agents first, so the "+n" never hides them.
    const rank = (p: Pane) => ["waiting", "working", "starting", "exited"].indexOf(p.state) >>> 0;
    pips.append(...[...t.panes].sort((a, b) => rank(a) - rank(b)).slice(0, 4).map((p) => {
      const pip = el("span", `pip ${p.state}`);
      pip.append(icon(p.agent));
      return pip;
    }));
    if (t.panes.length > 4) pips.append(el("span", "", `+${t.panes.length - 4}`));
  }
  const when = el("span", "age");
  when.dataset.thread = t.id;
  head.append(el("span", "chev"), who, pips, when);
  const more = button("⋯", () => threadActions(t), "icon-btn");
  more.setAttribute("aria-label", `${t.name}: actions`);
  const top = el("div", "thread-top");
  top.append(head, more);
  const box = el("div", `thread ${t.state}`);
  box.dataset.id = t.id;
  box.append(top);
  if (!shut) box.append(...(t.panes.length ? t.panes.map((p) => paneRow(p, p.agent, true)) : [el("p", "none", "No agents. Add one from ⋯.")]));
  return box;
}

function fold(key: string) {
  if (!folded.delete(key)) folded.add(key);
  setPref("loom-folded", [...folded].join("\n"));
  drawList();
}

function threadActions(t: Thread) {
  sheet([
    el("label", "", `Add an agent to ${t.name}`), addAgent(t.id),
    item("Show it on the PC", () => run("show", [t.id], { change: true }), "Shown on the PC"),
    button("Rename", () => {
      closeSheet();
      const name = prompt(`Rename ${t.name}. Its branch and folder keep their names.`, t.name)?.trim();
      if (name && name !== t.name) void act(() => run("rename", [t.id, name], { change: true }), "Renamed");
    }),
    item(`Close the thread ${t.name}`, () => run("close-thread", [t.id, "--yes"], { change: true, timeout: 60 }), "Thread closed",
      `Close ${t.name} and all its panes? Its folder and branch stay.`, "danger"),
  ]);
}

// --- One agent ------------------------------------------------------------

function go(id: string) {
  pushed = true;
  location.hash = `#/pane/${encodeURIComponent(id)}`;
}

function back() {
  if (!pushed) return location.replace("#/");
  pushed = false;
  history.back();
}

function drawHead() {
  const p = find(open);
  if (!p) {
    $("#pane-name").textContent = "This pane is gone";
    $("#pane-title").textContent = "";
    $("#pane-state").textContent = "";
    return;
  }
  $("#pane-name").textContent = `${p.ref} · ${p.agent}`;
  $("#pane-title").textContent = p.title;
  $("#pane-state").textContent = p.state;
  $("#pane-state").className = `chip ${p.state}`;
  // A question shows without the screen changing, as the agent stops: read again.
  if (p.state !== openState) shown = null;
  openState = p.state;
}

/** Terminal colours: the 16 of Loom's default theme, then xterm's cube and greys. */
const ANSI = ["--bg", "--err", "--ok", "--warn", "--blue", "--magenta", "--cyan", "--muted", "--faint", "--err", "--ok", "--warn", "--blue", "--magenta", "--cyan", "--text"];
function color(c: number | string | undefined) {
  if (c === undefined) return "";
  if (typeof c === "string") return c;
  if (c < 16) return `var(${ANSI[c]})`;
  if (c < 232) {
    const v = [0, 95, 135, 175, 215, 255], n = c - 16;
    return `rgb(${v[Math.floor(n / 36)]},${v[Math.floor(n / 6) % 6]},${v[n % 6]})`;
  }
  const g = 8 + (c - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

let charWidth = 0; // a character's width at a 1 px font
/** The font that fits the terminal's width, between 7 and 14 px. Wider than
 * that, the screen scrolls sideways and offers to fit Loom to the phone.
 * Wrapping, a screen that only fits under 10 px shows at 12 px, its lines wrapped. */
function fit(cols: number) {
  if (!charWidth) {
    const probe = el("span", "", "M".repeat(20));
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:100px var(--mono)";
    document.body.append(probe);
    charWidth = probe.getBoundingClientRect().width / 2000 || 0.6;
    probe.remove();
  }
  const box = $("#screen");
  const width = box.clientWidth - 16;
  const fitted = Math.floor((width / (cols * charWidth)) * 10) / 10;
  const size = Math.min(14, wrap && fitted < 10 ? 12 : Math.max(7, fitted));
  box.style.fontSize = `${size}px`;
  box.classList.toggle("wrap", wrap);
  if (!older) notice(!wrap && cols * charWidth * 7 > width ? `${cols} columns, wider than this screen.` : "");
}

function notice(text: string, label = phoneSize ? "Desktop size" : "Fit Loom to phone", action: () => void = () => void act(fitPhone)) {
  const bar = $("#notice");
  bar.hidden = !text;
  bar.querySelector("span")!.textContent = text;
  const b = bar.querySelector("button")!;
  b.textContent = label;
  b.onclick = action;
}

let drawnAt = 0; // when the page last moved the screen itself, not your finger
function draw(s: Screen, toEnd = false) {
  const box = $("#screen");
  drawnAt = performance.now();
  const atEnd = toEnd || box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  fit(s.cols);
  // The blank rows under an agent's last line would keep it off the bottom.
  let end = s.rows.length;
  while (end && !s.rows[end - 1].runs.some((r) => r.text.trim() || r.bg !== undefined)) end--;
  box.replaceChildren(...s.rows.slice(0, end).map((row) => {
    const text = row.runs.map((r) => r.text).join("");
    // A rule of box-drawing lines is cut at the edge, not wrapped onto more lines.
    const line = el("div", /^\s*[─-╿][\s─-╿]*$/.test(text) ? "line rule" : "line");
    let col = 0;
    for (const r of row.runs) {
      if (r.x > col) line.append(" ".repeat(r.x - col));
      const span = el("span", [r.bold && "b", r.dim && "d", r.italic && "i", r.underline && "u"].filter(Boolean).join(" "), r.text);
      const fg = color(r.fg), bg = color(r.bg);
      if (r.inverse) {
        span.style.color = bg || "var(--bg)";
        span.style.background = fg || "var(--text)";
      } else {
        if (fg) span.style.color = fg;
        if (bg) span.style.background = bg;
      }
      line.append(span);
      col = r.x + r.text.length;
    }
    return line;
  }));
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function drawQuestion(id: string, m: Menu | null) {
  const box = $("#question");
  const key = m ? m.rev : "";
  if (key === question) return; // the same question: leave the buttons under the finger
  question = key;
  box.hidden = !m;
  if (!m) return box.replaceChildren();
  box.replaceChildren(el("p", "", m.question.join("\n").trim()), ...m.options.map((o, i) => {
    const n = m.keys?.[i] ?? String(i + 1);
    return button(`${n}. ${o}`, () => void act(() => run("choose", [id, n, "--menu", m.rev], { change: true })));
  }));
}

const reread = () => void screen().catch(() => {});

/** Reads the open pane's screen, and its question when the screen changed. */
async function screen() {
  const id = open;
  if (!id || older || !token) return;
  const s = await run<Screen>("read", [id, "--styles"]);
  if (id !== open || older || s.text === shown) return;
  shown = s.text;
  draw(s);
  drawQuestion(id, await run<Menu | null>("menu", [id]).catch(() => null));
}

/** Toggles Loom's phone size on the PC, with the open pane filling the window. */
async function fitPhone() {
  const p = find(open);
  const th = p && threadOf(p);
  const fitting = !phoneSize;
  // A pane in a thread that isn't showing keeps its size, so it is shown first.
  if (p && fitting) await run("show", [p.id], { change: true });
  phoneSize = (await run<{ phone: boolean }>("window", ["phone"], { change: true })).phone;
  if (p && (th?.zoomed === p.id) !== fitting) await run("zoom", [p.id], { change: true });
  toast(phoneSize ? "Loom fits the phone now" : "Loom is back at its desktop size");
}

/** The pane's history above its screen, styled, when you scroll up past the
 * screen's top. The live view waits until you scroll back to the bottom. */
let loadingOlder = false;
async function olderLines() {
  const id = open;
  if (!id || older || loadingOlder) return;
  loadingOlder = true;
  try {
    const s = await run<Screen>("read", [id, "--styles", "--lines", "2000"]);
    if (id !== open) return;
    older = true;
    const box = $("#screen");
    const fromBottom = box.scrollHeight - box.scrollTop;
    draw(s);
    box.scrollTop = box.scrollHeight - fromBottom;
    notice("Older lines. Scroll to the bottom for live.", "Back to live", live);
  } finally {
    loadingOlder = false;
  }
}

function live() {
  if (!older) return;
  older = false;
  notice("");
  const id = open;
  void run<Screen>("read", [id!, "--styles"]).then((s) => {
    if (id !== open || older) return;
    shown = s.text;
    draw(s, true);
  }).catch(() => {});
}

{
  // Scrolling up past the top of the screen reads the history; back at the bottom, it's live again.
  const box = $("#screen");
  // Only a finger or a wheel counts: the box also scrolls when the keys fold or the page redraws.
  let last = 0, touchY = 0, touching = false, userAt = 0;
  const byUser = () => touching || performance.now() - userAt < 1000; // a flick glides on after the finger lifts
  box.addEventListener("scroll", () => {
    const up = box.scrollTop < last;
    last = box.scrollTop;
    if (performance.now() - drawnAt < 300 || !byUser()) return;
    if (up && box.scrollTop < 40) void olderLines();
    else if (!up && older && box.scrollTop + box.clientHeight >= box.scrollHeight - 4) live();
  }, { passive: true });
  // A screen shorter than the box doesn't scroll: a pull down asks for the history all
  // the same, and a push up at the bottom goes back to live.
  const atBottom = () => box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  const pulled = (dy: number) => {
    if (dy < 0 && box.scrollTop <= 0) void olderLines();
    else if (dy > 0 && older && atBottom()) live();
  };
  box.addEventListener("touchstart", (e) => { touching = true; touchY = e.touches[0].clientY; }, { passive: true });
  box.addEventListener("touchmove", (e) => {
    const dy = touchY - e.touches[0].clientY;
    if (Math.abs(dy) > 30) pulled(dy);
  }, { passive: true });
  for (const end of ["touchend", "touchcancel"]) box.addEventListener(end, () => { touching = false; userAt = performance.now(); }, { passive: true });
  box.addEventListener("wheel", (e) => {
    userAt = performance.now();
    pulled(e.deltaY);
  }, { passive: true });
}

function sheet(items: HTMLElement[]) {
  const box = $("#actions");
  box.replaceChildren(...items, button("Cancel", closeSheet));
  box.hidden = $("#scrim").hidden = false;
}
function closeSheet() {
  $("#actions").hidden = $("#scrim").hidden = true;
}
/** A sheet button that closes the sheet, asks first when `ask` says, then acts. */
function item(text: string, work: () => Promise<unknown>, done: string, ask = "", className = "") {
  return button(text, () => {
    closeSheet();
    if (ask && !confirm(ask)) return;
    void act(work, done);
  }, className);
}

/** A picker and Add: the new agent opens. */
function addAgent(threadId: string) {
  const pick = el("select");
  pick.append(...agents.map((a) => new Option(a, a)));
  pick.setAttribute("aria-label", "Agent");
  const add = button("Add", () => {
    closeSheet();
    void act(async () => {
      const added = await run<Pane>("add", [threadId, "--agent", pick.value], { change: true, timeout: 60 });
      await refresh();
      go(added.id);
    }, "Started");
  });
  const pair = el("div", "pair");
  pair.append(pick, add);
  return pair;
}

async function actions() {
  const p = find(open);
  if (!p) return;
  // Someone at the PC may have changed the window since.
  phoneSize = (await run<{ phone: boolean }>("status").catch(() => ({ phone: phoneSize }))).phone;
  const th = threadOf(p);
  sheet([
    item(phoneSize ? "Desktop size on the PC" : "Fit Loom to phone", fitPhone, ""),
    item(wrap ? "Don't wrap long lines" : "Wrap long lines", async () => {
      wrap = !wrap;
      setPref("loom-wrap", wrap ? "1" : "0");
      $("#screen").classList.toggle("wrap", wrap);
    }, ""),
    item("Show it on the PC", () => run("show", [p.id], { change: true }), "Shown on the PC"),
    item("Open it in Full Loom", async () => {
      await run("show", [p.id], { change: true });
      pushed = true;
      location.hash = "#/full";
    }, ""),
    item("Older lines", olderLines, ""),
    item("Clear the input (Ctrl+U)", () => run("keys", [p.id, "ctrl-u"], { change: true }), ""),
    el("label", "", `Add an agent to ${th?.name ?? "this thread"}`), addAgent(p.threadId),
    item("Restart", () => run("restart", [p.id, "--yes"], { change: true, timeout: 60 }), "Restarted", `Restart ${p.ref}? Its session resumes.`),
    item("Stop", () => run("stop", [p.id, "--yes"], { change: true }), "Stopped", `Stop ${p.ref}? The pane stays.`, "danger"),
    item("Close this pane", async () => { await run("close", [p.id, "--yes"], { change: true }); back(); }, "Closed", `Close ${p.ref}?`, "danger"),
    item(`Close the thread ${th?.name ?? ""}`, async () => { await run("close-thread", [p.threadId, "--yes"], { change: true, timeout: 60 }); back(); }, "Thread closed",
      `Close ${th?.name} and all its panes? Its folder and branch stay.`, "danger"),
  ]);
}

// --- A new thread ---------------------------------------------------------

let worktree = true;
function drawNew() {
  const form = $<HTMLFormElement>("#new form");
  const project = form.elements.namedItem("project") as HTMLSelectElement;
  const repos = [...new Set(threads.map((t) => t.repo))].sort((a, b) => base(a).localeCompare(base(b)));
  const keep = project.value;
  project.replaceChildren(...repos.map((r) => new Option(`${base(r)}  (${r})`, r)), new Option("Another folder…", ""));
  if (repos.includes(keep)) project.value = keep;
  const agent = form.elements.namedItem("agent") as HTMLSelectElement;
  const was = agent.value;
  agent.replaceChildren(...agents.map((a) => new Option(a, a)));
  if (agents.includes(was)) agent.value = was;
  kind();
}
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
function kind() {
  const form = $<HTMLFormElement>("#new form");
  $("#folder-field").hidden = (form.elements.namedItem("project") as HTMLSelectElement).value !== "";
  $("#name-field").hidden = $("#base-field").hidden = !worktree;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#new [data-kind]")) b.setAttribute("aria-pressed", String((b.dataset.kind === "worktree") === worktree));
}

async function create(e: SubmitEvent) {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  const folder = value("project") || value("folder");
  if (!folder) return toast("Pick a project or type a folder.", true);
  const args = [folder, "--agent", value("agent")];
  if (worktree) {
    if (!value("name") && !value("base")) return toast("Name the thread: its branch is loom/<name>.", true);
    if (value("name")) args.push("--name", value("name"));
    if (value("base")) args.push("--base", value("base"));
  }
  const submit = form.querySelector("button.primary") as HTMLButtonElement;
  submit.disabled = true;
  await act(async () => {
    const th = await run<Thread>("new", args, { change: true, timeout: 120 });
    await refresh();
    pushed = false;
    location.replace(th.panes[0] ? `#/pane/${encodeURIComponent(th.panes[0].id)}` : "#/");
  }, "Thread started");
  submit.disabled = false;
}

// --- A PC keyboard --------------------------------------------------------

type Mods = { ctrl: boolean; alt: boolean; shift: boolean };
type Typed = { key: string; mods: Mods } | { text: string };
const LABELS: Record<string, string> = {
  esc: "Esc", ctrl: "Ctrl", alt: "Alt", shift: "Shift", home: "Home", up: "↑", end: "End", tab: "Tab", "shift-tab": "⇧Tab",
  "ctrl-c": "^C", backspace: "⌫", left: "←", down: "↓", right: "→", fn: "Fn", insert: "Ins", delete: "Del",
  pageup: "PgUp", pagedown: "PgDn", space: "Space", enter: "Enter",
};
const PAGES = [
  [["esc", "ctrl", "alt", "shift", "home", "up", "end"], ["tab", "shift-tab", "ctrl-c", "backspace", "left", "down", "right"], ["fn", "insert", "delete", "pageup", "pagedown", "space", "enter"]],
  [["f1", "f2", "f3", "f4", "f5", "f6", "esc"], ["f7", "f8", "f9", "f10", "f11", "f12", "tab"], ["fn", "ctrl", "alt", "shift", "left", "right", "enter"]],
];
/** A physical keyboard's keys, by the names loomctl keys takes. */
const DOM_KEYS: Record<string, string> = {
  Escape: "esc", Tab: "tab", Enter: "enter", Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
const SENTINEL = " "; // the type box keeps one character, so Backspace always has something to delete and reaches us

/** The keys a PC has and a phone keyboard lacks; Ctrl, Alt and Shift held for
 * the next key, as on a PC; and a box whose typing goes straight through. */
function keyboard(box: HTMLElement, hint: string, out: (t: Typed) => void) {
  const mods: Mods = { ctrl: false, alt: false, shift: false };
  let page = 0;
  const keys = el("div", "keys");
  const draw = () => keys.replaceChildren(...PAGES[page].flat().map((k) => {
    const b = button(LABELS[k] ?? k.toUpperCase(), () => press(k));
    b.dataset.key = k;
    if (k === "fn") b.setAttribute("aria-pressed", String(page === 1));
    if (k in mods) b.setAttribute("aria-pressed", String(mods[k as keyof Mods]));
    // A key leaves the focus in the type box, so the phone's keyboard stays up.
    b.onpointerdown = (e) => e.preventDefault();
    return b;
  }));
  const press = (key: string, held: Partial<Mods> = {}) => {
    if (key === "fn") return (page = 1 - page), draw();
    if (key in mods) return (mods[key as keyof Mods] = !mods[key as keyof Mods]), draw();
    out({ key, mods: { ctrl: mods.ctrl || !!held.ctrl, alt: mods.alt || !!held.alt, shift: mods.shift || !!held.shift } });
    if (mods.ctrl || mods.alt || mods.shift) (mods.ctrl = mods.alt = mods.shift = false), draw();
  };
  // Text the phone's keyboard typed: with Ctrl, Alt or Shift held, each character is a key.
  const typed = (text: string) => {
    if (mods.ctrl || mods.alt || mods.shift) for (const ch of text) press(ch === " " ? "space" : ch);
    else out({ text });
  };
  const type = el("input", "type");
  Object.assign(type, { placeholder: hint, autocapitalize: "off", spellcheck: false });
  type.setAttribute("autocomplete", "off");
  type.setAttribute("autocorrect", "off");
  type.setAttribute("aria-label", hint);
  const reset = () => { type.value = SENTINEL; type.setSelectionRange(1, 1); };
  type.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // the phone's keyboard: beforeinput says what it typed
    const named = DOM_KEYS[e.key] ?? (/^F\d\d?$/.test(e.key) ? e.key.toLowerCase() : null);
    const combo = (e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1;
    if (!named && !combo) return;
    e.preventDefault();
    press(named ?? (e.key === " " ? "space" : e.key.toLowerCase()), { ctrl: e.ctrlKey, alt: e.altKey || e.metaKey, shift: e.shiftKey && !!named });
  });
  type.addEventListener("beforeinput", (e) => {
    if (e.isComposing || e.inputType === "insertCompositionText") return;
    if (e.inputType === "insertText" && e.data) typed(e.data);
    else if (e.inputType === "deleteContentBackward") press("backspace");
    else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") press("enter");
    else return;
    e.preventDefault();
  });
  // Words the keyboard composed (suggestions, swipe typing) arrive whole when it commits them.
  type.addEventListener("compositionend", (e) => { if (e.data) typed(e.data); reset(); });
  type.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    const extra = type.value.startsWith(SENTINEL) ? type.value.slice(SENTINEL.length) : type.value;
    if (extra) typed(extra);
    reset();
  });
  type.addEventListener("focus", () => setTimeout(reset));
  type.addEventListener("blur", () => (type.value = ""));
  box.replaceChildren(type, keys);
  draw();
  return type;
}

/** Sends in order, one request at a time; what piles up meanwhile goes in the next. */
function sequence<T>(send: (items: T[]) => Promise<unknown>) {
  let queue: T[] = [], busy = false;
  return (...items: T[]) => {
    queue.push(...items);
    if (busy) return;
    busy = true;
    void (async () => {
      while (queue.length) {
        const batch = queue;
        queue = [];
        try { await send(batch); } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
      }
      busy = false;
    })();
  };
}

/** The pane's keyboard: keys and typed text go to the open pane as they come. */
const toPane = sequence<{ id: string; t: Typed }>(async (items) => {
  // Runs of keys go in one keys command, runs of text in one --text, in order.
  for (let i = 0; i < items.length;) {
    const { id, t } = items[i];
    if ("text" in t) {
      let text = "";
      for (; i < items.length && items[i].id === id && "text" in items[i].t; i++) text += (items[i].t as { text: string }).text;
      await run("keys", [id, "--text", "-"], { stdin: text, change: true });
    } else {
      const names: string[] = [];
      for (; i < items.length && items[i].id === id && "key" in items[i].t; i++) {
        const { key, mods } = items[i].t as { key: string; mods: Mods };
        names.push(`${mods.ctrl ? "ctrl-" : ""}${mods.alt ? "alt-" : ""}${mods.shift ? "shift-" : ""}${key}`);
      }
      await run("keys", [id, ...names], { change: true });
    }
  }
  shown = null;
  reread();
});
keyboard($("#keys"), "Type here: each key goes straight to the pane", (t) => { if (open) toPane({ id: open, t }); });

// --- Full Loom ------------------------------------------------------------
// The PC's own Loom window, streamed from mirror.rs: every menu and panel.

type CdpEvent = { method: string; params: Record<string, unknown> };
const canvas = $<HTMLCanvasElement>("#mirror");
let full = 0; // which visit to Full Loom is running; 0 when it's closed
let emu = { width: 0, height: 0 }; // the page's size on the PC, in CSS pixels
let shownEmu = emu; // the size the frame on show was taken at
let frameSeq = 0;

async function mirror(body: object) {
  const res = await fetch("/api/mirror", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const reply = await res.json().catch(() => null);
  if (res.status === 401) { store(""); pairing(); }
  if (!reply?.ok) throw new Error(reply?.error ?? `Loom isn't answering (${res.status}). Is it running, with the remote on?`);
}

/** Lays Loom out at the size the stream has on this screen, and starts it. */
async function startFull() {
  const r = canvas.getBoundingClientRect();
  emu = { width: Math.round(r.width), height: Math.round(r.height) };
  // ponytail: the screencast sends frames at one pixel per CSS pixel whatever the ratio, so
  // text is soft on a sharp phone; Page.captureScreenshot with clip.scale 2 could do better.
  if (emu.width && emu.height) await mirror({ action: "start", ...emu, scale: 1 });
}

/** Draws each frame as it comes: a request waits on the PC until the page changes. */
async function watchFull(visit: number) {
  const draw = canvas.getContext("2d")!;
  while (full === visit) {
    if (document.hidden) { await sleep(500); continue; }
    let res: Response;
    try {
      res = await fetch(`/api/mirror?after=${frameSeq}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      $("#offline").textContent = "Can't reach Loom. Is the PC on, and Tailscale connected on both?";
      $("#offline").hidden = false;
      await sleep(2000);
      continue;
    }
    $("#offline").hidden = true;
    if (full !== visit) break;
    if (res.status === 401) { store(""); pairing(); break; }
    // The PC stopped the stream (this page was away a while): start it again.
    if (res.status === 409) { await startFull().catch(() => sleep(2000)); continue; }
    if (res.status !== 200) { if (res.status !== 204) await sleep(2000); continue; }
    frameSeq = Number(res.headers.get("X-Seq")) || frameSeq;
    const frame = await createImageBitmap(await res.blob());
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      [canvas.width, canvas.height] = [frame.width, frame.height];
      shownEmu = emu;
    }
    draw.drawImage(frame, 0, 0);
    frame.close();
    canvas.dataset.seq = String(frameSeq); // the frame on show, for checks
  }
}

const toFull = sequence<CdpEvent>((events) => mirror({ action: "input", events }));

/** Screen pixels per page pixel, and where the frame is drawn: it keeps its
 * shape in the box (object-fit: contain), so a frame from before a resize sits
 * between bands until the next one comes. */
function drawn() {
  const r = canvas.getBoundingClientRect();
  const fit = Math.min(r.width / canvas.width, r.height / canvas.height);
  const [w, h] = [canvas.width * fit, canvas.height * fit];
  return { k: w / (shownEmu.width || w), left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2 };
}
/** A point on the stream, in the page's CSS pixels. */
function at(e: { clientX: number; clientY: number }) {
  const { k, left, top } = drawn();
  return { x: Math.round((e.clientX - left) / k), y: Math.round((e.clientY - top) / k) };
}
const mouse = (type: string, p: { x: number; y: number }, more: Record<string, unknown> = {}): CdpEvent => ({ method: "Input.dispatchMouseEvent", params: { type, ...p, ...more } });
function click(p: { x: number; y: number }, button: "left" | "right", clickCount = 1) {
  toFull(mouse("mouseMoved", p), mouse("mousePressed", p, { button, buttons: button === "left" ? 1 : 2, clickCount }), mouse("mouseReleased", p, { button, buttons: 0, clickCount }));
}
let wheelAt: { x: number; y: number; dx: number; dy: number } | null = null;
function wheel(p: { x: number; y: number }, dx: number, dy: number) {
  // Gathered for 30 ms: a swipe is dozens of moves.
  if (wheelAt) return void ((wheelAt.dx += dx), (wheelAt.dy += dy));
  wheelAt = { ...p, dx, dy };
  setTimeout(() => {
    const w = wheelAt!;
    wheelAt = null;
    toFull(mouse("mouseWheel", { x: w.x, y: w.y }, { deltaX: Math.round(w.dx), deltaY: Math.round(w.dy) }));
  }, 30);
}

{
  // Tap to click, tap twice to double-click, hold to right-click, swipe to scroll.
  let g: { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean; held: boolean; timer: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2) return click(at(e), "right");
    canvas.setPointerCapture(e.pointerId);
    const p = at(e);
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, held: false, timer: 0 };
    const mine = g;
    g.timer = window.setTimeout(() => {
      if (mine.moved) return;
      mine.held = true;
      click(p, "right");
      navigator.vibrate?.(15);
    }, 550);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 10) return;
    g.moved = true;
    clearTimeout(g.timer);
    const { k } = drawn();
    wheel(at(e), (g.lastX - e.clientX) / k, (g.lastY - e.clientY) / k);
    [g.lastX, g.lastY] = [e.clientX, e.clientY];
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    if (!g.moved && !g.held) {
      const p = at(e), now = Date.now();
      const twice = now - lastTap.t < 400 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24;
      click(p, "left", twice ? 2 : 1);
      lastTap = twice ? { t: 0, x: 0, y: 0 } : { t: now, ...p };
    }
    g = null;
  });
  canvas.addEventListener("pointercancel", () => { if (g) clearTimeout(g.timer); g = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); wheel(at(e), e.deltaX, e.deltaY); }, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // The phone's keyboard or a resized window changes the room the stream has: Loom lays out again.
  let resized = 0;
  new ResizeObserver(() => {
    clearTimeout(resized);
    resized = window.setTimeout(() => {
      const r = canvas.getBoundingClientRect();
      if (full && Math.round(r.width) && (Math.abs(r.width - emu.width) > 2 || Math.abs(r.height - emu.height) > 2)) void startFull().catch((e) => toast(e.message, true));
    }, 300);
  }).observe(canvas);
}

/** A key as a PC keyboard sends it to the page. */
const CODES: Record<string, [string, string, number]> = {
  esc: ["Escape", "Escape", 27], tab: ["Tab", "Tab", 9], enter: ["Enter", "Enter", 13], backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46], insert: ["Insert", "Insert", 45], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], left: ["ArrowLeft", "ArrowLeft", 37],
  up: ["ArrowUp", "ArrowUp", 38], right: ["ArrowRight", "ArrowRight", 39], down: ["ArrowDown", "ArrowDown", 40], space: [" ", "Space", 32],
};
function keyEvents(t: Typed): CdpEvent[] {
  if ("text" in t) return [{ method: "Input.insertText", params: { text: t.text } }];
  let { key: name, mods } = t;
  if (name === "shift-tab") [name, mods] = ["tab", { ...mods, shift: true }];
  if (name === "ctrl-c") [name, mods] = ["c", { ...mods, ctrl: true }];
  const f = /^f(\d\d?)$/.exec(name);
  const ch = name.length === 1 ? (mods.shift ? name.toUpperCase() : name) : "";
  const [key, code, vk] = CODES[name] ?? (f ? [`F${f[1]}`, `F${f[1]}`, 111 + Number(f[1])]
    : /^[a-z]$/i.test(name) ? [ch, `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)]
    : /^\d$/.test(name) ? [ch, `Digit${name}`, 48 + Number(name)] : [ch, "", 0]);
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  // A character key types itself, unless Ctrl or Alt makes it a shortcut.
  const text = mods.ctrl || mods.alt ? "" : name === "enter" ? "\r" : key.length === 1 ? key : "";
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  return [
    { method: "Input.dispatchKeyEvent", params: { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) } },
    { method: "Input.dispatchKeyEvent", params: { ...base, type: "keyUp" } },
  ];
}
const fullType = keyboard($("#full-keys"), "Type here: keys go to Loom", (t) => toFull(...keyEvents(t)));
$("#full-kbd").onclick = () => {
  const box = $("#full-keys");
  box.hidden = !box.hidden;
  $("#full-kbd").setAttribute("aria-expanded", String(!box.hidden));
  if (!box.hidden) fullType.focus();
};
$("#full-back").onclick = back;
$("#full-btn").onclick = () => { pushed = true; location.hash = "#/full"; };

// --- Views, pairing and the loops -----------------------------------------

function route() {
  const m = /^#\/pane\/(.+)$/.exec(location.hash);
  const view = m ? "pane" : location.hash === "#/new" ? "new" : location.hash === "#/full" ? "full" : "list";
  if (view === "full" && !full) {
    full = Date.now();
    const visit = full;
    delete canvas.dataset.seq;
    // After the layout, so the stream asks for the room it really has.
    requestAnimationFrame(() => void startFull().then(() => watchFull(visit), (e) => toast(e.message, true)));
  } else if (view !== "full" && full) {
    full = 0;
    void mirror({ action: "stop" }).catch(() => {});
  }
  const id = m ? decodeURIComponent(m[1]) : null;
  if (id !== open) {
    open = id;
    openState = "";
    shown = null;
    question = "";
    older = false;
    $("#screen").replaceChildren();
    $("#question").hidden = true;
    notice("");
    // With Loom fitted to the phone, the agent you open fills the PC's window too, at the phone's width.
    const p = find(id);
    if (p && phoneSize) void act(async () => {
      await run("show", [p.id], { change: true });
      if (threadOf(p)?.zoomed !== p.id) await run("zoom", [p.id], { change: true });
    });
  }
  document.body.dataset.view = view;
  $("#pane").hidden = view !== "pane";
  $("#new").hidden = view !== "new";
  $("#full").hidden = view !== "full";
  closeSheet();
  if (view === "new") drawNew();
  drawList();
  drawHead();
  reread();
}

function pairing() {
  $("#app").hidden = true;
  $("#pairing").hidden = false;
}

async function pair(e: SubmitEvent) {
  e.preventDefault();
  const input = (e.target as HTMLFormElement).elements.namedItem("code") as HTMLInputElement;
  try {
    const res = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: input.value.trim() }) });
    const reply = await res.json();
    if (!reply.ok) return toast(reply.error, true);
    store(reply.token);
    input.value = "";
    void start();
  } catch {
    toast("Can't reach Loom. Is the PC on, and Tailscale connected on both?", true);
  }
}

async function refresh() {
  threads = await run<Thread[]>("threads");
  drawList();
  if (open) drawHead();
}

/** The list every 2 s and the open screen every second, while the page is in view. */
async function loop(every: number, work: () => Promise<unknown>) {
  for (;;) {
    if (token && !document.hidden) {
      try {
        await work();
      } catch (e) {
        if (e instanceof Offline) {
          $("#offline").textContent = e.message;
          $("#offline").hidden = false;
        }
      }
    }
    await sleep(every);
  }
}

let started = false;
async function start() {
  $("#pairing").hidden = true;
  $("#app").hidden = false;
  try {
    const s = await run<{ phone: boolean; agents: string[] }>("status");
    phoneSize = s.phone;
    if (s.agents?.length) agents = s.agents;
    await refresh();
  } catch (e) {
    if (!token) return;
    toast(e instanceof Error ? e.message : String(e), true);
  }
  route();
  if (started) return;
  started = true;
  void loop(2000, refresh);
  // ponytail: rereads the screen every second while it's open (about 1.7 KB gzipped);
  // gate on the pane's lastOutput if mobile data use matters.
  void loop(1000, screen);
}

window.addEventListener("hashchange", route);
$("#back").onclick = back;
$("#new .back").onclick = back;
$("#new-btn").onclick = () => { pushed = true; location.hash = "#/new"; };
$("#more").onclick = () => void actions();
$("#scrim").onclick = closeSheet;
$<HTMLFormElement>("#pairing form").onsubmit = pair;
$<HTMLFormElement>("#new form").onsubmit = create;
($<HTMLFormElement>("#new form").elements.namedItem("project") as HTMLSelectElement).onchange = kind;
for (const b of document.querySelectorAll<HTMLButtonElement>("#new [data-kind]")) b.onclick = () => { worktree = b.dataset.kind === "worktree"; kind(); };
for (const b of document.querySelectorAll<HTMLButtonElement>("#views button")) {
  b.onclick = () => { listView = b.dataset.list!; setPref("loom-list", listView); drawList(); };
}
/** The keys fold away under the button beside the message box, and stay as left. */
function drawKeys() {
  const box = $("#screen");
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  $("#keys").hidden = !keysOpen;
  $("#keys-btn").setAttribute("aria-expanded", String(keysOpen));
  if (atEnd) box.scrollTop = box.scrollHeight;
}
$("#keys-btn").onclick = () => { keysOpen = !keysOpen; setPref("loom-keys", keysOpen ? "1" : ""); drawKeys(); };
drawKeys();
$<HTMLFormElement>("#prompt").onsubmit = async (e) => {
  e.preventDefault();
  const box = $<HTMLTextAreaElement>("#prompt textarea");
  const text = box.value.trim();
  const send = $<HTMLButtonElement>("#prompt .primary");
  if (!text || !open) return;
  send.disabled = true;
  const id = open;
  // An agent gets a task Loom follows to its end. A shell gets the line typed:
  // submit needs Loom's PowerShell prompt and would add a PowerShell comment.
  const cmd = find(id)?.agent === "shell" ? "send" : "submit";
  await act(async () => {
    await run(cmd, [id, "-"], { stdin: text, change: true, timeout: 60 });
    box.value = "";
    box.style.height = "";
  }, "Sent");
  send.disabled = false;
};
// The box grows with what you type, up to 40% of the screen.
$("#prompt textarea").addEventListener("input", (e) => {
  const box = e.target as HTMLTextAreaElement;
  box.style.height = "";
  box.style.height = `${box.scrollHeight + 2}px`;
});
$("#prompt textarea").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $<HTMLFormElement>("#prompt").requestSubmit();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && token) void refresh().catch(() => {}); });

if (token) void start();
else pairing();
