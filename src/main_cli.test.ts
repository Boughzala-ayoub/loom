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
const names = new Set(["CLI", "CliTimeout", "CliError", "cliWord", "cliCommand", "cliTask", "record", "taskText", "taskLocation", "paneName", "paneData", "paneSettings", "threadData", "threadState", "cliState", "CLI_STATES", "windowStep", "waitTask", "taskStates", "choose", "cliGen", "moveTask", "taskWrites", "waitReceipt", "cliReceipt", "pollProviderUsage"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`const ${d.getText(source)};`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { CLI, pollProviderUsage };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let lastFixture: any;
function fixture(extra: Record<string, unknown> = {}) {
  const s = createContext({ ...cli, ...task, ...prompt, agentOf, console, setTimeout: (f: () => void) => setTimeout(f, 10), clearTimeout,
    startupTurns: null, contextOf: () => undefined, closedTaskContexts: new WeakMap(), taskSeq: 3, taskWatch: new Map(), heldEnter: new Map(), keepTasks() {}, keepReceipts() {},
    threads: [], current: null, unsaved: new Set(), tasks: new Map(), startups: [{ label: "Codex", cmd: "codex" }, { label: "Claude", cmd: "claude" }],
    ...extra });
  runInContext(code, s);
  lastFixture = s.f;
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
  assert.equal(moves, 2);
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
  const c = fixture({ MAX_PANES: 16, callerPath: (s: string) => s, invoke: async (_: string, a: any) => a.path,
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
  assert.match(c.tasks.help, /current reference.*pane ID/);
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

if (check(101)) {
  let created = 0;
  const c = fixture({ MAX_PANES: 16, callerPath: (s: string) => s,
    invoke: async (_: string, { path }: { path: string }) => {
      if (path.includes("missing") || path.endsWith("package.json")) throw new Error("Not an existing directory");
      return "C:\\ideas";
    },
    createThread: async (dir: string) => { created++; return { name: "ideas", dir, panes: [] }; } });
  for (const path of ["C:\\missing", "C:\\ideas\\package.json"])
    await assert.rejects(c.new.run({ _: [path] }, {}), /existing directory/);
  assert.equal(created, 0);
  assert.equal((await c.new.run({ _: ["C:\\ideas\\."] }, {})).data.dir, "C:\\ideas");
  console.log("ok   N1 validates and canonicalizes new targets before insertion");
}

if (check(103)) {
  const t = { id: "pending", pane: "p", state: "working", events: [] as any[] };
  let rejectWrite!: (e: Error) => void, writes = 0, secondDone = false;
  const unsaved = new Set<string>();
  const c = fixture({ tasks: new Map([[t.id, t]]), unsaved, paneById: () => undefined, requireJournal() {},
    journal: () => {
      writes++;
      if (writes === 1) return new Promise((_, reject) => { rejectWrite = (e) => { unsaved.add(t.id); reject(e); }; });
      unsaved.clear(); return Promise.resolve();
    } });
  const first = c.task.run({ _: [t.id], end: "cancelled" }).catch((e: Error) => e);
  const second = c.task.run({ _: [t.id], end: "cancelled" }).then(() => { secondDone = true; }, (e: Error) => e);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondDone, false, "same-outcome retry must await persistence");
  rejectWrite(new Error("disk failure"));
  await first; await second;
  const retry = await c.task.run({ _: [t.id], end: "cancelled" });
  assert.equal(retry.data.saved, true);
  assert.equal(writes, 2, "retry must write a recovery snapshot");
  assert.equal(t.events.length, 1);
  console.log("ok   N3 concurrent settlement waits and failed settlement retries without another event");
}

if (check(104)) {
  const t = { id: "held", pane: "p", state: "accepted", events: [] };
  const p = { id: "p", generation: 1 };
  const r = { pane: p, gen: 1, ref: "work:1", unsent: false };
  const c = fixture({ tasks: new Map([[t.id, t]]), receipts: new Map([[t.id, r]]),
    heldEnter: new Map([[t.id, { receipt: r }]]), paneById: () => undefined, requireJournal() {}, journal: async () => {}, gone: () => false,
    until: async (ready: () => boolean) => {
      assert.equal(ready(), false);
      await c.task.run({ _: [t.id], end: "unknown" });
      assert.equal(ready(), true, "receipt wait must wake when tracking ends without Enter");
    } });
  await assert.rejects(c.wait.run({ _: [], receipt: t.id }, { seconds: 1 }), /didn't press Enter/);
  assert.equal(r.unsent, true);
  console.log("ok   N4 existing receipt waits wake with no outcome after held task settlement");
}

if (check(105)) {
  const th = { panes: [] as any[], addPane: async (st: any) => {
    const p = { id: "codex", th, agent: "codex", ...st }; th.panes.push(p); return p;
  } };
  const c = fixture({ threads: [th], paneRows: () => "", MAX_PANES: 16, cliThread: () => th, show() {}, revealPane() {}, save() {} });
  const r = await c.add.run({ _: [], agent: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  assert.equal(r.data.model, "gpt-6.1-sol");
  assert.equal(r.data.effort, "xhigh");
  th.panes[0].sessionId = "observed-session";
  th.panes[0].providerUsage = { sid: "observed-session", model: "observed", effort: "low", ctx: 12000, window: 100000 };
  const record = (await c.add.run({ _: [], agent: "codex" })).data;
  assert.equal(record.model, null);
  assert.equal(c.panes.run({ _: [] }).data[0].model, "observed");
  assert.equal(c.panes.run({ _: [] }).data[0].context.remainingTokens, 88000);
  th.panes[0].sessionId = "another-session";
  assert.equal(c.panes.run({ _: [] }).data[0].model, "gpt-6.1-sol", "a changed session must not expose the previous session's settings");
  let deliver!: (v: any) => void;
  const p = th.panes[0];
  p.sessionId = "known"; p.generation = 1; p.providerUsage = null;
  fixture({ threads: [th], gone: () => false, invoke: () => new Promise((r) => { deliver = r; }) });
  const pending = lastFixture.pollProviderUsage();
  p.generation++;
  deliver({ codex: { model: "wrong-generation" } });
  await pending;
  assert.equal(p.providerUsage, null);
  console.log("ok   N5 startup selections are structured per-pane fallbacks");
}
