/** Agents: the threads as the PC's sidebar draws them, what every agent last
 * heard and said, one agent's screen, and starting threads. */
import {
  act, age, agentIcon, app, back, base, button, closeSheet, confirmSheet, el, findPane, findThread, go, iconButton,
  item, logo, panes, pref, promptSheet, replace, replaceAround, run, sequence, setPref, sheet, stat, threadOf, tick, toast, topBar, ui,
  type Pane, type Thread,
} from "./core";
import { keyboard, type Typed } from "./keyboard";
import { dictationSheet, lists, pickLabel, readLists, bar as recBar, record, repaint, transcribing } from "./dictate";

type Run = { x: number; text: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; fg?: number | string; bg?: number | string };
type Screen = { text: string; cols: number; alt?: boolean; rows: { runs: Run[] }[] };
type Menu = { question: string[]; options: string[]; keys?: string[]; rev: string };
type Said = { user: string; agent: string };

const ORDER = ["waiting", "working", "starting", "idle", "exited"];
const rank = (p: Pane) => ORDER.indexOf(p.state) >>> 0;

// --- The list ---------------------------------------------------------------

let view = pref("loom-list", "threads"); // "threads", as on the PC, or "activity"
const folded = new Set(pref("loom-folded", "").split("\n").filter(Boolean)); // thread ids and "repo:<path>"
let query = "";
const said = new Map<string, Said>();
const asks = new Map<string, Menu | null>();
let saidAt = 0;
let listKey = "";
let held = false; // a card kept as it was while its reply is typed: redrawn once you leave its box
// The agent the list highlights, apart from the agent on show (`open`): New thread unlights the list, while the
// agent screen keeps its agent and that agent's draft. Shared, the draft went to the next agent opened.
let lit: string | null = null;

export const list = el("section", "screen primary");
list.id = "list";
const rows = el("div", "rows");
const findBox = el("input");
Object.assign(findBox, { type: "search", placeholder: "Find an agent or thread", autocapitalize: "off", spellcheck: false });
findBox.setAttribute("aria-label", "Find an agent or thread");
findBox.oninput = () => { query = findBox.value.trim().toLowerCase(); drawList(); };
const views = el("div", "seg");
for (const [v, label] of [["threads", "Threads"], ["activity", "Activity"]]) {
  const b = button(label, () => { view = v; setPref("loom-list", v); drawList(); if (v === "activity") void readSaid(true); });
  b.dataset.view = v;
  views.append(b);
}
{
  const find = el("label", "find");
  find.append(ui("search"), findBox);
  const body = el("div", "body");
  body.append(find, views, rows);
  const brand = el("h1", "brand");
  brand.append(logo(), "Loom");
  // New thread floats over the list, bottom right.
  const add = button(ui("pen"), () => go("#/new"), "fab");
  add.append("New thread");
  add.setAttribute("aria-label", "New thread"); // scripts/remote-check.mjs finds it by this
  list.append(topBar(brand), body, add);
}

export function showList(current: string | null) {
  lit = current;
  listKey = "";
  drawList();
}

function matches(t: Thread, p?: Pane) {
  if (!query) return true;
  const words = [t.name, t.branch, base(t.repo), ...(p ? [p.agent, p.title, p.ref] : [])].join(" ").toLowerCase();
  return words.includes(query);
}

