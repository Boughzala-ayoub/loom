# loomctl usage guide

`loomctl` controls a running Loom from a terminal, a script, or an agent in a
Loom pane. Each command runs inside the Loom window through the same code its
buttons use, so the window shows what happened. `loomctl.exe` is installed next
to `loom.exe`, so it is on your PATH. In a development checkout it's at
`src-tauri\target\release\loomctl.exe`.

`docs/cli-control.md` explains how it works and why. This page is about using it.

## First commands

```powershell
loomctl status                      # what's running, and who is waiting for you
loomctl panes                       # every pane, as <thread>:<n>, with its state
loomctl read api-fix:1              # what that pane shows, as text
loomctl send api-fix:1 run the tests
loomctl wait api-fix:1              # until that agent waits for you
loomctl submit api-fix:1 fix the login test   # a task id, once Enter went in
loomctl wait --task <id>            # until that task finishes or asks
```

## Which Loom it talks to

- With no options, the Loom running your default workspace.
- With `--profile work.json`, the Loom started as `loom.exe work.json`.
- Inside a Loom pane, the Loom that owns the pane. `loomctl` is on the pane's
  PATH, and the pane's `LOOM_PIPE` variable names its Loom. `--profile` still
  picks another.
- `loomctl info` says which Loom answered: its version, protocol, process id and
  its own pipe. To keep a script on that one Loom even if another starts:

  ```powershell
  $env:LOOM_PIPE = (loomctl --json info | ConvertFrom-Json).pipe
  ```

A development build (`tauri dev`) answers on a separate pipe, so it never
answers for the installed app. Only your Windows account can open the pipe, and
Loom refuses remote connections.

After an update, restart Loom. A `loomctl` and a Loom on different protocol
versions refuse each other before running anything (exit 2, `code: version`).

## The command line

```
loomctl [--json] [--profile FILE] [--timeout SECONDS] [--key NAME] <command> [words...] [command options]
```

`loomctl`'s own options can go anywhere before `--`:

