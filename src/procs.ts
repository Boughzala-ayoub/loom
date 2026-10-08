/** The task manager, in the phone's Settings (remote/settings.ts) and the PC's
 * Preferences (main.ts): the PC's CPU, memory and processes, which loom.exe
 * reads from Windows itself (procs.rs), every 2 s while it's open and the page
 * is in view. Read-only: it ends nothing. procs.css lays it out; the phone's
 * sheet and the PC's dialog around it are styled where they live. */
import "./procs.css";

type Proc = { pid: number; name: string; cpu: number; memory: number };
export type Reading = { cpu: number; memory: { used: number; total: number; commit: number; limit: number }; uptime: number; procs: Proc[] };
type Group = { key: string; name: string; procs: Proc[]; cpu: number; memory: number };
type By = "cpu" | "memory";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
const button = (text: string, onclick: () => void, className = "") => Object.assign(el("button", className, text), { type: "button", onclick });

const MB = 2 ** 20;
const bytes = (n: number) => (n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= 10 * MB ? `${Math.round(n / MB)} MB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const pct = (n: number) => `${n.toFixed(1)}%`;
function up(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `Up ${d} day${d === 1 ? "" : "s"} ${h} hr` : h ? `Up ${h} hr ${m} min` : `Up ${m} min`;
}

/** A limit as a bar: white, amber once it nears, red at the end. The phone's Usage draws its limits with it too. */
export function meter(percent: number, severity = "") {
  const m = el("div", `meter ${severity}`);
  const p = Math.max(0, Math.min(100, percent));
  const runEl = el("span", "run");
  runEl.style.width = `${p}%`;
  m.append(runEl);
  m.setAttribute("role", "meter");
  m.setAttribute("aria-valuenow", String(Math.round(p)));
  m.setAttribute("aria-valuemin", "0");
  m.setAttribute("aria-valuemax", "100");
  return m;
}

/** A series against its most, as a line over a shaded area: the PC's CPU here,
 * a session's context after each turn on the phone (compactions are the falls). */
export function spark(series: number[], max: number, label: string) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 100},${40 - (v / max) * 38}`);
  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", `M0,40 L${pts.join(" L")} L100,40 Z`);
  area.setAttribute("fill", "color-mix(in srgb, var(--accent) 18%, transparent)");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, line);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  return svg;
}

/** Processes by name, as Task Manager's Apps view has them: chrome × 34, summed. */
function groups(procs: Proc[], by: By, filter: string) {
  const want = filter.trim().toLowerCase();
  const all = new Map<string, Group>();
  for (const p of procs) {
    const name = p.name.replace(/\.exe$/i, "") || `PID ${p.pid}`;
    const key = name.toLowerCase();
    if (!key.includes(want)) continue;
    let g = all.get(key);
    if (!g) all.set(key, (g = { key, name, procs: [], cpu: 0, memory: 0 }));
    g.procs.push(p);
    g.cpu += p.cpu;
    g.memory += p.memory;
  }
  const order = (a: Proc | Group, b: Proc | Group) => (by === "cpu" ? b.cpu - a.cpu || b.memory - a.memory : b.memory - a.memory || b.cpu - a.cpu);
  const list = [...all.values()].sort((a, b) => order(a, b) || a.name.localeCompare(b.name));
  for (const g of list) g.procs.sort(order);
  return list;
}

let by: By = "cpu"; // kept while the page lasts

