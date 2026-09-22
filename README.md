# Loom v3

A thread-driven agentic terminal workspace for Windows, shaped like Orca. A
**thread** is one branch of work in its own git worktree, with an agent running
in it: `claude`, `codex` or `opencode`. Threads sit in a sidebar grouped by
repo; the current one shows its panes, real ConPTY terminals, in a grid. Cut
as many threads as you like and every agent keeps running while you look at
another one.

Tauri v2 (Rust backend, system WebView2) + xterm.js. No Electron, no Node at runtime.

## Requirements

- **Windows 10/11** — WebView2 ships with Windows 11.
- **`claude`, `codex` and/or `opencode` on PATH**, whichever you cut threads
  with. `git` on PATH for worktrees.
- **VS Code (`code`)** on PATH for the `VS Code` button / `F5`. Optional.

## Install

Run the installer from `src-tauri\target\release\bundle\nsis\`. It is unsigned,
so SmartScreen will warn once — *More info → Run anyway*.

## Build from source

Needs Node 20+, Rust (MSVC toolchain), VS Build Tools with the C++ workload,
and CMake — whisper.cpp is compiled from source for dictation.

```
npm install
cd src-tauri && pip install --target .build libclang && cd ..   # once, see below
npm run tauri dev     # dev, hot-reloads the frontend
npm run tauri build   # release + installer
```

whisper-rs generates its bindings with bindgen, which wants `libclang.dll`. That
one pip command drops it (~80 MB, no admin, nothing system-wide) where
`src-tauri\.cargo\config.toml` already points `LIBCLANG_PATH`; a full LLVM
install works too and needs no config. The crate's own bundled fallback bindings
are Linux-generated and fail their layout asserts on MSVC, so bindgen has to run.

## Using it

`+ Thread` opens the new-thread form. **Open checkout** starts an agent in
the existing folder. **Create worktree** creates a separate folder and branch.
Pick a project or browse to one, choose an agent, and give worktrees a thread
name. **Advanced options** contains the base ref and pane count. Loom
creates the branch `loom/<name>` off the base (HEAD when blank) and checks it
out as a worktree under `~\loom\<repo>\<name>`, then starts the agent there.
A name that is already a branch or a folder gets `-2`, `-3` appended, the way
Orca names a second worktree, so the base you asked for is always the base you
get. To continue an existing branch, put it in the base field. A base that
names nothing, locally or on origin after a fetch, is taken as a new branch
name: the thread is created on that branch, off HEAD. Spelling it like a
remote ref (`origin/x`) that isn't there is refused as a typo. **Open checkout**
also supports folders that are not Git repositories.

The sidebar lists threads under the project they came from, and under each
thread one row per pane, the way Orca lists agent sessions under a worktree:
the provider's mark, the agent (`claude`, `codex`, `opencode`, `shell`) and
whatever it titled itself. Projects fold on click and threads fold on their
`▾`; both orders change by dragging a row up or down its list, and all of
that is remembered. The box at the top filters threads by project, name,
branch, agent, or agent title. Project headings contain indented threads or
checkouts, with their agents and terminals nested below. Filtering reveals
matching threads even when their project is collapsed.

`1 waiting` in the top bar counts panes waiting on you across
every thread. Click it to choose an agent from the waiting list, or press `F3`
to jump to the next one. Choosing an agent reveals its terminal and clears
only its waiting indicator. Every
row has a dot: pulsing while that agent is working, yellow when it has finished
a turn and is waiting on you, red when it has exited. The thread's own dot is
the worst of its panes. Clicking an agent row focuses that pane; if the thread
is zoomed, the zoom moves to it, so a zoomed thread reads one agent at a time.

Threads, branches, and panes come back on the next launch. Claude keeps its
pinned session ID. Codex and OpenCode report their actual session IDs, so two
panes in the same folder resume separate conversations. Loom never falls back
silently to a fresh conversation after a resume error.

Codex reports its thread through its `notify` setting, which Loom passes on the
command line: after every completed turn a script records the thread for that
pane. Nothing to trust or enable. OpenCode uses Loom's local plugin.

Older panes have no verified session ID and show **Choose session** in the
pane, which lists the folder's conversations for that agent.
Choose the previous conversation once, and Loom remembers it. Closing an active pane or discarding changes uses
a themed in-app confirmation, with Cancel focused by default.

When an agent quits, the pane says `[exited N] — Enter relaunches`, and Enter
brings it back into the same session. Agents no longer run inside a PowerShell:
`claude.exe` runs bare and the npm-shimmed `codex` and `opencode` run under
`cmd.exe`. That is where most of the memory went. A PowerShell host is about
65 MB per pane; cmd is 4 MB. Shell panes still get PowerShell with the OSC 133
integration below.

| Action | How |
| --- | --- |
| New thread | `+ Thread`, then Open checkout or Create worktree |
| Switch thread | click its row, or `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Choose a waiting agent | click the waiting count |
| Preferences | `⚙` in the top bar |
| Add / close a pane | `+` on the thread bar, or `✕` on the pane header |
| Relaunch a dead pane | focus it and press Enter |
| Resize panes | drag the gap between them |
| Move a pane | drag its header onto another pane — they swap |
| Dictate into the focused agent pane | hold `F4` and talk, or click `◉ speak` |
| Zoom a pane | `F2`, double-click its header, or `⛶` |
| Jump to a pane waiting on you | `F3` |
| Scroll a pane | `Alt+Shift+↑` / `Alt+Shift+↓`, or the mouse wheel |
| Open the thread in VS Code | `F5` or the `VS Code` button |
| Thread actions | `⋯` on its row or in the thread bar, or right-click the row (rename lives here) |
| Fold / reorder the sidebar | click a project, `▾` on a thread; drag a row to move it |
| Filter threads | the search box above the list |
| Show / hide the sidebar | `Ctrl+B` |
| Move focus between panes | `Ctrl+Alt+←↑↓→` |
| Jump to a thread | `Ctrl+1` … `Ctrl+9` |
| Font size | `Ctrl+=` / `Ctrl+−` / `Ctrl+0`, or `Ctrl+wheel` over the panes |
| Every shortcut | `F1` |
| See what changed | `⎇` in the thread bar (the number is files touched) |
| Close a thread / delete its worktree | `⋯` → Close, Delete worktree (keep branch), Delete worktree and branch |

