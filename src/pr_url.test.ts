// Real ref reads and pushes to a temporary origin; only its displayed URL is GitHub-shaped.
// @ts-ignore Node-only test.
import assert from "node:assert/strict";
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

const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(source.statements.filter(n => ts.isFunctionDeclaration(n) && ["headBranch", "syncBranch", "prUrl"].includes(n.name?.text ?? "")).map(n => n.getText(source)).join("\n") + "\nglobalThis.pr = prUrl;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
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