| Option | What it does |
| --- | --- |
| `--json` | Answers as JSON, failures included. See [JSON and exit codes](#json-and-exit-codes). |
| `--profile FILE` | Talk to the Loom started with that workspace file. |
| `--timeout SECONDS` | How long to wait for the answer: 30 by default, an hour for `wait` and `wait-any`. |
| `--key NAME` | Run this request once, even if you retry it. See [Retrying safely](#retrying-safely). |
| `--help`, `-h` | `loomctl --help` lists the commands; `loomctl send --help` shows one. |
| `--version`, `-V` | The version of `loomctl`. |

A command's own options go after its name, in any order among its words:
`--name value`, `--name=value`, or a bare `--yes` for an on/off option
(`--yes=off` turns it off). An on/off option never takes the next word, so
`close --yes api-fix:2` closes api-fix:2. An option the command doesn't take is
an error. After `--`, every word is text, even one starting with `--`.

An argument of `-` is standard input. It is sent apart from the words, so text
starting with `--` stays text, and one final line break is dropped. Use it for
anything long, multi-line, or full of quotes:

```powershell
Get-Content task.md -Raw | loomctl send api-fix:1 -
```

Several words are joined with single spaces. Quote the text to keep it exact.

## Naming panes and threads

A pane is any of these:

- `<thread>:<n>`, the thread's name and the pane's place in it from 1, as in
  `api-fix:2`
- its id, shown by `panes`
- `.`, or nothing for commands whose pane is optional: the pane in front

A thread is its name (any case), a unique start of its name, its id, or `.` for
the thread in front.

Names and numbers change when you rename a thread or close a pane. Ids don't,
until Loom exits. Scripts should use ids.

Panes are in one of these states. `waiting` is the one that usually matters:
the agent finished or wants you, and the pane shows the attention dot.

| State | Meaning | Also accepted as |
| --- | --- | --- |
| `starting` | The process is launching | |
| `working` | The agent is busy, or a shell command is running | `busy` |
| `idle` | Running, nothing new for you | `ready` |
| `waiting` | Finished a turn, or asking you something | |
| `exited` | The process is gone; the pane stays | `dead` |

## Commands

`loomctl help` lists them from the running Loom, and `loomctl help <command>`
shows one.

### Reading

| Command | What it does |
| --- | --- |
| `status` | Counts by state, the pane in front, and every pane waiting for you. |
| `threads` | Every thread: name, id, state, pane count, branch and folder. |
| `panes [--thread T] [--state S]` | Every pane, or a thread's, or the ones in a state (`--state idle,waiting` for several). |
| `read [pane] [--lines N] [--styles]` | The pane's screen as text. With `--lines N`, its last N lines, scrollback included. See [What the input holds](#what-the-input-holds). |
| `menu [pane]` | The numbered question on the pane's screen, if any, with an id for it. See [Answering questions](#answering-questions). |
| `receipt <token>` | What `send --receipt` sent and what came back, without waiting. See [Receipts as a record](#receipts-as-a-record). |
| `task <id>` | A task from `submit` as it stands. See [Tasks](#tasks). |
| `tasks [--pane P] [--state S]` | Every open task and the last 500 to finish. |
| `watch [task] [--after N] [--follow] [--metadata [--policy \| --policy-v4] [--notification-context]]` | Task events after number N, as they come. See [Waiting and watching](#waiting-and-watching). |
| `close-plan <thread> [--delete worktree\|branch]` | What `close-thread` would close and delete, changing nothing. See [Deleting a worktree](#deleting-a-worktree). |
| `info` | Which Loom answered. Answered by the handshake, not the window. |
| `help [command]` | The commands, or one command. |

`panes --json` gives more than the table, per pane:

| Field | Meaning |
| --- | --- |
| `id`, `ref`, `thread`, `threadId`, `n` | The pane's id, its `<thread>:<n>`, and its thread |
| `agent`, `title`, `state`, `front` | What runs there, its title, its state, whether it's in front |
| `dir`, `sessionId` | The thread's folder; the agent session it resumes |
| `generation` | Changes whenever the pane stops or starts. `--gen` takes it. |
| `turns` | Agent panes: turns finished since it started. See [Knowing when work finished](#knowing-when-work-finished). |
| `commands`, `failed`, `exit` | Shell panes: commands finished since it started, and whether the last failed, with its exit code (`null` when PowerShell can't say which) |
| `atPrompt` | Shell panes: PowerShell's prompt is waiting for a command |
| `lastOutput` | When the pane last drew anything |

### Moving around the window

| Command | What it does |
| --- | --- |
| `show <thread\|pane>` | Bring a thread or a pane to the front. |
| `next` | Go to the next agent waiting for you, as F3 does. |
| `overview [open\|close]` | Open, close, or toggle the Overview. |
| `changes [open\|close]` | Open, close, or toggle the Changes panel. |
| `layout <cols\|rows\|grid> [--thread T]` | How a thread arranges its panes. |
| `zoom [pane]` | Let a pane fill its thread, or put it back. |
| `window <show\|minimize\|maximize\|restore\|phone>` | Bring the window up, resize it, or toggle the phone size. |

### Threads and panes

| Command | What it does |
| --- | --- |
| `new <folder> [--agent A \| --cmd C] [--name N] [--base B] [--panes N]` | Open a Git folder as a thread. |
| `add [thread] [--agent A \| --cmd C]` | Start another agent or terminal in a thread and bring it to the front. |
| `rename <thread> <name>` | Rename a thread. Its branch and folder keep their names. |
| `restart [pane] [--yes]` | Start the pane's process again, resuming its session. A running one needs `--yes`. |
| `stop [pane] --yes` | Stop the process and keep the pane. A start still in progress is cancelled too. |
| `close [pane] [--yes]` | Close a pane. One running an agent needs `--yes`. |
| `close-thread <thread> --yes [--delete worktree\|branch] [--plan REV] [--discard LIST] [--force]` | Close a thread and its panes. |

`new` opens the folder's Git repository (a relative folder is relative to your
terminal). Without `--name` it opens the repository itself, or brings up the
thread already open on it. With `--name login` it creates a worktree on a new
branch `loom/login`, from `--base` if given (else from the current HEAD). The
worktree goes in `~\loom\<repo>\login`, and a name already taken gets a
number added. `--panes N` opens 1 to 16 panes. Nothing is created if an
argument is wrong.

`--agent` picks a startup by its label. The default list is `claude`, `codex`,
`opencode`, `opencode2`, `powershell`, `cmd` and `git bash`; your own list in
Loom replaces it. With neither `--agent` nor `--cmd`, the first one runs.
`--cmd "npm run dev"` runs a command line in PowerShell with Loom's prompt
around it, and `--cmd=` (empty) is a plain PowerShell.

`close-thread --delete worktree` also removes the worktree folder, and
`--delete branch` removes the branch too. Both work only on worktrees Loom made.
What they protect is in [Deleting a worktree](#deleting-a-worktree).

### Deleting a worktree

Deleting a worktree destroys four kinds of thing that may exist nowhere else.
`close-thread` refuses while it would lose any of them that `--discard` doesn't
name:

| `--discard` | What it allows to be lost |
| --- | --- |
| `tracked` | Changes to files Git tracks |
| `untracked` | Files Git doesn't track and doesn't ignore |
| `ignored` | Files Git ignores, such as `.env`, `node_modules/` or `target/` |
| `commits` | With `--delete branch`, commits no other branch or remote has |

Name several with commas (`--discard ignored,untracked`), or `--discard all`.
`--force` is `--discard all`, as before.

Ignored files count because Loom can't tell a build folder from a `.env` or
notes that exist only there. So a worktree whose only extra files are ignored
still needs `--discard ignored`. A folder ignored as a whole, like
`node_modules/`, counts as one entry; what's inside it isn't listed. If Loom
can't read the folder's status, it refuses rather than assume nothing is lost.

`close-plan` shows what would happen, and changes nothing:

```powershell
$plan = loomctl --json close-plan login --delete branch | ConvertFrom-Json
$plan.lost        # counts: tracked, untracked, ignored, commits
$plan.ignored     # the ignored paths (the first 50)
$plan.discard     # what --discard has to name to go ahead
loomctl close-thread $plan.thread --yes --delete branch --plan $plan.rev --discard ignored
```

The plan names the thread (`thread`, `dir`, `repo`, `branch`), the panes it
stops with their generations, the worktree's HEAD, and the lists of tracked,
untracked and ignored paths. Its `rev` covers all of it. `close-thread --plan
REV` reads it again before closing anything and refuses if any of it changed:
another pane, a restart, a new file, a new commit. Without `--plan`, the check
uses whatever is there when the command runs.

After the panes stop, Loom reads the folder once more, since a pane's process
writes until it's gone. If the folder changed, Loom keeps it and says so. The
Delete worktree buttons in the window work the same way: their dialog lists
what would be lost, ignored files included, and nothing goes if that changed
before you answered.

A cleanup that stops part-way says which steps finished, in `steps`:

```json
{ "ok": false, "code": "failed", "closed": "mupvx2k-30",
  "steps": { "panes": "closed", "worktree": "failed", "branch": "kept" },
  "error": "Closed login and stopped its panes, but couldn't remove its worktree folder, ..." }
```

`worktree` is `removed`, `kept` (it changed while the panes closed), `failed`
(Git refused; the folder may be partly deleted) or `null` when not asked.
`branch` is `deleted`, `kept` (the folder step didn't finish), `failed` or
`null`. A thread whose panes closed is gone from Loom even when its folder
stayed: remove that folder with `git worktree remove`.

### Typing into panes

| Command | What it does |
| --- | --- |
| `send <pane> <text...> [--no-enter] [--gen N] [--receipt] [--input REV] [--replace]` | Type text and press Enter once it shows on screen. |
| `submit <pane> <text...> [--gen N] [--input REV]` | Hand over a task: `send`'s checks and more, and a task id back. See [Tasks](#tasks). |
| `keys <pane> <key...> [--gen N] [--task ID]` | Press keys. A lone `enter` can be a task's held-back Enter: see [Retrying a submit](#retrying-a-submit). |
| `choose <pane> <n> [--menu ID] [--gen N]` | Pick option n of a numbered question, as the Overview's buttons do. |

How `send` works:

1. It pastes the text, the way a paste from the clipboard arrives.
2. It waits for the text to show on screen. Long text counts as shown when its
   end is visible, or when Claude shows `[Pasted text #1 +120 lines]` or Codex
   shows `[Pasted Content 5000 chars]` instead.
3. Then it presses Enter. If the text never shows (say a menu was up, where
   Enter would pick an option), it doesn't press Enter and fails with
   `"typed": true`. The text may be sitting in the input, so don't send it
   again: `loomctl read` shows it and `loomctl keys <pane> enter` submits it.

Between the paste and the Enter, Loom's paste is the only input it expects. If
anything else writes to the pane meanwhile, such as a key pressed in the
window, dictation or a dropped file, both are in the input, so Loom holds back
the Enter and fails with `"typed": true`. Look at the input before sending
anything. Input like that arriving after the send's turn began but before the
paste (while a shell receipt waits for its prompt, say) stops the send with
nothing typed (`"typed": false`). Loom's last checks, `--input` and
`--replace` among them, run right before the paste with nothing in between.

When writing to the pane itself fails, Loom can't tell how much went in, so
the failure says which write is in doubt with `"uncertain"`: `"type"` (some or
all of the text may be in the input) or `"submit"` (the text is in the input
and Enter may or may not have gone in). Either way it carries `"typed": true`.
Only a failure with `"typed": false` wrote nothing and is safe to send again.

`--no-enter` only types. Sends to one pane take turns, so two at once arrive as
two commands. Input belongs to the session that was running when you sent it:
if the pane stops or restarts first, the send fails and nothing reaches the new
session. `--gen N` goes further and refuses unless the pane is still on the
generation you saw in `panes --json`.

`send` answers with the pane, its generation, and the SHA-256 and byte count
of the text's UTF-8 (`sha256`, `bytes`), so a caller can check Loom typed what
it meant to. The text is what Loom got: words joined with single spaces, or
standard input less one final line break. A shell receipt's comment isn't part
of it.

### What the input holds

An agent's input can show text nobody typed: Claude puts a suggested next
prompt there, dim, and the first letter you type replaces it. As plain text it
looks the same as a draft someone typed and hasn't sent. `read --json` tells
them apart where Loom can:

```powershell
$r = loomctl --json read api-fix:1 | ConvertFrom-Json
$r.input.kind     # draft, suggestion, empty or unknown
$r.input.text     # the draft or suggestion as drawn
$r.input.rev      # what send --input takes
```

| `kind` | Meaning |
| --- | --- |
| `draft` | Text someone typed and hasn't sent. Sending types after it. |
| `suggestion` | Text the agent shows that typing replaces. |
| `empty` | Nothing in the input. |
| `unknown` | Loom can't tell. Treat any text there as a draft. |

Claude's and Codex's inputs are read. OpenCode and shells are always
`unknown`.

- **Claude**, as Claude Code 2.1 draws it: `❯` (or `>`) and a space or a
  no-break space before the input, between two rules, typed text plain, its
  placeholder and suggestion dim.
- **Codex**, as Codex 0.160 draws it (captured from the real program,
  `src/fixtures/codex-composer.json`): `›` in the first column and the input
  from the third, wrapped rows and the draft's own lines indented to it, then
  a blank row and its status lines at the bottom. A draft can hold blank
  lines, so Loom reads the input from `›` down to the blank row above the
  status lines, wherever the cursor is in it. Typed text is plain, and a long
  paste shows as `[Pasted Content N chars]`. Its dim placeholder,
  `Ask Codex to do anything`, which Codex shows only while the input is empty,
  reads as a `suggestion`. Codex draws no caret, so Loom also needs the
  terminal cursor at the insertion point: the placeholder counts only with the
  cursor right in front of it. Codex's input never reads as `empty`: blank
  without its placeholder, it may hold blank lines, so it's `unknown`.

Either is `unknown` when its input isn't on screen, a question is up (an
approval draws `›` on its first option), the cursor is hidden or outside the
input (Codex), Codex's status lines aren't below the cursor (so its end can't
be found), plain and dim text are mixed, or the screen is drawn some other
way. `input.why` says which. A draft that is a numbered list can look like a
question, and reads as `unknown` too.

`read --json` also gives the terminal `cursor` (`x`, `y` on the screen, and
`hidden` when the program hid it; Claude hides it and draws its own caret).
`read --styles` adds the screen's `rows` as runs of text with their style:
`bold`, `dim`, `italic`, `underline`, `inverse`, and `fg`/`bg` as a palette
index or `#rrggbb`.

`--input REV` makes a send conditional on the input you read. Loom checks it in
the pane's turn, right before typing, and types nothing if anything wrote to
the pane since: another `loomctl` call, a key pressed in the window, a paste or
dictation, even before the agent draws it. It also refuses if a draft appeared
or changed. A suggestion arriving or changing doesn't count, since typing
replaces it.

```powershell
loomctl send api-fix:1 --input $r.input.rev 'run the tests'
```

`--replace` types only over an empty input or a suggestion. It refuses a draft
or an input Loom can't read, typing nothing, and over a suggestion it presses
Enter only once the input reads as a draft without it. Loom never clears a
draft for you: Ctrl-C interrupts a turn and Esc can open Claude's rewind menu,
so no key is safe. Clear it in the window.

To look before committing to the whole text, type a first letter and read
again. Each step is checked against the read before it, so a writer in between
stops the rest:

```powershell
$r = loomctl --json read api-fix:1 | ConvertFrom-Json
loomctl send api-fix:1 --no-enter --input $r.input.rev 'W'
$r = loomctl --json read api-fix:1 | ConvertFrom-Json    # the suggestion is gone: draft "W"
loomctl send api-fix:1 --input $r.input.rev 'rite the tests'
```

`keys` takes `enter` (or `return`), `esc` (or `escape`), `tab`, `shift-tab`
(or `backtab`), `backspace`, `space`, `delete` (or `del`), `pageup`,
`pagedown`, `up`, `down`, `left`, `right`, `home`, `end`, `ctrl-<letter>`
(also written `ctrl+c` or `c-c`), and any single character. If a restart cuts a
`keys` short, the failure says how many went in (`"pressed": 1`): an `enter`
among them may already have run something.

### Waiting

| Command | What it does |
| --- | --- |
| `wait [pane] [--state S]` | Until the pane is in a state: `waiting` by default, or several such as `--state idle,waiting`. |
| `wait <pane> --turn-after N [--gen N]` | Until an agent finishes turn N+1. |
| `wait --receipt R` | Until what `send --receipt` sent finishes. |
| `wait --task ID [--until S]` | Until a task finishes or asks for approval, or reaches a state `--until` names. |
| `wait-any [--state S] [--thread T] [--new]` | Until any pane, or any in a thread, is in a state. `--new` skips the ones already in it until they leave and come back. |

Waits get an hour unless `--timeout` says otherwise, and end with exit code 3
when time runs out.

### Settings

| Command | What it does |
| --- | --- |
| `theme [name]` | List the themes, or switch to one. |
| `set` | Show the settings. |
| `set sound\|taskbar\|awake\|plan-usage on\|off` | Change one. |
| `set overlay off\|background\|always` | When the agent overlay shows. |
| `notify [pane [inherit\|on\|off]] [--all on\|off] [--finish\|--fail\|--blocked on\|off] [--new-panes inherit\|on\|off]` | Task notices: show them, or change every pane's, one pane's, the kinds or what new panes start with. See [Task notices](#task-notices). |
| `notify --check SEQ,...` | Whether those events may go out as notices now. |

## Answering questions

```powershell
loomctl menu api-fix:1
```

`menu` prints the whole question as drawn, from the line above it through each
option's details, and an id for all of it. `choose` moves the highlight one
arrow key at a time and presses Enter only on the option you asked for. It
gives up without choosing if the question changes while it works.

Pass the id to make sure you answer the question you read:

```powershell
$m = loomctl --json menu api-fix:1 | ConvertFrom-Json
$m.prompt                                        # read the full question first
loomctl choose api-fix:1 1 --menu $m.rev
```

If anything in the question changed since you read it (another question, or a
different path or command under the same options), `choose` refuses. Moving the
highlight doesn't change the id.

`menu` reads numbered questions only. Claude's folder-trust prompt has no
numbers, so answer it with `keys`, for example `keys api-fix:1 down enter`. The
id covers what is on screen; if a question starts above the visible part, read
the pane before approving.

## Knowing when work finished

There are three ways to know, from coarse to exact. A fourth, [tasks](#tasks),
follows one `submit` from start to outcome on the agent's own reports.

1. `wait --state waiting` waits until the pane needs you, which for an agent
   usually means it finished. It is a state, so a pane already waiting returns
   at once.
2. `turns` (in `panes --json`) counts each time an agent finished or stopped to
   ask, from the agent's own signal: Claude's bell or Stop hook, Codex's and
   OpenCode's notifications. It never guesses from the screen going quiet. A
   turn counts only after new input, and only from the kind of signal that
   counted the pane's first turn, so one turn that signals twice counts once.
   `wait <pane> --turn-after N` waits for the next one.
3. Receipts tie an outcome to one `send`:

   ```powershell
   $r = loomctl send api-fix:3 --receipt 'npm test'
   loomctl --json wait --receipt $r
   ```

In a shell pane, the receipt rides on the command line as a comment
(`npm test  # loom-receipt:<token>`). Loom's PowerShell prompt reports that
line's own exit code, so other commands on the same pane can't answer for it.
The answer has `failed` and `exit`. The pane has to be at Loom's PowerShell
prompt: if a command sent just before is still running, `send --receipt` waits
up to 5 seconds for the next prompt, then fails with nothing typed.

In an agent pane, the receipt is the first turn after your Enter. The answer
has `turn`, and `asking: true` if it stopped on a question. It says the agent
finished or asked, not that it did the job: read its answer. Two callers
sending to one agent at once can't be told apart, since it may answer both in
one turn. And if a permission question arrives on a different signal than the
one that counts turns, it raises the alert without finishing the receipt, so
watch `wait --state waiting` and `menu` alongside.

A receipt fails if its pane restarts, exits or closes before the outcome
arrives. One that already has its outcome keeps it. Loom keeps the last 500
receipts with an outcome and refuses a new one while 2000 are still pending.

### Receipts as a record

The screen moves on: a long task scrolls away or shows as
`[Pasted text #1 +120 lines]`. `loomctl receipt <token>` answers from Loom's
own record instead, in two parts:

```json
{ "receipt": "0512e22855924d79", "pane": "mupi1lr6-35", "ref": "studio:1", "generation": 1, "key": "task-42",
  "wrote": { "sha256": "92bc5e…", "bytes": 41, "stage": "submitted",
             "acceptedAt": "…", "typedAt": "…", "submittedAt": "…" },
  "acknowledged": { "turn": 4, "at": "…" },
  "outcome": "acknowledged" }
```

`wrote` is what Loom did: the digest and size of the text, and how far it got.
`stage` is `accepted`, `typed`, or `submitted` once Enter went in. `uncertain`
is `null`, or names the write that failed and may have gone in anyway: `type`
(the text, so `stage` stays `accepted`) or `submit` (Enter, after the text was
typed). A receipt whose Enter is uncertain stays `pending`, since the agent may
be working on it. The next turn on that pane acknowledges it, whatever input
started that turn, so `acknowledged` doesn't prove this Enter or this task
reached the agent: `uncertain` stays `submit`, and only the agent's screen or
answer can tell. `acknowledged`
is what the pane signaled back: an agent's turn ending (`turn`), or a shell
command's `failed` and `exit`. It is `null` until then. `outcome` is `pending`,
`acknowledged`, or `none` when nothing will come (the pane restarted, exited or
closed, or Enter was never pressed). A turn ending means the agent stopped,
not that the job is done: read its answer. `held` is `true` while its task's
Enter is held back and can still be pressed (see [Retrying a submit](#retrying-a-submit));
such a receipt stays `pending` and is never pruned from the history meanwhile.

Loom keeps the digest, never the text, since prompts can hold secrets. Save the
prompt on your side and hash its UTF-8 to compare. When `send --receipt` fails
after writing anything (`"typed": true`), the failure carries the `receipt`.
One whose Enter was held back shows `stage: "typed"`, and `wait --receipt` on
it fails at once. Only a send that wrote nothing drops its receipt. A retry with the same `--key` answers with the first receipt and types
nothing. Receipts live in memory: after Loom restarts or drops one, `receipt`
fails with `"unavailable": true`.

## Tasks

`submit` hands a pane a piece of work and answers with a task id as soon as
Enter went in. From then on Loom records where the task got to, from what the
agent itself reports, and keeps that record in a journal beside your workspace
file. The id, its `--key` and its events still answer after Loom restarts.

Two other turns are tasks too, each with its own id, and every task says what
started it in `source`:

- `send`: an ordinary `loomctl send` to Claude, Codex or OpenCode with Enter.
  The task is made right before its Enter, so a send that stops sooner leaves
  none, and `send` answers with its id as `task` (the receipt token, with
  `--receipt`). A send to a shell, or with `--no-enter`, makes none.
- `manual`: a person's Enter in Loom's window, typed in the pane, sent from
  the Overview's reply box, or dictated. Loom notes the Enter and, where it
  can read the input, a hash of the prompt, never the text. The task appears
  only when the agent reports the turn that Enter sent: Claude's prompt hook
  naming it, OpenCode's first run after it, Codex's turn report naming its
  prompt (or, when Loom could read Codex's input, at the Enter itself, since
  Codex reports only a finished turn). An Enter on an empty input, one that
  answers a question on screen, and a turn no such Enter explains (an agent's
  background notice, input from outside Loom) make no task. A report from a
  launch the pane has since replaced makes none either.

A `send` or `manual` task then moves like a submit's, on the same reports and
with the same rules: a quiet pane never completes it, and without the agent's
own end it ends `unknown`. Its record keeps no text at all for `manual`
(`sha256` empty, `bytes` 0), only the prompt's match.

```powershell
$t = loomctl --json --key login-1 submit api-fix:1 'fix the login test' | ConvertFrom-Json
loomctl --json wait --task $t.task         # until it finishes or asks for approval
loomctl task $t.task                        # where it is now, without waiting
```

A task is in one of these states:

| State | Meaning |
| --- | --- |
| `accepted` | Loom checked the pane, wrote the task to its journal, and is typing the text or pressing Enter, or held Enter back (`uncertain: "enter"`). Nothing the agent reports moves it yet |
| `submitted` | Enter went in. The agent hasn't reported taking it yet |
| `working` | The agent reported starting it, or Loom saw it working (see `correlation`) |
| `approval` | The agent is asking for permission or an answer |
| `completed` | The agent reported the end of the turn that carried this task (Claude: its Stop, and Claude no longer working) |
| `failed` | The agent reported an error, the shell command exited non-zero, the agent's process exited, or Loom couldn't press Enter |
| `cancelled` | Esc or Ctrl-C stopped the agent, or the pane was restarted, stopped or closed |
| `unknown` | Loom can't tell how it ended: Loom restarted while it ran, the agent sat idle for 30 s with no end reported, a shell line never started, or something else was written to the pane while its text waited for Enter |

The last four are final: a task never leaves them. `completed` means the agent
stopped, not that the work is right. Read its answer.

### What submit checks

Everything `send` checks: the pane's generation (`--gen`), anything else
writing to the pane, the text showing before Enter. On top of that, `submit`
types nothing when:

- an agent shows a numbered question, where Enter would answer it (`menu` and
  `choose` deal with those)
- Claude's or Codex's input holds a draft someone typed, which the task would
  join

Over a suggestion (Codex's placeholder included) it types as `send --replace`
does. An input Loom can't read (OpenCode, a shell, or Claude or Codex when
their input reads as `unknown`, say Codex with its cursor hidden) gets the
text after whatever is there, as `send` does, and the task says
`input: "unknown"`. A shell needs Loom's PowerShell
prompt, as `send --receipt` does. `--input REV` works as it does for `send`.

Before typing, `submit` writes the task to its journal and waits for the
write. If the journal can't take it (a full disk, say), it types nothing and
fails with `"typed": false`. The wait happens inside the pane's turn, before
`send`'s last checks, so input arriving meanwhile still stops the send.

`submit` takes no `--no-enter`: a task starts with its Enter.

### Retrying a submit

With `--key`, a retry gets the same task back and types nothing, even after
Loom restarted: the journal has the task and its key before anything is
typed, so even a crash right after the Enter leaves it there (the retry then
finds it `unknown`, since that Loom is gone). The same key with a different
request is refused. Repeat the request word for word, pane included, even if
that pane id is gone. A key is spent once its task is recorded, even if the
send then stopped before typing (a draft appeared, say): the retry gets that
task, `cancelled` with reason `not-sent`.

Without `--key`, the failure tells you how far it got:

| Failure | Task | Safe to send again |
| --- | --- | --- |
| `"typed": false` | none, or `cancelled` with reason `not-sent` once recorded | yes |
| Enter held back: the text didn't show | stays `accepted`, `uncertain: "enter"` | no: the text may be in the input (see below) |
| Enter held back: something else typed meanwhile | `failed`, reason `not-submitted` | no: the input holds both |
| Writing the text failed | `failed`, `not-submitted`, `uncertain: "type"` | no |
| Writing Enter failed | stays `submitted`, `uncertain: "submit"` | no: the agent may be working on it |

A failure carries the task's id as `task` once the task was recorded.

Loom waits up to 5 seconds for the text to show: an agent may draw a long
paste in stages, quiet partway (Codex did for 0.4 s on its first input after
starting). When the text didn't show, Loom's paste was all that went into the pane, so
the text may be sitting in the input, alone. The task stays open, `accepted`
with `uncertain: "enter"`. `loomctl read` the pane, and if the text is there,
`loomctl keys <pane> enter --task <id>` presses its Enter for it: the task
goes on from there exactly as if `submit` had pressed it, to `submitted` and
on to its outcome, and `wait --task` and `watch` follow it. That Enter counts
for the task only on its own pane and launch, with nothing written there since
the text (a key, dictation, another send), no question on screen, and
Claude's or Codex's input reading as a draft. Otherwise `--task` presses
nothing and fails with `"typed": false`. A plain `keys <pane> enter` is the
task's Enter when all of that holds, and an ordinary key when it doesn't.
Anything else written to the pane first may have sent the text or changed it,
so the task ends `unknown`, reason `not-submitted`. Restarting or closing the
pane cancels it, its process exiting fails it, and a Loom restart ends it
`unknown`. The task's receipt (its id) goes with it: `pending` with `held:
true` while the Enter can still be pressed, then the Enter's own record once
it is, or `none` when the task ended without it.

A
task whose Enter is in doubt stays open. On a shell, the line that runs
carries the task's own receipt token, so the doubt clears and the task goes
on as usual. Nothing else clears it. An agent reports a prompt by its text,
never by the Enter that sent it, and an earlier prompt of the same text
looks the same: its report can be written after the doubted Enter, and so
can a `send` or typing in the window. An agent task whose Enter is in doubt
can still show `working` or `approval`, but whatever ends its turn ends it
`unknown`, with reason `submit-uncertain`, never `completed`. That holds
even when the Enter did go in: `loomctl read` the pane to find out. If
nothing comes, it ends `unknown` too.

If a journal write after the first one fails, the record says `saved:
false`: a crash then would lose that change. The next write rewrites the
whole journal, a task being reserved included, and `saved` goes back to
`true` once that works.

An append that a crash cut short costs only that last line: the tasks and
keys before it come back. If Loom can't read the journal at all when it
starts (its permissions changed, say), `submit` refuses until it can, since
it couldn't tell a retried `--key` from a new task, and Loom leaves the file
alone. Fix or move it and restart Loom.

### How Loom knows

Every agent reports differently. `correlation` on the task says what tied it
to the agent's work:

| Agent | Start | End | Asks | Interrupted |
| --- | --- | --- | --- | --- |
| Claude Code | its prompt hook names this prompt (`prompt`) | its Stop hook, once Claude is also seen idle, ends the prompts it started; a failure hook fails them | its permission hook, with the tool | no report: Loom sees Esc or Ctrl-C go in, then Claude stop working |
| Codex | no report: Loom sees "esc to interrupt", or its title's run state says Working, Thinking or Waiting (`screen`); Codex hides that hint while it streams an answer, so the title keeps the turn running | its turn notification lists the turn's prompts; each mention completes one task with that text, the oldest (`prompt`) | its "Approval requested" notification | as Claude |
| OpenCode | the first run its plugin reports after the Enter (`sequence`) | that run succeeding, failing or being interrupted | its plugin's permission and question events, until all are answered | its plugin's interrupted |
| Shell | the command line carries the task id (`token`) | that line's own exit code | | the command's exit code |

Loom compares a prompt by a hash of its text with each run of spacing made
one space, because Claude turns CRLF into LF and tabs into spaces, and wraps
a long paste in tags of its own. `edit foo bar` and `edit foobar` still
differ. It never keeps the text.

Every report names the launch of the process that sent it, so a late report
from a process that was stopped or restarted never moves a task of the one
that replaced it.

A report counts for a task only if Loom had pressed the task's Enter by the
time the agent wrote it. Before that, the agent didn't have the prompt. While
the write of that Enter is still out, Loom holds the pane's reports and
applies them once it knows whether the Enter went in. So an earlier prompt
with the same text that finishes while Loom is still typing the task can't
complete it. If the paste fails, the task ends `failed`. If the Enter fails,
it ends `unknown`. A shell line carries the task's id, so its marks settle
the task either way. The pane's other tasks wait meanwhile too: a report of
theirs that came during that write still decides them, before an earlier
Stop or the pane exiting can.

Claude's Stop hook runs beside any Stop hooks of your own, and one of those
can tell Claude to keep working. So a Stop completes a task only once Claude
sits idle at its input: no "esc to interrupt", its input line on screen (a
permission dialog takes its place, reported or not), and no question. If
Claude works on, the task stays `working`, and the next Stop, an Esc or a
failure decides. A permission request after a Stop shows Claude went on, so
that Stop no longer counts at all.

Two open tasks with the same text on one pane: a report of that text goes
first to a task whose Enter surely went in, oldest first, and only then to
one whose Enter is in doubt (`uncertain: "submit"`), since the same text
from a later submit proves nothing about an earlier Enter (and as above,
text alone never completes a task whose Enter is in doubt). On Codex, a turn
that mentions the text once completes one task, marked `uncertain:
"repeated-prompt"` because Loom picked it (unless it already says what's in
doubt); the other waits for a turn of its own. A turn Codex reports twice
counts once.

Two things never complete a task: the pane going quiet, and a turn that ends
without having named it. A task only seen working on screen waits for a
report that names it. If you send Claude a second prompt while it works,
Claude reports it at once and takes it into the running turn (Claude Code
2.1.287 does this), so one Stop completes both.

Answering a question puts the task back to `working`: an Enter or a one-key
answer (`1`, `y`) that went in, from `choose`, `keys` or the window. Moving
the highlight doesn't count, and an answer whose write failed leaves the task
asking, with `answerInDoubt: true` until an answer goes in. Esc on Claude's permission dialog denies
it and ends the turn, so the task ends `cancelled`.

An Esc that the agent shrugs off changes nothing: Loom waits 2 seconds after
the Esc and cancels only if the agent stopped working, and only if no end was
reported first.

### Waiting and watching

`wait --task ID` returns when the task finishes or asks for approval, with the
whole record. `--until working` (or any states, comma-separated, `open` for
any not final) returns earlier. When the time runs out it exits 3, and the
failure carries `task` and `state`.

`watch` gives the events, each a state a task moved to:

```json
{ "events": [ { "seq": 41, "task": "0f3b22280f9d435b", "at": "2026-10-02T00:04:26.629Z",
                "state": "working", "signal": "prompt" } ],
  "next": 41, "done": false, "gap": false, "last": 41 }
```

`seq` numbers every task's events in one order, and the journal carries it
across restarts. `watch --after N` returns the events after N, oldest first,
waiting up to `--timeout` (30 s) for one to come. If none does, it answers
with no events and the same `next`, exit 0. Pass `next` back to continue: no
event comes twice and none is skipped. `watch <task>` gives only that task's
events, and `done: true` once it is final. `gap: true` means Loom no longer
has every event after N (it keeps the last 500 finished tasks), or N is past
its journal (the journal was deleted), in which case it starts from the first
event it has. `watch` shows only events the journal already holds, and
after a restart numbering goes on from the journal, so a number a watcher saw
is never used again. A write takes milliseconds; while the journal can't be
written at all (`saved: false`), new events wait for it.

`watch --metadata` gives each event as `seq`, `task`, `pane` (its id),
`generation`, `state`, `at` and `response`, nothing a prompt or report said,
and adds `"source": "loom-durable-events-v2"` to the answer. `response` is
`null` except on a `completed` event, where it names the agent's final message
the way a prompt is named (16 hex digits of a hash of its words, never the
text), from the agent's own report: Claude's Stop hook, Codex's turn
notification, OpenCode 2.x's last text of the run. It is `null` there too when
the agent named none (a shell, OpenCode 1.x). The same answer observed twice
names the same, so a relay can send one notice per task and answer, and still
one per task when two tasks both answer "Done.". A program that relays events
elsewhere can rely on that shape, and on each event being flushed to disk
before `watch` shows it. `watch` wakes when a journal write lands, not on a
timer.

`watch --follow` keeps going: it prints each event as it comes, one JSON line
each with `--json`, and asks again from the last one. When Loom goes away or
restarts, it says so on stderr and tries again every second from the same
number. Loom's restart events come through too, as the tasks it was running
end `unknown`. On a task it stops (exit 0) once that task is final; otherwise
it runs until Ctrl-C, or `--timeout` seconds (exit 3). With `--json`, a
failure that ends it, a timeout included, is one more line: the usual failure
object, with `next`, the number to resume from. A `loomctl` running in
a Loom pane follows the Loom that owns the pane and goes with it, so follow
from a terminal outside Loom to ride out a restart.

```powershell
loomctl --json watch --follow | ForEach-Object { $e = $_ | ConvertFrom-Json; "$($e.task) $($e.state)" }
```

### Task notices

Loom decides which task events may go out as notices: a task finished, failed,
or blocked on a question (the email bridge sends these, and they wake Ash).
Every other state is never a notice.

- Every pane: on or off (Preferences, Task notices, or `notify --all`). On by
  default, as Loom always was.
- The kinds: finished, failed and blocked, each on or off, for every pane
  (`notify --finish`, `--fail`, `--blocked`).
- A pane's own setting: like every pane (`inherit`), or its own `on` or `off`
  (its bell, top right of the pane, or `notify <pane> on`). A pane's own on or
  off wins over every pane's; the kinds apply either way. The bell is faint
  while the pane follows every pane, bright when it has its own on, and
  crossed out whenever its notices are off.
- New panes: what a pane added from now on starts with (`notify --new-panes`):
  like every pane by default, or its own on or off.

All of it is kept: every pane's settings in the workspace file, a pane's own
in its saved slot (so it survives a relaunch and a Loom restart, though pane
ids change), and each change in the task journal, so every event's decision
does too. An event may go out only if its kind was allowed for its pane when
it happened and by every change since. So turning a pane or kind off also
holds back its notices not sent yet, and turning it on again sends none of
them: only events after that.

`watch --metadata --policy` gives each event two more fields than
`--metadata`: `source` (`submit`, `send`, `manual`) and `notify` (whether it
may go out), under `"source": "loom-durable-events-v3"`. Policy mutes only turn
`notify` from true to false. `notify --check 41,52` asks right before sending:

```json
{ "41": true, "52": false, "9": null }
```

`null` means Loom has no such event. The email bridge reads v3, leaves out
every notice with `notify: false`, and asks `notify --check` again right
before each send. A message the mail server already accepted can't be
recalled, so turning a pane off stops every notice not yet sent, never one
already on its way. A v2 sender that is still running sends what it
already queued without asking, so mutes reach its mail only once it is
stopped; the bridge's runbook gives the switch.

`watch --metadata` without `--policy` (`loom-durable-events-v2`) can't say
what the policy holds back, and a reader of it would send every outcome. So
Loom answers it only while none of the events in the answer is a notice the
policy holds back, and otherwise refuses the whole answer, naming v3. With
every pane on, as by default, v2 answers as it always did. The details, and
what changed in the bridge, are in
[docs/turn-tracking-and-notifications.md](turn-tracking-and-notifications.md).

`notify` checks everything it was given, the pane included, before it changes
anything: a command it refuses changes nothing. `--check` only asks, so it
takes no pane or setting beside it.

An upgrade from slots without `notifyIds` cannot safely connect old task owners
to restored panes. A reference such as `work:1` may now name a different pane.
Loom holds unlinked historical owners and lists their IDs, historical references
and task IDs in `notify` output, under `unresolved` in JSON. A live pane's bell
does not decide those owners' policies.

After reviewing an owner, use `notify --resolve-owner ID release` to remove its
ownership hold, or `notify --resolve-owner ID mute` to suppress its notices
permanently. The decision is journaled and can be retried if its write fails.
Each owner is independent, including closed panes. Release is an explicit
exception to the hold's false result; it still respects every historical policy
mute. It does not recreate notices a relay has already discarded or sent.

For recoverable holds, opt in with `watch --metadata --policy-v4`. Its batch
source is `loom-durable-events-v4`. Events keep the v3 fields except that
`disposition` replaces `notify`:

| Disposition | Consumer action |
| --- | --- |
| `send` | Queue the notice and recheck before sending. |
| `held` | Retain the notice durably and recheck later. Do not mark it permanently muted. |
| `muted` | Suppress the notice permanently. This includes historical policy mutes, even while the owner is unresolved. |
| `none` | This event is not a notification outcome. |

Use `notify --check 41,52 --policy-v4` for pre-send checks. Its map values are
the same four strings, or `null` if the event is unavailable. Keep a held
notice pending when its check returns `held`, and move an unavailable notice
to manual review. A successful owner release changes an eligible notice to
`send`; an owner mute changes it to `muted`. Release creates no task event.
Consumers must recheck retained notices independently of their watch cursor.
Store the batch and held notices before advancing that cursor, and preserve
event and completion deduplication across retries and replay.

The existing `watch --metadata --policy` and `notify --check` contract stays
v3, including its boolean false for held owners. The current email bridge
continues to work unchanged, with its existing limitation that it discards
those notices permanently. Recoverable delivery requires the bridge to opt
into v4 and retain held notices. See the
[bridge upgrade requirements](turn-tracking-and-notifications.md#recoverable-owner-holds-v4).

To also learn where each event happened, add `--notification-context` to
`--metadata --policy` or `--metadata --policy-v4`. Each event then carries a
`context` object, and the answer's source becomes
`loom-durable-events-v3-context-v1` or `loom-durable-events-v4-context-v1`.
The context is what Loom copied when it recorded the event: `threadId`,
`threadName`, `paneId` (the event's `pane`), `paneNumber` (its place in the
thread then), `paneTitle`, `agent`, `provider` (the CLI family: `claude`,
`codex`, `opencode` or `shell`), `capturedAt`, `origin` and `issues`. A later
rename, move or close doesn't change it. `paneTitle` is set only when Loom
named the pane itself (`Terminal`, `Agent session`). A title the running
program set can hold a prompt or a path, so it comes back null. `origin` is
`event` for a copy taken from the pane for this event, `last-known` when the
pane had already left its thread or relaunched, and `legacy` for an event from
before contexts existed, which has only its pane id and agent. Such an answer
holds at most 1000 events and 512 KiB of them. When that cuts one short,
`next` is its last event and `done` stays false, so read on from `next`. The
flag needs `--metadata` and a
policy mode, and the answers without it keep their exact fields. The rules
for labels are in
[Notification context](turn-tracking-and-notifications.md#notification-context).

### A task's record

`task --json` (and `submit`, `wait --task`, `tasks`) answers with:

| Field | Meaning |
| --- | --- |
| `task`, `key` | Its id, and the `--key` it came with |
| `source` | What started it: `submit`, `send` or `manual` (a task from before Loom kept this says `submit`) |
| `state`, `final` | Where it is, and whether that can change |
| `pane`, `ref`, `agent`, `generation` | The pane and the launch it went to |
| `sha256`, `bytes` | Of the text as Loom got it, as `send` reports them |
| `input` | What the input held when Loom typed: `empty`, `suggestion` or `unknown` |
| `correlation` | `prompt`, `token`, `sequence`, `screen`, or `null` before it started |
| `uncertain` | `submit` or `type`: the write of the task's own text or Enter that failed and may have gone in anyway (only proof clears `submit`); `enter`: Loom held its Enter back, and its text may be waiting in the input; `repeated-prompt`: a Codex turn named its text while another open task had the same text |
| `answerInDoubt` | An answer to its question failed to write and may or may not have gone in; an answer that does go in clears it |
| `reason` | Why it ended where it did: `pane-closed`, `pane-stopped`, `pane-restarted`, `exited`, `interrupted`, `not-submitted`, `not-sent`, `no-end-signal`, `no-start-signal`, `submit-uncertain`, `loom-restarted` |
| `detail` | What the agent said: the tool it wants (`Write`), its error, `exit 3` |
| `exit` | A shell command's exit code, or `null` |
| `acceptedAt`, `submittedAt`, `startedAt`, `endedAt` | When each happened. `startedAt` is the agent's own time where it reported one |
| `events` | Every state it went through, with the `signal` that moved it |
| `saved` | Whether the journal has its latest change, a change of `uncertain` or `correlation` without a new state included |

An event's `signal` says what moved it: `loomctl` (accepted), `enter`,
`prompt`, `token`, `run` (OpenCode), `screen`, `approval`, `answered`,
`turn-end`, `turn-failed`, `interrupt`, `interrupted`, `pane`, `quiet` or
`restart`.

`tasks` lists them, oldest first: every open one and the last 500 to finish.
`--state` and `--pane` narrow it.

The journal is `workspaces.tasks.jsonl` beside `workspaces.json`, or
`<profile>.tasks.jsonl` beside a profile. It holds digests, never the text,
and the counters that keep `seq` and `gap` right across restarts.

## Retrying safely

A command can time out or lose its connection after Loom ran it. Give each
change a name with `--key`, and retry with the same name:

```powershell
loomctl --key task-42 send api-fix:1 'fix the login test'
```

Loom runs a key once. A retry of the same command with the same key gets the
first answer (and `loomctl` says so on stderr), waiting for it if it's still
running. The same key with a different command is refused. A key stays while
its command runs, and Loom keeps the last 256 finished ones until it exits.
With 1024 keyed commands still running, a new one is refused.

`submit` keeps its keys in the task journal as well, so a retried `submit`
finds its task even after Loom restarts. See [Retrying a submit](#retrying-a-submit).

Without a key, use the failure's `sent` field:

- `"sent": false` means nothing reached Loom, so trying again is safe.
- `"sent": true` means it may have run. Look first, with `threads`, `panes`,
  `read` or `wait --receipt`.

A timeout stops the waiting, not the command: a slow `new` or `close-thread`
can still finish afterwards.

## JSON and exit codes

With `--json`, a success prints the command's data (`null` when there is none),
and a failure prints one object:

```json
{ "ok": false, "code": "failed", "sent": true, "error": "No thread \"nosuch\". loomctl threads lists them." }
```

| `code` | Meaning | Exit |
| --- | --- | --- |
| `usage` | A `loomctl` option was wrong; nothing was sent | 1 |
| `failed` | Loom ran the command and it failed | 1 |
| `not-running` | No Loom on that pipe | 2 |
| `busy` | Every pipe connection stayed busy | 2 |
| `unreachable` | The pipe couldn't be opened | 2 |
| `version` | `loomctl` and Loom are different versions: restart Loom | 2 |
| `connection` | The connection broke. Check `sent`. | 2 |
| `timeout` | No answer in time. Check `sent`. | 3 |

From Loom, a failure can also carry `timeout`, `typed` (text may be in the
pane and Enter wasn't surely pressed) and `pressed` (keys that went in before a
restart). Other fields say more where a command needs to: `uncertain` (`type`
or `submit`, the write that failed and may have gone in anyway), `receipt` (the
record of a send that wrote something and didn't finish), `task` (the same
for `submit`, with `state` where a `wait --task` ran out), `unavailable` (no
such receipt or task any more),
`closed` and `steps` (a cleanup that stopped part-way), `lost` and `discard`
(what deleting would lose, and what `--discard` must name), and `plan` (a
plan's revision now). The message also goes to stderr. Without `--json`, a success prints readable text
and a failure prints only to stderr. The exit code is 0 on success either way.

## Recipes

Open a worktree for a task and start two agents in it:

```powershell
loomctl new C:\code\app --name login --base main --agent codex --panes 2
```

Run the tests in a fresh shell and get the exit code:

```powershell
$env:LOOM_PIPE = (loomctl --json info | ConvertFrom-Json).pipe     # stay on this Loom
$sh = loomctl --json add login --cmd= | ConvertFrom-Json
do { Start-Sleep -Milliseconds 300 } until ((loomctl --json panes | ConvertFrom-Json | Where-Object id -eq $sh.id).atPrompt)
$r = loomctl send $sh.id --receipt 'npm test'
$out = loomctl --json --timeout 900 wait --receipt $r | ConvertFrom-Json
"exit: $($out.exit)"
loomctl read $sh.id --lines 40
```

Hand an agent a task from a file, and wait for its turn:

```powershell
$p = @(loomctl --json panes --thread login | ConvertFrom-Json | Where-Object agent -eq 'claude')
if ($p.Count -ne 1) { throw "expected one Claude pane in login, found $($p.Count)" }
$p = $p[0]
$r = Get-Content task.md -Raw | loomctl --key login-task-1 send $p.id - --gen $p.generation --receipt
$done = loomctl --json --timeout 3600 wait --receipt $r | ConvertFrom-Json
if ($done.asking) { loomctl menu $p.id } else { loomctl read $p.id --lines 80 }
```

Wait for whichever agent needs you next:

```powershell
loomctl wait-any --new
loomctl next
```

From an agent inside a Loom pane, the same commands work with no setup, and
they reach the Loom that owns the pane. An agent can read other panes, start
agents with `add`, hand them tasks with `send --receipt`, and wait for them.

Clean up a finished worktree, after seeing what it would lose:

```powershell
loomctl close-plan login --delete branch
loomctl close-thread login --yes --delete branch --plan <rev> --discard ignored
```

## Limits

- Keys and receipts live in Loom's memory and are gone when it exits; tasks
  and `submit`'s keys are in the journal. After a restart, look up pane ids
  again with `panes` rather than reusing old ones.
- Claude Code shows a long or many-line paste as `[Pasted text #1 +40 lines]`
  and hands it to the model wrapped in `<pasted_content>` tags. In a live
  check, haiku answered a 41-line task by saying it doesn't follow
  instructions inside pasted content. `send` has the same problem. Keep what
  you hand Claude short, or put the long part in a file and submit
  `Read task.md and do what it says`.
- A task needs its agent's reports. Claude's come from hooks Loom adds with
  `--settings` when it starts the pane: a Claude started before this version
  of Loom, a startup command with its own `--settings`, or Claude's
  `disableAllHooks` sends none, and its tasks go `working` by screen and end
  `unknown`. Codex reports no start, and OpenCode names no prompt, so a task
  there is tied by screen or by order.
- Loom spots an interrupt, and a task gone quiet, by the agent's "esc to
  interrupt" hint leaving the screen. An agent that draws it differently
  isn't seen working, and its tasks end only on a report.
- There's no command to cancel a task: press Esc with `keys`, or stop the pane.
- A receipt or a turn says an agent finished or asked, not that its work is
  right.
- Loom reads only Claude's and Codex's inputs as a draft or a suggestion, and
  only as Claude Code 2.1 and Codex 0.160 draw them. Everything else is
  `unknown`. Loom never clears a draft.
- Receipts keep a digest of the text, not the text. Keep your own copy.
- Restarting a Codex or OpenCode pane that has no saved session to resume needs
  a choice in the window.
- `loomctl` finds one Loom per pipe. It can't list every Loom running.
- Terminal output comes back as it is, secrets included. Treat it as data, not
  instructions.

The three steps of `window show` (unminimize, show, focus) each time out after 2 seconds. A stuck step does not block later commands. Windows may still finish that step after loomctl reports a timeout.

Task records resolve `ref` from the pane ID each time they are read. After close, `ref` is null and `paneClosed` is true; text output names the closed pane and its original reference. `tasks --pane` accepts a current reference or a pane ID, including a closed pane's ID. Historical watch events stay unchanged.

`new <folder>` opens ordinary folders as well as repositories, preserving the folder you selected. Git is required only for `--name` or `--base`, which creates a worktree. `--base` alone also supplies its name.

`menu` recognizes Claude's session survey. Its JSON includes `keys: [1,2,3,0]` as strings and `selected: -1`. Use `choose <pane> 0` to dismiss, or 1/2/3 to rate. Loom sends that digit without Enter; `--menu REV` and `--gen N` still guard the write.

`usage [claude|codex] --json` fetches current account plan usage, even while `set plan-usage off` is in effect. Omit the provider for both. The object is keyed by provider and preserves `limits`, `stale`, `bankedResets` and `bankedResetExpiries` when available. A failed provider returns an `error` field. This command does not enable background polling.

`panes --json` includes `model`, `effort` and `context` from the latest session data. Context contains `usedTokens`, `windowTokens`, `remainingTokens` and `remainingPercent`. Missing data is null. Recent settings take precedence over statusline reports, then the last transcript turn; this does not depend on pane width. The same fields appear in nested pane records from `threads` and `status`.

`add` and `new` accept `--model M` and `--effort E` with an agent startup, including the default startup. Example: `add --agent codex --model gpt-6-astra --effort high`. Model identifiers must have no spaces or shell characters. Effort accepts none/minimal/low/medium/high/xhigh/max/auto for Claude and Codex; each agent validates which values its model supports. OpenCode accepts `--model` but not `--effort`. Neither option combines with `--cmd`.
