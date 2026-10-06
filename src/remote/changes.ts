/** Changes: the PC's git panel as phone screens. Everything is `loomctl git`,
 * which runs git the way the panel's own buttons do. */
import { diffRows, hunkPatch, type DiffRow } from "../gitparse";
import {
  act, app, base, button, closeSheet, confirmSheet, el, findThread, go, iconButton, item, pref, promptSheet, run, setPref,
  sheet, stat, tick, toast, topBar, ui,
} from "./core";

type File = { path: string; x: string; y: string; add: number; del: number };
type Sec = "staged" | "unstaged" | "untracked";
type Status = {
  thread: string; name: string; branch: string; upstream: string; ahead: number; behind: number; midway: string;
  staged: File[]; unstaged: File[]; untracked: File[]; commits: { sha: string; subject: string }[];
};

const SECTIONS: [Sec, string][] = [["staged", "Staged"], ["unstaged", "Changes"], ["untracked", "New files"]];
const conflicted = (c: File) => c.x === "U" || c.y === "U" || (c.x === c.y && (c.x === "A" || c.x === "D"));
const letter = (sec: Sec, c: File) => (conflicted(c) ? "!" : sec === "staged" ? c.x : sec === "untracked" ? "U" : c.y);

let thread: string | null = null; // the thread on show
let status: Status | null = null;
let statusKey = "";
const git = (args: string[], opts: { stdin?: string; change?: boolean; timeout?: number } = {}) => run<Status>("git", [thread!, ...args], { timeout: 120, ...opts });

// --- The summary ------------------------------------------------------------------

export const summary = el("section", "screen primary");
summary.id = "changes";
const pickerBtn = button("", () => pickThread(), "picker");
const body = el("div", "body");
const page = el("div", "body");
page.append(pickerBtn, body);
body.style.padding = "0";
summary.append(topBar("Changes", [iconButton("refresh", "Refresh", () => void read(true)), iconButton("more", "Git actions", () => repoActions())]), page);
function paintPicker(t: { name: string; changed?: { add: number; del: number; files: number } }) {
  const who = el("span", "who");
  const n = t.changed?.files ?? 0;
  who.append(el("b", "", t.name), el("span", "", n ? `${n} file${n === 1 ? "" : "s"} changed` : "No changes"));
  pickerBtn.replaceChildren(who, stat(t.changed), ui("fold"));
  pickerBtn.setAttribute("aria-label", `Changes in ${t.name}: pick another thread`);
}

/** The thread asked for, else the one in front on the PC, else the first with changes. */
export function showSummary(id: string | null) {
  const t = findThread(id) ?? findThread(pref("loom-changes", "")) ?? app.threads.find((x) => x.front) ?? app.threads.find((x) => x.changed?.files) ?? app.threads[0];
  if (!t) {
    thread = null;
    body.replaceChildren(empty("No threads", "Start a thread on the Agents tab first."));
    pickerBtn.hidden = true;
    return;
  }
  if (t.id !== thread) (status = null), (statusKey = "");
  thread = t.id;
  setPref("loom-changes", t.id);
  pickerBtn.hidden = false;
  paintPicker(t);
  if (!status) body.replaceChildren(el("p", "hint", "Reading git…"));
  void read(true);
}
export const changesThread = () => thread;

let readAt = 0;
/** Reads git again: on show, after a change, and every 6 s while it's on screen. */
export async function read(now = false) {
  if (!thread || summary.hidden || (!now && Date.now() - readAt < 6000)) return;
  readAt = Date.now();
  try {
    draw(await git(["status"]));
  } catch (e) {
    body.replaceChildren(empty("git can't read this thread", e instanceof Error ? e.message : String(e)));
  }
}

function empty(title: string, text: string) {
  const box = el("div", "empty");
  box.append(el("b", "", title), text);
  return box;
}

