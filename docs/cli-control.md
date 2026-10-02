# Controlling Loom from a terminal

Status: implemented on `loom/go`, 2026-09-30. `README.md` has the everyday
commands; this page covers how it works and why it was built this way.

The goal: everything you can do in Loom's window, done from a terminal, a
script or an agent in a pane, with the result showing in the running window.

## How it works

```
loomctl.exe ──named pipe──> loom.exe (control.rs) ──"cli" event──> page (main.ts)
            <── one JSON line ──                  <── cli_reply ──
```

1. `loomctl` connects to Loom's control pipe and says hello with its protocol
   number (`PROTOCOL` in `pipe.rs`). `control.rs` answers with its own, its
   version, its process id and its own pipe, without involving the page.
   Either side refuses a different protocol before any command is sent. This
   matters after an update, which replaces `loomctl.exe` while the old Loom
   may still be running: the first protocol sent `args` and this one `argv`,
   and each read the other's request as "no arguments", so `close <pane>`
   closed the pane in front. The first Loom has no hello: it answers it as an
   unknown command, having run nothing, and `loomctl` stops there.
   `loomctl info` prints the hello and stops.
2. `loomctl <command> [args]` reads only its own options (`--json`,
   `--profile`, `--timeout`) and sends the command, its other words untouched,
   standard input if an argument is `-`, and the terminal's folder as one JSON
   request. Only the page knows which of a command's options are on/off flags,
   so it parses them (`parseArgs` in `cli.ts`, with each command's option
   list): a flag never swallows the pane name after it, and an unknown option
   is an error. Standard input goes in place of `-` only after that, so text
   starting with `--` is never read as options.
3. `control.rs` in `loom.exe` checks the request has a command and a list of
   words, hands it to the page as a `cli` event and waits for the page's
   `cli_reply`, up to the request's own timeout.
4. The page runs the command in `main.ts`'s loomctl section, with the same
   functions the buttons call: `createThread`, `revealPane`, `sendReply`,
   `choose`, `closePane`, `toggleDashboard` and the rest. That's why the window
   shows every change: nothing takes a separate path around the UI.
5. The answer goes back as `{ ok, data, text }`, or `{ ok: false, error }`
   with `timeout`, `typed` or `pressed` when they apply. `loomctl` prints
   `text`, or `data` as JSON with `--json`. Under `--json` every failure,
   whether Loom or `loomctl` found it, prints one object with a stable `code`
   (`usage`, `not-running`, `busy`, `unreachable`, `version`, `connection`,
   `timeout`, `failed`) and `sent`: whether the command reached Loom, so a
   script knows when it may have run. The message goes to stderr as well.
   `sent` is `false` only before any of the command went out. Loom runs a
   request only if its line arrived whole, newline included (`request` in
   `control.rs`): `read_line` also returns what came before a dropped
   connection, and a valid JSON command cut off there used to run. A real
   pipe test showed it: a `close` sent without its newline, then the
   connection ended, closed the pane. Even so, a write that fails partway
   reports `sent: true`, since `loomctl` can't prove how much arrived.

Loom's threads, panes and their states live in the page, not in Rust, so the
page is the only place that can answer "which panes are waiting" or run
"switch to this thread". Rust only carries the request.

## Decisions

**A separate console program.** `loom.exe` is a GUI-subsystem program. PowerShell
and cmd don't wait for those, so output would land after the next prompt and
the exit code would be lost. `loomctl.exe` is a 230 KB console binary in the same
Cargo package (`src/bin/loomctl.rs`), with no Tauri in it. The same Cargo run
builds it, and it ships beside `loom.exe` through the installer hook and
`npm run update`. `Cargo.toml` sets `default-run = "loom"`, because with two
binaries Tauri otherwise bundled `loomctl` as the app.

Rejected:
- **`loom.exe --cli` with `AttachConsole`.** It works from bash and from batch
  files, which wait, but not from an interactive PowerShell or cmd prompt.
- **The single-instance plugin's argument forwarding.** It carries the command
  line one way and can't return an answer, so `read`, `panes` and `wait` would be
  impossible.
- **A local HTTP or WebSocket server.** Any web page can reach localhost ports,
  so it would need tokens and Origin checks. A named pipe with an explicit ACL
  is simpler and narrower.
- **`loom.com` beside `loom.exe`**, the `devenv.com` trick that lets `loom`
  resolve to the console binary. Git Bash doesn't append `.com`, and agents run
  commands through bash.

