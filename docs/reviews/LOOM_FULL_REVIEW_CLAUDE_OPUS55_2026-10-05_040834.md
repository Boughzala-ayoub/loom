# Loom full review, Claude Opus 5.5

Reviewed `main` at `ef14290` (Reconcile pane activity after approval acknowledgements) on 2026-10-05. This covers the whole app, not one diff: the frontend in `src/`, the native side in `src-tauri/src/`, loomctl, the installer hooks, `scripts/update.ps1` and the check scripts where they guard behaviour. Two helper reviewers read the Rust side and the usage/installer code in parallel. I re-read every claim of theirs that appears below against the source before keeping it, and dropped the ones I couldn't confirm.

The worst problem is new and easy to hit. `close-thread --delete worktree --force` hands the folder straight to `git worktree remove --force`, and Git for Windows follows NTFS junctions inside a worktree and empties their targets. I reproduced that with the installed git 2.39.1 in a scratch folder. The fingerprint added in `b225fd2` would refuse such a tree, but `--force` skips it. Since the fingerprint also refuses any worktree with more than 20,000 entries or 256 MiB, `--force` is the only deletion that still works for a Loom worktree that has been built once, so agents will reach for it.

The two Codex-idle commits fix the reported symptom. But `ef14290` made the busy flag level-triggered on two signals that lie: Codex's title says Working all through an approval prompt, and the hint regex matches "esc to interrupt" anywhere on the visible screen. A Codex pane now shows as working while it waits for your answer, or while it sits idle with that phrase in its last answer.

## Status of earlier findings

Astra's full review (`LOOM_FULL_REVIEW_ASTRA_2026-10-05_013744.md`, at `b60f957`) and round 3 (`LOOMCTL_GAPS_ROUND3_SOL61_XHIGH_REVIEW_2026-10-05_013558.md`), checked against `git log 5196892..HEAD`.

