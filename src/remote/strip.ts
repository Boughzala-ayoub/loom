/** The strip that floats above the tabs: the servers the PC's panes run, and
 * its CPU and RAM. The PC status bar's reading (main.ts paintStatus), read
 * through remote.rs's /api/bar every 3 s while the page is in view. */
import { button, closeSheet, el, findPane, go, run, sheet, threadOf } from "./core";
import { openTasks } from "./settings";

type Reading = { cpu: number; memory: { used: number; total: number }; servers: { port: number; pane: string; name: string }[] };
type Server = Reading["servers"][number];

export const strip = el("div");
strip.id = "strip";
strip.hidden = true; // until the first reading
const cap = el("div", "ss-cap");
// The list fades out behind the strip rather than showing a cut line in the gap under it.
export const stripFade = el("div");
stripFade.id = "strip-fade";
stripFade.hidden = true;
strip.append(cap);

let last: Reading | null = null;
let sig = "";

export async function readStrip() {
  last = await run<Reading>("bar", [], { path: "/api/bar", timeout: 5 });
  paint();
}

/** Redrawn only when what it shows changes: a tap mid-press must not lose its button. */
function paint() {
  if (!last?.memory) return;
  // A server whose pane the phone hasn't read yet (or that just closed) waits for the next reading.
  const servers = last.servers.filter((s) => findPane(s.pane));
  const cpu = Math.round(last.cpu);
  const ram = Math.round((last.memory.used / last.memory.total) * 100);
  const now = JSON.stringify([servers.map((s) => [s.port, s.pane, s.name, where(s)]), cpu, ram]);
  strip.hidden = stripFade.hidden = false;
  if (now === sig) return;
  sig = now;
  const parts: Node[] = [];
  const [first] = servers;
  if (first) {
    const b = button(dot(), () => openServer(first), "ss-server");
    b.append(el("span", "ss-name", first.name || "port"), el("span", "ss-port", `:${first.port}`));
    b.setAttribute("aria-label", `${label(first)}. Open its pane.`);
    parts.push(b);
    if (servers.length > 1) {
      const more = button(el("span", "ss-count", `+${servers.length - 1}`), () => list(servers), "ss-more");
      more.setAttribute("aria-label", `All ${servers.length} servers`);
      parts.push(more);
    }
    parts.push(el("span", "ss-sep"));
  } else {
    const none = el("span", "ss-none", "No servers");
    none.prepend(dot());
    parts.push(none);
  }
  const pc = button(meter("CPU", cpu), () => void openTasks(), "ss-pc");
  pc.append(meter("RAM", ram));
  pc.setAttribute("aria-label", `CPU ${cpu}%, RAM ${ram}%. Open the task manager.`);
  parts.push(pc);
  cap.replaceChildren(...parts);
}

const dot = () => el("span", "ss-dot");

function meter(name: string, percent: number) {
  const m = el("span", "ss-meter");
  const top = el("span", "ss-top");
  top.append(el("span", "ss-label", name), el("span", "ss-val", `${percent}%`));
  const fill = el("span", "ss-fill");
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  const track = el("span", "ss-track");
  track.append(fill);
  m.append(top, track);
  return m;
}

/** "website · pane 2": the thread, and the pane's number in it (its ref, Name:N). */
function where(s: Server) {
  const p = findPane(s.pane);
  const t = p && threadOf(p);
  return t && p ? `${t.name} · pane ${p.ref.split(":").pop()}` : "";
}
const label = (s: Server) => `${s.name || "A server"} on port ${s.port}, in ${where(s) || "a pane"}`;

function openServer(s: Server) {
  closeSheet();
  if (findPane(s.pane)) go(`#/pane/${encodeURIComponent(s.pane)}`);
}

function list(servers: Server[]) {
  const rows = servers.map((s) => {
    const text = el("span");
    text.append(el("b", "", s.name || "port"), el("small", "", where(s)));
    const b = button(dot(), () => openServer(s), "ss-row");
    b.append(text, el("span", "ss-port", `:${s.port}`));
    b.setAttribute("aria-label", `${label(s)}. Open its pane.`);
    return b;
  });
  const box = el("div", "ss-rows");
  box.append(...rows);
  void sheet([el("p", "", "Tap one to open the pane that runs it."), box], "Servers on the PC", "Close");
}