**One pipe per workspace.** The name is `\\.\pipe\loom-<user>`, plus a hash of
the profile path for profile launches (`pipe.rs`, shared by both programs).
Loom creates it with `first_pipe_instance`, so a second Loom on the same
workspace can't take it over, and a command never reaches the wrong window.
Debug builds use `loom-dev-<user>`, the way they keep their own data folder,
so `tauri dev` beside the installed app doesn't answer for it.

**Only your account.** The pipe's security descriptor grants your user SID and
SYSTEM and nobody else. The default descriptor for pipes also gives everyone
read access. Remote clients are refused. Anyone who can open the pipe can make
Loom start processes as you, so this is the boundary that matters.

**Panes find their own Loom.** Every Loom also serves a pipe named after its
process (`\\.\pipe\loom-<user>-pid<pid>`), and every pane gets that name as
`LOOM_PIPE`, with Loom's folder at the front of its `PATH`. `loomctl` in a pane
reaches the Loom that owns that pane with no setup, even when another Loom holds
the workspace's pipe. This is what lets an agent orchestrate other agents: read their
screens, answer their questions, start more and wait for them.

**Confirmations become `--yes`.** Where a button asks first, the command refuses
without `--yes` instead of opening a dialog a script can't click. Deleting a
worktree also runs the dialog's own check, for changed, untracked and ignored
files and for commits only on the branch, and refuses to lose any that
`--discard` doesn't name (`--force` names them all). `close-plan` shows the
same check without closing anything, and `--plan` refuses if it changed since.

**Waiting is a command.** `wait` and `wait-any` block until a pane reaches a
state. The page polls the state every 200 ms, because a state changes in a
dozen places. It answers with a timeout flag when time runs out, and `loomctl`
exits 3 for that. Waits get an hour by default and other commands 30 seconds.
A timeout ends the waiting, not the command: a `new` still running Git carries
on, so a script checks `threads` before trying again. `loomctl` gives up on its
own 20 seconds after that, in case Loom stops answering altogether. Its clock
starts before the hello, which gets 10 seconds or `--timeout`, whichever is
shorter: a Loom that takes the connection and never answers ends in exit 3 with
`sent: false`, and no command reaches it.

**Commands can overlap.** Each request runs as it arrives, so two terminals can
act on one pane or thread at once. Text sent to a pane takes turns, one `send`
or `choose` after another, so two sends arrive as two commands. A thread closes
once: a second close is told it is already closed. Each start of a pane has a
number that `stop`, a restart and closing the pane all move on, so a start
that was still waiting for its session check or startup slot gives up, and a
process that came up anyway is killed. `stop` also cancels a start on a pane
that is dead but restarting, instead of answering "already exited". `new`
answers with the thread it made, and a failed start or Git removal comes back
as an error, not "done".

**Input belongs to a session.** A `send`, `keys` or `choose` records the
pane's start number (`generation` in `panes`) when it is queued, or takes the
one the caller saw with `--gen`, and checks it again before each write. If the
pane stopped or restarted in between, the command fails and nothing reaches
the new session. A `keys` cut short that way says how many keys went in
(`pressed`) instead of "nothing was sent": an Enter among them may have run a
command already.

**Shell outcomes.** Loom's PowerShell prompt reports each finished command
(OSC 133 `D;<code>`). `panes --json` shows the count since the pane started
(`commands`; the startup command is the first), whether the last `failed`,
its `exit` code, and `lastOutput`, when the pane last drew. PowerShell leaves
`$LASTEXITCODE` alone after a cmdlet, so when it hasn't moved the prompt can't
tell a failing cmdlet from a native command exiting with the same code as the
last one. It used to report 1 there, which was fine for a red dot but not for
a script; now it sends `D;1;exact=0` and `exit` is `null`, with `failed` still
true.

**Agent turns.** Loom already hears when an agent finishes or stops to ask:
Claude's bell and its Stop/Notification hooks, Codex's OSC 9, OpenCode's
OSC 99. That is what raises the attention dot (`Pane.wake`). `turns` counts
those signals, but only after input written since the last counted one
(`lastIn > lastTurnAt`). Claude's idle reminder comes a minute later with no
new input, so it doesn't count. A single turn often signals twice, though:
Claude's bell at once and its Stop hook a marker poll (250 ms) and a
PowerShell start later; OpenCode's plugin and its OSC 99. The input rule alone
let the second one count when the caller had sent its next task in between,
which finished that task's receipt with nothing done. So every signal carries
its source (`WakeSource`), and the first source to count a turn in a launch
is the only one that counts turns until the pane restarts (`turnSource`). The
others still raise the alert. `wait --turn-after N` waits for the next one. This
replaces the screen-quiet guess (Claude reads as idle after 1.5 s of no
output) as the way to know an agent is done. It still says nothing about
whether the work succeeded.

