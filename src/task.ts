/** Tasks: what `loomctl submit` hands back an id for, and how each one moves
 * from accepted to an outcome. Pure, so it runs under plain node
 * (task.test.ts). main.ts owns the panes: it feeds in what the agents signal
 * (route) and what it sees of the pane itself, and persists what changes.
 *
 * A task only finishes on a signal tied to it: the agent reporting this
 * prompt's text (Claude's UserPromptSubmit, Codex's turn input), the shell
 * running the command line that carries the task's id, or OpenCode's first
 * run after the Enter. A pane going quiet, or a later turn that never named
 * this prompt, never completes it. Where no such signal can come, the task
 * says so: `correlation` names what tied it, `uncertain` what Loom can't tell,
 * and `unknown` is an outcome of its own. */

export type TaskState = "accepted" | "submitted" | "working" | "approval" | "completed" | "failed" | "cancelled" | "unknown";
export const TASK_STATES: readonly TaskState[] = ["accepted", "submitted", "working", "approval", "completed", "failed", "cancelled", "unknown"];
const FINAL: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "unknown"]);
export const isFinal = (s: TaskState) => FINAL.has(s);

/** What tied the task's start or end to what the agent did. `prompt`: the
 * agent reported this prompt's text. `token`: the shell ran the command line
 * carrying this task's id. `sequence`: the agent's first run after the Enter,
 * which it didn't name (OpenCode). `screen`: Loom saw the agent working after
 * the Enter, and nothing reported it. */
export type Correlation = "prompt" | "token" | "sequence" | "screen";

/** One change of a task's state. `seq` counts every task's events in one
 * order that outlives Loom (the journal keeps it), so a watcher resumes after
 * the last one it saw and never sees one twice. A completed one carries
 * `response`, the agent's own report of its final message named as a prompt
 * is (promptMatch), never its text: two observations of one answer name the
 * same, so a relay can tell a repeat from a new answer. */
export type TaskEvent = { seq: number; task: string; at: number; state: TaskState; signal: string; detail?: string; response?: string; context?: TaskContext };

/** What a notice may say of where an event happened: the Loom thread, its
 * name, the pane's place in it and a title Loom chose itself
 * (docs/turn-tracking-and-notifications.md, Notification context). Copied
 * when Loom makes the event, never a reference, so a rename, a move or a close
 * later changes no copy. The pane id and agent are the task's own. */
export type TaskContext = {
  threadId: string | null;
  threadName: string | null;
  paneNumber: number | null;
  paneTitle: string | null;
  /** When Loom copied it, in ms. */
  capturedAt: number | null;
  /** `event`: copied from the live pane for this event. `last-known`: the
   * task's last copy, its pane having left its thread or relaunched.
   * `legacy`: nothing could be kept. */
  origin: "event" | "last-known" | "legacy";
  issues: ContextIssue[];
};
export type ContextIssue = "missing-name" | "missing-number" | "private-label" | "truncated-label" | "untrusted-title" | "invalid-context";
const ISSUES: readonly unknown[] = ["missing-name", "missing-number", "private-label", "truncated-label", "untrusted-title", "invalid-context"];
/** The only pane titles a notice may carry: Loom's own, for a pane whose
 * process set none. A process's title can hold a prompt summary (Claude), a
 * thread id (Codex) or a path (a shell). */
export const LOOM_TITLES = { shell: "Terminal", agent: "Agent session" } as const;
/** A path, or a name that looks like it holds a secret. A filter for the
 * obvious, not a promise that free text holds none. */
const PRIVATE = /^(?:[a-z]:[\\/]|\/|~[\\/])|\\|(?:^|[^a-z0-9])(?:sk|pk|rk)-[a-z0-9_-]{16,}|\bgh[pousr]_[a-z0-9]{20,}|\bakia[0-9a-z]{16}\b|\bxox[abprs]-|-----begin/i;

const CREDENTIAL = /(?:^|[^a-zA-Z0-9])(?:glpat-[a-zA-Z0-9_-]{20,}|hf_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{20,}|AIza[a-zA-Z0-9_-]{30,}|ASIA[0-9A-Z]{16}|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/;
const credentialOrPath = (value: string) => PRIVATE.test(value) || CREDENTIAL.test(value);
const privateValue = (value: string) => credentialOrPath(value) || /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]/i.test(value);

