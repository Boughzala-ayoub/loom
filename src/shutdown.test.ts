// Execute the production close callback, with native/window/storage boundaries controlled.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const text = readFileSync("src/main.ts", "utf8");
const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
const handlers = source.statements.filter(n => ts.isFunctionDeclaration(n) && ["runCli", "createThread"].includes(n.name?.text ?? "")).map(n => n.getText(source));
const close = text.slice(text.indexOf("  let closing = false"), text.indexOf('  for (const id of ["#new-thread", "#open-first"])'));
assert.ok(close.includes("onCloseRequested"));
const code = ts.transpileModule(handlers.join("\n") + "\nglobalThis.create = createThread; globalThis.cli = runCli;\n(async () => {\n" + close + "\n})();", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const p = { id: "p", dead: false, paint() {}, exited() { this.dead = true; } };
let nativeClosed = false, destroyed = false, drains = 0, restart = 0, shutdowns = 0;
let closeHandler: () => Promise<void>;
const pendingWrites = ["final report"];
let diskFull = true;
class TestError extends Error {}
const sandbox = createContext({ console, setTimeout, Date, agentBatch: 0, shuttingDown: false, relaunching: false,
  document: { body: { inert: false } }, threads: [{ panes: [p] }], MAX_PANES: 8,
  pollSessions: async () => {}, flushSave: async () => {}, saveQueue: Promise.resolve(),
  drainJournal: async () => { if (++drains > 1 && diskFull) throw new Error("disk full"); if (!diskFull) pendingWrites.length = 0; },
  invoke: async (cmd: string) => { assert.equal(cmd, "pty_shutdown"); nativeClosed = true; shutdowns++; return { events: [["p", { kind: "end" }]], emitted: 0 }; },
  agentEvents: () => {}, sweepTasks: () => {}, toast: () => {},
  getCurrentWindow: () => ({ onCloseRequested: async (cb: (e: unknown) => Promise<void>) => { closeHandler = () => cb({ preventDefault() {} }); }, destroy: async () => { destroyed = true; } }),
  CLI: { restart: { run: async () => { restart++; return { text: "restarted" }; } } }, parseArgs: () => ({ _: [] }),
  CliTimeout: TestError, CliError: TestError, NotSubmitted: TestError,
});
await runInContext(code, sandbox);
await closeHandler!();
assert.ok(nativeClosed && !destroyed);
assert.equal(p.dead, true, "native shutdown killed the pane but the surviving page still calls it running");
const restarted = await sandbox.cli({ cmd: "restart", argv: [], timeout: 1 });
assert.equal(restarted.ok, false, "a cancelled close admitted new work while native reports remained closed");
assert.equal(restart, 0);
await assert.rejects(sandbox.create("repo", "new", "", "", 1), /clos|shutdown/i);
assert.equal(pendingWrites.length, 1, "failed final writes must remain retryable");
diskFull = false;
await closeHandler!();
assert.ok(destroyed && pendingWrites.length === 0);
assert.equal(shutdowns, 1, "retry must retain the committed shutdown instead of killing again");
console.log("ok   R15-4 final journal failure keeps killed panes stopped, blocks new work and retries close");

const named = (names: string[]) => source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? "")).map(n => n.getText(source)).join("\n");
const router = named(["receiveAgentBatch", "routeAgentBatches"]);
const ordered: string[] = [];
const batches = createContext({ agentBatch: 0, agentBatches: new Map(), agentEvents: (events: [string, unknown][]) => ordered.push(...events.map(e => e[0])) });
runInContext(ts.transpileModule(router, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, batches);
batches.receiveAgentBatch({ seq: 2, events: [["second", {}]] });
assert.equal(batches.agentBatch, 0, "a later batch does not satisfy a missing earlier batch");
batches.receiveAgentBatch({ seq: 1, events: [["first", {}]] });
assert.deepEqual(ordered, ["first", "second"]);
assert.equal(batches.agentBatch, 2);
batches.receiveAgentBatch({ seq: 1, events: [["duplicate", {}]] });
assert.equal(ordered.length, 2);
console.log("ok   R15-5 numbered reports route in contiguous order even when delivery is reversed");

// R16-5: Ctrl+R reloads the page, which starts again at batch 0 while Rust has
// already sent batches 1 and 2 to the page before it. The page runs its real
// close callback and report listener, on a clock that skips the waits.
const listening = text.slice(text.indexOf("  // What the agents report for loomctl's tasks"), text.indexOf("  // Codex's notify script"));
assert.ok(listening.includes('"agent-events"'));
async function page(sentBefore: number, emitted: number) {
  let clock = 0, onBatch = (_: { payload: unknown }) => {}, request = async () => {};
  const routed: string[] = [], toasts: string[] = [];
  const sandbox = createContext({ console, Date: { now: () => clock }, setTimeout: (f: () => void, ms: number) => { clock += ms; setTimeout(f, 0); },
    agentBatch: 0, agentBatches: new Map(), shuttingDown: false, relaunching: false, document: { body: { inert: false } }, threads: [{ panes: [{ id: "p", paint() {} }] }],
    pollSessions: async () => {}, flushSave: async () => {}, saveQueue: Promise.resolve(), drainJournal: async () => {},
    invoke: async (cmd: string) => cmd === "agent_batch_base" ? sentBefore : { events: [["p", "final"]], emitted },
    listen: async (_: string, f: typeof onBatch) => { onBatch = f; return () => {}; },
    agentEvents: (events: [string, unknown][]) => routed.push(...events.map(e => String(e[1]))), sweepTasks: () => {}, toast: (m: string) => toasts.push(m),
    getCurrentWindow: () => ({ onCloseRequested: async (cb: (e: unknown) => Promise<void>) => { request = () => cb({ preventDefault() {} }); }, destroy: async () => { routed.push("destroyed"); } }),
  });
  await runInContext(ts.transpileModule(router + "\n(async () => {\n" + close + listening + "\n})();", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  await new Promise(r => setTimeout(r, 0));
  return { routed, toasts, close: () => request(), deliver: (seq: number) => onBatch({ payload: { seq, events: [["p", `batch ${seq}`]] } }) };
}
const reloaded = await page(2, 3);
reloaded.deliver(3);
await reloaded.close();
assert.deepEqual(reloaded.routed, ["batch 3", "final", "destroyed"], "a reloaded page must route Rust's next batch and close in one attempt");
console.log("ok   R16-5 a reloaded page starts after the batches Rust already sent, and closes");

const lost = await page(0, 2);
lost.deliver(2);
await lost.close();
assert.deepEqual(lost.routed, [], "a missing batch must cancel the first close");
assert.match(lost.toasts[0], /batch 1 of 2/);
await lost.close();
assert.deepEqual(lost.routed, ["batch 2", "final", "destroyed"], "a batch that never lands must not keep the window open for good");
const behind = await page(0, 0);
for (let seq = 2; seq <= 66; seq++) behind.deliver(seq);
assert.equal(behind.routed.length, 65, "batches behind one that never lands must not pile up without bound");
console.log("ok   R16-5 a batch that never lands is given up on by the second close, or after 64 later ones");

// Restarting (main.ts relaunch): the same safe close, and the new Loom is started
// only once everything is on record, just before the window goes. A start that
// fails keeps the window, panes stopped, as a failed close does.
for (const fails of [false, true]) {
  const order: string[] = [];
  let request = async () => {};
  const s = createContext({ console, setTimeout, Date, agentBatch: 0, shuttingDown: false, relaunching: true, document: { body: { inert: false } },
    threads: [{ panes: [{ id: "p", paint() {} }] }], pollSessions: async () => {}, flushSave: async () => {}, saveQueue: Promise.resolve(),
    drainJournal: async () => { order.push("journal"); },
    invoke: async (cmd: string) => { order.push(cmd); if (cmd === "relaunch" && fails) throw new Error("no exe"); return { events: [], emitted: 0 }; },
    agentEvents: () => {}, sweepTasks: () => {}, toast: () => { order.push("toast"); },
    getCurrentWindow: () => ({ onCloseRequested: async (cb: (e: unknown) => Promise<void>) => { request = () => cb({ preventDefault() {} }); }, destroy: async () => { order.push("destroyed"); } }),
  });
  await runInContext(ts.transpileModule(`(async () => {\n${close}\n})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
  await new Promise(r => setTimeout(r, 0));
  await request();
  assert.deepEqual(order, ["journal", "pty_shutdown", "journal", "relaunch", fails ? "toast" : "destroyed"]);
  assert.equal(s.relaunching, !fails, "a failed start leaves no restart armed for the next close");
}
console.log("ok   a restart closes safely and starts the new Loom only before the window goes; a failed start keeps the window");
// A save that fails on every try (a locked backup, a full disk) must not leave
// killing Loom as the only way out: the second failed close asks to close anyway.
for (const answer of [false, true]) {
  const asked: string[] = [];
  let request = async () => {}, destroyed = false;
  const s = createContext({ console, setTimeout, Date, agentBatch: 0, shuttingDown: false, relaunching: false, document: { body: { inert: false } },
    threads: [{ panes: [{ id: "p", paint() {} }] }], pollSessions: async () => {}, saveQueue: Promise.resolve(), drainJournal: async () => {},
    flushSave: async () => { throw new Error("couldn't keep a backup"); },
    invoke: async () => ({ events: [], emitted: 0 }), agentEvents: () => {}, sweepTasks: () => {}, toast: () => {},
    confirm: async (title: string) => (asked.push(title), answer),
    getCurrentWindow: () => ({ onCloseRequested: async (cb: (e: unknown) => Promise<void>) => { request = () => cb({ preventDefault() {} }); }, destroy: async () => { destroyed = true; } }),
  });
  await runInContext(ts.transpileModule(`(async () => {\n${close}\n})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, s);
  await new Promise(r => setTimeout(r, 0));
  await request();
  assert.deepEqual([asked, destroyed], [[], false], "the first failure only says so");
  await request();
  assert.deepEqual([asked, destroyed], [["Close without saving?"], answer], "the second asks, and closes only on yes");
  assert.equal(s.windowClosing, false, "a refused close lets a restart be asked for again");
}
console.log("ok   a close that keeps failing asks to close without saving the second time");
