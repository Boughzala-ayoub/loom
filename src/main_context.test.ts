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
const names = new Set(["startupTurns", "startupNotify", "finishTaskReplay", "paneContext", "contextOf", "keepContext", "turnTask", "enterTurn", "moveTask", "taskWrites", "holdSignals", "enterHeld", "taskSignal", "pendingContextTasks", "closedTaskContexts", "agentTurn", "watched"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`let ${d.getText(source)};`);
}
function fixture() {
  const th = { id: "thread-1", name: "At Enter", panes: [] as any[] };
  const p = { id: "pane-1", generation: 1, agent: "codex", th };
  th.panes.push({}, p);
  const tasks = new Map(), taskWatch = new Map();
  const s = createContext({ ...model, crypto, console, tasks, taskSeq: 0, unsaved: new Set(), taskWatch, heldEnter: new Map(),
    paneById: (id: string) => th.panes.find((p) => p.id === id), paneTitle: () => "Agent session", paneName: () => "work:2",
    journal: async () => {}, sweepSoon() {}, keepTasks() {}, keepReceipts() {}, adoptManual: () => false });
  runInContext(ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { turnTask, enterTurn, keepContext, finishTaskReplay, holdSignals, taskSignal, contextOf };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
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