**Receipts.** `send --receipt` returns a token, and `wait --receipt` waits for
the outcome it names. In a shell, the token goes on the command line as a
PowerShell comment, `# loom-receipt:<token>`. The prompt's OSC 133 `E` mark
carries the line that runs, and `Pane.mark` pairs the token in an `E` with
the `D` after it. Commands run one at a time at the prompt, so that pairing
is exact even when other writers use the pane. Only the comment at the very
end of the `E` line counts, so a command that merely prints marker-like text
doesn't hide its own receipt. A result counts only from the pane and launch
the receipt was sent to (`finishReceipt`), so a token copied into another
pane, or a restarted pane reusing it, can't answer for it. The shell has to
be at its prompt (`B` seen since the last line break typed into it;
`atPrompt` in `panes`), otherwise the line would go to whatever is running.
That is checked in the pane's input turn, right before the paste, and any
Enter typed into the shell spends the prompt at once (`usePrompt`), because
the `E` and `C` marks only arrive a moment later. So a receipt queued behind
a command waits up to 5 s for the next `B`, or gives up with nothing typed.
The first version checked before queueing, so a receipt queued behind a
command that started a program typed into that program. In an agent pane,
the token stands for the first turn after the Enter, recorded when that
launch's turn signal arrives (`turnReceipts`), with `asking` if a numbered
question is on screen. The first version compared the live turn count
instead, and after a restart reset it, the new launch's turns could complete
an old receipt. An agent may answer two queued prompts in one turn, so two
callers on one agent aren't told apart; a receipt there means "my prompt went
in and a turn came back". A receipt ends in an error if the pane restarts,
exits or closes before its outcome; one with an outcome keeps it. Receipts
live in memory: the last 500 settled (an outcome, or a pane that restarted,
exited or closed), however many are pending, and up to 2000 pending, past
which `send --receipt` refuses. `pruneSettled` in `cli.ts` keeps both this
store and the `--key` cache. It counts only settled entries against the
limit, and evicts in the order they settled. Each settling takes a number
from one counter (`settlings`), and a receipt cut off by its pane counts as
settling when that is first noticed. The first version counted every entry,
so pending ones pushed out the finished outcomes a late wait or a retry
still needed. The next one evicted in creation order, so a request that
started first and finished last, the newest result, went the moment it
finished, before its own answer was back.

**Retries with `--key`.** `loomctl --key NAME` sends a caller's name for the
request. The page keeps a map from key to the command and the promise of its
answer (`keyed` in `main.ts`). A retry with the same key and the same
command, cwd and stdin awaits that promise instead of running again, even if
the first is still running. A retry with the same key and a different command
is refused. The answer comes back with `replayed`, and `loomctl` says so on
stderr. Only finished keys are evicted, beyond the last 256 finished ones,
pruned whenever a request finishes; a running one stays, since evicting it
would let its retry run a second time, as the first version did under 256
newer keys. With 1024 keyed commands running, new ones
are refused unrun. Keys live in memory, so they don't survive a restart of
Loom. The key is why `PROTOCOL` went to 3: a protocol-2 Loom answered the
same hello and dropped `key` without a word, so a retry against it ran twice.
Now the hello refuses it before any command.

**Tasks.** `submit` is one guarded call where a caller used to need three
(`panes`, `read --json`, `send --receipt --input`), and it answers with a task
id. It runs `send`'s own path (`sendText` in `main.ts`) with a receipt whose
token is the task's id, and adds two refusals: a numbered question on an
agent's screen, and a draft in Claude's input. The states and the rules that
move them are pure (`task.ts`, run under node by `task.test.ts`); `main.ts`
feeds in signals and pane facts and keeps the record.

