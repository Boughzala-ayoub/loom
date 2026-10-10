# Loom full review, Claude Opus 5.5, second pass

Reviewed `main` at `6ffc85e` on 2026-10-08. This covers the whole app again. Most of the reading went to the 16,000 lines that landed after the last full review at `ef14290`: the trash, the phone app with push, dictation and the task manager, restart, the restyle and themes. The older code around them got read too. Seven reviewers split it by area: native core, deletion and install, the phone server, the phone page, the two halves of `main.ts`, and usage. I checked every finding below against the source at `6ffc85e` before keeping it. Where a finding says I reproduced it, I ran it myself, not just the reviewer.

The worst problem is old and cheap to fix. Codex and OpenCode panes start through `cmd.exe /c codex ...` with the thread's folder as the working directory, and cmd looks in the current folder before PATH. A `codex.cmd` or `opencode.cmd` in a checkout runs as you, before the agent starts and before Codex asks whether to trust the folder. An OpenCode one runs again on every Overview refresh. An agent that can write to its worktree can plant one and have Loom run it, outside any sandbox, the next time the pane starts.

Next comes a misread screen. `readMenu` takes the lowest highlighted numbered row on screen as a question. Claude and Codex both draw your sent prompt in the transcript behind the same cursor glyph. So a prompt whose first line starts with "1." reads as a two-option question for as long as it stays on screen. `submit` refuses, the task ends `unknown` instead of `completed`, and the Overview offers your prompt's lines as answer buttons. Related to it, a dictated message with a sending prefix presses Enter without looking for a menu, so a permission prompt that appears while whisper runs gets its highlighted Yes.

The phone page has four reproduced bugs where text goes to the wrong agent, stays behind after it was sent, or goes twice. One of them turns a second tap on Commit into `git add -A`. The phone server held up. Every API route except pairing checks the token first, and the pairing code allows five guesses in ten minutes.

The trash also held up. Nothing in it destroys what an approval kept, through junctions, redirected parents, a writer mid-move or a move across drives. Its failures are the other way round: a worktree under a junctioned folder can never be deleted (R12), and a half-finished move can leave a gigabyte folder that nothing in Loom will finish or purge (R13).

## Fix status

All 29 are fixed in the working tree on `main`, uncommitted. The user asked to fix everything and to change the UX where that improves it. Where a fix changes what you see, the table says so. "Fails first" means the check was also run on the old code and failed there.

| Finding | Fix | Check |
| --- | --- | --- |
| R1 | `codex` and `opencode` resolve from PATH only, in Rust, and cmd gets the full path (`with_program`, `on_path`). `codex_shim_dir` no longer looks in the folder. A program not on PATH fails the spawn by name. | `a_pane_command_runs_its_program_from_path_never_its_folder`, and the opencode tests with planted `.cmd` and `.bat` files |
| R2 | `readMenu` skips a numbered row with a live input drawn below it, and a numbered draft in Claude's own input box | four cases in `prompt.test.ts`, three fail first |
| R3 | A dictated send runs in the pane's input turn and never presses Enter on a question. The text then goes to the clipboard, with a toast. | traced; needs a live mic |
| R4 | The phone puts paths after `--` | remote-ui-check, fails first |
| R5 | Commit and Amend empty the box once they went, and the buttons stay locked while a commit runs | remote-ui-check, fails first |
| R6 | The list's highlight has its own variable, so New thread keeps each agent's draft | remote-ui-check at 375 and 1280 px, fails first |
| R7 | A clip waits for that agent's send in flight before it reads the box | remote-ui-check, fails first |
| R8 | An Activity reply can't go twice | remote-ui-check, fails first |
| R9 | `open_vscode` runs in the thread's folder | traced; a test would open VS Code |
| R10 | A model or effort pick refuses while the input holds a draft, with "its input holds a draft: send or clear it first" | traced |
| R11 | Records sharing a `message.id` count once, in totals and the sparkline | `a_message_split_into_blocks_counts_once` |
| R12 | A new worktree thread keeps the folder path git records, resolved right after `git worktree add` | `worktree_creation.test.ts`, a parent junction |
| R13 | A held Git record finishes on a later purge, and a hand-pruned one completes. close-thread reports `worktree: "pending"` with the trash path. | `a_held_git_record_finishes_on_a_later_purge_or_after_a_hand_prune` |
| R14 | Detached-HEAD commits count as lost in every delete mode, and a detached worktree keeps its branch name. Debug builds have their own trash. An unborn branch or a deleted repository no longer holds up deletion. `update.ps1` rolls back by copying. loomctl exits quietly on a closed pipe, `watch --follow` retries on a timeout, and `starting` is `busy`, not sent. docs/loomctl.md matches the code. | `main_cli.test.ts` 210; the deletion tests; a new `update-check.ps1` case that fails first; the debug `loomctl --version \| (exit 0)` exits 0 |
| R15 | Shift+Tab counts as an answer when the question names it. An approval whose question has been off the screen for 2 s works on. | traced |
| R16 | A pane's job ends its console processes and leaves GUI apps started from it (VS Code, a browser). A Loom crash now leaves console orphans. | `a_program_is_a_gui_app_or_a_console_one`, `a_pane_job_spares_the_gui_apps_it_opened` |
| R17 | Mouse motion and wheel reports pass through like focus reports | traced |
| R18 | Closing a pane in a thread you aren't looking at leaves its neighbour's alert | traced |
| R19 | A network or device path shows no link, and `read_image` refuses one | `links.test.ts`, `image_preview_reads_bytes_and_rejects_invalid_files` |
| R20 | Commands that change something take a thread's whole name or id, and say what a start would have matched. Reads keep the start. | real debug Loom: `read harn:1` works, `send harn:1` is refused |
| R21 | The PC's hunk Discard asks first, `git abort` and `skip` want `--yes`, and the phone's Skip asks | ui-check case at 768 px; real debug Loom; remote-ui-check |
| R22 | A commit from loomctl or the phone empties the PC's box only when it held that message | traced |
| R23 | `/api/pair` takes only `application/json`, addressed to 127.0.0.1, localhost, [::1] or a `*.ts.net` name | `pairing_takes_json_from_this_pc_or_the_tailnet_only`; remote-check pairs through it |
| R24 | Clip uploads have an idle deadline per read. `/assets/*.html` is 404. At most 8 connections without a token. Each phone has a record (name from its browser, paired, last seen), and a phone unseen for 90 days unpairs. `remote revoke <id>` removes one phone. The phone's Settings lists each phone with Remove, and Unpair all stops when the revoke fails. | the remote.rs tests; remote-ui-check, with the list at every width |
| R25 | `slug` names a project folder as Claude Code does, past 200 characters and outside the BMP | `long_and_astral_folders_are_named_as_claude_code_names_them` |
| R26 | `Pane.screen()` clamps to the width. Speak decides its step when it runs. The Changes selection clears on a thread switch. On the phone: a late context reply is dropped, Fit Loom to phone uses `show`'s answer, and Send is per agent. | remote-ui-check for the three phone items, fail first; the rest traced |
| R27 | A second failed close asks to close without saving. A restart is refused while a close runs. A restart is armed and starts once Loom has exited (`relaunch`, `relaunch_cancel`). A thread made during startup's restore is new, panes and all. | `shutdown.test.ts`; real debug Loom restarted by `loomctl relaunch` and from the phone |
| R28 | The plan poll reads anew on each 5-minute tick, and "Updated" shows when the numbers were read. A Codex rollout's first line may be 1 MiB, and a miss waits 5 minutes. The phone's Usage tab doesn't ask the accounts while Plan usage is off, and offers to turn it on. The gauge repaints on a window change. A complete line that isn't UTF-8 is skipped. | `main_cli.test.ts` 211; the usage tests; remote-ui-check |
| R29 | The pipe name comes from the account's SID. A child is killed when its spawn fails after it started. A pane spawned without a launch gets no inherited `LOOM_LAUNCH`. The PC window has a CSP. Tauri hashes inline scripts into `script-src`, and `style-src` keeps `'unsafe-inline'` with its hashing off, because xterm adds style elements as it runs. | `the_name_is_this_accounts_sid_not_its_user_name`; real debug Loom: an inline script is blocked, and a reload logs no violations |

