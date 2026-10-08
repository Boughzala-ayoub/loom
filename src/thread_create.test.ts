// Execute createThread with real Git: the base a new thread is cut from.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
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
// Whichever of these main.ts has: the base check was refExists, then resolveBase.
const fns = source.statements.filter(n => ts.isFunctionDeclaration(n) && ["createThread", "refExists", "resolveBase"].includes(n.name?.text ?? ""));
const code = ts.transpileModule(fns.map(n => n.getText(source)).join("\n") + "\nglobalThis.create = createThread;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const real = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8" });
/** createThread in a sandbox, folders under `dir`, git real unless `git` wraps it. */
function creator(dir: string, git = (cwd: string, ...args: string[]) => real(cwd, ...args)) {
  const sandbox = createContext({ MAX_PANES: 8, shuttingDown: false, threads: [], git: async (cwd: string, ...args: string[]) => git(cwd, ...args),
    worktreeDir: async (_: string, slug: string) => join(dir, slug), openThread: (t: unknown) => t,
    invoke: async (cmd: string, args: { path: string }) => (cmd === "canonical_directory" ? realpathSync.native(args.path) : undefined) });
  runInContext(code, sandbox);
  return sandbox.create as (repo: string, name: string, cmd: string, base: string, n: number) => Promise<{ dir: string; branch: string }>;
}

const dir = mkdtempSync(join(tmpdir(), "loom-thread-base-"));
try {
  // origin/feature has a commit local main lacks, and there is no local feature.
  const origin = join(dir, "origin"), local = join(dir, "local");
  mkdirSync(origin);
  real(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "main\n");
  real(origin, "add", "-A");
  real(origin, "commit", "-qm", "main");
  real(dir, "clone", "-q", origin, local);
  real(origin, "switch", "-q", "-c", "feature");
  writeFileSync(join(origin, "a.txt"), "feature\n");
  real(origin, "commit", "-qam", "feature only");
  const feature = real(origin, "rev-parse", "feature").trim(), main = real(local, "rev-parse", "HEAD").trim();
  const create = creator(join(dir, "threads"));

  const remote = await create(local, "remote-case", "", "feature", 1);
  assert.deepEqual([remote.branch, real(remote.dir, "rev-parse", "HEAD").trim()], ["loom/remote-case", feature], "a base only on origin became a new branch from local HEAD");
  console.log("ok   a base that exists only on origin is fetched and cut from");

  // A base found nowhere is still a new branch of that name, off HEAD; origin/x that isn't there is a typo.
  const fresh = await create(local, "", "", "brand-new", 1);
  assert.deepEqual([fresh.branch, real(fresh.dir, "rev-parse", "HEAD").trim()], ["brand-new", main]);
  await assert.rejects(create(local, "typo", "", "origin/nope", 1), /not a branch on that remote/);
  console.log("ok   a base found nowhere is a new branch off HEAD, and a missing origin/x is refused");
} finally { rmSync(dir, { recursive: true, force: true }); }
