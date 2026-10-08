/** What every screen of the phone app shares: loomctl over /api/cli, the
 * threads it last read, navigation, sheets, toasts and small DOM helpers.
 * The app keeps nothing of Loom's own: every action is a loomctl command, so
 * it happens on the PC through the functions its buttons call. */
import { icon as agentIcon } from "../icons";
import type { Agent } from "../agent";

export type Pane = {
  id: string; ref: string; threadId: string; agent: Agent; title: string; state: string; lastOutput: string | null;
  stableId?: string; // the same pane's id after Loom restarts, when `id` is new (older Looms: none)
  model: string | null; effort: string | null; notify: string;
  context: { usedTokens: number; windowTokens: number; remainingPercent: number } | null;
};
export type Thread = {
  id: string; name: string; repo: string; dir: string; branch: string; state: string; zoomed: string | null; layout: string; front?: boolean;
  changed?: { add: number; del: number; files: number }; panes: Pane[];
};

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { agentIcon };

/** What the app last read of Loom, and this phone's own choices. */
export const app = {
  token: pref("loom-token", ""),
  threads: [] as Thread[],
  agents: ["claude", "codex", "opencode"],
  phoneSize: false,
  restarting: false, // Loom is restarting on the PC: the loops wait, the page reloads when it's back
  visit: 0, // counts route()s: work a screen began acts only while the same visit to it lasts
};
export const panes = () => app.threads.flatMap((t) => t.panes);
export const findPane = (id: string | null) => panes().find((p) => p.id === id);
export const findThread = (id: string | null) => app.threads.find((t) => t.id === id);
export const threadOf = (p: Pane) => findThread(p.threadId);
export const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function pref(name: string, fallback: string) {
  try { return localStorage.getItem(name) ?? fallback; } catch { return fallback; }
}
// A private window may refuse: the phone then forgets when the tab closes.
export function setPref(name: string, value: string) {
  try { if (value) localStorage.setItem(name, value); else localStorage.removeItem(name); } catch { /* see above */ }
}

export class Offline extends Error {}
/** Set by the entry: what a refused token does (back to pairing). */
export const hooks = { unpaired: () => {}, changed: () => {} };

/** One loomctl command. A change carries a key, so the retry after a dropped
 * connection gets the first run's answer instead of running it again. Each
 * waits as long as Loom would, then gives up: a reply lost on the way (the phone
 * changed networks) must not hold up the screen and every key after it. `path`
 * asks remote.rs itself instead of loomctl: /api/procs, the task manager's reading. */
export async function run<T>(cmd: string, argv: string[] = [], opts: { stdin?: string; change?: boolean; timeout?: number; path?: string } = {}): Promise<T> {
  const key = opts.change ? `phone-${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}` : null;
  const timeout = opts.timeout ?? 30;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined, reply: { ok?: boolean; error?: string; data?: unknown } | null = null;
    try {
      res = await fetch(opts.path ?? "/api/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.token}` },
        body: JSON.stringify({ cmd, argv, stdin: opts.stdin ?? null, key, timeout }),
        // Loom answers within its timeout plus 5 s (control.rs ask); then a little more for the trip.
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      });
      reply = await res.json();
    } catch { /* below */ }
    // No answer, or one cut off after the change ran: asked again with its key, it answers as the first run did.
    if (!reply && key && attempt < 3) { await sleep(1500); continue; }
    if (!res) throw new Offline("Can't reach Loom. Is the PC on, and Tailscale connected on both?");
    // Not JSON: tailscale serve answering for a Loom that isn't running, or has the remote off.
    if (!reply) throw new Offline(`Loom isn't answering (${res.status}). Is it running, with the remote on?`);
    if (res.status === 401) {
      store("");
      hooks.unpaired();
    }
    if (!app.restarting) $("#offline").hidden = true; // a restart keeps its own banner up
    if (!reply.ok) throw new Error(reply.error ?? "Loom refused that.");
    return reply.data as T;
  }
}

export function store(t: string) {
  app.token = t;
  setPref("loom-token", t);
}