A Codex review of these 29 changes found four regressions in them, all fixed in the working tree, each with a check that fails on the code before its fix:

- A phone unseen for 90 days could still get in, and its request then counted as seen, so it never expired while Loom stayed open. `remote.rs` `admit` now refuses it by the later of its saved and in-memory times before the request counts, and unpairs it at once. Test: `a_phone_unseen_too_long_cant_come_back_by_asking`.
- After an update, the new `loomctl` couldn't find a Loom still running under the pre-SID pipe name. It now tries Loom's own name, then that older one, only when the first doesn't exist, with the same owner check and hello. `LOOM_PIPE` stays exact. Test: `a_loom_from_before_the_sid_names_is_found_after_an_update`.
- A Codex rollout found with its first line still being written was taken for a miss, so its usage stayed hidden for 5 minutes. The reader now marks it as unfinished, the poll keeps its path and reads it again on the next poll, and only an absent file goes back to discovery. Test: `a_rollout_found_with_its_header_unfinished_reads_on_the_next_poll`.
- The plan poll could ask a provider again up to 10 s before its cooldown ended, measured from the ask rather than the answer. A provider's cooldown now holds every caller to the ms, from its answer, and only the 5-minute floor has slack. Test: `main_cli.test.ts` 212.

Running the full `scripts/task-check.mjs` then showed one case that R2 broke in the check itself, not in Loom: its fake Claude drew a question above a live input box, which real Claude never does (its permission prompt and AskUserQuestion take the box's place, as `prompt.test.ts`'s captured screens show). The fake now draws the question in the box's place, and all of task-check passes.

## Status of earlier findings

Every finding in the 2026-10-05 full review (C1 to C18, F7 to F19) and the 2026-10-06 phone review (P2-1 to P3-5) has a fix commit, and the reviewers found each fix in place in their areas. Two are incomplete:

- C18. `09cad2f` moved the config panel's `/model` into the pane's input turn, but dictation's automatic Enter still runs outside it (R3).
- C13. The pruning against the live-session set wasn't done. `03eea16` releases a large record's buffer, so the 128-entry bound is now cheap, and I'm not reopening it.

## Baseline

At `6ffc85e`: `tsc --noEmit` passes, `npm test` passes (17 files), and `cargo test` passes (122 passed, 5 ignored). After `npm run build`, `scripts/remote-ui-check.mjs` passes all 30 checks, with 216 views fitting their width. I didn't rerun `ui-check.mjs`; the last commit reports 1432 rendered states passing.

## Findings, most severe first

### R1. P1: a `codex.cmd` or `opencode.cmd` in the thread's folder runs before the agent

Location: `src/agent.ts:137` (`cmdHost`), `src-tauri/src/lib.rs:340-344` (codex and opencode run as `cmd.exe /d /s /c %LOOM_COMMAND%`) with the pane's folder as cwd (`:402-403`); `src-tauri/src/opencode.rs:9-16` (`cli()`, which `launch` runs on every spawn, `messages` on every Overview refresh and `sessions` in the picker); `src-tauri/src/helper.rs:320-334` (`codex_shim_dir` checks the pane's folder before PATH on purpose).

Failing scenario: a checkout holds `codex.cmd` (or `.bat`, `.exe`, `.com`) at its root. It came from a branch you opened a thread on to review, or an agent wrote it into its own worktree. Opening a Codex pane there, or Loom restoring one at start, runs that file with your rights, outside any agent sandbox, before Codex shows its folder-trust prompt. An `opencode.cmd` runs at spawn (`opencode --version`) and again on each Overview refresh. cmd skips the current folder only when `NoDefaultCurrentDirectoryInExePath` is set. It isn't set in the user or machine environment here, so a Loom started from the Start menu or by `relaunch` doesn't have it.

Evidence: in a scratch folder holding a planted `claude.cmd`, `cmd.exe /d /s /c "claude --version"` with that variable unset printed the planted file's output. The reviewer did the same with `codex` and `opencode`, and with the variable set the real `codex-cli 0.161.0` answered. `opencode.rs:105` is a test that a folder's `opencode.cmd` runs. Claude panes and shells are not affected: portable-pty resolves `claude` from PATH only, and PowerShell never runs a bare command from the current folder.

