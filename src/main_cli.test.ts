import detailCooldown from "./fixtures/codex-detail-cooldown.json" with { type: "json" };
import settings from "./fixtures/settings-values.json" with { type: "json" };
import claudeCapture from "./fixtures/claude-composer.json" with { type: "json" };
const claudeComposer = claudeCapture.lines.join("\n");
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
const names = new Set(["CLI", "CliTimeout", "CliError", "cliWord", "cliCommand", "cliTask", "record", "taskText", "taskLocation", "paneName", "paneData", "paneSettings", "threadData", "threadState", "cliState", "CLI_STATES", "windowStep", "waitTask", "taskStates", "choose", "cliGen", "moveTask", "pendingJournal", "taskWrites", "journal", "journalQueue", "journalLines", "journalCalls", "snapshotCalls", "journalDirty", "typedTasks", "waitReceipt", "cliReceipt", "receiptLost", "pollProviderUsage", "providerPolls", "accountPlan", "accountPolls", "accountCache", "fetchPlan", "resetIso", "normalizePlan", "liveScreen", "inventory", "inventoryDiff"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`${node.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${d.getText(source)};`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { CLI, pollProviderUsage, fetchPlan, moveTask, journal, inventory, inventoryDiff };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let lastFixture: any;
function fixture(extra: Record<string, unknown> = {}) {
  const s = createContext({ ...cli, ...task, ...prompt, agentOf, console, setTimeout: (f: () => void) => setTimeout(f, 10), clearTimeout,
    gone: () => false, invoke: async () => ({}), startupTurns: null, contextOf: () => undefined, closedTaskContexts: new WeakMap(), taskSeq: 3, taskWatch: new Map(), heldEnter: new Map(), keepTasks() {}, keepReceipts() {},
    threads: [], current: null, unsaved: new Set(), tasks: new Map(), startups: [{ label: "Codex", cmd: "codex" }, { label: "Claude", cmd: "claude" }],
    ...extra });
  runInContext(code, s);
  Object.assign(s, extra);
  lastFixture = s.f;
  return s.f.CLI;
}
// @ts-ignore Node-only test.
const check = (n: number) => !process.env.CLI_ITEM || process.env.CLI_ITEM === String(n);
if (check(204)) {
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  const p = { id: "p", th, agent: "codex", sessionId: "selected", generation: 1, providerUsage: null } as any;
  th.panes.push(p);
  let model = "first", calls = 0, deliver: ((v: any) => void) | undefined;
  const c = fixture({ threads: [th], current: th, dashboardOpen: false, paneRows: () => "", gone: () => false,
    document: { hidden: true }, backgroundHidden: () => true,
    invoke: async () => { calls++; return deliver ? new Promise((r) => { deliver = r; }) : { p: { sid: p.sessionId, model, effort: "high", ctx: 12, window: 100 } }; } });
  const first = await c.panes.run({ _: [] });
  assert.equal(first.data[0].model, "first", "minimized CLI reads must collect initial settings");
  model = "second";
  assert.equal((await c.threads.run()).data[0].panes[0].model, "second");
  assert.equal((await c.status.run()).data.front.context.usedTokens, 12);
  const before = calls;
  await Promise.all(Array.from({ length: 20 }, () => c.panes.run({ _: [] })));
  assert.equal(calls, before + 1, "concurrent clients coalesce native reads");
  deliver = () => {};
  const pending = c.panes.run({ _: [] });
  p.generation++; p.sessionId = "changed"; p.providerUsage = null;
  deliver!({ p: { sid: "selected", model: "stale" } });
  assert.equal((await pending).data[0].model, null);
  const stalled = await c.panes.run({ _: [] });
  assert.equal(stalled.data[0].model, null, "a stalled native read must be bounded");
  console.log("ok   R4 minimized CLI reads refresh, coalesce, bound waits and reject stale generations");
}
if (check(201)) {
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  const p = { id: "p", th, agent: "codex", sessionId: "selected" } as any;
  th.panes.push(p);
  Object.assign(th, { active: p });
  const c = fixture({ threads: [th], current: th, dashboardOpen: false, paneRows: () => "" });
  for (const value of ["sk-" + "a".repeat(40), "ghp_" + "b".repeat(30), "AKIA" + "C".repeat(16), "xoxb-synthetic", ...settings.private, "password=synthetic", "custom\nmodel", "a".repeat(161)]) {
    for (const field of ["providerUsage", "startupSettings"]) {
      p.providerUsage = null; p.startupSettings = null;
      p[field] = { sid: "selected", model: value, effort: value };
      const data = (await c.panes.run({ _: [] })).data[0];
      assert.ok(data.model === null && data.effort === null, "private settings must be absent");
      for (const reply of [await c.threads.run(), await c.status.run()])
        assert.ok(!JSON.stringify(reply).includes(value), "nested settings must be absent");
    }
  }
  for (const field of ["providerUsage", "startupSettings"]) {
    p.providerUsage = null; p.startupSettings = null;
    for (const model of settings.models) {
      p[field] = { sid: "selected", model };
      assert.equal((await c.panes.run({ _: [] })).data[0].model, model);
    }
    for (const effort of settings.efforts) {
      p[field] = { sid: "selected", effort };
      assert.equal((await c.panes.run({ _: [] })).data[0].effort, effort);
    }
  }
  for (const value of settings.invalidModels) assert.equal(task.settingValue(value, "model"), null);
  for (const value of settings.invalidEfforts) assert.equal(task.settingValue(value, "effort"), null);
  console.log("ok   R1 settings reject recognizable secrets and malformed restored values");
}
if (check(14)) {
  const th = { id: "th", name: "work", dir: "C:\\work", panes: [] as any[], zoomed: null as any };
  const p = { id: "p", th }, q = { id: "q", th };
  th.panes.push(p, q);
  const c = fixture({ threads: [th] });
  assert.equal((await c.threads.run()).data[0].zoomed, null);
  th.zoomed = p;
  let r = (await c.threads.run()).data[0];
  assert.equal(r.zoomed, "p");
  assert.equal(r.panes[0].zoomed, true);
  assert.equal(r.panes[1].zoomed, false);
  th.zoomed = q;
  r = (await c.threads.run()).data[0];
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
  const r = (await c.panes.run({ _: [] })).data[0];
  assert.equal(r.model, "current");
  assert.equal(r.effort, "high");
  assert.equal(r.context.remainingTokens, 75000);
  assert.equal(r.context.remainingPercent, 75);
  delete (p as any).usage;
  const unknown = (await c.panes.run({ _: [] })).data[0];
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
  assert.deepEqual(Array.from(r.data.codex.bankedResetExpiries), ["2026-11-01T00:00:00.000Z", null]);
  assert.deepEqual(calls, ["codex_plan_usage"]);
  await assert.rejects(c.usage.run({ _: ["invalid"] }));
  console.log("ok   usage explicitly fetches with polling off and preserves banked reset expiries");
}
if (check(5)) {
  const writes: string[] = [];
  let screen = claudeComposer + "\nHow is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss";
  const c = fixture({ cliPane: () => ({ id: "p", agent: "claude", th: { name: "work", panes: [] } }), liveScreen: () => screen,
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
    assert.equal((await c.threads.run()).data.length, 0, "A pending window call does not block other requests");
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
  // The receipt's pane is still up; the task finds none by its own id (paneById), as before receipts kept ids.
  const p = { id: "receipt-pane", generation: 1 };
  const r = { pane: p.id, gen: 1, ref: "work:1", unsent: false };
  const c = fixture({ tasks: new Map([[t.id, t]]), receipts: new Map([[t.id, r]]),
    heldEnter: new Map([[t.id, { receipt: r }]]), paneById: (id: string) => (id === p.id ? p : undefined), requireJournal() {}, journal: async () => {}, gone: () => false,
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
  assert.equal((await c.panes.run({ _: [] })).data[0].model, "observed");
  assert.equal((await c.panes.run({ _: [] })).data[0].context.remainingTokens, 88000);
  th.panes[0].sessionId = "another-session";
  assert.equal((await c.panes.run({ _: [] })).data[0].model, "gpt-6.1-sol", "a changed session must not expose the previous session's settings");
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

if (check(106)) {
  let calls = 0, release!: (v: any) => void;
  const c = fixture({ plans: {}, planErrors: {}, planFetchedAt: {}, PLAN_PROVIDERS: { claude: { command: "plan_usage" } }, planUsage: true,
    invoke: () => { calls++; return new Promise((r) => { release = r; }); } });
  const background = lastFixture.fetchPlan("claude");
  const reads = Array.from({ length: 20 }, () => c.usage.run({ _: ["claude"] }));
  assert.equal(calls, 1, "twenty clients must share one account fetch");
  release({ tier: "pro", stale: false, limits: [] });
  await Promise.all([background, ...reads]);
  const cached = await c.usage.run({ _: ["claude"] });
  assert.equal(calls, 1);
  assert.equal(cached.data.claude.cached, true);
  assert.ok(cached.data.claude.fetchedAt);
  console.log("ok   N6 explicit usage coalesces and reuses a fresh account reading with polling off");
}

if (check(106)) {
  let now = Date.now(), calls = 0;
  class Clock extends Date { static now() { return now; } }
  const c = fixture({ Date: Clock, PLAN_PROVIDERS: { claude: { command: "plan_usage" } },
    invoke: async () => { calls++; throw new Error("usage rate limited; retry after 7200 seconds"); } });
  await c.usage.run({ _: ["claude"] });
  now += 3600_000;
  const cached = await c.usage.run({ _: ["claude"] });
  assert.equal(calls, 1);
  assert.equal(cached.data.claude.stale, true);
  now += 3601_000;
  await c.usage.run({ _: ["claude"] });
  assert.equal(calls, 2);
  console.log("ok   N6 rate limits keep failures cached until the retry interval expires");
}

if (check(106)) {
  let now = Date.now(), fail = false;
  class Clock extends Date { static now() { return now; } }
  const planErrors: Record<string, string> = {};
  fixture({ Date: Clock, planUsage: true, plans: {}, planErrors, planFetchedAt: {},
    PLAN_PROVIDERS: { claude: { command: "usage" } }, invoke: async () => {
      if (fail) throw new Error("usage rate limited; retry after 7200 seconds");
      return { tier: "pro", limits: [], stale: false };
    } });
  await lastFixture.fetchPlan("claude");
  now += 301000; fail = true;
  await lastFixture.fetchPlan("claude");
  assert.match(planErrors.claude, /rate limited/, "a cached reading must not hide the background refresh error");
  console.log("ok   N6 background refresh retains its error beside cached readings");
}

if (check(107)) {
  for (const provider of ["claude", "codex"]) {
    const c = fixture({ PLAN_PROVIDERS: { [provider]: { command: "usage" } },
      invoke: async () => ({ stale: true, limits: [
        { resetsAt: "1791580233" }, { resetsAt: "2026-10-09T23:10:33+02:00" },
        { resetsAt: "bad" }, { resetsAt: "999999999999999999999" }],
        bankedResetExpiries: ["1791580233", null, "not-a-date"] }) });
    const plan = (await c.usage.run({ _: [provider] })).data[provider];
    assert.deepEqual(Array.from(plan.limits, (l: any) => l.resetsAt), ["2026-10-09T21:10:33.000Z", "2026-10-09T21:10:33.000Z", null, null]);
    assert.deepEqual(Array.from(plan.bankedResetExpiries), ["2026-10-09T21:10:33.000Z", null, null]);
  }
  console.log("ok   N7 all exported reset dates and credit expiries use validated UTC ISO timestamps");
}

if (check(108)) {
  const survey = "How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss";
  let screen = survey + "\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u276f\u00a0normal draft\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n? for shortcuts";
  const writes: string[] = [];
  const c = fixture({ cliPane: () => ({ id: "p", agent: "claude", th: { name: "work", panes: [] } }), liveScreen: () => screen,
    inTurn: (_: unknown, f: (live: () => void) => unknown) => f(() => {}), keys: (_: unknown, s: string) => writes.push(s) });
  assert.equal(c.menu.run({ _: ["p"] }).data, null);
  await assert.rejects(c.choose.run({ _: ["p", "0"] }), /numbered question/);
  assert.equal(writes.length, 0);
  screen = claudeComposer + "\n" + survey;
  const menu = c.menu.run({ _: ["p"] }).data;
  screen = survey + "\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u276f\u00a0draft\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
  await assert.rejects(c.choose.run({ _: ["p", "0"], menu: menu.rev }));
  assert.equal(writes.length, 0);
  console.log("ok   N8 transcript surveys and dismissed surveys cannot write into a draft");
}

if (check(109)) {
  for (const question of [["How is Claude doing", "this session?"], ["How is Clau", "de doing this session?"]]) {
    const physical = [...claudeCapture.lines, ...question, "1: Bad 2: Fine 3: Good 0: Dismiss"];
    const p = { id: "p", th: { name: "work", panes: [] }, agent: "claude", term: { rows: physical.length, buffer: { active: {
      baseY: 0, getLine: (i: number) => ({ isWrapped: i === 3 || (i === 4 && question[0].endsWith("Clau")), translateToString: () => physical[i] })
    } } } };
    const writes: string[] = [];
    const c = fixture({ cliPane: () => p, inTurn: (_: unknown, f: (live: () => void) => unknown) => f(() => {}), keys: (_: unknown, s: string) => writes.push(s) });
    const menu = c.menu.run({ _: ["p"] }).data;
    assert.ok(menu, "wrapped active survey must be visible");
    await c.choose.run({ _: ["p", "0"], menu: menu.rev });
    assert.deepEqual(writes, ["0"]);
  }
  console.log("ok   N9 hard-wrapped and soft-wrapped active surveys support menu and guarded choose");
}

if (check(206)) {
  const survey = "How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss";
  let screen = survey + "\nQuoted documentation above the live composer.\n" + claudeComposer + "\n" + survey;
  const writes: string[] = [];
  const p = { id: "p", th: { name: "work", panes: [] }, agent: "claude" };
  const c = fixture({ cliPane: () => p, liveScreen: () => screen,
    inTurn: (_: unknown, f: (live: () => void) => unknown) => f(() => {}), keys: (_: unknown, s: string) => writes.push(s) });
  const menu = c.menu.run({ _: ["p"] }).data;
  assert.ok(menu, "an earlier complete quote must not suppress the active survey");
  await c.choose.run({ _: ["p", "0"], menu: menu.rev });
  assert.deepEqual(writes, ["0"]);
  screen = survey + "\n" + claudeComposer;
  await assert.rejects(c.choose.run({ _: ["p", "0"], menu: menu.rev }));
  assert.deepEqual(writes, ["0"]);
  assert.equal(c.menu.run({ _: ["p"] }).data, null);
  console.log("ok   R6 active survey survives earlier quotations and dismissal invalidates guarded choose");
}

if (check(205)) {
  let now = Date.now(), calls = 0;
  class Clock extends Date { static now() { return now; } }
  const c = fixture({ Date: Clock, PLAN_PROVIDERS: { codex: { command: "codex_plan_usage" } },
    invoke: async () => { calls++; return structuredClone(detailCooldown); } });
  const first = (await c.usage.run({ _: ["codex"] })).data.codex;
  assert.equal(Date.parse(first.nextRefreshAt), now + 7200_000);
  assert.equal(first.stale, false);
  assert.match(first.note, /details unavailable/);
  now += 3600_000;
  await c.usage.run({ _: ["codex"] });
  assert.equal(calls, 1);
  now += 3601_000;
  await c.usage.run({ _: ["codex"] });
  assert.equal(calls, 2);
  console.log("ok   R5 native detail-429 result extends the shared account cooldown");
}

if (check(207)) {
  for (const fail of [false, true]) {
    const t = { id: "pending-read", pane: "p", gen: 1, state: "working", events: [{ seq: 3, at: 1, task: "pending-read", state: "working" }] } as any;
    const held: { resolve: () => void; reject: (e: Error) => void }[] = [];
    const c = fixture({ tasks: new Map([[t.id, t]]), paneById: () => undefined, requireJournal() {}, journalLoaded: true, journalUnreadable: "",
      taskPruned: 0, writtenSeq: 3, notifyHistory: [], taskEventGate: { notify() {} },
      invoke: () => new Promise<void>((resolve, reject) => held.push({ resolve, reject })) });
    const waitWrite = async () => { for (let n = 0; !held.length && n < 30; n++) await Promise.resolve(); assert.ok(held.length); return held.shift()!; };
    const pending = c.task.run({ _: [t.id], end: "cancelled" }).catch((e: Error) => e);
    const write = await waitWrite();
    assert.equal((await c.task.run({ _: [t.id] })).data.saved, false, "plain task reads must report held settlement writes as unsaved");
    assert.equal((await c.tasks.run({ _: [] })).data[0].saved, false);
    if (fail) write.reject(new Error("synthetic disk failure")); else write.resolve();
    await pending;
    assert.equal((await c.task.run({ _: [t.id] })).data.saved, !fail);
    if (fail) {
      const recovery = c.task.run({ _: [t.id], end: "cancelled" });
      const rewrite = await waitWrite();
      assert.equal((await c.task.run({ _: [t.id] })).data.saved, false);
      rewrite.resolve(); await recovery;
      assert.equal((await c.task.run({ _: [t.id] })).data.saved, true);
    }
  }
  const t = { id: "updates", pane: "p", state: "working", events: [{ seq: 3, at: 1, task: "updates", state: "working" }] } as any;
  const held: (() => void)[] = [];
  const c = fixture({ tasks: new Map([[t.id, t]]), paneById: () => undefined, journalLoaded: true, journalUnreadable: "",
    taskPruned: 0, writtenSeq: 3, notifyHistory: [], taskEventGate: { notify() {} }, invoke: () => new Promise<void>((r) => held.push(r)) });
  const first = lastFixture.moveTask(t, { state: "working", signal: "loomctl", reason: "first" });
  const second = lastFixture.moveTask(t, { state: "working", signal: "loomctl", reason: "second" });
  await Promise.resolve();
  assert.equal((await c.task.run({ _: [t.id] })).data.saved, false);
  held.shift()!(); await first;
  assert.equal((await c.task.run({ _: [t.id] })).data.saved, false, "an older write cannot certify a newer field mutation");
  held.shift()!(); await second;
  assert.equal((await c.task.run({ _: [t.id] })).data.saved, true);
  console.log("ok   R7 plain reads track pending success, failure, recovery and newer same-state mutations");
}

if (check(301)) {
  let contents = "before";
  fixture({ git: async (_dir: string, cmd: string) => cmd === "status" ? " M important.txt\0" : "head",
    lossInventory: () => ({ tracked: ["important.txt"], untracked: [], ignored: [] }),
    invoke: async () => contents });
  const before = await lastFixture.inventory({ dir: "work" }, false);
  contents = "after";
  const after = await lastFixture.inventory({ dir: "work" }, false);
  assert.notEqual(lastFixture.inventoryDiff(before, after), "", "same paths with new contents must invalidate deletion approval");
  console.log("ok   F4 deletion approval detects new contents at an already-listed path");
}

if (check(302)) {
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  const p = { id: "p", th, agent: "codex", sessionId: "selected", generation: 1, providerUsage: null } as any;
  th.panes.push(p);
  const pending: ((v: unknown) => void)[] = [];
  fixture({ threads: [th], invoke: () => new Promise(r => pending.push(r)) });
  await lastFixture.pollProviderUsage();
  await lastFixture.pollProviderUsage();
  assert.equal(pending.length, 1, "N3: a caller timeout must not release the native in-flight guard");
  pending[0]({ p: { sid: "selected", model: "late-current" } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(p.providerUsage?.model, "late-current", "N3: late native results still refresh the matching launch");
  console.log("ok   N3 bounded waits retain one native scan and apply late readings");
}

if (check(303)) {
  const th = { name: "work", panes: [] as any[] };
  const p = { id: "p", th, agent: "codex", sessionId: "selected", generation: 1,
    providerUsage: { sid: "selected", model: "new-model", effort: "", effortObserved: true },
    effort: "high", startupSettings: { effort: "high" } };
  th.panes.push(p);
  const c = fixture({ threads: [th], paneRows: () => "" });
  assert.equal((await c.panes.run({ _: [] })).data[0].effort, null, "N7: observed unset effort must suppress obsolete startup and hook values");
  console.log("ok   N7 observed unset effort cannot revive a startup fallback");
}
