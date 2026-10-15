import detailCooldown from "./fixtures/codex-detail-cooldown.json" with { type: "json" };
import settings from "./fixtures/settings-values.json" with { type: "json" };
import claudeCapture from "./fixtures/claude-composer.json" with { type: "json" };
const claudeComposer = claudeCapture.lines.join("\n");
// Production command handlers, with only native/window boundaries replaced.
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { execFileSync } from "node:child_process";
// @ts-ignore Node-only test.
import { tmpdir } from "node:os";
// @ts-ignore Node-only test.
import { join } from "node:path";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as cli from "./cli.ts";
import * as task from "./task.ts";
import * as prompt from "./prompt.ts";
import { agentOf } from "./agent.ts";
import * as gitparse from "./gitparse.ts";
import * as stash from "./stash.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["CLI", "CliTimeout", "CliError", "cliWord", "cliCommand", "cliTask", "record", "taskText", "taskLocation", "paneName", "paneData", "paneSettings", "threadData", "threadState", "cliState", "CLI_STATES", "windowStep", "waitTask", "taskStates", "choose", "cliGen", "moveTask", "pendingJournal", "taskWrites", "journal", "journalQueue", "journalLines", "journalCalls", "snapshotCalls", "journalDirty", "typedTasks", "waitReceipt", "cliReceipt", "receiptLost", "pollProviderUsage", "providerPolls", "accountPlan", "accountPolls", "accountCache", "accountHolds", "pushNotice", "AGENT_NAMES", "bootedAt", "working", "fetchPlan", "resetIso", "normalizePlan", "liveScreen", "paneMenu", "inventory", "inventoryDiff", "hashedFiles", "headBranch", "syncBranch", "windowClosing", "gitStatus", "prUrl", "dictationData", "removeThread", "riskText", "closingThreads", "closePlan", "cliDelete", "lossCounts", "sweepTasks", "watched", "reportsTurns", "uniqueStartups"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`${node.declarationList.flags & ts.NodeFlags.Const ? "const" : "let"} ${d.getText(source)};`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { CLI, pollProviderUsage, fetchPlan, moveTask, journal, inventory, inventoryDiff, pushNotice, headBranch, syncBranch, removeThread, sweepTasks, uniqueStartups };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let lastFixture: any;
function fixture(extra: Record<string, unknown> = {}) {
  const s = createContext({ ...cli, ...task, ...prompt, agentOf, console, setTimeout: (f: () => void) => setTimeout(f, 10), clearTimeout,
    gone: () => false, invoke: async () => ({}), startupTurns: null, contextOf: () => undefined, closedTaskContexts: new WeakMap(), taskSeq: 3, taskWatch: new Map(), heldEnter: new Map(), keepTasks() {}, keepReceipts() {},
    threads: [], current: null, unsaved: new Set(), tasks: new Map(), save() {}, startups: [{ label: "Codex", cmd: "codex" }, { label: "Claude", cmd: "claude" }], desktopWindow: undefined,
    ...extra });
  runInContext(code, s);
  Object.assign(s, extra);
  lastFixture = s.f;
  return s.f.CLI;
}
// @ts-ignore Node-only test.
const check = (n: number) => !process.env.CLI_ITEM || process.env.CLI_ITEM === String(n);
/** deletion.rs delete_branch (the branch_delete command) with real Git: refused while a worktree has the
 * branch, and only the approved tip goes. Its real-Git race tests are in deletion.rs. */
function branchDelete(repo: string, { branch, tip }: { branch: string; tip: string }) {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (git("worktree", "list", "--porcelain").split("\n").includes(`branch refs/heads/${branch}`)) throw `Cannot delete branch '${branch}': checked out at another worktree.`;
  git("update-ref", "--no-deref", "-d", `refs/heads/${branch}`, tip);
}

