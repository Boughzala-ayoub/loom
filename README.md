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
npm run tauri dev     # dev, hot-reloads the frontend
npm run tauri build   # release + installer
```

Both `npm run tauri` commands prepare `libclang.dll` before Cargo starts. New
worktrees reuse the DLL from the main checkout when available. Otherwise, setup
uses Python with pip to install `libclang==18.1.1` into the ignored
`src-tauri/.build` folder. Setup skips worktrees that already have the DLL and
respects an explicit `LIBCLANG_PATH`. No administrator access is needed.

Use `npm run tauri` so this setup runs. Before invoking Cargo or `npx tauri`
directly, run `node scripts/setup-native.mjs` from the repo root once per worktree.
The crate's own bundled fallback bindings
are Linux-generated and fail their layout asserts on MSVC, so bindgen has to run.

### Update the installed app while Loom is running

From this checkout, run:

```sh
npm run update
```

This builds the current code and replaces `%LOCALAPPDATA%\Loom\loom.exe`.
The running app and its terminals stay open. New features take effect on the
next normal launch. The command keeps the previous executable beside the new
one as `loom-before-update-<id>.exe` and prints its path. Backups are kept until
you remove them after the old Loom process exits.

For a custom installation directory or an existing build, use:

```sh
npm run update -- -InstallDir "D:\Apps\Loom"
npm run update -- -Source "C:\builds\loom.exe"
```

`-Source` skips the build. A failed build leaves the installed app unchanged.
The update command does not run the installer or restart Loom.

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

The sidebar lists threads under the project they came from, one line each:
the thread's name, a mark per agent, the lines it has changed, and how long
since anything drew. The thread you are on also lists one row per pane, the way
Orca lists agent sessions under a worktree: the provider's mark, the agent
(`claude`, `codex`, `opencode`, `shell`) and whatever it titled itself. Other
threads fold their agents into the marks, and clicking a mark opens that pane,
so thirty threads fit on one screen. A thread's chevron lists or folds its
agents by hand, and that choice sticks. Projects fold on click; both orders
change by dragging a row up or down its list, and all of that is remembered.
The box at the top filters threads by project, name, branch, agent, or agent
title, and reveals matching threads even when their project is collapsed.

`1 waiting` in the top bar counts panes waiting on you across
every thread. Click it to choose an agent from the waiting list, or press `F3`
to jump to the next one. `Ctrl+K` (or the search field in the top bar) lists
every agent in every thread, waiting ones first, then working, idle and exited;
type to filter by project, thread, branch, agent or title. Choosing an agent
reveals its terminal and clears only its waiting indicator. A thread's knot on
the sidebar rail is the worst of its panes: lit, with a light running down the
rail, while an agent works; yellow when one has finished a turn and is waiting
on you; red when all have exited. Agent marks carry the same colours as a dot. Clicking an agent row focuses that pane; if the thread
is zoomed, the zoom moves to it, so a zoomed thread reads one agent at a time.

**Overview** in the top bar lists every agent session. Shift+right-click
anywhere, or press `Ctrl+Shift+D`, to switch between it and your thread. It lists sessions across every open thread,
with waiting agents first, then working, idle, and exited sessions. Filter by
status or project, or search thread names, branches, agents, group names, and
terminal output. Expanded agent rows show your last message and the agent's last
message from its session. Shell rows still show terminal output. Every card also
shows the lines added and removed in its thread, and the groups its agent is in. Claude rows also show the model
and how full the context is, amber from 70% and red from 90%. A waiting agent's
row has a reply box: type an answer and press Enter to send it without opening
the terminal. Loom pastes the text and presses Enter only once the text shows up
on the agent's screen; otherwise it leaves the text there and tells you to open
the session. When the agent is showing a numbered menu instead, such as a
permission prompt, the row shows the question and one button per option. A
button moves the highlight with the arrow keys, checking the screen after each
step, and presses Enter once its option is highlighted. If the menu changes
first, nothing is chosen. Menus that take several choices have to be answered
in the terminal. After an answer, focus moves to the next waiting agent.
Click a row to preview that agent, or use **Next waiting** to open the oldest
waiting session matching your filters. `Up` and `Down` move between rows and
`Enter` previews the selected one. On a row, `R` jumps to its reply box or first
option and `Esc` comes back. `1` to `9` pick that option of a menu question, the
same number the agent shows, and `X` ticks the card.
`F3` follows those filters while the overview is open. **Compact view** hides
the inline messages so more sessions fit on screen. In compact view, click a row
to open its thread or the eye icon to preview the agent. Loom remembers this choice
and whether the overview was open.

Groups are lists of agents you name yourself, and one agent can be in several.
**Create group** picks a name and the members. Every card also has a group
button (a folder icon in compact view) that lists your groups. Click one to add
the agent or remove it, or type a new name and press Enter to start a group with
that agent in it. Each group gets its own filter beside the statuses.

**Select** puts a checkbox on every card and opens a bar at the bottom for the
ticked ones. **Add to group** puts them all in a group. The bar's message box
sends one message to each ticked agent that is waiting or idle, and the button
says how many that is. Loom can't tell a quiet agent from one that is still
thinking, so an idle agent may queue the message behind its work. Terminals are
left out, because Enter would run the text as a command. So are agents that are
working or exited, and agents showing a menu, where the text would pick an
option. Answer a menu from its own card. The bar names whoever it left out. Only
cards in view stay ticked. Filtering drops the rest, and they don't come back when you
clear the filter. `Esc` or **Done** leaves selecting.

The preview opens the live terminal in a centered modal. Opening it keeps the
agent's waiting alert; sending input clears it. Type, paste, select, and scroll
directly in the terminal. Esc goes to the agent while the terminal has focus.
The arrows in the preview header, or `Left` and `Right` when the terminal isn't
focused, switch to the previous or next session in the list. `F3` switches to the
oldest other waiting session.
Use the close button to return to the overview, or **Open thread** to switch
to its thread. The same pane returns to its original position, preserving the
running session. You can also stop its process after confirmation or relaunch
an exited session from the modal.
When a restored session needs a conversation selected, **Choose session** opens
the existing session picker.

Waiting means the agent signaled that a turn finished or input is needed. Working
uses Loom's existing activity detection. Idle means no work was detected, so a
quiet agent may still be thinking. The preview shows the live terminal. The time
beside each status counts from when the agent started waiting, started working,
went quiet, or exited.

**Agent overlay** (Preferences, off by default) is a small window that stays on
top of other apps. It lists the agents waiting on you, oldest first, and below
them the ones working, each with how long. A waiting agent that shows a
question, such as a permission prompt, has that question under its name.
**In background** shows it while Loom is minimized or behind another window and
something is waiting or working. **Always** keeps it up, over Loom too. It
never takes the keyboard from the app you're in.

Its height follows the list. Drag it by its header, and resize it from its
edges: the width stays where you leave it, and a height you drag to becomes the
most it grows to before the list scrolls. Loom remembers all three. Click an
agent to bring Loom back on the overview with that agent previewed, or the grid
icon for the overview alone. The close button hides it until you next switch to
or away from Loom. `node scripts/overlay-check.mjs` tests it in the real app;
it moves the mouse for about two seconds.

Threads, branches, and panes come back on the next launch. Claude keeps its
pinned session ID. Codex and OpenCode report their actual session IDs, so two
panes in the same folder resume separate conversations. Loom never falls back
silently to a fresh conversation after a resume error.

Codex reports its thread through its `notify` setting, which Loom passes on the
command line: after every completed turn `loom.exe --codex-notify` records the
thread for that pane. Nothing to trust or enable. Until that first turn ends, the
overview finds the conversation by the thread id Codex puts in the pane's title
(`tui.terminal_title`). OpenCode uses Loom's local plugin.

Older panes have no verified session ID and show **Choose session** in the
pane, which lists the folder's conversations for that agent.
Choose the previous conversation once, and Loom remembers it. Closing an active pane or discarding changes uses
a themed in-app confirmation, with Cancel focused by default.

When an agent quits, the pane says `[exited N] — Enter relaunches`, and Enter
brings it back into the same session. Agents no longer run inside a PowerShell:
`claude.exe` runs bare, `opencode` runs under `cmd.exe`, and an npm-installed
`codex` runs its native `codex.exe` directly. npm's shim would otherwise keep a
`cmd.exe` and a `node.exe` idle under every codex pane, about 25 MB between
them. A codex that `cmd` would resolve some other way (pnpm, bun, a `codex.exe`
earlier on PATH), or a startup line with `cmd` syntax in it, still goes through
`cmd.exe` as before. A PowerShell host is about 65 MB per pane. Shell panes
still get PowerShell with the OSC 133 integration below.

| Action | How |
| --- | --- |
| New thread | `+ Thread`, then Open checkout or Create worktree |
| Switch thread | click its row, or `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Choose a waiting agent | click the waiting count |
| Go to any agent | `Ctrl+K`, or the search field in the top bar |
| Preferences | `⚙` in the top bar |
| Add / close a pane | `+` in the thread strip, or `✕` on the pane header |
| Relaunch a dead pane | focus it and press Enter |
| Resize panes | drag the gap between them |
| Move a pane | drag its header onto another pane — they swap |
| Dictate into the focused agent pane | hold `F4` and talk, or click `Speak`; the language and prefix beside it are one click each |
| Zoom a pane | `F2`, double-click its header, or the zoom button on its header |
| Jump to a pane waiting on you | `F3` |
| Scroll a pane | `Alt+Shift+↑` / `Alt+Shift+↓`, or the mouse wheel |
| Open the thread in VS Code | `F5` or the `VS Code` button |
| Thread actions | `⋯` on its row or in the thread strip, or right-click the row (rename lives here) |
| Fold / reorder the sidebar | click a project, the chevron on a thread; drag a row to move it |
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

