// Run the production startup/close paths without a WebView or a live journal.
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as model from "./task.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["startupTurns", "startupNotify", "finishTaskReplay", "paneContext", "contextOf", "keepContext", "turnTask", "enterTurn", "moveTask", "taskWrites", "holdSignals", "enterHeld", "taskSignal", "pendingContextTasks", "closedTaskContexts", "agentTurn", "watched", "sweepTasks", "QUIET_MS"]);
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
    journal: async () => {}, sweepSoon() {}, keepTasks() {}, keepReceipts() {}, adoptManual: () => false, ...extra });
  runInContext(ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { turnTask, enterTurn, keepContext, finishTaskReplay, holdSignals, taskSignal, contextOf, sweepTasks };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
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
  Object.assign(p, { agent: "claude", busySince: 5 });
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
  p.busySince = 900;
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
  Object.assign(p, { busySince: 900, interruptAt: 950 });
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