Fix: resolve `codex` and `opencode` to absolute paths from PATH in Rust (PATHEXT order, PATH only) and give cmd that path, in the pane launch, `opencode::cli` and `helper::chain`, and drop `cwd` from `codex_shim_dir`. Setting `NoDefaultCurrentDirectoryInExePath=1` on the pane would also close it, but every process the agent starts would inherit it, so an agent's `cmd /c build.bat` in its own folder would stop finding the script.

### R2. P2: a sent prompt that starts with a number reads as the agent's question

Location: `src/prompt.ts:46-51` (the highlighted option nearest the bottom wins). Callers that act on the result: the submit guard (`src/main.ts:8390`), the sweep's `idleInput` (`:4925`), the Overview cards (`:3698`, `:3883`), `manualEnter` (`:4567`), `answers` (`:2801`), `paneMenu` behind `loomctl menu` and the phone's `read --menu` (`:3620`), and `readCodexInput` (`prompt.ts:195`).

Failing scenario: you send Claude "1. Fix the login bug in auth.ts" and "2. Add a regression test for it" on two lines. Claude 2.1 draws it in the transcript as "❯ 1. Fix ...", and Codex draws it as "› 1. fix ...". Until it scrolls off:

- `loomctl submit` to that pane refuses, saying the pane is asking a question.
- The task's Stop arrives, but the sweep waits for `idleInput()`, which stays false. After 30 s of quiet the task ends `unknown` (no-end-signal) instead of `completed`, so the phone's "finished" notice says something else.
- The Overview card shows the two lines as answer buttons. Clicking the first presses Enter into the composer and sends whatever draft is there. The second presses Down, which walks Claude's prompt history.
- A manual Enter isn't tracked, typing "1" or "2" counts as an answer, and the phone shows your prompt as the agent's question.

Evidence: I fed `readMenu` an idle Claude screen with that prompt above the answer, then "✻ Worked for 12s", then the empty composer between its rules. It returned `{"options":["Fix the login bug in auth.ts","Add a regression test for it"],"selected":0}`. The reviewer got the same for a Codex screen. The effects above are traced through the callers, not run in a live pane. The prompt's first line has to start with a number, and orchestrator prompts and fix lists often do.

Fix: accept a menu only when no live composer is drawn below its last option: a Claude "❯" row between two rules, or a Codex "›" row that isn't an option. Real permission prompts, AskUserQuestion and Codex approvals all take the composer's place, so they still read.

### R3. P2: a dictated message with a sending prefix presses Enter on a menu, or joins a `loomctl send`

Location: `src/main.ts:1761-1777` (`micStop`, the `pre.enter` branch).

Failing scenario A: your prefix sends itself (the ⏎ toggle, or `loomctl dictation prefix ... --enter`). You dictate the next message while Claude works. Before whisper answers, Claude shows a permission prompt. `micStop` pastes the text, which the menu ignores, waits 150 ms and writes `\r`, which picks the highlighted "1. Yes". You approved a command you never saw. Codex approvals go the same way.

Failing scenario B: a `loomctl send` to the same pane is between its paste and its Enter, which can take up to 5 s of echo wait. Dictation pastes and presses Enter outside `inTurn`, so its Enter submits both texts joined, and the send then reports that the input holds both. A caller that retries sends its text twice.

Evidence: `p.term.paste(text); if (pre.enter) { await p.settle(150, 1000); ... void invoke("pty_write", { id: p.id, data: "\r" })`, with no `readMenu`, no echo check and no `inTurn`. `manualEnter` sees the menu and returns early, but the Enter is written anyway. Traced.

Fix: send a dictation with a sending prefix through `sendReply` (`main.ts:4049`) with the pane's `gen`, as `replyAsPerson` does. That takes the input turn, waits for the echo and never presses Enter on a menu. When it refuses, leave the text typed and say why.

### R4. P2: deleting a file named like an option, from the phone, discards whole sections

Location: `src/remote/changes.ts:200-203` (the path goes before `--yes` with no `--`), `src/cli.ts:27-46` (`parseArgs`), `src/main.ts:8807-8813` (no paths left means every file in the picked sections).

Failing scenario: an untracked file is named `--staged`, or any other flag the `git` command takes (`--unstaged`, `--untracked`, `--push`, `--full`, ...). You tap Delete on it in the phone's Changes tab. The phone sends `discard --untracked --staged --yes`, `parseArgs` reads the name as a flag, no path is left, and Loom discards every staged change and deletes every untracked file. "Discard changes" on a tracked file named that way discards every unstaged change. A repo can ship such a file on purpose.

Evidence: the reviewer ran the phone's argv through the real `parseArgs`, `parseStatus` and `gitAct` against a scratch repo. Git ran `restore --staged --worktree -- :(literal)kept.txt` and `clean -f -d -- :(literal)--staged :(literal)notes.md`. A name that isn't one of the command's flags fails safely: `parseArgs` refuses an unknown option.

Fix: put paths after a bare `--` in every phone git call that takes one: stage, unstage, discard, resolve, diff and file. `parseArgs` already honours `--`.

### R5. P2: after a commit on the phone, the box keeps the message, and a second tap commits everything

Location: `src/remote/changes.ts:212-216` (`change()` draws the new status), `:241-247` (the stored draft is cleared only after that draw), `:230` (the redrawn composer reads the stored draft).

Failing scenario: stage one file, type "Fix the login", choose Only staged and tap Commit. The toast says Committed and the box still holds "Fix the login". Nothing is staged now, so the Only staged switch is hidden and `onlyStaged` goes back to false. Tap Commit again and Loom runs `git add -A` and commits all the unstaged work under the same message. With All changes it happens whenever an agent keeps writing files, since the composer redraws at once. Amend leaves its text behind the same way.

Evidence: reproduced in headless Chrome against the built page with the remote-ui-check mock. The box showed "Fix the login", and the two commits went out as `commit - --staged` then `commit -`.

Fix: clear the stored draft inside the act callback, before `change()` draws, when it still equals the committed text, and empty a kept box too.

### R6. P2: on the phone, a draft moves to another agent after you visit New thread