When controlling the PC from a phone, click the phone icon beside Preferences
to fit Loom to Galaxy A26 portrait proportions within the current monitor's
usable area. Click it again to restore the previous window size, position,
and maximized or fullscreen state. The sidebar closes in phone mode and returns
to its previous state afterward. Running panes stay open. On short monitors,
the window keeps enough width for the controls instead of preserving the exact ratio.

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
`--settings` points `statusLine` at `loom.exe --statusline`, which drops the
payload Claude Code pushes on every state change into `%TEMP%\loom-status\<pane>`
and then chains to whatever statusline you configured, so your own bar draws
unchanged. It runs about once a second across a dozen panes, which is why it is
loom.exe and not a script: ~35 ms a run, where the PowerShell it replaced took
over a second. That marker follows a `/model` typed by hand the moment it runs;
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

## OpenCode versions

Loom supports OpenCode 1.18.29+ and 2.x. `opencode`, `opencode1`, and `opencode2`
startup commands share the OpenCode integration while keeping the executable
you selected for launch, resume, session listing, and Overview messages. An
alias must be installed on PATH; Loom does not install the CLIs. The default
`opencode` command may point to either version, so Loom reads its actual version.

OpenCode 2 panes use `--standalone`. Its normal background service cannot carry
a separate Loom pane identity for each terminal. External `--server` connections
are rejected for these panes. V2 session reads also use a private server, have a
20-second deadline, and may take several seconds. V1 reads keep a five-second
deadline. Failed reads keep the previous Overview text and retry later.