/** Validate the whole value before any export, including restored fallbacks. */
export function settingValue(value: unknown, kind: "model" | "effort"): string | null {
  if (typeof value !== "string" || credentialOrPath(value)) return null;
  if (kind === "effort") return /^(none|minimal|low|medium|high|xhigh|max|auto)$/.test(value) ? value : null;
  return value.length <= 160 && /^[a-z0-9][a-z0-9._:/-]*(?:\[[0-9]+[km]\])?$/i.test(value) ? value : null;
}

/** Text with nothing a terminal or a reader could act on: NFC, escape
 * sequences gone, line breaks and tabs made spaces, control, format (bidi,
 * zero-width) and lone surrogate characters gone, spacing made single, ends
 * trimmed. */
const plain = (s: string) => s.normalize("NFC")
  .replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[@-_]?)/g, "")
  .replace(/[\t\n\v\f\r\x85\u2028\u2029]/g, " ")
  .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
  .replace(/\s+/g, " ").trim();

/** A thread name as a notice may show it: plain, null when nothing is left
 * or it looks private (checked whole, so a cut can't split a secret past the
 * check), cut to 128 Unicode scalar values and 256 UTF-8 bytes. */
function label(s: string, issues: Set<ContextIssue>): string | null {
  const text = plain(s);
  const left = !text ? "missing-name" : privateValue(text) ? "private-label" : null;
  if (left) {
    issues.add(left);
    return null;
  }
  const size = (cps: string[]) => new TextEncoder().encode(cps.join("")).length;
  let cps = [...text];
  if (cps.length <= 128 && size(cps) <= 256) return text;
  issues.add("truncated-label");
  cps = cps.slice(0, 128);
  while (size(cps) > 256) cps.pop();
  return cps.join("").trim();
}

/** A context checked field by field, the same way when Loom copies one and
 * when replay reads one back, so checking a checked copy changes nothing and
 * a damaged journal line can't widen what goes out. A field of the wrong shape
 * is null with `invalid-context`; a title that isn't Loom's own is null with
 * `untrusted-title`. */
export function taskContext(raw: unknown): TaskContext {
  if (!raw || typeof raw !== "object") return { threadId: null, threadName: null, paneNumber: null, paneTitle: null, capturedAt: null, origin: "legacy", issues: ["invalid-context"] };
  const r = raw as Record<string, unknown>;
  const issues = new Set(Array.isArray(r.issues) ? r.issues.filter((i): i is ContextIssue => ISSUES.includes(i)) : []);
  const bad = () => (issues.add("invalid-context"), null);
  if (r.issues !== undefined && (!Array.isArray(r.issues) || r.issues.some((i) => !ISSUES.includes(i)))) bad();
  const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : bad());
  const threadId = r.threadId == null ? null : typeof r.threadId === "string" && /^[\x21-\x7e]{1,96}$/.test(r.threadId) && !privateValue(r.threadId) ? r.threadId : bad();
  const name = text(r.threadName);
  const threadName = name === null ? null : label(name, issues);
  const paneNumber = r.paneNumber == null ? null : typeof r.paneNumber !== "number" ? bad() : Number.isSafeInteger(r.paneNumber) && r.paneNumber > 0 ? r.paneNumber : (issues.add("missing-number"), null);
  const title = plain(text(r.paneTitle) ?? "");
  const paneTitle = !title ? null : Object.values(LOOM_TITLES).some((t) => t === title) ? title : (issues.add("untrusted-title"), null);
  // Date can show no time past 8.64e15 ms.
  const capturedAt = r.capturedAt == null ? null : typeof r.capturedAt === "number" && r.capturedAt >= 0 && r.capturedAt <= 8.64e15 ? r.capturedAt : bad();
  const origin = r.origin === "event" || r.origin === "last-known" || r.origin === "legacy" ? r.origin : (bad(), "legacy");
  return { threadId, threadName, paneNumber, paneTitle, capturedAt, origin, issues: [...issues] };
}

/** An event's context as `watch --notification-context` gives it: ten
 * fields, in this order. The pane id and the agent are the task's (`provider`
 * names the CLI family, not a model vendor); an event from before contexts
 * existed is `legacy`. */