Up to **16 panes** per thread. The top bar contains the dictation language, prefix,
and pane layout controls. Layout options are columns, rows, and grid.
The grid reduces its column count in narrower windows. At phone
widths, panes stack vertically and the project sidebar becomes a drawer.

### Changes

`⎇` in the thread bar (or `Ctrl+Shift+G`) opens the changes panel on the
right, laid out like Orca's: **Create PR** (pushes the branch and opens
GitHub's compare page against the remote's default branch), the branch with
its `+added −deleted` against HEAD, the upstream it tracks, a message box with
**Commit** (`git add -A` then `git commit`; `▾` adds "Commit all & push"), then
Changes, Staged changes and Untracked files, each folding, each a folder tree
with counts, each file with its line counts and status letter, and each with a
**View all** that opens the whole section as one diff. Commits sits folded at
the bottom; a commit opens as its own diff.

A diff opens as a **tab** beside the panes, the way Orca does it: the strip
above the stage shows `▦ <thread>` for the panes and one tab per diff, with
old and new line numbers in the gutter. Tabs re-read git every time they are
shown, so they never go stale behind a refresh. **full file** in the diff
header switches between git's hunks and the whole file with the changes
marked in it; the choice sticks across diffs and restarts.

The panel's **Files** tab lists every file in the thread's folder, the way
Orca's does: what git tracks or would track (so nothing ignored), or the folder
itself when it is not a repository. Folders fold, and a file opens as a tab
beside the panes with line numbers; right-click copies its path or opens it in
VS Code.

Every thread row in the sidebar carries the same `+N −M`, refreshed every ten
seconds, so a thread with work in it reads as such before you open it.

### Deleting a worktree

`⋯` on a thread row (or right-click it, or `⋯` in the thread bar) lists Close
thread, which leaves the folder and branch alone; Delete worktree (keep branch),
which runs `git worktree remove --force`; and Delete worktree and branch, which
also runs `git branch -D`. Each asks first, and the dialog counts what exists
nowhere else: uncommitted files in the worktree, and for a branch delete the
commits no other branch or remote holds. The thread's panes are closed
before git is asked, since a folder with a shell still in it cannot be removed.

### Shell panes

A plain shell pane is PowerShell with `src-tauri/src/shell-init.ps1`
dot-sourced, which emits OSC 133 marks around every command. All Loom does
with them is the pulsing dot in the pane header while a command runs; the
Warp-style command blocks an earlier README described were never built.

## Dictation

Hold `F4`, talk, let go — or click `◉ speak` in the workspace bar, which toggles
instead of holding. A rising blip marks the mic opening and a falling one marks
it closing, so push-to-talk needs no eyes on the toolbar. whisper.cpp
transcribes on this machine; nothing leaves the box, and none of Handy's other
half applies — no global hotkey, no system-wide text injection — because Loom
already owns the pty.

