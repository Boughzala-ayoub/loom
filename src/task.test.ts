import settings from "./fixtures/settings-values.json" with { type: "json" };
// Self-check for loomctl's tasks. Run: node src/task.test.ts
import { allows, changeFields, claimManual, codexAsks, CONTEXT_BATCH, contextRecord, DEFAULT_NOTIFY, eventsAfter, fitBatch, isFinal, keptNotify, notifies, notifyDisposition, parseSignal, promptMatch, readJournal, route, taskContext, taskFields, taskRecord, writeJournal, type Change, type NotifySnapshot, type Signal, type Task, type TaskState } from "./task.ts";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  fails++;
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

let n = 0;
const task = (text: string, state: TaskState = "submitted", more: Partial<Task> = {}): Task => ({
  id: `t${++n}`, key: null, what: null, pane: "p1", ref: "a:1", agent: "claude", gen: 1, sha256: "", bytes: 0,
  match: promptMatch(text), input: "empty", state, correlation: null, uncertain: null, reason: null, detail: null, exit: null,
  acceptedAt: 1000, submittedAt: 2000, startedAt: null, endedAt: null, events: [], ...more,
});
/** Applies route's changes the way main.ts moveTask does: fields through changeFields, a final task never. */
function apply(open: Task[], s: Signal) {
  const moved = route(open.filter((t) => !isFinal(t.state)), s);
  for (const [t, c] of moved) Object.assign(t, changeFields(t, c as Change), { state: c.state });
  return moved.map(([t, c]) => [t.id, c.state]);
}
const at = 5000;

// What Claude Code 2.1.287 reported for a paste of this text (seen in a real
// session): CRLF became LF and the tab four spaces. helper.rs gives the same.
eq("Claude's rewrite of a paste still matches", promptMatch("Reply with exactly the word ALPHA.\nLine two  \n    line three with a tab"), promptMatch("Reply with exactly the word ALPHA.\r\nLine two  \r\n\tline three with a tab"));
eq("the value helper.rs must give too", promptMatch("Reply with exactly the word ALPHA.\r\nLine two  \r\n\tline three with a tab"), "45f3880110629eda");
eq("UTF-8, as helper.rs hashes it", promptMatch("héllo wörld ✓"), "4aee6004cebc55b9");
check("other words don't match", promptMatch("run the tests") !== promptMatch("run the test"));
// The review's collision: spacing that splits words counts, its kind and amount don't.
eq("edit foo bar isn't edit foobar", [promptMatch("edit foo bar"), promptMatch("edit foobar")], ["5614147f87873c08", "150936de3eb42a92"]);
eq("leading, trailing and doubled spacing don't count", promptMatch("  edit \t foo\r\n bar \n"), promptMatch("edit foo bar"));
eq("only ASCII spacing is trimmed, as helper.rs does", promptMatch(" x "), "9baab6eab24e743f");
// A paste Claude collapsed comes back wrapped in tags (Claude Code 2.1.287, seen live).
const sent41 = ["Reply with exactly the word LINES.", ...Array.from({ length: 40 }, (_, i) => `\tfiller line ${i}  `)].join("\r\n");
const hook41 = `\n\n<pasted_content id="8e95">\n${sent41.replace(/\r\n/g, "\n").replace(/\t/g, "    ")}\n</pasted_content id="8e95">\n`;
eq("a collapsed paste, as Claude reports it, still matches", promptMatch(hook41), promptMatch(sent41));
eq("the value helper.rs must give for it", promptMatch(sent41), "99f2aa029a84bdb5");
check("only Claude's own tag shape is dropped", promptMatch('<pasted_content id="zz">x') !== promptMatch("x"));