export function contextRecord(t: Pick<Task, "pane" | "agent">, c?: TaskContext) {
  const agent = ["claude", "codex", "opencode", "shell"].includes(t.agent) ? t.agent : null;
  return {
    threadId: c?.threadId ?? null, threadName: c?.threadName ?? null, paneId: t.pane, paneNumber: c?.paneNumber ?? null, paneTitle: c?.paneTitle ?? null,
    agent, provider: agent, capturedAt: c?.capturedAt == null ? null : new Date(c.capturedAt).toISOString(), origin: c?.origin ?? "legacy", issues: c ? [...c.issues] : [],
  };
}

/** How much one `watch --notification-context` answer holds, well inside a
 * reader's own limits (the email bridge takes 1 MiB and 5000 events). */
export const CONTEXT_BATCH = { events: 1000, bytes: 512 * 1024 };
/** How many of `rows`, from the first, fit one answer as JSON lines: at
 * least one, so a reader always gets further. */
export function fitBatch(rows: unknown[], limit = CONTEXT_BATCH): number {
  let n = 0, bytes = 0;
  for (const r of rows) {
    bytes += new TextEncoder().encode(JSON.stringify(r)).length + 1;
    if (n && (n >= limit.events || bytes > limit.bytes)) break;
    n++;
  }
  return n;
}

/** What started a task: `loomctl submit`, an ordinary `loomctl send`, or a
 * person in Loom's window (typing in the pane, the Overview's reply box,
 * dictation). A task from before sources were kept was a submit. */
export type TaskSource = "submit" | "send" | "manual";

export type Task = {
  id: string;
  source?: TaskSource;
  /** The caller's --key, and a hash of the request it named, so a retry after Loom restarts still finds it. */
  key: string | null;
  what: string | null;
  pane: string;
  ref: string;
  agent: string;
  gen: number;
  /** SHA-256 and UTF-8 size of the text, for the caller. Never the text. */
  sha256: string;
  bytes: number;
  /** promptMatch(text): how the agents' reports name it. */
  match: string;
  /** What the input held when Loom typed: empty, suggestion or unknown. */
  input: string;
  state: TaskState;
  correlation: Correlation | null;
  /** What Loom can't tell about the task itself: its own Enter (`submit`) or
   * text (`type`) may not have gone in, its text may be waiting for an Enter
   * Loom held back (`enter`, main.ts heldEnter), or which of two tasks with
   * its text a turn was (`repeated-prompt`). Only proof clears `submit`
   * (changeFields). */
  uncertain: string | null;
  /** An answer to its question failed to write, so it may or may not have gone
   * in. Apart from `uncertain`: an answer going in says nothing about whether
   * the task's own Enter did. */
  answerInDoubt?: boolean;
  reason: string | null;
  detail: string | null;
  exit: number | null;
  acceptedAt: number;
  submittedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  events: TaskEvent[];
  /** When it became final, in event order: the oldest go first (pruneSettled). */
  settledAt?: number;
  /** Its latest copy of where it is (TaskContext), for an event that comes
   * once its pane has left its thread or relaunched. */
  context?: TaskContext;
};

/** What an agent reported, as helper.rs, the OpenCode plugin and the pane's
 * own OSC marks put it. `at` is when the agent reported it, in ms. `launch`
 * is the pane launch (Pane.generation) whose process reported it: a report
 * from a process that has since been replaced must not move the next one's
 * tasks. The pane's own marks come from its running launch. A turn's end or
 * Claude's Stop names its final message as `response` (TaskEvent). */
export type Signal = { at: number; launch?: number } & (
  | { kind: "start"; match?: string; token?: string }
  | { kind: "end"; matches?: string[]; turn?: string; token?: string; failed?: boolean | null; exit?: number | null; response?: string }
  | { kind: "stop"; response?: string }
  | { kind: "fail"; detail?: string }
  | { kind: "approval"; detail?: string }
  | { kind: "resume" }
  | { kind: "interrupt" }
);

/** `proof`: the change rests on evidence that names this task, the only
 * thing that may clear `uncertain: "submit"`: a shell's token, the task's own
 * id on the command line that ran. An agent's report names a prompt by its
 * text alone, never by the Enter that sent it, so it is never proof: an
 * earlier prompt of the same text whose report was written late (helper.rs
 * stamps the time it writes, not when the prompt went in) looks the same. */
export type Change = Partial<Pick<Task, "correlation" | "uncertain" | "answerInDoubt" | "reason" | "detail" | "exit" | "input">> & { state: TaskState; signal: string; proof?: true; response?: string };

