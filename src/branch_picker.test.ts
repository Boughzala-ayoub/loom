// Actual desktop/CLI list-to-switch paths; only rendering and status are inert.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { test } from "node:test";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
// @ts-ignore Node-only test.
import { tmpdir } from "node:os";
// @ts-ignore Node-only test.
import { join } from "node:path";
// @ts-ignore Node-only test.
import { execFileSync } from "node:child_process";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as cli from "./cli.ts";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = ["headBranch", "syncBranch", "showBranches", "gitDo", "cliWord", "CliError"];
const pieces = source.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && names.includes(n.name?.text ?? "")).map(n => n.getText(source));
for (const n of source.statements) if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (d.name.getText(source) === "CLI") {
  let init = d.initializer!;
  while (!ts.isObjectLiteralExpression(init)) init = (init as ts.AsExpression).expression;
  const git = init.properties.find(p => p.name?.getText(source) === "git") as ts.PropertyAssignment;
  pieces.push(`const command = (${git.initializer.getText(source)}).run;`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { showBranches, command };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

for (const branch of ["\u00a0approved", "approved\u00a0", "approved"]) test(`picker preserves ${JSON.stringify(branch)}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-picker-")), repo = join(dir, "repo"), wt = join(dir, "wt");
  try {
    mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "B"); git(repo, "add", "f"); git(repo, "commit", "-qm", "B");
    const b = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "worktree", "add", "-q", "-b", branch, wt);
    writeFileSync(join(wt, "f"), "A"); git(wt, "commit", "-qam", "A");
    const a = git(wt, "rev-parse", "HEAD").trim();
    git(repo, branch === "approved" ? "tag" : "branch", "approved", b);
    const th = { dir: wt, repo, branch, setStat() {} }, rows: { label: string; click: () => void }[] = [], errors: string[] = [];
    let finished = () => {};
    const sandbox = createContext({ ...cli, console, threads: [th], cliThread: () => th, current: null, changesOpen: false,
      save() {}, toast: (s: string) => errors.push(s), $: () => ({ disabled: false }), pollStats() {},
      git: async (cwd: string, ...args: string[]) => git(cwd, ...args), gitStatus: async () => ({}),
      refreshChanges: async () => finished(), showGitMenu: (_: unknown, m: any) => m.rows([]),
      menuItem: (_: unknown, label: string, click: () => void) => rows.push({ label, click }), note() {},
    });
    runInContext(code, sandbox);
    const list = await sandbox.f.command({ _: ["t", "branches"] });
    assert.equal(list.data.current, branch);
    assert.equal(list.data.branches.filter((n: string) => n === branch).length, 1, "exact branch missing or duplicated");
    assert.equal(new Set(list.data.branches).size, list.data.branches.length);
    assert.ok(list.text.split("\n").includes(`* ${branch}`));
    await sandbox.f.showBranches(th);
    assert.equal(rows.filter(r => r.label === `${branch} ✓`).length, 1, "desktop current marker lost its identity");
    // Select from a different branch, using the actual list entries and callbacks.
    git(wt, "switch", "-q", "-c", "other", "main"); th.branch = "other";
    await sandbox.f.command({ _: ["t", "switch", list.data.branches.find((n: string) => n === branch)] });
    assert.equal(git(wt, "symbolic-ref", "HEAD").replace(/\r?\n$/, ""), `refs/heads/${branch}`);
    assert.equal(git(wt, "rev-parse", "HEAD").trim(), a);
    git(wt, "switch", "-q", "other"); th.branch = "other"; rows.length = 0;
    await sandbox.f.showBranches(th);
    const done = new Promise<void>(resolve => { finished = resolve; });
    rows.find(r => r.label === branch)!.click(); await done;
    assert.deepEqual(errors, []);
    assert.equal(git(wt, "symbolic-ref", "HEAD").replace(/\r?\n$/, ""), `refs/heads/${branch}`);
    assert.equal(git(wt, "rev-parse", "HEAD").trim(), a);
    assert.equal(git(repo, "rev-parse", branch === "approved" ? "refs/tags/approved" : "refs/heads/approved").trim(), b);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
