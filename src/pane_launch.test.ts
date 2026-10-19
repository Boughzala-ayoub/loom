// Pane's real spawn, launch and stop against a model of lib.rs's sessions:
// one per pane, replaced by pty_spawn, and pty_kill refuses a launch that
// isn't the one installed.
// @ts-ignore Node-only test; the app intentionally has no Node typings.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { Settler } from "./pane_events.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const pane = source.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === "Pane")!;
const names = new Set(["spawn", "launch", "stop", "exited", "launchGen", "launched", "installed", "launching", "starts", "launchPending", "generation"]);
const members = pane.members.filter((m) => m.name && names.has(m.name.getText(source))).map((m) => m.getText(source));
const code = ts.transpileModule(`globalThis.P = class {\n${members.join("\n")}\n};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const native = new Map<string, number>();
  const calls: [string, any][] = [];
  let hold: ((v: boolean) => void)[] | null = null;
  const invoke = async (cmd: string, a: any) => {
    calls.push([cmd, a]);
    if (cmd === "has_session") return hold ? new Promise((r) => hold!.push(r)) : true;
    if (cmd === "pty_spawn") return void native.set(a.id, a.launch);
    if (cmd === "pty_kill") {
      if (a.launch != null && native.has(a.id) && native.get(a.id) !== a.launch) return;
      return void native.delete(a.id);
    }
  };
  const s = createContext({ invoke, console, restoring: false, shuttingDown: false, outs: new Map(), ackOutput() {}, ownSession: () => false,
    Channel: class { id = Math.random(); onmessage?: unknown }, launch: () => ["claude"], booted: async () => {}, claudeMarker: () => "" });
  runInContext(code, s);
  const p = Object.assign(new s.P(), {
    id: "pane-1", agent: "claude", sid: "sid-1", startup: "claude", effort: "", dead: true, disposed: false, th: { dir: "C:\\work" },
    out: { id: 0 }, term: { cols: 80, rows: 24, write() {}, reset() {} }, paint() {}, retryCodexStartup() {}, settler: { see() {}, stop() {} },
  });
  return { p, native, calls, holdSessions: () => (hold = []), releaseSessions: () => hold!.splice(0).forEach((r) => r(true)) };
}

{
  // Review R14-3: a Claude launch publishes itself, then checks its session.
  // A stop meanwhile ends the process that is still running, not the one
  // that would replace it, and that launch gives up.
  const { p, native, calls, holdSessions, releaseSessions } = fixture();
  assert.equal(await p.spawn(false), true);
  const first = native.get("pane-1");
  assert.ok(first && !p.dead);
  holdSessions();
  const relaunch = p.spawn(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.some(([c]) => c === "has_session") && p.launched !== first, "the relaunch is checking its session");
  await p.stop();
  releaseSessions();
  assert.notEqual(await relaunch, true);
  assert.ok(p.dead, "the pane says it stopped");
  assert.ok(!native.has("pane-1"), "the stop left the process it said it ended running");
  assert.equal(calls.filter(([c]) => c === "pty_spawn").length, 1, "the stopped relaunch still started a process");
  console.log("ok   A stop during a relaunch's session check ends the running process, and the relaunch gives up");
}

{
  // Review round 1, 3: an exit still settling when a relaunch begins isn't the relaunch's,
  // however long its session check keeps it from repainting.
  const { p, holdSessions, releaseSessions } = fixture();
  const state = (x: any) => (x.dead ? "exited" : x.starting ? "starting" : "idle");
  const events: string[] = [];
  p.settler = new Settler((old, st) => events.push(`${old}>${st} gen ${p.generation} exit ${p.exitCode ?? null}`), 30, () => state(p));
  p.paint = () => p.settler.see(state(p));
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const up = async (launch: Promise<unknown>) => { assert.equal(await launch, true); p.starting = false; p.paint(); await settle(); };
  await up(p.spawn(false));
  p.exited(0);
  await settle();
  assert.deepEqual(events, ["starting>idle gen 1 exit null", "idle>exited gen 1 exit 0"], "an exit that stood is the launch's that exited");
  holdSessions();
  let relaunch = p.spawn(true);
  await settle();
  assert.deepEqual(events.slice(2), ["exited>starting gen 2 exit null"], "the relaunch is starting while its session check waits");
  releaseSessions();
  await up(relaunch);
  events.length = 0;
  p.exited(0);
  holdSessions();
  relaunch = p.spawn(true); // within the settle time
  await settle();
  assert.deepEqual(events, ["idle>starting gen 3 exit null"], "an exit replaced by a relaunch never settles, under the old launch or the new");
  releaseSessions();
  await up(relaunch);
  console.log("ok   A relaunch held in its session check never reports the last launch's exit as its own");
}