Location: `src/remote.ts:63` (`#/new` calls `showList(null)`), `src/remote/agents.ts:58-62` (`showList` sets `open`, which the agent screen shares), `:405-410` (`showPane` keeps the box when `was` is null).

Failing scenario: at 375 px, open Alpha and type "for alpha only". Go back, tap New thread, go back, open Beta. Beta's box holds "for alpha only", and Send gives it to Beta. Alpha's box is empty afterwards. At 1280 px, clicking New thread and then Beta in the list does the same.

Evidence: `showList(null)` clears `open` without saving the box under Alpha's key. `showPane(Beta)` then sees `was === null` and keeps the text, a path meant for a link whose agent is still being looked up. Reproduced in headless Chrome at both widths.

Fix: give the list's highlight its own variable so `showList` never touches `open`, or route `#/new` through `showPane(null)` so the draft is saved first.

### R7. P2: on the phone, a clip recorded during a typed send joins it, and the typed text goes again on the next Send

Location: `src/remote/agents.ts:738` (`wasEmpty`), `:741-746` (where a clip lands), `:711-714` (`sendPrompt` clears only an unchanged box).

Failing scenario: with a sending prefix, type "typed message", tap Send, and dictate "next message" while Loom answers. Whisper answers first, so the clip lands while the send is pending and the box reads "typed message next message". The send succeeds, but the box no longer equals what went, so it isn't cleared. The clip lost its prefix and never sent itself, and the next Send delivers "typed message" a second time.

Evidence: `b2c0b42` fixed this for a clip behind a clip, but only dictated sends join the `landed` chain, so a typed send doesn't hold a clip back. Reproduced in headless Chrome: the box ended as "typed message next message" after one submit of "typed message".

Fix: keep each draft key's in-flight `sendPrompt()` promise, and have a landing clip await it before it reads the box.

### R8. P2: on the phone, a double tap on an Activity reply sends it twice

Location: `src/remote/agents.ts:253-265`.

Failing scenario: in Activity, type "looks good" and tap Send twice while Loom answers. `submit` waits on the agent, so the first can take seconds. Two submits go out under two keys, and the agent gets the reply twice. The agent screen's box disables Send while it sends (`:702`). This form has no guard.

Evidence: reproduced in headless Chrome: two submits of "looks good" with different keys.

Fix: disable the form's button while its send runs.

### R9. P2: Open in VS Code on a file opens a path under Loom's own folder

Location: `src/main.ts:6214` (Files) and `:6335` (the Changes menu) pass `goto` as a path relative to the repo; `src-tauri/src/lib.rs:946-963` runs `code.cmd "<dir>" -g "<path>"` without a working directory.

Failing scenario: right-click `src/main.ts` in Changes and choose Open in VS Code. VS Code resolves `-g` against its own working directory, which is Loom's, and the Start-menu shortcut starts Loom in `%LOCALAPPDATA%\Loom`. VS Code opens the worktree plus a new, empty `C:\Users\ayoub\AppData\Local\Loom\src\main.ts`. A Loom started from inside a checkout opens that checkout's copy of the file instead of the worktree's, and edits land in the wrong tree.

Evidence: traced through the installed VS Code's CLI (`doValidatePaths` resolves each path with `preparePath(cwd, ...)`) and the shortcut's "Start in". I didn't launch VS Code.

Fix: pass the full path (`th.dir` joined with `path`), or set `current_dir(&dir)` in `open_vscode`.

### R10. P2: picking a model while the Claude input holds a draft sends the draft with "/model ..." on the end

Location: `src/main.ts:7222-7230` (`slash`), `:7260-7291` (`applyOne`).

Failing scenario: you type a prompt into a Claude pane, then open the gauge's panel to switch model before sending it. `slash` pastes "/model <id>" at the cursor and presses Enter. Claude receives "your draft/model claude-..." as one prompt and starts it on the old model. `applyOne` checks the recording, the mic chain and `claudeUp`, but never the input. Everywhere else Loom refuses to type over a draft.

Evidence: traced. Not run live.

Fix: inside the `inTurn` callback, read `inputState(p)` (`main.ts:3642`) and refuse unless it's empty or a suggestion, with the note "clear the draft first".

### R11. P2: Claude token totals and turn counts are 2 to 6 times too high

Location: `src-tauri/src/usage.rs:184-216` (`scan`), `:728-734` (`profile_of`). Shown in the gauge tooltip (`src/main.ts:1497`), the session's "N turns" (`:7548`) and the phone's Usage and context screens (`src/remote/usage.ts:150`, `:163`).

Failing scenario: Claude Code 2.1.29x writes one transcript record per content block (thinking, text, tool_use), and each repeats the message's id and usage. `scan` adds every record, so turns, input, output, cache read and cache write are all multiplied. `profile_of` adds one sparkline point per record, which also shifts the turn number shown for each compaction. The context figure is right, because it's replaced on each record, not summed.

Evidence: on the newest transcript on this machine I counted 90 usage records for 42 distinct messages, and 149,368 output tokens summed against 31,005 counted once per message. The reviewer saw factors of 2 to 6 across eight transcripts.

Fix: read `message.id`, and skip a record whose id matches the last one counted, in both `scan` and `profile_of`.

### R12. P2: a worktree under a junctioned folder can't be deleted, and Loom finds out only after closing its panes

Location: `src/main.ts:6879` (`worktreeDir` is `~\loom\<repo>\<slug>`, never resolved), `src-tauri/src/deletion.rs:385-390` (`entry_of` compares the recorded path's spelling with `th.dir`'s).

Failing scenario: `~\loom`, or any folder above it, is a junction to another drive, which is the obvious way to keep 11 GB worktrees off a small C:. `git worktree add` records the resolved path in `.git/worktrees/<n>/gitdir`, while `th.dir` keeps the junction's spelling. `close-plan` succeeds, because the inventory and fingerprint read through the junction. `close-thread --yes --delete worktree` then stops the panes and removes the thread, and `worktree_remove` fails all 11 tries with "... leads to the worktree git keeps at <real path>, not to its own". The thread is gone and the folder and branch stay. Reopening the folder gives `repo == dir`, so Loom no longer treats it as a worktree thread and can't retry. `~\loom` isn't a junction on this machine today.

