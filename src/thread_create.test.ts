// Execute createThread with real Git: the base a new thread is cut from.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync, utimesSync, existsSync } from "node:fs";
// @ts-ignore Node-only test.
import { tmpdir } from "node:os";
// @ts-ignore Node-only test.
import { basename, join } from "node:path";
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
  const sandbox = createContext({ crypto, setTimeout, MAX_PANES: 8, shuttingDown: false, threads: [], git: async (cwd: string, ...args: string[]) => git(cwd, ...args),
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

  // feature was fetched once and is referenced by nothing now, its objects 40 days old. This fetch
  // finds them already here and leaves them old. Just before git worktree add, another fetch rewrites
  // FETCH_HEAD and git gc runs with its default prune: only a ref still holding the commit keeps it.
  const aged = join(dir, "aged");
  real(dir, "clone", "-q", "--single-branch", "--branch", "main", origin, aged);
  real(aged, "fetch", "-q", "origin", "feature");
  real(aged, "fetch", "-q", "origin", "main");
  const old = new Date(Date.now() - 40 * 86_400_000);
  for (const object of real(aged, "rev-list", "--objects", v2, "--not", "main").split("\n").filter(Boolean)) {
    const sha = object.split(" ")[0];
    utimesSync(join(aged, ".git", "objects", sha.slice(0, 2), sha.slice(2)), old, old);
  }
  let collected = 0;
  const kept = await creator(join(dir, "aged-threads"), (cwd, ...args) => {
    if (args[0] === "worktree" && args[1] === "add") real(cwd, "fetch", "-q", "origin", "main"), real(cwd, "gc", "--quiet"), collected++;
    return real(cwd, ...args);
  })(aged, "aged-case", "", "feature", 1);
  assert.deepEqual([collected, real(kept.dir, "rev-parse", "HEAD").trim()], [1, v2], "git gc pruned the base before git worktree add used it");
  assert.equal(real(aged, "for-each-ref", "refs/loom-fetch/"), "", "the fetch's own ref stayed behind");
  console.log("ok   a fetched base keeps its ref until git worktree add has used it, so git gc meanwhile can't prune it");

  // Another git holds the lock on the fetch's own ref while createThread deletes it. Loom never touches that lock.
  let fetchRef = "", deletes = 0;
  const lockOf = (repo: string) => join(repo, ".git", ...fetchRef.split("/")) + ".lock";
  const clone = (name: string) => (real(dir, "clone", "-q", "--single-branch", "--branch", "main", origin, join(dir, name)), join(dir, name));
  /** createThread in `repo`, git real, `hook` run before each git command. */
  const locking = (repo: string, hook: (args: string[]) => void) => creator(join(dir, `${basename(repo)}-threads`), (cwd, ...args) => {
    if (args[0] === "fetch") fetchRef = args[args.length - 1].split(":")[1];
    if (args[0] === "update-ref") deletes++;
    hook(args);
    return real(cwd, ...args);
  });
  // A short hold is waited out.
  const brief = clone("brief");
  await locking(brief, (args) => {
    if (args[0] === "update-ref" && deletes === 1) writeFileSync(lockOf(brief), ""), setTimeout(() => rmSync(lockOf(brief)), 600);
  })(brief, "brief-case", "", "feature", 1);
  assert.ok(deletes > 1, "one try at deleting the ref");
  assert.equal(real(brief, "for-each-ref", "refs/loom-fetch/"), "", "the ref stayed behind after another git's short hold");
  // A hold that lasts: the thread is made, and the error says so and names the ref left behind.
  const held = clone("held");
  await assert.rejects(locking(held, (args) => {
    if (args[0] === "update-ref" && !existsSync(lockOf(held))) writeFileSync(lockOf(held), "");
  })(held, "held-case", "", "feature", 1), (e: Error) => {
    assert.match(e.message, /^Made held-case in .+, but Loom couldn't delete its temporary ref refs\/loom-fetch\/[0-9a-f-]+: .*cannot lock ref/s);
    assert.ok(e.message.includes(fetchRef), "the error doesn't name the ref left");
    return true;
  }, "a ref that couldn't be deleted went unsaid");
  assert.ok(existsSync(lockOf(held)), "another git's lock was removed");
  rmSync(lockOf(held));
  assert.deepEqual([real(held, "for-each-ref", "--format=%(refname)", "refs/loom-fetch/").trim(), real(held, "rev-parse", "loom/held-case").trim()], [fetchRef, v2]);
  // A creation that fails with the ref held too: its own error first, then the ref.
  const broken = clone("broken");
  await assert.rejects(locking(broken, (args) => {
    if (args[0] !== "worktree" || args[1] !== "add") return;
    writeFileSync(lockOf(broken), "");
    throw "fatal: test: no space left on device"; // as Loom's git rejects: git's own words
  })(broken, "broken-case", "", "feature", 1), /^Error: fatal: test: no space left on device\nLoom also couldn't delete its temporary ref refs\/loom-fetch\//);
  rmSync(lockOf(broken));
  console.log("ok   the fetch's own ref is deleted through another git's short hold on it, and a ref left behind is reported");
} finally { rmSync(dir, { recursive: true, force: true }); }
