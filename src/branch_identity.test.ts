// Real Git identities through creation, restore and the production close handlers.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { test } from "node:test";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
// @ts-ignore Node-only test.
import { tmpdir } from "node:os";
// @ts-ignore Node-only test.
import { join, basename } from "node:path";
// @ts-ignore Node-only test.
import { execFileSync } from "node:child_process";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import * as cli from "./cli.ts";
import * as gitparse from "./gitparse.ts";

/** deletion.rs delete_branch (the branch_delete command) with real Git: refused while a worktree has the
 * branch, and only the approved tip goes. Its real-Git race tests are in deletion.rs. */
function branchDelete(repo: string, { branch, tip }: { branch: string; tip: string }) {
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (git("worktree", "list", "--porcelain").split("\n").includes(`branch refs/heads/${branch}`)) throw `Cannot delete branch '${branch}': checked out at another worktree.`;
  git("update-ref", "--no-deref", "-d", `refs/heads/${branch}`, tip);
}

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const names = ["headBranch", "syncBranch", "openThread", "createThread", "inventory", "hashedFiles", "inventoryDiff", "lossCounts", "riskText", "removeThread", "closingThreads", "closePlan", "cliDelete", "cliWord", "CliError"];
const pieces: string[] = [];
for (const n of source.statements) {
  if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? "")) pieces.push(n.getText(source));
  if (ts.isClassDeclaration(n) && names.includes(n.name?.text ?? "")) pieces.push(n.getText(source));
  if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) {
    if (names.includes(d.name.getText(source))) pieces.push(`const ${d.getText(source)};`);
    if (d.name.getText(source) === "CLI") {
      let init = d.initializer!;
      while (!ts.isObjectLiteralExpression(init)) init = (init as ts.AsExpression).expression;
      const close = init.properties.find(p => p.name?.getText(source) === '"close-thread"') as ts.PropertyAssignment;
      pieces.push(`const close = (${close.initializer.getText(source)}).run;`);
    }
  }
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.f = { headBranch, syncBranch, openThread, createThread, closePlan, close };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

for (const branch of ["\u00a0approved", "approved\u00a0", "approved"]) for (const mode of ["plan", "force"]) {
  test(`branch identity ${JSON.stringify(branch)} ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-branch-identity-"));
    const repo = join(dir, "repo"), wt = join(dir, "wt");
    try {
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "f"), "main"); git(repo, "add", "f"); git(repo, "commit", "-qm", "main");
      git(repo, "worktree", "add", "-q", "-b", branch, wt);
      writeFileSync(join(wt, "f"), "A"); git(wt, "commit", "-qam", "A");
      const a = git(wt, "rev-parse", "HEAD").trim();
      const b = git(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "B").trim();
      if (branch === "approved") git(repo, "tag", "approved", b);
      else git(repo, "branch", "approved", b);
      const th = { id: "t", name: "t", repo, dir: wt, branch: "stale", isWorktree: true, panes: [], dispose: async () => {} };
      const sandbox = createContext({ ...cli, ...gitparse, console, crypto, TextEncoder, setTimeout, basename,
        MAX_PANES: 8, shuttingDown: false, threads: [th], cliThread: () => th, save() {}, toast() {}, renderSide() {}, show() {},
        git: async (cwd: string, ...args: string[]) => git(cwd, ...args),
        invoke: async (cmd: string, args: any) => cmd === "worktree_fingerprint" ? "unchanged files" : cmd === "worktree_remove" ? (git(repo, "worktree", "remove", "--force", args.dir), "fixture trash") : cmd === "branch_delete" ? branchDelete(repo, args) : undefined,
      });
      runInContext(code, sandbox);
      const f = sandbox.f;
      // Creation on an existing checkout must seed the exact cached identity.
      const opened: any[] = [];
      sandbox.threads = [];
      sandbox.openThread = (st: any) => (opened.push(st), st);
      await f.createThread(wt, "", [{ cmd: "" }], "");
      assert.equal(opened[0].branch, branch, "creation cached a different branch");
      // Restore's asynchronous checkout refresh must use the same identity.
      const refreshed: Promise<void> = new Promise(resolve => {
        sandbox.Thread = class {
          panes = [{}]; grid = { classList: { add() {} } };
          constructor(repo: string, dir: string, branch: string, name: string) { Object.assign(this, { repo, dir, branch, name }); }
          setStat() { resolve(); } relayout() {} async addPane() {}
        };
      });
      Object.assign(sandbox, { repos: [], $: () => ({ append() {} }), pollStats() {} });
      const restored = await f.openThread({ repo: wt, dir: wt, branch: "stale", name: "restore" }, [], "cols", true);
      await refreshed;
      assert.equal(restored.branch, branch, "restore cached a different branch");
      sandbox.threads = [th];
      assert.equal(await f.syncBranch(th), branch);
      git(wt, "switch", "-q", "--detach");
      assert.equal(await f.headBranch(th), branch, "detached worktree lost its cached identity");
      assert.equal(await f.headBranch({ ...th, repo: wt }), "HEAD", "detached checkout must say HEAD");
      sandbox.cliThread = () => ({ ...th, repo: wt, isWorktree: false });
      await assert.rejects(f.close({ _: ["t"], yes: true, delete: "branch", force: true }), /isn't a worktree Loom made/);
      sandbox.cliThread = () => th;
      git(wt, "switch", "-q", branch);
      const plan = mode === "plan" ? await f.closePlan(th, "branch") : null;
      if (plan) { assert.equal(plan.data.branch, branch); assert.equal(plan.data.branchTip, a); }
      const result = await f.close({ _: ["t"], yes: true, delete: "branch", ...(plan ? { plan: plan.data.rev, discard: "commits" } : { force: true }) });
      assert.equal(result.data.steps.branch, "deleted");
      assert.throws(() => git(repo, "show-ref", "--verify", "refs/heads/" + branch));
      assert.equal(git(repo, "rev-parse", branch === "approved" ? "refs/tags/approved" : "refs/heads/approved").trim(), b, "a different ref was deleted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