Evidence: the reviewer compiled the real `deletion.rs` into a scratch harness (stubs only for `git_run` and `file_identity`, git 2.39.1). `git worktree add -b t <link>\wt` wrote `gitdir = ...\real\wt\.git`, and `remove_worktree(repo, <link>\wt)` returned exactly that refusal.

Fix: after `git worktree add` in `createThread`, store the folder through `canonical_directory`, as `loomctl new` already does for `repo`. Keep `entry_of`'s spelling check, since comparing file identities there would undo the redirected-parent guard.

### R13. P3: a deletion whose Git record can't follow leaves a transaction nothing in Loom can finish

Location: `src/main.ts:5802-5813` (11 tries, then `worktree: "failed"`), `src/main.ts:6929-6933` (`new` skips a taken `loom/<slug>`), `src-tauri/src/deletion.rs:152-155`, `:345` (purge skips pending records), `docs/loomctl.md:280-284`, `:308`.

Failing scenario: something holds a file in `.git/worktrees/<n>` (a git process, TGitCache) while close-thread runs. The folder moves to the trash, but renaming Git's entry fails every time. close-thread reports `worktree: "failed"`, and the docs say the folder stays whole and to delete it in Explorer and run `git worktree prune`. But the folder is no longer at its path, and prune can't remove an entry locked as pending. `git branch -D loom/x` refuses because the branch is checked out at that entry, so `loomctl new --name x` moves on to `x-2`. Purge skips pending records, so the trash folder (possibly gigabytes), the lock and `refs/loom-trash/<id>` stay for good. If you unlock and prune by hand, `finish_record` then fails on the missing entry every time, and both `prepare_worktree` and `remove_worktree` refuse that path for good.

Evidence: reproduced end to end in the same harness, including both permanent refusals and the keep ref outliving purge. The `main.ts` side is traced.

Fix: in `finish_record`, treat "entry and its trash spot both absent" as nothing left to move and complete the record. Report `worktree: "pending"` with the trash path rather than `failed`, and retry pending records from purge or at startup.

### R14. P3: deletion, update and loomctl leftovers

- Commits on a detached HEAD aren't counted as lost (`src/main.ts:5703-5711` counts only `th.branch`, and only for `--delete branch`). An agent detaches and commits, close-plan says `--delete worktree` loses nothing, and after purge the keep ref and the worktree's reflog are gone, so gc removes those commits after its grace period. A Loom git action while detached also stores `th.branch = "HEAD"` (`:6357`, `:8771`): "Delete worktree and branch" then counts commits for the main checkout's HEAD and runs `branch -D HEAD`. A worktree on an unborn branch fails `rev-parse --verify` (`deletion.rs:244-246`) after its panes are closed. Count `rev-list HEAD --not --branches --remotes` for every delete mode, skip the keep ref when HEAD has no commit, and read the branch with `symbolic-ref -q --short HEAD`, keeping the old name when that fails.
- Debug builds purge the release Loom's trash (`src-tauri/src/lib.rs:191-193`: `trash_dir` has no `-dev` suffix, unlike `data_dir`). A `tauri dev` run or a debug loom.exe from an older worktree purges real deleted worktrees with its own rules. At `cbb9ede`, purge had no pending, restore or reachability checks. Add the suffix.
- `update.ps1` can't roll back a running `loom.exe` (`scripts/update.ps1:78`). After `loom.exe` is replaced, `$f.Backup` is the image the running Loom maps, so `[IO.File]::Replace` back fails with "being used by another process". The reviewer reproduced that API call with a running copy. You get a new `loom.exe` beside the old `loomctl.exe`, and the script says so. Roll back with `Copy-Item -Force` from the backup.
- `loomctl` crashes when its reader stops early. I ran the installed `loomctl.exe --version | (exit 0)`: it panicked with "failed printing to stdout ... (os error 232)" and exited 127, outside the documented 0 to 3. `loomctl --json watch --follow | head -1` hits the same. Write through a locked stdout and exit quietly on a broken pipe.
- `watch --follow` ends on Loom's own timeout reply (`src-tauri/src/bin/loomctl.rs:418-428`): a watch the page misses (during a WebView reload) gets `{ok:false, timeout:true}` after poll + 5 s, and `follow` treats it as fatal although the help says it reconnects. A command sent while Loom starts gets `code: "failed", sent: true` though nothing reached the page (`:340-345`). Retry a watch on `timeout`, and map `starting` to a not-sent code.
- Records that never purge: a deleted repository makes `reachable(entry_at)` false for good (`deletion.rs:356-357`), so its trash folder stays, and uninstall (`nsis-hooks.nsi:125-133`) leaves `.git/loom-trash/<id>`, `refs/loom-trash/<id>` and cross-drive `.<id>.loom-trash` folders behind. Document how to drop a record by hand, or add `trash forget <id>`.
- docs/loomctl.md:267-269 still describes the old checks ("refuse ... reparse points, and stop at 20,000 entries, 64 directory levels, 256 MiB, or five seconds"). The code now counts links without refusing them, allows 2,000,000 entries with no depth limit and 15 s, and applies 256 MiB to hashed changed files only. An agent reading the docs will think a built worktree can't be deleted and remove it by hand.

### R15. P3: a Claude task stays in `approval` when the question is answered without Enter or a menu key

Location: `src/main.ts:2797-2803` (`answers`), `:2816-2822` (`wrote` is the only way out of `approval`), `:4935` (the sweep skips approval tasks); `src/task.ts:343-345` (`stop` moves only working tasks).

Failing scenario: Claude asks for permission and the task moves to `approval`. You accept with Shift+Tab ("allow all edits during this session"), or answer through Claude's own remote control, which never touches the pane's input. Claude works and its Stop arrives, but `route` ignores Stop for an asking task and the sweep skips it. The task never completes, the phone never gets "finished", and the sweep timer runs until the pane exits. Esc is handled (the sweep cancels on an interrupt before the skip).

Evidence: the reviewer ran `route()` on an approval task, and `stop` returned no move. The Shift+Tab option is from Claude's edit prompt as remembered, not checked on 2.1.288.

