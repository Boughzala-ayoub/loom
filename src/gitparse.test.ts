// Self-check for gitparse. Run: node src/gitparse.test.ts
import { parseStatus, parseNumstat, sumStat, diffClass, lossInventory } from "./gitparse.ts";

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
  fails++;
}

const NUL = "\0";
check(
  "status: staged, unstaged, both, untracked, rename",
  parseStatus(["M  a.ts", " M b.ts", "MM c.ts", "?? new.ts", "R  moved.ts", "old.ts", "D  gone.ts", ""].join(NUL)),
  [
    { path: "a.ts", x: "M", y: " " },
    { path: "b.ts", x: " ", y: "M" },
    { path: "c.ts", x: "M", y: "M" },
    { path: "new.ts", x: "?", y: "?" },
    { path: "moved.ts", x: "R", y: " " },
    { path: "gone.ts", x: "D", y: " " },
  ],
);
check("status: empty", parseStatus(""), []);

const ns = parseNumstat("12\t3\tsrc/main.ts\n-\t-\ticon.png\n0\t5\tdir with space/x.rs\n");
check("numstat parses lines and binaries", [...ns.entries()], [
  ["src/main.ts", { add: 12, del: 3 }],
  ["icon.png", { add: 0, del: 0 }],
  ["dir with space/x.rs", { add: 0, del: 5 }],
]);
check("sum", sumStat(ns.values()), { add: 12, del: 8 });

check("diff classes", ["@@ -1,2 +1,3 @@", "+++ b/x", "--- a/x", "+added", "-removed", "diff --git a/x b/x", " context", "index 1..2"].map(line => diffClass(line)), [
  "hunk", "meta", "meta", "add", "del", "meta", "", "meta",
]);

import { diffRows, fileRows, tree } from "./gitparse.ts";
for (const text of ["", "one", "one\n", "\n\n", "one\r\ntwo\n", "x\n".repeat(1000)]) {
  const expected = text.replace(/\n$/, "").split("\n");
  const { rows, count } = fileRows(text, 2);
  check("file preview count and cap: " + text.length, [count, rows.map(r => r.text), rows.map(r => r.neu)],
    [expected.length, expected.slice(0, 2), expected.slice(0, 2).map((_, i) => i + 1)]);
}
const rows = diffRows(["diff --git a/x b/x", "@@ -3,2 +3,3 @@", " ctx", "-gone", "+new1", "+new2", ""].join(String.fromCharCode(10)));
check("diff rows number both sides", rows.map((r) => [r.kind, r.old, r.neu]), [
  ["meta", 0, 0], ["hunk", 0, 0], ["", 3, 3], ["del", 4, 0], ["add", 0, 4], ["add", 0, 5],
]);
const t = tree(["README.md", "src/a.ts", "src/b.ts", "src/deep/c.ts"]);
check("tree nests folders with counts", [t.count, t.files.map((f) => f.name), t.dirs.map((d) => [d.name, d.count, d.dirs.map((x) => [x.name, x.count])])], [
  4, ["README.md"], [["src", 3, [["deep", 1]]]],
]);

import { gitAct } from "./gitparse.ts";
const F = (path: string, x = " ", y = "M") => ({ path, x, y });
check("stage is add", gitAct("unstaged", "stage", [F("a.ts")]), [["add", "--", "a.ts"]]);
check("unstage leaves the worktree alone", gitAct("staged", "unstage", [F("a.ts", "M", " ")]), [["restore", "--staged", "--", "a.ts"]]);
check("discard unstaged restores from the index", gitAct("unstaged", "discard", [F("a.ts")]), [["restore", "--", "a.ts"]]);
check(
  "discard staged: new files are deleted, edits restored",
  gitAct("staged", "discard", [F("new.ts", "A", " "), F("old.ts", "M", " ")]),
  [["rm", "-f", "--", "new.ts"], ["restore", "--staged", "--worktree", "--", "old.ts"]],
);
check("discard untracked deletes the file", gitAct("untracked", "discard", [F("x.ts", "?", "?")]), [["clean", "-f", "-d", "--", "x.ts"]]);
check("nothing selected runs nothing", gitAct("unstaged", "stage", []), []);
check(
  "a huge selection is chunked",
  gitAct("unstaged", "stage", Array.from({ length: 250 }, (_, i) => F(`f${i}.ts`))).map((a) => a.length),
  [202, 52],
);