// Claude: its UserPromptSubmit names the prompt. Its Stop only says the turn
// stopped: another Stop hook may send Claude on working, so main.ts completes
// the task once Claude is also seen idle (review P1).
{
  const a = task("write the tests");
  eq("a start naming the task starts it", apply([a], { kind: "start", at, match: promptMatch("write the tests") }), [[a.id, "working"]]);
  eq("by the prompt", a.correlation, "prompt");
  const stop = route([a], { kind: "stop", at });
  eq("a Stop marks the task it ended, and finishes nothing", stop.map(([t, c]) => [t.id, c.state, c.signal]), [[a.id, "working", "stop"]]);
  eq("still working", a.state, "working");
  apply([a], { kind: "approval", at, detail: "Write" });
  eq("a Stop while the task asks marks nothing (follow-up F4)", route([a], { kind: "stop", at }), []);
}
{
  const a = task("task A"), b = task("task B");
  apply([a, b], { kind: "start", at, match: promptMatch("task A") });
  eq("another prompt starting changes nothing (Claude reports a mid-turn message at once)", apply([a, b], { kind: "start", at, match: promptMatch("something else") }), []);
  eq("B, submitted but not reported, isn't marked by A's Stop", route([a, b], { kind: "stop", at }).map(([t]) => t.id), [a.id]);
}
{
  // A message sent mid-turn: Claude reports both prompts, then one Stop ends both (seen live).
  const a = task("sleep 15"), b = task("then say QUEUED");
  apply([a, b], { kind: "start", at, match: promptMatch("sleep 15") });
  apply([a, b], { kind: "start", at, match: promptMatch("then say QUEUED") });
  eq("one Stop marks both prompts of a merged turn", route([a, b], { kind: "stop", at }).map(([t]) => t.id), [a.id, b.id]);
}
{
  const a = task("same"), b = task("same");
  eq("two tasks with one text start in order", apply([a, b], { kind: "start", at, match: promptMatch("same") }), [[a.id, "working"]]);
  eq("then the second", apply([a, b], { kind: "start", at, match: promptMatch("same") }), [[b.id, "working"]]);
  const later = task("same", "submitted", { acceptedAt: 4000, submittedAt: 6000 });
  eq("a prompt reported before the task's Enter isn't the task's", apply([later], { kind: "start", at, match: promptMatch("same") }), []);
}
{
  const a = task("looks busy", "working", { correlation: "screen" });
  eq("a Stop never marks a task only seen busy on screen", route([a], { kind: "stop", at }), []);
  eq("nor does an unnamed end", apply([a], { kind: "end", at }), []);
  eq("its own prompt report upgrades it", apply([a], { kind: "start", at, match: promptMatch("looks busy") }), [[a.id, "working"]]);
  eq("to prompt", a.correlation, "prompt");
}
{
  const a = task("ask first");
  apply([a], { kind: "start", at, match: promptMatch("ask first") });
  eq("a permission request asks", apply([a], { kind: "approval", at, detail: "Write" }), [[a.id, "approval"]]);
  eq("with the tool", a.detail, "Write");
  eq("answered, it works again", apply([a], { kind: "resume", at }), [[a.id, "working"]]);
  eq("StopFailure fails it", apply([a], { kind: "fail", at, detail: "rate_limit" }), [[a.id, "failed"]]);
  eq("with Claude's error", a.detail, "rate_limit");
  eq("a final task takes no more signals", apply([a], { kind: "end", at }), []);
}
{
  const a = task("not started");
  eq("approval needs a task working", apply([a], { kind: "approval", at }), []);
  eq("a failure needs a task started", apply([a], { kind: "fail", at }), []);
}

// Follow-up review F3: a later submit's report proves nothing about an earlier Enter in doubt.
{
  const a = task("retry same text", "submitted", { uncertain: "submit" }), b = task("retry same text");
  eq("Codex: one mention completes the task whose Enter surely went in", apply([a, b], { kind: "end", at, matches: [promptMatch("retry same text")] }), [[b.id, "completed"]]);
  eq("not the one in doubt", [a.state, a.uncertain], ["submitted", "submit"]);
  eq("and says it was picked", b.uncertain, "repeated-prompt");
  // Third review F1: a later mention may be a send or typing Loom never tracked, so it can't complete A.
  eq("a later mention ends the doubted one unknown, not completed", apply([a, b], { kind: "end", at, matches: [promptMatch("retry same text")] }), [[a.id, "unknown"]]);
  eq("saying why, and keeping what was in doubt", [a.reason, a.uncertain], ["submit-uncertain", "submit"]);
  const c = task("same again", "submitted", { uncertain: "submit" }), d = task("same again");
  eq("Claude: a start goes to the task whose Enter surely went in", apply([c, d], { kind: "start", at, match: promptMatch("same again") }), [[d.id, "working"]]);
  eq("alone, a doubted task still takes its own prompt's start", apply([c], { kind: "start", at, match: promptMatch("same again") }), [[c.id, "working"]]);
  // Fifth review: a start names the text, never the Enter that sent it, so it proves nothing.
  eq("but no start clears the doubt about its Enter", c.uncertain, "submit");
  eq("so its turn's end still can't complete it", apply([c], { kind: "end", at }), [[c.id, "unknown"]]);
}
{
  // Third review F1, around it: every outcome tied by text or order alone, for any agent.
  const doubted = (more: Partial<Task> = {}) => task("doubted", "working", { uncertain: "submit", correlation: "prompt", ...more });
  const a = doubted();
  eq("Claude's turn ending (here, OpenCode's unnamed end) can't complete it", apply([a], { kind: "end", at }), [[a.id, "unknown"]]);
  const b = doubted();
  eq("nor can a failure fail it", apply([b], { kind: "fail", at, detail: "rate_limit" }), [[b.id, "unknown"]]);
  const c = doubted({ agent: "opencode", correlation: "sequence" });
  eq("nor an interrupt cancel it", apply([c], { kind: "interrupt", at }), [[c.id, "unknown"]]);
  const d = task("npm test", "submitted", { agent: "shell", id: "00000000000000dd", uncertain: "submit" });
  eq("a shell's token proves its line ran", apply([d], { kind: "start", at, token: d.id }), [[d.id, "working"]]);
  eq("clearing the doubt", d.uncertain, null);
  eq("and its exit code is its own", apply([d], { kind: "end", at, token: d.id, failed: false, exit: 0 }), [[d.id, "completed"]]);
  const e = task("npm test", "working", { agent: "shell", id: "00000000000000ee", uncertain: "submit", correlation: "screen" });
  eq("even straight to its end", apply([e], { kind: "end", at, token: e.id, failed: true, exit: 2 }), [[e.id, "failed"]]);
}
{
  // Follow-up review F5: an answer delivered clears the doubt a failed one left.
  const a = task("answered later", "approval", { correlation: "prompt", answerInDoubt: true });
  eq("resume", apply([a], { kind: "resume", at }), [[a.id, "working"]]);
  eq("clears the answer's doubt", a.answerInDoubt, false);
  const b = task("enter in doubt", "approval", { correlation: "prompt", uncertain: "submit", answerInDoubt: true });
  apply([b], { kind: "resume", at });
  eq("but keeps a doubt about its own Enter (fourth review F2)", [b.uncertain, b.answerInDoubt], ["submit", false]);
  eq("so its turn ending still can't complete it", apply([b], { kind: "stop", at }).length + apply([b], { kind: "fail", at }).map(([, s]) => s).join(), "1unknown");
}
{
  // Fourth review F2, the rule itself: only proof clears a doubt about the task's own Enter.
  const t = task("doubted", "working", { uncertain: "submit" });
  eq("a change clearing it without proof leaves it", changeFields(t, { state: "working", signal: "answered", uncertain: null }), {});
  eq("nor can a change replace it", changeFields(t, { state: "working", signal: "x", uncertain: "answer" }), {});
  eq("proof clears it", changeFields(t, { state: "working", signal: "prompt", uncertain: null, proof: true }), { uncertain: null });
  eq("other fields still change", changeFields(t, { state: "working", signal: "prompt", correlation: "prompt", answerInDoubt: true }), { correlation: "prompt", answerInDoubt: true });
  const u = task("other doubt", "working", { uncertain: "repeated-prompt" });
  eq("other doubts aren't held this way", changeFields(u, { state: "working", signal: "x", uncertain: null }), { uncertain: null });
}

