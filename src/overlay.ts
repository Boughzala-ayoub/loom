/** The overlay window: the agents waiting on you, then the ones working, in a
 * small always-on-top list. main.ts decides when it shows and sends the rows
 * ready to draw; a click goes back to it as an event. Its height follows the
 * list down to the bottom of the screen it's on, where the list scrolls;
 * dragging the width is yours to keep. */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { icon, type Mark } from "./icons";

/** `ask`: for a waiting agent with a menu on screen, what it asks. */
export type OverlayRow = { id: string; name: string; agent: Mark; waiting: boolean; time: string; ask: string };
export type OverlayState = { rows: OverlayRow[]; vars: Record<string, string>; scheme: string };

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

async function fit() {
  // screenY is the top of the page, so this is the room left below it on its screen.
  // availTop is Chromium's, missing from TypeScript's Screen.
  const room = (screen as Screen & { availTop: number }).availTop + screen.availHeight - screenY;
  const want = Math.max(MIN, Math.min(room, Math.ceil(header.getBoundingClientRect().height + rail.getBoundingClientRect().height + 2)));
  const win = getCurrentWindow();
  // With less room than the minimum, it moves up by what would hang below the screen. Moved
  // in physical pixels: within one screen a CSS pixel is devicePixelRatio of them, whatever
  // the screen's offset, where Chromium's and Tauri's logical coordinates can disagree.
  if (want > room) {
    const at = await win.outerPosition();
    await win.setPosition(new PhysicalPosition(at.x, at.y - Math.ceil((want - room) * devicePixelRatio)));
  }
  if (Math.abs(want - innerHeight) < 1) return;
  void win.setSize(new LogicalSize(innerWidth, want));
}

// A height you dragged to, or a move that changes the room below, fits again once you let go.
let settle = 0;
const refit = () => {
  clearTimeout(settle);
  settle = window.setTimeout(fit, 400);
};
addEventListener("resize", refit);
void getCurrentWindow().onMoved(refit);

function render({ rows, vars, scheme }: OverlayState) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = scheme;
  const waiting = rows.filter(r => r.waiting);
  const working = rows.filter(r => !r.waiting);
  rail.replaceChildren(
    ...(waiting.length ? section("waiting", "Waiting", waiting) : []),
    ...(working.length ? section("busy", "Working", working) : []),
  );
  if (!rows.length) rail.append(el("p", "empty", "No agents are working or waiting."));
  void fit();
}

document.getElementById("open")!.onclick = () => void emit("overlay-open");
document.getElementById("hide")!.onclick = () => void emit("overlay-dismiss");
void listen<OverlayState>("overlay-rows", e => render(e.payload)).then(() => emit("overlay-ready"));
