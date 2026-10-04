# loomctl: open bugs and gaps found on 2026-10-04

These came up while a Claude Code session drove Loom through `loomctl` for a whole day: prompting panes, waiting on tasks, opening and closing threads. The Loom that ran was the build installed on 2026-10-03 at 03:11, not main.

Anything main already fixes is left out. Main is at `38eaaca`, with the R1 fix still in progress. That excludes:

- the held Enter after a paste Codex or Claude draws late (`9c8573a`)
- Codex tasks ending `unknown` while Codex hides its status row (`04fea96`)
- narrow Codex panes shown as idle while working, because Codex cuts "esc to interrupt" short. `04fea96` makes `activity()` also read Codex's run state from its title (`src/main.ts:2052`). This only covers Codex panes started after the install.
- `send` not creating a task (`f80a83e`)

## Bugs

### 1. `window show` blocked every later request

`loomctl window show` didn't answer within 30 s. The next `loomctl status`, with `--timeout 120`, timed out too, and so did everything after it.

- Loom's main process used no CPU over 5 s. Its WebView2 renderer stayed alive, at about 12% of a core.
- Loom answered again about 10 minutes later, probably once the user touched its window. That isn't confirmed.
- Just before the call, another process had forced Edge to the foreground with `SetForegroundWindow`.

The command runs `w.unminimize().then(() => w.show()).then(() => w.setFocus())` (the `window` entry in the loomctl table in `src/main.ts`). The likely cause is `setFocus` waiting on Windows' foreground lock, with every request queued behind it. That isn't proven.

Wanted: a time limit on the focus step, and a stuck command that doesn't hold up the rest.

### 2. A task keeps the pane reference it was created with

Task `1d242584a50e4728` was submitted to `loom:4`. Closing `loom:3` and then `loom:1` renumbered that pane to `loom:3` and then `loom:2`. `loomctl task` kept printing "on loom:4", which by then named a different pane.

The task stores `ref: paneName(p)` once, when it's created (`src/main.ts:3924`). Pane references are positions, and they shift whenever a pane before them closes.

Wanted: work out the reference from the pane id when printing, and say so when the pane has closed.

### 3. A Claude task stayed `working` after its turn ended (not yet checked on main)

Task `dd6d1b5779f941b7` on the loom thread's Claude pane finished its turn around 02:40. The pane went to `waiting`, but the task never left `working`. Because of that, no notice went out, and `wait --task` ran until its 3500 s limit.

Several extra prompts reached that turn while it ran:
- two `loomctl send` notes
- several background-command reports from Claude Code, each arriving as its own UserPromptSubmit

After the turn, Claude Code also drew its "How is Claude doing this session?" survey. Dismissing the survey didn't release the task.

The likely cause is that the turn's Stop got tied to one of the extra prompts instead of the task. `f80a83e` changed how sends and typed turns become tasks, so reproduce this on the new build before fixing it.

### 4. `new` refuses folders that aren't Git repositories

`loomctl new C:\Users\ayoub\Videos\opencode\ideas` fails with "isn't in a Git repository" (`src/main.ts:7840`). The New thread dialog opens the same folder as a checkout, because `createThread` doesn't need Git when there's no worktree name. The same thing happened with `personal-portfolio`.

Wanted: require Git only when `--name` or `--base` asks for a worktree.

### 5. `menu` doesn't see Claude Code's session survey

Claude Code's "How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss" isn't seen as a menu: `loomctl menu` returns null for it. So `choose` can't answer it, while `keys <pane> 0` does. This is minor.

## What loomctl can't do yet

### 6. Show plan usage or banked resets

With `plan-usage` on, Loom fetches both accounts' limits, and `usage.rs` reads Codex's `rate_limit_reset_credits` too. The results only appear as chips in Loom's top bar.

Today's workarounds:
- `/usage` typed into a Claude pane
- `/status` typed into a Codex pane, which doesn't list banked resets
- the usage overlay's `providers.js`, for the resets' expiry dates

Wanted: `loomctl usage [claude|codex] --json`.

### 7. Show an agent pane's model, effort and context use

`panes --json` has the agent, state and title, but not the model, effort or context left. Those can only be read off each agent's status line, which gets cut short in narrow panes.

### 8. Start an agent with a chosen model or effort

`add --agent codex` has no `--model` or `--effort`. The workaround is `--cmd "codex -m gpt-6-astra -c model_reasoning_effort=high"`, which works because `agentOf` still sees a Codex pane. It needs each CLI's own flags, though.

### 9. Clear a draft

`send --replace` refuses to type over a draft, by design, and `keys` has no key that clears a line. A 26-character draft took 30 `backspace` keys to clear.

Wanted: `keys <pane> ctrl-u`, or `send --clear`.

### 10. End a stuck task by hand

No command moves a task to `cancelled` or `unknown` by hand. Task `dd6d1b5779f941b7` from item 3 is still `working`.

### 11. Wait on a task with a fallback

`wait --task` returns only when Loom ends the task. When Loom misses the end, as in item 3, it waits until its time limit.

The workaround was a shell loop that checks `task` and `panes` every 30 s. It gives up after the pane has been out of `working` for 90 s.

Wanted: an option like `wait --task ID --or-idle` that also returns when the pane leaves `working`.

### 12. Notify the session that runs loomctl without a running process

`wait` and `watch --follow` have to keep running. Claude Code stopped them five times today because memory ran low: 1.3 GB of 16 GB was free at the worst point. The Ash email reaches the user, but not the session driving Loom.

Wanted: some way for Loom to push task events to a local consumer without a long-lived client. Any version that runs a command needs a careful look at what it may run.

### 13. Read an agent's whole reply

`read --lines N` returns the screen as the agent drew it:
- wrapped at the pane's width
- tables broken across lines
- tool output folded to "+541 lines (ctrl+t to view transcript)"

Loom keeps only a hash of the final message (`response`), on purpose. Claude's Stop hook (`last_assistant_message`) and Codex's notify payload (`last-assistant-message`) both carry the text, so a `loomctl reply <task>` is possible if keeping that text locally is acceptable.

### 14. Tell which pane is zoomed

`threads --json` has `layout` and `front`, but nothing about zoom. After `show` on another pane, there's no way to tell whether the zoom moved or stayed.

## Problems outside Loom that affect loomctl

- **Git Bash rewrites a leading slash.** `loomctl send loom:2 "/clear"` typed `C:/Program Files/Git/clear` into the pane. Set `MSYS_NO_PATHCONV=1` when sending slash commands from Git Bash.
- **Claude Code stops idle background shells when memory is short.** That includes any `loomctl wait` watcher (item 12).
- **Windows Modern Standby pauses agent processes.** The log shows Kernel-Power 506 and 507 every few minutes. One review that took 18 minutes of work stretched over 6 hours of wall time. `loomctl set awake on` keeps the PC awake while Loom runs.