// Codex: its notify lists the turn's prompts; each mention completes one task.
{
  const a = task("fix lint"), b = task("write docs");
  eq("a turn naming another prompt completes nothing", apply([a, b], { kind: "end", at, matches: [promptMatch("other")] }), []);
  eq("the turn naming the prompt completes it, wherever it got to", apply([a, b], { kind: "end", at, matches: [promptMatch("fix   lint\n")] }), [[a.id, "completed"]]);
  eq("by the prompt", [a.correlation, a.uncertain], ["prompt", null]);
}
{
  // The review's case: one mention, two tasks with that text.
  const a = task("run tests"), b = task("run tests");
  eq("one mention completes one task, the oldest", apply([a, b], { kind: "end", at, matches: [promptMatch("run tests")] }), [[a.id, "completed"]]);
  eq("marked as picked by order", a.uncertain, "repeated-prompt");
  eq("the other waits for its own turn", b.state, "submitted");
  eq("which completes it", apply([a, b], { kind: "end", at, matches: [promptMatch("run tests")] }), [[b.id, "completed"]]);
  eq("with nothing left to confuse it with", b.uncertain, null);
  const c = task("go"), d = task("go");
  eq("two mentions complete both", apply([c, d], { kind: "end", at, matches: [promptMatch("go"), promptMatch("go")] }), [[c.id, "completed"], [d.id, "completed"]]);
  const e = task("go", "submitted", { acceptedAt: 4000, submittedAt: 9000 });
  eq("a turn that ended before the task's Enter isn't its", apply([e], { kind: "end", at, matches: [promptMatch("go")] }), []);
}
// A turn's end names its final message: each task it completes carries it, never another outcome.
{
  const said = promptMatch("Done."), a = task("go"), b = task("go"), w = task("other", "working", { correlation: "sequence" });
  eq("one Codex turn completing two tasks names its answer on both", route([a, b], { kind: "end", at, matches: [promptMatch("go"), promptMatch("go")], response: said }).map(([t, c]) => [t.id, c.state, c.response]), [[a.id, "completed", said], [b.id, "completed", said]]);
  eq("an unnamed end (OpenCode) names it too", route([w], { kind: "end", at, response: said }).map(([, c]) => c.response), [said]);
  const d = task("go", "submitted", { uncertain: "submit" });
  eq("an unproven end is unknown and names nothing", route([d], { kind: "end", at, matches: [promptMatch("go")], response: said }).map(([, c]) => [c.state, c.response]), [["unknown", undefined]]);
  eq("never a task field", changeFields(a, { state: "completed", signal: "prompt", response: said }), {});
  const f = task("fail", "working", { correlation: "prompt" });
  eq("a failure names none", route([f], { kind: "fail", at }).map(([, c]) => c.response), [undefined]);
}
// Sixth review: accepted, its paste or Enter still being written. Nothing the
// agent reports by text or order can be this task's yet (main.ts holds what
// comes while its Enter is written, and sets submittedAt once that has an outcome).
{
  const a = task("pending write", "accepted", { submittedAt: null });
  eq("an accepted task takes no start of its text", apply([a], { kind: "start", at, match: promptMatch("pending write") }), []);
  eq("nor a turn's end naming it (Codex)", apply([a], { kind: "end", at, matches: [promptMatch("pending write")] }), []);
  eq("nor an unnamed run (OpenCode)", apply([a], { kind: "start", at }), []);
  eq("so it's still accepted, its write's outcome to come", [a.state, a.uncertain], ["accepted", null]);
  const b = task("pending write", "accepted", { submittedAt: null }), other = task("pending write");
  eq("an earlier task of its text takes the turn instead", apply([b, other], { kind: "end", at, matches: [promptMatch("pending write")] }), [[other.id, "completed"]]);
  const sh = task("pending line", "accepted", { submittedAt: null, agent: "shell" });
  eq("its own token names it all the same", apply([sh], { kind: "start", at, token: sh.id }), [[sh.id, "working"]]);
}
eq("Codex's approval text", [codexAsks("Approval requested: rm -rf build"), codexAsks("Codex wants to edit 2 files"), codexAsks("Question: which?"), codexAsks("Agent turn complete")], [true, true, true, false]);

