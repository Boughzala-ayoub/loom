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
import { readMenu, menuRev, menuKeys, readSurvey } from "./prompt.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["startupTurns", "startupNotify", "finishTaskReplay", "paneContext", "contextOf", "keepContext", "turnTask", "enterTurn", "moveTask", "taskWrites", "holdSignals", "enterHeld", "taskSignal", "pendingContextTasks", "closedTaskContexts", "agentTurn", "adoptManual", "watched", "sweepTasks", "QUIET_MS", "keepTasks", "taskPruned", "agentReport", "turnsSeen", "turnTasks"]);
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
  runInContext(ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { turnTask, enterTurn, keepContext, finishTaskReplay, holdSignals, taskSignal, contextOf, sweepTasks, keepTasks, agentReport };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
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
const paneNames = new Set(["_busy", "busySince", "quietSince", "busy", "waiting", "waitingSince", "workSince", "workAt", "idle", "lastIn", "lastTurnAt", "turnSource", "turns", "opencodeStatus", "codexAsking", "cursorTurn", "cursorGen", "cursorEsc", "cursorEnded", "cursorEscAt", "cursorAsking", "cursorAnswered", "cursorQuestion", "answeredCursor", "cursorRuns", "programState", "activity", "wake", "seen", "wrote", "answers", "programStatus", "mark", "commands", "lastFailed", "lastExit", "atPrompt", "receiptRunning"]);
const paneCode = ts.transpileModule(`globalThis.Pane = class {\n${paneClass.members.filter((m) => m.name && paneNames.has(m.name.getText(source))).map((m) => m.getText(source)).join("\n")}\n};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function claudePane(extra: Record<string, unknown> = {}) {
  const fx = swept(), timers: { due: number; run: (() => void) | null }[] = [];
  const s = createContext({ Date: class extends Date { static now() { return fx.clock.at; } }, beep() {}, taskbarEnabled: false, loomFocused: true, dashboardOpen: false, TextDecoder, atob, taskSignal: fx.f.taskSignal, tasks: fx.tasks, ...extra,
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
  const c = claudePane({ readMenu, menuRev, menuKeys, readSurvey, liveScreen: () => view.text, turnReceipts() {}, ...extra });
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
  p.wake("cursor:busy", "hook", "g1");
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
  p.answeredCursor();
  f.taskSignal(p, { kind: "resume", at: 3500 });
  p.seen();
  assert.deepEqual([p.busy, p.waiting, t.state, p.turns], [true, false, "working", 1], "answered, its menu still drawn");
  view.text = " ⠰⠳ Working\n\n  → Add a follow-up        ctrl+c to stop\n";
  p.activity();
  later(9000);
  p.wake("cursor:done", "hook", "g1");
  f.agentReport(p, { kind: "end", at: 9000, launch: 1, turn: "g1" });
  f.agentReport(p, { kind: "end", at: 9000, launch: 1, turn: "g1" });
  assert.deepEqual([p.busy, p.waiting, t.state, t.endedAt, p.turns], [false, true, "completed", 9000, 2], "done");
  await new Promise((r) => setTimeout(r, 0)); // notices go out once the journal has the event
  assert.deepEqual(pushed, ["approval", "completed"]);
}
// What Cursor's hooks say of turn `gen` when it stops: the marker the pane
// wakes on, then the report its task moves on (stop: aborted, error or completed).
const cursorStop = (c: ReturnType<typeof cursorPane>, end: string, gen: string) => {
  c.p.wake(`cursor:${end}`, "hook", gen);
  const at = c.clock.at;
  c.f.agentReport(c.p, end === "aborted" ? { kind: "interrupt", at, launch: 1, turn: gen }
    : end === "error" ? { kind: "fail", at, launch: 1, detail: "Cursor reported an error", turn: gen } : { kind: "end", at, launch: 1, turn: gen });
};
const cursorPrompt = (c: ReturnType<typeof cursorPane>, prompt: string, gen: string) => {
  const t = c.f.turnTask(c.p, "submit", model.promptMatch(prompt), c.clock.at);
  c.f.enterTurn(t, c.clock.at);
  c.p.wake("cursor:busy", "hook", gen);
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
  p.wrote("\x1b", true, false);
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
  p.wrote("\x1b", true, false);
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
  p.wrote("\x03", true, false);
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
  const answer = p.answers("\t");
  p.wrote("\t", true, answer);
  p.seen();
  assert.deepEqual([answer, p.waiting, t.state], [true, false, "working"], "Tab answered the approval");
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
  p.wrote(key, true, p.answers(key));
  p.seen();
  view.text = "  → Add a follow-up        ctrl+c to stop\n"; // its feedback, typed in the composer
  p.activity();
  clock.at = p.lastIn = 5000;
  p.wrote("\r", true, p.answers("\r"));
  p.seen();
  clock.at = 60_000;
  cursorStop(c, "error", "gA");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([t.state, p.waiting, pushed], ["failed", true, ["approval", "failed"]], JSON.stringify(key));
}
for (const order of [["aborted", "error"], ["error", "aborted"]]) {
  // Esc stops A, and B starts before either of A's stops lands. They end A,
  // the task A's start moved, and leave B working; B's end completes B alone.
  const c = cursorPane({ text: "" });
  const { p, pushed, clock } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, false);
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
  p.wrote("\x1b", true, p.answers("\x1b"));
  clock.at = 1300;
  const start = () => f.agentReport(p, { kind: "start", at: 1050, launch: 1, match: t.match, turn: "gA" });
  const report = (end: string) => f.agentReport(p, end === "aborted" ? { kind: "interrupt", at: 1200, launch: 1, turn: "gA" } : { kind: "fail", at: 1200, launch: 1, detail: "Cursor reported an error", turn: "gA" });
  if (onePoll) {
    p.wake(`cursor:${order[1]}`, "hook", "gA");
    start();
    order.forEach(report);
  } else {
    p.wake("cursor:busy", "hook", "gA");
    start();
    for (const end of order) (p.wake(`cursor:${end}`, "hook", "gA"), report(end));
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
  const receipts = new Map<string, any>([["B", { pane: "pane-1", gen: 1, turnsAt: 0 }]]);
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
{
  // One poll reads B's start and A's late stops: every hook keeps its report,
  // but each replaces the pane's one wake marker, and Rust sends that marker
  // (A's error) before the reports. The reports, in order, say B runs.
  const c = cursorPane({ text: "" });
  const { p, clock, f, sweep } = c;
  clock.at = 1000;
  const a = cursorPrompt(c, "A", "gA");
  clock.at = 2000;
  p.wrote("\x1b", true, false);
  clock.at = 2100;
  const b = f.turnTask(p, "submit", model.promptMatch("B"), 2100);
  f.enterTurn(b, 2100);
  clock.at = 2300;
  p.wake("cursor:error", "hook", "gA");
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
  p.wake("cursor:done", "hook", "gC");
  f.agentReport(p, { kind: "start", at: 41_050, launch: 1, match: t.match, turn: "gC" });
  f.agentReport(p, { kind: "end", at: 41_200, launch: 1, turn: "gC" });
  assert.deepEqual([t.state, p.cursorTurn, p.cursorGen, p.busy, p.waiting], ["completed", false, "gC", false, true], "a start and its own end in one poll");
}
console.log("ok   Cursor's hooks move its pane and its tasks, and its questions are read off its screen");
