// Production command handlers, with only native/window boundaries replaced.
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as cli from "./cli.ts";
import * as task from "./task.ts";
import * as prompt from "./prompt.ts";
import { agentOf } from "./agent.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["CLI", "CliTimeout", "CliError", "cliWord", "cliCommand", "cliTask", "record", "taskText", "taskLocation", "paneName", "paneData", "paneSettings", "threadData", "threadState", "cliState", "CLI_STATES", "windowStep", "waitTask", "taskStates", "choose", "cliGen"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`const ${d.getText(source)};`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { CLI };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(extra: Record<string, unknown> = {}) {
  const s = createContext({ ...cli, ...task, ...prompt, agentOf, console, setTimeout: (f: () => void) => setTimeout(f, 10), clearTimeout,
    threads: [], current: null, unsaved: new Set(), tasks: new Map(), startups: [{ label: "Codex", cmd: "codex" }, { label: "Claude", cmd: "claude" }],
    ...extra });
  runInContext(code, s);
  return s.f.CLI;
}
// @ts-ignore Node-only test.
const check = (n: number) => !process.env.CLI_ITEM || process.env.CLI_ITEM === String(n);
if (check(14)) {
  const th = { id: "th", name: "work", dir: "C:\\work", panes: [] as any[], zoomed: null as any };
  const p = { id: "p", th }, q = { id: "q", th };
  th.panes.push(p, q);
  const c = fixture({ threads: [th] });
  assert.equal(c.threads.run().data[0].zoomed, null);
  th.zoomed = p;
  let r = c.threads.run().data[0];
  assert.equal(r.zoomed, "p");
  assert.equal(r.panes[0].zoomed, true);
  assert.equal(r.panes[1].zoomed, false);
  th.zoomed = q;
  r = c.threads.run().data[0];
  assert.equal(r.zoomed, "q");
  console.log("ok   thread and pane records identify the actual zoom target independently of focus");
}
if (check(11)) {
  const t = { id: "stuck", pane: "p", gen: 1, ref: "work:1", state: "working", events: [] };
  const th = { name: "work", panes: [] as any[] };
  const p = { id: "p", generation: 1, busy: true, th };
  th.panes.push(p);
  const c = fixture({ tasks: new Map([[t.id, t]]), paneById: () => p,
    until: async (ok: () => boolean) => { assert.equal(ok(), false); p.busy = false; assert.equal(ok(), true); } });
  assert.equal(c.wait.options['or-idle'], "bool");
  const r = await c.wait.run({ _: [], task: t.id, 'or-idle': true }, { seconds: 1 });
  assert.equal(r.data.waitReason, "pane-idle");
  assert.equal(r.data.state, "working");
  assert.equal(t.events.length, 0);
  await assert.rejects(c.wait.run({ _: [], 'or-idle': true }, { seconds: 1 }), /--task/);
  console.log("ok   wait --or-idle returns a separate fallback reason without settling the task");
}
if (check(10)) {
  const t = { id: "stuck", pane: "p", ref: "work:1", state: "working", events: [] };
  let moves = 0;
  const c = fixture({ tasks: new Map([[t.id, t]]), paneById: () => undefined, requireJournal() {},
    moveTask: async (_: unknown, change: { state: string }) => { moves++; t.state = change.state; return true; } });
  assert.equal(c.task.options?.end, "string");
  await c.task.run({ _: [t.id], end: "unknown" });
  assert.equal(t.state, "unknown");
  await c.task.run({ _: [t.id], end: "unknown" });
  assert.equal(moves, 1);
  await assert.rejects(c.task.run({ _: [t.id], end: "completed" }));
  await assert.rejects(c.task.run({ _: [t.id], end: "cancelled" }));
  console.log("ok   task --end settles explicitly, is idempotent, and cannot invent completion or rewrite a final task");
}
if (check(9)) {
  assert.equal(cli.keyBytes("ctrl-u", false), "\x15");
  assert.match(fixture().keys.help, /ctrl-u/);
  console.log("ok   keys documents the existing ctrl-u draft-clear key");
}
if (check(8)) {
  let command = "";
  const th = { panes: [], addPane: async ({ cmd }: { cmd: string }) => { command = cmd; return { id: "p", th, agent: "codex" }; } };
  const c = fixture({ MAX_PANES: 16, cliThread: () => th, show() {}, revealPane() {}, save() {} });
  await c.add.run({ _: [], agent: "codex", model: "gpt-6-astra", effort: "high" });
  assert.equal(command, "codex --model gpt-6-astra -c model_reasoning_effort=high");
  await c.add.run({ _: [], agent: "claude", model: "opus", effort: "max" });
  assert.equal(command, "claude --model opus --effort max");
  await assert.rejects(c.add.run({ _: [], agent: "codex", model: "bad & command" }));
  await assert.rejects(c.add.run({ _: [], cmd: "codex", effort: "high" }));
  assert.equal(c.new.options.model, "string");
  console.log("ok   add and new accept safe model/effort flags and reject command injection or --cmd ambiguity");
}
if (check(7)) {
  const th = { name: "work", panes: [] as any[] };
  const p = { id: "p", th, agent: "codex", usage: { model: "old", liveModel: "current", effort: "low", liveEffort: "high", ctx: 25000, window: 100000 } };
  th.panes.push(p);
  const c = fixture({ threads: [th], paneRows: () => "" });
  const r = c.panes.run({ _: [] }).data[0];
  assert.equal(r.model, "current");
  assert.equal(r.effort, "high");
  assert.equal(r.context.remainingTokens, 75000);
  assert.equal(r.context.remainingPercent, 75);
  delete (p as any).usage;
  const unknown = c.panes.run({ _: [] }).data[0];
  assert.deepEqual([unknown.model, unknown.effort, unknown.context], [null, null, null]);
  console.log("ok   panes exports live model, effort and context, with null for unavailable data");
}
if (check(6)) {
  const calls: string[] = [];
  const plan = { tier: "pro", limits: [{ label: "Weekly", percent: 40 }], stale: false, bankedResets: 2, bankedResetExpiries: ["2026-11-01", null] };
  const c = fixture({ planUsage: false, PLAN_PROVIDERS: { claude: { command: "plan_usage" }, codex: { command: "codex_plan_usage" } },
    invoke: async (cmd: string) => { calls.push(cmd); return plan; } });
  assert.ok(c.usage, "usage command must exist");
  const r = await c.usage.run({ _: ["codex"] });
  assert.equal(r.data.codex.bankedResets, 2);
  assert.deepEqual(r.data.codex.bankedResetExpiries, plan.bankedResetExpiries);
  assert.deepEqual(calls, ["codex_plan_usage"]);
  await assert.rejects(c.usage.run({ _: ["invalid"] }));
  console.log("ok   usage explicitly fetches with polling off and preserves banked reset expiries");
}
if (check(5)) {
  const writes: string[] = [];
  let screen = "How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss";
  const c = fixture({ cliPane: () => ({ id: "p", agent: "claude" }), liveScreen: () => screen,
    inTurn: (_: unknown, f: (live: () => void) => unknown) => f(() => {}), keys: (_: unknown, s: string) => writes.push(s) });
  const menu = c.menu.run({ _: ["p"] }).data;
  await c.choose.run({ _: ["p", "0"], menu: menu.rev });
  assert.deepEqual(writes, ["0"]);
  screen = "different question";
  await assert.rejects(c.choose.run({ _: ["p", "1"], menu: menu.rev }));
  assert.deepEqual(writes, ["0"]);
  console.log("ok   survey choose sends its digit without Enter and refuses a changed screen");
}
if (check(4)) {
  let created = "", gitCalls = 0;
  const c = fixture({ MAX_PANES: 16, callerPath: (s: string) => s,
    git: async () => { gitCalls++; throw new Error("not a repository"); },
    createThread: async (folder: string) => { created = folder; return { name: "ideas", dir: folder, panes: [] }; } });
  await c.new.run({ _: ["C:\\ideas"] }, {});
  assert.equal(created, "C:\\ideas");
  assert.equal(gitCalls, 0);
  await assert.rejects(c.new.run({ _: ["C:\\ideas"], name: "branch" }, {}), /Git repository/);
  await assert.rejects(c.new.run({ _: ["C:\\ideas"], base: "main" }, {}), /Git repository/);
  console.log("ok   new opens a plain folder and requires Git for a worktree");
}
if (check(2)) {
  const th = { name: "work", panes: [] as any[] };
  const p = { id: "p", th };
  th.panes.push({}, p);
  const t = { id: "task1", pane: "p", ref: "work:4", state: "working", events: [] };
  const c = fixture({ tasks: new Map([[t.id, t]]), paneById: () => th.panes.includes(p) ? p : undefined });
  assert.equal((await c.task.run({ _: [t.id] })).data.ref, "work:2");
  th.panes.shift();
  assert.match((await c.task.run({ _: [t.id] })).text, /on work:1/);
  th.panes.length = 0;
  assert.equal((await c.task.run({ _: [t.id] })).data.ref, null);
  assert.equal((await c.task.run({ _: [t.id] })).data.paneClosed, true);
  assert.match((await c.task.run({ _: [t.id] })).text, /closed pane/);
  assert.equal(t.ref, "work:4", "Display does not rewrite history");
  console.log("ok   task references follow pane IDs and explicitly report closed panes");
}
if (check(1)) {
  for (const stuck of ["unminimize", "show", "setFocus"]) {
    const w = Object.fromEntries(["unminimize", "show", "setFocus"].map((k) => [k, () => k === stuck ? new Promise(() => {}) : Promise.resolve()]));
    const c = fixture({ getCurrentWindow: () => w });
    const pending = c.window.run({ _: ["show"] });
    assert.equal(c.threads.run().data.length, 0, "A pending window call does not block other requests");
    const result = await Promise.race([pending.then(() => "unexpected success", (e: Error) => e.message), new Promise((r) => setTimeout(() => r("hung"), 100))]);
    assert.match(String(result), /window.*timed out/i);
  }
  console.log("ok   window show bounds each native step and leaves other requests runnable");
}