// OpenCode: no prompt named, so the first run reported after the Enter.
{
  const a = task("opencode task", "submitted", { agent: "opencode", submittedAt: 3000 });
  eq("a run that began before the Enter isn't this task's", apply([a], { kind: "start", at: 2500 }), []);
  eq("one after it is", apply([a], { kind: "start", at: 3500 }), [[a.id, "working"]]);
  eq("by sequence", a.correlation, "sequence");
  eq("interrupted is cancelled", apply([a], { kind: "interrupt", at }), [[a.id, "cancelled"]]);
  const b = task("opencode task 2", "working", { agent: "opencode", correlation: "sequence" });
  eq("its run succeeding completes it", apply([b], { kind: "end", at }), [[b.id, "completed"]]);
}

// Shell: the token on the command line, and its own exit code.
{
  const a = task("npm test", "submitted", { agent: "shell", id: "0123456789abcdef" });
  eq("another line's token starts nothing", apply([a], { kind: "start", at, token: "fedcba9876543210" }), []);
  eq("its own starts it", apply([a], { kind: "start", at, token: a.id }), [[a.id, "working"]]);
  eq("exit 5 fails it", apply([a], { kind: "end", at, token: a.id, failed: true, exit: 5 }), [[a.id, "failed"]]);
  eq("with the code", [a.exit, a.detail], [5, "exit 5"]);
  const b = task("ls", "working", { agent: "shell", id: "00000000000000bb" });
  apply([b], { kind: "end", at, token: b.id, failed: true, exit: null });
  eq("a failure whose code the prompt doesn't know", [b.state, b.exit, b.detail], ["failed", null, "exit code unknown"]);
}

// The files the agents leave are checked: each names its launch, and none carries a shell's token.
eq("a start", parseSignal({ kind: "start", t: 7, launch: 3, match: "abc" }), { at: 7, launch: 3, kind: "start", match: "abc" });
eq("no launch, no signal (review P1: a replaced process's report)", [parseSignal({ kind: "stop", t: 7 }), parseSignal({ kind: "stop", t: 7, launch: "3" })], [null, null]);
eq("a token in a file is ignored", parseSignal({ kind: "end", t: 7, launch: 3, token: "x", failed: false }), { at: 7, launch: 3, kind: "end" });
eq("Codex's prompts and turn", parseSignal({ kind: "end", t: 7, launch: 3, matches: ["a", 3, "b"], turn: "u1", thread: "th" }), { at: 7, launch: 3, kind: "end", matches: ["a", "b"], turn: "u1" });
eq("Claude's Stop", parseSignal({ kind: "stop", t: 7, launch: 3 }), { at: 7, launch: 3, kind: "stop" });
eq("Claude's Stop naming its final message", parseSignal({ kind: "stop", t: 7, launch: 3, response: "0123456789abcdef" }), { at: 7, launch: 3, kind: "stop", response: "0123456789abcdef" });
eq("a turn's end naming its final message", parseSignal({ kind: "end", t: 7, launch: 3, matches: ["a"], response: "0123456789abcdef" }), { at: 7, launch: 3, kind: "end", matches: ["a"], response: "0123456789abcdef" });
eq("a response that isn't a match is dropped, text above all", [parseSignal({ kind: "stop", t: 7, launch: 3, response: "the answer" }), parseSignal({ kind: "stop", t: 7, launch: 3, response: 5 })], [{ at: 7, launch: 3, kind: "stop" }, { at: 7, launch: 3, kind: "stop" }]);
eq("junk", [parseSignal(null), parseSignal("x"), parseSignal({ kind: "explode", launch: 1 })], [null, null, null]);