/** The fields a change sets on a task, keeping one rule wherever the change
 * came from: a doubt about the task's own Enter clears only on proof it went
 * in. Not an answer to a question going in (that doubt is `answerInDoubt`),
 * not a report of its text, not a turn ending. */
export function changeFields(t: Task, c: Change): Partial<Task> {
  const { state: _state, signal: _signal, proof, response: _response, ...fields } = c;
  if (t.uncertain === "submit" && "uncertain" in fields && fields.uncertain !== "submit" && !proof) delete fields.uncertain;
  return fields;
}

/** An agent's mark for an attached image, or an image's path in quotes: either counts as spacing (promptMatch). */
const IMAGE_MARK = /\[Image #[0-9]+\]|"[A-Za-z]:[\\/][^"\r\n]*\.(?:png|jpe?g|gif|webp)"/gi;
/** A word that is an image's path. */
const IMAGE_PATH = /^[A-Za-z]:[\\/]\S*\.(?:png|jpe?g|gif|webp)$/i;
/** How Claude's and Codex's reports name a prompt, computed the same way in
 * helper.rs: FNV-1a 64 of the text's UTF-8, with every run of ASCII
 * whitespace made one space and the ends trimmed. Claude turns CRLF into LF
 * and a tab into four spaces, so the kind and amount of spacing can't count,
 * but where it falls does: "edit foo bar" isn't "edit foobar". A paste Claude
 * collapsed comes back wrapped in `<pasted_content id="8e95">` and
 * `</pasted_content id="8e95">` (four hex digits, Claude Code 2.1.287), so
 * those tags count as spacing. An image's path doesn't count, nor `[Image #N]`:
 * Claude Code 2.1.295 takes the path out of the prompt it reports and puts
 * `[Image #N]` in front, and it and Codex show a path pasted alone as one.
 * Not a digest to trust: texts that differ only in spacing share it. */
export function promptMatch(text: string): string {
  let h = 0xcbf29ce484222325n;
  const bare = text.replace(/<\/?pasted_content id="[0-9a-f]{4}">/g, " ").replace(IMAGE_MARK, " ")
    .split(/[\t\n\v\f\r ]+/).filter((w) => w && !IMAGE_PATH.test(w)).join(" ");
  for (const b of new TextEncoder().encode(bare)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

const started = (t: Task) => t.correlation === "prompt" || t.correlation === "sequence" || t.correlation === "token";

/** A task's Enter is in doubt (`uncertain: "submit"`) and an outcome comes
 * that only its text, or the agent's order, ties to it: the same text from a
 * submit Loom never tracked (`send`, typing in the window) reports the same,
 * so nothing proves the turn was this task's. It ends `unknown` instead.
 * A shell's token proves its line ran (and clears the doubt); Loom's own
 * record of the pane, its state or the Loom restarting say nothing about
 * whose turn it was. */
export function unproven(t: Task, c: Change): Change {
  if (t.uncertain !== "submit" || !isFinal(c.state) || ["token", "pane", "quiet", "restart", "loomctl"].includes(c.signal)) return c;
  return { state: "unknown", signal: c.signal, reason: "submit-uncertain", detail: "a turn with its text ended, but its own Enter may never have gone in" };
}

/** Which of a pane's open tasks (oldest first, all on the launch the signal
 * came from) a signal moves, and to what.
 *
 * Only its token names a task. Its text, or the agent's order, can point at
 * it only once Loom pressed its Enter (`submittedAt`) no later than the
 * report: anything reported before that was another prompt's, since the
 * agent had none of this one's to start or end. main.ts sets `submittedAt`
 * once that Enter's write has its outcome, and holds what comes meanwhile
 * (taskSignal), so the write's own result is on the task first.
 *
 * Where tasks share a prompt's text, those whose Enter surely went in come
 * first, oldest first, then those whose Enter is in doubt: the same text
 * from a later submit says nothing about whether the earlier Enter arrived.
 *
 * - start: the task its token names, or the first its text names, or for
 *   an agent that names neither (OpenCode), the oldest, each Entered before
 *   it. A start that names another prompt changes nothing: Claude reports a
 *   prompt sent mid-turn at once and then ends both in one turn (seen in
 *   Claude Code 2.1.287).
 * - end: the tasks it names. A shell names its token. Codex lists its turn's
 *   prompts: each one there completes one task with that text, Entered
 *   before the turn ended, so two tasks with one text need two mentions; one
 *   taken while another with its text waits is marked `uncertain:
 *   "repeated-prompt"` (unless it already says what's in doubt), since Loom
 *   picked it. With no names (OpenCode), every task the agent reported
 *   starting. Never one that only looked busy: the turn that ended may be
 *   the one before it.
 * - stop: Claude's Stop hook, for the tasks working. Another Stop hook may
 *   send Claude on working, so it ends nothing here: main.ts completes these
 *   tasks once Claude is also seen idle at its input (sweepTasks). A task
 *   asking for approval takes none: Claude doesn't stop while it asks, and
 *   the idle pause of a question would confirm it.
 * - fail, approval, resume, interrupt: the tasks working (or asking) now.
 *
 * A final outcome for a task whose Enter is in doubt goes through unproven. */
export function route(open: Task[], s: Signal): [Task, Change][] {
  const out: [Task, Change][] = [];
  const waiting = (t: Task) => t.state === "accepted" || t.state === "submitted";
  const active = (t: Task) => t.state === "working" || t.state === "approval";
  const entered = (t: Task) => t.submittedAt !== null && t.submittedAt <= s.at;
  const byDelivery = (ts: Task[]) => [...ts.filter((t) => t.uncertain !== "submit"), ...ts.filter((t) => t.uncertain === "submit")];
  const said = s.kind === "end" && s.response ? { response: s.response } : {};
  switch (s.kind) {
    case "start": {
      if (s.token) {
        const t = open.find((t) => t.id === s.token && (waiting(t) || t.correlation === "screen"));
        // The line ran: its Enter went in, whatever its write said.
        if (t) out.push([t, { state: "working", signal: "token", correlation: "token", ...(t.uncertain === "submit" ? { uncertain: null, proof: true as const } : {}) }]);
      } else if (s.match) {
        const t = byDelivery(open.filter((t) => t.match === s.match && entered(t) && (waiting(t) || (t.state === "working" && t.correlation === "screen"))))[0];
        if (t) out.push([t, { state: "working", signal: "prompt", correlation: "prompt" }]);
      } else {
        const t = open.find((t) => (waiting(t) || (t.state === "working" && t.correlation === "screen")) && entered(t));
        if (t) out.push([t, { state: "working", signal: "run", correlation: "sequence" }]);
      }
      break;
    }
    case "end": {
      if (s.token) {
        const t = open.find((t) => t.id === s.token);
        const failed = s.failed === true;
        const detail = s.exit === null || s.exit === undefined ? (failed ? "exit code unknown" : undefined) : `exit ${s.exit}`;
        if (t) out.push([t, { state: failed ? "failed" : "completed", signal: "token", correlation: "token", exit: s.exit ?? null, ...(detail ? { detail } : {}) }]);
      } else if (s.matches) {
        for (const m of new Set(s.matches)) {
          const mentions = s.matches.filter((x) => x === m).length;
          const candidates = byDelivery(open.filter((t) => t.match === m && entered(t)));
          const repeated = candidates.length > mentions;
          for (const t of candidates.slice(0, mentions)) {
            out.push([t, { state: "completed", signal: "prompt", correlation: "prompt", ...(repeated && !t.uncertain ? { uncertain: "repeated-prompt" } : {}), ...said }]);
          }
        }
      } else {
        for (const t of open) if (active(t) && started(t)) out.push([t, { state: "completed", signal: "turn-end", ...said }]);
      }
      break;
    }
    case "stop":
      for (const t of open) if (t.state === "working" && started(t)) out.push([t, { state: t.state, signal: "stop" }]);
      break;
    case "fail":
      for (const t of open) if (active(t) && started(t)) out.push([t, { state: "failed", signal: "turn-failed", ...(s.detail ? { detail: s.detail } : {}) }]);
      break;
    case "approval":
      for (const t of open) if (t.state === "working") out.push([t, { state: "approval", signal: "approval", ...(s.detail ? { detail: s.detail } : {}) }]);
      break;
    case "resume":
      for (const t of open) if (t.state === "approval") out.push([t, { state: "working", signal: "answered", detail: null, ...(t.answerInDoubt ? { answerInDoubt: false } : {}) }]);
      break;
    case "interrupt":
      for (const t of open) if (active(t) && started(t)) out.push([t, { state: "cancelled", signal: "interrupted", reason: "interrupted" }]);
      break;
  }
  return out.map(([t, c]) => [t, unproven(t, c)]);
}

/** One event the agents left for Loom (helper.rs, the OpenCode plugin),
 * checked; anything else is no signal. Each must name the launch that wrote
 * it (LOOM_LAUNCH), or it can't be told from a replaced process's. Tokens
 * come only from the pane's own OSC 133 marks, never from these files. */
export function parseSignal(ev: unknown): Signal | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (typeof e.launch !== "number" || !Number.isSafeInteger(e.launch)) return null;
  const at = typeof e.t === "number" && Number.isFinite(e.t) ? e.t : Date.now();
  const base = { at, launch: e.launch };
  const detail = typeof e.detail === "string" && e.detail ? { detail: e.detail.slice(0, 200) } : {};
  const response = typeof e.response === "string" && /^[0-9a-f]{16}$/.test(e.response) ? { response: e.response } : {};
  switch (e.kind) {
    case "start":
      return { ...base, kind: "start", ...(typeof e.match === "string" ? { match: e.match } : {}) };
    case "end":
      return {
        ...base, kind: "end",
        ...(Array.isArray(e.matches) ? { matches: e.matches.filter((m): m is string => typeof m === "string") } : {}),
        ...(typeof e.turn === "string" && e.turn ? { turn: e.turn } : {}),
        ...response,
      };
    case "fail":
    case "approval":
      return { ...base, kind: e.kind, ...detail };
    case "stop":
      return { ...base, kind: "stop", ...response };
    case "resume":
    case "interrupt":
      return { ...base, kind: e.kind };
  }
  return null;
}

/** Codex's OSC 9 notifications, by their text (codex-cli 0.159): an approval
 * or a question it waits on, or anything else (a turn's end, which its
 * `notify` reports with the prompts, so this one is left alone). */
export const codexAsks = (text: string) => /^(Approval requested|Codex wants to|Question:|Plan mode prompt:)/.test(text.trim());

/** The journal: one JSON line per record. `{seq, pruned}` carries the counter
 * and the highest event number pruned away, which the tasks kept can't show,
 * `{task}` a whole task as it stood, `{event, set}` one event and the task's
 * fields with it, `{update, set}` fields that changed with no new state. A
 * line cut short by a crash is skipped. */
export type JournalLine = { seq: number; pruned: number } | { task: Task } | { event: TaskEvent; set: Partial<Task> } | { update: string; set: Partial<Task> };

/** A task's fields that change after it's reserved, as each journal line carries them. */
export const taskFields = (t: Task): Partial<Task> => ({
  state: t.state, correlation: t.correlation, uncertain: t.uncertain, answerInDoubt: !!t.answerInDoubt, reason: t.reason, detail: t.detail, exit: t.exit,
  input: t.input, submittedAt: t.submittedAt, startedAt: t.startedAt, endedAt: t.endedAt, context: t.context,
});

export function readJournal(text: string): { tasks: Map<string, Task>; seq: number; pruned: number; notify: NotifySnapshot[] } {
  const tasks = new Map<string, Task>();
  const notify: NotifySnapshot[] = [];
  let seq = 0, pruned = 0;
  // A record of the wrong shape (a hand edit, another version) throws here, and
  // startup reads the journal as unavailable, never as a shorter history.
  const shaped = (t: Task, where: string) => {
    const ok = t && typeof t === "object" && typeof t.id === "string" && typeof t.pane === "string" && typeof t.state === "string"
      && Array.isArray(t.events) && t.events.every((e) => e && typeof e === "object" && typeof e.seq === "number");
    if (!ok) throw new Error(`a task record${where} isn't shaped as Loom writes them`);
  };
  for (const line of text.split("\n")) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec?.seq === "number") seq = Math.max(seq, rec.seq);
    if (typeof rec?.pruned === "number") pruned = Math.max(pruned, rec.pruned);
    // Every change is its own line, in the order made: changes between two
    // events share a number, so off, on, off again is three, never two.
    const n = rec?.notify as NotifySnapshot | undefined;
    if (n && typeof rec.at === "number" && typeof n.on === "boolean" && n.kinds && n.panes)
      notify.push({ at: rec.at, on: n.on, kinds: { ...DEFAULT_NOTIFY.kinds, ...n.kinds }, panes: { ...n.panes },
        ...(n.owners && typeof n.owners === "object" ? { owners: Object.fromEntries(Object.entries(n.owners).filter(([, v]) => v === "held" || v === "released" || v === "muted")) } : {}) });
    if (rec?.set !== undefined && (typeof rec.set !== "object" || rec.set === null || Array.isArray(rec.set))) throw new Error("a journal change isn't shaped as Loom writes them");
    // A field that is there is checked whatever it holds: skipped, its record would be gone.
    if (rec?.update !== undefined && typeof rec.update !== "string") throw new Error("a journal change isn't shaped as Loom writes them");
    const ev = rec?.event as TaskEvent | undefined;
    if (ev !== undefined && !(ev && typeof ev === "object" && typeof ev.task === "string")) throw new Error("a journal event isn't shaped as Loom writes them");
    if (rec?.task !== undefined) {
      const t = rec.task as Task;
      shaped(t, "");
      tasks.set(t.id, t);
      for (const e of t.events) seq = Math.max(seq, e.seq);
    }
    const updated = typeof rec?.update === "string" ? tasks.get(rec.update) : undefined;
    if (updated) (Object.assign(updated, rec.set), shaped(updated, ` changed by ${JSON.stringify(rec.update)}`));
    const e = rec?.event as TaskEvent | undefined;
    const t = e && tasks.get(e.task);
    if (e && t && !t.events.some((x) => x.seq === e.seq)) {
      if (typeof e.seq !== "number") throw new Error("a journal event has no number");
      Object.assign(t, rec.set);
      t.events.push(e);
      shaped(t, ` changed by event ${e.seq}`);
      seq = Math.max(seq, e.seq);
      if (isFinal(t.state) && t.settledAt === undefined) t.settledAt = e.seq;
    }
  }
  for (const t of tasks.values()) {
    if (t.context !== undefined) t.context = taskContext(t.context);
    for (const e of t.events) if (e.context !== undefined) e.context = taskContext(e.context);
  }
  return { tasks, seq, pruned, notify: notify.sort((a, b) => a.at - b.at) }; // stable: equal numbers keep their order
}