function draw(s: Status) {
  status = s;
  const key = JSON.stringify(s);
  if (key === statusKey) return; // leave the rows under the finger
  statusKey = key;
  const kept = body.querySelector<HTMLTextAreaElement>(".composer textarea");
  const focused = document.activeElement === kept;
  const t = findThread(thread);
  const tracked = [...s.staged, ...s.unstaged];
  const paths = new Set([...tracked, ...s.untracked].map((f) => f.path));
  if (t) paintPicker({ name: t.name, changed: { add: tracked.reduce((n, f) => n + f.add, 0), del: tracked.reduce((n, f) => n + f.del, 0), files: paths.size } });
  const nodes: Node[] = [branchCard(s)];
  const total = s.staged.length + s.unstaged.length + s.untracked.length;
  if (!total) nodes.push(empty("Nothing to commit", "The working tree matches the last commit."));
  else nodes.push(composer(s));
  for (const [sec, title] of SECTIONS) {
    const files = s[sec];
    if (!files.length) continue;
    const head = el("div", "section-title");
    head.append(el("span", "grow", `${title} ${files.length}`));
    if (sec === "staged") head.append(button("Unstage all", () => void change(["unstage", "--staged"], "Unstaged"), "ghost"));
    else head.append(button("Stage all", () => void change(["stage", `--${sec}`], "Staged"), "ghost"));
    const box = el("div", "files");
    box.append(...files.map((f) => fileRow(sec, f)));
    nodes.push(head, box);
  }
  if (s.commits.length) {
    const box = el("div", "files");
    box.append(...s.commits.map((c) => {
      const row = el("div", "commit-row");
      const open = button("", () => go(`#/commit/${encodeURIComponent(thread!)}/${c.sha}`), "open");
      open.append(el("b", "", c.subject), el("span", "mono", c.sha));
      row.append(open, iconButton("more", `Commit ${c.sha}`, () => commitActions(c)));
      return row;
    }));
    nodes.push(el("div", "section-title", "Recent commits"), box);
  }
  body.replaceChildren(...nodes);
  if (focused) body.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
}

function branchCard(s: Status) {
  const card = el("div", "branch-card");
  const name = el("div", "branch");
  name.append(ui("branch"), s.branch || "(no branch)");
  const far = s.ahead || s.behind ? [s.ahead ? `${s.ahead} to push` : "", s.behind ? `${s.behind} to pull` : ""].filter(Boolean).join(", ") : "up to date";
  card.append(name, el("div", "upstream", s.upstream ? `${s.upstream}: ${far}` : "Not pushed yet"));
  const row = el("div", "row");
  if (s.behind) row.append(button("Pull", () => void change(["pull"], "Pulled")));
  row.append(button(s.upstream ? "Push" : "Publish branch", () => void change(["push"], "Pushed")), button("Create PR", () => void openPR()));
  card.append(row);
  if (s.midway) {
    const bar = el("div", "midway");
    const acts = el("div", "row");
    acts.append(button(s.midway === "merge" ? "Commit" : "Continue", () => void change(["continue"], "Continued"), "primary"));
    if (s.midway === "rebase") acts.append(button("Skip", () => void change(["skip"], "Skipped")));
    acts.append(button("Abort", () => void ask(`Abort the ${s.midway}?`, "The branch goes back to where it was before it started.", "Abort", ["abort"], "Aborted"), "danger"));
    bar.append(el("b", "", `A ${s.midway} is in progress`), acts);
    card.append(bar);
  }
  return card;
}

function fileRow(sec: Sec, f: File) {
  const row = el("div", "file");
  const l = letter(sec, f);
  const open = button("", () => go(`#/diff/${encodeURIComponent(thread!)}/${sec}/${encodeURIComponent(f.path)}`), "open");
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  open.append(el("b", "", base(f.path)), el("span", "", dir || " "));
  row.append(el("span", `letter ${l}`, l), open, stat(f), iconButton("more", `${f.path}: actions`, () => fileActions(sec, f)));
  return row;
}

