/** Pure parsing for the Changes panel: `git status --porcelain -z`,
 * `git diff --numstat`, and the class a unified-diff line renders with. */

export type Change = {
  path: string;
  /** Index (staged) status letter, " " when nothing is staged. */
  x: string;
  /** Working-tree status letter, " " when the tree matches the index. */
  y: string;
};

/** `git status --porcelain=v1 -z`: `XY path` entries NUL-separated; a rename
 * or copy is followed by one more NUL-terminated entry, the original path,
 * which is dropped — the panel shows where the file is now. With `--branch`
 * the first entry is the `## ` branch line, which parseBranch reads. */
export function parseStatus(z: string): Change[] {
  const out: Change[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4 || (i === 0 && e.startsWith("## "))) continue;
    const x = e[0];
    const y = e[1];
    out.push({ path: e.slice(3), x, y });
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
  }
  return out;
}

/** The `## ` line `git status --porcelain=v1 -z --branch` starts with, as the
 * two answers it replaces: `upstream` is what `rev-parse --abbrev-ref
 * @{upstream}` printed and `span` what `rev-list --left-right --count
 * @{upstream}...HEAD` printed ("behind\tahead"). Both are "" when that command
 * failed: no upstream, a gone one, a detached HEAD, or no commits yet.
 * `ask`: a branch with no commits names an upstream, which status calls gone
 * whether it exists or not. Only rev-parse can tell, so the caller runs it. */
export function parseBranch(z: string): { upstream: string; span: string; ask: boolean } {
  const none = { upstream: "", span: "", ask: false };
  let line = z.split("\0")[0];
  if (!line.startsWith("## ")) return none;
  let track = "";
  const open = line.lastIndexOf(" [");
  if (open >= 0 && line.endsWith("]")) (track = line.slice(open + 2, -1)), (line = line.slice(0, open));
  const dots = line.indexOf("...");
  if (dots < 0) return none;
  if (/^## (No commits yet|Initial commit) on /.test(line)) return { ...none, ask: true };
  if (track === "gone") return none;
  const count = (word: string) => +(new RegExp(`\\b${word} (\\d+)`).exec(track)?.[1] ?? 0);
  return { upstream: line.slice(dots + 3), span: `${count("behind")}\t${count("ahead")}`, ask: false };
}

/** What the Changes panel says about the upstream: "→ origin/main  ↓2 ↑1". */
export function upstreamLabel(upstream: string, span: string): string {
  const [behind, ahead] = span.split("\t");
  const gap = +behind || +ahead ? `  ${+behind ? `↓${behind}` : ""}${+ahead ? ` ↑${ahead}` : ""}`.trimEnd() : "";
  return upstream ? `→ ${upstream}${gap}` : "→ not pushed yet";
}

export type Stat = { add: number; del: number };

/** `git diff --numstat`: `added<TAB>deleted<TAB>path`; binaries report `-`. */
export function parseNumstat(out: string): Map<string, Stat> {
  const m = new Map<string, Stat>();
  for (const line of out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    m.set(rest.join("\t"), { add: +a || 0, del: +d || 0 });
  }
  return m;
}

export function sumStat(stats: Iterable<Stat>): Stat {
  let add = 0;
  let del = 0;
  for (const s of stats) (add += s.add), (del += s.del);
  return { add, del };
}

/** How one line of `git diff` output is coloured. Headers before the first
 * hunk are "meta"; the `---`/`+++` file lines are meta too, not a change. */
export function diffClass(line: string, inHunk = false): "add" | "del" | "hunk" | "meta" | "" {
  if (line.startsWith("@@")) return "hunk";
  if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (/^(diff |index |new file|deleted file|similarity|rename |copy |Binary)/.test(line)) return "meta";
  return "";
}

/** A unified diff as rows with the line numbers each side had. `old`/`neu`
 * are 0 for a line that exists on one side only, and for headers. */
export type DiffRow = { kind: ReturnType<typeof diffClass>; old: number; neu: number; text: string };

export function diffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) inHunk = false;
    const kind = diffClass(line, inHunk);
    if (kind === "hunk") {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      o = m ? +m[1] : 0;
      n = m ? +m[2] : 0;
      rows.push({ kind, old: 0, neu: 0, text: line });
      continue;
    }
    if (kind === "meta") {
      rows.push({ kind, old: 0, neu: 0, text: line });
      continue;
    }
    if (kind === "add") rows.push({ kind, old: 0, neu: n++, text: line });
    else if (kind === "del") rows.push({ kind, old: o++, neu: 0, text: line });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: 0, neu: 0, text: line }); // "\ No newline at end of file"
    else rows.push({ kind, old: o++, neu: n++, text: line });
  }
  // The trailing empty string a final newline leaves behind is not a line.
  if (rows.length && rows[rows.length - 1].text === "" && rows[rows.length - 1].kind === "") rows.pop();
  return rows;
}