/** The journal rewritten as it stands: the counters, the notification policy's
 * history, then each task whole. */
export const writeJournal = (tasks: Iterable<Task>, seq: number, pruned: number, notify: NotifySnapshot[] = []) =>
  [{ seq, pruned }, ...notify.map(({ at, ...n }) => ({ notify: n, at })), ...[...tasks].map((task) => ({ task }))].map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Which notices a task's events stand for: finished, failed or blocked on a
 * question. Every other state is no notice at all. */
export type NotifyKind = "finish" | "fail" | "blocked";
export const NOTIFY_KINDS: readonly NotifyKind[] = ["finish", "fail", "blocked"];
export const notifyKind = (state: TaskState): NotifyKind | null =>
  state === "completed" ? "finish" : state === "failed" ? "fail" : state === "approval" ? "blocked" : null;

/** The notification policy from event `at` on (`at` is the last event number
 * before it changed): every pane on or off (`on`), each kind on or off, and
 * the panes that override `on` with their own on or off. A pane absent from
 * `panes` inherits. Loom journals one each time the policy changes. */
export type NotifySnapshot = { at: number; on: boolean; kinds: Record<NotifyKind, boolean>; panes: Record<string, "on" | "off">;
  /** Legacy owners without a proven pane identity. Presence marks migration complete. */
  owners?: Record<string, "held" | "released" | "muted"> };