// The journal: tasks and their events come back as they were; a torn last line is skipped.
{
  const a = task("journaled", "completed", { events: [{ seq: 1, task: "j1", at: 1, state: "accepted", signal: "loomctl" }], id: "j1" });
  const b = task("open", "submitted", { id: "j2", events: [{ seq: 2, task: "j2", at: 2, state: "accepted", signal: "loomctl" }] });
  const text = writeJournal([a, b], 2, 0)
    + JSON.stringify({ event: { seq: 3, task: "j2", at: 3, state: "working", signal: "prompt" }, set: { state: "working", correlation: "prompt" } }) + "\n"
    + JSON.stringify({ event: { seq: 3, task: "j2", at: 3, state: "working", signal: "prompt" }, set: { state: "working" } }) + "\n"
    + '{"event":{"seq":4,"task":"j2"';
  const got = readJournal(text);
  eq("the counter is the highest event", got.seq, 3);
  eq("events applied once", got.tasks.get("j2")!.events.map((e) => e.seq), [2, 3]);
  eq("their fields too", [got.tasks.get("j2")!.state, got.tasks.get("j2")!.correlation], ["working", "prompt"]);
  eq("a counter line outlives pruned tasks", readJournal(writeJournal([], 41, 0)).seq, 41);
  eq("so does the highest event pruned (review P2)", readJournal(writeJournal([a], 1002, 2)).pruned, 2);
  eq("events in order across tasks", eventsAfter(got.tasks.values(), 1).map((e) => e.seq), [2, 3]);
}
{
  // Follow-up review F2: an append cut inside a UTF-8 character, as lib.rs reads it back (lossy: U+FFFD).
  const a = task("café", "completed", { id: "k1", key: "review-torn", events: [{ seq: 1, task: "k1", at: 1, state: "accepted", signal: "loomctl" }, { seq: 2, task: "k1", at: 2, state: "completed", signal: "turn-end" }] });
  const got = readJournal(writeJournal([a], 2, 0) + '{"event":{"seq":3,"task":"k1","detail":"caf\ufffd');
  eq("the task and its key survive a torn tail", [got.tasks.get("k1")?.key, got.tasks.get("k1")?.state, got.seq], ["review-torn", "completed", 2]);
}
{
  // Follow-up review F5: a field that changes with no new state is journaled as an update.
  const a = task("asks", "approval", { id: "u1", events: [{ seq: 1, task: "u1", at: 1, state: "accepted", signal: "loomctl" }] });
  const fresh = { ...a, events: [...a.events] };
  a.answerInDoubt = true;
  const got = readJournal(writeJournal([fresh], 1, 0) + JSON.stringify({ update: "u1", set: taskFields(a) }) + "\n");
  eq("an update line restores a same-state field", [got.tasks.get("u1")?.state, got.tasks.get("u1")?.answerInDoubt], ["approval", true]);
}

// The notification policy: a pane's own on or off wins over every pane's; the kinds apply to all.
{
  const snap = (at: number, more: Partial<NotifySnapshot> = {}): NotifySnapshot => ({ at, ...DEFAULT_NOTIFY, ...more, kinds: { ...DEFAULT_NOTIFY.kinds, ...more.kinds } });
  eq("by default every pane sends every kind", ["finish", "fail", "blocked"].map((k) => allows(DEFAULT_NOTIFY, "p1", k as "finish")), [true, true, true]);
  eq("a pane off, the rest on", [allows(snap(0, { panes: { p1: "off" } }), "p1", "finish"), allows(snap(0, { panes: { p1: "off" } }), "p2", "finish")], [false, true]);
  eq("every pane off, one on", [allows(snap(0, { on: false, panes: { p1: "on" } }), "p1", "finish"), allows(snap(0, { on: false, panes: { p1: "on" } }), "p2", "finish")], [true, false]);
  eq("a kind off applies to a pane that is on too", allows(snap(0, { panes: { p1: "on" }, kinds: { fail: false } as never }), "p1", "fail"), false);
  const done = (seq: number) => ({ seq, state: "completed" as TaskState });
  eq("with no history, an outcome goes out; other states never", [notifies(done(5), "p1", []), notifies({ seq: 5, state: "working" }, "p1", [])], [true, false]);
  eq("approval is a blocked notice, failed a fail", [notifies({ seq: 5, state: "approval" }, "p1", [snap(0, { kinds: { blocked: false } as never })]), notifies({ seq: 5, state: "failed" }, "p1", [snap(0, { kinds: { fail: false } as never })])], [false, false]);
  const off = [snap(10, { panes: { p1: "off" } })];
  eq("an event before the pane went off stays unsent (queued, not sent yet)", notifies(done(9), "p1", off), false);
  eq("an event while it is off", notifies(done(11), "p1", off), false);
  const back = [...off, snap(20)];
  eq("on again: what came while off, or before it, never goes out", [notifies(done(9), "p1", back), notifies(done(15), "p1", back)], [false, false]);
  eq("only what comes after", notifies(done(21), "p1", back), true);
  eq("other panes are untouched throughout", notifies(done(15), "p2", back), true);
  eq("two changes before any event: the last decides what follows", notifies(done(31), "p1", [snap(30, { panes: { p1: "off" } }), snap(30)]), true);
  eq("the history a rewrite keeps from event 15: the one in force then, and after", keptNotify(back, 15).map((s) => s.at), [10, 20]);
  eq("from event 25", keptNotify(back, 25).map((s) => s.at), [20]);
  const t = { id: "n1", events: [] } as unknown as Task;
  const text = writeJournal([t], 30, 0, back);
  const got = readJournal(text);
  eq("the journal keeps the history, in order", got.notify.map((s) => [s.at, s.panes]), [[10, { p1: "off" }], [20, {}]]);
  const twice = readJournal(text + text.split("\n")[1] + "\n").notify;
  eq("a line written twice is kept, and decides the same", [twice.length, notifies(done(9), "p1", twice), notifies(done(21), "p1", twice)], [3, false, true]);
  eq("a task's source; one from before sources were kept was a submit", [taskRecord({ ...task("x"), source: "manual" }).source, taskRecord(task("y")).source], ["manual", "submit"]);
}

