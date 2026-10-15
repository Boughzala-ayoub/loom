/** Settings: the PC's Preferences, the agents its + menu offers, the window,
 * and this phone's own choices. Each PC setting is a loomctl command. */
import { $, act, age, app, button, closeSheet, confirmSheet, el, findPane, hooks, iconButton, panes, pref, run, setPref, sheet, sleep, store, toast, topBar, ui, type Startup } from "./core";
import { b64u, unb64u } from "../push";
import { dictationSheet, lists, pickLabel, readLists } from "./dictate";
import { procsView, type Reading } from "../procs";

type Theme = { name: string; scheme: string; current: boolean; vars: Record<string, string> };
type Notify = { all: string; kinds: { finish: boolean; fail: boolean; blocked: boolean }; newPanes: string };
type Settings = { sound: string; taskbar: string; overlay: string; awake: string; "plan-usage": string; font: string };
/** A paired phone: its id is the start of its token's SHA-256 (remote.rs), its times unix ms. */
type Device = { id: string; name: string; paired: number | null; seen: number | null; push: boolean };
type Remote = { phones: number; address: string | null; port: number; devices?: Device[] };
type Trashed = { folder?: string; at: string; branch?: string; commit?: string; when?: string };
/** When this Loom started, and whether an update waits for a restart. */
type Status = { booted?: number; updated?: boolean };

export const settingsView = el("section", "screen primary alone");
settingsView.id = "settings";
const body = el("div", "body");
settingsView.append(topBar("Settings"), body);

let themes: Theme[] = [];
let notify: Notify | null = null;
let settings: Settings | null = null;
let startups: Startup[] = [];
let remote: Remote | null = null;
let trash: Trashed[] = [];
let loom: Status = {};
let mine = ""; // this phone's id in the PC's list of phones

/** This phone's id as remote.rs keeps it: the first 12 hex digits of its token's SHA-256. */
async function myId() {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(app.token)));
  return [...sum].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export async function read() {
  const [t, n, s, st, r, tr, , ls, , id] = await Promise.all([
    run<Theme[]>("theme").catch(() => themes),
    run<Notify>("notify").catch(() => notify),
    run<Settings>("set").catch(() => settings),
    run<Startup[]>("startups").catch(() => startups),
    run<Remote>("remote").catch(() => remote),
    run<Trashed[]>("trash").catch(() => trash),
    pushState().catch(() => {}),
    run<Status>("status").catch(() => loom),
    readLists().catch(() => {}),
    myId().catch(() => ""), // no crypto.subtle on plain http: no phone is marked as this one
  ]);
  loom = ls;
  mine = id;
  // An older Loom answers a command it lacks with an error: each reading keeps its shape.
  const list = <T>(v: unknown, was: T[]) => (Array.isArray(v) ? (v as T[]) : was);
  [themes, startups, trash] = [list(t, themes), list(st, startups), list(tr, trash)];
  // New Thread and Add Agent offer these: one added here shows there, a removed one goes.
  if (Array.isArray(st)) app.startups = startups;
  [notify, settings, remote] = [n, s, r];
  const cur = themes.find((x) => x.current);
  if (cur) wear(cur);
  draw();
}

// --- Notifications on this phone (docs/phone-notifications-study.md) ---------------

