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
   with `timeout` or `typed` when they apply. `loomctl` prints `text`, or
   `data` as JSON with `--json`; with `--json` a failure prints the whole
   answer as JSON as well as the message on stderr.

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
worktree also runs the dialog's own check for uncommitted files and unmerged
commits, and refuses if any would be lost unless you add `--force`.

**Waiting is a command.** `wait` and `wait-any` block until a pane reaches a
state. The page polls the state every 200 ms, because a state changes in a
dozen places. It answers with a timeout flag when time runs out, and `loomctl`
exits 3 for that. Waits get an hour by default and other commands 30 seconds.
A timeout ends the waiting, not the command: a `new` still running Git carries
on, so a script checks `threads` before trying again. `loomctl` gives up on its
own 20 seconds after that, in case Loom stops answering altogether.

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
pane's start number when it is queued and checks it again before each write.
If the pane stopped or restarted in between, the command fails and nothing
reaches the new session.

**Enter only once the text shows.** `send` pastes, then presses Enter only if
the text appeared, so Enter never picks a menu option by accident. It counts
the start of the text, its end (the start of a long task scrolls off), and the
placeholders Claude and Codex draw instead of a long paste: `[Pasted text #1
+120 lines]` and `[Pasted Content 5000 chars]`, checked in a real Claude pane.
When none shows, the text may still be sitting in the input, so the failure
carries `typed: true` and says not to send it again.

**Menus have ids.** `menu` gives each question an id, a hash of its question
lines, options and kind but not the highlight. `choose` compares that id, not
just the option labels, before every arrow key and Enter, so a "Delete the
project?" that replaces "Read README.md?" with the same Yes/No options is not
answered. `choose --menu <id>` also refuses a question other than the one the
caller read.

**Ids last as long as Loom does.** Pane and thread ids aren't saved; after a
restart, use names or `<thread>:<n>`.

**Help comes from the running Loom.** `loomctl help` lists the command table in
`main.ts`, so it always matches the Loom you are talking to.

## Commands

| Group | Commands |
| --- | --- |
| Reading | `status`, `threads`, `panes`, `read`, `menu` |
| Moving around | `show`, `next`, `overview`, `changes`, `layout`, `zoom`, `window` |
| Threads and panes | `new`, `add`, `rename`, `close`, `close-thread`, `restart`, `stop` |
| Input | `send`, `keys`, `choose` |
| Waiting | `wait`, `wait-any` |
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
  run, and a `--json` failure printed as JSON.
- `ui-check.mjs` stops a pane while its session check is held open and checks
  it never starts, then fails a restart with a refused `pty_spawn`. It holds a
  write to queue a send, restarts the pane and checks the send is refused with
  nothing typed; stops a dead Codex pane while its restart checks the saved
  session and checks nothing spawns; changes a question under the same
  options before a queued `choose` and checks no Enter; and sends a 120-line
  task that scrolls, one that collapses to a placeholder, and one that never
  shows (`typed: true`, pasted once, no Enter).
- `cargo test` covers the pipe names, `loomctl`'s own options and the hello
  check. `node src/cli.test.ts` covers pane references, key names, option
  parsing and folders relative to the terminal, and `node src/prompt.test.ts`
  the echo check and menu ids.
- `pty-close-check.mjs` still passes.
- A verbose `makensis` run lists `loomctl.exe` in the installer next to `loom.exe`.

## Not done yet

- **A live event stream** (`loomctl watch`) that prints state changes as they
  happen. `wait-any` covers the common case.
- **Git from the Changes panel:** stage, commit and push. `send` can type git
  commands into a shell pane meanwhile.
- **Agent groups, dictation, font size and file previews** have no commands.
- **An agent skill** that teaches Claude Code or Codex in a pane to orchestrate
  the others through `loomctl`.
- **Knowing a task finished, and how.** `wait` sees states (idle, waiting,
  exited), and Claude reads as idle after a short quiet spell, so a controller
  can't yet tell "done" from "paused", bind a wait to the send before it, or
  read a shell command's exit code (OSC 133 `D;<code>` is seen, not kept).
- **Retrying safely.** No caller request ids, so after a timeout a script has
  to look before sending or creating again.
- **Picking a Codex or OpenCode session from the terminal** when a restart
  needs one; it still takes the window.
- **Unnumbered menus.** `menu` reads numbered questions only. Claude's
  folder-trust prompt has no numbers, so it needs `keys` (down, enter).