// Review 2026-10-03 15:52 (P2): changes between two events share a number; replay keeps every one, in order.
{
  const snap = (at: number, off: boolean): NotifySnapshot => ({ at, ...DEFAULT_NOTIFY, panes: off ? { p1: "off" } : {} });
  const history = [snap(10, true), snap(10, false), snap(10, true), snap(11, false)];
  const e11 = { seq: 11, state: "completed" as TaskState };
  eq("muted under the last of three changes at one number", notifies(e11, "p1", history), false);
  const back = readJournal(writeJournal([], 11, 0, history)).notify;
  eq("all four changes come back, in order", back.map((s) => [s.at, s.panes.p1 ?? "inherit"]), [[10, "off"], [10, "inherit"], [10, "off"], [11, "inherit"]]);
  eq("and the event stays held back after replay", notifies(e11, "p1", back), false);
  eq("a line read twice is still one change each time: replay is the file, line by line", readJournal(writeJournal([], 11, 0, history)).notify.length, 4);
}

// Legacy ownership holds are separate from policy mutes: review can release
// an identity hold, but never a policy mute that already applied to the event.
{
  const event = { seq: 5, state: "completed" as TaskState };
  const held: NotifySnapshot = { at: 10, ...DEFAULT_NOTIFY, owners: { old: "held" } };
  const released: NotifySnapshot = { ...held, owners: { old: "released" } };
  eq("an unresolved owner is held", notifies(event, "old", [held]), false);
  eq("another owner is independent", notifies(event, "other", [held]), true);
  eq("an explicit release lifts only the ownership hold", notifies(event, "old", [held, released]), true);
  const muted: NotifySnapshot = { ...held, panes: { old: "off" } };
  eq("release never undoes an earlier policy mute", notifies(event, "old", [muted, released]), false);
  eq("an explicit owner mute stays suppressed", notifies(event, "old", [{ ...held, owners: { old: "muted" } }]), false);
  const replay = readJournal(writeJournal([], 10, 0, [held, released])).notify;
  eq("owner decisions survive compaction and replay", replay.map((n) => n.owners), [{ old: "held" }, { old: "released" }]);
  eq("the replayed release still permits the event", notifies(event, "old", replay), true);
  eq("v4 distinguishes a recoverable hold", notifyDisposition(event, "old", [held]), "held");
  eq("v4 preserves the hold after a filtered snapshot", notifyDisposition(event, "old", [held, { ...held, owners: {} }]), "held");
  eq("v4 releases an explicitly reviewed owner", notifyDisposition(event, "old", [held, released]), "send");
  eq("a historical mute wins even while the owner is held", notifyDisposition(event, "old", [muted]), "muted");
  eq("release never revives a historical mute in v4", notifyDisposition(event, "old", [muted, released]), "muted");
  eq("an explicit owner mute is permanent in v4", notifyDisposition(event, "old", [{ ...held, owners: { old: "muted" } }]), "muted");
  eq("non-notices have no pending disposition", notifyDisposition({ seq: 5, state: "working" }, "old", [held]), "none");
}

// A person's Enter waits for the agent's report of its turn (main.ts manualEnter, adoptManual).
{
  const m = (at: number, match: string | null, launch = 1) => ({ at, launch, match });
  eq("the Enter naming the reported prompt, whenever it was", claimManual([m(100, "aa"), m(200, "bb")], 5000, 1, "bb", 10_000), 1);
  eq("else the oldest within the window", claimManual([m(100, null), m(200, null)], 300, 1, "cc", 10_000), 0);
  eq("a known different prompt never falls back by time", claimManual([m(100, "aa")], 300, 1, "bb", 10_000), -1);
  eq("nor with Codex's unlimited window", claimManual([m(100, "aa")], 300, 1, "bb", Infinity), -1);
  eq("an unknown marker after a known mismatch can still claim the report", claimManual([m(100, "aa"), m(200, null)], 300, 1, "bb", 10_000), 1);
  eq("an unread one past the window takes nothing", claimManual([m(100, null)], 20_000, 1, "cc", 10_000), -1);
  eq("never one after the report", claimManual([m(500, "aa")], 400, 1, "aa", 10_000), -1);
  eq("never another launch's", claimManual([m(100, "aa", 1)], 200, 2, "aa", 10_000), -1);
  eq("a report naming nothing (OpenCode) takes the oldest of its launch", claimManual([m(100, null, 2), m(150, null, 3)], 9_999_999, 3, null, Infinity), 1);
}