Fix: count `\x1b[Z` as an answer while a menu is up, and in the sweep move an approval task back to `working` once no menu is on screen and Claude reads busy, or once a Stop arrives.

### R16. P3: a pane's job kills GUI apps started from it

Location: `src-tauri/src/lib.rs:95-114` (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, breakaway only for a program that asks), `:489-509` (the exit thread drops the job when the root process exits).

Failing scenario: with VS Code closed, type `code .` in a shell pane. VS Code's CLI starts Code.exe detached but without asking to break away, so it joins the pane's job. Closing the pane, Restart, Restart to update, `exit` in that shell, or a Loom crash then kills that VS Code window. A browser that `start http://localhost:5173` opens, when it wasn't already running, goes the same way. Before `7844282`, `taskkill /T` missed such orphans and they survived.

Evidence: the reviewer found `detached:!0` with no breakaway flag in the installed VS Code's `cli.js`. Job inheritance is standard Windows behaviour. Not run on the desktop.

Fix: on close, list the job's processes (`JobObjectBasicProcessIdList`) and terminate the console ones, instead of `KILL_ON_JOB_CLOSE`. Or keep it and say so in docs/loomctl.md.

### R17. P3: mouse movement over an OpenCode pane counts as typing

Location: `src/main.ts:2152-2179` (`onData`).

Failing scenario: OpenCode turns on any-motion mouse tracking. Each pointer move over its pane reaches `onData` as `\x1b[<35;x;yM`, which bumps `inputSeq`, sets `lastIn` and, once written, calls `seen()`. Moving the pointer across a waiting OpenCode pane clears its alert, so it drops out of the chip, F3, the overlay and `wait-any --state waiting`. A `loomctl send` in flight there stops before Enter, saying something else was typed. A task waiting on its held Enter ends `unknown`, and `send --input REV` refuses because the revision moved.

Evidence: focus reports are already passed through without touching any of that (`:2155-2157`). Mouse reports are not. Traced.

Fix: pass motion and wheel reports through the way focus reports go. Clicks can still count.

### R18. P3: closing a pane clears its neighbour's alert, even in a thread you aren't looking at

Location: `src/main.ts:3032` (`closePane` calls `focusPane`), `:3065-3069`, `:2692-2695` (`focus()` calls `seen()`).

Failing scenario: `loomctl close <pane> --yes` runs on a background thread, from an orchestrator or the phone. `closePane` focuses the pane that takes its place, and if that pane was waiting its alert is cleared. `revealPane` sets `active` by hand for exactly this reason (`:3345`, "Switching must not clear a different pane's notification").

Fix: in `closePane`, set `active` and repaint, and call `focusPane` only when the thread is in front.

### R19. P3: an image path on a network share becomes a link that connects over SMB

Location: `src/links.ts:10` (`PATH_RE` accepts `\\` paths), `src-tauri/src/lib.rs:832-839` (`read_image` joins and opens the path).

Failing scenario: an agent prints `\\attacker.example\share\chart.png`, perhaps because a web page or a repo file told it to. It shows as an image link. Clicking it opens the UNC path, so Windows connects to that host and offers your NTLM credentials. The extension check passes because the name ends in `.png`.

Evidence: `fileLinks` on that row returned the UNC path as an image link. `Path::join` with a UNC path discards the thread folder. The credential exchange is standard Windows behaviour, not run here.

Fix: have `read_image` refuse UNC and device paths, or drop `\\` and `//` from `PATH_RE`.

### R20. P3: thread names match by prefix, also for commands that delete

Location: `src/main.ts:8197-8202` (`cliThread`), `:8213-8214` (`cliPane` for `name:n`).

