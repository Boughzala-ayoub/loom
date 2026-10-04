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

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["CLI", "CliTimeout", "CliError", "cliWord", "cliCommand", "cliTask", "record", "taskText", "taskLocation", "paneName", "paneData", "threadData", "threadState", "cliState", "CLI_STATES", "windowStep", "waitTask", "taskStates"]);
const pieces: string[] = [];
for (const node of source.statements) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name!.text)) pieces.push(node.getText(source));
  if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations)
    if (names.has(d.name.getText(source))) pieces.push(`const ${d.getText(source)};`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { CLI };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(extra: Record<string, unknown> = {}) {
  const s = createContext({ ...cli, ...task, console, setTimeout: (f: () => void) => setTimeout(f, 10), clearTimeout,
    threads: [], current: null, unsaved: new Set(), tasks: new Map(), startups: [{ label: "Codex", cmd: "codex" }, { label: "Claude", cmd: "claude" }],
    ...extra });
  runInContext(code, s);
  return s.f.CLI;
}
// @ts-ignore Node-only test.
const check = (n: number) => !process.env.CLI_ITEM || process.env.CLI_ITEM === String(n);
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
  assert.equal(c.task.run({ _: [t.id] }).data.ref, "work:2");
  th.panes.shift();
  assert.match(c.task.run({ _: [t.id] }).text, /on work:1/);
  th.panes.length = 0;
  assert.equal(c.task.run({ _: [t.id] }).data.ref, null);
  assert.equal(c.task.run({ _: [t.id] }).data.paneClosed, true);
  assert.match(c.task.run({ _: [t.id] }).text, /closed pane/);
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