function fileActions(sec: Sec, f: File) {
  const items: Node[] = [item("Show the diff", () => go(`#/diff/${encodeURIComponent(thread!)}/${sec}/${encodeURIComponent(f.path)}`), "", { icon: "file" })];
  if (conflicted(f)) items.push(
    item("Keep ours", () => change(["resolve", "ours", f.path], "Kept ours"), "", { icon: "changes" }),
    item("Keep theirs", () => change(["resolve", "theirs", f.path], "Kept theirs"), "", { icon: "changes" }),
    item("Mark resolved", () => change(["stage", f.path], "Marked resolved"), "", { icon: "changes" }),
  );
  else if (sec === "staged") items.push(item("Unstage", () => change(["unstage", f.path], "Unstaged"), "", { icon: "undo" }));
  else items.push(item("Stage", () => change(["stage", `--${sec}`, f.path], "Staged"), "", { icon: "plus" }));
  items.push(item(sec === "untracked" ? "Delete" : "Discard changes", () => change(["discard", `--${sec}`, f.path, "--yes"], "Discarded"), "", {
    icon: "trash", danger: true, ask: [sec === "untracked" ? `Delete ${base(f.path)}?` : `Discard changes to ${base(f.path)}?`, sec === "untracked" ? "git never had this file, so it can't come back." : "They can't be brought back.", sec === "untracked" ? "Delete" : "Discard"],
  }));
  void sheet(items, f.path);
}

/** A git change: the reply is the status after it. */
async function change(args: string[], done: string, opts: { stdin?: string } = {}) {
  let after: Status | null = null;
  const ok = await act(async () => { after = await git(args, { change: true, ...opts }); }, done);
  if (after) draw(after);
  return ok;
}
async function ask(title: string, detail: string, action: string, args: string[], done: string) {
  if (await confirmSheet(title, detail, action, true)) await change([...args, "--yes"], done);
}

// --- Committing -------------------------------------------------------------------

let onlyStaged = false;
function composer(s: Status) {
  const box = el("div", "composer");
  const draftKey = `loom-commit-${thread}`;
  const msg = el("textarea");
  Object.assign(msg, { rows: 2, placeholder: "Commit message", value: pref(draftKey, "") });
  msg.setAttribute("aria-label", "Commit message");
  msg.oninput = () => setPref(draftKey, msg.value);
  if (!s.staged.length) onlyStaged = false;
  const which = el("div", "seg");
  for (const [v, label] of [[false, "All changes"], [true, `Only staged (${s.staged.length})`]] as const) {
    const b = button(label, () => { onlyStaged = v; for (const x of which.children) x.setAttribute("aria-pressed", String(x === b)); });
    b.setAttribute("aria-pressed", String(onlyStaged === v));
    which.append(b);
  }
  which.hidden = !s.staged.length;
  const commit = (push: boolean) => async () => {
    const text = msg.value.trim();
    if (!text) return msg.focus();
    for (const b of buttons) b.disabled = true;
    const done = await change(["commit", "-", ...(onlyStaged ? ["--staged"] : []), ...(push ? ["--push"] : [])], push ? "Committed and pushed" : "Committed", { stdin: text });
    for (const b of buttons) b.disabled = false;
    if (done) setPref(draftKey, "");
  };
  const buttons = [button("Commit", commit(false), "primary"), button("Commit & push", commit(true))];
  const row = el("div", "row");
  row.append(...buttons);
  box.append(msg, which, row);
  return box;
}