/** A service worker and the Push API: Chrome has them at Loom's https address. */
const pushable = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let pushOn = false;
/** /api/push: Loom's key and whether this phone gets notifications, after the change asked for. */
async function pushApi(change: object) {
  const res = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.token}` }, body: JSON.stringify(change) });
  const reply = await res.json().catch(() => null);
  if (!reply?.ok) throw new Error(reply?.error ?? `Loom isn't answering (${res.status}).`);
  return reply as { key: string | null; on: boolean };
}
const subscribed = async () => (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;
/** The key a subscription was made with: a push signed with any other is refused (RFC 8292, section 4.2). */
function keyOf(sub: PushSubscription | null) {
  const made = sub?.options.applicationServerKey;
  return made ? b64u(new Uint8Array(made)) : "";
}
/** On when Loom has this phone's subscription and the browser holds it, made with Loom's key. */
async function pushState() {
  if (!pushable()) return;
  const { key, on } = await pushApi({});
  pushOn = on && Notification.permission === "granted" && !!key && keyOf(await subscribed()) === key;
}
/** Signs this phone up for Loom's notifications (Android asks first), or stops them. */
async function setPush(on: boolean) {
  const reg = await navigator.serviceWorker.register("/sw.js");
  if (!on) {
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    pushOn = (await pushApi({ off: true })).on;
    return;
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this page: allow them in the browser's site settings.");
  const { key } = await pushApi({});
  if (!key) throw new Error("Loom is still making its key. Try again in a moment.");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Made with another key (Loom's remote settings were reset): sign up again.
  if (sub && keyOf(sub) !== key) (await sub.unsubscribe(), (sub = null));
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
  pushOn = (await pushApi({ subscription: sub.toJSON() })).on;
}
/** Each start: a phone signed up hands Loom its subscription again, in case its browser renewed it. */
export async function syncPush() {
  if (!pushable() || Notification.permission !== "granted") return;
  // A newer worker from an updated Loom takes over now, not a day later.
  void (await navigator.serviceWorker.getRegistration())?.update().catch(() => {});
  // Checked as switching them on checks it: one made with a key Loom has since changed is replaced.
  if (!(await subscribed())) return;
  await setPush(true);
  if (!settingsView.hidden) draw(); // Settings may be up already, drawn before this
}
/** A notification goes once its agent was seen or answered (idle or working again), 15 s after it came.
 * One for an agent that exited stays. */
export async function closeStale() {
  if (!pushable() || Notification.permission !== "granted") return;
  for (const n of (await (await navigator.serviceWorker.getRegistration())?.getNotifications()) ?? []) {
    const p = findPane(n.data?.pane ?? null);
    if (p && (p.state === "idle" || p.state === "working") && Date.now() - (n.data?.at ?? 0) > 15_000) n.close();
  }
}

/** Restarts Loom on the PC (loomctl relaunch), then reloads this page from the
 * Loom that comes back: after an update, its new page too. */
async function restartLoom() {
  const busy = panes().filter((p) => p.state === "working").map((p) => p.ref);
  const detail = busy.length ? `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working: restarting stops ${busy.length === 1 ? "it" : "them"}. Every agent comes back in its session.`
    : "Loom closes safely on the PC and starts again, the new version if you just updated. Every agent comes back in its session.";
  if (!(await confirmSheet("Restart Loom?", detail, "Restart", busy.length > 0))) return;
  // Asked of the Loom running now (Settings' reading may be of one restarted since), by its booted: a retry of
  // a request cut off as it restarted reaches the Loom that replaced it, which then restarts nothing.
  let was: number | undefined;
  if (!(await act(async () => {
    was = (await run<Status>("status")).booted;
    await run("relaunch", ["--yes", "--booted", String(was)], { change: true });
  }))) return;
  app.restarting = true;
  const banner = $("#offline");
  banner.classList.add("calm");
  for (const end = Date.now() + 180_000; Date.now() < end; await sleep(2000)) {
    banner.textContent = "Loom is restarting on the PC. This page reloads when it's back.";
    banner.hidden = false;
    const s = await run<Status>("status").catch(() => null);
    if (s?.booted && s.booted !== was) return location.reload();
  }
  app.restarting = false;
  banner.classList.remove("calm");
  banner.textContent = "Loom didn't come back. Start it on the PC.";
}

/** The task manager (src/procs.ts) in a sheet, read through remote.rs's /api/procs. */
export async function openTasks() {
  const view = procsView(() => run<Reading>("procs", [], { path: "/api/procs", timeout: 10 }));
  const closed = sheet([view.box], "Task manager", "Close");
  $("#sheet").classList.add("tasks-sheet");
  await view.poll(closed, () => app.restarting);
}

/** The phone wears the PC's theme: the same colour names, set on the page. */
export function wear(t: Pick<Theme, "scheme" | "vars">) {
  const root = document.documentElement;
  for (const k of [...root.style]) if (k.startsWith("--")) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars ?? {})) root.style.setProperty(k, v);
  root.dataset.scheme = t.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.vars?.["--panel"] ?? "#0f0f0f");
  setPref("loom-theme", JSON.stringify({ scheme: t.scheme, vars: t.vars }));
}

