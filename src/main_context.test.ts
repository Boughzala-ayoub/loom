// Run the production startup/close paths without a WebView or a live journal.
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as model from "./task.ts";
import { pruneSettled } from "./cli.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["startupTurns", "startupNotify", "finishTaskReplay", "paneContext", "contextOf", "keepContext", "turnTask", "enterTurn", "moveTask", "taskWrites", "holdSignals", "enterHeld", "taskSignal", "pendingContextTasks", "closedTaskContexts", "agentTurn", "watched", "sweepTasks", "QUIET_MS", "keepTasks", "taskPruned"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`let ${d.getText(source)};`);
}
function fixture(extra: Record<string, unknown> = {}) {
  const th = { id: "thread-1", name: "At Enter", panes: [] as any[] };
  const p: any = { id: "pane-1", generation: 1, agent: "codex", th };
  th.panes.push({}, p);
  const tasks = new Map(), taskWatch = new Map();
  const s = createContext({ ...model, crypto, console, tasks, taskSeq: 0, unsaved: new Set(), taskWatch, heldEnter: new Map(),
    paneById: (id: string) => th.panes.find((p) => p.id === id), paneTitle: () => "Agent session", paneName: () => "work:2",
    journal: async () => {}, sweepSoon() {}, pruneSettled, keepReceipts() {}, adoptManual: () => false, ...extra });
  runInContext(ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { turnTask, enterTurn, keepContext, finishTaskReplay, holdSignals, taskSignal, contextOf, sweepTasks, keepTasks };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
  return { th, p, tasks, taskWatch, f: s.f };
}
for (const held of [false, true]) {
  const { th, p, f } = fixture();
  const t = f.turnTask(p, "manual", model.promptMatch("A"), 1);
  f.enterTurn(t, 2);
  const release = held ? f.holdSignals(p) : () => {};
  if (held) f.taskSignal(p, { kind: "end", at: 3, matches: [t.match], turn: "A" });
  th.name = "At Close";
  th.panes.shift();
  f.keepContext([p]);
  th.panes.length = 0;
  f.finishTaskReplay();
  release();
  const copies = t.events.map((e: any) => [e.context.threadName, e.context.paneNumber, e.context.origin]);
  assert.deepEqual(JSON.parse(JSON.stringify(copies.slice(0, 2))), [["At Enter", 2, "event"], ["At Enter", 2, "event"]]);
  const last = held ? t.events.at(-1).context : f.contextOf(t);
  assert.deepEqual([last.threadName, last.paneNumber, last.origin], ["At Close", 1, "last-known"]);
  const replay = model.readJournal(model.writeJournal([t], t.events.length, 0)).tasks.get(t.id)!;
  assert.equal(replay.context!.threadName, "At Close");
}
console.log("ok   Deferred readable tasks keep pre-close context separately from Enter snapshots");
for (const held of [false, true]) {
  const { th, p, f } = fixture();
  const t = f.turnTask(p, "manual", model.promptMatch("A"), 1);
  f.enterTurn(t, 2);
  th.name = "At Report";
  f.taskSignal(p, { kind: "end", at: 3, matches: [t.match], turn: "A" });
  const b = f.turnTask(p, "manual", model.promptMatch("B"), 4);
  f.enterTurn(b, 5);
  const release = held ? f.holdSignals(p) : () => {};
  th.name = "At Close";
  th.panes.shift();
  f.keepContext([p]);
  th.panes.length = 0;
  f.finishTaskReplay();
  release();
  const e = t.events.at(-1);
  assert.equal(e.state, "completed");
  assert.deepEqual([e.context.threadName, e.context.paneNumber, e.context.origin], ["At Report", 2, "event"]);
  const replay = model.readJournal(model.writeJournal([t, b], t.events.length + b.events.length, 0)).tasks.get(t.id)!;
  assert.equal(replay.events[replay.events.length - 1].context!.threadName, "At Report");
}
console.log("ok   A later Enter hold preserves an earlier report's captured context");

// A turn of Claude's no Enter explains (a background job's notice) becomes a task of its own at its Stop.
{
  const { p, tasks, taskWatch, f } = fixture();
  f.finishTaskReplay(); // past Loom's startup read, which holds reports until it's done
  Object.assign(p, { agent: "claude", workSince: 5 });
  f.taskSignal(p, { kind: "stop", at: 9, response: "r1" });
  const [t, ...more] = [...tasks.values()];
  assert.equal(more.length, 0);
  assert.deepEqual([t.source, t.state, t.correlation, t.startedAt, t.gen], ["agent", "working", "sequence", 5, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(t.events.map((e: any) => [e.state, e.signal]))), [["accepted", "agent"], ["working", "agent"]]);
  assert.ok(taskWatch.get(t.id).stopAt > 0, "its Stop waits for Claude idle, as any turn's (sweepTasks)");
  assert.equal(taskWatch.get(t.id).response, "r1");
  f.taskSignal(p, { kind: "stop", at: 12, response: "r2" });
  assert.equal(tasks.size, 1, "another Stop hook sent Claude on: its next Stop is the same turn's");
  assert.equal(taskWatch.get(t.id).response, "r2");
}
{
  // Asking first: the task asks, so the question notifies.
  const { p, tasks, f } = fixture();
  f.finishTaskReplay();
  p.agent = "claude";
  f.taskSignal(p, { kind: "approval", at: 9, detail: "Bash" });
  const [t] = [...tasks.values()];
  assert.deepEqual([t.source, t.state, t.startedAt], ["agent", "approval", 9]);
}
{
  // Not from a replaced process, not with a task open, not for Codex.
  const { p, tasks, f } = fixture();
  f.finishTaskReplay();
  p.agent = "claude";
  f.taskSignal(p, { kind: "stop", at: 9, launch: 0 });
  assert.equal(tasks.size, 0, "a replaced launch's Stop");
  const t = f.turnTask(p, "manual", model.promptMatch("A"), 10);
  f.enterTurn(t, 11);
  f.taskSignal(p, { kind: "stop", at: 12 });
  assert.equal(tasks.size, 1, "a Stop between a person's Enter and its start is no new turn");
  const codex = fixture();
  codex.f.finishTaskReplay();
  codex.f.taskSignal(codex.p, { kind: "stop", at: 9 });
  assert.equal(codex.tasks.size, 0, "Codex's untracked turns stay untracked");
}
console.log("ok   A turn of Claude's no Enter explains becomes an agent task at its Stop or question");

/** A fixture past the startup read whose sweep reads, at the time the test
 * sets, the screen it sets (Claude working, its input, a question), and which
 * records the notices that go out. */
function swept() {
  const clock = { at: 0 }, pushed: string[] = [], screen = { busy: false, input: false, menu: false };
  const fx = fixture({ Date: class extends Date { static now() { return clock.at; } }, pushNotice: (_: unknown, e: any) => pushed.push(e.state),
    shuttingDown: false, gone: () => false, sweepTimer: 0, clearInterval() {}, claudeWorking: () => screen.busy, interruptHint: () => false,
    screenCells: () => [], liveScreen: () => "", readInput: () => ({ kind: screen.input ? "empty" : "unknown" }), readMenu: () => (screen.menu ? { question: [], options: ["Yes", "No"] } : null) });
  fx.f.finishTaskReplay();
  Object.assign(fx.p, { agent: "claude", dead: false, interruptAt: 0, screen: () => "" });
  const sweep = async (at: number) => ((clock.at = at), fx.f.sweepTasks(), await new Promise((r) => setTimeout(r, 0)));
  return { ...fx, clock, pushed, screen, sweep };
}
// Claude runs no Stop hook for a turn Esc or Ctrl-C interrupts, so a Stop
// before one, that another Stop hook sent on, completes nothing: the turn
// ends cancelled, whether a person's Enter began it or Claude itself did.
for (const source of ["manual", "agent"]) {
  const { p, tasks, pushed, screen, clock, sweep, f } = swept();
  p.workSince = 900;
  if (source === "manual") {
    const t = f.turnTask(p, "manual", model.promptMatch("A"), 900);
    f.enterTurn(t, 900);
    f.taskSignal(p, { kind: "start", at: 900, match: t.match });
  }
  clock.at = 1000;
  f.taskSignal(p, { kind: "stop", at: 1000 });
  screen.busy = true;
  await sweep(1600);
  p.interruptAt = 2000;
  Object.assign(screen, { busy: false, input: true });
  await sweep(4500);
  const [t, ...more] = [...tasks.values()];
  assert.equal(more.length, 0);
  assert.deepEqual([t.source, t.state, t.reason], [source, "cancelled", "interrupted"], `${source}: Ctrl-C after a Stop Claude went on from`);
  assert.deepEqual(pushed, [], `${source}: an interrupted turn notified`);
}
{
  // Asking at Loom's first sight of it, answered, then interrupted. A Ctrl-C
  // before it asked (clearing a draft, say) didn't end it: it asked after.
  const { p, tasks, pushed, screen, clock, sweep, f } = swept();
  Object.assign(p, { workSince: 900, interruptAt: 950 });
  clock.at = 1000;
  f.taskSignal(p, { kind: "approval", at: 1000, detail: "Bash" });
  const [t] = [...tasks.values()];
  screen.menu = true;
  await sweep(3000);
  assert.equal(t.state, "approval", "a Ctrl-C before Claude asked ended the turn that asked");
  Object.assign(screen, { menu: false, busy: true });
  clock.at = 3500;
  f.taskSignal(p, { kind: "resume", at: 3500 }); // the answer went in (Pane.wrote)
  await sweep(3600);
  p.interruptAt = 4000;
  Object.assign(screen, { busy: false, input: true });
  await sweep(6500);
  assert.deepEqual([t.source, t.state, t.reason], ["agent", "cancelled", "interrupted"], "Ctrl-C after answering its question");
  assert.deepEqual(pushed, ["approval"]);
}
console.log("ok   Esc or Ctrl-C ends a turn Claude began by itself cancelled, never completed");

// Pane's own busy, wake and activity, on the clock and timers the test runs.
const paneClass = source.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === "Pane")!;
const paneNames = new Set(["_busy", "busySince", "quietSince", "busy", "waiting", "waitingSince", "workSince", "workAt", "idle", "lastIn", "lastTurnAt", "turnSource", "turns", "opencodeStatus", "activity", "wake"]);
const paneCode = ts.transpileModule(`globalThis.Pane = class {\n${paneClass.members.filter((m) => m.name && paneNames.has(m.name.getText(source))).map((m) => m.getText(source)).join("\n")}\n};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function claudePane() {
  const fx = swept(), timers: { due: number; run: (() => void) | null }[] = [];
  const s = createContext({ Date: class extends Date { static now() { return fx.clock.at; } }, beep() {}, taskbarEnabled: false, loomFocused: true,
    window: { setTimeout: (run: () => void, ms: number) => timers.push({ due: fx.clock.at + ms, run }) }, clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].run = null; } });
  runInContext(paneCode, s);
  const p = Object.assign(new s.Pane(), { id: fx.p.id, generation: 1, agent: "claude", th: fx.th, dead: false, interruptAt: 0, screen: () => "", paint() {} });
  fx.th.panes[fx.th.panes.indexOf(fx.p)] = p;
  const later = (to: number) => {
    for (const t of timers) if (t.run && t.due <= to) ((fx.clock.at = t.due), t.run(), (t.run = null));
    fx.clock.at = to;
  };
  const out = (at: number) => (later(at), p.activity());
  return { ...fx, p, later, out };
}
{
  // A turn Claude begins under an alert nobody has read draws no work on the
  // pane (the alert stays), yet its task starts where its output did, not
  // where the turn before it began.
  const { p, tasks, f, later, out } = claudePane();
  out(10_000); out(10_500);
  later(11_000);
  p.wake(undefined, "bell");
  for (let at = 3_600_000; at < 3_610_000; at += 1000) out(at);
  assert.deepEqual([p.waiting, p.busy], [true, false], "output under an unread alert shows as work");
  later(3_610_000);
  f.taskSignal(p, { kind: "stop", at: 3_610_000 });
  const [t] = [...tasks.values()];
  assert.equal(t.startedAt, 3_600_000, "the turn took the start of the one before it");
}
{
  // Its own bell, and the redraw after it, come before Loom reads its Stop.
  const { p, tasks, f, later, out } = claudePane();
  for (let at = 5000; at < 9000; at += 1000) out(at);
  later(9000);
  p.wake(undefined, "bell");
  out(9200);
  later(9400);
  f.taskSignal(p, { kind: "stop", at: 9050 });
  assert.equal([...tasks.values()][0].startedAt, 5000, "the turn's own bell moved its start");
}
console.log("ok   A turn Claude began by itself starts where its output did, unread alert or not");
for (const [kind, fresh] of [["fail", false], ["approval", false], ["stop", true]] as const) {
  // A person's turn ends (its task completed), and Claude's next turn reports
  // a failure or a question before Loom reads any output of it: the output
  // Loom has is the ended turn's, so the task starts at its report. Output
  // after that task ended is the new turn's.
  const { p, tasks, f, later, out, sweep, screen } = claudePane();
  const prior = f.turnTask(p, "manual", model.promptMatch("A"), 9_000);
  f.enterTurn(prior, 9_000);
  f.taskSignal(p, { kind: "start", at: 9_500, match: prior.match });
  out(10_000); out(10_500);
  later(11_000);
  p.wake(undefined, "bell");
  f.taskSignal(p, { kind: "stop", at: 11_000 });
  screen.input = true;
  later(11_700);
  await sweep(11_700);
  assert.deepEqual([prior.state, prior.endedAt], ["completed", 11_700]);
  if (fresh) out(3_590_000);
  later(3_600_000);
  f.taskSignal(p, { kind, at: 3_600_000, detail: "rate_limit" });
  const t = [...tasks.values()].find((t) => t.source === "agent");
  assert.equal(t.startedAt, fresh ? 3_590_000 : 3_600_000, `${kind}: the turn took the start of the one that ended before it`);
}
console.log("ok   A turn Claude began by itself never starts in a turn that ended before it");
for (const pruned of [false, true]) {
  // A person's task ended an hour ago, and then left the history (only the
  // last 500 to finish stay, keepTasks): Claude's next turn, reporting a
  // failure before any output of its own, still starts at its report.
  const { p, tasks, f, later, out, sweep, screen } = claudePane();
  const prior = f.turnTask(p, "manual", model.promptMatch("A"), 9_000);
  f.enterTurn(prior, 9_000);
  f.taskSignal(p, { kind: "start", at: 9_500, match: prior.match });
  out(10_000); out(10_500);
  later(11_000);
  p.wake(undefined, "bell");
  f.taskSignal(p, { kind: "stop", at: 11_000 });
  screen.input = true;
  later(11_700);
  await sweep(11_700);
  assert.equal(prior.state, "completed");
  if (pruned) {
    for (let i = 0; i < 500; i++) tasks.set(`other-${i}`, { id: `other-${i}`, pane: "pane-2", state: "completed", settledAt: prior.settledAt + (i + 1) / 1000, events: [] });
    f.keepTasks();
    assert.deepEqual([tasks.has(prior.id), tasks.size], [false, 500], "the person's task was pruned");
  }
  later(3_600_000);
  f.taskSignal(p, { kind: "fail", at: 3_600_000, detail: "rate_limit" });
  const t = [...tasks.values()].find((t) => t.source === "agent");
  assert.equal(t.startedAt, 3_600_000, `${pruned ? "pruned" : "kept"}: the turn took the start of one that ended before it`);
}
{
  // Relaunched mid-turn: the old launch's task ends with it (sweepTasks), and
  // the new launch's first report, before any output of its own, starts there.
  const { p, tasks, f, later, out, sweep } = claudePane();
  const prior = f.turnTask(p, "manual", model.promptMatch("A"), 9_000);
  f.enterTurn(prior, 9_000);
  f.taskSignal(p, { kind: "start", at: 9_500, match: prior.match });
  out(10_000); out(10_500);
  p.generation = 2;
  later(11_000);
  await sweep(11_000);
  assert.deepEqual([prior.state, prior.reason], ["cancelled", "pane-restarted"]);
  later(3_600_000);
  f.taskSignal(p, { kind: "fail", at: 3_600_000, detail: "rate_limit" });
  const t = [...tasks.values()].find((t) => t.source === "agent");
  assert.deepEqual([t.gen, t.startedAt], [2, 3_600_000], "the new launch's turn took the old launch's start");
}
console.log("ok   A turn Claude began by itself starts after the pane's last task ended, pruned or relaunched");
for (const first of [11_800, 13_000]) {
  // Claude begins its own turn right after a person's task ended: its first
  // output 1.3 s after the last one (or, the control, 2.5 s after), then a
  // draw every half second for 65 s. Its task runs from that first output.
  const { p, tasks, f, later, out, sweep, screen } = claudePane();
  const prior = f.turnTask(p, "manual", model.promptMatch("A"), 9_000);
  f.enterTurn(prior, 9_000);
  f.taskSignal(p, { kind: "start", at: 9_500, match: prior.match });
  out(10_000); out(10_500);
  later(11_000);
  p.wake(undefined, "bell");
  f.taskSignal(p, { kind: "stop", at: 11_000 });
  screen.input = true;
  later(11_700);
  await sweep(11_700);
  assert.deepEqual([prior.state, p.workSince], ["completed", 0]);
  for (let at = first; at < first + 65_000; at += 500) out(at);
  later(first + 65_000);
  f.taskSignal(p, { kind: "stop", at: first + 65_000 });
  await sweep(first + 65_700);
  const t = [...tasks.values()].find((t) => t.source === "agent");
  assert.deepEqual([t.state, t.startedAt, t.endedAt - t.startedAt], ["completed", first, 65_700], `first output ${first - 10_500} ms after the last`);
}
console.log("ok   A turn Claude began by itself right after a task ended starts at its first output");
