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
const close = text.slice(text.indexOf("  let closing = false;"), text.indexOf('  for (const id of ["#new-thread", "#open-first"])'));
assert.ok(close.includes("onCloseRequested"));
const code = ts.transpileModule(handlers.join("\n") + "\nglobalThis.create = createThread; globalThis.cli = runCli;\n(async () => {\n" + close + "\n})();", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const p = { id: "p", dead: false, paint() {}, exited() { this.dead = true; } };
let nativeClosed = false, destroyed = false, drains = 0, restart = 0, shutdowns = 0;
let closeHandler: () => Promise<void>;
const pendingWrites = ["final report"];
let diskFull = true;
class TestError extends Error {}
const sandbox = createContext({ console, setTimeout, Date, agentBatch: 0, shuttingDown: false,
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

const receive = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "receiveAgentBatch")!;
const ordered: string[] = [];
const batches = createContext({ agentBatch: 0, agentBatches: new Map(), agentEvents: (events: [string, unknown][]) => ordered.push(...events.map(e => e[0])) });
runInContext(ts.transpileModule(receive.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, batches);
batches.receiveAgentBatch({ seq: 2, events: [["second", {}]] });
assert.equal(batches.agentBatch, 0, "a later batch does not satisfy a missing earlier batch");
batches.receiveAgentBatch({ seq: 1, events: [["first", {}]] });
assert.deepEqual(ordered, ["first", "second"]);
assert.equal(batches.agentBatch, 2);
batches.receiveAgentBatch({ seq: 1, events: [["duplicate", {}]] });
assert.equal(ordered.length, 2);
console.log("ok   R15-5 numbered reports route in contiguous order even when delivery is reversed");
