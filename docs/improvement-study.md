# Loom improvement study

2026-10-06, at `80155bf`. I read the code, the four earlier idea lists (09-09 twice, 09-22, 10-05), the
session history for what you decided, and the current docs and changelogs of about twenty competing
tools. Each proposal says whether it is new or was proposed before, and what happened to it.

Sizes: S is a day or less, M is two to four days, L is one to three weeks.

## Short version

- **Loom is strong where it is different.** It runs on Windows, and Conductor, Superset and cmux
  don't. Few rivals answer an agent's menu from a list or keep an always-on-top window of
  waiting agents. Your phone app is served by Loom over Tailscale with no hosting. Only Paseo
  does something similar.
- **The other tools have moved to the start and end of a thread.** Seven of them run a setup
  script when they create a worktree. Eight send diff line comments to the agent. Loom creates a
  worktree with `git worktree add` and nothing more (`src/main.ts:6561`). Its last step is
  opening GitHub's compare page.
- **You don't land through pull requests, so don't copy the PR/CI loop.** `main` is 244 commits
  ahead of `origin/main`. Threads land by fast-forward into the root checkout, then
  `npm run update` and Restart. The landing feature you'd use is a local one.
- **The review/fix loop still runs outside Loom**, in the loom-operator skill, driven by a Claude
  Code session whose watchers die when memory runs low. That was bet A on 10-05, and nothing has
  moved on it.
- **Four code-health items from 10-05 are still open.** These are one input path, one busy rule,
  `npm test`, and an async `cli_reply`. The phone polls Loom every second now, so a blocked
  window thread freezes it as well.

My order: `npm test` and the async reply first, then setup on cut, behind/overlap marks, Land,
diff comments to the agent, and `submit --after`. Section 7 has the plan.

## 1. Where Loom stands

### Shipped from the earlier lists

| Proposed | Shipped as |
|---|---|
| Dirty-worktree delete guard, 09-09 | Inventory dialog (`c14e316`), then the trash with `refs/loom-trash` (`cbb9ede`, `0ceb75e`) |
| Install Claude's hooks for you, 09-09 | `claude-hooks.json` passed with `--settings` at spawn (`src-tauri/src/lib.rs:25`) |
| Keep the PC awake, 09-09 | `src-tauri/src/awake.rs` |
| A CLI in every pane, 09-09 | loomctl, on PATH in every pane |
| `loomctl reply`, 10-05 | `loomctl messages` (`src/main.ts:8488`) and `read --menu` |
| Phone push from Loom, 10-05 | Web Push from task notices (`f7e8161`) |
| Phone page, bet C on 10-05 | Four-tab phone app (`483eef0`), restart from the phone (`e08eae0`) |
| Stable pane names, 10-05 | Partly: a `stableId` that follows restarts (`9bc0f33`), but no name you choose |

### What Loom does that most rivals don't

- **Windows.** Conductor is Mac only, Superset is Mac with experimental Linux, cmux is macOS.
  On Windows your competition is Orca, Emdash, the Codex app, Claude Code desktop and Cursor.
- **Menus answered from anywhere, safely.** The Overview, the phone and `loomctl choose --menu`
  all refuse a question that changed since you read it.
- **The overlay.** A window of waiting agents above other apps that never takes the keyboard.
- **A phone app with no server bill.** Orca, Conductor, Superset and Nimbalyst ship store apps.
  Yours is a page Loom serves, carried by Tailscale.

### Decided against, so not proposed here

- A mirror of Loom's window on the phone. You rejected Full Loom (43220ab2, turn 295), and
  `483eef0` removed it.
- The frameless title bar, reverted by `8a29016` because its controls are hard to tap from the
  phone.
- `loomctl trash restore`, removed on purpose in `5173850`.
- Context % on the overlay and Overview cards. You wanted to see the prompt and how long it has
  been working (a3889c40, turn 855).
- Anything with a hosting fee (ae9721e7, turn 50).
- ntfy, and relying on Claude Code's own push. Loom's Web Push replaced both.
- Loud themes.

## 2. The start and end of a thread

### 2.1 Setup on cut

Size S. Proposed 09-09 and again 09-22, not built.