The prefix dropdown in the top bar picks what gets typed into the pane the moment recording
starts, and the transcript lands after it. It's the same dropdown as the startup
menu: click a prefix to use it, `⏎` on a row to make *that* prefix send itself
as soon as the transcript arrives, `✕` to drop it, or type a new one into the
box. Prefixes without `⏎` wait for your Enter, so you can fix the one word it
got wrong first; `(no prefix)` dictates a bare message. The list and your pick
are saved in `workspaces.json`.

Both the button and `F4` type into agent prompts only: they need a pane whose
agent is still running, and the button dims when the focused pane is a shell
or a dead pane. Say nothing and the prefix is
backspaced away again rather than left sitting in the input.

First use downloads `ggml-base.bin` (~142 MB) into `models\` next to
`workspaces.json`. Drop any other `ggml-*.bin` in there and it wins instead —
`ggml-large-v3-turbo.bin` is the upgrade when base fumbles your flags and paths.
Language is detected per clip; pin `LANG` in `src-tauri/src/dictate.rs` if you
only ever dictate one.

The button reads `◉ listening` in red while recording and `◌ working` while
transcribing, or `⚠ mic` with the reason in its tooltip when something fails.
Text lands in the pane that was focused when you started talking, so clicking
around mid-sentence doesn't misdeliver it, and leaving the window counts as
letting go of `F4` — an alt-tab can't leave the mic open behind your back.

What counts as speech is whisper's own `no_speech_prob`, not a loudness
threshold — a quiet room here measures rms 0.02, louder than a soft-spoken
sentence somewhere else, and without that check whisper answers room tone with a
confident "Yes." or "Thank you.".

## Model and effort per pane

The `⚙` on a claude pane's header sets its model and effort: picking from a
dropdown types the matching `/model` or `/effort` into the pane and watches for
Claude Code's confirmation. Picks made mid-turn are queued by claude itself and
show `sent — waiting for claude to confirm` until they land.

What the panel reports as current comes from a statusline tee: Loom's
`--settings` points `statusLine` at `loom-status.ps1`, which drops the payload
Claude Code pushes on every state change into `%TEMP%\loom-status\<pane>` and
then chains to whatever statusline you configured, so your own bar draws
unchanged. That marker follows a `/model` typed by hand the moment it runs;
the transcript, which only learns at the next turn, is the fallback.

## Context and plan usage

Every claude pane's header carries a **context gauge** — `NN%` of the model's
window, filling as its background, amber past 70% and red past 90%, which is
about where Claude Code starts compacting on you. Hovering gives the turn count
and the token split; clicking opens that pane's **context profile**, above a list
of every live session so you can see which pane is doing the spending and jump
straight to it.

The profile has two exact readings and one estimate. Exact: the window's size at
every turn, drawn as a sparkline scaled to the session's own peak, with a dashed
red rule wherever a compaction cut it — `peak 241k · 2 compactions, 365k evicted`
comes straight out of the `compact_boundary` records Claude Code writes. The
estimate is the stacked bar below it: which origin produced the session's tokens,
at 4 chars a token, one slice per tool plus thinking, your prompts, and each kind
of injected context (skill listings, hook output, file attachments).

That last one is **what each origin produced over the session, not a breakdown of
what is in the window right now** — the panel says so, and the distinction is
real. Claude Code prunes the request it actually sends, and the transcript
records nothing about what it pruned: measured here, a session's log summed to
3.4M tokens against a live 716k window, and no recency rule fits (the reach back
to a real context ran 7%–48% of the messages across four sessions). Splitting the
live window would mean guessing at an undocumented pruner and breaking on the
next Claude Code release. "Which tool is generating the material you keep paying
to re-cache" is the question that stays answerable, so it is the one asked.

Reading a whole transcript is not something to do on a timer, so the profile is
read once when the panel opens, while the 4s gauge poll keeps skipping every line
without `"usage"` in it.

Numbers come from Claude Code's own transcript (`~\.claude\projects\<slug>\<sid>.jsonl`) —
each pane already boots with its own `--session-id`, so nothing extra is
recorded to find one. Polling folds in only the bytes appended since the last
pass. Subagent turns count toward tokens but not toward the pane's context,
since a sidechain carries a window of its own.

The `◔ NN%` chip in the top bar is the account's **5-hour session limit**, the
same number Claude Code's `/usage` shows; click it for the weekly ones. It asks
the endpoint the desktop app asks — the copy cached in `~\.claude.json` goes
stale for days — using the OAuth token `claude` already signed in with. Polled
every five minutes because that endpoint rate-limits hard, and a failed refresh
keeps the last good numbers with the reason underneath rather than blanking.
Preferences → Plan usage turns the Claude and Codex chips off; while off, Loom
draws neither and never calls either usage endpoint. Turning it back on
fetches both at once. The per-pane context gauges read local transcripts and
stay either way.
The pane config panel's model list is fetched live too, so a model Anthropic
adds shows up without a Loom release.

## Turn-finished notifications

When an agent finishes a turn or wants your input, the pane **border turns yellow**
(`NN · waiting` in its header), the thread's dot in the sidebar goes yellow, and
Loom plays a short blip. Typing in the pane or focusing it clears all three.

Each agent says "done" its own way, and Loom listens to all of them:

- **codex** is launched with `-c tui.notifications=true`, `notification_method=osc9`
  and `notification_condition=always`, so it writes an OSC 9 sequence into the
  pane when a turn ends or it wants an approval. No files, no hooks.
- **opencode** loads local plugins from `~\.config\opencode\plugins\` and from
  nowhere else, so the first opencode pane installs `loom.js` there. It writes
  the wake marker below on `session.idle` and does nothing outside a Loom pane.
- **claude** uses hooks, below. Terminal BEL and OSC 99 (kitty notifications)
  count too, for anything else that rings.

While an agent is drawing output the pane and its thread show as running. There
is no protocol for "working", so this is output that keeps coming, ended by
1.5 s of quiet; the echo right after a keystroke does not count.

Loom sets `LOOM_PANE` in every pane, and Claude's hooks drop a marker file named
after it, which Loom drains every 250ms. A hook can't signal the pane directly —
a BEL written to `CONOUT$` is swallowed by conhost and never reaches ConPTY —
so this is the same marker-file trick `aa` uses with `WEZTERM_PANE`. Add to
`~\.claude\settings.json` under both `Stop` and `Notification`:

```json
{
  "type": "command", "shell": "powershell",
  "command": "if ($env:LOOM_PANE) { $e = ''; try { $e = ([Console]::In.ReadToEnd() | ConvertFrom-Json).effort.level } catch {}; if (-not $e) { $e = \"$env:CLAUDE_EFFORT\" }; New-Item -ItemType File -Force -Path \"$env:TEMP\\loom-wait\\$env:LOOM_PANE\" | Out-Null; if ($e) { Set-Content -LiteralPath \"$env:TEMP\\loom-wait\\$env:LOOM_PANE\" -Value $e -NoNewline } }"
}
```

The marker's content is the session's effort level (from the hook payload, env
var fallback): resuming restores the model but not the effort — Claude Code
reads that from global settings — so Loom saves the last reported level per
pane and re-pins it with `--effort` on the next launch.

Without the hooks the cue still fires, but only off Claude's own bell — which
waits for a hardcoded ~60s idle delay (and effort re-pinning has nothing to go on).

## State

- Release builds: `%APPDATA%\dev.ayoub.loom\`
- Debug builds (`tauri dev`): `%APPDATA%\dev.ayoub.loom-dev\`

Split so an installed release and a dev session can run side by side without
overwriting each other.

Loom restores the selected project, thread, and pane, pane zoom and split sizes,
open diff tabs, per-thread commit drafts, and sidebar and Changes panel visibility.
It also remembers collapsed groups, the sidebar filter, and its scroll position.
Changes are saved during use, and closing waits for the final workspace save.
Temporary menus and confirmation dialogs do not reopen.

- `workspaces.window.json` stores the window position, size, maximized state,
  and fullscreen state. An explicit profile has its own adjacent `.window.json` file.
- `workspaces.json` — threads (repo, worktree, branch, panes with their
  sessions), known repos, the startup list. Hand-editable (no BOM — the loader
  strips one, but PowerShell's `Set-Content -Encoding utf8` adds it and other
  tools may not cope). An older file with `spaces` in it loads as threads on
  the checkouts themselves.
- `shell-init.ps1`, `loom-status.ps1`, `claude-hooks.json` — rewritten from the
  binary whenever they differ; edits are lost.

Every pane gets `TERM=xterm-256color`, `COLORTERM=truecolor` and
`TERM_PROGRAM=Loom`, the way any terminal announces itself, and loses
`NO_COLOR` and Claude Code's own session markers (`CLAUDECODE`,
`CLAUDE_CODE_*`) if Loom happened to be launched from inside an agent or a
tool that sets them. Without that a claude in a pane draws in monochrome, or
takes itself for a child session and stops saving its transcript.
- Worktrees live in `~\loom\<repo>\<thread>`.

## v3 limits

- Windows only (ConPTY, `cmd.exe` / `powershell.exe`, hardcoded).
- Create PR knows GitHub remotes only; other hosts get the error in the panel.
- Startup commands are split on whitespace: no quoted arguments in the list.
- Codex panes override a `notify` program set in `~/.codex/config.toml`.
- Hidden threads keep their xterm buffers; agent panes cap scrollback at 1500
  lines to hold that down.
- Pane layout weights reset when the grid changes shape, including after a resize that changes its column count.
- A block's accent bar is only drawn while its first line is on screen.
