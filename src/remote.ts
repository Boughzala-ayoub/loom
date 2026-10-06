/** The phone app (remote.html), served by loom.exe (remote.rs): Loom's agents,
 * changes, usage and settings as phone screens, each action a loomctl command
 * posted to /api/cli. See docs/phone-remote-study.md. */
import "./remote.css";
import { $, app, closeSheet, el, hooks, Offline, pref, run, sleep, store, toast, ui, type IconName, type Thread } from "./remote/core";
import { drawHead, drawList, list, newView, openPane, paneView, reread, screen, showList, showNew, showPane } from "./remote/agents";
import { diffView, filesView, read as readChanges, showCommit, showDiff, showFile, showFiles, showSummary, summary } from "./remote/changes";
import { contextView, draw as drawUsage, read as readUsage, showContext, usageView } from "./remote/usage";
import { read as readSettings, settingsView, wear } from "./remote/settings";

// The theme the PC wore last time, before anything is read: no flash of another one.
try { wear(JSON.parse(pref("loom-theme", "null")) ?? { scheme: "dark", vars: {} }); } catch { /* the default palette */ }

type Tab = "agents" | "changes" | "usage" | "settings";
const TABS: [Tab, string, IconName, string][] = [
  ["agents", "Agents", "agents", "#/"],
  ["changes", "Changes", "changes", "#/changes"],
  ["usage", "Usage", "usage", "#/usage"],
  ["settings", "Settings", "settings", "#/settings"],
];
const root = $("#app");
const tabs = $("#tabs");
const badge = el("span", "badge");
badge.hidden = true;
for (const [tab, label, icon, href] of TABS) {
  const a = el("a");
  a.href = href;
  a.dataset.tab = tab;
  a.append(ui(icon), label);
  if (tab === "agents") a.append(badge);
  tabs.append(a);
}
// On a wide screen the detail column waits for a pick.
const placeholder = el("section", "screen detail");
placeholder.append(el("div", "empty"));
const screens = [list, paneView, newView, summary, diffView, filesView, usageView, contextView, settingsView, placeholder];
root.append(...screens);

type View = { tab: Tab; primary: HTMLElement; detail?: HTMLElement; hint?: [string, string]; enter: () => void };
function view(): View {
  const [head = "", a = "", b = "", c = ""] = location.hash.replace(/^#\/?/, "").split("/").map((s) => decodeURIComponent(s));
  switch (head) {
    case "pane": return { tab: "agents", primary: list, detail: paneView, enter: () => { showPane(a); showList(a); } };
    case "new": return { tab: "agents", primary: list, detail: newView, enter: () => { showNew(); showList(null); } };
    case "changes": return { tab: "changes", primary: summary, hint: ["Pick a file", "Its diff shows here, with a button for each hunk."], enter: () => showSummary(a || null) };
    case "diff": return { tab: "changes", primary: summary, detail: diffView, enter: () => { showSummary(a); showDiff(a, b as "staged", c); } };
    case "commit": return { tab: "changes", primary: summary, detail: diffView, enter: () => { showSummary(a); showCommit(a, b); } };
    case "files": return { tab: "changes", primary: summary, detail: filesView, enter: () => { showSummary(a); void showFiles(a); } };
    case "file": return { tab: "changes", primary: summary, detail: diffView, enter: () => { showSummary(a); void showFile(a, b); } };
    case "usage": return { tab: "usage", primary: usageView, enter: () => void readUsage(true) };
    case "context": return { tab: "usage", primary: usageView, detail: contextView, enter: () => { void readUsage(); void showContext(a); } };
    case "settings": return { tab: "settings", primary: settingsView, enter: () => void readSettings() };
    default: return { tab: "agents", primary: list, hint: ["Pick an agent", "Its screen shows here, with the keyboard and its questions."], enter: () => showList(openPane()) };
  }
}

function route() {
  const v = view();
  const detail = v.detail ?? (v.hint ? placeholder : undefined);
  if (v.hint) placeholder.firstElementChild!.replaceChildren(el("b", "", v.hint[0]), v.hint[1]);
  for (const s of screens) s.hidden = s !== v.primary && s !== detail;
  // Phones show one screen: the detail when there is one.
  root.toggleAttribute("data-detail", !!v.detail);
  v.primary.classList.toggle("alone", !detail);
  for (const a of tabs.querySelectorAll<HTMLElement>("a")) {
    if (a.dataset.tab === v.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  closeSheet();
  v.enter();
  if (!v.detail) scrollTo(0, 0);
}

// --- Pairing and the loops -----------------------------------------------------

function pairing() {
  root.hidden = true;
  $("#pairing").hidden = false;
}
hooks.unpaired = pairing;
// After a change: the threads, and whatever screen is up, read again.
hooks.changed = () => setTimeout(() => {
  void refresh().catch(() => {});
  reread();
  void readChanges(true);
}, 300);

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
  app.threads = await run<Thread[]>("threads");
  const waiting = app.threads.flatMap((t) => t.panes).filter((p) => p.state === "waiting").length;
  badge.textContent = String(waiting);
  badge.hidden = !waiting;
  if (!list.hidden) drawList();
  if (!paneView.hidden) drawHead();
  if (!usageView.hidden) drawUsage();
}

/** The threads every 2 s, the open screen every second, git every 6 s: while the page is in view. */
async function loop(every: number, work: () => Promise<unknown>) {
  for (;;) {
    if (app.token && !document.hidden) {
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
  root.hidden = false;
  try {
    const s = await run<{ phone: boolean; agents: string[] }>("status");
    app.phoneSize = s.phone;
    if (s.agents?.length) app.agents = s.agents;
    await refresh();
    void run<{ scheme: string; current: boolean; vars: Record<string, string> }[]>("theme").then((t) => {
      const cur = t.find((x) => x.current);
      if (cur) wear(cur);
    }, () => {});
  } catch (e) {
    if (!app.token) return;
    toast(e instanceof Error ? e.message : String(e), true);
  }
  route();
  if (started) return;
  started = true;
  void loop(2000, refresh);
  // ponytail: rereads the open screen every second (about 1.7 KB gzipped); gate on
  // the pane's lastOutput if mobile data use matters.
  void loop(1000, screen);
  void loop(6000, () => readChanges());
}

window.addEventListener("hashchange", route);
$("#scrim").onclick = () => closeSheet();
$<HTMLFormElement>("#pairing form").onsubmit = pair;
document.addEventListener("visibilitychange", () => { if (!document.hidden && app.token) void refresh().catch(() => {}); });

if (app.token) void start();
else pairing();