const DEFAULT: Record<string, string> = { "--bg": "#0f0f0f", "--text": "#ececec", "--accent": "#ececec", "--ok": "#6fbf86", "--warn": "#e9b44c", "--err": "#ef6d64" };
const color = (t: Theme, k: string) => t.vars?.[k] ?? DEFAULT[k];
function dots(t: Theme) {
  const box = el("span", "dots");
  for (const k of ["--accent", "--ok", "--warn", "--err"]) {
    const dot = el("i");
    dot.style.background = color(t, k);
    box.append(dot);
  }
  return box;
}
/** Every theme as a swatch in its own colours. */
function grid() {
  const box = el("div", "themes");
  box.append(...themes.map((t) => {
    const b = button("", () => {
      closeSheet();
      void act(() => run("theme", [t.name], { change: true }), `Theme: ${t.name}`).then(() => read());
    }, "swatch");
    b.style.background = color(t, "--bg");
    b.style.color = color(t, "--text");
    b.setAttribute("aria-pressed", String(t.current));
    b.append(dots(t), el("b", "", t.name));
    return b;
  }));
  return box;
}

function group(title: string, ...rows: Node[]) {
  const box = el("div", "group");
  box.append(...rows);
  return [el("div", "section-title", title), box];
}
function setting(title: string, detail: string, control: Node, stack = false) {
  const row = el("div", stack ? "setting stack" : "setting");
  const what = el("div", "what");
  what.append(el("b", "", title), ...(detail ? [el("span", "", detail)] : []));
  row.append(what, control);
  return row;
}
function toggle(on: boolean, label: string, change: (on: boolean) => Promise<unknown>) {
  const s = el("input", "switch");
  s.type = "checkbox";
  s.checked = on;
  s.setAttribute("role", "switch");
  s.setAttribute("aria-label", label);
  s.onchange = () => void act(() => change(s.checked)).then((ok) => { if (!ok) s.checked = !s.checked; else void read(); });
  return s;
}
function choice(value: string, options: [string, string][], change: (v: string) => Promise<unknown>) {
  const seg = el("div", "seg");
  for (const [v, label] of options) {
    const b = button(label, () => void act(() => change(v)).then(() => read()));
    b.setAttribute("aria-pressed", String(v === value));
    seg.append(b);
  }
  return seg;
}