| Finding | Fix | Does its failing scenario still fail? |
| --- | --- | --- |
| F1 resize blocks the main thread and registry lock | `a44c2c8` | Closed. `pty_resize` runs on the blocking pool (`lib.rs:1377`), `resize_pty` copies the session's handles and drops the map lock before the native call, and sizes coalesce so one worker at most waits per pane (`lib.rs:481-510`). Residual: a stalled resize holds an `Arc` to the master, so a killed pane's `ClosePseudoConsole` waits for that resize to return. |
| F2 two instances write one journal | `db899db` | Closed for the scenario. An exclusive lease on `<state>.tasks.lock` is taken first in setup (`lib.rs:1594`, `workspace.rs:9-19`), on a canonical path, and the pipe name now canonicalizes too, so junction aliases share one owner. The refusal path crashes the process (C8). Hard links to the same workspace file still get two leases. |
| F3 unreadable workspace becomes empty and is saved | `85fbc06` | Closed. `read_workspace` separates missing from unreadable or empty (`lib.rs:1351`), and `main()` stops before any save on a read or parse failure (`main.ts:8657-8663`). A shape error later in `main()` also leaves `restoring` true, so nothing is saved. C6 is the remaining way to lose this file. |
| F4 deletion approval ignores file contents | `b225fd2` | Closed for the approval paths: the inventory now carries a SHA-256 over every file and the index, and the pre-close, post-stop and retry checks compare it. It also refuses most real worktrees (C3), and `--force` bypasses it entirely (C1). |
| F5 large diffs transferred and parsed whole | `df33211` | Closed for previews: 4 MiB stdout cap, 5 s deadline, parse stops at 50,001 rows. The cap applies to every `git diff`, including the Changes panel's `--numstat` calls (C4). |
| F6 / N3 usage timeout releases the guard while native work runs | `2f5fe5a` | Closed. The promise stays in `providerPolls` until the native call settles, each caller races only its own 2 s wait, and late results are applied under the generation and session check (`main.ts:7438-7455`). |
| F7 a finished stop marks a replacement launch dead | none | Open. `Pane.stop()` still calls `exited()` unconditionally after the await (`main.ts:1855-1858`), and `pty-exit:<id>` still carries only the exit code (`lib.rs:438`). |
| F8 close does not drain the task journal | none | Open. The close handler awaits session polling and the workspace save, then `pty_shutdown` and `destroy()`, never `journalQueue` (`main.ts:8709-8722`). |
| F9 dictation pastes into a restarted pane | none | Open. `micStop` captures no generation or input sequence (`main.ts:1388-1429`). |
| F10 loomctl trusts any server that says the right protocol | none | Open. No `GetNamedPipeServerProcessId` or SID check, and Loom only `eprintln!`s when its pipe name is taken (`control.rs:39`), which a GUI build never shows. |
| F11 loomctl and Loom update separately | none | Open, and easier to hit than the original text says: the email bridge keeps `loomctl watch` running, so `update.ps1:33` throws on the mapped `loomctl.exe` and never updates `loom.exe`. See C17 for the installer side. |
| F12 journal append spreads all event numbers into `Math.min` | none | Open (`main.ts:3809`). The throw happens inside the queued closure, before `invoke`, so the rejection handler that sets `journalDirty` and `unsaved` never runs and the task still reports `saved: true`. |
| F13 valid JSON with a bad shape aborts startup | none | Open (`task.ts:436`, `main.ts:4414`). The effect is worse than described: `main()` rejects at `await loadTasks()`, so `installCli()` never runs, `restoring` stays true and every workspace change in that session is silently never saved, and `startupTurns` buffers every task change forever. |
| F14 session and wake markers keyed by pane id | none | Open. `session-marks/<pane>`, `loom-wait/<pane>` and `loom-tx/<pane>` carry no launch; only `loom-task` events do. |
| F15 junction-following walks | none | Open. `list_files` (`lib.rs:696-720`) and `codex_rollouts` (`lib.rs:1072-1084`) follow linked folders with no visited set or depth limit. `codex_rollouts` runs on Codex restore, the session picker and `last_messages`. |
| F16 no Job Object for pane process trees | none | Open. Cleanup is still `taskkill /T /F` with the result ignored. |
| F17 pipe connections have no admission limit or deadlines | none | Open (`control.rs:43-49`, hello and request reads, both writes). |
| F18 receipts and dashboard caches retain closed panes | none | Open. `Receipt.pane` is still a live `Pane` (`main.ts:3658`) and `dashboardMessages` is never pruned. |
| F19 apostrophe in `$INSTDIR` breaks the PATH hook | none | Open (`nsis-hooks.nsi:40,46`), and `nsExec` results are still unchecked. |
| N1 GitLab and Hugging Face tokens pass as model ids | `4dc616a` | Closed on both boundaries (`task.ts:62`, `usage.rs` `CREDENTIAL`). |
| N2 notification context ignores the new credential formats | `33f6c5b` | Closed. Labels and restored thread ids use `privateValue` (`task.ts:64`, `:88`, `:114`). |
| N4 a scoped query evicts other sessions' readers | `8b0fb64` | Closed. Readers persist across scoped reads, with a 128-entry LRU bound. It keeps closed sessions' buffers (C13). |
| N5 `vendor/token:latest` rejected as a credential | `a84442d` | Closed. Settings use `credentialOrPath`; only free-text labels keep the `token:` heuristic. |
| N6 truncate and regrow keeps the old file's state | `15e44bb` | Closed. Four hashed checkpoints (first 4 KiB, last 4 KiB before the offset, the last turn_context and token_count records) reset the reader on mismatch. `fold_codex` reads only those two record types, so a rewrite that keeps all four cannot change the result. |
| N7 unset effort keeps the old effort | `d9be857` | Closed. `effort_observed` makes an observed unset effort export as null and stops the startup fallback from reviving it (`main.ts:7476`). |

## New findings, most severe first

### C1. P1: `close-thread --force` deletes through junctions, outside the worktree

Location: `src/main.ts:8459-8477` (`--force` passes `approved = null`), `src/main.ts:5223-5237` (no check runs when `expected` is null), `git worktree remove --force` at `:5237`.

Failing scenario: a worktree contains a directory junction, for example `node_modules` linked to the main checkout to skip an install, which has happened in this repo before. An agent runs `loomctl close-thread X --yes --delete worktree --force`. Loom closes the panes and runs `git worktree remove --force`, which recurses through the junction and deletes the files in its target. I reproduced this in a scratch folder with the installed `git version 2.39.1.windows.1`: a worktree with `link -> ..\target`, then `git worktree remove --force`, exit 0, and `target\keep.txt` was gone. The fingerprint refuses reparse points, so the dialog and `--plan` paths are protected. `--force` never computes it.