/** Everything on: Loom's behavior before there was a policy. */
export const DEFAULT_NOTIFY: Omit<NotifySnapshot, "at"> = { on: true, kinds: { finish: true, fail: true, blocked: true }, panes: {} };
export const sameNotify = (a: Omit<NotifySnapshot, "at">, b: Omit<NotifySnapshot, "at">) =>
  a.on === b.on && NOTIFY_KINDS.every((k) => a.kinds[k] === b.kinds[k]) && JSON.stringify(Object.entries(a.panes).sort()) === JSON.stringify(Object.entries(b.panes).sort()) &&
  JSON.stringify(a.owners ? Object.entries(a.owners).sort() : null) === JSON.stringify(b.owners ? Object.entries(b.owners).sort() : null);

/** Whether `policy` lets `pane` send `kind`. The pane's own on or off wins
 * over every pane's; the kind applies either way. */
export const allows = (policy: Omit<NotifySnapshot, "at">, pane: string, kind: NotifyKind) =>
  (policy.panes[pane] ? policy.panes[pane] === "on" : policy.on) && policy.kinds[kind];

/** Pruning can omit an owner from newer snapshots while a watch still holds
 * its task. Only an explicit decision can change that owner's disposition. */
export function notifyOwner(pane: string, history: NotifySnapshot[]) {
  for (let i = history.length - 1; i >= 0; i--) {
    const decision = history[i].owners?.[pane];
    if (decision !== undefined) return decision;
  }
}