import { hunkPatch } from "./gitparse.ts";
const two = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.ts b/b.ts",
  "index 333..444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1,2 @@",
  " one",
  "+two",
  "@@ -9 +10,2 @@",
  " nine",
  "+ten",
].join(String.fromCharCode(10));
const tr = diffRows(two);
check("each file restarts header parsing", tr.slice(8, 15).map(r => r.kind), ["meta", "meta", "meta", "meta", "hunk", "", "add"]);
check(
  "one hunk carries its own file header",
  hunkPatch(tr, 6).split(String.fromCharCode(10)),
  ["diff --git a/a.ts b/a.ts", "index 111..222 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""],
);
check(
  "the second file's second hunk takes that file's header, not the first's",
  hunkPatch(tr, 17).split(String.fromCharCode(10)),
  ["diff --git a/b.ts b/b.ts", "index 333..444 100644", "--- a/b.ts", "+++ b/b.ts", "@@ -9 +10,2 @@", " nine", "+ten", ""],
);
check("above the first hunk there is nothing to apply", hunkPatch(tr, 1), "");
check("a later file header must not select the previous file's hunk", hunkPatch(tr, 10), "");
check("a missing row has no hunk", [hunkPatch(tr, -1), hunkPatch(tr, tr.length)], ["", ""]);

const markers = diffRows("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n---removed\n+++added\n same\n");
check("header-like content inside a hunk keeps its class and line numbers", markers.map(r => [r.kind, r.old, r.neu]), [
  ["meta", 0, 0], ["meta", 0, 0], ["hunk", 0, 0], ["del", 1, 0], ["add", 0, 1], ["", 2, 2],
]);

const wide = tree(Array.from({ length: 2000 }, (_, i) => `dir${i}/src/file.ts`).concat(["dir0/src/second.ts"]));
check("wide trees reuse folders and retain input order and file indexes",
  [wide.count, wide.dirs.length, wide.dirs[0].count, wide.dirs[0].dirs[0].files, wide.dirs[1999].name],
  [2001, 2000, 2, [{ name: "file.ts", i: 0 }, { name: "second.ts", i: 2000 }], "dir1999"]);

import { parseBranch, upstreamLabel } from "./gitparse.ts";
// What `rev-parse --abbrev-ref @{upstream}` and `rev-list --left-right --count @{upstream}...HEAD`
// printed for each `## ` line; "" where they failed.
const branches: [string, { upstream: string; span: string; ask: boolean }][] = [
  ["## main", { upstream: "", span: "", ask: false }],
  ["## main...origin/main", { upstream: "origin/main", span: "0\t0", ask: false }],
  ["## main...origin/main [ahead 2]", { upstream: "origin/main", span: "0\t2", ask: false }],
  ["## main...origin/main [behind 3]", { upstream: "origin/main", span: "3\t0", ask: false }],
  ["## main...origin/main [ahead 1, behind 12]", { upstream: "origin/main", span: "12\t1", ask: false }],
  ["## loom/x...origin/loom/x [gone]", { upstream: "", span: "", ask: false }],
  ["## feature...main [ahead 1]", { upstream: "main", span: "0\t1", ask: false }],
  ["## HEAD (no branch)", { upstream: "", span: "", ask: false }],
  ["## No commits yet on main", { upstream: "", span: "", ask: false }],
  // With no commits, status calls any upstream gone; rev-parse has to say.
  ["## No commits yet on main...origin/main [gone]", { upstream: "", span: "", ask: true }],
  ["", { upstream: "", span: "", ask: false }],
];
for (const [line, want] of branches) check(`branch: ${line || "(no line)"}`, parseBranch(line + NUL + " M a.ts" + NUL), want);
check("status skips the branch line", parseStatus("## main...origin/main [ahead 1]" + NUL + " M a.ts" + NUL + "## odd.ts" + NUL),
  [{ path: "a.ts", x: " ", y: "M" }, { path: "odd.ts", x: "#", y: "#" }]);
// git 2.39's own `status --porcelain=v1 -z -uall --ignored=matching` in a repo
// ignoring node_modules/, .env, *.log and build, plus tracked changes and a rename.
const loss = lossInventory([" M a.ts", "R  new.ts", "old.ts", "D  gone.ts", "?? src/app.ts", "!! .env", "!! build/", "!! logs/a.log", "!! logs/b.log", "!! node_modules/", "!! src/debug.log", ""].join("\0"));
check("worktree loss: tracked changes, a rename once by its new name", loss.tracked, ["a.ts", "new.ts", "gone.ts"]);
check("worktree loss: untracked files one by one", loss.untracked, ["src/app.ts"]);
check("worktree loss: ignored files, a wholly ignored folder as one entry", loss.ignored, [".env", "build/", "logs/a.log", "logs/b.log", "node_modules/", "src/debug.log"]);
check("worktree loss: a clean tree with only an ignored file still lists it", lossInventory("!! notes/private.md\0"), { tracked: [], untracked: [], ignored: ["notes/private.md"] });
check("worktree loss: nothing", lossInventory(""), { tracked: [], untracked: [], ignored: [] });
check("upstream labels", [["origin/main", "2\t1"], ["origin/main", "0\t0"], ["main", "0\t3"], ["", ""]].map(([u, s]) => upstreamLabel(u, s)),
  ["→ origin/main  ↓2 ↑1", "→ origin/main", "→ main   ↑3", "→ not pushed yet"]);

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
