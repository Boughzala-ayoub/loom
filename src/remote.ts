/** The phone remote (remote.html), served by loom.exe (remote.rs). It keeps
 * nothing of its own: every action is a loomctl command posted to /api/cli,
 * so what the phone does happens in the desktop window, through the functions
 * its buttons call. See docs/phone-remote-study.md. */
import { icon } from "./icons";
import type { Agent } from "./agent";

type Pane = { id: string; ref: string; threadId: string; agent: Agent; title: string; state: string; lastOutput: string | null };
type Thread = { id: string; name: string; repo: string; zoomed: string | null; panes: Pane[] };
type Run = { x: number; text: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; fg?: number | string; bg?: number | string };
type Screen = { text: string; cols: number; rows: { runs: Run[] }[] };
type Menu = { question: string[]; options: string[]; keys?: string[]; rev: string };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GROUPS: [string, string[]][] = [["Waiting for you", ["waiting"]], ["Working", ["working", "starting"]], ["Idle", ["idle"]], ["Exited", ["exited"]]];

let token = stored();
let threads: Thread[] = [];
let agents = ["claude", "codex", "opencode"];
let phoneSize = false;
let open: string | null = null;
let openState = "";
let shown: string | null = null; // the last screen drawn, to skip redrawing an unchanged one
let question = "";
let older = false; // older lines on screen: the live view waits
let pushed = false; // this page put the open pane in the history, so Back can pop it

function stored() {
  try { return localStorage.getItem("loom-token") ?? ""; } catch { return ""; }
}
function store(t: string) {
  token = t;
  // A private window may refuse: the phone then stays paired until the tab closes.
  try { if (t) localStorage.setItem("loom-token", t); else localStorage.removeItem("loom-token"); } catch { /* see above */ }
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
  const waiting = all.filter((p) => p.state === "waiting").length;
  $("#counts").textContent = waiting ? `${waiting} waiting` : "";
  $("#counts").hidden = !waiting;
  $("#counts").className = waiting ? "chip waiting" : "chip";
  // Rebuilt only when something besides the ages changed, so a tap never lands on a row being replaced.
  const key = JSON.stringify([open, all.map((p) => [p.id, p.ref, p.state, p.title, p.agent])]);
  if (key !== listKey) {
    listKey = key;
    const rows = $("#rows");
    if (!all.length) rows.replaceChildren(el("p", "none", "No agents. Start a thread with + New."));
    else rows.replaceChildren(...GROUPS.flatMap(([title, states]) => {
      const group = all.filter((p) => states.includes(p.state));
      if (!group.length) return [];
      return [el("h2", states[0], `${title} · ${group.length}`), ...group.map((p) => {
        const row = button("", () => go(p.id), `row ${p.state}`);
        row.dataset.id = p.id;
        row.setAttribute("aria-current", String(p.id === open));
        row.append(icon(p.agent), el("span", "name", `${p.ref} · ${p.agent}`), el("span", "age"), el("span", "title", p.title || " "));
        return row;
      })];
    }));
  }
  for (const row of document.querySelectorAll<HTMLElement>("#rows .row")) row.querySelector(".age")!.textContent = age(find(row.dataset.id!)?.lastOutput ?? null);
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
 * that, the screen scrolls sideways and offers to fit Loom to the phone. */
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
  const size = Math.min(14, Math.max(7, Math.floor((width / (cols * charWidth)) * 10) / 10));
  box.style.fontSize = `${size}px`;
  if (!older) notice(cols * charWidth * 7 > width ? `${cols} columns, wider than this screen.` : "");
}

function notice(text: string, label = phoneSize ? "Desktop size" : "Fit Loom to phone", action = () => void act(fitPhone)) {
  const bar = $("#notice");
  bar.hidden = !text;
  bar.querySelector("span")!.textContent = text;
  const b = bar.querySelector("button")!;
  b.textContent = label;
  b.onclick = action;
}

function draw(s: Screen) {
  const box = $("#screen");
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  fit(s.cols);
  box.replaceChildren(...s.rows.map((row) => {
    const line = el("div", "line");
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

async function olderLines() {
  const id = open;
  if (!id) return;
  const s = await run<{ text: string }>("read", [id, "--lines", "500"]);
  older = true;
  const box = $("#screen");
  box.textContent = s.text;
  box.scrollTop = box.scrollHeight;
  notice("Older lines.", "Back to live", () => {
    older = false;
    shown = null;
    notice("");
    reread();
  });
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

async function actions() {
  const p = find(open);
  if (!p) return;
  // Someone at the PC may have changed the window since.
  phoneSize = (await run<{ phone: boolean }>("status").catch(() => ({ phone: phoneSize }))).phone;
  const th = threadOf(p);
  const pick = el("select");
  pick.append(...agents.map((a) => new Option(a, a)));
  const add = button("Add", () => {
    closeSheet();
    void act(async () => {
      const added = await run<Pane>("add", [p.threadId, "--agent", pick.value], { change: true, timeout: 60 });
      await refresh();
      go(added.id);
    }, "Started");
  });
  const pair = el("div", "pair");
  pair.append(pick, add);
  sheet([
    item(phoneSize ? "Desktop size on the PC" : "Fit Loom to phone", fitPhone, ""),
    item("Show it on the PC", () => run("show", [p.id], { change: true }), "Shown on the PC"),
    item("Older lines", olderLines, ""),
    item("Clear the input (Ctrl+U)", () => run("keys", [p.id, "ctrl-u"], { change: true }), ""),
    el("label", "", `Add an agent to ${th?.name ?? "this thread"}`), pair,
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

// --- Views, pairing and the loops -----------------------------------------

function route() {
  const m = /^#\/pane\/(.+)$/.exec(location.hash);
  const view = m ? "pane" : location.hash === "#/new" ? "new" : "list";
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
for (const b of document.querySelectorAll<HTMLButtonElement>("#keys button")) {
  b.onclick = () => { if (open) void act(() => run("keys", [open!, b.dataset.key!], { change: true })); };
}
$<HTMLFormElement>("#prompt").onsubmit = async (e) => {
  e.preventDefault();
  const box = $<HTMLTextAreaElement>("#prompt textarea");
  const text = box.value.trim();
  const send = $<HTMLButtonElement>("#prompt button");
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