Before anything is typed, the task is written to a journal beside the state
file (`workspaces.tasks.jsonl`), and the send waits for that write
(`reserveTask`). A crash after the Enter then still leaves the task and its
`--key` on disk, so a retry gets the task back instead of typing the prompt a
second time; the first version queued the write and answered without it, and
the review reproduced exactly that duplicate. The wait runs inside the pane's
input turn, before `sendReply`'s last synchronous checks (generation, input
counter, `--input`, draft), so input arriving while the disk writes still
stops the send. A journal that refuses the write stops it with nothing typed.
A later write that fails marks the task `saved: false` and makes the next
write rewrite the journal whole, which puts it back. That rewrite also
carries the reservation that triggered it: the task being reserved has no
events yet, so the whole-journal snapshot alone left it out (the follow-up
review's duplicate after a reload). Every line carries the task's mutable
fields as they stand, and a change with no new state (an answer's write in
doubt, `answerInDoubt`) is an `{update, set}` line of its own, so `saved: true` means the
file has all of it. A whole rewrite records how many journal calls it had
seen; one queued before it writes nothing more (but a reservation), since
the snapshot holds its change already. Without that, an older `{update}`
queued behind the snapshot overwrote the newer state on replay: a failed
task read back as working, then `unknown` after a restart.

`lib.rs` reads the journal lossily: an append cut off inside a UTF-8
character used to make the whole file unreadable as text, and the read gave
back an empty journal, forgetting every key. Now only that torn line is
lost. A read that fails outright is an error, not an empty journal:
`submit` refuses, and nothing rewrites the file.

`watch` shows only events whose lines are on disk (`writtenSeq`): appends
land in event order, and one runs only once every write before it landed (a
failed one turns the next into a whole rewrite), so a landed write makes
every event before it durable. After a restart numbering goes on from the
journal, so no number a watcher saw comes twice. An earlier version added a
fixed 1000 to the journal's counter instead, and a backlog of 1001 unwritten
events reused a number a watcher had seen.

Receipts take the first turn after the Enter as the outcome, which is wrong for
a task: that turn may be one that was already running. The 2026-10-01 review
reproduced a receipt whose Enter never went in, acknowledged by a later turn
that had nothing to do with it. A task finishes only on a signal tied to it,
and the provider has to send it:

- Claude Code (2.1.287 checked): Loom's own settings file, which every Claude
  pane already loads with `--settings`, adds UserPromptSubmit, Stop,
  StopFailure and PermissionRequest hooks. Each runs `loom.exe --claude-hook`
  (`helper.rs`), which writes one event file to `%TEMP%\loom-task` and prints
  nothing: a UserPromptSubmit hook's output joins the prompt, and exit 2
  blocks it. The prompt hook sends a hash of the prompt, never the text, and
  runs in step, so its report is on disk before the turn it starts can end.
  It was async at first, and a fast turn's Stop report could land before it,
  leaving the task to end `unknown`. Stop and StopFailure run async; the
  helper takes about 50 ms.
- Claude's Stop is not proof the turn ended: Loom's hooks run beside your own,
  and one of yours can tell Claude to keep working. So a Stop only marks the
  tasks it concerns, and the sweep completes a `working` one once Claude is
  seen idle at its input: no "esc to interrupt", Claude's input line on
  screen as `readInput` reads it, and no numbered question. A permission
  dialog, numbered or not, takes the input's place and shows no hint either,
  so a dialog whose report never arrived can't confirm a Stop. A permission request
  after the Stop clears it: Claude went on. A task asking takes no Stop at
  all, since Claude doesn't stop while it asks. If Claude works on, the next
  Stop, an Esc or a failure decides.
- Codex (0.159.3 checked): the `notify` program Loom already runs after each
  turn gets `input-messages`, the turn's prompts, and the turn's and thread's
  ids. Only a root conversation's turn counts (internal agents inherit
  `notify`), and a turn id is counted once. Each mention of a prompt
  completes one task with that text, Entered before the turn ended: first
  one whose Enter surely went in, then one whose Enter is in doubt, oldest
  first in each. If more tasks with that text are open than the turn
  mentioned, the one taken says `uncertain: "repeated-prompt"`, unless it
  already says what's in doubt. Claude's prompt reports pick the same way.
  A task whose Enter is in doubt never ends `completed`, `failed` or
  `cancelled` on its text alone (`unproven` in `task.ts`): a later `send` or
  typing of the same text, which no task tracks, reports the same. It ends
  `unknown`, reason `submit-uncertain`. Only a change marked `proof` clears
  that doubt (`changeFields`), and only a shell's receipt token is proof: it
  is the task's own id on the line that ran. An agent's start names the
  text, not the Enter. Earlier versions took a start as proof when the
  agent was idle at the Enter, the start came after it and no input went in
  since. The fifth review broke that with an earlier untracked prompt of
  the same text: its busy screen hadn't drawn yet, and its hook wrote the
  start after the task's failed Enter (helper.rs stamps `t` when it writes,
  not when the prompt went in). It passed all three tests and the task was
  saved `completed`. The page can't tell that start from one for the
  doubted Enter, so no start counts. The cost: an agent task whose Enter
  went in although its write reported a failure ends `unknown`, never
  `completed`. An answer to a question going in is its own doubt,
  `answerInDoubt`; when it shared the field, a failed then delivered answer
  erased the Enter's doubt and let the task complete. Codex's OSC 9 text says
  when it asks ("Approval requested: ...", "Codex wants to edit ...").
  Nothing reports a start.
