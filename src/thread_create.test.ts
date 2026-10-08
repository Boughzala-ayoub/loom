// Execute createThread with real Git: the base a new thread is cut from.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync } from "node:fs";
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
  const sandbox = createContext({ crypto, MAX_PANES: 8, shuttingDown: false, threads: [], git: async (cwd: string, ...args: string[]) => git(cwd, ...args),
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

  // Another creator makes the new branch between the base check and git worktree add.
  let adds = 0;
  const racing = (branch: string) => creator(join(dir, `race-${branch.replace(/\W/g, "-")}`), (cwd, ...args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      if (++adds > 4) throw new Error("test stop: worktree add retried without end");
      if (adds === 1) real(cwd, "branch", branch);
    }
    return real(cwd, ...args);
  });
  await assert.rejects(racing("fresh")(local, "", "", "fresh", 1), (e: Error) => {
    assert.match(e.message, /fresh/);
    assert.doesNotMatch(e.message, /test stop/, "an explicit new branch that appeared meanwhile retried without end");
    return true;
  });
  assert.equal(adds, 1, "one try: the branch the caller named is taken");
  // loom/<slug> taken meanwhile still moves on to the next number.
  adds = 0;
  const auto = await racing("loom/auto")(local, "auto", "", "", 1);
  assert.deepEqual([auto.branch, adds], ["loom/auto-2", 2]);
  console.log("ok   a new branch made by someone else meanwhile stops the thread, and loom/<slug> takes the next number");

  // origin/feature is v1 in a clone whose fetch refspec covers main only, and
  // origin's feature moves on to v2: the fetch gets v2 but leaves origin/feature at v1.
  const narrow = join(dir, "narrow");
  real(dir, "clone", "-q", "-b", "main", origin, narrow);
  real(narrow, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  writeFileSync(join(origin, "a.txt"), "feature v2\n");
  real(origin, "commit", "-qam", "feature v2");
  const v2 = real(origin, "rev-parse", "feature").trim();
  const stale = await create(narrow, "stale-case", "", "feature", 1);
  assert.equal(real(narrow, "rev-parse", "origin/feature").trim(), feature, "the fixture's origin/feature is v1");
  assert.equal(real(stale.dir, "rev-parse", "HEAD").trim(), v2, "the thread started from a stale origin/feature");
  // No origin/feature at all, and another fetch in the repository rewrites FETCH_HEAD right after this one.
  const single = join(dir, "single");
  real(dir, "clone", "-q", "--single-branch", "--branch", "main", origin, single);
  const raced = await creator(join(dir, "single-threads"), (cwd, ...args) => {
    const out = real(cwd, ...args);
    if (args[0] === "fetch") real(cwd, "fetch", "-q", "origin", "main");
    return out;
  })(single, "raced-case", "", "feature", 1);
  assert.equal(real(raced.dir, "rev-parse", "HEAD").trim(), v2, "the thread started from another fetch's FETCH_HEAD");
  assert.equal(real(single, "for-each-ref", "refs/loom-fetch/") + real(narrow, "for-each-ref", "refs/loom-fetch/"), "", "a fetch's own ref stayed behind");
  console.log("ok   a base fetched from origin is the commit this fetch got, not a stale origin/<base> or another fetch's FETCH_HEAD");

  // origin can't be reached: that is git's error, not a base origin lacks, so no new branch from local HEAD.
  const away = join(dir, "away"), offline = join(dir, "offline");
  real(dir, "clone", "-q", "--bare", origin, away);
  real(dir, "clone", "-q", "--single-branch", "--branch", "main", away, offline);
  renameSync(away, `${away}-gone`);
  await assert.rejects(create(offline, "offline-case", "", "feature", 1), /Could not read from remote repository/, "an unreachable origin made a thread from local HEAD");
  assert.equal(real(offline, "for-each-ref", "--format=%(refname)", "refs/heads/").trim(), "refs/heads/main", "a branch was made");
  // No origin at all: a base found nowhere is a new branch, as before.
  const lone = join(dir, "lone");
  mkdirSync(lone);
  real(lone, "init", "-q", "-b", "main");
  real(lone, "commit", "-q", "--allow-empty", "-m", "start");
  const solo = await create(lone, "", "", "solo", 1);
  assert.deepEqual([solo.branch, real(solo.dir, "rev-parse", "HEAD").trim()], ["solo", real(lone, "rev-parse", "HEAD").trim()]);
  console.log("ok   an origin that can't be reached stops the thread with git's error; with no origin a missing base is still a new branch");
} finally { rmSync(dir, { recursive: true, force: true }); }