C3 makes this likelier. A worktree that has been built once has more than 20,000 entries (this checkout's `src-tauri/target` alone passes 25,000 and is 11 GB), so `close-plan` and every non-forced `--delete` fail, and `--force` is the only command that works.

Fix: never let git walk the tree. Before `git worktree remove`, on every path including `--force`, remove each directory junction and symlink inside the worktree with `RemoveDirectoryW` on the link itself (what `cmd /c rmdir <link>` does), or delete the folder with a remover that does not follow reparse points and then run `git worktree prune`. Rust's `std::fs::remove_dir_all` removes links without following them. A metadata-only walk for reparse points is cheap; it doesn't need the content hash or its 20,000-entry cap.

### C2. P2: since `ef14290`, a Codex pane shows "working" while it waits on an approval or sits idle

Location: `src/main.ts:2068-2072` (`activity()`), `:2216-2222` (`seen()` now calls it), `:2298-2301` (`focus()` calls `seen()`), `:2653-2661` and `:5023-5047` (`show()` and `focusPane()` call `focus()`), `:2420` (`INTERRUPT_HINT`).

`status` is `INTERRUPT_HINT.test(screen) || codexRunning(codexState)`, and busy is now set on every draw while `status && !busy && !waiting`. Both inputs can be true while nothing runs:

1. Codex keeps its title at Working or Thinking through an approval. `run_state_status_text` returns those whenever `bottom_pane.is_task_running()`, which follows `agent_turn_running`, and the approval handlers in `tool_requests.rs` and `protocol_requests.rs` change neither. I read this in the current `openai/codex` source; the installed 0.160 may differ in detail.
2. The hint regex runs over the whole live screen, and in inline mode that includes the tail of the transcript.

Failing scenario A: Codex asks for approval. OSC 9 sets waiting. You press F3, click the waiting chip, click the thread or run `loomctl next` or `show`. Each ends in `focusPane()`, so `seen()` clears waiting and `activity()` finds the title still saying Working and sets busy. Before you have answered, the pane reads Working in the sidebar and Overview and `working` in `loomctl panes`, `status` and `wait-any --state waiting`. The overlay drops it from the waiting rows.

Failing scenario B: a Codex turn ends with an answer that quotes "esc to interrupt". That's likely here, since main.ts, task-check.mjs and these review files all contain the phrase. The title says Ready and the turn-complete alert sets waiting. Once you look at the pane, `activity()` sets busy from the quoted text, and nothing clears it until the text scrolls off. `loomctl wait <pane> --state idle` and `wait --task --or-idle` hang until timeout. The 8 Hz spinner clock runs while Loom is focused, and the overlay in background mode stays on screen for a phantom worker.

Before `ef14290` the edge trigger kept both scenarios at idle, which was wrong in a different way. The new `pane-state` case in `task-check.mjs` proves what it claims, but it never focuses a pane while an approval is pending, and it never draws a Ready title with hint text above the composer.

Fix: when the title has reported a run state, trust it alone: `status = codexState !== undefined ? codexRunning(codexState) : hintInStatusRows(screen)`. Read the hint fallback only from the rows above the composer, not the whole screen. Don't set busy while this launch has an unanswered approval: `readMenu(liveScreen(p, false))` already recognizes Codex's "› 1. ..." approval menu (`prompt.ts:183`), or keep a flag set by `codexAsks` and cleared by a delivered answer in `wrote()`.

### C3. P2: worktree deletion now refuses most real worktrees

Location: `src-tauri/src/deletion.rs:19-21` (5 s or 256 MiB), `:31-33` and `:47-49` (20,000 entries, depth 64), `:37-39` (any reparse point), `:14` (`share_mode(1)`); `src/main.ts:5187-5192`, `:7587`, `:8464-8467`.

Failing scenario: delete a Loom worktree that has been built, or any JS or Rust project with `node_modules` or `target`, or any pnpm layout, which uses junctions. The dialog path says "Could not inspect the complete worktree. Nothing was closed or deleted." `close-plan` and `close-thread --delete worktree` without `--force` fail with "Couldn't read what deleting X would lose". `--discard all` still runs the plan, so it fails too. Only `--force` works, and that is C1's path. The hash also opens every file with `FILE_SHARE_READ` only, so a file that an agent, a dev server or SQLite holds open for writing fails the whole check, and an agent writing a file while it's hashed gets a sharing violation.

Fix: hash contents only for what git reports as tracked changes and untracked files. That is what the user is asked about, and it's usually small. For ignored paths, record names, sizes and modified times, or skip them when the approval already discards `ignored`. Keep the reparse-point scan as its own cheap metadata walk (C1). Open files with read, write and delete sharing and compare size and time before and after reading rather than locking writers out. Keep failing closed when the bounded check can't finish, but make `--discard all` mean "don't hash what I'm discarding".

### C4. P2: the diff preview bound breaks the Changes panel

Location: `src-tauri/src/lib.rs:550-574` (every `diff` and `show` goes through `diff_output`), `:585-622` (64 KiB stderr cap, 5 s deadline); `src/main.ts:5981-5986`, `:6250`.

The bound meant for previews also applies to the Changes panel's three `git diff --numstat` calls and the sidebar's `pollStats`. Two ordinary situations now fail:

- This repo has `core.autocrlf=true`. Git prints one "warning: in the working copy of '…', LF will be replaced by CRLF" line per affected file, which I measured at about 128 bytes. Once a formatter or codemod leaves about 500 files with LF endings, stderr passes 64 KiB and `diff_output` fails. The panel shows only "Diff preview exceeds its output limit (4 MiB stdout, 64 KiB stderr). Open the file in an editor." The thread's line counts stop updating.
- In a large repository, `git diff --numstat` can take longer than 5 s, especially with `GIT_OPTIONAL_LOCKS=0`, which keeps Loom's own runs from refreshing the index. The panel then shows "Diff preview exceeded five seconds" instead of the file list.

Fix: bound only the preview loaders (`diffLoader`, `diffOf`), for example with a separate command or a flag. On success git's stderr isn't returned, so read and discard it past the cap instead of failing.

### C5. P2: `loomctl new` on an unreachable path blocks the window

Location: `src-tauri/src/lib.rs:100-108` (`canonical_directory` is a sync command, so it runs on the main thread); caller `src/main.ts:8067`.

Failing scenario: `loomctl new \\nas\share\proj`, or a folder on a disconnected mapped drive. `std::fs::canonicalize` waits for the SMB redirector timeout, typically tens of seconds. Meanwhile the window doesn't pump messages, every other loomctl request queues behind it, and a click on the window can turn into a Windows Application Hang. A second `loom.exe` launch waits too, inside the single-instance plugin's `SendMessageW`. That fits the "Top level window is idle" hang type of the 00:55 event, though nothing ties that incident to this path.

Fix: move it into `mod commands` behind `blocking(...)`, as the other filesystem commands are.

### C6. P2: a power loss after a save can leave an empty workspace with no copy

Location: `src-tauri/src/lib.rs:1360-1367`.

`save_state` writes `<state>.json.pending` and renames it over the workspace without `sync_all`. NTFS journals the rename but not the file data, so a BSOD or power cut in the seconds after a save can leave `workspaces.json` zero-filled or empty. Since `85fbc06`, Loom then refuses to start that workspace rather than overwriting it, which is right, but the threads, pane commands and session ids to resume are gone, because nothing keeps the previous file. The task journal's rewrite already does `sync_all` before its rename (`lib.rs:955-962`).

Fix: `File::create`, `write_all`, `sync_all`, then rename, as the journal does. Keep the replaced file as `.bak` and offer it in the "Workspace could not be loaded" dialog.

### C7. P2: a Claude task stays `working` after its Stop while the transcript shows the hint

Location: `src/main.ts:4353-4354` (`busy` uses `INTERRUPT_HINT` over the whole live screen), `:4371` (completion needs `!busy`), `:4376-4378`.

Claude Code 2.1.288 no longer draws "esc to interrupt" in its working line, so for Claude panes this regex now matches mostly transcript text. Failing scenario: a submitted Claude turn ends with an answer that mentions "esc to interrupt", easy when the work is on Loom itself. The Stop hook arrives, but the sweep sees `busy` on every tick, keeps resetting `quietSince` and never completes the task. No `finish` notice is sent and `wait --task` runs to its timeout. The task only moves when the text scrolls off, usually during the next turn. This predates the reviewed range. It is one plausible cause of open issue 3 in `LOOMCTL_OPEN_ISSUES_2026-10-04.md`, which I couldn't confirm without that session's screen.

Fix: for Claude, rely on `claudeWorking` (anchored to column 0) and the API retry banner's own row; restrict any hint check to the rows next to the input box. Apply the same row restriction to Codex in the sweep (C2).

### C8. P3: refusing a second instance of a profile crashes the process

Location: `src-tauri/src/lib.rs:1594-1602`; Tauri 2.11.5 `app.rs:1425` turns a setup error into `panic!("Failed to setup app")`; `Cargo.toml` sets `panic = "abort"` for release.

Failing scenario: open `loom.exe work.json` twice. The second process shows the "Workspace unavailable" dialog, then aborts with a fail-fast exception and a WER Application Error entry. Those entries make the hang investigation's event log noisier, and a stuck mid-exit `loom.exe`, a known cause here, produces one on every relaunch attempt.

Fix: after the dialog, `std::process::exit(1)` instead of returning `Err`. Retry the lease for a second or two first, and name the owning process if `RmGetList` can find it.

### C9. P3: an untracked Codex approval answered through `loomctl keys` leaves the pane waiting

Location: `src/main.ts:2406-2414`, `:3523-3535`.

`wrote()` acknowledges the alert only when a tracked task is in `approval`. For a turn Loom hasn't adopted yet (a manual Enter with an unreadable composer is adopted at the turn's end), `loomctl keys <pane> enter` delivers the answer, but nothing calls `seen()`. The pane says waiting for the rest of the turn, and `activity()` won't set busy while it does. That's the original "idle while working" report, still present for untracked turns. Fix: in `wrote()`, call `seen()` after any delivered Enter or one-key answer when the alert predates the write (`waitingSince <= lastIn`), whether or not a task tracks it.