- OpenCode: the plugin reports each run's start and its outcome (2.x's
  `session.execution.*`, 1.x's status changes), and an approval or question,
  resuming only when none is left unanswered. It names no prompt, so the
  first run that starts after the Enter is the task's.
- A shell: the receipt comment already pairs a command line with its own exit
  code (OSC 133 `E` and `D`). A line that never starts ends `unknown` after
  30 s.

Every process a pane starts gets `LOOM_LAUNCH`, the pane's launch number
(`Pane.generation`), and every report carries it. A report goes only to that
launch's tasks, and a report without one is dropped. Draining at a pane's
exit was not enough: an async hook of the old process can still write after
the new one started, and its Stop completed the new launch's task.

A report can be a task's only if Loom pressed the task's Enter no later than
the report's time (`submittedAt`, when that Enter's write began; `entered`
in `route`). Before that the agent had none of the task's prompt, so what it
reported was another prompt's. While the Enter's write is out, `taskSignal`
holds every report for the pane (`enterHeld`). `sendText` replays them in
order once the write's outcome is on the task: `submitted` if it went in,
`uncertain: "submit"` if it failed. The sixth review found the gap this
closes. A task stayed `accepted`, with nothing in doubt, until its write came
back, and `route` took any report stamped after the task was accepted. An
earlier untracked prompt of the same text that finished while Loom was still
pasting or pressing Enter completed the task. The write's failure then found
it final, `moveTask` dropped the change, and the false `completed` came back
after a restart and on a keyed retry. A shell's token settles its task
whenever it arrives, since it names the task.

The hold covers the pane's older tasks too, so the sweep judges none of them
while it lasts: a held report may overtake what the sweep saw before. The
seventh review found what happened without that. An older Claude task had a
Stop that came while Claude still looked busy. Its StopFailure or
PermissionRequest then arrived during a newer task's Enter and was held.
Claude went idle, and the sweep completed the task from the old Stop. The
held report found it final on replay, and `completed` stayed through a
restart and a keyed retry. Now `sweepTasks` skips every task on a pane with
a hold, and drops the idle time it saw before (`quietSince`), so a quiet
spell counts only time it watched. A pane exiting waits as well, so a
failure the task reported first still decides it. A write returns once the
process reads its input or the pane is killed. One that reads none leaves
the pane's tasks open until then, or `unknown` after Loom restarts.

Rust drains `%TEMP%\loom-task` on the 250 ms tick that already drains the wake
markers, and at a pane's exit, and sends them as `agent-events`. Each file is
written beside and renamed in, and named `<pane>.<µs>.<pid>`, so the drain
never reads half of one and a pane's events arrive in the order they were
written. A token can only come from the pane's own OSC marks, never from a
file.

What the probes found decides the other rules. Claude reports a prompt sent
mid-turn the moment it's sent, then ends both with one Stop, so a start that
names another prompt changes nothing and a Stop marks every prompt Claude
reported starting. Esc fires no hook at all, mid-tool or on a permission
dialog, and no idle notification came within 75 s. So Loom records when an
Esc or Ctrl-C write went into a pane (`Pane.wrote`), and the sweep
(`sweepTasks`, every 500 ms while a task is open) cancels a task if, 2 s
later, nothing ended it and the agent's "esc to interrupt" hint is gone.
Approval answers aren't reported either: an Enter or one-key answer that went
in puts an asking task back to `working`, and one whose write failed leaves
it asking with `answerInDoubt: true`; arrow keys and pastes answer nothing.
The hint also moves a Codex task to `working` (`correlation: "screen"`), and
an agent idle for 30 s with nothing reported ends `unknown`, never
`completed`. Claude rewrites a paste (CRLF to LF, a tab to four spaces) and
wraps a collapsed one in `<pasted_content id="...">` tags, so the hash makes
each run of ASCII spacing one space and those tags spacing, in TypeScript and
Rust alike, and tests on both sides pin the same values. The first version
took the spacing out altogether, so "edit foo bar" matched "edit foobar".

Every state change is an event with a number (`seq`) shared by all tasks.
`watch --after N` long-polls for the events after N, and `watch --follow` in
`loomctl` repeats it, printing each once and reconnecting every second when
Loom goes away; with `--json`, a failure that ends it is one more line with
`next`, so every line parses alone. The journal holds one line per task as
it was reserved and one per event after, through `task_journal_write` in
`lib.rs`, appended in order. At start Loom reads it back, marks open tasks
`unknown` (their processes ended with the last Loom), keeps the last 500
finished, and rewrites it; past 5000 lines it rewrites it too. Its first line
carries the event counter and the highest event pruned away, so `watch` can
still report a `gap` after the tasks that showed it are gone. The journal is
what lets a `--key` retry, a task id and a watcher's number outlive a
restart. It holds hashes, never text.

