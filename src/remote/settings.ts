/** Settings: the PC's Preferences, the agents its + menu offers, the window,
 * and this phone's own choices. Each PC setting is a loomctl command. */
import { act, app, button, closeSheet, confirmSheet, el, hooks, iconButton, pref, run, setPref, sheet, store, toast, topBar } from "./core";

type Theme = { name: string; scheme: string; current: boolean; vars: Record<string, string> };
type Notify = { all: string; kinds: { finish: boolean; fail: boolean; blocked: boolean }; newPanes: string };
type Settings = { sound: string; taskbar: string; overlay: string; awake: string; "plan-usage": string; font: string };
type Startup = { label: string; cmd: string };
type Remote = { phones: number; address: string | null; port: number };
type Trashed = { folder?: string; at: string; branch?: string; commit?: string; when?: string };

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

export async function read() {
  const [t, n, s, st, r, tr] = await Promise.all([
    run<Theme[]>("theme").catch(() => themes),
    run<Notify>("notify").catch(() => notify),
    run<Settings>("set").catch(() => settings),
    run<Startup[]>("startups").catch(() => startups),
    run<Remote>("remote").catch(() => remote),
    run<Trashed[]>("trash").catch(() => trash),
  ]);
  // An older Loom answers a command it lacks with an error: each reading keeps its shape.
  const list = <T>(v: unknown, was: T[]) => (Array.isArray(v) ? (v as T[]) : was);
  [themes, startups, trash] = [list(t, themes), list(st, startups), list(tr, trash)];
  // New Thread and Add Agent offer these: one added here shows there, a removed one goes.
  if (Array.isArray(st)) app.agents = startups.map((x) => x.label);
  [notify, settings, remote] = [n, s, r];
  const cur = themes.find((x) => x.current);
  if (cur) wear(cur);
  draw();
}

/** The phone wears the PC's theme: the same colour names, set on the page. */
export function wear(t: Pick<Theme, "scheme" | "vars">) {
  const root = document.documentElement;
  for (const k of [...root.style]) if (k.startsWith("--")) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(t.vars ?? {})) root.style.setProperty(k, v);
  root.dataset.scheme = t.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.vars?.["--panel"] ?? "#121a2d");
  setPref("loom-theme", JSON.stringify({ scheme: t.scheme, vars: t.vars }));
}

const DEFAULT: Record<string, string> = { "--bg": "#0c1120", "--text": "#e8eaf1", "--accent": "#7ea6ef", "--ok": "#7cc08d", "--warn": "#f2bb44", "--err": "#e5605a" };
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

  if (notify && settings) nodes.push(...group("Notifications",
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
  nodes.push(...group("This phone",
    phoneToggle("Wrap long lines", "In an agent's screen, instead of scrolling sideways", "loom-wrap", wrapOn, "1", "0"),
    phoneToggle("Keyboard open", "Show the PC keys under an agent by default", "loom-keys", pref("loom-keys", "") === "1"),
    setting("Paired phones", remote ? `${remote.phones} paired${remote.address ? `, at ${remote.address}` : ""}` : "", button("Unpair all", async () => {
      if (!(await confirmSheet("Unpair every phone?", "This one too: each needs a new code from loomctl remote pair on the PC.", "Unpair all", true))) return;
      await act(() => run("remote", ["revoke"], { change: true }), "Unpaired");
      store("");
      hooks.unpaired();
    }, "danger")),
  ));

  if (trash.length) nodes.push(...group("Deleted worktrees", ...trash.map((x) => setting(x.branch?.replace(/^refs\/heads\//, "") ?? x.folder ?? x.at, `In Loom's trash on the PC: ${x.at}`, el("span")))));
  nodes.push(el("p", "hint", "Deleted worktrees stay in Loom's trash on the PC for a day; docs/loomctl.md says how to move one back."));
  body.replaceChildren(...nodes);
}
