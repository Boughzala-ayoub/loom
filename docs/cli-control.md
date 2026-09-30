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

1. `loomctl <command> [args]` turns its words and `--options` into one JSON
   request and writes it to Loom's control pipe.
2. `control.rs` in `loom.exe` hands the request to the page as a `cli` event
   and waits for the page's `cli_reply`, up to the request's own timeout.
3. The page runs the command in `main.ts`'s loomctl section, with the same
   functions the buttons call: `createThread`, `revealPane`, `sendReply`,
   `choose`, `closePane`, `toggleDashboard` and the rest. That's why the window
   shows every change: nothing takes a separate path around the UI.
4. The answer goes back as `{ ok, data, text }`. `loomctl` prints `text`, or
   `data` as JSON with `--json`.

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

**Only your account.** The pipe's security descriptor grants your user SID and
SYSTEM and nobody else. The default descriptor for pipes also gives everyone
read access. Remote clients are refused. Anyone who can open the pipe can make
Loom start processes as you, so this is the boundary that matters.

**Panes find their own Loom.** Every pane gets `LOOM_PIPE` and Loom's folder at
the front of its `PATH`. `loomctl` in a pane reaches the Loom that owns that pane,
with no setup. This is what lets an agent orchestrate other agents: read their
screens, answer their questions, start more and wait for them.

**Confirmations become `--yes`.** Where a button asks first, the command refuses
without `--yes` instead of opening a dialog a script can't click. Deleting a
worktree also runs the dialog's own check for uncommitted files and unmerged
commits, and refuses if any would be lost unless you add `--force`.

**Waiting is a command.** `wait` and `wait-any` block until a pane reaches a
state. The page polls the state every 200 ms, because a state changes in a
dozen places. It answers with a timeout flag when time runs out, and `loomctl`
exits 3 for that. Waits get an hour by default and other commands 30 seconds.

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
  a timeout and a missing Loom.
- `cargo test` covers the pipe name and `loomctl`'s argument parsing, and
  `node src/cli.test.ts` covers pane references, key names and option parsing.
- `pty-close-check.mjs` and `ui-check.mjs` still pass.
- A verbose `makensis` run lists `loomctl.exe` in the installer next to `loom.exe`.

## Not done yet

- **A live event stream** (`loomctl watch`) that prints state changes as they
  happen. `wait-any` covers the common case.
- **Git from the Changes panel:** stage, commit and push. `send` can type git
  commands into a shell pane meanwhile.
- **Agent groups, dictation, font size and file previews** have no commands.
- **An agent skill** that teaches Claude Code or Codex in a pane to orchestrate
  the others through `loomctl`.