### C10. P3: one failed pipe re-creation stops the control pipe until restart

Location: `src-tauri/src/control.rs:36-41`. After the first instance, a `create` error returns from the serve loop. A transient `CreateNamedPipe` failure, such as running out of resources on this low-memory machine, leaves that pipe with no listener: loomctl reports not running and the bridge's `watch --follow` retries forever. Fix: log, back off and retry.

### C11. P3: an append after a torn journal tail glues the next record onto it

Location: `src-tauri/src/lib.rs:948-954`; `src/main.ts:4425-4441`. Append mode writes after whatever the file ends with. A journal that holds only policy lines and a torn last line gets no whole rewrite at load, because no task is marked unsaved. `recordNotify` then appends a snapshot onto the fragment, and the next replay skips that line, losing a mute the user set. Fix: in append mode, write a newline first when the file doesn't end in one.

### C12. P3: a partly failed deletion is reported as "kept"

Location: `src/main.ts:5232-5243`. When `git worktree remove --force` deletes part of the tree and then fails on a busy file, the retry's inventory differs from `expected`, and Loom returns `worktree: "kept"` with "worktree changed during deletion retries". The folder is half deleted. Fix: report `failed`, "may be partly deleted", as the final catch already does.

### C13. P3: Codex readers of closed sessions keep their buffers

