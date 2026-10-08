/** The task manager, from Settings: the PC's CPU, memory and processes, which
 * loom.exe reads from Windows itself (procs.rs), every 2 s while this is open
 * and the page is in view. Read-only: it ends nothing. */
import { $, app, button, el, run, sheet, sleep } from "./core";
import { meter, spark } from "./usage";

type Proc = { pid: number; name: string; cpu: number; memory: number };
type Reading = { cpu: number; memory: { used: number; total: number; commit: number; limit: number }; uptime: number; procs: Proc[] };
type Group = { key: string; name: string; procs: Proc[]; cpu: number; memory: number };
type By = "cpu" | "memory";

const MB = 2 ** 20;
const bytes = (n: number) => (n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB` : n >= 10 * MB ? `${Math.round(n / MB)} MB` : n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const pct = (n: number) => `${n.toFixed(1)}%`;
function up(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `Up ${d} day${d === 1 ? "" : "s"} ${h} hr` : h ? `Up ${h} hr ${m} min` : `Up ${m} min`;
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

export async function openTasks() {
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

  let shut = false;
  const closed = sheet([box], "Task manager", "Close").then(() => void (shut = true));
  $("#sheet").classList.add("tasks-sheet");
  draw();
  while (!shut) {
    const began = performance.now();
    // As the app's other loops: nothing while the page is out of view, or Loom restarts.
    if (!document.hidden && !app.restarting) {
      try {
        reading = await run<Reading>("procs", [], { path: "/api/procs", timeout: 10 });
        error = "";
        cpus.push(reading.cpu);
        if (cpus.length > 60) cpus.shift();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (shut) return; // closed while Loom answered, or unpaired (pairing closes sheets): the sheet up now is another's
      draw();
    }
    await Promise.race([closed, sleep(2000 - (performance.now() - began))]);
  }
}