**Enter only once the text shows.** `send` pastes, then presses Enter only if
the text appeared, so Enter never picks a menu option by accident. It counts
the start of the text, its end (the start of a long task scrolls off), and the
placeholders Claude and Codex draw instead of a long paste: `[Pasted text #1
+120 lines]` and `[Pasted Content 5000 chars]`, checked in a real Claude pane.
When none shows, the text may still be sitting in the input, so the failure
carries `typed: true` and says not to send it again.

**Menus have ids.** `menu` prints the whole prompt as drawn: from the divider
above it (or the top of the screen) through the last option's wrapped text and
description, up to a blank line or the next divider. Its id is a hash of all
of that with only the highlight glyph taken out. An earlier id covered the
question's last four lines and each option's first line, so a path under an
option or a command higher up could change and keep the id. `choose` compares
the id before every arrow key and Enter, so neither a "Delete the project?"
under the same Yes/No nor `rm -rf src` where `rm -rf build` was gets answered,
and `choose --menu <id>` refuses any question but the one the caller read.
Anything on screen outside those bounds, such as a status line below a blank
line, stays out, so a clock there can't block an answer.

**Ids last as long as Loom does.** Pane and thread ids aren't saved; after a
restart, use names or `<thread>:<n>`.

**Help comes from the running Loom.** `loomctl help` lists the command table in
`main.ts`, so it always matches the Loom you are talking to.

## Commands

| Group | Commands |
| --- | --- |
| Reading | `status`, `threads`, `panes`, `read`, `menu`, `receipt`, `task`, `tasks` |
| Moving around | `show`, `next`, `overview`, `changes`, `layout`, `zoom`, `window` |
| Threads and panes | `new`, `add`, `rename`, `close`, `close-thread`, `restart`, `stop` |
| Input | `send`, `submit`, `keys`, `choose` |
| Waiting | `wait` (for a state, `--turn-after N`, `--receipt R` or `--task ID`), `wait-any`, `watch` |
| Settings | `theme`, `set` |

## A bug found on the way

`pty_kill` takes a session out of Loom's map before killing it, so no
`pty-exit` event follows. That suited closing a pane, which was its first use,
but the Overview's Stop reused it. A stopped pane stayed marked as running, never
offered "Enter relaunches", and typing into it failed. The UI tests missed it
because their mock emits `pty-exit` on every kill. `Pane.stop()` now marks the
exit itself, and the Overview's Stop and `loomctl stop` and `restart` all use it.

## Verification

- `scripts/cli-check.mjs` drives the real app through `loomctl` on a temporary
  profile and two temporary Git folders. It checks each command's answer and,
  over CDP, what the window shows: pane counts, the thread in front, the layout
  button, zoom, the theme's colors and the Overview. It also runs `loomctl` from
  inside a pane, and checks the exit codes for an unknown command, a bad pane,
  a timeout and a missing Loom. It also replays the cases from the CLI review:
  `close --yes alpha:2`, `LOOM_PIPE` ending in `-pid<pid>`, two sends and two
  `new`s at once, two deletes of one worktree at once, `new .` from a folder
  with a space, `--json` for a null answer, and `--panes 1.5` leaving no branch.
  From the agent-control review: `info`, a request in the first protocol's
  shape refused with the panes untouched, this `loomctl` against a fake first
  Loom stopping after the hello, standard input starting with `--` typed and
  run, and a `--json` failure printed as JSON. From the second agent review:
  fake Looms that give an old greeting, take the hello and never answer
  (exit 3 within seconds, `sent: false`, only the hello heard), or drop the
  connection after the command (`connection`, `sent: true`); a bad option, a
  missing Loom, a Loom-side timeout and a failed command, each as one JSON
  object; a real PowerShell pane reporting `exit 7`; and `--gen` refused
  after a restart. From the third: the same pane running `exit 7` twice, a
  failing cmdlet and `exit 0` (7, then unknown, unknown, 0), and a `close`
  written to the real pipe without its newline before the connection ends,
  which must leave the pane open. Then a real `add` twice with one `--key`
  (one pane, the second answer replayed, the key refused for `status`), and
  a receipt from a real PowerShell prompt reporting `exit 4`, and a
  protocol-2 Loom refused at the hello before a keyed `send` reaches it.