export function drawList() {
  const all = panes();
  const waiting = all.filter((p) => p.state === "waiting");
  // Rebuilt only when something besides the ages changed, so a tap never lands on a row being replaced.
  const key = JSON.stringify([lit, view, query, [...folded], app.threads.map((t) => [t.id, t.name, t.branch, t.state, t.changed, t.panes.map((p) => [p.id, p.state, p.title, p.agent])]), view === "activity" ? [...said, ...asks] : 0]);
  const typing = document.activeElement instanceof HTMLInputElement && rows.contains(document.activeElement) ? document.activeElement : null;
  if (key !== listKey || (held && !typing)) {
    listKey = key;
    for (const b of views.querySelectorAll<HTMLElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    const banner = waiting.length ? [waitingBanner(waiting)] : [];
    const next = !app.threads.length ? [empty("No threads yet", "Start one with New thread, below.")] : [...banner, ...(view === "activity" ? activity() : byThread())];
    // The card whose reply is being typed stays as it was, its box never rebuilt, until you leave the box.
    const card = typing?.closest<HTMLElement>(".card");
    const at = card ? next.findIndex((n) => n instanceof HTMLElement && n.matches(".card") && n.dataset.pane === card.dataset.pane) : -1;
    held = at >= 0;
    if (held) (next[at] = card!), replaceAround(rows, next, card!);
    else rows.replaceChildren(...next);
  }
  const latest = (id: string) => findThread(id)?.panes.map((p) => p.lastOutput ?? "").sort().pop() || null;
  for (const a of rows.querySelectorAll<HTMLElement>(".when")) {
    const when = age(a.dataset.thread ? latest(a.dataset.thread) : findPane(a.dataset.pane!)?.lastOutput ?? null);
    if (a.textContent !== when) a.textContent = when;
  }
  if (view === "activity") void readSaid();
}

function empty(title: string, text: string) {
  const box = el("div", "empty");
  box.append(el("b", "", title), text);
  return box;
}

function waitingBanner(waiting: Pane[]) {
  const first = [...waiting].sort((a, b) => (a.lastOutput ?? "").localeCompare(b.lastOutput ?? ""))[0];
  const b = button("", () => go(`#/pane/${encodeURIComponent(first.id)}`), "waiting-banner");
  const text = el("span", "text");
  text.append(waiting.length === 1 ? "1 agent is waiting on you" : `${waiting.length} agents are waiting on you`, el("small", "", `${first.ref}: ${first.title || first.agent}`));
  b.append(el("span", "dot"), text, el("span", "chip waiting", "Open"));
  return b;
}

function fold(key: string) {
  if (!folded.delete(key)) folded.add(key);
  setPref("loom-folded", [...folded].join("\n"));
  tick();
  drawList();
}

function byThread() {
  const shown = app.threads.filter((t) => matches(t) || t.panes.some((p) => matches(t, p)));
  if (!shown.length) return [empty("Nothing matches", `No agent or thread has "${query}" in it.`)];
  return [...new Set(shown.map((t) => t.repo))].map((repo) => {
    const group = shown.filter((t) => t.repo === repo);
    const key = `repo:${repo}`;
    const shut = folded.has(key) && !query;
    const head = button("", () => fold(key), "project-head");
    head.setAttribute("aria-expanded", String(!shut));
    const chevron = el("span", "fold");
    chevron.append(ui("fold"));
    head.append(chevron, el("span", "grow", base(repo)), el("span", "n", group.length === 1 ? "1 thread" : `${group.length} threads`));
    const box = el("div", "project");
    box.append(head);
    if (!shut) {
      const warp = el("div", "warp");
      warp.append(...group.map(threadBlock));
      box.append(warp);
    }
    return box;
  });
}

function threadBlock(t: Thread) {
  const shut = folded.has(t.id) && !query;
  const head = button("", () => fold(t.id), "thread-head");
  head.setAttribute("aria-expanded", String(!shut));
  // Line two, as the PC's sidebar has it: a folded thread's agents, its branch, then what changed and when.
  const sub = el("span", "sub");
  if (shut) {
    const pips = el("span", "pips");
    pips.append(...[...t.panes].sort((a, b) => rank(a) - rank(b)).slice(0, 4).map((p) => {
      const pip = el("span", `pip ${p.state}`);
      pip.append(agentIcon(p.agent));
      return pip;
    }));
    if (t.panes.length > 4) pips.append(el("span", "", `+${t.panes.length - 4}`));
    sub.append(pips);
  }
  sub.append(el("span", "branch", t.branch || base(t.dir)));
  if (t.changed?.files) sub.append(stat(t.changed));
  const when = el("span", "when");
  when.dataset.thread = t.id;
  sub.append(when);
  head.append(el("span", "name", t.name), sub);
  const top = el("div", "thread-top");
  const more = iconButton("more", `${t.name}: actions`, () => threadActions(t));
  top.append(head, more);
  const box = el("div", `thread ${t.state}`);
  box.dataset.id = t.id;
  box.append(top);
  if (!shut) {
    const agents = el("div", "agents");
    const shown = t.panes.filter((p) => !query || matches(t) || matches(t, p));
    agents.append(...(shown.length ? shown.map(agentRow) : [el("p", "none-here", "No agents. Add one from ⋯.")]));
    box.append(agents);
  }
  return box;
}

function agentRow(p: Pane) {
  const row = button("", () => go(`#/pane/${encodeURIComponent(p.id)}`), `agent ${p.state}`);
  row.dataset.id = p.id;
  row.setAttribute("aria-current", String(p.id === lit));
  const line1 = el("span", "line1");
  line1.append(el("span", "", p.agent));
  if (p.state !== "idle") line1.append(el("span", `chip ${p.state}`, p.state));
  const when = el("span", "when");
  when.dataset.pane = p.id;
  row.append(agentIcon(p.agent), line1, when, el("span", "line2", p.title || " "));
  return row;
}

// --- Activity: the PC's Overview ---------------------------------------------

async function readSaid(now = false) {
  if (!now && Date.now() - saidAt < 5000) return;
  saidAt = Date.now();
  const got = await run<{ pane: string; user: string; agent: string }[]>("messages").catch(() => []);
  for (const m of Array.isArray(got) ? got : []) if (m.user || m.agent) said.set(m.pane, { user: m.user, agent: m.agent });
  await Promise.all(panes().filter((p) => p.state === "waiting").map(async (p) => asks.set(p.id, await run<Menu | null>("menu", [p.id]).catch(() => null))));
  for (const id of [...asks.keys()]) if (findPane(id)?.state !== "waiting") asks.delete(id);
  drawList();
}

function activity() {
  const shown = panes().filter((p) => matches(threadOf(p)!, p)).sort((a, b) => rank(a) - rank(b) || (a.state === "waiting" ? (a.lastOutput ?? "").localeCompare(b.lastOutput ?? "") : (b.lastOutput ?? "").localeCompare(a.lastOutput ?? "")));
  if (!shown.length) return [empty("Nothing matches", `No agent has "${query}" in it.`)];
  return shown.map((p) => {
    const t = threadOf(p)!;
    const card = el("article", `card ${p.state}`);
    card.dataset.pane = p.id;
    const head = button("", () => go(`#/pane/${encodeURIComponent(p.id)}`), "card-head");
    const who = el("span", "who");
    who.append(el("b", "", `${t.name} / ${p.agent}`), el("span", "", p.title || t.branch));
    const when = el("span", "when");
    when.dataset.pane = p.id;
    head.append(agentIcon(p.agent), who, ...(p.state !== "idle" ? [el("span", `chip ${p.state}`, p.state)] : []), when);
    card.append(head);
    const s = said.get(p.id);
    if (s?.user) card.append(quote("You", s.user, "said you"));
    if (s?.agent) card.append(quote(p.agent === "codex" ? "Codex" : p.agent === "claude" ? "Claude" : "Agent", s.agent, "said"));
    const ask = asks.get(p.id);
    if (p.state === "waiting" && ask) card.append(choices(p, ask));
    else if (p.state === "waiting" || (p.state === "idle" && p.agent !== "shell")) card.append(replyBox(p));
    return card;
  });
}

function quote(who: string, text: string, className: string) {
  const q = el("p", className);
  q.append(el("b", "", `${who}: `), text);
  return q;
}

function choices(p: Pane, m: Menu) {
  const box = el("div", "choices");
  box.append(el("p", "ask", m.question.join("\n").trim()), ...m.options.map((o, i) => {
    const n = m.keys?.[i] ?? String(i + 1);
    return button(`${n}. ${o}`, () => void act(() => run("choose", [p.id, n, "--menu", m.rev], { change: true }), "Answered"));
  }));
  return box;
}

const drafts = new Map<string, string>(); // each Activity reply's unsent text: the cards are rebuilt as agents change
const replying = new Set<string>(); // panes whose reply is on its way: a second tap, or Enter, sends nothing
const replyInput = (pane?: string) => [...rows.querySelectorAll<HTMLInputElement>(".reply input")].find((i) => i.dataset.pane === pane);

function replyBox(p: Pane) {
  const form = el("form", "reply");
  const input = el("input");
  Object.assign(input, { placeholder: `Reply to ${p.agent}`, enterKeyHint: "send", value: drafts.get(p.id) ?? "" });
  input.dataset.pane = p.id;
  input.setAttribute("aria-label", `Reply to ${p.ref}`);
  input.oninput = () => drafts.set(p.id, input.value);
  const send = el("button", "primary", "Send");
  send.disabled = replying.has(p.id);
  form.append(input, send);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || replying.has(p.id)) return;
    replying.add(p.id);
    send.disabled = true;
    void act(async () => {
      await run(p.agent === "shell" ? "send" : "submit", [p.id, "-"], { stdin: text, change: true, timeout: 60 });
      // Only the reply that went: one typed while it was on its way stays a draft.
      if ((drafts.get(p.id) ?? "").trim() !== text) return;
      drafts.delete(p.id);
      const shown = replyInput(p.id); // this box, or the one a rebuild put in its place meanwhile
      if (shown) shown.value = "";
    }, "Sent").finally(() => {
      replying.delete(p.id);
      for (const b of [send, replyInput(p.id)?.form?.querySelector("button")]) if (b) b.disabled = false;
    });
  };
  return form;
}