The plugin is inert in session-list/export helpers and outside Loom. A new Loom
build installs its plugin when an OpenCode pane starts; an already-running v1
process may need a relaunch to load a changed plugin.

Compatibility checks, without model calls:

```powershell
node src/agent.test.ts
node scripts/opencode-plugin-check.mjs
node scripts/opencode-cli-check.mjs
# Against npm run preview:
node scripts/opencode-status-check.mjs
$env:OPENCODE_COMMAND = 'opencode2'
node scripts/opencode-status-check.mjs
```

The CLI check uses isolated config/data directories and tests the installed npm
packages. Set `OPENCODE_V1_EXE` and `OPENCODE_V2_EXE` for other install locations.
The V1 object-entrypoint requirement is documented in the
[OpenCode plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Turn-finished notifications

When an agent finishes a turn or wants your input, the pane **border turns yellow**
(`NN · waiting` in its header), the thread's dot in the sidebar goes yellow, and
Loom plays a short blip. Typing in the pane or focusing it clears all three.

Each agent says "done" its own way, and Loom listens to all of them:

- **codex** is launched with `-c tui.notifications=true`, `notification_method=osc9`
  and `notification_condition=always`, so it writes an OSC 9 sequence into the
  pane when a turn ends or it wants an approval. No files, no hooks.
- **opencode** gets Loom's plugin in its global config directory,
  `~\.config\opencode\plugins\loom.js`, or `$XDG_CONFIG_HOME/opencode/plugins/loom.js`.
  It writes
  the wake marker below when a turn ends (`session.idle` on 1.x, the
  `session.execution.*` pair on 2.x) and on a question, form or permission
  prompt (any of those blocks mid-turn and never goes idle), and does nothing
  outside a Loom pane.
- **claude** uses hooks, below. Terminal BEL and OSC 99 (kitty notifications)
  count too, for anything else that rings.

OpenCode's plugin reports Working and Waiting directly. Pending questions and
permissions stay Waiting until answered. Child-session completion cannot mark
the parent done. Other agents use terminal notifications and activity detection;
the echo right after a keystroke does not count as work.

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

## Control Loom from a terminal

`loomctl.exe` sits beside `loom.exe`, so it is on your PATH after installing.
It drives the running Loom: each command goes through the same code the
buttons use, and the window shows the result as it happens.

```
loomctl status                          # counts by state, and who is waiting
loomctl threads                         # every thread and its folder
loomctl panes                           # every pane as <thread>:<n>, with its state
loomctl read api-fix:1                  # what a pane shows, as text
loomctl read api-fix:1 --lines 200      # its last 200 lines, history included
loomctl send api-fix:1 run the tests    # type it, then Enter once it shows up
loomctl wait api-fix:1                  # block until that agent waits for you
loomctl menu api-fix:1                  # the whole numbered question on its screen, and its menu id
loomctl choose api-fix:1 2 --menu 3f9a01c2   # pick option 2, only if it is still that question
loomctl new C:\code\app --name login --agent codex   # a new worktree thread
loomctl add login --agent claude        # another agent in that thread
loomctl show login:2                    # bring it to the front
loomctl close login:2 --yes             # stop it and close the pane
loomctl --json panes                    # the same answers as JSON
loomctl info                            # which Loom answers: version, process, its own pipe
loomctl send api-fix:1 --receipt 'npm test'   # a token for wait --receipt
loomctl --key fix-1 submit api-fix:1 fix the login test   # a task id, once Enter went in
loomctl wait --task <id>                # until it finishes or asks for approval
loomctl watch --follow                  # every task's state changes as they happen
loomctl --key job-7 new C:\code\app --name login   # retried with the same key, runs once
loomctl help                            # every command the running Loom knows
```

A pane is `<thread>:<n>`, its id, or `.` for the pane in front. A thread is its
name, a unique start of it, or its id. Anything a button would ask about first
needs `--yes`: closing a pane whose agent is running, stopping or restarting a
running process, and closing a thread. `close-thread --delete worktree|branch` also refuses to lose
uncommitted files or unmerged commits unless you add `--force`. `send -`
reads the text from standard input and types it as it is, less one final line
break: text starting with `--` stays text. A command's options go after its name, in
any order around its arguments; after `--`, every word is an argument. A
relative folder, as in `loomctl new .`, is relative to the terminal you ran
`loomctl` in. Pane and thread ids last until Loom exits; names and numbers
change when you rename or reorder.

Text sent to a pane belongs to the session that was running when you sent it.
If the pane stops or restarts first, the send fails and nothing is typed into
the new session. `panes` shows each pane's `generation`, which goes up
whenever it stops or starts; `send`, `keys` and `choose` take `--gen N` to refuse a pane that
restarted since you looked. `send` presses Enter only once the text shows on
screen, which for a long task can be Claude's `[Pasted text #1 +120 lines]`
or Codex's `[Pasted Content ...]`. If it never shows, `send` fails but says
the text went in (`"typed": true`), so don't send it again: `loomctl read`
shows it and `loomctl keys <pane> enter` submits it. `keys` cut short by a
restart says which keys went in (`"pressed"`), since an Enter may have run
something.

`menu` prints the whole question as drawn, from the divider above it to the
last option's details, and an id for all of it. `choose --menu <id>` refuses
the question if anything in it changed, a path or command included, but not
if only the highlight moved.

For a shell pane, `panes --json` also shows how many commands finished since
it started (`commands`, the startup command included), whether the last one
`failed`, and its `exit` code, from Loom's PowerShell prompt, plus when the
pane last drew anything (`lastOutput`). `exit` is `null` when PowerShell can't
say which code: after a failing cmdlet, or a native command exiting with the
same code as the one before. `failed` is still right then. On a pane others
also type into, `commands` can grow for someone else's command, so use a
receipt (below).

For an agent pane, `turns` counts the times it finished or stopped to ask
since it started, from the agent's own signals (Claude's bell and Stop hook,
Codex's and OpenCode's notifications), not from the screen going quiet. A
turn counts only after new input, and only from the signal that counted the
pane's first turn since it started: one turn that rings both the bell and
the Stop hook counts once, even when the second arrives after your next task
went in, and Claude's idle reminder doesn't count. `loomctl wait <pane>
--turn-after N` returns when turn N+1 is in. If the signal that counts doesn't
also come for questions (say the bell rings when a turn ends but only the
Notification hook fires on a permission prompt), a question raises the alert
without finishing a receipt: a controller waiting on a receipt should also
watch for `wait --state waiting` and `menu`.