- `ui-check.mjs` stops a pane while its session check is held open and checks
  it never starts, then fails a restart with a refused `pty_spawn`. It holds a
  write to queue a send, restarts the pane and checks the send is refused with
  nothing typed; stops a dead Codex pane while its restart checks the saved
  session and checks nothing spawns; changes a question under the same
  options before a queued `choose` and checks no Enter; and sends a 120-line
  task that scrolls, one that collapses to a placeholder, and one that never
  shows (`typed: true`, pasted once, no Enter). Then it changes only the path
  under an option (a queued `choose` and a stale `--menu` both refused, no
  Enter), restarts a pane between the two keys of `keys enter x` (`pressed: 1`,
  no `x`), refuses `--gen` for an old launch, and reads an exit code from an
  OSC 133 mark. Then `--key` (a replayed `add`, a refused reuse, two sends at
  once with one key typing once), turns (a bell with no input since the last
  turn doesn't count, a bell plus a Stop hook for one turn counts once,
  `wait --turn-after` returns), an agent receipt that ends on a question, and
  a shell receipt that reports its own `exit 5` though a later command exits
  9. From the review of those: a running key that survives 256 newer keys
  and types once; an agent receipt finished before a restart that keeps its
  turn, and one cut off by a restart that fails though the new launch
  finishes a turn; a receipt queued behind a command whose marks come 300 ms
  late, typed only after it finished; one queued behind a send that starts a
  program, refused with nothing typed; a command printing marker-like text
  that still completes its receipt; and another pane's command carrying the
  token that can't complete it. Each of these fails on the frontend from
  before the fix. From the next review: a finished key that still replays
  while 256 keyed sends are held running on another pane, and an agent task
  B that a late second signal for task A doesn't finish, with the bell first
  and then with the hook first; both fail on the frontend before that fix.
  Then the key held while 256 newer keys finish, released last, and retried:
  it replays, typed once, and fails on the frontend before settle-order
  eviction. `node src/cli.test.ts` covers `pruneSettled`, which both stores
  use, including a request that started first and finished last and entries
  that settle out of order. The receipt store's version of that case is
  covered there, not in the harness: it needs 500 receipts at about 150 ms
  each.
- `cargo test` covers the pipe names, `loomctl`'s own options, the hello check,
  the failure shape and the whole-line rule for requests.
  `src-tauri/src/shell-init.test.ps1` (run it with `powershell -NoProfile
  -File`) covers the prompt's exit marks, repeats included. `node src/cli.test.ts` covers pane references, key
  names, option parsing and folders relative to the terminal, and
  `node src/prompt.test.ts` the echo check and menu ids, including a changed
  path under an option and a changed command above four identical lines.
