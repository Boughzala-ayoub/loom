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
import { readMenu, readFeedback, cursorKey, menuRev, menuKeys, readSurvey, interruptHint, grokRunning } from "./prompt.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["startupTurns", "startupNotify", "finishTaskReplay", "paneContext", "contextOf", "keepContext", "turnTask", "enterTurn", "moveTask", "taskWrites", "holdSignals", "enterHeld", "taskSignal", "pendingContextTasks", "closedTaskContexts", "agentTurn", "adoptManual", "watched", "sweepTasks", "QUIET_MS", "keepTasks", "taskPruned", "agentReport", "agentEvents", "reportsHeld", "holdReports", "turnsSeen", "turnTasks", "reportsTurns"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`let ${d.getText(source)};`);
}
function fixture(extra: Record<string, unknown> = {}) {
  const th = { id: "thread-1", name: "At Enter", panes: [] as any[] };
  const p: any = { id: "pane-1", generation: 1, agent: "codex", th, manual: [] };
  th.panes.push({}, p);
  const tasks = new Map(), taskWatch = new Map();
  const s = createContext({ ...model, crypto, console, tasks, taskSeq: 0, unsaved: new Set(), taskWatch, heldEnter: new Map(),
    paneById: (id: string) => th.panes.find((p) => p.id === id), paneTitle: () => "Agent session", paneName: () => "work:2",
    journal: async () => {}, sweepSoon() {}, pruneSettled, keepReceipts() {}, ...extra });
  runInContext(ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { turnTask, enterTurn, keepContext, finishTaskReplay, holdSignals, taskSignal, contextOf, sweepTasks, keepTasks, agentReport, agentEvents, holdReports, reportsHeld, reportsTurns, moveTask, turnTasks, watched };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
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
const paneNames = new Set(["_busy", "busySince", "quietSince", "busy", "waiting", "waitingSince", "workSince", "workAt", "idle", "lastIn", "lastTurnAt", "turnSource", "turns", "opencodeStatus", "codexAsking", "cursorTurn", "grokStop", "grokIdleSince", "grokTimer", "grokBusy", "grokReport", "grokSettle", "grokEnd", "cursorGen", "cursorEsc", "cursorEscs", "cursorAsking", "cursorAnswered", "cursorFeedback", "cursorQuestion", "cursorAsks", "cursorAskLater", "cursorAskSoon", "cursorPrompted", "answeredCursor", "sending", "cursorRuns", "programState", "activity", "wake", "seen", "wrote", "answers", "programStatus", "mark", "commands", "lastFailed", "lastExit", "atPrompt", "receiptRunning"]);
const paneCode = ts.transpileModule(`globalThis.Pane = class {\n${paneClass.members.filter((m) => m.name && paneNames.has(m.name.getText(source))).map((m) => m.getText(source)).join("\n")}\n};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function claudePane(extra: Record<string, unknown> = {}) {
  const fx = swept(), timers: { due: number; run: (() => void) | null }[] = [];
  const s = createContext({ Date: class extends Date { static now() { return fx.clock.at; } }, beep() {}, taskbarEnabled: false, loomFocused: true, dashboardOpen: false, TextDecoder, atob, taskSignal: fx.f.taskSignal, agentReport: fx.f.agentReport, moveTask: fx.f.moveTask, holdReports: fx.f.holdReports, reportsHeld: fx.f.reportsHeld, reportsTurns: fx.f.reportsTurns, tasks: fx.tasks, ...extra,
    window: { setTimeout: (run: () => void, ms: number) => timers.push({ due: fx.clock.at + ms, run }) }, clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].run = null; } });
  runInContext(paneCode, s);
  const p = Object.assign(new s.Pane(), { id: fx.p.id, generation: 1, agent: "claude", th: fx.th, dead: false, interruptAt: 0, manual: [], screen: () => "", paint() {} });
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
{
  // OMP between turns takes a person's Enter, then says itself what its turn
  // does (OSC 7501), drawing its prompt in the transcript between OSC 133
  // marks meanwhile: working through them, asking, answered, done. Its task
  // and its pane go as a Claude or Codex turn's do.
  const { p, tasks, pushed, clock, later } = claudePane();
  const say = async (d: string) => (p.programStatus(`state=${d}:app=omp`), await new Promise((r) => setTimeout(r, 0)));
  p.agent = "omp";
  await say("idle");
  clock.at = 1000;
  p.manual = [{ at: 1000, launch: 1, match: null }]; // manualEnter, at the Enter
  await say("working");
  for (const m of ["A", "B", "C", "D;0"]) p.mark(m);
  assert.equal(p.busy, true, "OMP's D;0 ended the turn it said was working");
  later(5000);
  p.activity();
  const [t, ...more] = [...tasks.values()];
  assert.equal(more.length, 0);
  assert.deepEqual([p.busy, p.waiting, p.commands, p.atPrompt], [true, false, 0, false], "its transcript's marks read as a shell's");
  assert.deepEqual([t.source, t.state, t.correlation, t.startedAt], ["manual", "working", "sequence", 1000]);
  await say(`blocked:kind=question:msg=${btoa("Which database?")}`);
  assert.deepEqual([p.busy, p.waiting, t.state, t.detail], [false, true, "approval", "Which database?"], "asking");
  p.seen();
  await say("working");
  assert.deepEqual([p.busy, t.state], [true, "working"], "answered");
  later(9000);
  await say("done");
  assert.deepEqual([p.busy, p.waiting, t.state, t.endedAt], [false, true, "completed", 9000], "done");
  assert.deepEqual(pushed, ["approval", "completed"]);
  p.wake(undefined, "bell"); // OMP rings after it, as it notifies
  assert.equal(p.turns, 0, "its bell counted a turn its report had");
  // A turn sent from elsewhere under the unread alert: working once it's read.
  await say("working");
  assert.deepEqual([p.busy, p.waiting], [false, true]);
  p.seen();
  assert.equal(p.busy, true, "read, the alert gave way to its work");
}
for (const [end, state, notice] of [["idle", "cancelled", []], ["error:msg=" + btoa("rate limited"), "failed", ["failed"]], ["clear", "cancelled", []]] as const) {
  // Esc stops the turn (idle), it fails (error), or OMP quits mid-turn (clear).
  const { p, pushed, clock, f } = claudePane();
  p.agent = "omp";
  p.programStatus("state=idle");
  const t = f.turnTask(p, "submit", "", 1000);
  f.enterTurn(t, 1000);
  clock.at = 2000;
  p.programStatus("state=working");
  p.programStatus(`state=${end}`);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.busy, p.waiting, pushed], [state, false, state === "failed", notice], end);
  if (state === "failed") assert.equal(t.detail, "rate limited");
}
{
  // Once OMP has quit, its shell's prompt has the pane, and its marks count.
  const { p } = claudePane();
  p.agent = "omp";
  p.programStatus("state=idle");
  p.programStatus("state=clear");
  p.mark("C");
  assert.equal(p.busy, true, "a command at the shell's prompt");
  p.mark("D;0");
  assert.deepEqual([p.busy, p.commands], [false, 1]);
}
console.log("ok   OMP's own reports (OSC 7501) move its pane and its tasks as Claude's and Codex's do");
// Cursor's CLI (2026.10.01): an approval as its screen draws it, and its composer.
const CURSOR_ASK = ` $  echo hi in .

 Run this command?
 Not in allowlist: echo
  → Run (once) (y)
    Add Shell(echo) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)
`;
const cursorPane = (view: { text: string }, extra: Record<string, unknown> = {}) => {
  const c = claudePane({ readMenu, readFeedback, cursorKey, menuRev, menuKeys, readSurvey, interruptHint, grokRunning, screenCells: () => [], liveScreen: () => view.text, turnReceipts() {}, ...extra });
  c.p.agent = "cursor";
  return c;
};
{
  // Cursor's hooks say when its turn starts (cursor:busy, then the start that
  // names its prompt) and ends (cursor:done, then its end). Its approval shows
  // on the screen alone, and stays drawn a moment after its answer. Its task
  // and its pane go as a Claude turn's do.
  const view = { text: "  → Add a follow-up\n" };
  const { p, tasks, pushed, clock, later, f } = cursorPane(view);
  clock.at = p.lastIn = 1000;
  p.manual = [{ at: 1000, launch: 1, match: null }]; // manualEnter, at the Enter
  p.wake("cursor:busy", "hook");
  f.agentReport(p, { kind: "start", at: 1200, launch: 1, match: model.promptMatch("run echo hi"), turn: "g1" });
  const [t, ...more] = [...tasks.values()];
  assert.equal(more.length, 0);
  assert.deepEqual([p.busy, p.waiting, t.source, t.state, t.startedAt], [true, false, "manual", "working", 1200], "working");
  clock.at = 3000;
  view.text = CURSOR_ASK;
  p.activity();
  assert.deepEqual([p.busy, p.waiting, t.state, t.detail], [false, true, "approval", "$  echo hi in . Run this command? Not in allowlist: echo"], "asking");
  p.activity();
  assert.equal(p.turns, 1, "one question, one alert");
  clock.at = p.lastIn = 3500; // Enter on "Run (once)"
  p.wrote("\r", true, p.sending("\r"));
  p.seen();
  assert.deepEqual([p.busy, p.waiting, t.state, p.turns], [true, false, "working", 1], "answered, its menu still drawn");
  view.text = " ⠰⠳ Working\n\n  → Add a follow-up        ctrl+c to stop\n";
  p.activity();
  later(9000);
  p.wake("cursor:done", "hook");
  f.agentReport(p, { kind: "end", at: 9000, launch: 1, turn: "g1" });
  f.agentReport(p, { kind: "end", at: 9000, launch: 1, turn: "g1" });
  assert.deepEqual([p.busy, p.waiting, t.state, t.endedAt, p.turns], [false, true, "completed", 9000, 2], "done");
  await new Promise((r) => setTimeout(r, 0)); // notices go out once the journal has the event
  assert.deepEqual(pushed, ["approval", "completed"]);
}
// What Cursor's hooks say of turn `gen` when it stops: the marker the pane
// wakes on, then the report its task moves on (stop: aborted, error or completed).
const cursorStop = (c: ReturnType<typeof cursorPane>, end: string, gen: string, at = c.clock.at) => {
  c.p.wake(`cursor:${end}`, "hook");
  c.f.agentReport(c.p, end === "aborted" ? { kind: "interrupt", at, launch: 1, turn: gen }
    : end === "error" ? { kind: "fail", at, launch: 1, detail: "Cursor reported an error", turn: gen } : { kind: "end", at, launch: 1, turn: gen });
};
const cursorPrompt = (c: ReturnType<typeof cursorPane>, prompt: string, gen: string) => {
  const t = c.f.turnTask(c.p, "submit", model.promptMatch(prompt), c.clock.at);
  c.f.enterTurn(t, c.clock.at);
  c.p.wake("cursor:busy", "hook");
  c.f.agentReport(c.p, { kind: "start", at: c.clock.at + 100, launch: 1, match: t.match, turn: gen });
  return t;
};
for (const order of [["aborted", "error"], ["error", "aborted"]]) {
  // Esc: Cursor reports the turn it stopped aborted and failed, either first,
  // both naming it. It's cancelled, and raises no alert.
  const c = cursorPane({ text: "" });
  const { p, tasks, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2100;
  for (const end of order) cursorStop(c, end, "gA");
  await new Promise((r) => setTimeout(r, 0)); // notices go out once the journal has the event
  assert.deepEqual([t.state, p.busy, p.waiting, pushed, tasks.size], ["cancelled", false, false, [], 1], order.join(" then "));
}
{
  // An error with no Esc before it fails the turn, and raises the alert.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 60_000;
  cursorStop(c, "error", "gA");
  await new Promise((r) => setTimeout(r, 0)); // notices go out once the journal has the event
  assert.deepEqual([t.state, p.busy, p.waiting, pushed], ["failed", false, true, ["failed"]]);
}
for (const late of [null, "aborted", "error"]) {
  // Esc stops turn A, and B, sent a second later, fails for real 2 s after
  // the Esc: B fails and raises the alert. With `late`, one of A's two stops
  // lands only after B started: A ends on the other, and B runs on.
  const c = cursorPane({ text: "" });
  const { p, tasks, pushed, clock } = c;
  clock.at = 60_000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 61_000;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 61_100;
  for (const end of ["aborted", "error"]) if (end !== late) cursorStop(c, end, "gA");
  clock.at = 62_000;
  const b = cursorPrompt(c, "B", "gB");
  if (late) {
    clock.at = 62_500;
    cursorStop(c, late, "gA");
    assert.deepEqual([a.state, b.state, p.busy, p.waiting], ["cancelled", "working", true, false], `A's late ${late} leaves B working`);
  }
  clock.at = 63_000;
  cursorStop(c, "error", "gB");
  await new Promise((r) => setTimeout(r, 0)); // notices go out once the journal has the event
  assert.deepEqual([a.state, b.state, p.busy, p.waiting, pushed, tasks.size], ["cancelled", "failed", false, true, ["failed"], 2], `late ${late}`);
}
{
  // Ctrl-C between turns interrupts nothing: the next turn's error is its own.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock } = c;
  clock.at = 1000;
  cursorPrompt(c, "A", "gA");
  clock.at = 5000;
  cursorStop(c, "completed", "gA");
  clock.at = 6000;
  p.wrote("\x03", true, p.sending("\x03"));
  clock.at = 7000;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 8000;
  cursorStop(c, "error", "gB");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([b.state, p.waiting, pushed], ["failed", true, ["completed", "failed"]]);
}
{
  // Tab picks an approval's allowlist option, "(tab)" (Cursor's allowlistApprove):
  // an answer. The next approval, drawn straight over it, asks again.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = p.lastIn = 3000;
  const sent = p.sending("\t");
  p.wrote("\t", true, sent);
  p.seen();
  assert.deepEqual([sent.answer, p.waiting, t.state], [true, false, "working"], "Tab answered the approval");
  view.text = CURSOR_ASK.replace("echo hi", "echo next").replace("Not in allowlist: echo", "Not in allowlist: next");
  p.activity();
  assert.deepEqual([p.waiting, t.state, t.detail], [true, "approval", "$  echo next in . Run this command? Not in allowlist: next"], "the next approval asks");
  view.text = "  → Add a follow-up\n";
  assert.equal(p.answers("\t"), false, "Tab in the composer answers nothing");
}
for (const key of ["\x1b", "\x03"]) {
  // Esc on an approval is its "Skip & tell the agent what to do instead"
  // (Cursor's propose), and Ctrl-C there rejects it: an answer to that one
  // question, after which the turn goes on. A genuine error later in that
  // turn fails it, and raises the alert.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 3000;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = p.lastIn = 4000;
  p.wrote(key, true, p.sending(key));
  p.seen();
  view.text = "  → Add a follow-up        ctrl+c to stop\n"; // its feedback, typed in the composer
  p.activity();
  clock.at = p.lastIn = 5000;
  p.wrote("\r", true, p.sending("\r"));
  p.seen();
  clock.at = 60_000;
  cursorStop(c, "error", "gA");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], ["failed", true, ["approval", "failed"]], JSON.stringify(key));
}
// Cursor's rejection feedback, asked after Esc picks an approval's "Skip &
// tell the agent what to do instead": its composer's placeholder (2026.10.01).
const CURSOR_FEEDBACK = "  → Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)   ctrl+c to stop\n";
const CURSOR_WORKING = "  → Add a follow-up        ctrl+c to stop\n";
for (const [how, steps, stopped] of [
  // Esc on the approval asks for feedback (Cursor's propose). Ctrl-C there
  // skips the feedback (onSkipRejectionReason), typed or not, as an empty
  // Enter does, and Esc goes back to the approval (onCancelRejectionReason),
  // still asked: the task asks on with no new notice. Ctrl-C on the approval
  // rejects it. None of these stops the turn: Cursor and the task work on, and
  // the turn's genuine error later fails it.
  ["skipped", [["\x1b", CURSOR_FEEDBACK], ["\x03", CURSOR_WORKING]], false],
  ["typed, then skipped", [["\x1b", CURSOR_FEEDBACK], ["use ls", "  → use ls\n"], ["\x03", CURSOR_WORKING]], false],
  ["skipped with Enter", [["\x1b", CURSOR_FEEDBACK], ["\r", CURSOR_WORKING]], false],
  ["back to the approval", [["\x1b", CURSOR_FEEDBACK], ["\x1b", CURSOR_ASK], ["y", CURSOR_WORKING]], false],
  ["back, then rejected", [["\x1b", CURSOR_FEEDBACK], ["\x1b", CURSOR_ASK], ["\x03", CURSOR_WORKING]], false],
  ["rejected", [["\x03", CURSOR_WORKING]], false],
  // Skipped, sent or rejected, the question is over: the next Ctrl-C or Esc stops the turn.
  ["skipped, then stopped", [["\x1b", CURSOR_FEEDBACK], ["\x03", CURSOR_WORKING], ["\x03", CURSOR_WORKING]], true],
  ["sent, then stopped", [["\x1b", CURSOR_FEEDBACK], ["use ls", "  → use ls\n"], ["\r", CURSOR_WORKING], ["\x1b", CURSOR_WORKING]], true],
  ["rejected, then stopped", [["\x03", CURSOR_WORKING], ["\x1b", CURSOR_WORKING]], true],
] as const) for (const redrawFirst of [false, true]) {
  // `redrawFirst`: Cursor's redraw after each key lands before the write's
  // acknowledgement (two native threads, no order between them). What a key
  // means is read as it's typed (answers), before either.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 3000;
  view.text = CURSOR_ASK;
  p.activity();
  for (const [key, after] of steps) {
    clock.at = p.lastIn = clock.at + 1000;
    const sent = p.sending(key);
    const redraw = () => ((view.text = after), p.activity());
    if (redrawFirst) redraw();
    p.wrote(key, true, sent);
    p.seen();
    if (!redrawFirst) redraw();
  }
  const what = `${how}${redrawFirst ? ", redrawn before the write's acknowledgement" : ""}`;
  assert.deepEqual([t.state, p.busy, p.waiting], ["working", true, false], `${what}: Cursor works on`);
  clock.at = 60_000;
  for (const end of stopped ? ["aborted", "error"] : ["error"]) cursorStop(c, end, "gA");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], stopped ? ["cancelled", false, ["approval"]] : ["failed", true, ["approval", "failed"]], what);
}
for (const key of ["y", "\t", "\r", "\x03"]) {
  // The answer to approval 1 goes in, and Cursor draws approval 2 before the
  // write is acknowledged. Approval 1 is the one answered: approval 2 still
  // asks, with its own notice, and the pane waits on it.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 3000;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = p.lastIn = 4000;
  const sent = p.sending(key);
  view.text = CURSOR_ASK.replace("echo hi", "echo next").replace("Not in allowlist: echo", "Not in allowlist: next");
  p.activity();
  clock.at = 4001;
  // As the pane's writer does: an alert raised during the write stays.
  const since = p.waitingSince;
  p.wrote(key, true, sent);
  if (p.waitingSince === since) p.seen();
  p.activity();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([p.cursorAsking, p.busy, p.waiting, t.state, t.detail, pushed], [true, false, true, "approval", "$  echo next in . Run this command? Not in allowlist: next", ["approval", "approval"]], JSON.stringify(key));
}
// Cursor's approvals by kind (2026.10.01 decision-logic), each option ending
// in the keys that pick it. Shell's and Write's Esc and n propose, which asks
// for feedback, and so does p. MCP's, Read's, a web search's and fetch's Esc
// and n pick "Skip", which rejects, and Delete's Esc rejects too ("Keep").
const cursorMenuOf = (question: string, options: string[]) => ` ${question}\n${options.map((o, i) => `${i ? "    " : "  → "}${o}`).join("\n")}\n`;
const CURSOR_MCP = cursorMenuOf("Run this MCP tool?", ["Run (once) (y)", "Allowlist MCP Tool (tab)", "Reject & propose changes (p)", "Skip (esc or n)"]);
for (const [kind, menu, key, settles] of [
  ["shell", CURSOR_ASK, "\x1b", false],
  ["shell", CURSOR_ASK, "n", false],
  ["write", cursorMenuOf("Write to this file?", ["Proceed (y)", "Reject & propose changes (esc or n or p)", "Add to allowlist (tab)"]), "p", false],
  ["MCP", CURSOR_MCP, "p", false],
  ["MCP", CURSOR_MCP, "\x1b", true],
  ["read", cursorMenuOf("Read this file?", ["Allow once (y)", "Skip (esc or n)"]), "n", true],
  ["delete", cursorMenuOf("Delete this file?", ["Delete (y)", "Keep (n)"]), "\x1b", true],
] as const) {
  // One that settles the question resumes the task, and one that asks for
  // feedback leaves it asking. Neither stops the turn: its genuine error fails it.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 3000;
  view.text = menu;
  p.activity();
  clock.at = p.lastIn = 4000;
  p.wrote(key, true, p.sending(key));
  p.seen();
  view.text = settles ? CURSOR_WORKING : CURSOR_FEEDBACK;
  p.activity();
  const what = `${JSON.stringify(key)} on ${kind}'s approval`;
  assert.equal(t.state, settles ? "working" : "approval", what);
  clock.at = 60_000;
  cursorStop(c, "error", "gA");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], ["failed", true, ["approval", "failed"]], what);
}
for (const screen of [CURSOR_ASK, CURSOR_FEEDBACK]) {
  // A Ctrl-C whose write failed may or may not have gone in: the task still
  // asks, its answer in doubt.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, clock } = c;
  clock.at = 1000;
  const t = cursorPrompt(c, "A", "gA");
  clock.at = 3000;
  view.text = CURSOR_ASK;
  p.activity();
  view.text = screen;
  p.activity();
  clock.at = p.lastIn = 4000;
  p.wrote("\x03", false, p.sending("\x03"));
  assert.deepEqual([t.state, t.answerInDoubt], ["approval", true], screen === CURSOR_ASK ? "the approval" : "its feedback");
}
for (const order of [["aborted", "error"], ["error", "aborted"]]) {
  // Esc stops A, and B starts before either of A's stops lands. They end A,
  // the task A's start moved, and leave B working; B's end completes B alone.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2100;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 2300;
  for (const end of order) cursorStop(c, end, "gA");
  assert.deepEqual([a.state, b.state, p.busy, p.waiting], ["cancelled", "working", true, false], `A's ${order.join(" then ")} after B started`);
  clock.at = 3000;
  cursorStop(c, "completed", "gB");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([a.state, b.state, p.waiting, pushed], ["cancelled", "completed", true, ["completed"]], `then B's end, ${order.join(" then ")}`);
}
{
  // A fails for real, its report landing after B started: A fails, B works on and completes.
  const c = cursorPane({ text: "" });
  const { clock } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2100;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 2300;
  cursorStop(c, "error", "gA");
  assert.deepEqual([a.state, b.state], ["failed", "working"]);
  clock.at = 3000;
  cursorStop(c, "completed", "gB");
  assert.deepEqual([a.state, b.state], ["failed", "completed"]);
}
for (const order of [["error", "aborted"], ["aborted", "error"]]) for (const onePoll of [false, true]) {
  // Esc goes in before Loom has read the turn's first hooks (no cursorTurn or
  // cursorGen yet). Its start, stamped before the Esc, ties the Esc to it, so
  // both stops read as the interrupt, in either order. `onePoll`: all of it
  // lands in one 250 ms poll, so the wake marker (the last stop's: each
  // replaces the one before) comes before any report. A later turn's
  // genuine error is its own.
  const c = cursorPane({ text: "" });
  const { p, tasks, pushed, clock, f } = c;
  clock.at = 1000;
  const t = f.turnTask(p, "submit", model.promptMatch("A"), 1000);
  f.enterTurn(t, 1000);
  clock.at = 1100;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 1300;
  const start = () => f.agentReport(p, { kind: "start", at: 1050, launch: 1, match: t.match, turn: "gA" });
  const report = (end: string) => f.agentReport(p, end === "aborted" ? { kind: "interrupt", at: 1200, launch: 1, turn: "gA" } : { kind: "fail", at: 1200, launch: 1, detail: "Cursor reported an error", turn: "gA" });
  if (onePoll) {
    p.wake(`cursor:${order[1]}`, "hook");
    start();
    order.forEach(report);
  } else {
    p.wake("cursor:busy", "hook");
    start();
    for (const end of order) (p.wake(`cursor:${end}`, "hook"), report(end));
  }
  await new Promise((r) => setTimeout(r, 0));
  const what = `${order.join(" then ")}${onePoll ? ", in one poll" : ""}`;
  assert.deepEqual([t.state, p.busy, p.waiting, pushed, tasks.size], ["cancelled", false, false, [], 1], what);
  clock.at = 2000;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 3000;
  cursorStop(c, "error", "gB");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([b.state, p.waiting, pushed], ["failed", true, ["failed"]], `then B's own error, ${what}`);
}
// loomctl send --receipt's receipts, finished by the production finishReceipt and turnReceipts.
const receiptCode = ts.transpileModule(source.statements.filter((n) => ts.isFunctionDeclaration(n) && ["finishReceipt", "turnReceipts"].includes(n.name!.text)).map((n) => n.getText(source)).join("\n")
  + "\nglobalThis.turnReceipts = turnReceipts;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const end of ["error", "completed"]) {
  // A's stop lands after B started. It ends A's task, which notifies, and
  // leaves B's pane working and B's receipt waiting until B's own end.
  const receipts = new Map<string, any>([["B", { pane: "pane-1", gen: 1, turnsAt: 0, acceptedAt: 2100, steps: { entering: 2100, submitted: 2100 } }]]);
  const scope = createContext({ receipts, settlings: 0, keepReceipts() {} });
  runInContext(receiptCode, scope);
  const c = cursorPane({ text: "" }, { turnReceipts: scope.turnReceipts });
  const { p, pushed, clock } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2100;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 2300;
  cursorStop(c, end, "gA");
  await new Promise((r) => setTimeout(r, 0));
  const ended = end === "error" ? "failed" : "completed";
  assert.deepEqual([a.state, b.state, p.busy, p.waiting, p.turns, receipts.get("B").result?.turn ?? null, pushed], [ended, "working", true, false, 0, null, [ended]], `A's late ${end}`);
  clock.at = 5000;
  cursorStop(c, "completed", "gB");
  assert.deepEqual([b.state, p.busy, p.waiting, p.turns, receipts.get("B").result?.turn], ["completed", false, true, 1, 1], `then B's end, after A's ${end}`);
}
for (const end of ["error", "completed"]) {
  // A stops at 2000 and B's Enter goes in at 2050, both before the poll at
  // 2200 that reads A's stop, then B's start. A's stop ends A and counts its
  // turn, but B's receipt waits for a turn that stopped after its Enter: B's own.
  const receipts = new Map<string, any>([["B", { pane: "pane-1", gen: 1, acceptedAt: 2050, steps: { entering: 2050, submitted: 2050 } }]]);
  const scope = createContext({ receipts, settlings: 0, keepReceipts() {} });
  runInContext(receiptCode, scope);
  const c = cursorPane({ text: "" }, { turnReceipts: scope.turnReceipts });
  const { p, pushed, clock, f } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2050;
  receipts.get("B").turnsAt = p.turns;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2050);
  f.enterTurn(b, 2050);
  clock.at = 2200;
  cursorStop(c, end, "gA", 2000);
  f.agentReport(p, { kind: "start", at: 2100, launch: 1, match: b.match, turn: "gB" });
  await new Promise((r) => setTimeout(r, 0));
  const ended = end === "error" ? "failed" : "completed";
  assert.deepEqual([a.state, b.state, p.busy, p.waiting, p.turns, receipts.get("B").result?.turn ?? null, pushed], [ended, "working", true, false, 1, null, [ended]], `A's ${end} before B's Enter`);
  clock.at = 5000;
  cursorStop(c, "completed", "gB");
  assert.deepEqual([b.state, p.busy, p.waiting, p.turns, receipts.get("B").result?.turn], ["completed", false, true, 2, 2], `then B's end, after A's ${end}`);
}
{
  // One poll reads B's start and A's late stops: every hook keeps its report,
  // but each replaces the pane's one wake marker, and Rust sends that marker
  // (A's error) before the reports. The reports, in order, say B runs.
  const c = cursorPane({ text: "" });
  const { p, clock, f, sweep } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2100;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2100);
  f.enterTurn(b, 2100);
  clock.at = 2300;
  p.wake("cursor:error", "hook");
  f.agentReport(p, { kind: "start", at: 2150, launch: 1, match: b.match, turn: "gB" });
  f.agentReport(p, { kind: "interrupt", at: 2200, launch: 1, turn: "gA" });
  f.agentReport(p, { kind: "fail", at: 2250, launch: 1, detail: "Cursor reported an error", turn: "gA" });
  assert.deepEqual([a.state, b.state, p.cursorTurn, p.cursorGen, p.busy, p.waiting], ["cancelled", "working", true, "gB", true, false], "B runs");
  p.activity();
  await sweep(2400);
  await sweep(32_400);
  assert.deepEqual([b.state, b.reason, p.busy], ["working", null, true], "still running 30 s on");
  // A start from a launch before this one moves neither the pane nor its turn.
  f.agentReport(p, { kind: "start", at: 32_500, launch: 0, match: b.match, turn: "gOld" });
  assert.deepEqual([p.cursorGen, p.cursorTurn], ["gB", true], "a replaced launch's start");
  // C's start and its own end in one poll, with only C's done marker left.
  clock.at = 40_000;
  cursorStop(c, "completed", "gB");
  clock.at = p.lastIn = 41_000;
  const t = f.turnTask(p, "submit", model.promptMatch("C"), 41_000);
  f.enterTurn(t, 41_000);
  clock.at = 41_300;
  p.seen();
  p.wake("cursor:done", "hook");
  f.agentReport(p, { kind: "start", at: 41_050, launch: 1, match: t.match, turn: "gC" });
  f.agentReport(p, { kind: "end", at: 41_200, launch: 1, turn: "gC" });
  assert.deepEqual([t.state, p.cursorTurn, p.cursorGen, p.busy, p.waiting], ["completed", false, "gC", false, true], "a start and its own end in one poll");
}
for (const [first, second] of [["error", "aborted"], ["aborted", "error"]]) for (const interleaved of [false, true]) {
  // Esc stops A, then B, before either's stops land. Each keeps its own
  // interruption, so both end cancelled with no alert, whichever stop comes
  // first and however the two turns' stops mix. A third turn that nobody
  // stopped still fails for real.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2100;
  const b = cursorPrompt(c, "B", "gB");
  clock.at = 2200;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2300;
  const stops: [string, string][] = interleaved ? [[first, "gA"], [first, "gB"], [second, "gA"], [second, "gB"]] : [[first, "gA"], [second, "gA"], [first, "gB"], [second, "gB"]];
  for (const [end, gen] of stops) cursorStop(c, end, gen);
  await new Promise((r) => setTimeout(r, 0));
  const what = `${first} then ${second}${interleaved ? ", interleaved" : ""}`;
  assert.deepEqual([a.state, b.state, p.busy, p.waiting, pushed], ["cancelled", "cancelled", false, false, []], what);
  clock.at = 3000;
  const t = cursorPrompt(c, "C", "gC");
  clock.at = 4000;
  cursorStop(c, "error", "gC");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], ["failed", true, ["failed"]], `then C's own error, ${what}`);
}
for (const order of [["error", "aborted"], ["aborted", "error"]]) {
  // A fails for real at 2000, unread when B's Enter (2050) and B's start
  // (2100) go by, and an Esc stops B at 2150. Loom still has A running, so
  // the Esc goes to A too, but A's failure came before it: it's A's own.
  // B's start, before the Esc, takes it.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock, f } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2050;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2050);
  f.enterTurn(b, 2050);
  clock.at = 2150;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2200;
  cursorStop(c, "error", "gA", 2000);
  f.agentReport(p, { kind: "start", at: 2100, launch: 1, match: b.match, turn: "gB" });
  order.forEach((end, i) => cursorStop(c, end, "gB", 2170 + 10 * i));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([a.state, b.state, pushed], ["failed", "cancelled", ["failed"]], `A's error, then B's ${order.join(" then ")}`);
}
for (const [how, began, stops, delivered, end] of [
  // Esc goes in at 2000 while A works. Cursor writes its error and aborted for
  // gA, either first, and the poll at 2250 reads both before the write's
  // acknowledgement at 2300. The reports wait for that outcome, then A ends
  // cancelled, with no alert.
  ["error first", undefined, [["fail", 2010], ["interrupt", 2020]], true, "cancelled"],
  ["aborted first", undefined, [["interrupt", 2010], ["fail", 2020]], true, "cancelled"],
  // A's genuine error, written before the Esc went in, is its own: before the
  // key was typed, or while the pane's writer still wrote what came before it
  // (it began writing the Esc at 2100).
  ["error before the Esc", undefined, [["fail", 1990]], true, "failed"],
  ["error before the writer began", 2100, [["fail", 2050]], true, "failed"],
  // An Esc whose write failed may not have gone in: the error stays A's own.
  ["write failed", undefined, [["fail", 2010]], false, "failed"],
] as const) {
  const c = cursorPane({ text: "" });
  const { p, pushed, clock, f } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2000;
  const sent = p.sending("\x1b");
  clock.at = 2250;
  f.agentEvents(stops.map(([kind, t]) => [p.id, { kind, t, launch: 1, turn: "gA", ...(kind === "fail" ? { detail: "Cursor reported an error" } : {}) }]));
  assert.equal(a.state, "working", `${how}: the reports wait for the write`);
  clock.at = 2300;
  p.wrote("\x1b", delivered, sent, began);
  await new Promise((r) => setTimeout(r, 0));
  const failed = end === "failed";
  assert.deepEqual([a.state, p.waiting, pushed], [end, failed, failed ? ["failed"] : []], how);
}
for (const escA of [false, true]) for (const order of [["error", "aborted"], ["aborted", "error"]]) {
  // One poll at 2200 reads both turns' hooks, neither start heard before it.
  // A's Enter goes in at 2000 (its start 2020), B's at 2090 (2110), and an
  // Esc at 2150 stops B. `escA`: an Esc at 2050 stopped A too, before A's
  // stops (2070, 2080), so both are cancelled. Otherwise A failed for real at
  // 2060, before any Esc, and that failure is its own.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock, f } = c;
  clock.at = 2000;
  const a = f.turnTask(p, "submit", model.promptMatch("A"), 2000);
  f.enterTurn(a, 2000);
  if (escA) (clock.at = 2050), p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2090;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2090);
  f.enterTurn(b, 2090);
  clock.at = 2150;
  p.wrote("\x1b", true, p.sending("\x1b"));
  clock.at = 2200;
  f.agentReport(p, { kind: "start", at: 2020, launch: 1, match: a.match, turn: "gA" });
  if (escA) order.forEach((end, i) => cursorStop(c, end, "gA", 2070 + 10 * i));
  else cursorStop(c, "error", "gA", 2060);
  f.agentReport(p, { kind: "start", at: 2110, launch: 1, match: b.match, turn: "gB" });
  order.forEach((end, i) => cursorStop(c, end, "gB", 2170 + 10 * i));
  await new Promise((r) => setTimeout(r, 0));
  const what = `${escA ? "Esc on A and on B" : "A's error, Esc on B"}, ${order.join(" then ")}`;
  assert.deepEqual([a.state, b.state, p.busy, p.waiting, pushed], escA ? ["cancelled", "cancelled", false, false, []] : ["failed", "cancelled", false, false, ["failed"]], what);
}
for (const seen of [false, true]) {
  // A's Enter goes in at 2000, its start is stamped 2020, and Cursor draws its
  // approval at 2140, before the poll at 2200 that reads the start. The
  // approval then asks in the task the start moves, with one notice, and the
  // pane still waits (`seen`: unless the alert was read before the poll).
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock, f } = c;
  clock.at = p.lastIn = 2000;
  const t = f.turnTask(p, "submit", model.promptMatch("A"), 2000);
  f.enterTurn(t, 2000);
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  if (seen) p.seen();
  clock.at = 2200;
  f.agentEvents([[p.id, { kind: "start", t: 2020, launch: 1, match: t.match, turn: "gA" }]]); // the poll's batch, as Rust sends it
  p.activity();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([p.cursorAsking, p.busy, p.waiting, t.state, t.detail, pushed], [true, false, !seen, "approval", "$  echo hi in . Run this command? Not in allowlist: echo", ["approval"]], `seen ${seen}`);
  // Answered, the turn works on and ends as any turn does.
  clock.at = p.lastIn = 3000;
  p.wrote("y", true, p.sending("y"));
  p.seen();
  view.text = "  → Add a follow-up        ctrl+c to stop\n";
  p.activity();
  assert.deepEqual([p.busy, p.waiting, t.state], [true, false, "working"], `answered, seen ${seen}`);
  clock.at = 4000;
  cursorStop(c, "completed", "gA");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], ["completed", true, ["approval", "completed"]], `done, seen ${seen}`);
}
for (const lateEnd of [false, true]) {
  // One poll at 2200 reads A's start (2020) and end (2060), then B's start
  // (2110), after Cursor drew B's approval at 2140. The approval asks in B's
  // task alone, once the batch has said B's turn runs. `lateEnd`: A's slow stop
  // hook lands in the next poll, after B's start, and A still never asks.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock, f } = c;
  clock.at = p.lastIn = 2000;
  const a = f.turnTask(p, "submit", model.promptMatch("A"), 2000);
  f.enterTurn(a, 2000);
  clock.at = p.lastIn = 2090;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2090);
  f.enterTurn(b, 2090);
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = 2200;
  const endA = [p.id, { kind: "end", t: 2060, launch: 1, turn: "gA" }];
  f.agentEvents([[p.id, { kind: "start", t: 2020, launch: 1, match: a.match, turn: "gA" }], ...(lateEnd ? [] : [endA]), [p.id, { kind: "start", t: 2110, launch: 1, match: b.match, turn: "gB" }]]);
  if (lateEnd) (clock.at = 2450), f.agentEvents([endA]);
  p.activity();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([a.state, a.detail, [...a.events].map((e: any) => e.state), b.state, [...b.events].filter((e: any) => e.state === "approval").length, p.waiting, pushed],
    ["completed", null, ["accepted", "submitted", "working", "completed"], "approval", 1, true, lateEnd ? ["approval", "completed"] : ["completed", "approval"]], `A's end ${lateEnd ? "a poll later" : "in the same poll"}`);
}
for (const pending of ["task", "manual"]) {
  // Loom knows A runs (gA). Cursor ends A at 2060, B's Enter goes in at 2090,
  // B's start is written at 2110, and B's approval draws at 2140, before the
  // poll at 2200 reads A's end and B's start. With a prompt waiting for its
  // start (a task's Enter, or a person's noted one), the approval asks in no
  // task until that poll, then in B's. The pane waits at once.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, tasks, pushed, clock, f, later } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2090;
  const match = model.promptMatch("B");
  if (pending === "task") f.enterTurn(f.turnTask(p, "submit", match, 2090), 2090);
  else p.manual = [{ at: 2090, launch: 1, match: null }];
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  assert.deepEqual([a.state, p.waiting], ["working", true], `${pending}: B's approval, before the poll`);
  clock.at = 2200;
  f.agentEvents([[p.id, { kind: "end", t: 2060, launch: 1, turn: "gA" }], [p.id, { kind: "start", t: 2110, launch: 1, turn: "gB", match }]]);
  later(4000);
  await new Promise((r) => setTimeout(r, 0));
  const b = [...tasks.values()].find((t: any) => t !== a);
  assert.deepEqual([[...a.events].map((e: any) => e.state), a.detail, b.state, b.detail, p.waiting, pushed],
    [["accepted", "submitted", "working", "completed"], null, "approval", "$  echo hi in . Run this command? Not in allowlist: echo", true, ["completed", "approval"]], pending);
}
{
  // A follow-up queued while A runs waits for A's end, and A asks meanwhile:
  // no start comes, so a second on the approval asks in A.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock, f, later } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2090;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2090);
  f.enterTurn(b, 2090);
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  later(3140);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([a.state, a.detail, b.state, p.waiting, pushed], ["approval", "$  echo hi in . Run this command? Not in allowlist: echo", "submitted", true, ["approval"]]);
}
{
  // A real Esc goes in at 2000 while A runs, its acknowledgement late. A is
  // interrupted at 2060, B's Enter goes in at 2090 (its start 2110), and B's
  // approval draws at 2140. The poll at 2250 brings A's interrupt and B's
  // start, held behind the Esc's write (holdReports), while the page's timers
  // run on. The approval asks in no task until the write's outcome is in at
  // 3500, then in B alone.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock, f, later } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2000;
  const esc = p.sending("\x1b");
  clock.at = p.lastIn = 2090;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2090);
  f.enterTurn(b, 2090);
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = 2250;
  f.agentEvents([[p.id, { kind: "interrupt", t: 2060, launch: 1, turn: "gA" }], [p.id, { kind: "start", t: 2110, launch: 1, turn: "gB", match: b.match }]]);
  later(3200);
  assert.deepEqual([a.state, b.state, p.waiting], ["working", "submitted", true], "B's approval waits on the held reports");
  clock.at = 3500;
  p.wrote("\x1b", true, esc, 2000);
  later(5000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([[...a.events].map((e: any) => e.state), a.detail, b.state, pushed], [["accepted", "submitted", "working", "cancelled"], null, "approval", ["approval"]]);
}
for (const queued of [false, true]) {
  // A asks itself while an Esc's write is out, its outcome late. The write
  // failed, and the reports it held start no newer turn (none came), so once
  // its outcome is in, A's approval asks in A. `queued`: B waits for its
  // start behind A too.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, pushed, clock, f, later } = c;
  clock.at = p.lastIn = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2000;
  const esc = p.sending("\x1b");
  if (queued) (clock.at = p.lastIn = 2090), f.enterTurn(f.turnTask(p, "submit", model.promptMatch("B"), 2090), 2090);
  clock.at = 2140;
  view.text = CURSOR_ASK;
  p.activity();
  later(3200);
  assert.deepEqual([a.state, p.waiting], ["working", true], `queued ${queued}: A's approval waits on the write`);
  clock.at = 3500;
  p.wrote("\x1b", false, esc);
  later(5000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([a.state, p.waiting, pushed], ["approval", true, ["approval"]], `queued ${queued}`);
}
// What a relaunch resets (Pane.launch), now on launch 2, with launch 1's tasks swept away.
const cursorRelaunch = async (c: ReturnType<typeof cursorPane>) => {
  Object.assign(c.p, { generation: 2, waiting: false, cursorTurn: undefined, cursorGen: undefined, cursorEsc: new Map(), cursorEscs: [], cursorAsking: false, cursorAnswered: undefined, cursorFeedback: false, manual: [] });
  await c.sweep(c.clock.at);
};
for (const delivered of [true, false]) {
  // y answers A's approval in launch 1, its acknowledgement late. The pane
  // relaunches, and B asks the very same question in launch 2. The old
  // write's outcome, delivered or failed, is launch 1's: B still asks, its
  // question isn't taken as answered, and no answer of B's is in doubt.
  const view = { text: "" };
  const c = cursorPane(view);
  const { p, clock, f } = c;
  clock.at = p.lastIn = 1000;
  cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  view.text = CURSOR_ASK;
  p.activity();
  clock.at = p.lastIn = 3000;
  const answered = p.sending("y");
  clock.at = 3200;
  await cursorRelaunch(c);
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 3200);
  f.enterTurn(b, 3200);
  f.agentEvents([[p.id, { kind: "start", t: 3250, launch: 2, match: b.match, turn: "gB" }]]);
  clock.at = 3500;
  p.activity();
  assert.deepEqual([b.state, p.cursorAsking, p.waiting], ["approval", true, true], "B asks");
  clock.at = 4000;
  p.wrote("y", delivered, answered, 3000);
  p.activity();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([b.state, !!b.answerInDoubt, p.cursorAsking, p.busy, p.waiting], ["approval", false, true, false, true], `launch 1's answer, ${delivered ? "delivered" : "failed"}`);
}
{
  // An Esc goes to launch 1 at 2000, its acknowledgement late. The pane
  // relaunches, and B's start in launch 2 (3250) waits behind that write. The
  // write's outcome comes in at 3500, its writer having begun at 3300. It's
  // launch 1's: it lets B's start through and stops nothing of launch 2's, so
  // B's genuine error at 4000 fails B.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock, f } = c;
  clock.at = p.lastIn = 1000;
  cursorPrompt(c, "A", "gA");
  clock.at = p.lastIn = 2000;
  const esc = p.sending("\x1b");
  clock.at = 3200;
  await cursorRelaunch(c);
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 3200);
  f.enterTurn(b, 3200);
  f.agentEvents([[p.id, { kind: "start", t: 3250, launch: 2, match: b.match, turn: "gB" }]]);
  assert.equal(b.state, "submitted", "B's start waits behind the old write");
  clock.at = 3500;
  p.wrote("\x1b", true, esc, 3300);
  assert.deepEqual([b.state, p.cursorEscs.length], ["working", 0], "the old write lets B's start through, and stops nothing");
  clock.at = 4000;
  f.agentEvents([[p.id, { kind: "fail", t: 4000, launch: 2, turn: "gB", detail: "Cursor reported an error" }]]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([b.state, p.waiting, pushed], ["failed", true, ["failed"]]);
}
for (const end of ["completed", "error", "aborted"]) {
  // An open Overview redraws when a Cursor turn stops. Done or failed, the
  // pane already waits then, so its card never reads idle until the next tick.
  const drawn: boolean[][] = [];
  const c = cursorPane({ text: "" }, { dashboardOpen: true, renderDashboard: () => drawn.push([c.p.busy, c.p.waiting]) });
  c.clock.at = 1000;
  cursorPrompt(c, "A", "gA");
  c.clock.at = 2000;
  cursorStop(c, end, "gA");
  assert.deepEqual(drawn[drawn.length - 1], [false, end !== "aborted"], `the Overview after ${end}`);
}
console.log("ok   Cursor's hooks move its pane and its tasks, and its questions are read off its screen");
// Grok Build 1.0.52: its hooks report each turn (promptId) and how it ended,
// and its permission card shows on its screen (fixtures/grok-screens.json).
const grokScreens = JSON.parse(readFileSync("src/fixtures/grok-screens.json", "utf8")) as Record<string, string[]>;
const [GROK_IDLE, GROK_WORKING, GROK_ASK] = ["idle", "working", "approval"].map((s) => grokScreens[s].join("\n"));
{
  // Grok review 1: a grok Claude started for a second opinion runs Grok's global hooks
  // in Claude's pane. Its reports name their source, and none of them is this pane's.
  const { p, f, clock, pushed, tasks } = claudePane();
  clock.at = p.lastIn = 1000;
  const t = f.turnTask(p, "submit", model.promptMatch("Implement the feature and consult Grok"), 1000);
  f.enterTurn(t, 1000);
  f.taskSignal(p, { kind: "start", launch: 1, at: 1100, match: t.match });
  clock.at = 3000;
  f.agentEvents([
    { kind: "start", match: model.promptMatch("Give a second opinion"), turn: "pChild", t: 2000 },
    { kind: "stop", response: "7a93ff464303fbf5", turn: "pChild", t: 2500 },
    { kind: "end", response: "7a93ff464303fbf5", turn: "pChild", t: 2600 },
    { kind: "fail", detail: "rate_limit", turn: "pChild", t: 2700 },
    { kind: "interrupt", turn: "pChild", t: 2800 },
  ].map((ev) => [p.id, { ...ev, launch: 1, src: "grok" }]));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, tasks.size, pushed, f.turnTasks.size], ["working", 1, [], 0], "a child grok's reports moved the Claude pane's task");
  // Claude's own, then: its task still ends on them.
  clock.at = 4000;
  f.agentEvents([[p.id, { kind: "stop", launch: 1, src: "claude", t: 4000 }]]);
  assert.equal(f.watched(t).stopAt, 4000, "Claude's own Stop counts");
}
console.log("ok   Reports from another agent's hooks don't move a pane's tasks");
const grokTurn = (view: { text: string }) => {
  const c = cursorPane(view);
  c.p.agent = "grok";
  const report = (ev: Record<string, unknown>) => c.f.agentEvents([[c.p.id, { launch: 1, turn: "pA", src: "grok", ...ev }]]);
  c.clock.at = c.p.lastIn = 1000;
  const t = c.f.turnTask(c.p, "submit", model.promptMatch("A"), 1000);
  c.f.enterTurn(t, 1000);
  // Grok's bar says it works the moment the prompt goes in, before its prompt hook runs.
  view.text = GROK_WORKING;
  c.p.activity();
  report({ kind: "start", t: 1100, match: t.match });
  return { ...c, t, report };
};
{
  // A prompt, its permission card, the answer "3" (Yes, proceed), and its end.
  const view = { text: GROK_IDLE };
  const { p, pushed, clock, later, t, report } = grokTurn(view);
  assert.deepEqual([t.state, p.busy, p.waiting], ["working", true, false], "working");
  clock.at = 3000;
  view.text = GROK_ASK;
  p.activity();
  assert.deepEqual([t.state, t.detail, p.busy, p.waiting], ["approval", "Remove the del1 directory recursively rm -r del1", false, true], "asking");
  clock.at = p.lastIn = 4000;
  const sent = p.sending("3");
  p.wrote("3", true, sent);
  view.text = GROK_WORKING;
  p.activity();
  assert.deepEqual([sent.answer, t.state, p.busy, p.waiting], [true, "working", true, false], "answered");
  // Its Stop, then its stop hooks run under the same bar, then the turn is over.
  clock.at = 9000;
  report({ kind: "stop", t: 9000, response: "00000000000000f1" });
  later(9400);
  assert.deepEqual([t.state, p.busy, p.waiting], ["working", true, false], "its Stop gate");
  view.text = GROK_IDLE;
  later(9700);
  assert.equal(t.state, "working", "idle for under half a second");
  later(10_000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, t.events.at(-1).response, p.busy, p.waiting, pushed], ["completed", "00000000000000f1", false, true, ["approval", "completed"]], "done");
}
for (const [how, stops, state, notices] of [
  // Ctrl+C, or a permission card dismissed or rejected: Grok reports the turn cancelled, and it raises no alert.
  ["cancelled", [{ kind: "interrupt" }], "cancelled", []],
  ["failed", [{ kind: "fail", detail: "rate_limit: 429" }], "failed", ["failed"]],
  // An older helper's end, which Grok's Stop was: it still ends the turn.
  ["ended", [{ kind: "end" }], "completed", ["completed"]],
] as const) {
  const view = { text: GROK_IDLE };
  const { p, pushed, clock, t, report } = grokTurn(view);
  clock.at = 9000;
  view.text = GROK_IDLE;
  for (const s of stops) report({ ...s, t: 9000 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.busy, p.waiting, pushed], [state, false, state !== "cancelled", notices], how);
}
// Grok review 2: a Stop is a gate. Another Stop hook that blocks it (a decision,
// additionalContext, exit 2) sends Grok on under the same prompt, its bar unchanged,
// with no new prompt hook, and stopHookActive is true for every Stop after. The
// turn's own later cancel, failure or Stop decides; past 8 continuations Grok
// forces the stop and runs no hook for it, and its bar then shows the turn over.
for (const [how, after, state, response, notices] of [
  ["the gate's last Stop", [{ kind: "stop", response: "00000000000000f2" }], "completed", "00000000000000f2", ["completed"]],
  ["a failure after the block", [{ kind: "fail", detail: "server_error" }], "failed", undefined, ["failed"]],
  ["a cancel in the gate", [{ kind: "interrupt" }], "cancelled", undefined, []],
  ["8 continuations, then the forced stop", Array.from({ length: 7 }, (_, i) => ({ kind: "stop", response: `00000000000000a${i}` })), "completed", "00000000000000a6", ["completed"]],
] as const) {
  const view = { text: GROK_IDLE };
  const { p, pushed, clock, later, t, report } = grokTurn(view);
  clock.at = 3000;
  report({ kind: "stop", t: 3000, response: "00000000000000f1" });
  later(8000);
  assert.deepEqual([t.state, p.busy, p.waiting, pushed], ["working", true, false, []], `${how}: Grok goes on after its first Stop`);
  let at = 8000;
  for (const s of after) {
    at += 3000;
    clock.at = at;
    report({ ...s, t: at });
    later(at + 2000);
  }
  if (state === "completed") assert.deepEqual([t.state, p.busy], ["working", true], `${how}: still going`);
  view.text = GROK_IDLE;
  p.activity();
  later(at + 4000);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, t.events.at(-1).response, p.busy, p.waiting, pushed], [state, response, false, state !== "cancelled", notices], how);
}
{
  // Ctrl+C after the Stop, and the bar idle: the turn may have been cancelled in its
  // gate, which Grok reports late, so it waits for that report or Grok's idle notice.
  for (const late of [{ kind: "interrupt" }, { kind: "idle" }]) {
    const view = { text: GROK_IDLE };
    const { p, pushed, clock, later, t, report } = grokTurn(view);
    clock.at = 3000;
    report({ kind: "stop", t: 3000, response: "00000000000000f1" });
    clock.at = p.lastIn = 3200;
    p.wrote("\x03", true, p.sending("\x03"));
    view.text = GROK_IDLE;
    later(9000);
    assert.equal(t.state, "working", "Ctrl+C after the Stop: waiting for its report");
    clock.at = 9000;
    report({ ...late, t: 9000 });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual([t.state, pushed], late.kind === "idle" ? ["completed", ["completed"]] : ["cancelled", []], late.kind);
  }
  // A bar too narrow to read: Grok's idle notice says the turn is over.
  const view = { text: GROK_IDLE };
  const { pushed, clock, later, t, report } = grokTurn(view);
  clock.at = 3000;
  report({ kind: "stop", t: 3000 });
  view.text = "  │ >\n\n  Shift+Tab:mode  │  Ct";
  later(60_000);
  assert.equal(t.state, "working", "an unreadable bar ends nothing");
  clock.at = 63_000;
  report({ kind: "idle", t: 63_000 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, pushed], ["completed", ["completed"]], "idle notice");
  // The next prompt starting ends a held Stop's turn: Grok starts one only once the last is over.
  const v2 = { text: GROK_IDLE };
  const c = grokTurn(v2);
  c.clock.at = 3000;
  c.report({ kind: "stop", t: 3000, response: "00000000000000f1" });
  c.clock.at = c.p.lastIn = 3100;
  const next = c.f.turnTask(c.p, "submit", model.promptMatch("B"), 3100);
  c.f.enterTurn(next, 3100);
  c.report({ kind: "start", t: 3200, turn: "pB", match: next.match });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([c.t.state, c.t.events.at(-1).response, next.state, c.pushed], ["completed", "00000000000000f1", "working", ["completed"]], "a queued prompt");
}
console.log("ok   Grok's Stop holds until its screen shows the turn over");
{
  // Grok review 3: another UserPromptSubmit hook blocks the prompt after Loom's reported
  // it. No turn runs, and Grok shows the blocked prompt's card (Edit, Resend, Discard).
  // 1.0.52 then reports a StopCancelled the guide doesn't promise.
  const GROK_BLOCKED = grokScreens.blocked.join("\n");
  for (const cancelled of [false, true]) {
    const view = { text: GROK_IDLE };
    const { p, pushed, clock, t, report, sweep } = grokTurn(view);
    view.text = GROK_BLOCKED;
    clock.at = 2000;
    p.activity();
    assert.deepEqual([p.busy, p.cursorTurn], [false, false], `${cancelled}: no turn runs on the blocked prompt's card`);
    if (cancelled) report({ kind: "interrupt", t: 2100 });
    await sweep(2500);
    await sweep(65_000);
    assert.deepEqual([t.state, p.busy, pushed.filter((n) => n !== "unknown")], [cancelled ? "cancelled" : "unknown", false, []], `${cancelled}: settled, never completed`);
  }
}
console.log("ok   A prompt another hook blocks leaves no Grok turn running");
{
  // Esc doesn't stop a Grok turn ("Press Ctrl+c to cancel the turn"), and holds no reports: a later error is the turn's own.
  const view = { text: GROK_IDLE };
  const { p, pushed, clock, t, report } = grokTurn(view);
  clock.at = p.lastIn = 2000;
  const esc = p.sending("\x1b");
  p.wrote("\x1b", true, esc);
  clock.at = 9000;
  report({ kind: "fail", t: 9000, detail: "server_error" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([esc.stop, esc.answer, t.state, pushed], [undefined, false, "failed", ["failed"]]);
}
console.log("ok   Grok's hooks move its pane and its tasks, and its permission card is read off its screen");