When Loom creates a worktree, it should copy the gitignored files the repo lists, then run the
project's setup command. A fresh worktree has no `node_modules` and no `.env`, so an agent's first
turn goes on finding that out. Seven of the tools I surveyed do this (Orca, Conductor, Superset,
Codex, Emdash, Agentastic, Claude Code).

The small version needs no new config format.

- **Files to copy.** Read the repo's `.worktreeinclude`, the file Claude Code and Orca already
  use, written in gitignore syntax. In the root checkout,
  `git ls-files --others --ignored --exclude-from=.worktreeinclude` lists exactly the files to
  copy.
- **Setup command.** One string per project, saved with the project in `workspaces.json` and set
  from the project's `⋯`. Loom opens a shell pane named `setup` in the new thread and sends the
  command with `--receipt`. The agent panes start once the receipt reports success. On failure the
  pane stays open with the output, and the agents start anyway with a notice.
- **No junctions.** Don't link `node_modules` back to the root checkout. `git worktree remove`
  empties junction targets (the junction trap in memory). The trash moves junctions safely today,
  but one regression there would delete the root checkout's dependencies. Copy or install.

It goes in `createThread` after `worktree add` (`src/main.ts:6561`) and before `openThread` starts
the panes. Skipped: Orca's and Conductor's archive scripts. Add one when something needs tearing
down.

### 2.2 A port block per thread

Size S. Proposed 09-09, not built.

Set `LOOM_PORT` in each pane's environment, next to `LOOM_PANE` (`src-tauri/src/lib.rs:350`). It
would be 4100 plus 10 times a slot number stored on the thread, so each thread gets ten ports.
Conductor does the same with `$CONDUCTOR_PORT`. It only helps when the dev command reads it
(`vite --port $env:LOOM_PORT`), so it belongs with 2.1's setup command. Build it the first time two
threads start dev servers at once.

### 2.3 Land, locally

Size M. A local version of 09-09's "land and clean", not built.

Today a thread lands like this: fast-forward `main` in the root checkout, build with
`npm run update`, Restart, then close the thread and delete its worktree and branch. You type or
prompt each step. A Land action on the thread's `⋯`, plus `loomctl land <thread>`, would do the
following:

1. Refuse while any pane in the thread is working.
2. Refuse when there are uncommitted files, counted the way the delete dialog counts them now.
3. If the branch doesn't contain the base's tip, offer Rebase in the thread's worktree. A
   conflict stops there, and the Changes panel already has Continue, Skip and Abort.
4. Run `git merge --ff-only <branch>` in whichever checkout has the base checked out, found with
   `git worktree list --porcelain`. Git refuses on its own to overwrite untracked files during a
   merge, so the root checkout's untracked studies and reviews are safe. Ignored files get no such
   protection, so Land should refuse when the branch adds a path that exists there as an ignored
   file.
5. Run the project's optional after-land command, which for Loom is `npm run update`, in a shell
   pane of the base's thread.
6. Close the thread with "delete worktree and branch". The folder goes to the trash, as it does
   today.

Why local and not PR/CI: Conductor's Checks tab and Claude Code's CI bar are the most-cited
features in the survey, but they serve a push-and-review workflow you don't use. If that
changes, `gh` is installed and signed in. `gh pr view --json statusCheckRollup` would add checks
to the Changes panel cheaply. Park it until then.

### 2.4 Behind base, branch drift, and shared files

Size S. Items 5, 6 and 7 of 09-09. Only partly there: the Changes panel counts ahead/behind
against the upstream (`src/main.ts:6459`). A `loom/*` branch that was never pushed has no
upstream, so the count is empty for most threads.

Threads don't remember their base. `createThread` has it and drops it, and `ThreadState`
(`src/main.ts:5270`) has no field for it. Store it, then add to the once-a-minute
`pollStats(true)` pass (`src/main.ts:6481`):

- `git rev-list --count <branch>..<base>`, shown on the row as "12 behind main".
- `git rev-parse --abbrev-ref HEAD` compared with the thread's branch. On an open-checkout thread,
  an agent that ran `git switch` has moved every pane in that folder, and the row still shows the
  old name.
- `git diff --name-only <base>...<branch>` plus the uncommitted paths the poll already reads.
  Within each repo, intersect them across threads and mark rows that share a file, with the file
  and the other thread in the tooltip.