// --- Thread actions ------------------------------------------------------------

function agentPicker() {
  const pick = el("select");
  pick.append(...app.agents.map((a) => new Option(a, a)));
  pick.setAttribute("aria-label", "Agent");
  return pick;
}

export function threadActions(t: Thread) {
  const pick = agentPicker();
  const add = button("Add", () => {
    closeSheet();
    void act(async () => {
      const added = await run<Pane>("add", [t.id, "--agent", pick.value], { change: true, timeout: 60 });
      go(`#/pane/${encodeURIComponent(added.id)}`);
    }, "Started");
  }, "primary");
  const pair = el("div", "pair");
  pair.append(pick, add);
  const layout = el("div", "seg");
  for (const l of ["cols", "rows", "grid"]) {
    const b = button(l === "cols" ? "Side by side" : l === "rows" ? "Stacked" : "Grid", () => {
      closeSheet();
      void act(() => run("layout", [l, "--thread", t.id], { change: true }), "Layout changed on the PC");
    });
    b.setAttribute("aria-pressed", String(t.layout === l));
    layout.append(b);
  }
  const worktree = t.dir !== t.repo;
  void sheet([
    el("p", "", `Add an agent to ${t.name}`), pair,
    item("Changes", () => go(`#/changes/${encodeURIComponent(t.id)}`), "", { icon: "changes" }),
    item("Rename", () => rename(t), "", { icon: "rename" }),
    item("Show it on the PC", () => run("show", [t.id], { change: true }), "Shown on the PC", { icon: "eye" }),
    item("Open in VS Code on the PC", () => run("vscode", [t.id], { change: true }), "VS Code opened on the PC", { icon: "code" }),
    el("p", "", "Layout on the PC"), layout,
    item("Close the thread", () => closeThread(t, ""), "", { icon: "close", danger: true }),
    ...(worktree ? [
      item("Close and delete the worktree", () => closeThread(t, "worktree"), "", { icon: "trash", danger: true }),
      item("Close and delete worktree and branch", () => closeThread(t, "branch"), "", { icon: "trash", danger: true }),
    ] : []),
  ], t.name);
}

async function rename(t: Thread) {
  const name = await promptSheet(`Rename ${t.name}`, t.name, "", "Rename");
  if (name && name !== t.name) await act(() => run("rename", [t.id, name], { change: true }), "Renamed");
}

/** Closing asks first; deleting the worktree says what would be lost, as close-plan reads it. */
async function closeThread(t: Thread, del: "" | "worktree" | "branch") {
  let detail = `Its ${t.panes.length} pane${t.panes.length === 1 ? "" : "s"} stop.`;
  const args = [t.id, "--yes"];
  if (!del) detail += " Its folder and branch stay.";
  else {
    const plan = await run<{ rev: string; lost: Record<string, number> }>("close-plan", [t.id, "--delete", del]).catch((e) => (toast(e.message, true), null));
    if (!plan) return;
    const lost = Object.entries(plan.lost).filter(([, n]) => n > 0);
    detail += del === "branch" ? ` The worktree moves to Loom's trash and the branch ${t.branch} is deleted.` : " The worktree folder moves to Loom's trash, kept for a day.";
    if (lost.length) detail += `\n\nThis loses ${lost.map(([k, n]) => `${n} ${k === "commits" ? `commit${n === 1 ? "" : "s"} no other branch has` : `${k} file${n === 1 ? "" : "s"}`}`).join(", ")}.`;
    args.push("--delete", del, "--plan", plan.rev, ...(lost.length ? ["--discard", lost.map(([k]) => k).join(",")] : []));
  }
  if (!(await confirmSheet(`Close ${t.name}?`, detail, del ? "Close and delete" : "Close thread", true))) return;
  await act(() => run("close-thread", args, { change: true, timeout: 120 }), "Thread closed");
  if (location.hash.includes(t.id)) replace("#/");
}