// Notification context (docs/turn-tracking-and-notifications.md): what Loom
// copies of a task's thread and pane, the labels it lets out, and replay.
{
  const live = { threadId: "mabc1200-14", threadName: "Loom notification work", paneNumber: 2, paneTitle: "Agent session", capturedAt: 1000, origin: "event" };
  for (const threadId of ["C:\\private\\customer-repo", "/private/customer-repo", "secret=customer-key", "ghp_abcdefghijklmnopqrstuvwxyz0123"]) {
    const t = task("private optional context", "completed", { events: [{ seq: 3, task: "t1", at: 3, state: "completed", signal: "end", context: { ...live, threadId, origin: "event", issues: [] } }] });
    const replay = readJournal(writeJournal([t], 3, 0)).tasks.get(t.id)!;
    const c = contextRecord(replay, replay.events[0].context);
    eq("replay strips a private thread ID without losing the event", [replay.events[0].seq, c.threadId, c.threadName, c.issues], [3, null, live.threadName, ["invalid-context"]]);
  }
  eq("a clean copy keeps every field", taskContext(live), { ...live, issues: [] });
  const name = (threadName: unknown) => { const c = taskContext({ ...live, threadName }); return [c.threadName, c.issues]; };
  eq("escapes, controls, bidi and zero-width characters go, spacing becomes one space", name("\x1b]0;title\x07Fix\tthe\r\nbug\u202e\u200b  now\x1b[31m!\x1b[0m"), ["Fix the bug now!", []]);
  eq("a decomposed accent is normalized", name("cafe\u0301"), ["café", []]);
  eq("a lone surrogate goes", name("a\ud800b"), ["ab", []]);
  eq("a branch-like name stays", name("loom/notification-work"), ["loom/notification-work", []]);
  for (const p of ["C:\\Users\\ayoub\\work", "\\\\server\\share", "/home/ayoub/work", "~/work", "work\\sub"]) eq(`a path-like name is private: ${p}`, name(p), [null, ["private-label"]]);
  for (const s of ["deploy sk-abcdefghijklmnopqrstuv", "ghp_abcdefghijklmnopqrstuvwxyz0123", "AKIAABCDEFGHIJKLMNOP", "password=hunter2", "-----BEGIN PRIVATE KEY-----"]) eq(`a secret-like name is private: ${s}`, name(s), [null, ["private-label"]]);
  eq("nothing left is a missing name", name("\x1b[0m \t\u200b"), [null, ["missing-name"]]);
  eq("a number is no name", name(42), [null, ["invalid-context"]]);
  const long = taskContext({ ...live, threadName: "é".repeat(200) });
  eq("cut to 128 scalar values", [[...long.threadName!].length, new TextEncoder().encode(long.threadName!).length, long.issues], [128, 256, ["truncated-label"]]);
  const wide = taskContext({ ...live, threadName: "😀".repeat(100) }).threadName!;
  eq("and to 256 UTF-8 bytes, at a code point", [[...wide].length, new TextEncoder().encode(wide).length], [64, 256]);
  eq("a secret is caught before the cut could split it", name(`${"x ".repeat(60)}sk-abcdefghijklmnopqrstuv`), [null, ["private-label"]]);
  const title = (paneTitle: unknown) => { const c = taskContext({ ...live, paneTitle }); return [c.paneTitle, c.issues]; };
  eq("Loom's own titles go out", [title("Terminal")[0], title("Agent session")[0]], ["Terminal", "Agent session"]);
  eq("a title the process set never does", title("✳ Fix the parser in C:\\work"), [null, ["untrusted-title"]]);
  eq("an empty title is just none", title(""), [null, []]);
  const number = (paneNumber: unknown) => { const c = taskContext({ ...live, paneNumber }); return [c.paneNumber, c.issues]; };
  eq("a pane out of its thread has no number", number(0), [null, ["missing-number"]]);
  eq("nor a fraction", number(1.5), [null, ["missing-number"]]);
  eq("a string is no number", number("2"), [null, ["invalid-context"]]);
  eq("an id is printable ASCII, at most 96 characters", [taskContext({ ...live, threadId: "x".repeat(97) }).threadId, taskContext({ ...live, threadId: "thréad" }).issues], [null, ["invalid-context"]]);
  eq("a time Date can't show is none", taskContext({ ...live, capturedAt: 1e20 }).capturedAt, null);
  eq("a damaged copy keeps nothing", taskContext("oops"), { threadId: null, threadName: null, paneNumber: null, paneTitle: null, capturedAt: null, origin: "legacy", issues: ["invalid-context"] });
  eq("unknown origins and issue codes go", taskContext({ ...live, origin: "guess", issues: ["truncated-label", "rm -rf", "truncated-label"] }), { ...live, origin: "legacy", issues: ["truncated-label", "invalid-context"] });
  for (const raw of [live, { ...live, threadName: "é".repeat(200), paneTitle: "secret", paneNumber: 0 }, "oops"]) eq("checking a checked copy again changes nothing", taskContext(taskContext(raw)), taskContext(raw));

  eq("exported with the task's pane and agent, ten fields in order", contextRecord({ pane: "mabc1234-27", agent: "codex" }, taskContext(live)),
    { threadId: "mabc1200-14", threadName: "Loom notification work", paneId: "mabc1234-27", paneNumber: 2, paneTitle: "Agent session", agent: "codex", provider: "codex", capturedAt: "1970-01-01T00:00:01.000Z", origin: "event", issues: [] });
  eq("an event from before contexts is legacy, its pane and agent still known", contextRecord({ pane: "p1", agent: "claude" }),
    { threadId: null, threadName: null, paneId: "p1", paneNumber: null, paneTitle: null, agent: "claude", provider: "claude", capturedAt: null, origin: "legacy", issues: [] });
  eq("an agent Loom doesn't know is none", [contextRecord({ pane: "p1", agent: "vim" }).agent, contextRecord({ pane: "p1", agent: "vim" }).provider], [null, null]);
  const worst = JSON.stringify(contextRecord({ pane: "p".repeat(96), agent: "opencode" }, taskContext({ threadId: "t".repeat(96), threadName: '"'.repeat(300), paneNumber: 16, paneTitle: "Agent session", capturedAt: 8.64e15, origin: "last-known",
    issues: ["missing-name", "missing-number", "private-label", "truncated-label", "untrusted-title", "invalid-context"] })));
  check("the worst case fits the 2048-byte context budget", new TextEncoder().encode(worst).length <= 2048, `${new TextEncoder().encode(worst).length} bytes`);

  const first = taskContext(live), second = taskContext({ ...live, threadName: "renamed", paneNumber: 1, capturedAt: 2000 });
  const t = task("with context", "working", { id: "c1", context: first, events: [{ seq: 1, task: "c1", at: 1, state: "accepted", signal: "loomctl", context: first }] });
  const reserved = writeJournal([t], 1, 0);
  t.context = second;
  t.state = "completed";
  t.events.push({ seq: 2, task: "c1", at: 2, state: "completed", signal: "turn-end", context: second });
  const appended = readJournal(reserved + JSON.stringify({ event: t.events[1], set: taskFields(t) }) + "\n").tasks.get("c1")!;
  eq("an appended event keeps its copy, and the task its latest", [appended.events.map((e) => e.context), appended.context], [[first, second], second]);
  const compacted = readJournal(writeJournal([appended], 2, 0)).tasks.get("c1")!;
  eq("a whole rewrite keeps every copy as it was", [compacted.events.map((e) => e.context), compacted.context], [[first, second], second]);
  eq("an old line has none", readJournal(writeJournal([task("old", "completed", { id: "o1", events: [{ seq: 1, task: "o1", at: 1, state: "completed", signal: "turn-end" }] })], 1, 0)).tasks.get("o1")!.events[0].context, undefined);
  const damaged = readJournal(reserved + JSON.stringify({ event: { seq: 2, task: "c1", at: 2, state: "completed", signal: "turn-end", context: { threadName: 5, paneNumber: -1, paneTitle: "secret title", capturedAt: "soon", origin: "event", issues: [] } }, set: { state: "completed" } }) + "\n").tasks.get("c1")!;
  eq("a damaged copy is checked on replay, and its event kept", [damaged.state, damaged.events[1].context], ["completed", { threadId: null, threadName: null, paneNumber: null, paneTitle: null, capturedAt: null, origin: "event", issues: ["invalid-context", "missing-number", "untrusted-title"] }]);
  eq("loomctl task shows no context", taskRecord(t).events.map((e) => "context" in e), [false, false]);
}