`send --receipt` prints a token, and `loomctl wait --receipt <token>` waits for
what that send started:

```
$r = loomctl send api-fix:3 --receipt 'npm test'
loomctl --json wait --receipt $r      # {"done":true,"failed":true,"exit":1,...}
```

In a shell, the token rides on the command line as a comment
(`npm test  # loom-receipt:<token>`), and Loom's prompt reports that line's
own exit code, so someone else's command on the same pane can't answer for
it. Only that comment at the very end of the line counts, and only from the
pane and the launch the receipt went to. It needs the PowerShell prompt
waiting for a command (`atPrompt` in `panes --json`): if a command sent just
before is still running, `send --receipt` waits up to 5 seconds for the next
prompt and otherwise fails with nothing typed. In an agent pane the receipt is
the first turn after your Enter, recorded when it comes in, with `asking:
true` if it stopped on a question; two callers sending to one agent at once
can't be told apart there, since it may answer both in one turn. A receipt
whose pane restarts, exits or closes before the outcome fails; one that
finished first keeps its outcome.

`submit` is `send` for handing over work: it refuses a draft or a question
on screen, answers with a task id once Enter went in, and the task moves from
`accepted` through `working` and `approval` to `completed`, `failed`,
`cancelled` or `unknown` on the agent's own reports (Claude's prompt, Stop
and permission hooks, Codex's turn notification naming the prompt, OpenCode's
plugin, a shell's exit code). Going quiet never completes a task. Loom keeps
tasks in a journal beside the workspace file, so ids, `--key` retries and
`watch` numbers survive a restart. `docs/loomctl.md` has the details.