if (check(219)) {
  const base = mkdtempSync(join(tmpdir(), "loom-delete-tip-"));
  const real = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (const when of ["cli", "dialog", "closing", "delete", "other-worktree", "unchanged", "configured", "config-lock"]) {
      const repo = join(base, when), wt = join(base, `${when}-wt`);
      mkdirSync(repo);
      real(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "main\n");
      real(repo, "add", "a.txt"); real(repo, "commit", "-qm", "main");
      const main = real(repo, "rev-parse", "HEAD").trim();
      real(repo, "switch", "-q", "-c", "approved");
      writeFileSync(join(repo, "a.txt"), "A\n"); real(repo, "commit", "-qam", "A");
      const a = real(repo, "rev-parse", "HEAD").trim();
      real(repo, "switch", "-q", "--detach", main);
      writeFileSync(join(repo, "a.txt"), "B\n"); real(repo, "commit", "-qam", "B");
      const b = real(repo, "rev-parse", "HEAD").trim();
      real(repo, "switch", "-q", "main");
      real(repo, "worktree", "add", "-q", "--detach", wt, main);
      assert.notEqual(real(repo, "rev-parse", `${a}^{tree}`), real(repo, "rev-parse", `${b}^{tree}`));
      assert.equal(real(repo, "rev-list", "--count", `${main}..${a}`), real(repo, "rev-list", "--count", `${main}..${b}`));
      const move = () => real(repo, "branch", "-f", "approved", b);
      if (when === "configured" || when === "config-lock") {
        real(repo, "config", "branch.approved.remote", "origin");
        real(repo, "config", "branch.neighbor.remote", "keep");
        if (when === "config-lock") writeFileSync(join(repo, ".git", "config.lock"), "held");
      }
      const th = { id: "t", name: "t", dir: wt, repo, branch: "approved", isWorktree: true, panes: [], dispose: async () => { if (when === "closing") move(); } };
      const threads = [th];
      const c = fixture({ ...gitparse, threads, cliThread: () => th, toast() {}, renderSide() {}, show() {}, save() {},
        confirm: async () => { if (when === "dialog") move(); return true; },
        invoke: async (cmd: string, args: any) => {
          if (cmd === "worktree_fingerprint") return "unchanged detached files and index";
          if (cmd === "worktree_remove") return (real(repo, "worktree", "remove", "--force", args.dir), "fixture trash");
          if (cmd !== "branch_delete") return "";
          if (when === "delete") move();
          branchDelete(repo, args);
        },
        git: async (dir: string, ...args: string[]) => real(dir, ...args) });
      if (when === "cli") {
        const plan = await c["close-plan"].run({ _: ["t"], delete: "branch" });
        move();
        await assert.rejects(c["close-thread"].run({ _: ["t"], yes: true, delete: "branch", plan: plan.data.rev, discard: "commits" }), /changed since plan/);
        assert.equal(threads.length, 1);
      } else {
        if (when === "other-worktree") real(repo, "worktree", "add", "-q", join(base, "other"), "approved");
        const result = await lastFixture.removeThread(th, "all");
        if (when === "dialog") {
          assert.equal(result.removed, false);
          assert.match(result.error, /changed while the dialog was open.*branch.*commit/);
        } else if (["unchanged", "configured", "config-lock"].includes(when)) {
          assert.equal(result.branch, "deleted");
          if (when === "configured") {
            assert.throws(() => real(repo, "config", "--get", "branch.approved.remote"));
            assert.equal(real(repo, "config", "--get", "branch.neighbor.remote").trim(), "keep");
          }
          if (when === "config-lock") {
            assert.match(result.error, /deleted the branch.*settings/);
            assert.equal(readFileSync(join(repo, ".git", "config.lock"), "utf8"), "held");
          }
        }
        else {
          assert.equal(result.removed, true);
          assert.equal(result.branch, "failed");
          assert.match(result.error, when === "other-worktree" ? /checked out|used by worktree/ : /expected|changed/);
        }
      }
      if (!["unchanged", "configured", "config-lock"].includes(when)) assert.equal(real(repo, "rev-parse", "refs/heads/approved").trim(), when === "other-worktree" ? a : b);
      console.log(`ok   branch tip approval: ${when}`);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
}
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
  // The phone remote reads the window size and the startups the new-thread form offers.
  assert.deepEqual([(await c.status.run()).data.phone, (await c.status.run()).data.agents], [false, ["Codex", "Claude"]]);
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

if (check(304)) {
  const calls: [string, unknown][] = [];
  const c = fixture({ table: (rows: string[][]) => rows.map(r => r.join(" ")).join("\n"), invoke: async (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    return [{ id: "record", folder: "C:/old", at: "C:/trash/record", entry: "C:/repo/.git/worktrees/old", entry_at: "C:/repo/.git/loom-trash/record", pending: false },
      { id: "cut-short", error: "EOF while parsing a value at line 1 column 0" },
      { id: "half", folder: "C:/half", at: "C:/trash/half", entry: "C:/repo/.git/worktrees/half", entry_at: "C:/repo/.git/loom-trash/half", pending: false, restoring: "C:/back" }];
  } });
  const listed = await c.trash.run({ _: ["list"] });
  assert.equal(listed.data[0].id, "record");
  assert.match(listed.text, /folder C:\/old -> C:\/trash\/record/);
  assert.match(listed.text, /git C:\/repo\/.git\/worktrees\/old -> C:\/repo\/.git\/loom-trash\/record/);
  assert.match(listed.text, /cut-short unreadable EOF while parsing/);
  assert.match(listed.text, /half restoring folder C:\/half -> C:\/trash\/half/);
  assert.match(listed.text, /restore stopped on its way to C:\/back/);
  await assert.rejects(c.trash.run({ _: ["restore", "record"] }), /Use loomctl trash list/);
  assert.deepEqual(calls.map(([cmd]) => cmd), ["trash_list"]);
  console.log("ok   trash list says where each folder and its Git record went, to move both back by hand");
}

if (check(305)) {
  let now = Date.now(), calls = 0, limited = false;
  class Clock extends Date { static now() { return now; } }
  const c = fixture({ Date: Clock, PLAN_PROVIDERS: { claude: { command: "plan_usage" } },
    invoke: async () => { calls++; if (limited) throw new Error("usage rate limited; retry after 7200 seconds"); return { tier: "pro", stale: false, limits: [] }; } });
  await c.usage.run({ _: ["claude"] });
  assert.equal((await c.usage.run({ _: ["claude"] })).data.claude.cached, true, "a plain read keeps the five-minute cache");
  assert.equal((await c.usage.run({ _: ["claude"], refresh: true })).data.claude.cached, false, "--refresh skips the five minutes");
  assert.equal(calls, 2);
  limited = true;
  await c.usage.run({ _: ["claude"], refresh: true });
  now += 600_000;
  assert.equal((await c.usage.run({ _: ["claude"], refresh: true })).data.claude.cached, true, "--refresh waits out a rate limit");
  assert.equal(calls, 3);
  now += 6601_000;
  await c.usage.run({ _: ["claude"], refresh: true });
  assert.equal(calls, 4);
  console.log("ok   usage --refresh skips the five-minute cache but not a rate limit's cooldown");
}

if (check(307)) {
  // usage.rs clamps a 429's Retry-After to at least 300 s: a limit as long as the cache floor still holds a refresh.
  for (const answer of ["thrown", "fallback"]) {
    let now = Date.now(), calls = 0;
    class Clock extends Date { static now() { return now; } }
    const c = fixture({ Date: Clock, PLAN_PROVIDERS: { claude: { command: "plan_usage" } }, invoke: async () => {
      calls++;
      if (answer === "thrown") throw "usage rate limited; retry after 300 seconds";
      return { tier: "pro", stale: true, limits: [], retryAfterSeconds: 300 };
    } });
    assert.equal((await c.usage.run({ _: ["claude"], refresh: true })).data.claude.cached, false);
    assert.equal((await c.usage.run({ _: ["claude"], refresh: true })).data.claude.cached, true, `${answer}: a 300 s limit holds --refresh`);
    assert.equal(calls, 1);
    now += 301_000;
    assert.equal((await c.usage.run({ _: ["claude"], refresh: true })).data.claude.cached, false, `${answer}: and lets go when it ends`);
    assert.equal(calls, 2);
  }
  console.log("ok   usage --refresh waits out a 300-second rate limit, thrown or carried by a fallback reading");
}

if (check(306)) {
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  let seen = 0;
  const p = { id: "p", th, agent: "codex", waiting: true, seen() { seen++; this.waiting = false; } } as any;
  th.panes.push(p);
  const c = fixture({ threads: [th], current: th, cliPane: () => p, paneRows: () => "", show() { throw new Error("seen must not bring the pane to the front"); } });
  const r = await c.seen.run({ _: ["p"] });
  assert.equal(seen, 1);
  assert.equal(r.data.state, "idle");
  await assert.rejects(async () => c.seen.run({ _: [] }), /pane/);
  console.log("ok   seen clears a pane's wait without showing it");
}

if (check(308)) {
  // A task notice the policy sends goes to the phones: what ended, and where a tap goes.
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  const p = { id: "p1", th, agent: "codex", stableId: "k1" } as any;
  th.panes.push(p);
  const sent: any[] = [], notifyHistory: any[] = [];
  const c = fixture({ threads: [th], notifyHistory, current: null, dashboardOpen: false, paneRows: () => "", paneById: (id: string) => th.panes.find((x) => x.id === id), paneName: () => "work:1", liveScreen: () => "",
    push: async (m: any) => { sent.push(m); return { sent: 1, failed: [] }; } });
  const at = Date.now(), t = { id: "t1", pane: "p1", startedAt: at - 4 * 60_000 } as any;
  const notice = (seq: number, state: string, more = {}) => lastFixture.pushNotice(t, { seq, task: "t1", at, state, signal: "end", ...more });
  // A completion's response is its answer's promptMatch (task.ts), never words to show.
  const response = task.promptMatch("All tests pass.");
  assert.match(response, /^[0-9a-f]{16}$/);
  await notice(5, "completed", { response });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ title: "work:1 · Codex finished · 4 min", body: "Its task is done.", tag: "p1", url: "/#/pane/p1/work%3A1/k1" }]);
  await notice(6, "working");
  assert.equal(sent.length, 1, "working is no notice");
  await notice(7, "approval");
  assert.deepEqual([sent[1].title, sent[1].body], ["work:1 · Codex asks", "It's waiting on you."]);
  notifyHistory.push({ at: 7, on: true, kinds: { finish: false, fail: true, blocked: true }, panes: {} });
  await notice(8, "completed");
  assert.equal(sent.length, 2, "a kind turned off sends nothing");
  await notice(9, "failed", { detail: "codex exited 1" });
  assert.deepEqual([sent[2].title, sent[2].body], ["work:1 · Codex failed", "codex exited 1"]);
  await lastFixture.pushNotice({ ...t, pane: "gone" }, { seq: 10, task: "t1", at, state: "failed", signal: "end" });
  assert.equal(sent.length, 3, "a pane that's gone sends nothing");
  // loomctl remote push test: a notification that opens the first agent.
  assert.match((await c.remote.run({ _: ["push", "test"] })).text, /Sent to 1 phone/);
  assert.deepEqual([sent[3].tag, sent[3].url], ["loom-test", "/#/pane/p1/work%3A1/k1"]);
  await assert.rejects(async () => c.remote.run({ _: ["push"] }), /remote push takes test/);
  // The pane's stableId, in the links above and in its JSON: the pane Loom restores after a restart has it too.
  assert.equal((await c.panes.run({ _: [] })).data[0].stableId, "k1");
  console.log("ok   task notices become phone notifications that open the agent, as the policy allows; remote push test");
}