- Tasks. `node src/task.test.ts` covers the routing rules (a prompt start,
  a merged Claude turn, a turn naming another prompt, a task only seen on
  screen, approvals, failures, Codex's turn list, OpenCode's order, shell
  tokens), the prompt hash against what Claude reported live for a reformatted
  and a collapsed paste, and the journal read back with a torn last line.
  `cargo test` checks the hook payloads become those events, that the hash in
  `helper.rs` gives the same values, Codex's real notify payload, and that the
  drain takes each event once, in order, never half-written.
  `scripts/task-check.mjs` drives the built page over Tauri's mocks with fake
  agents that only send what a real one would: submit, wait and watch;
  unrelated prompts and turns that must not finish a task; a `--key` retry;
  a stale `--gen`, a restart and a close; an approval answered; Claude's
  failure and a shell's exit 5; an Esc that stops the agent and one it
  ignores; a draft and a question refused unwritten; Codex by screen, OSC 9
  and its turn list; an Enter in doubt and one held back; 30 s idle ending
  `unknown`; and a reload that brings the journal back. The 2026-10-02
  review's findings each have a case: a journal write held (nothing typed
  until it lands) or refused (nothing typed, no task), a crash between the
  Enter and its record (the retry types nothing), a replaced launch's late
  Stop, a Stop Claude works on past, a repeated Codex prompt and a replayed
  turn, a failed or navigating answer to an approval, and the pruned-event
  mark across two restarts. The follow-up review's have one each too: a
  whole-journal rewrite after a failed write (the new task and key survive a
  reload), a torn tail (the task, its key and the numbering survive) and an
  unreadable journal (submit refuses, the file stays), a failed Enter then
  the same text again (the later task completes, the doubted one stays
  open), a blocked Stop then a question, reported or only on screen (still
  asking), and a failed answer's doubt across a reload. The third review's
  too: an untracked `send` of a doubted task's text, on Codex and Claude
  (unknown, never completed), a start after a lost Enter reply with nothing
  typed since (once proof; it now keeps the doubt and ends unknown), an
  unreported unnumbered dialog after a Stop (still
  working), writes queued behind a whole rewrite in one batch (the journal
  replays to `failed`), and 1100 events while the journal stalls, then a
  restart (none shown, no number reused). The fourth review's too: typing
  through the window while a failed Enter's write hung, a start while the
  agent was busy at the Enter and one stamped before it (each keeps the
  doubt), and a failed then delivered answer on a task whose Enter failed
  (both doubts kept apart; unknown, never completed). The fifth review's
  too: an earlier untracked prompt of the same text, idle on screen, whose
  start arrives after the task's failed Enter. One case stamps the report on
  the page. The other runs the real `loom.exe --claude-hook` (the debug
  build, or `LOOM_TEST_EXE`) with its stdin held open until that Enter has
  failed, checks the event's `t` is later than the Enter, and hands the
  file's event to the page. Both keep the doubt and end `unknown`, saved
  that way. A shell task whose Enter reply was lost still completes on its
  token. The sixth review's too: an earlier untracked turn of the task's
  text while its Enter or its paste write is held, on Claude and on Codex.
  The write then fails, and the task ends `unknown` (Enter) or `failed` with
  `uncertain: "type"` (paste), and comes back that way after a restart and
  on a keyed retry, typing nothing. When the held Enter goes in, what came
  meanwhile still counts, and a shell line that runs before the Enter's
  reply completes its task whether that reply succeeds or fails. A turn
  stamped before the task's Enter but delivered after it isn't the task's.
  The seventh review's too: an older Claude task with a Stop seen while
  Claude looked busy, whose StopFailure or PermissionRequest arrives during
  a newer task's held Enter, with that Enter failing or going in. It stays
  `working` while held, then ends `failed`, or asks, never `completed`, and
  comes back that way after a restart. A pane that exits after the
  failure report leaves the task failed by that report, not by the exit.
  Putting each of those defects back fails the check, as does breaking the
  Esc rule, the draft refusal or the journal's key lookup.
  `cargo test` also pins the prompt hook running in step, events without a
  launch going unwritten, `watch --follow`'s one-line failures, and a torn
  journal read back up to the tear (an unreadable one as an error).
  `scripts/opencode-plugin-check.mjs` checks the plugin's task reports.
  `scripts/task-live-check.mjs` runs the debug build: a PowerShell task's
  exit code, a `--key` retry, `watch --follow` while Loom is killed and
  started again, and, with `TASK_LIVE_CLAUDE=1`, a real Claude pane on haiku:
  a prompt started and ended by its hooks, an approval answered with
  `choose`, an Esc interrupt and a 41-line paste.
- `pty-close-check.mjs` still passes.
- A verbose `makensis` run lists `loomctl.exe` in the installer next to `loom.exe`.

## Not done yet

- **Pane state changes as a stream.** `watch` streams task events; a pane
  going waiting or idle still takes `wait-any`.
- **Waking a controller from outside Loom.** Tasks and `watch --follow` stay on
  this machine; a connection that wakes a remote controller is designed later,
  once its transport is checked.
- **Cancelling a task.** There's no `cancel`: `keys <pane> esc` interrupts, and
  the task ends `cancelled` once the agent stops.
- **Git from the Changes panel:** stage, commit and push. `send` can type git
  commands into a shell pane meanwhile.
- **Agent groups, dictation, font size and file previews** have no commands.
- **An agent skill** that teaches Claude Code or Codex in a pane to orchestrate
  the others through `loomctl`.
- **Whether an agent's work succeeded.** Turns and receipts say an agent
  finished or asked, not whether it did what was asked. Reading its answer is
  still up to the caller.
- **Two callers on one agent.** An agent receipt can't tell which of two
  queued prompts a turn answered. Tasks can for Claude and Codex, which name
  their prompts; OpenCode's are tied by order.
- **Retries across a restart of Loom** for anything but `submit`: other
  `--key` answers live in memory.
- **Finding every running Loom.** `info` names the one a pipe reaches, but
  nothing lists them all, and the hello doesn't say which workspace file it has.
- **Prompts taller than the screen.** A menu id covers what is on screen; if
  the prompt starts above it, the top isn't in the id.
- **Picking a Codex or OpenCode session from the terminal** when a restart
  needs one; it still takes the window.
- **Unnumbered menus.** `menu` reads numbered questions only. Claude's
  folder-trust prompt has no numbers, so it needs `keys` (down, enter).