/** Whether an event may be sent on as a notice: its kind allowed by the
 * policy in force when it happened and by every policy since. So turning a
 * pane or kind off also stops its notices not sent yet, and turning it back
 * on brings none of them back: only events after that are sent. */
export function notifies(e: { seq: number; state: TaskState }, pane: string, history: NotifySnapshot[]): boolean {
  return notifyDisposition(e, pane, history) === "send";
}

/** v4 distinguishes a recoverable ownership hold from permanent suppression.
 * Historical policy mutes take precedence over a temporary ownership hold. */
export function notifyDisposition(e: { seq: number; state: TaskState }, pane: string, history: NotifySnapshot[]): "send" | "held" | "muted" | "none" {
  const kind = notifyKind(e.state);
  if (!kind) return "none";
  const owner = notifyOwner(pane, history);
  if (owner === "muted") return "muted";
  let from = history.length;
  while (from > 0 && history[from - 1].at >= e.seq) from--;
  // `from - 1` was in force when it happened (none: everything was on), and all from `from` came after.
  if (!history.slice(Math.max(from - 1, 0)).every((p) => allows(p, pane, kind))) return "muted";
  return owner === "held" ? "held" : "send";
}

/** The policy history a rewritten journal keeps: all that decide an event
 * from `oldest` on, the one in force at `oldest` included. */