Superset added cross-workspace conflict detection on Sep 28. You often have three or more threads
on Loom itself (root, mobile, overviewv2 and others in history), and this is where those collide.
It costs three git launches per thread per minute.

## 3. Reviewing agent work

### 3.1 Diff comments sent to the agent

Size M. New.

Click a line in a diff tab, on the PC or in the phone's diff screen, and write a note. The tab
collects the notes, and Send types them into the thread's agent as one message:

```
Review notes on loom/setup-on-cut:
src/main.ts:6561  copy the .worktreeinclude files before the panes start
src/remote.ts:88  this loop keeps running while the page is hidden
```

Send goes through `submit`, so it gets a task id and refuses a draft or a question on screen. With
several agents in the thread, it asks which one. Eight surveyed tools have this (Orca, Conductor,
Superset, Claude Code, Codex, Vibe Kanban, Emdash, Copilot). It removes the step where you read a
diff in one place and retype what you saw into another. Notes live with the tab. Don't save them
until a restart loses a batch you cared about.

### 3.2 `submit --after`, then the loop in Loom

`--after` is size M, the loop is L. Item 2 and bet A of 10-05, not built.

`loomctl submit <pane> --after <task> <prompt>` queues a prompt that Loom submits when that task
ends `completed`, and drops it on `failed` or `unknown`. The queue lives in the task journal, so
it survives a restart. With Web Push shipped, each step can tell the phone. That alone runs a
review, then a fix, then a review, with no Claude Code session watching.

Then decide whether Loom should own the whole loop: a reviewer pane, a fixer pane, prompt
templates, a stop rule. Keep it to the one shape you run, review then fix then review.
Factory's Missions and Orca's task DAGs show how big this gets when it tries to be general.

### 3.3 Best of N

Size M, after 2.3. New.

Give the same prompt to N new threads off the same base, each with a different agent, put them in
a group on the Overview, land the winner and trash the rest. Orca, Cursor, Emdash and Copilot have
it. Loom has every part already: the new-thread form takes an agent and a pane count, groups
exist, and Land and the trash would cover the end. Once 2.3 exists this is mostly a form.

## 4. Unattended runs

### 4.1 Send when the limit resets

Size S. Item 9 of 09-09, not built.

Add `loomctl submit <pane> --at reset <prompt>`, plus a button on a waiting agent's card on the
phone. Loom already knows when each limit resets (`resetsAt`, `src/main.ts:1224`). The queued
prompt goes in the journal next to `--after`'s. None of the surveyed tools tie a prompt to the
plan limit.

For prompts on a clock, don't build an automations feature. Windows Task Scheduler running
`loomctl submit` already does it. Nine tools ship scheduled automations, and a recipe in
`docs/loomctl.md` covers what you'd use them for.

### 4.2 Stuck detector

Size S. Item 14 of 09-09, not built.

If an agent has been working for ten minutes and its transcript hasn't grown, mark the pane and
send a push. The usage poll already reads each transcript's new bytes every 4 seconds, so the
growth is known. A loop that burns tokens until you notice is the failure this catches.

### 4.3 Shell pane logs

Size S. Item 4 of 09-09, narrowed.

Agent scrollback stops at 1,500 lines and shell scrollback at 5,000 (`src/main.ts:1786`). For
agents, the transcript and `loomctl messages` already hold the real content. For shells, a long
build or test log is lost. Append shell panes' output to a rolling file of a few megabytes in the
data folder, and add an "open log" item to the pane menu. Skip agent panes: their raw output is
mostly redraw sequences.

## 5. Cheaper to change

These are from 10-05 and still open. Each takes a class of review findings off the table.

- **`npm test`.** Done: `"test": "node --test src/*.test.ts"` runs the 17 files in 6 seconds.
- **Async `cli_reply`.** Done: `cli_reply` and `cli_ready` are `#[tauri::command(async)]`, so a
  reply no longer queues behind other work on the window thread. It can't help if that thread is
  stuck outright, because WebView2 delivers the call on it. The 00:55 hang is still unexplained,
  and the phone now asks for the screen every second, so a stuck window freezes it too. The
  request timings from 10-05 item 9 would say which case it was. Size S.
