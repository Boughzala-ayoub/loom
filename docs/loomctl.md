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
| `keys <pane> <key...> [--gen N]` | Press keys. |
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

Only Claude's input is read, from how Claude Code 2.1 draws it: `❯` (or `>`)
and a space or a no-break space before the input, typed text plain, its
placeholder and suggestion dim. Codex, OpenCode and shells are
always `unknown`, and so is Claude when its input isn't on screen (a question
is up) or is drawn some other way. `input.why` says which.

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

There are three ways to know, from coarse to exact.

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
not that the job is done: read its answer.

Loom keeps the digest, never the text, since prompts can hold secrets. Save the
prompt on your side and hash its UTF-8 to compare. When `send --receipt` fails
after writing anything (`"typed": true`), the failure carries the `receipt`.
One whose Enter was held back shows `stage: "typed"`, and `wait --receipt` on
it fails at once. Only a send that wrote nothing drops its receipt. A retry with the same `--key` answers with the first receipt and types
nothing. Receipts live in memory: after Loom restarts or drops one, `receipt`
fails with `"unavailable": true`.

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
record of a send that wrote something and didn't finish), `unavailable` (no
such receipt any more),
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

- Keys and receipts live in Loom's memory and are gone when it exits. After a
  restart, look up ids again with `panes` rather than reusing old ones.
- A receipt or a turn says an agent finished or asked, not that its work is
  right.
- Loom reads only Claude's input as a draft or a suggestion, and only as
  Claude Code 2.1 draws it. Everything else is `unknown`. Loom never clears a
  draft.
- Receipts keep a digest of the text, not the text. Keep your own copy.
- Restarting a Codex or OpenCode pane that has no saved session to resume needs
  a choice in the window.
- `loomctl` finds one Loom per pipe. It can't list every Loom running.
- Terminal output comes back as it is, secrets included. Treat it as data, not
  instructions.