Failing scenario: threads `fix` and `fix-login` exist. `loomctl close-thread fix --yes --delete branch --force` closes `fix`. A later command that still says `fix` (a script's next step, or an agent repeating itself) resolves by prefix to `fix-login`: `send fix:1`, `close fix:1 --yes`, `git fix discard --yes` or another `close-thread`, which moves its worktree to the trash and deletes its branch. The help promises "its name or id".

Fix: exact name or id only, at least for commands that change anything.

### R21. P3: destructive git actions that skip the confirmation their siblings ask for

Location: the PC diff view's hunk Discard (`src/main.ts:6066`, `apply --reverse`) runs on one click, while the phone asks first and loomctl wants `--yes` for the same thing. `loomctl git <thread> abort` and `skip` (`:8896-8906`) take no `--yes`, though the panel asks "Abort the merge?" and `merge --abort` throws away hand-resolved conflicts. The phone's rebase Skip (`src/remote/changes.ts:163`) doesn't ask.

Fix: a confirm on the hunk Discard, `sure()` on abort and skip, and `ask` on the phone's Skip.

### R22. P3: a commit from loomctl or the phone empties the PC's commit box

Location: `src/main.ts:8831-8832`.

Failing scenario: you're writing a message in the PC's commit box, and a commit with its own message comes from the phone or an agent. `th.commitDraft = ""` and the textarea is emptied regardless, so the PC draft is gone. That undoes what `ba389b9` did for the PC's own commits.

Fix: clear only when the draft equals the committed message, as `usedDraft` does.

### R23. P3: phone pairing is reachable from any web page on the PC

Location: `src-tauri/src/remote.rs:300-317` (`route` checks neither Host nor Origin), `:350-358` (`pair` parses the body whatever its type).

Failing scenario: a page open in a browser on the PC posts `{"code":"000000"}` to `http://127.0.0.1:7420/api/pair` as `text/plain`, which needs no preflight. With no code open it costs nothing. Once you run `loomctl remote pair`, five wrong guesses close the code, so the page can keep your phone from pairing for as long as it's open. With DNS rebinding it can also read the reply, so a lucky guess (5 in a million per code) hands it a token with full control. Other Windows accounts on the PC reach the port the same way.

Evidence: a request with `Host: evil.example` got a 200 from the running server. The pairing path is traced. The study (docs/phone-remote-study.md:147-149) dropped the Host check because every command needs the token, and pairing is the one route where that isn't so.

Fix: on `/api/pair`, refuse any Content-Type but `application/json`, which forces a preflight that Loom fails (the page already sends that type), and refuse a Host other than `127.0.0.1:<port>`, `localhost:<port>` or a `*.ts.net` name.

### R24. P3: other phone server leftovers

- A long clip on a slow uplink is lost. `CLIP_FRAME` (`remote.rs:30-31`, `:289-295`) is one 60 s deadline from accept. A 3-minute clip (5.76 MB) over an uplink under about 0.77 Mbit/s doesn't arrive in time, `tailscale serve` answers 502, and `post()` in `src/remote/dictate.ts` drops the recording with a toast. Use an idle deadline per read, or keep the clip so it can be sent again.
- Tokens never expire, and pairing again never retires the old token (`remote.rs:356`). A phone that cleared its site data or was sold keeps a working token, and the only removal is Unpair all. The live server reports 3 phones paired. Store a label and last-seen time per token, and allow removing one.
- Unpair all forgets this phone's token even when the revoke failed (`src/remote/settings.ts:303-308` ignores what `act()` returns). The pairing form appears as if it worked, while the other phones, including a lost one you meant to cut off, stay paired.
- `/assets/<anything>.html` serves the desktop `index.html` with a one-year cache (`remote.rs:309`, `:328`): the guard lets any name ending in `.html` through Tauri's index fallback. Reproduced against the running server. Harmless today, since that page has no Tauri IPC there. Test `path == "remote.html"` instead.
- Unauthenticated clients share the 32-connection cap (`remote.rs:36`, `:205-208`), so a local process can hold 32 idle connections and keep the phone out. Low priority.

### R25. P3: a Claude pane in a long folder path fails on every restore

Location: `src-tauri/src/usage.rs:85-103` (`slug`, `has_session`), `:139-143`; used at `src/main.ts:2343` and `src/agent.ts:108`.

Failing scenario: the folder's sanitized name is over 200 characters. Claude Code stores the session under the first 200 characters plus `-` and a base-36 hash of the path. Loom looks under the whole name, finds nothing, and launches `claude --session-id <sid>` for a session that exists. Claude prints "Error: Session ID ... is already in use." and exits. A folder name with a character outside the BMP mismatches too, since Claude replaces each UTF-16 unit (an emoji becomes two dashes, Loom writes one).

Evidence: traced through Loom and the installed claude.exe (`n.slice(0,cde)` with `cde=200`, then the hash). No such folder exists here, so not run.

Fix: mirror Claude's slug (UTF-16 units, its 32-bit string hash, base 36), or when the name is over 200 characters, look for `projects/<first 200>-*` holding `<sid>.jsonl`.

### R26. P3: smaller pane, phone and Changes issues

- `Pane.screen()` reads past the terminal's width (`src/main.ts:2646-2656`). xterm keeps stale cells in the alternate buffer after a narrowing resize, and every other reader clamps to `term.cols`. OpenCode runs in the alternate screen, so a narrowed pane can keep an old "esc interrupt" in the tail of a row, and `busy` stays set in the sweep. Fix: `translateToString(!joined, 0, this.term.cols)`.
- The Speak button misses a fast second click (`src/main.ts:9896`). `mic(recording ? micStop : micStart)` picks the step at click time, so a second click while the mic opens queues another start, and the mic stays open. Fix: `mic(() => (recording ? micStop() : micStart()))`.
- The Changes selection survives a thread switch for paths both threads changed (`src/main.ts:6250-6251`, `:6591-6595`). Ctrl-click `src/main.ts` in one worktree, switch to another where it's also modified, and Discard acts on it there. The confirm names the file, not the thread. Clear `sel` when the thread changes.
- On the phone, a late context reply draws under another agent's name (`src/remote/usage.ts:133-167` has no visit or sequence check). Reproduced.
- On the phone, "Fit Loom to phone" can unzoom the pane it means to zoom (`src/remote/agents.ts:593-600`): it toggles from the list's `zoomed`, which lags by a poll. Use the `show` reply's `zoomed`, as `focusOnPc` does since `ede80ff`.
- On the phone, one unanswered send disables Send for every agent for up to four 70 s tries (`src/remote/agents.ts:702`, `:719`), while a dictated send bypasses the button. Track pending sends per draft key.

### R27. P3: shutdown, restart and startup edges

- A save or journal write that keeps failing (a locked `.json.bak`, a full disk) leaves no way to close the window but killing Loom (`src/main.ts:9758-9760`, `:9785-9790`). The panes are already stopped after `pty_shutdown`, so each retry fails the same way. Offer "Close without saving" on the second close after the same failure.
- `loomctl relaunch` during a close turns the close into a restart (`src/main.ts:3215-3220`, `:9783`): `shuttingDown` is still false while the close polls sessions and drains the journal, so the request is accepted and sets `relaunching`. Refuse it while `closing`.
- A restart whose `destroy()` throws leaves the old window open with stopped panes while the new Loom waits 60 s and then shows "Workspace unavailable" (`src/main.ts:9783-9784`). Rare.
- `loomctl new` during startup's restore (about 26 s for 9 panes) makes a thread that never reaches the sidebar and gives its pane `notify: "inherit"` instead of the new-pane default (`src/main.ts:5659`, `:2983`).

### R28. P3: usage display

- The PC's plan chip refreshes every 10 minutes, not 5 (`src/main.ts:7787-7809`). `nextRefreshAt` is set after the reply, so it lands just after the next 5-minute tick, and every other tick gets the cache. The panel's "Updated" then shows the poll time over numbers up to 10 minutes old, or hours old during a 429 hold. Reproduced in Node with a fake clock. Take `nextRefreshAt` from the request's start and `planFetchedAt` from `fetchedAt`.
- The 64 KiB cap on a Codex rollout's first line (`src-tauri/src/usage.rs:431-438`) is near real sizes: the largest here is 52,533 bytes, mostly `dynamic_tools`. A rollout past it loses its model, effort and context, and every 4 s poll then walks the whole sessions tree again (`:508-557`) under the `CodexScanned` lock. Raise the cap and remember misses for a few minutes.
- The phone's Usage tab asks both accounts while Plan usage is off (`src/remote/usage.ts:47-50`, `src/main.ts:8619-8627`), every 5 minutes while the tab is open. Show "Plan usage is off" there instead.
- The context gauge doesn't repaint when only the window changes (`src/main.ts:2684-2686`), so after `/model` from a 1M to a 200k model it shows the old percentage until the next turn. Compare `window` too.
- One complete transcript line that isn't UTF-8 stops that pane's Claude scan for good (`usage.rs:172` returns before the offset moves). Only file corruption gets there. Skip a complete line that isn't UTF-8, and stop only on a partial one.

### R29. P3: native leftovers

- The control pipe's name comes from `USERNAME` with every non-ASCII-alphanumeric character dropped (`src-tauri/src/pipe.rs:22-24`), so accounts like "a.b" and "ab", or two fully non-ASCII names, share one name, and any local account can create it first. The owner check stops misuse but not that denial. Name it after the user's SID.
- If `contain()` failed and then `try_clone_reader` or `take_writer` fails, `pty_spawn` returns an error and leaves the child running with nothing to stop it (`src-tauri/src/lib.rs:415-423`). Kill it on those paths.
- `LOOM_LAUNCH` is set only when the page passes a launch (`lib.rs:354-356`), so a Loom started from inside a pane (`tauri dev`) hands its own inherited value to a pane spawned without one. Remove it when there's none.
- The PC window runs with no CSP (`tauri.conf.json`, `"csp": null`). I found no HTML injection: every `innerHTML` in `main.ts` takes escaped text or numbers. A CSP would still keep a future slip from reaching `invoke`.

## Checked and clean

- Panes: a late exit or stop from an old launch can't touch a new one (`pty-exit` carries its launch, and `pty_kill` checks it under the map lock). Wakes, session ids and usage readings are checked against the launch. Dictation checks the pane's generation after every await (F9). Codex goes by its title once it has one, and stays idle during an approval (C2). Claude's hint is read only in its footer and retry banner (C7). `wrote()` acknowledges an answer whether or not a task tracks it (C9).
- Native: the Job Object code (rights, handle closing, struct size, drop order), lock ordering (only `pty_spawn` nests, Reports then Flows then Ptys), the restart path (`LOOM_AFTER_PID` waited out before the single-instance plugin and the lease, `--reset` dropped), fsynced workspace saves with a `.bak`, journal rewrites and torn-tail appends, and the control pipe (owner-only DACL, owner check in loomctl before any write, 1 MiB cap, 10 s frames, 64 connections, retry after a failed re-create). `d2a47ac`'s `SetConsoleCtrlHandler(NULL, FALSE)` only clears the inherited ignore flag, and no pane starts in a new process group.
- Phone server: `/api/cli`, `/api/push`, `/api/dictate` and `/api/procs` check the token before anything else, and an unpaired request gets 401. Tokens are 32 random bytes stored as SHA-256. The head is capped at 16 KiB, a negative Content-Length gets 400, an oversized one 413 before any body is read, and chunked bodies 411. Static names allow only `[A-Za-z0-9._-]`, and traversal probes all got 404. Responses carry a CSP, nosniff and `frame-ancestors 'none'`. Push endpoints are limited to http(s) and checked for control characters; curl gets its config on stdin, follows no redirects and ignores `.curlrc`. The RFC 8291 crypto is right. `procs.rs` uses the right `Reserved1` offsets, an aligned buffer and a bounded growth loop.
- Phone page: everything from the PC reaches the DOM through `textContent` or built elements, and the only `innerHTML` is the constant logo. The task manager's poll stops on Close, a route change, a 401 and a hidden page. Loops start once, and the agent screen, git reads and diffs are guarded by id or sequence.
- Deletion and the trash: nothing destroys what the approval kept. The worktree folder is refused when it is itself a link, `rename` moves inner junctions as links, the fingerprint never descends into a reparse point, and purge's `remove_dir_all` removes links without following them. `entry_of` checks file identity of the worktrees folder and the backlink, so a redirected parent can't lead to another worktree, and a nested `.git` is refused even with `--force`. An open file or a process's working directory blocks the move, and a failed first move removes its reservation, lock and ref. A move across drives never copies. Purge cancels a record whose folder you moved back by either recipe in docs/loomctl.md, and keeps records on an offline drive. Two instances are kept apart by `create_new` reservations and exclusive record handles. The NSIS hooks write PATH back as `REG_EXPAND_SZ`, move both executables aside and put the pair back on failure.
- Tasks and loomctl: every path-taking git call in the panel and loomctl uses `--` and `:(literal)`, so `3c88131` is complete on the PC side (R4 is the phone-to-loomctl hop). Renames keep both names. The journal's `writtenSeq`, failed-write recovery and replay of torn or malformed lines hold. `TaskEventGate` cleans up on abort, timeout and throw. Arguments like `--lines` and `--timeout` are bounded.
- Usage: OAuth tokens come only from the agents' own credential files and reach curl on stdin, never argv. No token appears in an error, a log, the phone's JSON or CLI output. curl runs without `-L` or `-k`, with `-m 20`. `Retry-After` is clamped to 300 to 86,400 s, so a hold always ends. Every division is guarded.

## How this was checked

Seven reviewers read the code in parallel, each with the previous reviews so as not to repeat closed findings. I read each finding's cited lines myself before keeping it. None turned out wrong. I moved one from P2 to P3 (R15) and changed R1's fix, because the reviewer's first choice would leak into every process an agent starts. I reran these myself:

- R1: a planted `claude.cmd` run through cmd in a scratch folder.
- R2: `readMenu` from `src/prompt.ts` on a Claude screen.
- R11: duplicate usage records in this machine's newest Claude transcript, counted by message id.
- R14: the installed `loomctl.exe` writing into a closed pipe.

The phone reproductions (R5 to R8 and R26's late context reply) ran in headless Chrome against the built page with the remote-ui-check mock. R4 ran the real argument parser and git helpers against a scratch git repository. R12 and R13 ran the real `deletion.rs`, compiled into a scratch harness with a separate target folder, against scratch repositories with junctions. R23 and R24's asset probe sent unauthenticated requests to the running server on 127.0.0.1:7420, with no pairing attempt. The rest is traced through the code, as each finding says. I didn't edit any source file, stage or commit anything, touch a Loom pane or run an installer. This report is the only file I wrote in the repo.
