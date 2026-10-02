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
 * the last one it saw and never sees one twice. */
export type TaskEvent = { seq: number; task: string; at: number; state: TaskState; signal: string; detail?: string };

export type Task = {
  id: string;
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
   * text (`type`) may not have gone in, or which of two tasks with its text
   * a turn was (`repeated-prompt`). Only proof clears `submit` (changeFields). */
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
};

/** What an agent reported, as helper.rs, the OpenCode plugin and the pane's
 * own OSC marks put it. `at` is when the agent reported it, in ms. `launch`
 * is the pane launch (Pane.generation) whose process reported it: a report
 * from a process that has since been replaced must not move the next one's
 * tasks. The pane's own marks come from its running launch. */
export type Signal = { at: number; launch?: number } & (
  | { kind: "start"; match?: string; token?: string }
  | { kind: "end"; matches?: string[]; turn?: string; token?: string; failed?: boolean | null; exit?: number | null }
  | { kind: "stop" }
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
export type Change = Partial<Pick<Task, "correlation" | "uncertain" | "answerInDoubt" | "reason" | "detail" | "exit" | "input">> & { state: TaskState; signal: string; proof?: true };

/** The fields a change sets on a task, keeping one rule wherever the change
 * came from: a doubt about the task's own Enter clears only on proof it went
 * in. Not an answer to a question going in (that doubt is `answerInDoubt`),
 * not a report of its text, not a turn ending. */
export function changeFields(t: Task, c: Change): Partial<Task> {
  const { state: _state, signal: _signal, proof, ...fields } = c;
  if (t.uncertain === "submit" && "uncertain" in fields && fields.uncertain !== "submit" && !proof) delete fields.uncertain;
  return fields;
}

/** How Claude's and Codex's reports name a prompt, computed the same way in
 * helper.rs: FNV-1a 64 of the text's UTF-8, with every run of ASCII
 * whitespace made one space and the ends trimmed. Claude turns CRLF into LF
 * and a tab into four spaces, so the kind and amount of spacing can't count,
 * but where it falls does: "edit foo bar" isn't "edit foobar". A paste Claude
 * collapsed comes back wrapped in `<pasted_content id="8e95">` and
 * `</pasted_content id="8e95">` (four hex digits, Claude Code 2.1.287), so
 * those tags count as spacing. Not a digest to trust: texts that differ only
 * in spacing share it. */
export function promptMatch(text: string): string {
  let h = 0xcbf29ce484222325n;
  const bare = text.replace(/<\/?pasted_content id="[0-9a-f]{4}">/g, " ").replace(/[\t\n\v\f\r ]+/g, " ").replace(/^ | $/g, "");
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
            out.push([t, { state: "completed", signal: "prompt", correlation: "prompt", ...(repeated && !t.uncertain ? { uncertain: "repeated-prompt" } : {}) }]);
          }
        }
      } else {
        for (const t of open) if (active(t) && started(t)) out.push([t, { state: "completed", signal: "turn-end" }]);
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
      for (const t of open) if (t.state === "approval") out.push([t, { state: "working", signal: "answered", ...(t.answerInDoubt ? { answerInDoubt: false } : {}) }]);
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
  switch (e.kind) {
    case "start":
      return { ...base, kind: "start", ...(typeof e.match === "string" ? { match: e.match } : {}) };
    case "end":
      return {
        ...base, kind: "end",
        ...(Array.isArray(e.matches) ? { matches: e.matches.filter((m): m is string => typeof m === "string") } : {}),
        ...(typeof e.turn === "string" && e.turn ? { turn: e.turn } : {}),
      };
    case "fail":
    case "approval":
      return { ...base, kind: e.kind, ...detail };
    case "stop":
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
  input: t.input, submittedAt: t.submittedAt, startedAt: t.startedAt, endedAt: t.endedAt,
});

export function readJournal(text: string): { tasks: Map<string, Task>; seq: number; pruned: number } {
  const tasks = new Map<string, Task>();
  let seq = 0, pruned = 0;
  for (const line of text.split("\n")) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec?.seq === "number") seq = Math.max(seq, rec.seq);
    if (typeof rec?.pruned === "number") pruned = Math.max(pruned, rec.pruned);
    if (rec?.task && typeof rec.task === "object") {
      const t = rec.task as Task;
      tasks.set(t.id, t);
      for (const e of t.events) seq = Math.max(seq, e.seq);
    }
    const updated = typeof rec?.update === "string" ? tasks.get(rec.update) : undefined;
    if (updated) Object.assign(updated, rec.set);
    const e = rec?.event as TaskEvent | undefined;
    const t = e && tasks.get(e.task);
    if (e && t && !t.events.some((x) => x.seq === e.seq)) {
      Object.assign(t, rec.set);
      t.events.push(e);
      seq = Math.max(seq, e.seq);
      if (isFinal(t.state) && t.settledAt === undefined) t.settledAt = e.seq;
    }
  }
  return { tasks, seq, pruned };
}

/** The journal rewritten as it stands: the counters, then each task whole. */
export const writeJournal = (tasks: Iterable<Task>, seq: number, pruned: number) =>
  [{ seq, pruned }, ...[...tasks].map((task) => ({ task }))].map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Events after `after`, in order, from the tasks given. */
export const eventsAfter = (tasks: Iterable<Task>, after: number) =>
  [...tasks].flatMap((t) => t.events.filter((e) => e.seq > after)).sort((a, b) => a.seq - b.seq);

/** A task as loomctl shows it: times as ISO strings, events as they came. */
export function taskRecord(t: Task) {
  const at = (n: number | null) => (n ? new Date(n).toISOString() : null);
  return {
    task: t.id, state: t.state, final: isFinal(t.state), key: t.key,
    pane: t.pane, ref: t.ref, agent: t.agent, generation: t.gen,
    sha256: t.sha256, bytes: t.bytes, input: t.input,
    correlation: t.correlation, uncertain: t.uncertain, answerInDoubt: !!t.answerInDoubt, reason: t.reason, detail: t.detail, exit: t.exit,
    acceptedAt: at(t.acceptedAt), submittedAt: at(t.submittedAt), startedAt: at(t.startedAt), endedAt: at(t.endedAt),
    events: t.events.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
  };
}