// watch --notification-context answers in bounded parts (fitBatch): rows as JSON lines.
{
  const rows = (n: number, bytes: number) => Array.from({ length: n }, () => ({ pad: "x".repeat(bytes - 10) })); // {"pad":""} is 10 bytes
  eq("the limits are the documented ones", CONTEXT_BATCH, { events: 1000, bytes: 524288 });
  eq("nothing to send is none", fitBatch([]), 0);
  eq("small events stop at 1000", fitBatch(rows(3000, 50)), 1000);
  eq("1 KiB lines fill 512 KiB exactly", fitBatch(rows(2000, 1023)), 512);
  eq("one byte more and the 512th stays out", fitBatch(rows(2000, 1024)), 511);
  eq("an event bigger than the limit still goes, alone", fitBatch(rows(3, 600_000)), 1);
  eq("other limits", fitBatch(rows(10, 10), { events: 3, bytes: 1000 }), 3);
}

for (const value of settings.private) {
  const raw = { threadId: value, threadName: value, paneNumber: 1, paneTitle: "Agent session", capturedAt: 1, origin: "event", issues: [] };
  const context = taskContext(raw);
  check("N2 capture removes recognized credentials from labels and IDs", context.threadId === null && context.threadName === null);
  const t = task("synthetic", "completed", { context: raw as Task["context"], events: [{ seq: 1, task: "t", state: "completed", at: 1, signal: "turn-end", context: raw as Task["context"] }] });
  const journal = writeJournal([t], 1, 0);
  const replay = [...readJournal(journal).tasks.values()][0];
  check("N2 replay and enriched watch projection preserve redaction", !JSON.stringify(contextRecord(replay, replay.events[0].context)).includes(value));
}

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
