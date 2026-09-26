/** The overlay window: the agents waiting on you, then the ones working, in a
 * small always-on-top list. main.ts decides when it shows and sends the rows
 * ready to draw; a click goes back to it as an event. Its height follows the
 * list up to a cap; dragging the height sets the cap, dragging the width is
 * yours to keep. */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { icon } from "./icons";
import type { Agent } from "./agent";

/** `ask`: for a waiting agent with a menu on screen, what it asks. */
export type OverlayRow = { id: string; name: string; agent: Agent; waiting: boolean; time: string; ask: string };
export type OverlayState = { rows: OverlayRow[]; cap: number; vars: Record<string, string>; scheme: string };

const MIN = 110; // the window's min_inner_size in lib.rs
const header = document.querySelector("header")!;
const rail = document.getElementById("rail")!;

function el(tag: string, className: string, text = "") {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function section(className: string, title: string, rows: OverlayRow[]) {
  const heading = el("h2", className, title);
  heading.append(el("span", "", String(rows.length)));
  return [heading, ...rows.map(r => {
    const b = el("button", `row ${className}`);
    b.title = `${r.waiting ? "Waiting" : "Working"} ${r.time}: ${r.name} (${r.agent})${r.ask ? `\n${r.ask}` : ""}\nClick to preview it in Loom.`;
    b.append(el("span", "knot"), icon(r.agent), el("span", "name", r.name), el("span", "time", r.time));
    if (r.ask) b.append(el("span", "ask", r.ask));
    b.onclick = () => void emit("overlay-pick", r.id);
    return b;
  })];
}

let cap = 420;
let fitted = 0; // the height this page last asked for, to tell its own resizes from yours
function fit() {
  const want = Math.max(MIN, Math.min(cap, Math.ceil(header.getBoundingClientRect().height + rail.getBoundingClientRect().height + 2)));
  if (Math.abs(want - innerHeight) < 1) return;
  fitted = want;
  void getCurrentWindow().setSize(new LogicalSize(innerWidth, want));
}

// A height you dragged to becomes the cap once you let go (no resize for a moment).
let settle = 0;
addEventListener("resize", () => {
  if (!fitted || Math.abs(innerHeight - fitted) <= 2) return;
  clearTimeout(settle);
  settle = window.setTimeout(() => {
    cap = Math.max(MIN, innerHeight);
    void emit("overlay-cap", cap);
    fit();
  }, 400);
});

function render({ rows, cap: c, vars, scheme }: OverlayState) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = scheme;
  cap = c;
  const waiting = rows.filter(r => r.waiting);
  const working = rows.filter(r => !r.waiting);
  rail.replaceChildren(
    ...(waiting.length ? section("waiting", "Waiting", waiting) : []),
    ...(working.length ? section("busy", "Working", working) : []),
  );
  if (!rows.length) rail.append(el("p", "empty", "No agents are working or waiting."));
  fit();
}

document.getElementById("open")!.onclick = () => void emit("overlay-open");
document.getElementById("hide")!.onclick = () => void emit("overlay-dismiss");
void listen<OverlayState>("overlay-rows", e => render(e.payload)).then(() => emit("overlay-ready"));