/** Runs an action and says how it went; the screens read again after it. */
export async function act(work: () => Promise<unknown>, done = "") {
  try {
    await work();
    if (done) toast(done);
    tick();
    hooks.changed();
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
    return false;
  }
}

/** A short buzz where the phone has one: an action went through. */
export const tick = () => navigator.vibrate?.(8);

let toastTimer = 0;
export function toast(text: string, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 7000 : 2500);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
export function button(text: string | Node, onclick: () => void, className = "") {
  const b = el("button", className);
  b.type = "button";
  b.append(text);
  b.onclick = onclick;
  return b;
}
export function iconButton(name: IconName, label: string, onclick: () => void) {
  const b = button(ui(name), onclick, "icon-btn");
  b.setAttribute("aria-label", label);
  return b;
}

// --- Navigation -------------------------------------------------------------

let pushed = false; // this page put the current view in the history, so Back can pop it
export function go(hash: string) {
  pushed = true;
  location.hash = hash;
}
export function back(fallback = "#/") {
  if (!pushed) return location.replace(fallback);
  pushed = false;
  history.back();
}
export function replace(hash: string) {
  pushed = false;
  location.replace(hash);
}
/** A screen's top bar: back (phones), a title or who, and actions. */
export function topBar(title: string | Node, actions: Node[] = [], backTo = "") {
  const bar = el("header", backTo ? "top back-top" : "top");
  if (backTo) {
    const b = iconButton("back", "Back", () => back(backTo));
    b.classList.add("back");
    bar.append(b);
  }
  if (typeof title === "string") bar.append(el("h1", "", title));
  else bar.append(title);
  bar.append(...actions);
  return bar;
}

// --- Sheets -----------------------------------------------------------------

let sheetDone: ((v: unknown) => void) | null = null;
/** A sheet over the screen, from the bottom. Resolves with what was picked, or null. */
export function sheet<T = unknown>(items: (Node | string)[], title = "", close = "Cancel"): Promise<T | null> {
  closeSheet();
  const box = $("#sheet");
  box.replaceChildren(...(title ? [el("h2", "", title)] : []), ...items, button(close, () => closeSheet(), "ghost"));
  box.hidden = $("#scrim").hidden = false;
  requestAnimationFrame(() => { box.classList.add("on"); $("#scrim").classList.add("on"); });
  return new Promise((resolve) => (sheetDone = resolve as (v: unknown) => void));
}
export function closeSheet(value: unknown = null) {
  const box = $("#sheet");
  box.className = ""; // "on", and a sheet's own look (the task manager's)
  $("#scrim").classList.remove("on");
  box.hidden = $("#scrim").hidden = true;
  const done = sheetDone;
  sheetDone = null;
  done?.(value);
}
/** A sheet row: closes the sheet, then acts and says how it went. */
export function item(text: string, work: () => Promise<unknown> | unknown, done = "", opts: { icon?: IconName; danger?: boolean; ask?: [string, string, string] } = {}) {
  const b = button(text, () => {
    closeSheet();
    void (async () => {
      if (opts.ask && !(await confirmSheet(...opts.ask, opts.danger))) return;
      await act(async () => work(), done);
    })();
  }, `item${opts.danger ? " danger" : ""}`);
  if (opts.icon) b.prepend(ui(opts.icon));
  return b;
}
/** Asks before something that can't be taken back. */
export async function confirmSheet(title: string, detail: string, action: string, danger = false) {
  const ok = button(action, () => closeSheet(true), danger ? "danger" : "primary");
  return (await sheet<boolean>([...(detail ? [el("p", "", detail)] : []), ok], title)) === true;
}
/** A line of text from a sheet: a name, a branch, a message. */
export async function promptSheet(title: string, value = "", placeholder = "", action = "Save") {
  const input = el("input");
  Object.assign(input, { value, placeholder, autocapitalize: "off", spellcheck: false });
  input.setAttribute("aria-label", title);
  const form = el("form", "pair");
  const ok = el("button", "primary", action);
  form.append(input, ok);
  form.onsubmit = (e) => { e.preventDefault(); closeSheet(input.value.trim()); };
  setTimeout(() => input.focus(), 250);
  const got = await sheet<string>([form], title);
  return got || null;
}