/** The task manager's box, and `poll`, which reads every 2 s until `closed` settles. */
export function procsView(read: () => Promise<Reading>) {
  let reading: Reading | null = null, error = "";
  const cpus: number[] = []; // each reading's CPU while this is open: the sparkline
  const open = new Set<string>(); // groups showing their processes
  const rows = new Map<string, HTMLButtonElement>(); // kept across readings, so a tap mid-redraw lands

  const cpuNow = el("b"), memNow = el("b"), memOf = el("span");
  const cpuValue = el("div", "value"), memValue = el("div", "value");
  cpuValue.append(cpuNow);
  memValue.append(memNow, memOf);
  const cpuTile = el("div", "tile"), memTile = el("div", "tile");
  let line: Element = el("i"), bar: Element = meter(0);
  cpuTile.append(el("span", "label", "CPU"), cpuValue, line);
  memTile.append(el("span", "label", "Memory"), memValue, bar);
  const tiles = el("div", "tiles");
  tiles.append(cpuTile, memTile);
  const quiet = el("p", "quiet", "Reading the PC…");
  const filter = el("input");
  Object.assign(filter, { type: "search", placeholder: "Filter", autocapitalize: "off", spellcheck: false });
  filter.setAttribute("aria-label", "Filter processes");
  filter.oninput = () => draw();
  const seg = el("div", "seg");
  const sorts = ([["cpu", "CPU"], ["memory", "Memory"]] as [By, string][]).map(([v, label]) => {
    const b = button(label, () => ((by = v), draw()));
    b.dataset.by = v;
    return b;
  });
  seg.append(...sorts);
  seg.setAttribute("aria-label", "Sort by");
  const tools = el("div", "tools");
  tools.append(filter, seg);
  const list = el("div", "procs");
  const box = el("div", "tasks");
  box.append(tiles, quiet, tools, list);

  function groupRow(g: Group) {
    let b = rows.get(g.key);
    if (!b) {
      b = button("", () => ((open.has(g.key) ? open.delete(g.key) : open.add(g.key)), draw()), "proc");
      rows.set(g.key, b);
    }
    b.replaceChildren(el("span", "name", g.name), el("span", "n", g.procs.length > 1 ? `× ${g.procs.length}` : ""), el("span", "num cpu", pct(g.cpu)), el("span", "num memory", bytes(g.memory)));
    b.setAttribute("aria-expanded", String(open.has(g.key)));
    if (!open.has(g.key)) return [b];
    const pids = el("div", "pids");
    pids.append(...g.procs.map((p) => {
      const r = el("div", "pid");
      r.append(el("span", "name", `PID ${p.pid}`), el("span", "num cpu", pct(p.cpu)), el("span", "num memory", bytes(p.memory)));
      return r;
    }));
    return [b, pids];
  }

  function draw() {
    box.dataset.by = by;
    for (const b of sorts) b.setAttribute("aria-pressed", String(b.dataset.by === by));
    quiet.classList.toggle("error", !!error);
    if (!reading) return void (quiet.textContent = error || "Reading the PC…");
    const { cpu, memory: m, uptime, procs } = reading;
    cpuNow.textContent = `${Math.round(cpu)}%`;
    line.replaceWith((line = spark(cpus.length > 1 ? cpus : [cpu, cpu], 100, `CPU over the last ${cpus.length * 2} seconds`)));
    memNow.textContent = bytes(m.used);
    memOf.textContent = `of ${bytes(m.total)}`;
    const used = (m.used / m.total) * 100;
    // Most PCs sit at 80% and need nothing: amber only once memory runs short.
    bar.replaceWith((bar = meter(used, used >= 97 ? "critical" : used >= 90 ? "warning" : "")));
    quiet.textContent = error || `${procs.length} processes · ${bytes(m.commit)} of ${bytes(m.limit)} committed · ${up(uptime)}`;
    const shown = groups(procs, by, filter.value);
    list.replaceChildren(...(shown.length ? shown.flatMap(groupRow) : [el("p", "hint", `No process matches “${filter.value.trim()}”.`)]));
  }

  /** Reads every 2 s until `closed` settles: none while the page is out of view or `paused()` (Loom restarting). */
  async function poll(closed: Promise<unknown>, paused = () => false) {
    let shut = false;
    void closed.then(() => (shut = true));
    draw();
    while (!shut) {
      const began = performance.now();
      if (!document.hidden && !paused()) {
        try {
          reading = await read();
          error = "";
          cpus.push(reading.cpu);
          if (cpus.length > 60) cpus.shift();
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (shut) return; // closed while Loom answered (the phone's pairing form closes it too)
        draw();
      }
      await Promise.race([closed, new Promise((r) => setTimeout(r, 2000 - (performance.now() - began)))]);
    }
  }
  return { box, poll };
}
