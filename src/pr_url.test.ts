// Real ref reads and pushes to a temporary origin; only its displayed URL is GitHub-shaped.
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
const names = ["headBranch", "syncBranch", "prUrl", "createPR", "cliWord", "CliError"];
const pieces = source.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && names.includes(n.name?.text ?? "")).map(n => n.getText(source));
for (const n of source.statements) if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (d.name.getText(source) === "CLI") {
  let init = d.initializer!;
  while (!ts.isObjectLiteralExpression(init)) init = (init as ts.AsExpression).expression;
  const command = init.properties.find(p => p.name?.getText(source) === "git") as ts.PropertyAssignment;
  pieces.push(`const command = (${command.initializer.getText(source)}).run;`);
}
const code = ts.transpileModule(pieces.join("\n") + "\nglobalThis.pr = prUrl; globalThis.f = { prUrl, createPR, command };", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@loom", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const dir = mkdtempSync(join(tmpdir(), "loom-pr-base-")), origin = join(dir, "origin"), local = join(dir, "local");
try {
  mkdirSync(origin); git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "f"), "main"); git(origin, "add", "f"); git(origin, "commit", "-qm", "main");
  git(dir, "clone", "-q", "--no-local", origin, local); git(local, "switch", "-q", "-c", "review-topic");
  const th = { repo: local, dir: local, branch: "review-topic" };
  let pushes = 0;
  const sandbox = createContext({ save() {}, git: async (cwd: string, ...args: string[]) => {
    if (args.join(" ") === "remote get-url origin") return "https://github.com/review-fixture/loom.git\n";
    if (args[0] === "push") pushes++;
    return git(cwd, ...args);
  } });
  runInContext(code, sandbox);
  const expected = (base: string) => `https://github.com/review-fixture/loom/compare/${encodeURIComponent(base)}...review-topic?expand=1`;
  assert.equal(await sandbox.pr(th), expected("main"));
  git(local, "branch", "origin/main", "main");
  assert.equal(git(local, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim(), "remotes/origin/main");
  assert.equal(await sandbox.pr(th), expected("main"), "the namespace leaked into the PR base");
  const encoded = "\u00a0release/#ready\u00a0";
  git(origin, "branch", encoded); git(local, "fetch", "origin");
  git(local, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${encoded}`);
  assert.equal(await sandbox.pr(th), expected(encoded), "the base must retain whitespace and be URL-encoded");
  git(local, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.equal(await sandbox.pr(th), expected("main"), "missing default keeps the main fallback");
  assert.equal(pushes, 4);
  assert.equal(git(origin, "rev-parse", "refs/heads/review-topic").trim(), git(local, "rev-parse", "HEAD").trim());
  console.log("ok   PR base: normal, local origin/main collision, encoded name and missing-default fallback; four real temporary pushes");
} finally { rmSync(dir, { recursive: true, force: true }); }

function fixture(branch = "topic-A") {
  const dir = mkdtempSync(join(tmpdir(), "loom-pr-race-")), origin = join(dir, "origin"), local = join(dir, "local");
  mkdirSync(origin); git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "f"), "main"); git(origin, "add", "f"); git(origin, "commit", "-qm", "main");
  git(dir, "clone", "-q", "--no-local", origin, local); git(local, "switch", "-q", "-c", branch);
  writeFileSync(join(local, "f"), "A"); git(local, "commit", "-qam", "A");
  const a = git(local, "rev-parse", "HEAD").trim();
  git(local, "switch", "-q", "-c", "topic-B"); writeFileSync(join(local, "f"), "B"); git(local, "commit", "-qam", "B");
  git(local, "switch", "-q", branch);
  const th = { repo: local, dir: local, branch, setStat() {} }, opened: string[] = [], errors: string[] = [], pushes: string[][] = [];
  const sandbox = createContext({ ...cli, threads: [th], current: th, changesOpen: false, cliThread: () => th,
    save() {}, gitStatus: async () => ({ branch: th.branch }), refreshChanges: async () => {}, $: () => ({}),
    openUrl: async (url: string) => opened.push(url), note: (_: unknown, error: string) => errors.push(error),
    git: async (cwd: string, ...args: string[]) => {
      if (args.join(" ") === "remote get-url origin") return "https://github.com/review-fixture/loom.git\n";
      if (args[0] === "push") pushes.push(args);
      return git(cwd, ...args);
    },
  });
  runInContext(code, sandbox);
  return { dir, origin, local, branch, a, th, opened, errors, pushes, sandbox };
}

for (const schedule of ["before push", "after push"]) for (const mode of ["cli", "desktop"]) test(`PR keeps A across a switch ${schedule} via ${mode}`, async () => {
  const f = fixture();
  let entered = () => {}, release = () => {};
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  try {
    const run = f.sandbox.git;
    f.sandbox.git = async (cwd: string, ...args: string[]) => {
      const out = await run(cwd, ...args);
      if (schedule === "before push" ? args.join(" ") === "symbolic-ref -q refs/remotes/origin/HEAD" : args[0] === "push") { entered(); await gate; }
      return out;
    };
    const operation = mode === "cli" ? f.sandbox.f.command({ _: ["t", "pr"] }) : f.sandbox.f.createPR();
    await waiting;
    if (schedule === "after push") {
      assert.equal(git(f.origin, "rev-parse", `refs/heads/${f.branch}`).trim(), f.a);
      await f.sandbox.f.command({ _: ["t", "switch", "topic-B"] });
      assert.equal(f.th.branch, "topic-B");
    } else {
      git(f.local, "switch", "-q", "topic-B");
      assert.equal(f.th.branch, f.branch, "external switch leaves the cache stale");
    }
    release(); const result = await operation;
    assert.deepEqual(f.errors, []);
    const url = mode === "cli" ? result.data.url : f.opened[0];
    assert.equal(url, "https://github.com/review-fixture/loom/compare/main...topic-A?expand=1");
    assert.equal(git(f.origin, "rev-parse", "refs/heads/topic-A").trim(), f.a, "the URL's branch must actually be pushed");
    assert.equal(git(f.origin, "for-each-ref", "--format=%(refname)", "refs/heads/topic-B"), "", "B must stay unpushed");
    assert.equal(git(f.local, "symbolic-ref", "HEAD").trim(), "refs/heads/topic-B");
    assert.equal(git(f.local, "config", "branch.topic-A.merge").trim(), "refs/heads/topic-A");
    assert.equal(git(f.local, "config", "branch.topic-A.remote").trim(), "origin");
  } finally { release(); rmSync(f.dir, { recursive: true, force: true }); }
});

for (const branch of ["\u00a0topic/#A\u00a0", "topic-A"]) test(`PR publishes the exact branch ${JSON.stringify(branch)}`, async () => {
  const f = fixture(branch);
  try {
    git(f.local, "tag", branch, "topic-B");
    const url = await f.sandbox.f.prUrl(f.th);
    assert.equal(url, `https://github.com/review-fixture/loom/compare/main...${encodeURIComponent(branch)}?expand=1`);
    assert.equal(git(f.origin, "rev-parse", `refs/heads/${branch}`).trim(), f.a);
    assert.equal(git(f.origin, "for-each-ref", "--format=%(refname)", "refs/tags"), "");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const state of ["detached", "unborn", "removed source", "unavailable repository", "rejected push"]) test(`PR refuses ${state}`, async () => {
  const f = fixture();
  try {
    if (state === "detached") { git(f.local, "switch", "--detach", "-q"); f.th.repo = f.origin; }
    if (state === "unborn") git(f.local, "switch", "--orphan", "unborn");
    if (state === "unavailable repository") f.th.dir = join(f.dir, "missing");
    if (state === "rejected push") writeFileSync(join(f.origin, ".git", "refs", "heads", "topic-A.lock"), "held");
    if (state === "removed source") {
      const run = f.sandbox.git;
      f.sandbox.git = async (cwd: string, ...args: string[]) => {
        const out = await run(cwd, ...args);
        if (args.join(" ") === "symbolic-ref -q refs/remotes/origin/HEAD") {
          git(f.local, "switch", "-q", "topic-B"); git(f.local, "branch", "-D", "topic-A");
        }
        return out;
      };
    }
    await assert.rejects(f.sandbox.f.prUrl(f.th), state === "removed source" || state === "unborn" ? /src refspec .* does not match any/ : state === "rejected push" ? /cannot lock ref/ : /symbolic ref|cannot change to/);
    assert.equal(git(f.origin, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main\n");
    if (["detached", "unavailable repository"].includes(state)) assert.equal(f.pushes.length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