/** Paths as a folder tree, the way Orca's changes list nests them: each node
 * is a folder with its files and subfolders, files carrying their index into
 * the input so the caller can look the change back up. */
export type Node = { name: string; path: string; dirs: Node[]; files: { name: string; i: number }[]; count: number };

export function tree(paths: string[]): Node {
  const root: Node = { name: "", path: "", dirs: [], files: [], count: 0 };
  const dirs = new Map<string, Node>();
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let d = dirs.get(path);
      if (!d) {
        d = { name: part, path, dirs: [], files: [], count: 0 };
        dirs.set(path, d);
        node.dirs.push(d);
      }
      node = d;
      node.count++;
    }
    node.files.push({ name: parts[parts.length - 1], i });
  });
  return root;
}

/** Which list of the Changes panel a row came from. The same verb is a
 * different git command in each — that is the whole reason this table exists. */
export type Sec = "unstaged" | "staged" | "untracked";
export type Act = "stage" | "unstage" | "discard";

/** The git invocations one button press becomes, e.g. `[["add","--","a.ts"]]`.
 * Chunked at 200 paths so selecting a whole monorepo can't overrun the
 * command line. Discard is the dangerous one: restoring the worktree from the
 * index, throwing away a staged edit, and deleting a file git never had are
 * three different commands, and running the wrong one loses work. */
export function gitAct(sec: Sec, act: Act, files: Change[]): string[][] {
  const cmd = (pre: string[], f: Change[]) => {
    const out: string[][] = [];
    for (let i = 0; i < f.length; i += 200) out.push([...pre, "--", ...f.slice(i, i + 200).map((c) => c.path)]);
    return out;
  };
  if (!files.length) return [];
  if (act === "stage") return cmd(["add"], files);
  if (act === "unstage") return cmd(["restore", "--staged"], files);
  if (sec === "untracked") return cmd(["clean", "-f", "-d"], files);
  if (sec === "unstaged") return cmd(["restore"], files);
  // Staged: HEAD has no copy of a file added this commit, so `restore` can't
  // undo it — dropping it means removing it from the index and the disk.
  return [
    ...cmd(["rm", "-f"], files.filter((c) => c.x === "A")),
    ...cmd(["restore", "--staged", "--worktree"], files.filter((c) => c.x !== "A")),
  ];
}

/** The patch `git apply` needs to move a single hunk: this file's own header
 * lines, then the hunk `at` sits in. Everything before the first `@@` is the
 * header git wrote for the file, and a multi-file diff restarts it at each
 * `diff --git`. Empty when `at` is above the first hunk. */
export function hunkPatch(rows: DiffRow[], at: number): string {
  if (!rows[at]) return "";
  let start = at;
  while (start >= 0 && rows[start].kind !== "hunk") {
    if (rows[start].text.startsWith("diff --git")) return "";
    start--;
  }
  if (start < 0) return "";
  let end = start + 1;
  while (end < rows.length && rows[end].kind !== "hunk" && !rows[end].text.startsWith("diff --git")) end++;
  let head: string[] = [];
  let inHead = true; // a diff that never says "diff --git" still has its --- / +++
  for (let i = 0; i < start; i++) {
    if (rows[i].text.startsWith("diff --git")) (head = []), (inHead = true);
    if (rows[i].kind === "hunk") inHead = false; // earlier hunks are not header
    if (inHead) head.push(rows[i].text);
  }
  return [...head, ...rows.slice(start, end).map((r) => r.text), ""].join("\n");
}