Location: `src-tauri/src/usage.rs:535-539`, `:454`, `:469`. Since `8b0fb64` readers live until 128 exist, and `pending.clear()` keeps the capacity a near-256 KiB record grew. A day of Codex panes with large tool records can hold tens of MB on a machine already short of memory. Fix: replace `pending` with a fresh `Vec` after an oversized or large record, and prune against the live-session set as well as the LRU bound.

### C14. P3: a partly read rollout is exported as current

Location: `src-tauri/src/usage.rs:446-477`. Each refresh reads at most 16 MiB and returns the fold so far. After a restart, a resumed Codex pane with an 80 MB rollout reports the session's early model, effort and context for several refreshes, and while minimized only CLI reads advance it. Fix: keep a `caught_up` flag and mark or hold back readings until the reader reaches the end.

### C15. P3: Codex plan usage ignores `CODEX_HOME`

Location: `src-tauri/src/usage.rs:1019-1023`. `codex_homes()` reads only `%USERPROFILE%\.codex`, while `codex_home` (`lib.rs:1004`), the notify helper and the SQLite seeding honor `CODEX_HOME`. With it set, the plan chip says to sign in and the local fallback reads the wrong sessions folder. Fix: reuse the same resolution.

### C16. P3: `last_messages` reads backwards without a byte bound

Location: `src-tauri/src/lib.rs:1148-1176`. It reads 64 KiB chunks back to the last user message and buffers whole lines however long. During a long Codex turn with tens of MB of tool output, each Overview refresh rereads that span. Fix: cap the total bytes, skip lines over 256 KiB without buffering them, and keep the previous preview when the cap is reached.

### C17. P3: installer and update leftovers