async function openPR() {
  // A window opened now, before awaiting, isn't a popup the browser blocks.
  const win = window.open("", "_blank");
  try {
    const got = await run<{ url: string }>("git", [thread!, "pr"], { change: true, timeout: 120 });
    tick();
    if (win) win.location.href = got.url;
    else location.href = got.url;
    void read(true);
  } catch (e) {
    win?.close();
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

function repoActions() {
  if (!thread) return;
  const t = findThread(thread);
  void sheet([
    item("Fetch", () => change(["fetch"], "Fetched"), "", { icon: "refresh" }),
    item("Pull (rebase)", () => change(["pull"], "Pulled"), "", { icon: "pull" }),
    item("Push", () => change(["push"], "Pushed"), "", { icon: "push" }),
    item("Create PR", openPR, "", { icon: "pr" }),
    item("Switch branch", branches, "", { icon: "branch" }),
    item("Stash all changes", () => change(["stash"], "Stashed"), "", { icon: "stash" }),
    item("Restore a stash", stashes, "", { icon: "stash" }),
    item("Amend last commit", amend, "", { icon: "rename" }),
    item("Undo last commit", () => change(["undo", "--yes"], "Undone"), "", { icon: "undo", ask: ["Undo the last commit?", "Its changes come back as staged work.", "Undo"] }),
    item("Force push", () => change(["force-push", "--yes"], "Force-pushed"), "", {
      icon: "push", danger: true, ask: [`Force-push ${status?.branch ?? "this branch"}?`, "It overwrites the remote branch unless someone else has pushed since you last fetched.", "Force push"],
    }),
    item("Browse files", () => go(`#/files/${encodeURIComponent(thread!)}`), "", { icon: "file" }),
    item("Open in VS Code on the PC", () => run("vscode", [thread!], { change: true }), "VS Code opened on the PC", { icon: "code" }),
  ], t ? `${t.name}: git` : "git");
}

async function amend() {
  const draftKey = `loom-commit-${thread}`;
  const msg = pref(draftKey, "").trim();
  if (!(await confirmSheet("Amend the last commit?", msg ? `Its message becomes: ${msg}` : "Its message stays. Type one in the commit box first to change it.", "Amend", true))) return;
  if (await change(["amend", "--yes", ...(msg ? ["-"] : [])], "Amended", msg ? { stdin: msg } : {})) setPref(draftKey, "");
}

async function branches() {
  const got = await run<{ current: string; branches: string[] }>("git", [thread!, "branches"]).catch((e) => (toast(e.message, true), null));
  if (!got) return;
  void sheet([
    button("New branch…", async () => {
      closeSheet();
      const name = await promptSheet("New branch", "", "feature/name", "Create and switch");
      if (name) await change(["switch", name, "--create"], `On ${name}`);
    }, "item"),
    ...got.branches.map((b) => item(b === got.current ? `${b} (current)` : b, () => (b === got.current ? undefined : change(["switch", b], `On ${b}`)), "", { icon: "branch" })),
  ], "Switch branch");
}

async function stashes() {
  const got = await run<{ stashes: { ref: string; message: string }[] }>("git", [thread!, "stashes"]).catch((e) => (toast(e.message, true), null));
  if (!got) return;
  if (!got.stashes.length) return void sheet([el("p", "", "Stash all changes from the git actions to keep them here.")], "No stashes");
  void sheet(got.stashes.flatMap((x) => {
    const pair = el("div", "pair");
    const apply = item(`${x.ref}: ${x.message}`, () => change(["stash-apply", x.ref], "Stash applied"), "", { icon: "stash" });
    const drop = iconButton("trash", `Drop ${x.ref}`, () => { closeSheet(); void ask(`Drop ${x.ref}?`, x.message, "Drop", ["stash-drop", x.ref], "Dropped"); });
    pair.append(apply, drop);
    return [pair];
  }), "Restore a stash");
}

function commitActions(c: { sha: string; subject: string }) {
  void sheet([
    item("Show the commit", () => go(`#/commit/${encodeURIComponent(thread!)}/${c.sha}`), "", { icon: "file" }),
    item("Revert it", () => change(["revert", c.sha], "Reverted"), "", { icon: "undo", ask: [`Revert ${c.sha}?`, "A new commit undoes its changes.", "Revert"] }),
    item("Move the branch back to it", () => change(["reset", c.sha, "--soft", "--yes"], "Reset"), "", { icon: "history", ask: [`Move the branch back to ${c.sha}?`, "Everything after it stays in the tree, staged.", "Reset"] }),
    item("Reset hard to it", () => change(["reset", c.sha, "--hard", "--yes"], "Reset"), "", { icon: "trash", danger: true, ask: [`Reset hard to ${c.sha}?`, "Every change after it is lost.", "Reset hard"] }),
  ], c.subject);
}

function pickThread() {
  void sheet(app.threads.map((t) => {
    const b = button("", () => { closeSheet(); go(`#/changes/${encodeURIComponent(t.id)}`); }, "item");
    b.append(ui("branch"), el("span", "grow", t.name), stat(t.changed));
    b.style.justifyContent = "flex-start";
    return b;
  }), "Changes in");
}

// --- A diff -----------------------------------------------------------------------

export const diffView = el("section", "screen detail");
diffView.id = "diff";
const diffTop = el("div", "who");
const diffName = el("b"), diffSub = el("span");
diffTop.append(diffName, diffSub);
const fullBtn = button("Whole file", () => { full = !full; setPref("loom-diff-full", full ? "1" : ""); fullBtn.textContent = full ? "Changes only" : "Whole file"; void showDiffAgain(); }, "ghost");
const diffBox = el("div", "diff");
diffView.append(topBar(diffTop, [fullBtn], "#/changes"), diffBox);
let full = pref("loom-diff-full", "") === "1";
let lastDiff: () => Promise<void> = async () => {};
const showDiffAgain = () => lastDiff();

/** One file's diff in a section, with each hunk's buttons as on the PC. */
export function showDiff(tid: string, sec: Sec, path: string) {
  thread = tid;
  diffName.textContent = base(path);
  diffSub.textContent = `${SECTIONS.find(([s]) => s === sec)?.[1] ?? sec}: ${path}`;
  fullBtn.hidden = false;
  fullBtn.textContent = full ? "Changes only" : "Whole file";
  lastDiff = async () => {
    diffBox.replaceChildren(el("p", "hint", "Reading the diff…"));
    try {
      const got = await run<{ diff: string }>("git", [tid, "diff", path, `--${sec}`, ...(full ? ["--full"] : [])], { timeout: 60 });
      drawDiff(got.diff, sec, path);
    } catch (e) {
      diffBox.replaceChildren(empty("No diff", e instanceof Error ? e.message : String(e)));
    }
  };
  void lastDiff();
}

/** A commit: its stat and patch. */
export function showCommit(tid: string, sha: string) {
  thread = tid;
  diffName.textContent = `Commit ${sha}`;
  diffSub.textContent = findThread(tid)?.name ?? "";
  fullBtn.hidden = true;
  lastDiff = async () => {
    diffBox.replaceChildren(el("p", "hint", "Reading the commit…"));
    try {
      const text = (await run<{ diff: string }>("git", [tid, "show", sha], { timeout: 60 })).diff;
      // git show: the commit's header, its --stat, then the patch.
      const at = text.indexOf("\ndiff --git");
      const head = at < 0 ? text : text.slice(0, at);
      drawDiff(at < 0 ? "" : text.slice(at + 1), null, "");
      diffBox.prepend(commitHead(head));
    } catch (e) {
      diffBox.replaceChildren(empty("Can't show it", e instanceof Error ? e.message : String(e)));
    }
  };
  void lastDiff();
}

const CAP = 20000; // rows drawn: a phone isn't for reading more than this
function drawDiff(text: string, sec: Sec | null, path: string) {
  const rows = diffRows(text);
  if (!rows.length) return void diffBox.replaceChildren(...(sec === null ? [] : [empty("No differences", "Nothing changed here, or it's a binary file.")]));
  const files = rows.filter((r) => r.text.startsWith("diff --git")).length;
  const moves: [string, string[], boolean][] = sec === "unstaged" ? [["Stage", ["--cached"], false], ["Discard", ["--reverse"], true]] : sec === "staged" ? [["Unstage", ["--cached", "--reverse"], false]] : [];
  const out: Node[] = [];
  if (sec === "untracked") out.push(fileBar(button("Stage this file", () => void change(["stage", "--untracked", path], "Staged").then(() => history.back()), "primary")));
  rows.slice(0, CAP).forEach((r: DiffRow, i) => {
    if (r.text.startsWith("diff --git")) {
      if (files > 1 || sec === null) out.push(el("div", "file-head", r.text.replace(/^diff --git a\/(.*) b\/.*$/, "$1")));
      return;
    }
    if (r.kind === "hunk") {
      const h = el("div", "hunk");
      h.append(el("code", "", r.text));
      for (const [label, args, risky] of moves) h.append(button(label, () => void moveHunk(rows, i, args, risky, label), risky ? "danger" : ""));
      out.push(h);
      return;
    }
    if (r.kind === "meta" && /^(index |--- |\+\+\+ )/.test(r.text)) return;
    const line = el("div", `r ${r.kind}`);
    line.append(el("span", "n", r.kind === "add" ? "" : r.old ? String(r.old) : ""), el("span", "n", r.kind === "del" ? "" : r.neu ? String(r.neu) : ""), el("span", "t", r.text || " "));
    out.push(line);
  });
  if (rows.length > CAP) out.push(el("p", "hint", `${rows.length - CAP} more lines not shown.`));
  diffBox.replaceChildren(...out);
}
function commitHead(head: string) {
  const lines = head.split("\n");
  const author = lines.find((l) => l.startsWith("Author:"))?.slice(7).trim().replace(/\s*<.*>$/, "") ?? "";
  const date = lines.find((l) => l.startsWith("Date:"))?.slice(5).trim() ?? "";
  const message = lines.filter((l) => l.startsWith("    ")).map((l) => l.slice(4));
  const stats = lines.map((l) => /^\s*(.+?)\s*\|\s*(\d+|Bin.*?)(?:\s+[+-]+)?\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const total = lines.find((l) => /files? changed/.test(l))?.trim() ?? "";
  const box = el("div", "commit-head");
  box.append(el("b", "", message[0] ?? ""));
  if (message.length > 1) box.append(el("p", "", message.slice(1).join("\n").trim()));
  box.append(el("span", "meta", [author, date ? new Date(date).toLocaleString() : "", total].filter(Boolean).join(". ")));
  if (stats.length) {
    const files = el("div", "files");
    files.append(...stats.map(([, name, n]) => {
      const row = el("div", "stat-row");
      row.append(el("span", "", name), el("span", "", /^\d+$/.test(n) ? `${n} line${n === "1" ? "" : "s"}` : "binary"));
      return row;
    }));
    box.append(files);
  }
  return box;
}
function fileBar(...nodes: Node[]) {
  const bar = el("div", "hunk");
  bar.append(...nodes);
  return bar;
}

async function moveHunk(rows: DiffRow[], at: number, args: string[], risky: boolean, label: string) {
  if (risky && !(await confirmSheet("Discard this hunk?", "Its changes can't be brought back.", "Discard", true))) return;
  if (await change(["apply", "-", ...args, ...(risky ? ["--yes"] : [])], `${label === "Stage" ? "Staged" : label === "Unstage" ? "Unstaged" : "Discarded"} the hunk`, { stdin: hunkPatch(rows, at) })) void showDiffAgain();
}

// --- Files --------------------------------------------------------------------------

export const filesView = el("section", "screen detail");
filesView.id = "files";
const filesFind = el("input");
Object.assign(filesFind, { type: "search", placeholder: "Find a file", autocapitalize: "off", spellcheck: false });
filesFind.setAttribute("aria-label", "Find a file");
const filesBox = el("div", "files");
{
  const b = el("div", "body");
  const find = el("label", "find");
  find.append(ui("search"), filesFind);
  b.append(find, filesBox);
  filesView.append(topBar("Files", [], "#/changes"), b);
}
let fileList: string[] = [];
filesFind.oninput = () => drawFiles();

export async function showFiles(tid: string) {
  thread = tid;
  filesBox.replaceChildren(el("p", "hint", "Reading the file list…"));
  try {
    fileList = (await run<{ files: string[] }>("git", [tid, "files"], { timeout: 60 })).files;
    drawFiles();
  } catch (e) {
    filesBox.replaceChildren(empty("Can't list the files", e instanceof Error ? e.message : String(e)));
  }
}
function drawFiles() {
  const q = filesFind.value.trim().toLowerCase();
  const hits = (q ? fileList.filter((f) => f.toLowerCase().includes(q)) : fileList).slice(0, 300);
  filesBox.replaceChildren(...hits.map((f) => {
    const b = button("", () => go(`#/file/${encodeURIComponent(thread!)}/${encodeURIComponent(f)}`), "list-row");
    b.append(ui("file"), el("span", "grow", f));
    return b;
  }), ...(hits.length === 300 ? [el("p", "hint", "Type to narrow the list.")] : []));
}

export async function showFile(tid: string, path: string) {
  thread = tid;
  diffName.textContent = base(path);
  diffSub.textContent = path;
  fullBtn.hidden = true;
  diffBox.replaceChildren(el("p", "hint", "Reading the file…"));
  try {
    const text = (await run<{ text: string }>("git", [tid, "file", path], { timeout: 60 })).text;
    diffBox.replaceChildren(...text.split("\n").slice(0, CAP).map((t, i) => {
      const line = el("div", "r");
      line.append(el("span", "n", ""), el("span", "n", String(i + 1)), el("span", "t", t || " "));
      return line;
    }));
  } catch (e) {
    diffBox.replaceChildren(empty("Can't show it", e instanceof Error ? e.message : String(e)));
  }
}

/** Where a diff's back arrow goes: the summary of the same thread. */
export const changesHash = () => (thread ? `#/changes/${encodeURIComponent(thread)}` : "#/changes");