function draw() {
  const nodes: Node[] = [];
  // Appearance: the PC's theme, which this phone wears too, and the terminals' size.
const current = themes.find((t) => t.current);
  const now = el("span", "theme-now");
  if (current) now.append(dots(current), current.name);
  const pickTheme = button(now, () => void sheet([grid()], "Theme"));
  const font = Number(settings?.font ?? 13);
  const stepper = el("div", "stepper");
  const out = el("output", "", String(font));
  const step = (d: number) => void act(() => run("set", ["font", String(Math.min(24, Math.max(8, font + d)))], { change: true })).then(() => read());
  stepper.append(iconButton("minus", "Smaller", () => step(-1)), out, iconButton("plus", "Larger", () => step(1)));
  nodes.push(...group("Appearance",
    setting("Theme", "On the PC, and this phone wears it too", pickTheme),
    setting("Terminal text size", "The PC's agents and terminals, in points", stepper),
  ));
  // The mic's language and prefix: one pick, the PC's F4 and this phone's mic alike.
  if (lists) nodes.push(...group("Dictation",
    setting("Language and prefix", `${pickLabel()}. F4 on the PC uses the same.`, button("Change", () => dictationSheet(draw))),
  ));

  if (notify && settings) nodes.push(...group("Notifications",
    setting("Notifications on this phone", pushable() ? "Task notices, here too. A tap opens the agent." : "This browser can't get them. Open Loom's https address in Chrome.",
      pushable() ? toggle(pushOn, "Notifications on this phone", setPush) : el("span")),
    ...(pushOn ? [setting("Test them", "Every phone with notifications on gets one", button("Send a test", () => void act(() => run("remote", ["push", "test"], { change: true }), "Sent")))] : []),
    setting("Task notices", "Tell you when an agent's task ends", toggle(notify.all === "on", "Task notices", (on) => run("notify", ["--all", on ? "on" : "off"], { change: true }))),
    setting("When a task finishes", "", toggle(notify.kinds.finish, "When a task finishes", (on) => run("notify", ["--finish", on ? "on" : "off"], { change: true }))),
    setting("When a task fails", "", toggle(notify.kinds.fail, "When a task fails", (on) => run("notify", ["--fail", on ? "on" : "off"], { change: true }))),
    setting("When an agent is blocked", "It asks you something", toggle(notify.kinds.blocked, "When an agent is blocked", (on) => run("notify", ["--blocked", on ? "on" : "off"], { change: true }))),
    setting("New agents", "", choice(notify.newPanes, [["inherit", "Like all"], ["on", "On"], ["off", "Off"]], (v) => run("notify", ["--new-panes", v], { change: true })), true),
    setting("Sound", "A chime on the PC when an agent wakes", toggle(settings.sound === "on", "Sound", (on) => run("set", ["sound", on ? "on" : "off"], { change: true }))),
    setting("Flash the taskbar", "When Loom isn't in front on the PC", toggle(settings.taskbar === "on", "Flash the taskbar", (on) => run("set", ["taskbar", on ? "on" : "off"], { change: true }))),
  ));

  if (settings) {
    const win = el("div", "seg");
    for (const [how, label] of [["show", "Show"], ["minimize", "Minimize"], ["maximize", "Maximize"], ["restore", "Restore"]]) win.append(button(label, () => void act(() => run("window", [how], { change: true }), `Window: ${label.toLowerCase()}`)));
    nodes.push(...group("On the PC",
      setting("Restart Loom", loom.updated ? "An update is installed: restart to use it" : "Closes safely and starts again. Every agent comes back",
        button(loom.updated ? "Restart to update" : "Restart", () => void restartLoom(), loom.updated ? "primary" : "")),
      setting("Task manager", "The PC's CPU, memory and processes", button("Open", () => void openTasks())),
      setting("Keep the PC awake", "While Loom runs, the PC doesn't sleep", toggle(settings.awake === "on", "Keep the PC awake", (on) => run("set", ["awake", on ? "on" : "off"], { change: true }))),
      setting("Agent overlay", "The small list of agents over other windows", choice(settings.overlay, [["off", "Off"], ["background", "In background"], ["always", "Always"]], (v) => run("set", ["overlay", v], { change: true })), true),
      setting("Plan usage", "Ask Claude and Codex for your limits", toggle(settings["plan-usage"] === "on", "Plan usage", (on) => run("set", ["plan-usage", on ? "on" : "off"], { change: true }))),
      setting("Loom's window", "", win, true),
      setting("Phone size", "Shape Loom's window like a phone, so agents draw at its width", button(app.phoneSize ? "Desktop size" : "Phone size", () => void act(async () => { app.phoneSize = (await run<{ phone: boolean }>("window", ["phone"], { change: true })).phone; }).then(() => draw()))),
    ));
  }

  // The + menu's agents and terminals: new threads and Add pick from these.
  const add = el("form", "pair");
  const label = el("input"), cmd = el("input");
  Object.assign(label, { placeholder: "Name", autocapitalize: "off", spellcheck: false });
  Object.assign(cmd, { placeholder: "Command (the name if empty)", autocapitalize: "off", spellcheck: false });
  label.setAttribute("aria-label", "Name");
  cmd.setAttribute("aria-label", "Command");
  const addBtn = el("button", "primary", "Add");
  add.style.gridTemplateColumns = "minmax(0, 1fr)";
  add.append(label, cmd, addBtn);
  add.onsubmit = (e) => {
    e.preventDefault();
    if (!label.value.trim()) return toast("Name it first.", true);
    void act(() => run("startups", ["add", label.value.trim(), ...(cmd.value.trim() ? cmd.value.trim().split(/\s+/) : [])], { change: true }), "Added").then(() => read());
  };
  nodes.push(...group("Agents to start",
    ...startups.map((s) => setting(s.label, s.cmd || "PowerShell", iconButton("trash", `Remove ${s.label}`, () => void act(() => run("startups", ["remove", s.label], { change: true }), "Removed").then(() => read())))),
    setting("Add one", "", add, true),
  ));

  const wrapOn = pref("loom-wrap", "1") === "1";
  const phoneToggle = (title: string, detail: string, key: string, on: boolean, yes = "1", no = "") => {
    const s = el("input", "switch");
    s.type = "checkbox";
    s.checked = on;
    s.setAttribute("role", "switch");
    s.setAttribute("aria-label", title);
    s.onchange = () => setPref(key, s.checked ? yes : no);
    return setting(title, detail, s);
  };
  // Each paired phone, this one first, with its own Remove: a phone lost or sold goes, the rest stay paired.
  // An older Loom lists none, only how many.
  const devices = Array.isArray(remote?.devices) ? remote.devices : null;
  const all = setting(devices ? "All phones" : "Paired phones", remote ? `${remote.phones} paired${remote.address ? `, at ${remote.address}` : ""}` : "", button("Unpair all", async () => {
    if (!(await confirmSheet("Unpair every phone?", "This one too: each needs a new code from loomctl remote pair on the PC.", "Unpair all", true))) return;
    // Refused, nothing was unpaired: this phone stays, and so does one you meant to cut off.
    if (await act(() => run("remote", ["revoke"], { change: true }), "Unpaired")) unpaired();
  }, "danger"));
  nodes.push(...group("This phone",
    phoneToggle("Wrap long lines", "In an agent's screen, instead of scrolling sideways", "loom-wrap", wrapOn, "1", "0"),
    phoneToggle("Keyboard open", "Show the PC keys under an agent by default", "loom-keys", pref("loom-keys", "") === "1"),
    ...(devices ? [] : [all]),
  ));
  if (devices) nodes.push(...group("Paired phones", ...[...devices].sort((a, b) => +(b.id === mine) - +(a.id === mine)).map(phoneRow), all));

  if (trash.length) nodes.push(...group("Deleted worktrees", ...trash.map((x) => setting(x.branch?.replace(/^refs\/heads\//, "") ?? x.folder ?? x.at, `In Loom's trash on the PC: ${x.at}`, el("span")))));
  nodes.push(el("p", "hint", "Deleted worktrees stay in Loom's trash on the PC for a day; docs/loomctl.md says how to move one back."));
  body.replaceChildren(...nodes);
}

/** Back to pairing, as a refused token does. */
function unpaired() {
  store("");
  hooks.unpaired();
}

/** A paired phone: its name (a bell when it gets notifications), this one or when it was paired and last seen, Remove. */
function phoneRow(d: Device) {
  const me = d.id === mine, name = d.name || "A phone";
  const seen = d.seen ? age(new Date(d.seen).toISOString()) : "";
  const when = [me && "This phone", d.paired && `Paired ${new Date(d.paired).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`,
    !me && (seen ? (seen === "now" ? "Seen just now" : `Seen ${seen} ago`) : "Never seen")].filter(Boolean).join(" · ");
  const row = setting(name, when, iconButton("trash", `Remove ${name}`, () => void removePhone(d, name, me)));
  row.classList.add("phone");
  const bell = ui("bell");
  bell.removeAttribute("aria-hidden");
  bell.setAttribute("role", "img");
  bell.setAttribute("aria-label", "Notifications on");
  row.querySelector("b")!.replaceChildren(el("span", "", name), ...(d.push ? [bell] : []));
  return row;
}
async function removePhone(d: Device, name: string, me: boolean) {
  const detail = me ? "This phone goes back to pairing: it needs a new code from loomctl remote pair on the PC."
    : "It stops reaching Loom and getting notifications. To come back it needs a new code from loomctl remote pair on the PC.";
  if (!(await confirmSheet(`Remove ${name}?`, detail, "Remove", true))) return;
  if (!(await act(() => run("remote", ["revoke", d.id], { change: true }), "Removed"))) return;
  if (me) unpaired();
  else void read();
}