export function keptNotify(history: NotifySnapshot[], oldest: number): NotifySnapshot[] {
  let from = history.length;
  while (from > 0 && history[from - 1].at >= oldest) from--;
  return history.slice(Math.max(from - 1, 0));
}

/** An Enter a person gave a pane in Loom's window, waiting for the agent's own
 * report to make it a task (main.ts manualEnter): when, on which launch, and
 * the prompt's match when Loom could read it, never the text. `uncertain`:
 * its write to the process failed, so it may have sent nothing, and a report
 * of the same text can't prove it did (its task gets `uncertain: "submit"`). */
export type ManualEnter = { at: number; launch: number; match: string | null; uncertain?: boolean };

/** Which pending manual Enter a report no task claimed belongs to, on the
 * same launch and not after the report: the one naming the same prompt, or
 * else the oldest unknown prompt within `window` ms of it. A known different
 * hash contradicts a named report. OpenCode's nameless reports keep their
 * separate sequence rule. */
export function claimManual(pending: ManualEnter[], at: number, launch: number, match: string | null, window: number): number {
  const mine = (m: ManualEnter) => m.launch === launch && m.at <= at;
  const named = match === null ? -1 : pending.findIndex((m) => mine(m) && m.match === match);
  return named >= 0 ? named : pending.findIndex((m) => mine(m) && (match === null || m.match === null) && at - m.at <= window);
}

/** Events after `after`, in order, from the tasks given. */
export const eventsAfter = (tasks: Iterable<Task>, after: number) =>
  [...tasks].flatMap((t) => t.events.filter((e) => e.seq > after)).sort((a, b) => a.seq - b.seq);

/** A task as loomctl shows it: times as ISO strings, events as they came. */
export function taskRecord(t: Task) {
  const at = (n: number | null) => (n ? new Date(n).toISOString() : null);
  return {
    task: t.id, source: t.source ?? "submit", state: t.state, final: isFinal(t.state), key: t.key,
    pane: t.pane, ref: t.ref, agent: t.agent, generation: t.gen,
    sha256: t.sha256, bytes: t.bytes, input: t.input,
    correlation: t.correlation, uncertain: t.uncertain, answerInDoubt: !!t.answerInDoubt, reason: t.reason, detail: t.detail, exit: t.exit,
    acceptedAt: at(t.acceptedAt), submittedAt: at(t.submittedAt), startedAt: at(t.startedAt), endedAt: at(t.endedAt),
    events: t.events.map(({ context: _context, ...e }) => ({ ...e, at: new Date(e.at).toISOString() })),
  };
}