- **One input path.** `keys()` (`src/main.ts:3614`) is the complete write. Loomctl's `keys` uses it
  (`src/main.ts:8665`), and so does the phone keyboard through it. The terminal's `onData`,
  dictation, `slash` and `Pane.run` each copy parts of it. F9, RF13 and C18 each came from one of
  those copies. Size M.
- **One busy rule.** The sidebar and the task sweep still judge "busy" differently. Use the
  agent's own signals first and the screen as a labelled fallback. Size M.
- **Small cuts.** `CODEX_HOME` is resolved in four places (`helper.rs:106`, `lib.rs:331`,
  `lib.rs:1172`, `usage.rs:1033`), and C15 came from them drifting. The 810 lines of themes at
  `src/main.ts:178` can move to `themes.ts`. `main.ts` is 9,700 lines.

## 6. What I'd skip

- **PR/CI loop and issue-to-thread.** You don't push or use issues. See 2.3 for the cheap way in if
  that changes.
- **An MCP server in front of loomctl.** Agents in Loom panes already have loomctl on PATH and a
  skill for it. An MCP server would be a second copy of the command table.
- **Cloud sandboxes, SSH worktrees, containers.** Your agents run on your PC by design, and cloud
  means paying for hosting.
- **Multiplayer and shared sessions.** You're the only user.
- **A chat view over the terminal.** It would mean parsing each CLI's output, version by version,
  the same trap as the screen regexes. The transcripts and `messages` already give the clean text.
- **A built-in browser with design mode.** Nine tools have one, and it's real. But your agents
  check UI with Playwright under your CLAUDE.md rule, so a browser tab in Loom would be for you
  alone. Add it if you notice yourself switching to Chrome to look at a thread's dev server. It
  pairs with 2.2.
- **Dictation, maybe.** Still undecided from 10-05. The phone keyboard has its own voice input. If
  you rarely hold F4 now, deleting `dictate.rs` also drops whisper-rs, cpal, and the CMake,
  libclang and pip build setup.

## 7. Suggested order

Week 1:

1. `npm test` and the async `cli_reply` with timings.
2. Setup on cut, 2.1.
3. Behind base, drift and shared files, 2.4.
4. Land, 2.3.

Week 2:

5. Diff comments to the agent, 3.1.
6. `submit --after`, 3.2. Run one real review round with it, then decide on the loop in Loom.
7. Send when the limit resets, 4.1, and the stuck detector, 4.2.

Fit the input-path and busy-rule work between features. Each is a contained refactor with
task-check's cases underneath it.

Build every feature as a loomctl command first, then add the PC button, then the phone screen
that calls the same command. That is how the phone got Changes, Usage and Settings in one day
(`483eef0`), and it keeps "every PC feature on the phone" cheap.

## Questions for you

1. Do you want pull requests and CI anywhere in this? If yes, Land grows a push, PR and checks
   path through `gh`.
2. How often do you still use F4 dictation?
3. Should Loom run the review loop itself, or stay a tool the loop drives?

## Sources

Earlier sessions: d0adbf61 (09-09 lists), ca7d1fff (09-22), d9b8fe4f (10-05 analysis), 43220ab2
(phone app, Full Loom rejected), a3889c40 (card contents), ae9721e7 (no hosting fees).

Competitors, checked 2026-10-06:

- Orca: https://github.com/stablyai/orca, https://www.onorca.dev/docs/model/worktrees
- Conductor: https://www.conductor.build/changelog.md, https://www.conductor.build/docs/reference/scripts,
  https://www.conductor.build/docs/reference/checks
- Superset: https://superset.sh/changelog
- Emdash: https://github.com/generalaction/emdash
- Nimbalyst: https://github.com/Nimbalyst/nimbalyst
- Paseo: https://www.paseo.sh/
- cmux: https://github.com/manaflow-ai/cmux
- Claude Code desktop and web: https://code.claude.com/docs/en/desktop
- Codex app: https://learn.chatgpt.com/codex/environments/local-environment,
  https://learn.chatgpt.com/codex/code-review
- Cursor: https://cursor.com/changelog/3-0
- Zed: https://zed.dev/docs/preview/ai/parallel-agents.html
- Factory: https://factory.com/news/factory-desktop
- Gone or fading: Terragon shut down, Vibe Kanban is sunsetting, Crystal became Nimbalyst.
