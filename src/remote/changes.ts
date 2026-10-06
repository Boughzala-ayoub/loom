/** Changes: the PC's git panel as phone screens. Everything is `loomctl git`,
 * which runs git the way the panel's own buttons do. */
import { diffRows, hunkPatch, type DiffRow } from "../gitparse";
import {
  act, app, base, button, closeSheet, confirmSheet, el, findThread, go, iconButton, item, pref, promptSheet, replaceAround, run, setPref,
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
// Each screen's newest read: a reply to an older one, or for another thread, is dropped,
// so a late answer never puts one thread's files and buttons under another's name.
let readSeq = 0, diffSeq = 0, filesSeq = 0;
const git = (tid: string, args: string[], opts: { stdin?: string; change?: boolean; timeout?: number } = {}) => run<Status>("git", [tid, ...args], { timeout: 120, ...opts });

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
  const tid = thread;
  if (!tid || summary.hidden || (!now && Date.now() - readAt < 6000)) return;
  readAt = Date.now();
  const n = ++readSeq;
  try {
    const s = await git(tid, ["status"]);
    if (n === readSeq && tid === thread) draw(tid, s);
  } catch (e) {
    if (n === readSeq && tid === thread) body.replaceChildren(empty("git can't read this thread", e instanceof Error ? e.message : String(e)));
  }
}

function empty(title: string, text: string) {
  const box = el("div", "empty");
  box.append(el("b", "", title), text);
  return box;
}

let held = false; // the commit box kept as it was while a message is typed: redrawn once you leave it
function draw(tid: string, s: Status) {
  status = s;
  const key = JSON.stringify(s);
  const kept = body.querySelector<HTMLElement>(".composer");
  const typing = !!kept && kept.dataset.thread === tid && document.activeElement === kept.querySelector("textarea");
  if (key === statusKey && !(held && !typing)) return; // leave the rows under the finger
  statusKey = key;
  const t = findThread(tid);
  const tracked = [...s.staged, ...s.unstaged];
  const paths = new Set([...tracked, ...s.untracked].map((f) => f.path));
  if (t) paintPicker({ name: t.name, changed: { add: tracked.reduce((n, f) => n + f.add, 0), del: tracked.reduce((n, f) => n + f.del, 0), files: paths.size } });
  const nodes: Node[] = [branchCard(tid, s)];
  const total = s.staged.length + s.unstaged.length + s.untracked.length;
  if (!total) nodes.push(empty("Nothing to commit", "The working tree matches the last commit."));
  else nodes.push(composer(tid, s));
  for (const [sec, title] of SECTIONS) {
    const files = s[sec];
    if (!files.length) continue;
    const head = el("div", "section-title");
    head.append(el("span", "grow", `${title} ${files.length}`));
    if (sec === "staged") head.append(button("Unstage all", () => void change(tid, ["unstage", "--staged"], "Unstaged"), "ghost"));
    else head.append(button("Stage all", () => void change(tid, ["stage", `--${sec}`], "Staged"), "ghost"));
    const box = el("div", "files");
    box.append(...files.map((f) => fileRow(tid, sec, f)));
    nodes.push(head, box);
  }
  if (s.commits.length) {
    const box = el("div", "files");
    box.append(...s.commits.map((c) => {
      const row = el("div", "commit-row");
      const open = button("", () => go(`#/commit/${encodeURIComponent(tid)}/${c.sha}`), "open");
      open.append(el("b", "", c.subject), el("span", "mono", c.sha));
      row.append(open, iconButton("more", `Commit ${c.sha}`, () => commitActions(tid, c)));
      return row;
    }));
    nodes.push(el("div", "section-title", "Recent commits"), box);
  }
  // A message being typed keeps its box, never rebuilt: the caret stays, and so does a word the phone's keyboard is composing.
  const at = typing ? nodes.findIndex((n) => n instanceof HTMLElement && n.matches(".composer")) : -1;
  held = at >= 0;
  if (held) (nodes[at] = kept!), replaceAround(body, nodes, kept!);
  else body.replaceChildren(...nodes);
}

