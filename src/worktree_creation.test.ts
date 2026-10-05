// Execute createThread with real Git in a scratch repository.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
// @ts-ignore Node-only test.
import { tmpdir } from "node:os";
// @ts-ignore Node-only test.
import { join } from "node:path";
// @ts-ignore Node-only test.
import { execFileSync } from "node:child_process";
// @ts-ignore Node-only test.
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "createThread")!;
const code = ts.transpileModule(fn.getText(source) + "\nglobalThis.create = createThread;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const dir = mkdtempSync(join(tmpdir(), "loom-create-unavailable-"));
const repo = join(dir, "repo"), parent = join(dir, "external"), wt = join(parent, "existing");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
try {
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "start");
  git(repo, "worktree", "add", "-q", "-b", "existing", wt);
  writeFileSync(join(wt, "a.txt"), "staged");
  git(wt, "add", "a.txt");
  writeFileSync(join(wt, "a.txt"), "working");
  const entry = join(repo, ".git", "worktrees", "existing");
  const index = readFileSync(join(entry, "index"));
  renameSync(parent, join(dir, "offline"));
  const prepared: string[] = [];
  const sandbox = createContext({ MAX_PANES: 8, threads: [], git: async (cwd: string, ...args: string[]) => git(cwd, ...args), worktreeDir: async (_: string, slug: string) => join(dir, slug),
    openThread: (t: unknown) => t, invoke: async (cmd: string, args: { dir: string }) => {
      assert.equal(cmd, "worktree_prepare"); prepared.push(args.dir);
    } });
  runInContext(code, sandbox);
  const created = await sandbox.create(repo, "new thread", "", "", 1);
  assert.deepEqual(readFileSync(join(entry, "index")), index, "creating a thread discarded an unavailable worktree's index");
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0], created.dir);
  renameSync(join(dir, "offline"), parent);
  assert.equal(git(wt, "show", ":a.txt"), "staged");
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "working");
  console.log("ok   creating a thread preserves an unlocked worktree under an unavailable parent");
} finally { rmSync(dir, { recursive: true, force: true }); }