// --- One agent ------------------------------------------------------------------

export const paneView = el("section", "screen detail pane-screen");
paneView.id = "pane";
const who = el("div", "who");
const whoName = el("b"), whoTitle = el("span");
who.append(whoName, whoTitle);
const stateChip = el("span", "chip");
const noticeBar = el("div");
noticeBar.id = "notice";
noticeBar.hidden = true;
noticeBar.append(el("span"), el("button"));
const screenBox = el("pre");
screenBox.id = "screen";
const questionBox = el("div");
questionBox.id = "question";
questionBox.hidden = true;
const keysBox = el("div", "kbd");
keysBox.id = "keys";
const promptForm = el("form");
promptForm.id = "prompt";
const promptText = el("textarea");
Object.assign(promptText, { rows: 1, placeholder: "Message" });
promptText.setAttribute("aria-label", "Message");
const keysBtn = iconButton("keyboard", "Keys", () => { keysOpen = !keysOpen; setPref("loom-keys", keysOpen ? "1" : ""); drawKeys(); });
keysBtn.id = "keys-btn";
keysBtn.setAttribute("aria-controls", "keys");
const sendBtn = el("button", "primary");
sendBtn.append(ui("send"));
sendBtn.setAttribute("aria-label", "Send");
const micBtn = iconButton("mic", "Dictate", () => dictate());
micBtn.id = "mic";
promptForm.append(keysBtn, promptText, micBtn, sendBtn);
{
  const dock = el("div");
  dock.id = "dock";
  dock.append(questionBox, keysBox, promptForm, recBar);
  const more = iconButton("more", "Actions", () => paneActions());
  more.id = "more";
  paneView.append(topBar(who, [stateChip, more], "#/"), noticeBar, screenBox, dock);
}

let open: string | null = null; // the agent on show
let shown: string | null = null; // the last screen drawn, to skip redrawing an unchanged one
let question = "";
let older = false; // older lines on screen: the live view waits
let keysOpen = pref("loom-keys", "") === "1";
let wrap = pref("loom-wrap", "1") === "1";

/** null: a link names a pane the list doesn't have yet (remote.ts), so none is open until it is read:
 * nothing typed, chosen or asked goes to the one open before, and what was typed stays. */
export function showPane(id: string | null, stableId = "") {
  const was = draftKey();
  if (id !== open) {
    open = id;
    shown = null;
    question = "";
    older = false;
    screenBox.replaceChildren();
    questionBox.hidden = true;
    notice("");
    seen();
  }
  // The pane's own, else a link's (#/pane/<id>/<ref>/<stableId>), even for the id already open; a link
  // without one keeps what was known for that id, a lookup (null) in between too.
  if (id !== null) {
    openStable = findPane(id)?.stableId || stableId || (stableFor === id ? openStable : "");
    stableFor = id;
  }
  // Each agent keeps its own unsent message. One typed while a link's agent is looked up is for that agent.
  const now = draftKey();
  if (now !== was) {
    if (was !== null) typed.set(was, promptText.value);
    if (was !== null || !promptText.value) promptText.value = (now !== null && typed.get(now)) || "";
    promptText.style.height = "";
    if (promptText.value) promptText.style.height = `${promptText.scrollHeight + 2}px`;
  }
  paintSend();
  drawHead();
  drawKeys();
  reread();
}
export const openPane = () => open;

/** The open agent comes to the front on the PC and fills its thread there: on each visit to its screen
 * (remote.ts), never on the background reads. zoom toggles, so only show's own reply (not the list, up to
 * 2 s old) says whether it's needed, and only while that visit lasts: a reply that comes after you left,
 * or left and came back, zooms nothing. */
export function focusOnPc() {
  const p = findPane(open), visit = app.visit;
  if (p) void act(async () => {
    const d = await run<{ zoomed?: boolean }>("show", [p.id], { change: true });
    if (!d.zoomed && visit === app.visit) await run("zoom", [p.id], { change: true });
  });
}
// The open agent's stableId, and the pane id it was known for: it finds the agent again once Loom
// restarts and its pane id is gone.
let openStable = "", stableFor: string | null = null;
/** Unsent messages by agent: its stableId, which a restart keeps, else its pane id. None while a link's agent is looked up. */
const typed = new Map<string, string>();
/** What each agent's box is sending now, by the same key, and its send settling: on its way, it is no draft for
 * a new clip to join, and that agent's Send waits for it. Another agent's doesn't. */
const outgoing = new Map<string, { text: string; sent: Promise<unknown> }>();
const draftKey = () => (open === null ? null : (stableFor === open && openStable) || open);
const paintSend = () => void (sendBtn.disabled = outgoing.has(draftKey() ?? ""));

/** After each read of the list. Once the open agent's pane is missing from it, the one pane with its
 * stableId (saved with each pane, never shared) is the one Loom restored it as: the address follows,
 * keeping that id, without a new history entry. A pane closed on the PC has no such pane, so it stays
 * gone and what was typed for it goes to no other agent. Only while the address names this pane: an
 * agent open before stays out of the way of one a link asks for. */