// --- Small things -----------------------------------------------------------

export function age(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 10 ? "now" : s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** Sends in order, one request at a time; what piles up meanwhile goes in the next. */
export function sequence<T>(send: (items: T[]) => Promise<unknown>) {
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

/** Gives `parent` the children `next`, one of which is its child `keep`, never taken out: a text box in
 * it keeps the focus and the word a phone keyboard is still composing, which a rebuilt box would
 * get a second time. */
export function replaceAround(parent: Element, next: Node[], keep: Element) {
  for (const n of [...parent.childNodes]) if (n !== keep) n.remove();
  const at = next.indexOf(keep);
  keep.before(...next.slice(0, at));
  keep.after(...next.slice(at + 1));
}

/** +12 −3, or nothing for no change. */
export function stat(s: { add: number; del: number } | undefined) {
  const span = el("span", "stat");
  if (s && (s.add || s.del)) span.append(el("span", "add", `+${s.add}`), el("span", "del", `−${s.del}`));
  return span;
}

// --- Icons: 24 px strokes, drawn for this app -------------------------------

const PATHS = {
  // Stacked panes: several agents, one prompt.
  agents: "M6 8h7a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3ZM8 4h10a3 3 0 0 1 3 3v8M6.5 12l2 2-2 2",
  changes: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM12 8.5v6M9 11.5h6M9 17.5h6",
  usage: "M4 18a8 8 0 1 1 16 0M12 18l4-6",
  settings: "M4 7h9M19 7h1M4 17h1M11 17h9M18.5 7a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0ZM10.5 17a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z",
  send: "M12 19V5M6 11l6-6 6 6",
  mic: "M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
  check: "M5 12.5l4.5 4.5L19 7.5",
  enter: "M19 5v6a3 3 0 0 1-3 3H6M10 10l-4 4 4 4",
  pen: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.4 3.6a2 2 0 0 1 2.8 2.8L13 14.6l-3.6.8.8-3.6z",
  back: "M15 5l-7 7 7 7",
  more: "M5 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4ZM12 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4ZM19 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4Z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14a7 7 0 0 0 0 14ZM20 20l-4-4",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  branch: "M7 4v16M17 8a3 3 0 1 0 0-.01M17 11c0 4-6 3-10 7",
  push: "M12 19V6M6 11l6-6 6 6M5 21h14",
  pull: "M12 5v13M6 13l6 6 6-6M5 3h14",
  pr: "M7 4v16M7 4a2 2 0 1 0 0 .01M17 20a2 2 0 1 0 0 .01M17 18V9a3 3 0 0 0-3-3h-4M12 3l-2 3 2 3",
  stash: "M4 8h16v11H4zM4 8l2-4h12l2 4M9 12h6",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  stop: "M6 6h12v12H6z",
  restart: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
  close: "M6 6l12 12M18 6L6 18",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6Z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20h4",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
  rename: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  history: "M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v4h4",
  wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M15 16l-2 2 2 2M4 18h6",
  phone: "M8 3h8v18H8zM11 18h2",
  window: "M3 5h18v14H3zM3 9h18",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  fold: "M6 9l6 6 6-6",
  play: "M8 5l11 7-11 7z",
} as const;
export type IconName = keyof typeof PATHS;
export function ui(name: IconName) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

/** Loom's logo (src/logo.svg, which the PC wears too): a prompt and a cursor on a tile. */
export function logo() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("class", "logo");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<rect x="1" y="1" width="30" height="30" rx="8" fill="#0e1626" stroke="#2a3c5c" stroke-width="1.5"/>'
    + '<path d="M8.5 11 L14.5 16 L8.5 21" fill="none" stroke="#d97757" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<rect x="18.5" y="11.5" width="4.5" height="9" rx="1" fill="#d97757"/>';
  return svg;
}
