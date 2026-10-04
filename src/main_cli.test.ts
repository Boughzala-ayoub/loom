// Production command handlers, with only native/window boundaries replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const check = (n: number) => !process.env.CLI_ITEM || process.env.CLI_ITEM === String(n);
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