export function follow() {
  const id = open;
  const p = findPane(id);
  if (p) return void (openStable = p.stableId || openStable); // shown before the list had it
  const named = location.hash.startsWith("#/pane/") ? decodeURIComponent(location.hash.split("/")[2] ?? "") : null;
  if (!id || !openStable || stableFor !== id || named !== id) return;
  const again = panes().filter((q) => q.stableId === openStable);
  if (again.length !== 1) return;
  history.replaceState(null, "", `#/pane/${encodeURIComponent(again[0].id)}/${encodeURIComponent(again[0].ref)}/${encodeURIComponent(openStable)}`);
  showPane(again[0].id);
  showList(again[0].id);
}

/** Opening a waiting agent, or tapping its screen, clears the wait as a click on its pane does on the PC. */
function seen() {
  const p = findPane(open);
  if (p?.state === "waiting") void act(() => run("seen", [p.id], { change: true }));
}
screenBox.addEventListener("click", seen);

export function drawHead() {
  const p = findPane(open);
  // As the PC's Speak button: an agent's pane only. A prefix typed into PowerShell is an error.
  micBtn.hidden = !p || p.agent === "shell";
  if (!p) {
    whoName.textContent = open ? "This agent is gone" : "Opening the agent";
    whoTitle.textContent = open ? "Loom restarted, or it was closed. Go back to the list." : "Reading Loom's agents.";
    stateChip.textContent = "";
    return;
  }
  whoName.textContent = `${p.ref} · ${p.agent}`;
  whoTitle.textContent = p.title;
  stateChip.textContent = p.state;
  stateChip.className = `chip ${p.state}`;
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
 * that, the screen scrolls sideways and offers to fit Loom to the phone.
 * Wrapping, a screen that only fits under 10 px shows at 12 px, its lines wrapped.
 * A full-screen app (OpenCode) draws a grid that wrapping breaks: it only fits,
 * and under 10 px offers to fit Loom to the phone. */
function fit(cols: number, grid = false) {
  if (!charWidth) {
    const probe = el("span", "", "M".repeat(20));
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:100px var(--mono)";
    document.body.append(probe);
    charWidth = probe.getBoundingClientRect().width / 2000 || 0.6;
    probe.remove();
  }
  const width = screenBox.clientWidth - 24;
  const fitted = Math.floor((width / (cols * charWidth)) * 10) / 10;
  const wrapping = wrap && !grid;
  const size = Math.min(14, wrapping && fitted < 10 ? 12 : Math.max(7, fitted));
  screenBox.style.fontSize = `${size}px`;
  screenBox.classList.toggle("wrap", wrapping);
  screenBox.classList.toggle("grid", grid);
  if (!older) notice(!wrapping && fitted < (grid && !app.phoneSize ? 10 : 7) ? `${cols} columns, ${fitted < 7 ? "wider than" : "small on"} this screen.` : "");
}

function notice(text: string, label = app.phoneSize ? "Desktop size" : "Fit Loom to phone", action: () => void = () => void act(fitPhone)) {
  noticeBar.hidden = !text;
  noticeBar.querySelector("span")!.textContent = text;
  const b = noticeBar.querySelector("button")!;
  b.textContent = label;
  b.onclick = action;
}

let drawnAt = 0; // when the page last moved the screen itself, not your finger
function draw(s: Screen, toEnd = false) {
  const atEnd = toEnd || screenBox.scrollTop + screenBox.clientHeight >= screenBox.scrollHeight - 24;
  drawnAt = performance.now();
  fit(s.cols, !!s.alt);
  // Around a full-screen app's grid, the background of its top-left cell.
  const corner = s.rows[0]?.runs[0];
  screenBox.style.background = s.alt && corner?.x === 0 ? color(corner.bg) : "";
  // The blank rows under an agent's last line would keep it off the bottom.
  let end = s.rows.length;
  while (end && !s.rows[end - 1].runs.some((r) => r.text.trim() || r.bg !== undefined)) end--;
  screenBox.replaceChildren(...s.rows.slice(0, end).map((row) => {
    const text = row.runs.map((r) => r.text).join("");
    // A rule of box-drawing lines is cut at the edge, not wrapped onto more lines.
    const line = el("div", /^\s*[─-╿][\s─-╿]*$/.test(text) ? "line rule" : "line");
    let col = 0;
    for (const r of row.runs) {
      // In a span: a grid's rows are flex boxes, which drop bare spaces.
      if (r.x > col) line.append(el("span", "", " ".repeat(r.x - col)));
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
  if (atEnd) screenBox.scrollTop = screenBox.scrollHeight;
}

function drawQuestion(id: string, m: Menu | null) {
  const key = m ? m.rev : "";
  if (key === question) return; // the same question: leave the buttons under the finger
  question = key;
  questionBox.hidden = !m;
  if (!m) return questionBox.replaceChildren();
  questionBox.replaceChildren(el("p", "", m.question.join("\n").trim()), ...m.options.map((o, i) => {
    const n = m.keys?.[i] ?? String(i + 1);
    const b = button(el("span", "n", n), () => void act(() => run("choose", [id, n, "--menu", m.rev], { change: true })));
    b.append(o);
    return b;
  }));
}

export const reread = () => void screen().catch(() => {});

/** Reads the open agent's screen and its question, in one trip to the PC. */
export async function screen() {
  const id = open;
  if (!id || older || !app.token || paneView.hidden) return;
  const s = await run<Screen & { menu?: Menu | null }>("read", [id, "--styles", "--menu"], { timeout: 5 });
  // Its buttons answer this pane: not once another is open or being looked up (null), nor off screen.
  if (id !== open || older || paneView.hidden) return;
  if (s.text !== shown) {
    shown = s.text;
    draw(s);
  }
  drawQuestion(id, s.menu ?? null);
}

/** Toggles Loom's phone size on the PC, with the open pane filling the window. */
async function fitPhone() {
  const p = findPane(open);
  const fitting = !app.phoneSize;
  // A pane in a thread that isn't showing keeps its size, so it is shown first. zoom toggles: show's own reply
  // says whether the pane fills its thread, not the list, up to 2 s old (focusOnPc).
  const zoomed = p && !!(await run<{ zoomed?: boolean }>("show", [p.id], { change: true })).zoomed;
  app.phoneSize = (await run<{ phone: boolean }>("window", ["phone"], { change: true })).phone;
  if (p && zoomed !== fitting) await run("zoom", [p.id], { change: true });
  toast(app.phoneSize ? "Loom fits the phone now" : "Loom is back at its desktop size");
}

/** The pane's history above its screen, styled, when you scroll up past the
 * screen's top. The live view waits until you scroll back to the bottom. */
let loadingOlder = false;
async function olderLines() {
  const id = open;
  if (!id || older || loadingOlder) return;
  loadingOlder = true;
  try {
    const s = await run<Screen>("read", [id, "--styles", "--lines", "2000"]);
    if (id !== open) return;
    older = true;
    const fromBottom = screenBox.scrollHeight - screenBox.scrollTop;
    draw(s);
    screenBox.scrollTop = screenBox.scrollHeight - fromBottom;
    notice("Older lines. Scroll to the bottom for live.", "Back to live", live);
  } finally {
    loadingOlder = false;
  }
}

function live() {
  if (!older) return;
  older = false;
  notice("");
  const id = open;
  void run<Screen>("read", [id!, "--styles"]).then((s) => {
    if (id !== open || older) return;
    shown = s.text;
    draw(s, true);
  }).catch(() => {});
}

{
  // Only a finger or a wheel counts: the box also scrolls when the keys fold or the page redraws.
  let last = 0, touchY = 0, touching = false, userAt = 0;
  const byUser = () => touching || performance.now() - userAt < 1000; // a flick glides on after the finger lifts
  const atBottom = () => screenBox.scrollTop + screenBox.clientHeight >= screenBox.scrollHeight - 4;
  // A screen shorter than the box doesn't scroll: a pull down asks for the history all
  // the same, and a push up at the bottom goes back to live.
  const pulled = (dy: number) => {
    if (dy < 0 && screenBox.scrollTop <= 0) void olderLines();
    else if (dy > 0 && older && atBottom()) live();
  };
  screenBox.addEventListener("scroll", () => {
    const up = screenBox.scrollTop < last;
    last = screenBox.scrollTop;
    if (performance.now() - drawnAt < 300 || !byUser()) return;
    if (up && screenBox.scrollTop < 40) void olderLines();
    else if (!up && older && atBottom()) live();
  }, { passive: true });
  screenBox.addEventListener("touchstart", (e) => { touching = true; touchY = e.touches[0].clientY; }, { passive: true });
  screenBox.addEventListener("touchmove", (e) => {
    const dy = touchY - e.touches[0].clientY;
    if (Math.abs(dy) > 30) pulled(dy);
  }, { passive: true });
  for (const end of ["touchend", "touchcancel"]) screenBox.addEventListener(end, () => { touching = false; userAt = performance.now(); }, { passive: true });
  screenBox.addEventListener("wheel", (e) => { userAt = performance.now(); pulled(e.deltaY); }, { passive: true });
}

/** The keys fold away under the button beside the message box, and stay as left. */
function drawKeys() {
  const atEnd = screenBox.scrollTop + screenBox.clientHeight >= screenBox.scrollHeight - 24;
  keysBox.hidden = !keysOpen;
  keysBtn.setAttribute("aria-expanded", String(keysOpen));
  if (atEnd) screenBox.scrollTop = screenBox.scrollHeight;
}

/** The keyboard: keys and typed text go to the open pane as they come. */
const toPane = sequence<{ id: string; t: Typed }>(async (items) => {
  // Runs of keys go in one keys command, runs of text in one --text, in order.
  for (let i = 0; i < items.length;) {
    const { id, t } = items[i];
    if ("text" in t) {
      let text = "";
      for (; i < items.length && items[i].id === id && "text" in items[i].t; i++) text += (items[i].t as { text: string }).text;
      await run("keys", [id, "--text", "-"], { stdin: text, change: true });
    } else {
      const names: string[] = [];
      for (; i < items.length && items[i].id === id && "key" in items[i].t; i++) {
        const { key, mods } = items[i].t as { key: string; mods: { ctrl: boolean; alt: boolean; shift: boolean } };
        names.push(`${mods.ctrl ? "ctrl-" : ""}${mods.alt ? "alt-" : ""}${mods.shift ? "shift-" : ""}${key}`);
      }
      await run("keys", [id, ...names], { change: true });
    }
  }
  shown = null;
  reread();
});
keyboard(keysBox, "Type here: each key goes straight to the agent", (t) => { if (open) toPane({ id: open, t }); });

promptForm.onsubmit = (e) => {
  e.preventDefault();
  void sendPrompt();
};
/** Sends what the box holds, and settles once Loom has answered: a dictated ⏎ waits on it. One at a time per agent. */
function sendPrompt() {
  const text = promptText.value.trim(), id = open, key = draftKey();
  if (!text || !id || key === null || outgoing.has(key)) return;
  // An agent gets a task Loom follows to its end. A shell gets the line typed:
  // submit needs Loom's PowerShell prompt and would add a PowerShell comment.
  const cmd = findPane(id)?.agent === "shell" ? "send" : "submit";
  const sent = act(async () => {
    await run(cmd, [id, "-"], { stdin: text, change: true, timeout: 60 });
    // Only the message that went: one typed while it was on its way, here or for another agent, stays.
    if (typed.get(key)?.trim() === text) typed.delete(key); // left for another agent while it went
    if (draftKey() !== key || promptText.value.trim() !== text) return;
    promptText.value = "";
    promptText.style.height = "";
  }, "Sent").finally(() => {
    outgoing.delete(key);
    paintSend();
    shown = null;
    setTimeout(reread, 300);
  });
  outgoing.set(key, { text, sent });
  paintSend();
  return sent;
}
// The box grows with what you type, up to 40% of the screen.
promptText.addEventListener("input", () => {
  promptText.style.height = "";
  promptText.style.height = `${promptText.scrollHeight + 2}px`;
});
promptText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) promptForm.requestSubmit();
});

/** The mic: what you say goes in this agent's Message box, after the PC's prefix when the box was empty
 * as you tapped. A ⏎ prefix sends it when it is the whole message, if you're still on this visit to the agent
 * and stopped it yourself.
 * Once you've moved on, it is that agent's draft, never sent on its own. */
function dictate() {
  const p = findPane(open), key = draftKey(), visit = app.visit;
  if (!p || p.agent === "shell" || key === null) return;
  // Empty, or holding only a message on its way: what you say now is a message of its own.
  const wasEmpty = !promptText.value.trim() || promptText.value.trim() === outgoing.get(key)?.text;
  void record(async (text, pick, byHand) => {
    if (!text) return toast("Nothing heard.");
    // A send on its way to this agent, typed too, settles first: once it went the box is empty for this
    // clip, refused it stays and the clip joins it. Read before, the clip joined a message already sent.
    await outgoing.get(key)?.sent;
    const here = draftKey() === key;
    const box = here ? promptText.value : typed.get(key) ?? "";
    // Alone, the clip is the whole message, after the prefix. Otherwise it joins what the box holds: text
    // you typed, or an earlier send whose answer never came, which Loom may already have taken.
    const alone = wasEmpty && !box.trim();
    const message = alone ? `${pick.prefix?.text ?? ""}${text}` : [box.trimEnd(), text].filter(Boolean).join(" ");
    if (here) {
      promptText.value = message;
      promptText.dispatchEvent(new Event("input")); // grows to fit
    } else typed.set(key, message);
    // A ⏎ sends only a message the clip made alone, so nothing already sent goes again under a new key;
    // and the next clip lands only once this one has gone.
    if (here && visit === app.visit) {
      if (pick.prefix?.enter && byHand && alone) await sendPrompt();
    } else toast(`What you said to ${p.ref} is in its Message box.`);
  });
}
repaint.mic = () => {
  const busy = transcribing();
  micBtn.classList.toggle("busy", busy);
  micBtn.setAttribute("aria-label", busy ? "Dictate (transcribing the last clip)" : "Dictate");
  promptText.placeholder = busy ? "Transcribing…" : "Message";
};

const MODELS = ["opus[1m]", "sonnet[1m]", "fable[1m]", "haiku", "default"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"];

function paneActions() {
  const p = findPane(open);
  if (!p) return;
  const t = threadOf(p)!;
  const items: (Node | string)[] = [];
  if (p.agent === "claude") {
    const model = el("select");
    model.append(new Option(`Model: ${p.model ?? "default"}`, ""), ...MODELS.map((m) => new Option(m, m)));
    const effort = el("select");
    effort.append(new Option(`Effort: ${p.effort ?? "default"}`, ""), ...EFFORTS.map((m) => new Option(m, m)));
    model.setAttribute("aria-label", "Model");
    effort.setAttribute("aria-label", "Effort");
    // Typed into Claude as the PC's sliders do: /model X, /effort X.
    model.onchange = () => { closeSheet(); void act(() => run("send", [p.id, `/model ${model.value}`], { change: true }), `Model: ${model.value}`); };
    effort.onchange = () => { closeSheet(); void act(() => run("send", [p.id, `/effort ${effort.value}`], { change: true }), `Effort: ${effort.value}`); };
    const pair = el("div", "pair");
    pair.style.gridTemplateColumns = "1fr 1fr";
    pair.append(model, effort);
    items.push(pair);
  }
  const bell = el("div", "seg");
  for (const [v, label] of [["inherit", "Default"], ["on", "On"], ["off", "Off"]]) {
    const b = button(label, () => { closeSheet(); void act(() => run("notify", [p.id, v], { change: true }), `Notices: ${label.toLowerCase()}`); });
    b.setAttribute("aria-pressed", String(p.notify === v));
    bell.append(b);
  }
  items.push(el("p", "", "Task notices for this agent"), bell);
  if (p.agent !== "shell") {
    // What the mic will use, read again as the sheet opens: someone at the PC may have changed it.
    const label = () => (lists ? `Dictation · ${pickLabel()}` : "Dictation");
    const dictation = item(label(), () => dictationSheet(), "", { icon: "mic" });
    void readLists().then(() => (dictation.lastChild!.textContent = label()), () => {});
    items.push(dictation);
  }
  if (p.agent === "claude") items.push(item("Context", () => go(`#/context/${encodeURIComponent(p.id)}`), "", { icon: "layers" }));
  const fitLabel = () => (app.phoneSize ? "Desktop size on the PC" : "Fit Loom to phone");
  const fit = item(fitLabel(), fitPhone, "", { icon: "phone" });
  // The sheet opens at once; someone at the PC may have changed the window since, which status says.
  void run<{ phone: boolean }>("status").then((s) => {
    app.phoneSize = s.phone;
    fit.lastChild!.textContent = fitLabel();
  }, () => {});
  items.push(
    fit,
    item(wrap ? "Don't wrap long lines" : "Wrap long lines", () => {
      wrap = !wrap;
      setPref("loom-wrap", wrap ? "1" : "0");
      screenBox.classList.toggle("wrap", wrap);
      shown = null;
      reread();
    }, "", { icon: "wrap" }),
    item("Older lines", olderLines, "", { icon: "history" }),
    item("Show it on the PC", () => run("show", [p.id], { change: true }), "Shown on the PC", { icon: "eye" }),
    item(t.zoomed === p.id ? "Unzoom on the PC" : "Zoom on the PC", () => run("zoom", [p.id], { change: true }), "", { icon: "window" }),
    item("Clear the input (Ctrl+U)", () => run("keys", [p.id, "ctrl-u"], { change: true }), "", { icon: "close" }),
    item("Thread actions", () => threadActions(t), "", { icon: "more" }),
    item("Restart", () => run("restart", [p.id, "--yes"], { change: true, timeout: 60 }), "Restarted", { icon: "restart", ask: [`Restart ${p.ref}?`, "Its session resumes.", "Restart"] }),
    item("Stop", () => run("stop", [p.id, "--yes"], { change: true }), "Stopped", { icon: "stop", danger: true, ask: [`Stop ${p.ref}?`, "The pane stays, with what it last showed.", "Stop"] }),
    item("Close this agent", async () => { await run("close", [p.id, "--yes"], { change: true }); back(); }, "Closed", { icon: "close", danger: true, ask: [`Close ${p.ref}?`, "Its pane goes from the thread.", "Close"] }),
  );
  void sheet(items, `${p.ref} · ${p.agent}`);
}

// --- A new thread -----------------------------------------------------------

export const newView = el("section", "screen detail");
newView.id = "new";
const newForm = el("form", "body");
newForm.style.display = "grid";
newForm.style.gap = "16px";
newForm.style.maxWidth = "560px";
newView.append(topBar("New thread", [], "#/"), newForm);
let worktree = true;

export function showNew() {
  const keep = (name: string) => (newForm.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
  const was = { project: keep("project"), agent: keep("agent") || "claude", name: "", base: keep("base"), folder: keep("folder"), panes: keep("panes") || "1" };
  const repos = [...new Set(app.threads.map((t) => t.repo))].sort((a, b) => base(a).localeCompare(base(b)));
  const project = el("select");
  project.name = "project";
  project.append(...repos.map((r) => new Option(base(r), r)), new Option("Another folder…", ""));
  if (repos.includes(was.project)) project.value = was.project;
  const folder = field("Folder on the PC", "folder", "C:\\Users\\you\\code\\project");
  const kind = el("div", "seg");
  for (const [k, label] of [["worktree", "New worktree"], ["checkout", "This folder"]]) {
    const b = button(label, () => { worktree = k === "worktree"; paint(); });
    b.dataset.kind = k;
    kind.append(b);
  }
  const name = field("Thread name", "name", "fix-login");
  const baseBranch = field("Base branch (optional)", "base", "HEAD");
  const agent = el("select");
  agent.name = "agent";
  agent.append(...app.agents.map((a) => new Option(a, a)));
  if (app.agents.includes(was.agent)) agent.value = was.agent;
  const count = el("select");
  count.name = "panes";
  count.append(...[1, 2, 3, 4, 6, 8].map((n) => new Option(n === 1 ? "1 agent" : `${n} agents`, String(n))));
  count.value = was.panes;
  const create = el("button", "primary", "Create");
  const projectField = labelled("Project", project);
  newForm.replaceChildren(projectField, folder, kind, name, baseBranch, labelled("Agent", agent), labelled("How many", count), create);
  const paint = () => {
    folder.hidden = project.value !== "";
    name.hidden = baseBranch.hidden = !worktree;
    for (const b of kind.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String((b.dataset.kind === "worktree") === worktree));
  };
  project.onchange = paint;
  paint();
}

function field(label: string, name: string, placeholder: string) {
  const input = el("input");
  Object.assign(input, { name, placeholder, autocapitalize: "off", spellcheck: false });
  input.setAttribute("autocorrect", "off");
  return labelled(label, input);
}
function labelled(text: string, control: HTMLElement) {
  const l = el("label", "field", text);
  l.append(control);
  return l;
}

newForm.onsubmit = async (e) => {
  e.preventDefault();
  const value = (name: string) => ((newForm.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim();
  const folder = value("project") || value("folder");
  if (!folder) return toast("Pick a project or type a folder.", true);
  const args = [folder, "--agent", value("agent"), "--panes", value("panes") || "1"];
  if (worktree) {
    if (!value("name") && !value("base")) return toast("Name the thread: its branch is loom/<name>.", true);
    if (value("name")) args.push("--name", value("name"));
    if (value("base")) args.push("--base", value("base"));
  }
  const submit = newForm.querySelector("button.primary") as HTMLButtonElement;
  submit.disabled = true;
  await act(async () => {
    const th = await run<Thread>("new", args, { change: true, timeout: 120 });
    replace(th.panes[0] ? `#/pane/${encodeURIComponent(th.panes[0].id)}` : "#/");
  }, "Thread started");
  submit.disabled = false;
};