`--key NAME` makes a retry safe: Loom runs each key once, and the same command
with the same key gets the first answer, waiting for it if it's still
running, so a `send` or `new` retried after a timeout doesn't run twice. The
same key with another command is refused. A key stays as long as its command
runs, and Loom keeps the last 256 to finish until it exits, however many are
still running: a slow command that finishes after newer ones counts as the
newest. With 1024 keyed commands still running, a new one is refused unrun.
Receipts work the same way: the last 500 to get an outcome stay, and `send
--receipt` refuses a new one while 2000 are pending.

With `--json`, every failure prints one JSON object: `code` (`usage`,
`not-running`, `busy`, `unreachable`, `version`, `connection`, `timeout` or
`failed`), `sent` (whether the command reached Loom; if it did, it may have
run) and `error`. `sent` is `false` only when nothing went out: a connection
that breaks while the command is being written counts as sent, although Loom
runs only a request that arrived whole.

Exit codes: 0 done, 1 the command failed, 2 Loom isn't running or is a
different version than `loomctl`, 3 no answer in time (`--timeout`: 30
seconds, an hour for `wait`). A timeout stops the waiting, not the command, so
a slow `new` or `close-thread` may still finish after it: check with `loomctl
threads` before trying again. Loom answers `loomctl`'s hello before any
command within 10 seconds or `--timeout`, whichever is shorter, or `loomctl`
gives up with nothing sent. After an update, restart Loom: until then the new
`loomctl` and the old Loom refuse each other before running anything.

Inside a Loom pane, `loomctl` is on the PATH and talks to the Loom that owns the
pane, so an agent can read other panes, start agents and wait for them. For a
profile launch (`loom.exe work.json`), pass `--profile work.json`.

Loom listens on a named pipe, `\\.\pipe\loom-<user>`, that only your Windows
account can open, and it refuses remote connections. A second Loom on the same
workspace doesn't take over the pipe, and each Loom's panes talk to it on a
pipe of its own (`...-pid<pid>`), so they never reach the other window. A
`tauri dev` build uses `loom-dev-<user>` and leaves the installed Loom alone.
`docs/loomctl.md` is the full usage guide, with recipes; `docs/cli-control.md`
has the design.

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
- `shell-init.ps1`, `claude-hooks.json` — rewritten from the
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
- Codex panes override `notify` and `tui.terminal_title` set in `~/.codex/config.toml`.
- Hidden threads keep their xterm buffers; agent panes cap scrollback at 1500
  lines to hold that down.
- Pane layout weights reset when the grid changes shape, including after a resize that changes its column count.
- A block's accent bar is only drawn while its first line is on screen.