- `nsis-hooks.nsi:39` overwrites `loomctl.exe` with no move-aside, unlike `loom.exe`. The bridge's `loomctl watch` survives Loom being killed, because `--follow` reconnects, so NSIS hits a write error and shows abort/retry/ignore.
- `update.ps1:15,52` keeps every `loom-before-update-*.exe` backup forever, and uninstall leaves them behind.
- In Windows PowerShell 5.1, the PATH hook's `GetEnvironmentVariable('Path','User')` returns expanded text and `SetEnvironmentVariable` writes `REG_SZ`, so `%VAR%` entries in the user PATH get frozen. This is .NET Framework behaviour I didn't run; the user PATH on this machine has no such entries today. Writing the value from NSIS as `REG_EXPAND_SZ` with `$INSTDIR` as data would also fix F19.

### C18. P3: smaller native issues

- `dictate_level` (`dictate.rs:78-90`) is a sync main-thread command that locks `rec`, which `dictate_start` holds across audio device startup (`:50-61`). A poll still in flight when dictation restarts makes the main thread wait for the device. Use `try_lock` in the poll.
- The 250 ms poller and a pane's exit thread can drain the same `loom-task` and `loom-wait` files at once (`lib.rs:436-437`, `:907-926`, `:1248-1269`), so one event can be emitted twice. Route handles the duplicates I traced as no-ops, but claiming a file by rename before reading it would remove the race.
- `%TEMP%\loom-status`, `%TEMP%\loom-tx` and the data folder's `session-marks` are never pruned, and pane ids change every run.
- The config panel's `slash()` (`main.ts:6607-6617`) pastes and writes Enter outside `inTurn`. If you pick a model while a `loomctl send` to the same pane waits for its echo, the Enter submits both texts joined. The send then reports "its input holds both" after the fact.

## Checked and clean

- Lock ordering on the native side: the PTY map, `Flows`, `Resizes`, the new master mutex, the output bus and `control::Pending` never nest, and nothing slow runs under the PTY map lock. `pty_write` is a non-blocking channel send.
- The setup-time workspace dialog doesn't deadlock: the dialog plugin runs rfd on its own thread. Helper modes (`--claude-hook`, `--codex-notify`, `--statusline`, `--session-start`) exit before the builder and the lease (`lib.rs:1533-1538`).
- Pane teardown: writer, emitter and waiter threads end after a kill; the waiter's pid check survives PID reuse because the child handle stays open; the page acks output for disposed channels, so killed panes don't stall the bus.
- Pipe protocol: a request runs only when its line ends in a newline, the hello refuses a protocol mismatch, loomctl never resends a mutation (`--follow` repeats only `watch`), and the DACL is the owner and SYSTEM. Account-usage tokens reach curl through `-K -` on stdin, never argv, and errors are fixed strings with no provider body or curl stderr.
- Journal: whole rewrites are temp, `sync_all`, rename; appends `sync_all`; a refused reservation keeps its spent number as a cancelled task; `watch` and `notify --check` stay behind `writtenSeq`. The v3 `watch --metadata --policy` shape and the ASH-LOOM-EVENT contract are unchanged by this range.
- Task routing in `task.ts`: `9ea7bfe` clears the answered question's `detail` without touching history, and the approval, resume and interrupt routes still act only on the reporting launch's tasks.
- The new checkpoints in the Codex reader cost a few KiB of hashing per pane per poll; credential checks match between `task.ts` and `usage.rs`.
- The F3 failure path registers no close handler, so the window closes normally and nothing is saved.

## How this was checked

I read `src/main.ts` in the areas this range touched and in every area the brief named (Pane lifecycle and activity, input turns, the task journal and sweep, close-thread and deletion, startup and close, the loomctl table), plus `task.ts`, `agent.ts`, `prompt.ts`, `cli.ts`, `gitparse.ts`, `task_event_gate.ts` and every commit in `5196892..ef14290`. The helper reviewers covered the rest of `src-tauri/src`, `usage.rs`, the NSIS hooks and `update.ps1`.

Runs, all outside the repo: a scratch git repo showing that `git worktree remove --force` empties a junction's target (C1), a scratch repo measuring git's autocrlf warning size (C4), a count of this checkout's `node_modules` and `target` entries (C1, C3), and a fetch of the Codex TUI sources for its run-state title logic (C2). I ran no build, test suite, installer or live pane, and the C2 and C7 scenarios are traced through the code rather than reproduced in the app. I didn't edit, stage or commit anything, and I left the untracked docs alone. This report is the only file written.