if (check(309)) {
  // loomctl relaunch: a pane working on something wants --yes, and the restart comes after the answer.
  const th = { name: "work", id: "th", dir: "C:/work", panes: [] as any[] };
  const p = { id: "p1", th, agent: "codex", busy: true } as any;
  th.panes.push(p);
  let relaunched = 0;
  const c = fixture({ threads: [th], current: th, dashboardOpen: false, paneRows: () => "", paneName: () => "work:1", relaunch: () => { relaunched++; } });
  await assert.rejects(async () => c.relaunch.run({ _: [] }), /work:1 is working: a restart stops it\. Add --yes\./);
  assert.equal(relaunched, 0);
  assert.deepEqual(Array.from((await c.relaunch.run({ _: [], yes: true })).data.stopping), ["work:1"]);
  assert.equal(relaunched, 0, "not before its answer");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relaunched, 1);
  p.busy = false;
  await c.relaunch.run({ _: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relaunched, 2, "nothing working: no --yes needed");
  const booted = (await c.status.run()).data.booted;
  assert.equal(typeof booted, "number", "status says when this Loom started");
  // --booted: the Loom it names restarts. Its replacement, a new process with a new booted and none of
  // the old one's keys, gets the retry of a request whose answer was lost, and restarts nothing.
  await c.relaunch.run({ _: [], yes: true, booted: String(booted) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relaunched, 3, "the Loom it names restarts");
  await new Promise((r) => setTimeout(r, 5));
  let replaced = 0;
  const next = fixture({ threads: [th], current: th, dashboardOpen: false, paneRows: () => "", paneName: () => "work:1", relaunch: () => { replaced++; } });
  assert.notEqual((await next.status.run()).data.booted, booted, "the replacement started later");
  const retry = await next.relaunch.run({ _: [], yes: true, booted: String(booted) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(replaced, 0, "the replacement keeps running");
  assert.match(retry.text, /already restarted/);
  console.log("ok   relaunch wants --yes while a pane works and restarts after its answer; status says when Loom started; --booted restarts only that Loom");
}
if (check(310)) {
  // The phone reads an agent's screen and its question in one request: read --menu answers what menu does.
  const survey = "How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss";
  let screen = claudeComposer + "\n" + survey;
  const p = { id: "p", th: { name: "work", panes: [] }, agent: "claude", term: { cols: 80, buffer: { active: { cursorX: 0, cursorY: 0, type: "normal" } } } };
  const c = fixture({ cliPane: () => p, liveScreen: () => screen, inputState: () => ({ kind: "empty" }), styledRows: () => [] });
  const menu = c.menu.run({ _: ["p"] }).data;
  assert.ok(menu?.rev, "the fixture shows a question");
  assert.deepEqual(c.read.run({ _: ["p"], styles: true, menu: true }).data.menu, menu);
  assert.ok(!("menu" in c.read.run({ _: ["p"], styles: true }).data), "plain read is as before");
  screen = claudeComposer;
  assert.equal(c.read.run({ _: ["p"], menu: true }).data.menu, null);
  console.log("ok   read --menu carries the pane's question, as menu reads it, or null");
}
if (check(208)) {
  // loomctl git, which the phone uses too, against real Git: a named file is
  // literal and a rename moves as one, as with the panel's buttons.
  const repo = mkdtempSync(join(tmpdir(), "loom-cli-git-"));
  const real = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=check", "-c", "user.email=check@loom", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  try {
    real("init", "-q", "-b", "main");
    writeFileSync(join(repo, "old.txt"), "keep\n");
    real("add", "-A");
    real("commit", "-qm", "start");
    real("mv", "old.txt", "new.txt");
    writeFileSync(join(repo, "a[1].txt"), "picked\n");
    writeFileSync(join(repo, "a1.txt"), "not picked\n");
    const th = { id: "t", name: "t", dir: repo, branch: "main", changed: null, setStat() {} };
    const c = fixture({ ...gitparse, cliThread: () => th, git: async (_: string, ...args: string[]) => real(...args), invoke: async () => "", changesOpen: false, save() {} });
    const git = (flags: Record<string, true>, ...words: string[]) => c.git.run({ _: ["t", ...words], yes: true, ...flags });
    await git({}, "unstage", "new.txt");
    await git({}, "stage", "a[1].txt");
    const s = (await git({}, "status")).data;
    assert.deepEqual([s.staged.map((f: any) => f.path), s.unstaged.map((f: any) => [f.path, f.y]), s.untracked.map((f: any) => f.path)],
      [["a[1].txt"], [["old.txt", "D"]], ["a1.txt", "new.txt"]], "unstaging the rename staged no deletion, and staging a[1].txt left a1.txt");
    await git({}, "unstage", "a[1].txt");
    await git({ untracked: true }, "discard", "a[1].txt");
    assert.deepEqual([existsSync(join(repo, "a[1].txt")), existsSync(join(repo, "a1.txt"))], [false, true], "deleting a[1].txt keeps a1.txt");
    // The phone pages the commits: --commits N of them, and moreCommits while git has older ones.
    real("commit", "-q", "--allow-empty", "-m", "second");
    real("commit", "-q", "--allow-empty", "-m", "third");
    const two = (await c.git.run({ _: ["t", "status"], commits: 2 })).data;
    assert.deepEqual(JSON.parse(JSON.stringify([two.commits.map((x: any) => x.subject), two.moreCommits])), [["third", "second"], true], "2 of 3 commits, and more");
    const three = (await c.git.run({ _: ["t", "status"], commits: 3 })).data;
    assert.deepEqual([three.commits.length, three.moreCommits], [3, false], "all 3 commits, and no more");
    assert.equal((await git({}, "status")).data.commits.length, 3, "10 by default");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("ok   loomctl git stages, unstages and deletes the named file only, and a rename as both names; status pages its commits");
}
if (check(213)) {
  // Every worktree of a repository shares one stash list. The stash listed as
  // stash@{0} stays the one picked after another worktree stashes on top of it.
  const base = mkdtempSync(join(tmpdir(), "loom-cli-stash-"));
  const repo = join(base, "repo"), other = join(base, "other");
  const real = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  try {
    mkdirSync(repo);
    real(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "f.txt"), "base\n");
    real(repo, "add", "-A");
    real(repo, "commit", "-qm", "start");
    real(repo, "worktree", "add", "-q", "-b", "other", other);
    const th = { id: "t", name: "t", dir: repo, branch: "main", changed: null, setStat() {} };
    const drops: unknown[] = [];
    const c = fixture({ ...gitparse, ...stash, cliThread: () => th, changesOpen: false, save() {},
      invoke: async (cmd: string, args: unknown) => (cmd === "stash_drop" && drops.push(args), ""),
      git: async (_: string, ...args: string[]) => (assert.ok(!(args[0] === "stash" && args[1] === "drop"), "a stash dropped by its place"), real(repo, ...args)) });
    const git = (...words: string[]) => c.git.run({ _: ["t", ...words], yes: true });
    const stashOn = (dir: string, text: string, message: string) => (writeFileSync(join(dir, "f.txt"), text), real(dir, "stash", "push", "-q", "-m", message));
    const listed = async () => (await git("stashes")).data.stashes as { ref: string; sha?: string; message: string }[];
    const pick = async (message: string) => { const s = (await listed()).find((x) => x.message.endsWith(message))!; return s.sha ?? s.ref; };
    stashOn(repo, "A\n", "A");
    const a = await pick("A");
    stashOn(other, "B\n", "B"); // another worktree's stash takes stash@{0}
    await git("stash-apply", a);
    assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "A\n", "applying the listed stash applied another worktree's");
    real(repo, "checkout", "--", "f.txt");
    // git drops only by place, worked out before it locks the list: the drop is
    // stash_drop's, by the commit listed, under that lock (stash.rs races it).
    await git("stash-drop", a);
    await git("stash-drop", "stash@{1}"); // an older caller's place, read once, now
    assert.deepEqual(JSON.parse(JSON.stringify(drops)), [{ dir: repo, sha: a }, { dir: repo, sha: a }], "dropping the listed stash dropped another");
    assert.match(a, /^[0-9a-f]{40}$/);
    await assert.rejects(git("stash-drop", "0123456789abcdef"), /No stash/, "a stash no longer listed is refused");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log("ok   loomctl git applies the stash it listed, whatever another worktree stashes meanwhile, and drops it by its commit");
}
if (check(217)) {
  // A SHA-256 repository lists 64-digit stash commits: the phone hands loomctl the full one.
  const repo = mkdtempSync(join(tmpdir(), "loom-cli-sha256-"));
  const real = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=check", "-c", "user.email=check@loom", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  try {
    real("init", "-q", "-b", "main", "--object-format=sha256");
    writeFileSync(join(repo, "f.txt"), "base\n");
    real("add", "-A");
    real("commit", "-qm", "start");
    writeFileSync(join(repo, "f.txt"), "A\n");
    real("stash", "push", "-q", "-m", "A");
    const th = { id: "t", name: "t", dir: repo, branch: "main", changed: null, setStat() {} };
    const drops: unknown[] = [];
    const c = fixture({ ...gitparse, ...stash, cliThread: () => th, changesOpen: false, save() {},
      invoke: async (cmd: string, args: unknown) => (cmd === "stash_drop" && drops.push(args), ""),
      git: async (_: string, ...args: string[]) => real(...args) });
    const git = (...words: string[]) => c.git.run({ _: ["t", ...words], yes: true });
    const a = (await git("stashes")).data.stashes[0].sha as string;
    assert.match(a, /^[0-9a-f]{64}$/);
    await git("stash-apply", a);
    assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "A\n", "the listed SHA-256 stash wasn't applied");
    await git("stash-drop", a);
    await git("stash-drop", a.slice(0, 50)); // a prefix longer than SHA-1's 40
    assert.deepEqual(JSON.parse(JSON.stringify(drops)), [{ dir: repo, sha: a }, { dir: repo, sha: a }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("ok   loomctl git applies and drops a SHA-256 repository's stash by its full commit or a prefix of it");
}
if (check(218)) {
  // git stash store of a commit already listed lists that one commit twice: one stash to name, not two.
  const repo = mkdtempSync(join(tmpdir(), "loom-cli-stored-twice-"));
  const real = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=check", "-c", "user.email=check@loom", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
  try {
    real("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f.txt"), "base\n");
    real("add", "-A");
    real("commit", "-qm", "start");
    for (const text of ["A", "B"]) writeFileSync(join(repo, "f.txt"), `${text}\n`), real("stash", "push", "-q", "-m", text);
    const a = real("rev-parse", "stash@{1}").trim();
    real("stash", "store", "-m", "second copy", a);
    const th = { id: "t", name: "t", dir: repo, branch: "main", changed: null, setStat() {} };
    const drops: unknown[] = [];
    const c = fixture({ ...gitparse, ...stash, cliThread: () => th, changesOpen: false, save() {},
      invoke: async (cmd: string, args: unknown) => (cmd === "stash_drop" && drops.push(args), ""),
      git: async (_: string, ...args: string[]) => real(...args) });
    const git = (...words: string[]) => c.git.run({ _: ["t", ...words], yes: true });
    assert.deepEqual((await git("stashes")).data.stashes.map((s: { sha: string }) => s.sha === a), [true, false, true]);
    await git("stash-apply", a);
    assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "A\n", "a commit listed twice was called ambiguous");
    await git("stash-drop", a);
    assert.deepEqual(JSON.parse(JSON.stringify(drops)), [{ dir: repo, sha: a }]);
    // Two different commits that share the prefix given are still two stashes.
    const [x, y] = ["abc1234" + "a".repeat(33), "abc1234" + "b".repeat(33)];
    const two = async () => `stash@{0}\t${x}\tOn main: x\nstash@{1}\t${y}\tOn main: y\n`;
    await assert.rejects(stash.stashCommit(two, "abc1234"), /More than one stash starts with abc1234/);
    assert.equal(await stash.stashCommit(two, "abc1234b"), y);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("ok   a stash commit listed twice is one stash to apply or drop; two commits sharing a prefix still need more of it");
}
if (check(209)) {
  // The phone's mic reads the PC's lists and picks: the same objects the mic menu shows.
  const langs = [{ label: "English", code: "en" }, { label: "auto", code: "" }, { label: "French", code: "fr" }];
  const prefixes = [{ text: "/prompt ", enter: true }, { text: "", enter: false }];
  const c = fixture({ langs, lang: langs[2], prefixes, prefix: prefixes[0] });
  const d = c.dictation.run({ _: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(d.data)), {
    langs: [{ label: "English", code: "en", on: false }, { label: "auto", code: "", on: false }, { label: "French", code: "fr", on: true }],
    prefixes: [{ text: "/prompt ", enter: true, on: true }, { text: "", enter: false, on: false }],
  });
  assert.match(d.text, /^\* +language +French +fr$/m);
  assert.match(d.text, /^\* +prefix +\/prompt +sent the moment it lands$/m);
  assert.match(d.text, /language +auto +detected per clip/);
  // The phone's Dictation sheet changes the PC's pick and lists, saved as the mic menu saves them.
  let saved = 0;
  const e = fixture({ langs, lang: langs[0], prefixes, prefix: prefixes[0], save: () => saved++, paintLang() {}, paintPrefix() {} });
  const run = (...argv: string[]) => {
    const enter = argv.indexOf("--enter");
    const a: any = { _: enter < 0 ? argv : argv.slice(0, enter) };
    if (enter >= 0) a.enter = argv[enter + 1];
    return JSON.parse(JSON.stringify(e.dictation.run(a).data));
  };
  const on = (d: any) => [d.langs.find((l: any) => l.on)?.code, d.prefixes.find((p: any) => p.on)?.text, d.prefixes.find((p: any) => p.on)?.enter];
  assert.deepEqual(on(run("lang", "fr")), ["fr", "/prompt ", true]);
  assert.deepEqual(on(run("lang", "Auto")), ["", "/prompt ", true], "auto, by its label, detects");
  assert.deepEqual(on(run("lang", "English")), ["en", "/prompt ", true]);
  let got = run("lang", "JA");
  assert.deepEqual([on(got)[0], got.langs.at(-1)], ["ja", { label: "ja", code: "ja", on: true }], "a new code is added and picked");
  assert.throws(() => run("lang", "x\u0000"), /whisper language code/);
  assert.throws(() => run("lang"), /Name the language/);
  got = run("prefix", "/review", "--enter", "on");
  assert.deepEqual([on(got), got.prefixes.length], [["ja", "/review ", true], 3], "a new prefix, with a space after it, sending itself");
  assert.deepEqual(on(run("prefix", "/prompt", "--enter", "off")), ["ja", "/prompt ", false], "an old one, picked by its text, waits now");
  assert.deepEqual(on(run("prefix")), ["ja", "", false], "no text is no prefix");
  assert.throws(() => run("prefix", "/x\r"), /one line/);
  assert.throws(() => run("lang", "fr", "--enter", "on"), /--enter/);
  assert.throws(() => run("prefix", "/x", "--enter", "maybe"), /--enter/);
  got = run("remove", "lang", "ja");
  assert.deepEqual([on(got)[0], got.langs.some((l: any) => l.code === "ja")], ["en", false], "removing the pick picks the first");
  got = run("remove", "prefix", "/review");
  assert.deepEqual(got.prefixes.map((p: any) => p.text), ["/prompt ", ""]);
  assert.throws(() => run("remove", "lang", "zz"), /No language "zz"/);
  assert.throws(() => run("remove", "lang"), /No language ""/, "remove lang needs a name, not auto by default");
  run("remove", "lang", "fr"); run("remove", "lang", "auto");
  assert.throws(() => run("remove", "lang", "en"), /last language stays/);
  run("remove", "prefix");
  assert.throws(() => run("remove", "prefix", "/prompt"), /last prefix stays/);
  assert.throws(() => run("louder"), /takes lang, prefix or remove/);
  assert.equal(saved, 12, "each change saved, and only the changes");
  console.log("ok   loomctl dictation lists the mic's languages and prefixes with the PC's pick, and picks, adds and removes them");
}
if (check(210)) {
  // Commits on a detached HEAD are on no branch: deleting the worktree, in any mode, loses them.
  const repo = mkdtempSync(join(tmpdir(), "loom-cli-detached-"));
  const real = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
  try {
    real("init", "-q", "-b", "main");
    real("commit", "-q", "--allow-empty", "-m", "start");
    const th = { id: "t", name: "t", dir: repo, repo: join(repo, "elsewhere"), branch: "loom/t" };
    fixture({ ...gitparse, git: async (_: string, ...args: string[]) => real(...args), invoke: async () => "fingerprint" });
    const c = lastFixture;
    assert.equal((await c.inventory(th, false)).loose, 0, "a HEAD on a branch loses nothing of its own");
    real("checkout", "-q", "--detach");
    real("commit", "-q", "--allow-empty", "-m", "detached one");
    real("commit", "-q", "--allow-empty", "-m", "detached two");
    assert.equal((await c.inventory(th, false)).loose, 2, "both detached commits count, deleting only the worktree");
    // The first inventory read the branch git had (main) over the cached loom/t; detached since, it keeps that.
    assert.equal(await c.headBranch(th), "main", "a detached worktree keeps its branch's name, never HEAD");
    assert.equal(await c.headBranch({ ...th, repo }), "HEAD", "the checkout itself says HEAD");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("ok   commits on a detached HEAD count as lost, and a detached worktree keeps its branch");
}
if (check(211)) {
  // The PC's 5-minute plan poll: each tick reads anew, though the reply took time to come.
  let now = 1_800_000_000_000, calls = 0;
  class Clock extends Date { static now() { return now; } }
  const c = fixture({ Date: Clock, PLAN_PROVIDERS: { claude: { command: "plan_usage" } },
    invoke: async () => { calls++; now += 800; return { tier: "pro", stale: false, limits: [] }; } });
  const start = now;
  for (let tick = 0; tick < 6; tick++) {
    now = start + tick * 300_000;
    const got = (await c.usage.run({ _: ["claude"] })).data.claude;
    assert.equal(got.cached, false, `tick ${tick} read anew`);
  }
  assert.equal(calls, 6);
  now += 60_000;
  assert.equal((await c.usage.run({ _: ["claude"] })).data.claude.cached, true, "a read between ticks shares the last");
  console.log("ok   the plan poll reads anew on each 5-minute tick, not every other one");
}
if (check(212)) {
  // A provider's cooldown holds every caller to the ms, measured from its answer;
  // only the 5-minute floor gets the poll's few seconds of slack.
  let now = 1_800_000_000_000, calls = 0, limited = true;
  class Clock extends Date { static now() { return now; } }
  const c = fixture({ Date: Clock, PLAN_PROVIDERS: { claude: { command: "plan_usage" } },
    invoke: async () => { calls++; now += 800; if (limited) throw new Error("usage rate limited; retry after 300 seconds"); return { tier: "pro", stale: false, limits: [] }; } });
  const usage = async (refresh = false) => (await c.usage.run({ _: ["claude"], ...(refresh ? { refresh: true } : {}) })).data.claude;
  const t0 = now;
  await usage();
  assert.equal(calls, 1);
  const hold = t0 + 800 + 300_000; // the provider's 300 s, from when it answered
  now = t0 + 300_000; // the next 5-minute tick
  assert.equal((await usage()).cached, true, "the next poll waited out the cooldown");
  now = hold - 1;
  assert.equal((await usage()).cached, true, "a poll 1 ms early");
  assert.equal((await usage(true)).cached, true, "a forced read 1 ms early");
  assert.equal(calls, 1);
  limited = false;
  now = hold;
  assert.equal((await usage()).cached, false, "the cooldown's end");
  assert.equal(calls, 2);
  // No cooldown: a poll up to 10 s before the floor reads anew, but no earlier, and a forced read always does.
  const asked = now - 800;
  now = asked + 300_000 - 10_001;
  assert.equal((await usage()).cached, true, "11 s before the floor");
  now = asked + 300_000 - 9_000;
  assert.equal((await usage()).cached, false, "9 s before the floor");
  now += 1_000;
  assert.equal((await usage(true)).cached, false, "--refresh skips the floor");
  assert.equal(calls, 4);
  console.log("ok   a provider's cooldown holds polls and forced reads to the ms, from its answer");
}
if (check(214)) {
  // A branch switched in the thread's terminal, not by Loom: status, Create PR,
  // branches and the deletion inventory all go by the branch git has now.
  const repo = mkdtempSync(join(tmpdir(), "loom-cli-switch-"));
  const real = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
  try {
    real("init", "-q", "-b", "main");
    real("commit", "-q", "--allow-empty", "-m", "start");
    real("remote", "add", "origin", "https://github.com/example/review-fixture.git");
    const th = { id: "t", name: "t", dir: repo, repo, branch: "main", changed: null, setStat() {} };
    const pushed: string[][] = [];
    fixture({ ...gitparse, ...stash, cliThread: () => th, invoke: async () => "fingerprint", changesOpen: false, save() {},
      git: async (_: string, ...args: string[]) => (args[0] === "push" ? (pushed.push(args), "") : real(...args)) });
    const c = lastFixture;
    real("switch", "-q", "-c", "topic"); // in the terminal
    real("commit", "-q", "--allow-empty", "-m", "topic only");
    assert.equal((await c.CLI.git.run({ _: ["t", "status"] })).data.branch, "topic", "status kept the branch Loom cached");
    assert.equal((await c.CLI.git.run({ _: ["t", "pr"] })).data.url, "https://github.com/example/review-fixture/compare/main...topic?expand=1");
    assert.deepEqual(pushed, [["push", "-u", "origin", "refs/heads/topic:refs/heads/topic"]]);
    assert.equal((await c.CLI.git.run({ _: ["t", "branches"] })).data.current, "topic");
    th.branch = "main";
    assert.equal((await c.inventory(th, true)).commits, 1, "deleting the branch counted main's commits, not topic's");
    assert.equal(th.branch, "topic");
    // Detached, a worktree keeps its branch's name; unborn, the checkout's name is the one to come.
    real("switch", "-q", "--detach");
    assert.equal((await c.CLI.git.run({ _: ["t", "status"] })).data.branch, "HEAD", "the checkout itself says HEAD");
    const unborn = mkdtempSync(join(tmpdir(), "loom-cli-unborn-"));
    try {
      execFileSync("git", ["-C", unborn, "init", "-q", "-b", "fresh"]);
      Object.assign(th, { dir: unborn, repo: unborn, branch: "main" });
      fixture({ ...gitparse, ...stash, cliThread: () => th, invoke: async () => "", changesOpen: false, save() {},
        git: async (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }) });
      assert.equal((await lastFixture.CLI.git.run({ _: ["t", "branches"] })).data.current, "fresh");
    } finally { rmSync(unborn, { recursive: true, force: true }); }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("ok   a branch switched in the terminal is the one status, Create PR, branches and deletion use");
}
if (check(215)) {
  // The dialog names the branch it deletes. An agent can switch the worktree to
  // another branch at the same commit while the dialog is open, or after it.
  const base = mkdtempSync(join(tmpdir(), "loom-cli-approved-"));
  const repo = join(base, "repo"), wt = join(base, "wt");
  const real = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
  try {
    mkdirSync(repo);
    real(repo, "init", "-q", "-b", "main");
    real(repo, "commit", "-q", "--allow-empty", "-m", "start");
    real(repo, "branch", "unapproved");
    real(repo, "worktree", "add", "-q", "-b", "approved", wt);
    const asked: string[] = [];
    let answering = () => {}, closing = () => {};
    const th = { id: "t", name: "t", dir: wt, repo, branch: "approved", isWorktree: true, panes: [], dispose: async () => closing() };
    const threads = [th];
    fixture({ ...gitparse, threads, toast() {}, renderSide() {}, show() {}, save() {},
      confirm: async (what: string) => (asked.push(what), answering(), true),
      // The native fingerprint of the files and index: the same on either branch.
      invoke: async (cmd: string, args: any) => (cmd === "worktree_fingerprint" ? "same contents" : cmd === "worktree_remove" ? (real(repo, "worktree", "remove", "--force", args.dir), "trash") : cmd === "branch_delete" ? branchDelete(repo, args) : ""),
      git: async (dir: string, ...args: string[]) => real(dir, ...args) });
    const remove = lastFixture.removeThread;
    const branches = () => real(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
    answering = () => real(wt, "switch", "-q", "unapproved");
    const refused = await remove(th, "all");
    assert.match(asked[0], /AND the branch approved\?/);
    assert.deepEqual(branches(), ["approved", "main", "unapproved"], "a branch the dialog never named was deleted");
    assert.deepEqual([refused.removed, threads.length, existsSync(wt)], [false, 1, true]);
    assert.match(refused.error, /changed while the dialog was open \(the branch it's on \(unapproved, not approved\)\), so nothing was closed/);
    // Approved, and then the worktree switches while its panes close, and a status poll reads it.
    real(wt, "switch", "-q", "approved");
    answering = () => {};
    closing = () => (real(wt, "switch", "-q", "unapproved"), (th.branch = "unapproved"));
    const done = await remove(th, "all");
    assert.match(asked[1], /AND the branch approved\?/);
    assert.deepEqual([done.removed, done.branch, existsSync(wt)], [true, "deleted", false]);
    assert.deepEqual(branches(), ["main", "unapproved"], "the branch deleted wasn't the one approved");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log("ok   deleting a worktree and its branch deletes the branch the dialog named, or nothing");
}
if (check(216)) {
  // loomctl close-thread --delete branch: the branch its plan named, or without a plan the one Git has checked out.
  const base = mkdtempSync(join(tmpdir(), "loom-cli-plan-branch-"));
  const real = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
  let hashed = () => {};
  /** A repository, a worktree on approved, unapproved at the same commit, and loomctl over it. */
  const setup = (name: string) => {
    const repo = join(base, name, "repo"), wt = join(base, name, "wt");
    mkdirSync(repo, { recursive: true });
    real(repo, "init", "-q", "-b", "main");
    real(repo, "commit", "-q", "--allow-empty", "-m", "start");
    real(repo, "branch", "unapproved");
    real(repo, "worktree", "add", "-q", "-b", "approved", wt);
    const th = { id: "t", name: "t", dir: wt, repo, branch: "approved", isWorktree: true, panes: [], dispose: async () => {} };
    fixture({ ...gitparse, threads: [th], cliThread: () => th, toast() {}, renderSide() {}, show() {}, save() {},
      sha256: async (text: string) => { const h = await cli.sha256(text); hashed(); return h; },
      invoke: async (cmd: string, args: any) => (cmd === "worktree_fingerprint" ? "same contents" : cmd === "worktree_remove" ? (real(repo, "worktree", "remove", "--force", args.dir), "trash") : cmd === "branch_delete" ? branchDelete(repo, args) : ""),
      git: async (dir: string, ...args: string[]) => real(dir, ...args) });
    const f = lastFixture;
    return { repo, wt, th, f, close: (a: object) => f.CLI["close-thread"].run({ _: ["t"], yes: true, delete: "branch", ...a }),
      branches: () => real(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort() };
  };
  try {
    // A switch before close-thread's own inventory changes the plan's rev.
    let x = setup("before");
    let rev = (await x.f.CLI["close-plan"].run({ _: ["t"], delete: "branch" })).data.rev;
    real(x.wt, "switch", "-q", "unapproved");
    await assert.rejects(x.close({ plan: rev }), /changed since plan/);
    assert.deepEqual([x.branches(), existsSync(x.wt)], [["approved", "main", "unapproved"], true]);
    // A switch, read by a status poll, after that inventory and while the plan's rev is hashed: the plan still matches.
    x = setup("hashing");
    const planned = (await x.f.CLI["close-plan"].run({ _: ["t"], delete: "branch" })).data;
    assert.equal(planned.branch, "approved");
    let armed = true;
    hashed = () => { if (armed) (armed = false), real(x.wt, "switch", "-q", "unapproved"), void x.f.syncBranch(x.th); };
    await x.close({ plan: planned.rev });
    hashed = () => {};
    await new Promise((r) => setTimeout(r, 50)); // the poll's sync settles
    assert.deepEqual(x.branches(), ["main", "unapproved"], "close-thread deleted a branch its plan didn't name");
    // --force has no plan: a switch in the terminal that Loom's cache hasn't seen.
    x = setup("forced");
    real(x.wt, "switch", "-q", "unapproved");
    await x.close({ force: true });
    assert.deepEqual([x.branches(), existsSync(x.wt)], [["approved", "main"], false], "close-thread --force deleted the cached branch, not the one checked out");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log("ok   loomctl close-thread --delete branch deletes its plan's branch, or the one checked out when there's no plan");
}
if (check(311)) {
  // An approval moves on unseen only once Loom saw its question as a menu and then saw it gone 2 s.
  const menu = `Would you like to run the following command?

  $ npm test

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
`;
  let screen = `Question: which branch should I use?
› `, clock = 0;
  const moves: string[] = [];
  const p = { id: "p", generation: 1, agent: "codex", dead: false, interruptAt: 0, screen: () => "" };
  const t: any = { id: "t", pane: "p", gen: 1, state: "approval", events: [{ seq: 1, state: "approval" }] };
  fixture({ tasks: new Map([["t", t]]), shuttingDown: false, enterHeld: new Set(), paneById: () => p, interruptHint: () => false, sweepTimer: 0,
    liveScreen: () => screen, Date: { now: () => clock }, moveTask: (_: unknown, c: any) => { moves.push(`${c.state}:${c.signal}`); t.state = c.state; } });
  const sweep = (at: number) => ((clock = at), lastFixture.sweepTasks());
  sweep(0); sweep(5000);
  assert.deepEqual(moves, [], "a free-text question Loom can't read moved on by itself");
  screen = menu; sweep(6000);
  screen = ""; sweep(7000); sweep(8000);
  assert.deepEqual(moves, [], "gone for 1 s is still asking");
  sweep(9100);
  assert.deepEqual(moves, ["working:answered"], "a menu answered where Loom can't see stayed asking");
  // The next question, which Loom can't read, starts unseen.
  t.state = "approval"; t.events.push({ seq: 2, state: "approval" });
  screen = `Question: and which remote?
› `; sweep(9200); sweep(20000);
  assert.deepEqual(moves, ["working:answered"], "the last question's menu moved the next one on");
  console.log("ok   an approval moves on unseen only after its own menu was seen and then gone 2 s");
}
if (check(312)) {
  // A repeated startup label becomes "label (N)". --agent takes the first label equal in any case and the
  // form's saved count the exact label, so the renaming may change neither for any label in the list.
  type Startup = { label: string; cmd: string };
  const live: Startup[] = [];
  let command = "";
  const th = { panes: [], addPane: async ({ cmd }: { cmd: string }) => { command = cmd; return { id: "p", th, agent: "shell" }; } };
  const c = fixture({ MAX_PANES: 16, cliThread: () => th, show() {}, revealPane() {}, save() {}, startups: live });
  const unique = lastFixture.uniqueStartups as (list: Startup[]) => Startup[];
  const agent = (list: Startup[], name: string) => {
    live.splice(0, live.length, ...list);
    command = "";
    return c.add.run({ _: [], agent: name }).then(() => command, (e: Error) => `error: ${e.message}`);
  };
  const saved = [{ label: "powershell", cmd: "" }, { label: "powershell", cmd: "powershell" }, { label: "PowerShell (2)", cmd: "pwsh" }];
  assert.equal(unique(saved).map((s) => s.label).join(), "powershell,powershell (3),PowerShell (2)");
  assert.equal(await agent(unique(saved), "powershell (2)"), "pwsh", "a number Loom gave took a saved alias's --agent in another case");
  const entries = ["a", "A", "a (2)", "A (2)", "a (3)", "a (2) (2)"].flatMap((label) => ["x", "y"].map((cmd) => ({ label, cmd })));
  let lists: Startup[][] = [[]];
  for (let size = 1; size <= 3; size++) lists = [...lists, ...lists.filter((l) => l.length === size - 1).flatMap((l) => entries.map((e) => [...l, e]))];
  for (const list of lists) {
    const out = unique(list), seen = JSON.stringify(list);
    assert.equal(JSON.stringify(unique(out)), JSON.stringify(out), `normalizing twice changes nothing: ${seen}`);
    assert.equal(new Set(out.map((s) => s.label)).size, out.length, `one row per label: ${seen}`);
    for (const s of list) {
      assert.ok(out.some((o) => o.cmd === s.cmd), `no command lost: ${seen}`);
      assert.equal(out.find((o) => o.label === s.label)?.cmd, list.find((o) => o.label === s.label)!.cmd, `the form's count for "${s.label}" starts the same: ${seen}`);
      for (const name of [s.label, s.label.toLowerCase(), s.label.toUpperCase()])
        assert.equal(await agent(out, name), await agent(list, name), `--agent "${name}" starts the same: ${seen}`);
    }
  }
  console.log(`ok   renaming repeated startup labels keeps what every listed label starts, by --agent in any case and by the form (${lists.length} lists)`);
}