function branchCard(tid: string, s: Status) {
  const card = el("div", "branch-card");
  const name = el("div", "branch");
  name.append(ui("branch"), s.branch || "(no branch)");
  const far = s.ahead || s.behind ? [s.ahead ? `${s.ahead} to push` : "", s.behind ? `${s.behind} to pull` : ""].filter(Boolean).join(", ") : "up to date";
  card.append(name, el("div", "upstream", s.upstream ? `${s.upstream}: ${far}` : "Not pushed yet"));
  const row = el("div", "row");
  if (s.behind) row.append(button("Pull", () => void change(tid, ["pull"], "Pulled")));
  row.append(button(s.upstream ? "Push" : "Publish branch", () => void change(tid, ["push"], "Pushed")), button("Create PR", () => void openPR(tid)));
  card.append(row);
  if (s.midway) {
    const bar = el("div", "midway");
    const acts = el("div", "row");
    acts.append(button(s.midway === "merge" ? "Commit" : "Continue", () => void change(tid, ["continue"], "Continued"), "primary"));
    if (s.midway === "rebase") acts.append(button("Skip", () => void change(tid, ["skip"], "Skipped")));
    acts.append(button("Abort", () => void ask(tid, `Abort the ${s.midway}?`, "The branch goes back to where it was before it started.", "Abort", ["abort"], "Aborted"), "danger"));
    bar.append(el("b", "", `A ${s.midway} is in progress`), acts);
    card.append(bar);
  }
  return card;
}

function fileRow(tid: string, sec: Sec, f: File) {
  const row = el("div", "file");
  const l = letter(sec, f);
  const open = button("", () => go(`#/diff/${encodeURIComponent(tid)}/${sec}/${encodeURIComponent(f.path)}`), "open");
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  open.append(el("b", "", base(f.path)), el("span", "", dir || " "));
  row.append(el("span", `letter ${l}`, l), open, stat(f), iconButton("more", `${f.path}: actions`, () => fileActions(tid, sec, f)));
  return row;
}

function fileActions(tid: string, sec: Sec, f: File) {
  const items: Node[] = [item("Show the diff", () => go(`#/diff/${encodeURIComponent(tid)}/${sec}/${encodeURIComponent(f.path)}`), "", { icon: "file" })];
  if (conflicted(f)) items.push(
    item("Keep ours", () => change(tid, ["resolve", "ours", f.path], "Kept ours"), "", { icon: "changes" }),
    item("Keep theirs", () => change(tid, ["resolve", "theirs", f.path], "Kept theirs"), "", { icon: "changes" }),
    item("Mark resolved", () => change(tid, ["stage", f.path], "Marked resolved"), "", { icon: "changes" }),
  );
  else if (sec === "staged") items.push(item("Unstage", () => change(tid, ["unstage", f.path], "Unstaged"), "", { icon: "undo" }));
  else items.push(item("Stage", () => change(tid, ["stage", `--${sec}`, f.path], "Staged"), "", { icon: "plus" }));
  items.push(item(sec === "untracked" ? "Delete" : "Discard changes", () => change(tid, ["discard", `--${sec}`, f.path, "--yes"], "Discarded"), "", {
    icon: "trash", danger: true, ask: [sec === "untracked" ? `Delete ${base(f.path)}?` : `Discard changes to ${base(f.path)}?`, sec === "untracked" ? "git never had this file, so it can't come back." : "They can't be brought back.", sec === "untracked" ? "Delete" : "Discard"],
  }));
  void sheet(items, f.path);
}

/** A git change in the thread it was asked for: the reply is the status after it,
 * drawn while that thread is on show, and newer than any read already on its way. */
async function change(tid: string, args: string[], done: string, opts: { stdin?: string } = {}) {
  let after: Status | null = null;
  const ok = await act(async () => { after = await git(tid, args, { change: true, ...opts }); }, done);
  if (after && tid === thread) (readSeq++, draw(tid, after));
  return ok;
}
async function ask(tid: string, title: string, detail: string, action: string, args: string[], done: string) {
  if (await confirmSheet(title, detail, action, true)) await change(tid, [...args, "--yes"], done);
}

// --- Committing -------------------------------------------------------------------

let onlyStaged = false;
function composer(tid: string, s: Status) {
  const box = el("div", "composer");
  box.dataset.thread = tid;
  const draftKey = `loom-commit-${tid}`;
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
    const done = await change(tid, ["commit", "-", ...(onlyStaged ? ["--staged"] : []), ...(push ? ["--push"] : [])], push ? "Committed and pushed" : "Committed", { stdin: text });
    for (const b of buttons) b.disabled = false;
    if (done) setPref(draftKey, "");
  };
  const buttons = [button("Commit", commit(false), "primary"), button("Commit & push", commit(true))];
  const row = el("div", "row");
  row.append(...buttons);
  box.append(msg, which, row);
  return box;
}

async function openPR(tid: string) {
  // A window opened now, before awaiting, isn't a popup the browser blocks.
  const win = window.open("", "_blank");
  try {
    const got = await run<{ url: string }>("git", [tid, "pr"], { change: true, timeout: 120 });
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
  const tid = thread;
  if (!tid) return;
  const t = findThread(tid);
  void sheet([
    item("Fetch", () => change(tid, ["fetch"], "Fetched"), "", { icon: "refresh" }),
    item("Pull (rebase)", () => change(tid, ["pull"], "Pulled"), "", { icon: "pull" }),
    item("Push", () => change(tid, ["push"], "Pushed"), "", { icon: "push" }),
    item("Create PR", () => openPR(tid), "", { icon: "pr" }),
    item("Switch branch", () => branches(tid), "", { icon: "branch" }),
    item("Stash all changes", () => change(tid, ["stash"], "Stashed"), "", { icon: "stash" }),
    item("Restore a stash", () => stashes(tid), "", { icon: "stash" }),
    item("Amend last commit", () => amend(tid), "", { icon: "rename" }),
    item("Undo last commit", () => change(tid, ["undo", "--yes"], "Undone"), "", { icon: "undo", ask: ["Undo the last commit?", "Its changes come back as staged work.", "Undo"] }),
    item("Force push", () => change(tid, ["force-push", "--yes"], "Force-pushed"), "", {
      icon: "push", danger: true, ask: [`Force-push ${status?.branch ?? "this branch"}?`, "It overwrites the remote branch unless someone else has pushed since you last fetched.", "Force push"],
    }),
    item("Browse files", () => go(`#/files/${encodeURIComponent(tid)}`), "", { icon: "file" }),
    item("Open in VS Code on the PC", () => run("vscode", [tid], { change: true }), "VS Code opened on the PC", { icon: "code" }),
  ], t ? `${t.name}: git` : "git");
}

async function amend(tid: string) {
  const draftKey = `loom-commit-${tid}`;
  const msg = pref(draftKey, "").trim();
  if (!(await confirmSheet("Amend the last commit?", msg ? `Its message becomes: ${msg}` : "Its message stays. Type one in the commit box first to change it.", "Amend", true))) return;
  if (await change(tid, ["amend", "--yes", ...(msg ? ["-"] : [])], "Amended", msg ? { stdin: msg } : {})) setPref(draftKey, "");
}

async function branches(tid: string) {
  const got = await run<{ current: string; branches: string[] }>("git", [tid, "branches"]).catch((e) => (toast(e.message, true), null));
  if (!got) return;
  void sheet([
    button("New branch…", async () => {
      closeSheet();
      const name = await promptSheet("New branch", "", "feature/name", "Create and switch");
      if (name) await change(tid, ["switch", name, "--create"], `On ${name}`);
    }, "item"),
    ...got.branches.map((b) => item(b === got.current ? `${b} (current)` : b, () => (b === got.current ? undefined : change(tid, ["switch", b], `On ${b}`)), "", { icon: "branch" })),
  ], "Switch branch");
}

async function stashes(tid: string) {
  const got = await run<{ stashes: { ref: string; message: string }[] }>("git", [tid, "stashes"]).catch((e) => (toast(e.message, true), null));
  if (!got) return;
  if (!got.stashes.length) return void sheet([el("p", "", "Stash all changes from the git actions to keep them here.")], "No stashes");
  void sheet(got.stashes.flatMap((x) => {
    const pair = el("div", "pair");
    const apply = item(`${x.ref}: ${x.message}`, () => change(tid, ["stash-apply", x.ref], "Stash applied"), "", { icon: "stash" });
    const drop = iconButton("trash", `Drop ${x.ref}`, () => { closeSheet(); void ask(tid, `Drop ${x.ref}?`, x.message, "Drop", ["stash-drop", x.ref], "Dropped"); });
    pair.append(apply, drop);
    return [pair];
  }), "Restore a stash");
}

function commitActions(tid: string, c: { sha: string; subject: string }) {
  void sheet([
    item("Show the commit", () => go(`#/commit/${encodeURIComponent(tid)}/${c.sha}`), "", { icon: "file" }),
    item("Revert it", () => change(tid, ["revert", c.sha], "Reverted"), "", { icon: "undo", ask: [`Revert ${c.sha}?`, "A new commit undoes its changes.", "Revert"] }),
    item("Move the branch back to it", () => change(tid, ["reset", c.sha, "--soft", "--yes"], "Reset"), "", { icon: "history", ask: [`Move the branch back to ${c.sha}?`, "Everything after it stays in the tree, staged.", "Reset"] }),
    item("Reset hard to it", () => change(tid, ["reset", c.sha, "--hard", "--yes"], "Reset"), "", { icon: "trash", danger: true, ask: [`Reset hard to ${c.sha}?`, "Every change after it is lost.", "Reset hard"] }),
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
// A hunk action completes on the screen it started from (its route), or it neither
// reloads the diff screen, which may show another file now, nor goes back from where you are.
const showDiffAgain = () => lastDiff();

/** One file's diff in a section, with each hunk's buttons as on the PC. */
export function showDiff(tid: string, sec: Sec, path: string) {
  thread = tid;
  diffName.textContent = base(path);
  diffSub.textContent = `${SECTIONS.find(([s]) => s === sec)?.[1] ?? sec}: ${path}`;
  fullBtn.hidden = false;
  fullBtn.textContent = full ? "Changes only" : "Whole file";
  lastDiff = async () => {
    const n = ++diffSeq;
    diffBox.replaceChildren(el("p", "hint", "Reading the diff…"));
    try {
      const got = await run<{ diff: string }>("git", [tid, "diff", path, `--${sec}`, ...(full ? ["--full"] : [])], { timeout: 60 });
      if (n === diffSeq) drawDiff(tid, got.diff, sec, path);
    } catch (e) {
      if (n === diffSeq) diffBox.replaceChildren(empty("No diff", e instanceof Error ? e.message : String(e)));
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
    const n = ++diffSeq;
    diffBox.replaceChildren(el("p", "hint", "Reading the commit…"));
    try {
      const text = (await run<{ diff: string }>("git", [tid, "show", sha], { timeout: 60 })).diff;
      if (n !== diffSeq) return;
      // git show: the commit's header, its --stat, then the patch.
      const at = text.indexOf("\ndiff --git");
      const head = at < 0 ? text : text.slice(0, at);
      drawDiff(tid, at < 0 ? "" : text.slice(at + 1), null, "");
      diffBox.prepend(commitHead(head));
    } catch (e) {
      if (n === diffSeq) diffBox.replaceChildren(empty("Can't show it", e instanceof Error ? e.message : String(e)));
    }
  };
  void lastDiff();
}

/** The first PAGE of `count` rows, and a button that adds the next PAGE each tap. A phone lays out a
 * thousand rows in a few hundred ms; all of a 10,000-line file froze it for over a second. */
const PAGE = 1000;
function paged(count: number, row: (i: number) => Node | null): Node[] {
  let next = 0;
  const more = button("", () => more.before(...page()), "more-rows");
  const page = () => {
    const out: Node[] = [];
    for (const end = Math.min(count, next + PAGE); next < end; next++) {
      const node = row(next);
      if (node) out.push(node);
    }
    more.hidden = next >= count;
    more.textContent = `Show more: ${count - next} line${count - next === 1 ? "" : "s"} left`;
    return out;
  };
  return [...page(), more];
}

function drawDiff(tid: string, text: string, sec: Sec | null, path: string) {
  const rows = diffRows(text);
  if (!rows.length) return void diffBox.replaceChildren(...(sec === null ? [] : [empty("No differences", "Nothing changed here, or it's a binary file.")]));
  const files = rows.filter((r) => r.text.startsWith("diff --git")).length;
  const moves: [string, string[], boolean][] = sec === "unstaged" ? [["Stage", ["--cached"], false], ["Discard", ["--reverse"], true]] : sec === "staged" ? [["Unstage", ["--cached", "--reverse"], false]] : [];
  const out: Node[] = [];
  if (sec === "untracked") out.push(fileBar(button("Stage this file", () => {
    const route = location.hash;
    void change(tid, ["stage", "--untracked", path], "Staged").then((ok) => ok && location.hash === route && history.back());
  }, "primary")));
  out.push(...paged(rows.length, (i) => {
    const r: DiffRow = rows[i];
    if (r.text.startsWith("diff --git")) return files > 1 || sec === null ? el("div", "file-head", r.text.replace(/^diff --git a\/(.*) b\/.*$/, "$1")) : null;
    if (r.kind === "hunk") {
      const h = el("div", "hunk");
      h.append(el("code", "", r.text));
      for (const [label, args, risky] of moves) h.append(button(label, () => void moveHunk(tid, rows, i, args, risky, label), risky ? "danger" : ""));
      return h;
    }
    if (r.kind === "meta" && /^(index |--- |\+\+\+ )/.test(r.text)) return null;
    const line = el("div", `r ${r.kind}`);
    line.append(el("span", "n", r.kind === "add" ? "" : r.old ? String(r.old) : ""), el("span", "n", r.kind === "del" ? "" : r.neu ? String(r.neu) : ""), el("span", "t", r.text || " "));
    return line;
  }));
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

async function moveHunk(tid: string, rows: DiffRow[], at: number, args: string[], risky: boolean, label: string) {
  const route = location.hash;
  if (risky && !(await confirmSheet("Discard this hunk?", "Its changes can't be brought back.", "Discard", true))) return;
  if (await change(tid, ["apply", "-", ...args, ...(risky ? ["--yes"] : [])], `${label === "Stage" ? "Staged" : label === "Unstage" ? "Unstaged" : "Discarded"} the hunk`, { stdin: hunkPatch(rows, at) }) && location.hash === route) void showDiffAgain();
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
let fileList: string[] = [], filesTid = ""; // the list on show, and its thread
filesFind.oninput = () => drawFiles();

export async function showFiles(tid: string) {
  thread = tid;
  const n = ++filesSeq;
  filesBox.replaceChildren(el("p", "hint", "Reading the file list…"));
  try {
    const files = (await run<{ files: string[] }>("git", [tid, "files"], { timeout: 60 })).files;
    if (n !== filesSeq) return;
    [fileList, filesTid] = [files, tid];
    drawFiles();
  } catch (e) {
    if (n === filesSeq) filesBox.replaceChildren(empty("Can't list the files", e instanceof Error ? e.message : String(e)));
  }
}
function drawFiles() {
  const q = filesFind.value.trim().toLowerCase();
  const hits = (q ? fileList.filter((f) => f.toLowerCase().includes(q)) : fileList).slice(0, 300);
  filesBox.replaceChildren(...hits.map((f) => {
    const b = button("", () => go(`#/file/${encodeURIComponent(filesTid)}/${encodeURIComponent(f)}`), "list-row");
    b.append(ui("file"), el("span", "grow", f));
    return b;
  }), ...(hits.length === 300 ? [el("p", "hint", "Type to narrow the list.")] : []));
}

export async function showFile(tid: string, path: string) {
  thread = tid;
  diffName.textContent = base(path);
  diffSub.textContent = path;
  fullBtn.hidden = true;
  const n = ++diffSeq;
  diffBox.replaceChildren(el("p", "hint", "Reading the file…"));
  try {
    const lines = (await run<{ text: string }>("git", [tid, "file", path], { timeout: 60 })).text.split("\n");
    if (n !== diffSeq) return;
    diffBox.replaceChildren(...paged(lines.length, (i) => {
      const line = el("div", "r");
      line.append(el("span", "n", ""), el("span", "n", String(i + 1)), el("span", "t", lines[i] || " "));
      return line;
    }));
  } catch (e) {
    if (n === diffSeq) diffBox.replaceChildren(empty("Can't show it", e instanceof Error ? e.message : String(e)));
  }
}

/** Where a diff's back arrow goes: the summary of the same thread. */
export const changesHash = () => (thread ? `#/changes/${encodeURIComponent(thread)}` : "#/changes");
