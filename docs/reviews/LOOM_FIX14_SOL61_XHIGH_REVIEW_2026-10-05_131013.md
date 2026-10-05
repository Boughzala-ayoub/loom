# Loom fix review

Reviewed `main` at `03dad3ab56b1b75b0b7d226d08e43ab4652382d8` on 2026-10-05, Africa/Tunis. The requested range, `ed34c3e..HEAD`, contains 20 commits.

I read `LOOM_FIX13_SOL61_XHIGH_REVIEW_2026-10-05_070538.md` first, read the earlier full review for context, inspected all 20 commits, and traced the changed code through its callers. Line numbers refer to HEAD. This review writes only this report. Existing untracked documents were left alone. There were no builds, staging, commits, installer runs, live app operations, or changes to real worktrees.

## Status of RF1 through RF16

"Closed for its case" is a verdict about the reported failing scenario, not a claim that the whole subsystem is correct.

| Finding | Verdict | Does the fix close its own failing scenario? |
| --- | --- | --- |
| RF1, redirected deletion root | Partial | Direct root junctions, symlinks, and mount points are refused. An unrelated folder behind a redirected parent fails the `.git` administration check. A parent redirected to another unlocked worktree of the same repository still passes. R14-1. The checked root and its ancestors are also released before deletion. R14-2. |
| RF2, nested checkout deletion | Closed for a checkout already present at validation | Both forced and approved removals run the native walk. A nested `.git` file or directory, case-insensitively, refuses the operation, including a different repository, locked nested worktree, or initialized submodule. Interior directory links are skipped, so their targets are not deleted. A checkout introduced after validation is part of R14-2. |
| RF3, console closes before job and reader stops early | Closed for its reported teardown case | `_job` is now the first Session field to drop. The pump continues reading after its emitter disappears, so closing the flow no longer strands console output unread. I found no new teardown lock cycle. Job assignment and breakaway remain explicit containment limits, discussed below. |
| RF4, approved inventory not handed to native deletion | Partial | The approved fingerprint and hashed-file list now reach Rust. Changes made at the original path before the rename are detected after claiming it. Ordinary writers using the old path cannot write into the renamed tree. The claim pin does not exclude writes inside the claim, and it closes before the destructive open. R14-2. |
| RF5, stop check and removal under separate locks | Closed for its case | Rust compares the requested launch and removes the Session under one map lock. Output flows include the launch and only matching flows close. This fixes both killing a replacement Session and closing a replacement's already registered output. R14-3 is a separate frontend regression. |
| RF6, early exit lost or old exit marks replacement dead | Closed for both reported event-order cases; new regression | Publishing `launched` before native spawn accepts an early current exit and rejects an older exit. The successful spawn reply does not overwrite an early exit. Publishing it before Claude's remaining preparation awaits makes stop target a process that does not yet exist. R14-3. |
| RF7, Claude markers and usage cross launches | Closed for the normal Loom hook path | Transcript and status markers use `<pane>.<launch>`, and an outstanding usage result is discarded when `launched` changes. A hook invoking the current helper inherits `LOOM_LAUNCH`; its command need not pass an explicit launch argument. Older custom bare-filename writers are discussed below. |
| RF8, shared marker update lost during claim | Closed for the ordinary claim conflict | Rust and OpenCode producers retry sharing/access conflicts for about one second. Session markers use the exclusive read/delete claim rather than read-then-unlink. OpenCode awaits publication inside its event queue, preserving order. This is bounded retry, not guaranteed delivery through a longer claim. |
| RF9, arbitrary alphanumeric clears approval | Closed for the reported invalid-key/free-text cases; narrow regression | An arbitrary `x` and the first letter of a free-text draft no longer acknowledge approval. Enter remains accepted, and named shortcuts are recognized from the menu. A shortcut wrapped onto another row is lost, leaving a resumed Codex pane idle or waiting. R14-7. |
| RF10, adjacent quotes/drafts and truncated status | Partial | The exact ordinary adjacent quote, composer draft, and prefixed Claude retry-quote cases are fixed. A legacy status containing its header and elapsed time works without the complete hint. An idle transcript quote with that header and clock is still accepted. R14-8. A legacy row truncated to `Worki`, with no title or hint, still reads idle. |
| RF11, installer pair and updater rollback | Partial | PowerShell refuses a missing CLI source and attempts every completed replacement's rollback even if another restoration fails. NSIS retains rollback images through its second CLI write and restores recorded images on installation failure. An ignored main-image write and an unchecked backup fallback still defeat the pair guarantee. R14-5. |
| RF12, disconnected long waits occupy admission cap | Native failing case closed; page lifetime remains open | Disconnect drops the native request future, removes its waiter through Drop, and frees the active slot. A later page reply cannot answer a newer id. The page is never told to cancel, so the former connection cap no longer bounds abandoned page waits. R14-6. |
| RF13, dictation destination captured after mic opens | Closed for its case | The generation is captured before `dictate_start` and checked before prefix paste or recording assignment. A changed destination stops/discards the opened recording. The existing generation checks during transcription and submission remain. |
| RF14, shutdown reports never reach journal | Partial | Reports consumed by `pty_shutdown` return with the call and are handled before the second journal drain. A normal Codex `end` returned this way is queued for persistence. Claude Stop queues no journal record, and competing/in-flight drainers are outside the return barrier. R14-4. |
| RF15, malformed recognized task value silently skipped | Closed for its reported case | A present task value enters shape validation even when it is a string, null, false, or number. Present malformed event/change values are also checked. The lenient notify reader is a separate policy choice. This is not exhaustive validation of every journal corruption. |
| RF16, backup failure silently ignored | Closed for its ordinary failure cases | A replacement backup is prepared beside the old backup, hard-link failure falls back to a flushed copy, and preparation/rename failure refuses the save. The existing backup is not removed first. The pending-backup obstruction test catches behavior the old code would miss. |

## Remaining and new findings, ranked

P1 means data loss, crash, hang, or security. P2 means wrong behavior. P3 means a minor issue. Some findings are remaining gaps rather than bugs first introduced in this range.

### R14-1. P1. A redirected parent still selects another worktree for deletion

Location: `src-tauri/src/deletion.rs:119`, `:166`, `:168`; force caller at `src/main.ts:8585`.

Create two unlocked linked worktrees of repository R at `A/wt` and `B/wt`. Loom's thread names `A/wt`. Move A aside and replace A with a junction to B. Run `close-thread` for the original thread with `--yes --delete worktree --force`.

The root at `A/wt` is B's ordinary directory, not a reparse point. Its `.git` file names B's administration entry inside R's `worktrees`, and that entry's backlink opens the same `.git` file through B's real path. Both file-identity comparisons pass. The rename claims B's directory, the unchecked approval path deletes it, and B's Git entry is removed. The moved original A survives. Unsaved data in B is lost despite the command targeting A; a separate pane using B is not included in A's cleanup. B must be unlocked and unused enough for the rename to succeed.

This admitted gap is reachable without racing deletion itself. The parent can already be redirected before the command. It is narrower than the former arbitrary-folder deletion, but remains P1. `--force` approves discarding the selected worktree's data, not choosing a different worktree through a changed ancestor.

Fix: bind the target to its expected administration entry and root identity before destructive authorization. Carry those identities into native deletion. Validate the registered path for that specific entry; checking whichever valid entry the current `.git` file names is insufficient. Refuse redirected ancestry unless its identity is explicitly part of the authorized target.

Evidence: the targeted scratch check created two Git worktrees, redirected only their scratch parent, and verified that both current `entry_of` identity predicates accept B. No remover was called on either worktree.

### R14-2. P1. Claim validation still ends before the exclusive destructive boundary

Location: `src-tauri/src/deletion.rs:126`, `:131`, `:140`.

The root pin uses share mode 3 with read-attributes access. It prevents incompatible rename/delete operations on that directory while held. It does not prevent creating or changing children. After fingerprinting, the closure drops the pin and `remove_dir_all` opens the pathname again.

A concrete unapproved-data case is a writer that tracks the parent's rename notification and writes a new file under `.wt.loom-deleting` after the walk passes that directory. It closes the file before recursive removal reaches it. The write succeeds even while the root pin is held, and the new file is deleted although absent from the approved inventory. The deterministic claim name is observable and is not an ownership boundary.

There is also an outside-target case after the pin closes. Move the claim's parent aside and replace it with a junction to a sibling parent containing an ordinary directory with the same claim basename. The recursive remover's initial pathname resolves through that redirected ancestor to the other directory. It does not compare the newly opened root to `was`. Removing a link at the final component safely does not protect against a link in an ancestor. Rust's Windows implementation opens the initial root by pathname, then removes children relative to handles. Its descendant-link protection does not bind that initial open to Loom's prior identity check. [Rust Windows root open](https://github.com/rust-lang/rust/blob/1.90.0/library/std/src/sys/fs/windows.rs#L1242), [handle-relative removal](https://github.com/rust-lang/rust/blob/1.90.0/library/std/src/sys/fs/windows/remove_dir_all.rs#L161)

The rename closes the original report's ordinary old-path writer window. It is not an atomic approval guarantee. The source comment acknowledges a claim-name swap, but covers only a link at the claim itself and omits mutable ancestors and child writes. The same window can introduce a nested checkout after RF2's walk.

Fix: keep the claimed root and necessary ancestry bound by handles through removal, and remove relative to that checked root. Exclude child mutation during validation/removal or refuse when that exclusion cannot be established. A further pathname hash followed by another unlocked pathname delete still leaves the same gap.

Evidence: a native Windows scratch probe confirmed that creating a child succeeds while a pin with Loom's access, share mode, and flags is held. It also confirmed that renaming a directory with an open child file fails on this machine, even when that file permits delete sharing. I therefore do not claim an ordinary writer holding its original file open survives the initial rename. The post-validation write and ancestor replacement are source interleavings, not destructive reproductions.

### R14-3. P2. Stop during Claude preparation leaves the old process alive behind an exited pane

Location: `src/main.ts:1883`, `:1985`, `:1987`, `:1991`; native refusal at `src-tauri/src/lib.rs:571`.

A live Claude pane has native launch A. Restart it with resume. The replacement sets `dead = false` and publishes `launched = B`, then awaits `has_session`. Before that check replies, issue `loomctl stop ... --yes`, or use the UI stop control.

Stop cancels the pending launch generation and sends `pty_kill` for B. Native still holds A, so the atomic launch check correctly refuses that kill. Stop then marks the pane exited. When `has_session` replies, the stale launch returns at line 1991 without spawning B or killing A. A is still running and retains its console/job, but Loom advertises the pane as exited. A's eventual exit is also ignored because `launched` still names B.

This was introduced by moving publication ahead of the preparation awaits. The early-spawn exit tests hold the `pty_spawn` reply, so they start after this window and cannot expose it.

Fix: keep the native process launch separate from the generation accepted for pending-spawn events, or publish the replacement immediately before native spawn after preparation. A stop must cancel the pending spawn and terminate the still-installed process without targeting a later replacement.

Evidence: the targeted check extracted the actual `spawn`, `launch`, and `stop` methods through TypeScript's AST, held `has_session`, and modeled Rust's launch comparison. Before `47d7ff5`, the old Session was removed. At HEAD, the pane was dead while Session A remained. No app process was launched.

### R14-4. P2. Shutdown can still discard reports, including a returned Claude Stop

Location: `src/main.ts:4349`, `:4462`, `:8828`; `src-tauri/src/lib.rs:591`, `:603`, `:978`, `:1019`, `:1829`.

First case: Claude has finished, its screen is idle, and its async Stop report becomes available after the first journal drain. Shutdown returns the report. `taskSignal` records its `stopAt` and response only in `taskWatch`; it calls no `moveTask` or journal write for Stop. The second drain can finish and destroy the window before the sweep's required 500 ms elapses. The report file has been consumed, the task still reads working in the journal, and the final response hash was never persisted. On restart the task becomes `unknown/loom-restarted` with no recoverable Stop report.

I accept that a Stop alone must not blindly complete a Claude task: another hook can keep Claude working. That does not justify losing the report. In this concrete already-idle case a later sweep would have completed the task if the window remained open. For an ambiguous case, the report and response still need durable retention or explicit shutdown classification.

Second case: the periodic drainer copied pane ids before shutdown, exclusively opened a final immutable event file, and is descheduled before finishing its read/emission. Shutdown takes the Sessions, cannot claim that file, returns no event for it, and the page drains/destroys. The earlier drainer later deletes the file and emits to the closing or destroyed page. It is not joined or acknowledged by the returned array. An exit waiter that removed its Session before the shutdown snapshot has the same missing-id problem. This can lose a Codex end too.

Fix: stop and join competing drainers, include pending exit deliveries, and establish one acknowledged final delivery barrier before destruction. Handle/persist deferred Claude Stop reports within that barrier. Preserve uncertainty when shutdown cannot establish completion; do not manufacture a successful outcome.

Evidence: source lifetime trace, plus a direct check of the real `route` and `writeJournal` functions showing that a Claude Stop leaves the task working and its response out of the journal. The new `shutdown-reports` test returns a Codex `end` synchronously from a mock. It tests the returned-array path, but neither case above.

### R14-5. P2. NSIS can report a successful pair when the main write was skipped

Location: `src-tauri/nsis-hooks.nsi:59`, `:63`, `:67`, `:90`, `:114`, `:121`.

After PREINSTALL makes rollback images and copies, the template writes `loom.exe` with its normal File instruction. Let another process deny writes to that main-image destination and choose Ignore at the extraction prompt. The installer continues with the old main copy. POSTINSTALL clears the error flag and checks only its second `loomctl.exe` write. That write succeeds, so it discards both rollback images and finishes with an old app and new CLI.

The local generated Tauri script has the main File instruction at `installer.nsi:639` and invokes POSTINSTALL at `:706`. It is an existing generated artifact, not a rebuilt verification of HEAD. The current hook does not re-extract or verify the main image. NSIS documents that an ignored File failure sets the error flag, which `ClearErrors` here discards. [NSIS File reference](https://nsis.sourceforge.io/Reference/File)

A second remaining case is MoveAside failure. If a deny-delete handle prevents moving the old app but permits overwriting it, the hook falls back to installing in place with `LoomMainOld` empty. A later CLI failure cannot restore the overwritten app. CopyFiles failure also falls back, and the attempted restoration Rename is unchecked. `.onInstFailed` restores only backups that were successfully recorded; it cannot recover these missing ones.

Fix: require a verified previous copy before replacing an existing image, and verify/re-extract both new executables before declaring the pair installed or deleting backups. Abort rather than falling back to an unbacked in-place update. Check the backup-copy restoration too. `.onInstFailed` is useful, but runs on a failed installation's cancellation, not an Ignore path that reaches success. [NSIS callback reference](https://nsis.sourceforge.io/Docs/Chapter4.html#4.7.2.1.3)

Evidence: template/hook/error-path trace and primary NSIS documentation. No installer was run. The PowerShell missing-source and ordinary rollback fixes close their cases; this finding concerns NSIS.

### R14-6. P2. Freed native slots permit unbounded abandoned page waits

Location: `src-tauri/src/control.rs:159`, `:173`, `:277`; `src/main.ts:7672`, `:8698`, `:8721`; `src/task_event_gate.ts:12`.

Issue complete valid `wait` requests for an unmet condition with a 24-hour timeout, disconnect each client, then repeat. Each disconnect now frees the native slot. Each already-emitted page request retains its handler, payload, references, and 200 ms polling timer until its original deadline or condition is met. Abandoned `watch` requests retain TaskEventGate listeners and deadline timers. The frontend has no admission cap for unkeyed waits and receives no cancellation.

The old native-cap exhaustion is fixed, but its resource bound is gone for these page operations. A reconnecting or interrupted local automation can accumulate far more than 64 long waits, adding memory and repeated page work for a day. Closing or pruning a task does not necessarily end every requested wait condition.

Fix: send cancellation by request id on disconnect and cancel read-only wait/watch timers and listeners. Keep mutation/idempotency handling separate so disconnect never causes an unknown mutation to be resent. Alternatively retain a bounded frontend waiter cap until cancellation exists.

There is no identified wrong-request reply: ids increase through a native u64 counter, and a late `cli_reply` for a removed id is ignored. Retrying a keyed request shares its original result deliberately. The defect is resource lifetime, not id confusion.

Evidence: native Drop and page-handler/poll/gate lifetime trace. I did not flood the low-memory machine. The named-pipe test proves EOF ends the native wait; it does not observe frontend cancellation or bound these retained operations.

### R14-7. P2. A wrapped approval shortcut leaves a working Codex pane idle or waiting

Location: `src/main.ts:2448`, `:2449`, `:2464`; `src/prompt.ts:41`, `:86`.

A narrow Codex approval draws its accepted `(y)` shortcut on an option's continuation row, for example:

~~~text
› 1. Yes, proceed
     (y)
  2. No, and tell
     Codex what to do
     differently (esc)
~~~

`answers` deliberately reads unjoined menu rows. `readMenu` keeps only the numbered row's text in `options`; the continuation is in the whole prompt but not the option label. `menuKeys` therefore returns `1` and `2`, without `y`.

Deliver `y` through `loomctl keys`. Codex accepts it and resumes, but `wrote` receives `answer = false`, so the task stays in approval and `codexAsking` stays true. Activity suppresses the Working title until a later notification clears that latch. The pane remains waiting; after focus acknowledges the attention bit it reads idle while Codex works. Enter or an unwrapped menu avoids the bug.

Fix: preserve each option's continuation text and derive advertised shortcuts from that complete option. Keep the composer/draft exclusion and invalid-key guard. Do not join every Claude rule/header indiscriminately; the reason for reading physical menu rows still holds.

Evidence: parser and caller trace. The RF9 and `03dad3a` fixtures draw complete `(y)` text on one row. They do not cover this new false negative. I did not run a narrow native TUI or claim responsive/mobile validation.

### R14-8. P2. An elapsed-time transcript quote still matches the legacy Codex status

Location: `src/prompt.ts:236`, `:270`; callers at `src/main.ts:2104`, `:4445`.

An idle Codex without run-state titles ends its answer with the status line it was asked to explain:

~~~text
• Working (3s • esc to interrupt)

› Ask Codex to do anything

  ? for shortcuts
~~~

The four-row window includes that final transcript line. `CODEX_STATUS` accepts a generic optional leading non-space character, any header, and an elapsed-time prefix. The transcript bullet and quoted clock satisfy it. `interruptHint` returns true, so focusing the completed pane can show it working and an idle wait can continue to timeout. The task sweep also treats that text as busy.

Fix: distinguish an agent-owned live status row from transcript rows, at least excluding known transcript prefixes and checking its actual layout/style. Preserve the modern title's authority. Where the legacy renderer has removed every distinguishing character, expose uncertainty rather than confidently declaring idle or working.

Evidence: a direct call to the real `interruptHint` returned true for the screen above. The targeted check confirmed false for the original adjacent ordinary quote and composer draft, true for `Working (5m 17s • esc to inte…`, and false for `Worki`. A modern Ready title still wins over all these hints, and a modern Working title covers a narrow missing status row.

## Deletion recovery and platform edge cases

- A crash after the claim rename leaves `.name.loom-deleting` and the original Git backlink/registration. If deletion had begun, the claim can be partial. A subsequent native request with the same spelling refuses an existing claim instead of forgetting the registration. The thread was already removed and saved by the frontend, so restart does not automatically restore it or its path. Inspect the claim, then rename it back to the original path if recovering it. Do not prune its administrative entry first. Git still records the old path and can regard the renamed worktree as missing; this is not automatic crash recovery.
- A busy-folder rename failure leaves the folder and Git record untouched. The frontend has already closed/removed its thread and retries ten times, 300 ms apart, before reporting failure. It does not delete the branch on failure. The test and native scratch probe support the refusal, not a claim that all writers are excluded afterward.
- The claim is a sibling of the target. A worktree on another volume than the main repository does not require a cross-volume rename: target and claim are on the worktree's volume. Git administration/index access can be on the repository volume. Root mount-point links are refused. An ordinary linked worktree on another volume is not inherently rejected by the identity checks, which compare each pair on its own volume.
- Live admission uses file identities, so stable case and 8.3 aliases are not string-prefix escape routes. The already-absent `forget` helper uses lowercase slash-normalized text instead. Relative gitdir records and alternate missing-path spellings can leave stale entries, as its comment acknowledges. Those failures do not recursively delete another directory.
- Long paths remain an availability limit. The sibling claim adds 15 characters to the final directory component, so a valid NTFS basename longer than 240 characters cannot fit the claim's 255-character component limit. It fails before deletion. Extended-length path support does not remove that per-component limit. [Microsoft path-length limits](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) Long-path/8.3/UNC cases were inspected, not exercised on every volume or filesystem.
- A failed check attempts to put the claim back. If another actor recreated the original directory, restoration can fail and the error names the claim. That is preferable to overwriting the new directory. Failure to remove the Git administration entry after folder removal is reported; a later request for an absent original can retry forgetting it.

## Teardown, hooks, and the named pushbacks

### RF3 assignment and breakaway

The installed portable-pty 0.9.0 source creates its child with fixed `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT` flags, uses a single private pseudoconsole attribute, and closes the returned thread handle. There is no exposed suspended-start/job-list option in that path. I accept the claimed API limit. It explains why assignment-before-execution needs a dependency change; it does not prove the post-spawn window safe.

`BREAKAWAY_OK` knowingly permits explicit escape. Keeping it is a compatibility choice, not a containment fix. Ordinary children after successful assignment join the job, including detached consoles. Children started before assignment, failed assignment, and explicit breakaway remain outside that guarantee. I did not establish a shipped helper requiring the flag or run a breakaway experiment. [Microsoft job-object rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

For the reported shutdown hang, flow closure wakes an emitter blocked in `acquire`; dropping its receiver releases a pump blocked in `send`; the pump then reads/discards until EOF. The job closes before master console teardown. These changes do not intentionally leak reader/output/input handles. Output after explicit pane close is discarded by design, so this is not a promise to retain final closed-pane screen text. On natural exit the emitter remains available for queued output. The exit thread flushes the bus but does not join the reader/emitter, so its existing comment promises stronger final-output ordering than that flush proves.

Older Windows can block in ClosePseudoConsole while output is unread; Windows 11 24H2 changed that behavior. I did not reproduce either OS teardown path. [Microsoft ClosePseudoConsole reference](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)

### RF8 shared names

Unique filenames are not required to fix the ordinary shared wake/session conflict. Exclusive consumption plus checked retry and serialized OpenCode publication is a defensible small fix. The objection to an unconditional rename consumer holds: it would not supply the current exclusive ownership. The remaining ceiling is the one-second retry and swallowed terminal failure. A stalled filesystem read or long access-denied condition can exceed it; there is no durable spool for shared updates. I found no new normal-claim deadlock.

### RF10 truncated rows

A row retaining the elapsed-time shape now covers the missing-hint case. A row reduced to `Worki` has insufficient text for this matcher and still reads idle. I accept that a text matcher cannot reconstruct characters never rendered. That is not full support for legacy narrow panes: the app needs an uncertainty/version limit or another authoritative signal. Modern run-state titles solve the concrete modern case and should remain authoritative.

### RF12 stale page waits

A stale page wait cannot answer an unrelated request through normal id reuse. It is retained work, and freeing its connection slot admits further retained work. R14-6 is why "the page polls until timeout" has a real resource cost.

### RF14 Claude Stop after restart

Startup deliberately turns unfinished tasks into unknown. That is reasonable when an outcome was never established. It does not recover a consumed Stop or its response hash. R14-4 distinguishes receiving a report, proving completion, and durably retaining the report.

### RF15 lenient notify

The malformed-task bypass is fixed. Leaving notify records lenient does not reintroduce that task reservation bypass, and I found no new normal-writer notify incompatibility. Malformed notify records can still be ignored or merged with defaults. That is weaker recovery policy, not strict fail-closed journal validation. It should not be described as refusing every recognized malformed record. I have not promoted arbitrary hand-corrupted policy shapes into a new finding here.

### RF5 reachability

The old separate-lock native stop could overlap an independently issued restart even though frontend spawns are serialized. A spawn queue does not serialize native stops with Session insertion. The atomic check/remove and launch-specific output closure close that concrete case. R14-3 uses ordinary frontend calls and was demonstrated against the actual methods.

### Older Claude hooks

A settings command invoking current `loom.exe --session-start` or `--statusline` need not explicitly send a launch. Native exports it and the helper reads it. Retaining that command in an older settings.json does not itself break panes.

A custom old writer of `loom-tx/<pane>` or `loom-status/<pane>` is different. Readers now request the qualified filename without falling back to bare markers. Such a writer loses live-marker discovery, including following `/clear` and live status/model/effort updates. The pinned transcript remains a fallback, so this is not an agent startup crash; restored boot gating can wait its 60 polls, about 15 seconds, for a missing qualified SessionStart marker. Migrate that writer rather than accepting untagged markers into a reused pane. Legacy untagged wake/session payload compatibility remains lenient and cannot authenticate their producing launch. I inspected repository hook commands, not private user settings.

## New checks and what they prove

These are source comparisons unless explicitly identified as executed. I did not run the full task/ui/native suites or an old served app bundle.

| Change | Assessment against old code |
| --- | --- |
| `d948047` root/ancestor refusal tests | The direct root-link case exposes old canonicalization deletion. The ancestor fixture redirects to an unrelated folder, not another worktree of the same repository, so it misses R14-1. |
| `8014fe1` nested-checkout test | Meaningful. Old removal recursively deleted the locked nested worktree and a different repository. The new refusal protects both. There is no added submodule fixture, though the same guard covers initialized submodules on inspection. |
| `be78f43` approval/claim test | Meaningful for a new file after approval but before the native call, an open child preventing rename, and refusal of a leftover claim. Old removal lacked the approved inventory. There is no writer after validation or ancestor switch before removal. |
| `9be8890` pump test | Meaningful. With the receiver dropped, the former loop stopped at its first send failure; the new pump consumes the full 64 KiB Cursor. It tests draining, not ConPTY timing, job assignment, or final-screen delivery. |
| `6f4ca14` publication/session-claim checks | Meaningful. A short exclusive claim rejected the old single write; retry lands after release. An open session writer defeated the former read/unlink consumer. The OpenCode check holds a marker for 300 ms, within the retry budget. |
| `b54febb` shutdown-reports | Meaningful for a mocked Codex `end` returned by shutdown. The old frontend ignored that return and could not save its completion. It models neither competing drains nor Claude Stop deferral. |
| `90cec02` disconnected-client test | Meaningful for native EOF versus an indefinitely pending future. It does not run the page handler, admission exhaustion, or page cleanup. |
| `a15e6a9` old-stop/output test | Meaningful. An absent old Session plus replacement registered flow was previously closed by pane id alone. It does not execute the old map interleaving; the new single lock structurally closes that case. |
| `47d7ff5` early-exit checks | Both original event-order cases fail with the old publication point. They hold native spawn's reply, not the earlier Claude session check. My targeted old/HEAD replay adds that missing interleaving. |
| `9a5b8c8` Claude usage checks | A held usage response followed by restart is a real old-code failure. The Rust marker-name test checks qualified-name selection, but does not invoke a hook or verify environment inheritance itself. |
| `c308ce9` microphone-opening check | Meaningful. Old code captured the replacement generation after device startup and would paste the recording there. The mock controls that await explicitly. |
| `b5bd751`, `68c1334` prompt/activity checks | Invalid `x`, adjacent ordinary quotes, drafts, and the prefixed Claude retry quote are real old-code failures. Truncated clock-shaped status cases fail the former complete-hint requirement. Missing are a wrapped `(y)`, a quoted clock-shaped row, and the admitted `Worki` case. |
| `c9163b1` update check | Missing CLI source is a real old-code failure. The locked-main test still reaches replacement: its source backup is in the install directory, which contains the CLI. That unchanged CLI is skipped by hash, so this remains a single-image failure check. No second-image failure proves rollback of an already replaced first image, and no NSIS rollback is executed. |
| `1ce3edc` journal checks | Present scalar/null task and malformed event/update values are real parser branch regressions, not only success round trips. Old code silently skipped the scalar task. |
| `b268ba8` backup-obstruction check | Meaningful. Obstructed `.bak.pending` refuses save and preserves workspace/backup. Former code did not use that preparation path and would report success. It does not exercise a hard-link-unsupported filesystem. |
| `686238e` | Mock contract repair. Returning `[]` matches the new native type and prevents iteration over undefined. It is not an independent regression test against old production code. |
| `ad7bf7c` | AST-fixture dependency repair. Extracting `hashedFiles` keeps the inventory test executable after refactoring. The original inline implementation needed no extracted helper. |
| `03dad3a` | Fixture repair with a valid reason. It now draws the menu advertising `y`, rather than expecting bare alphanumeric acknowledgment. Both old broad acknowledgment and new menu-aware code accept this drawn `y`; this commit alone does not prove RF9. The separate invalid-key check does. The fixture remains unwrapped. |

## Checked and found clean

The v3 `loomctl watch --metadata --policy` serialization still emits `loom-durable-events-v3`, task source, and boolean `notify`. v4 requires explicit `--policy-v4` and uses disposition. No reviewed commit changes `loomctl.rs` or a mail template. The ASH-LOOM-EVENT format was not edited. I checked repository-side watch/serialization and the changeset, not the external email bridge, and sent no mail. Shutdown-report loss and abandoned page work affect availability/completeness without changing the wire format.

Native stop releases the Session map before flow closure and process/console teardown. Flow close wakes its blocked emitter; pump draining stays outside the map lock. The disconnect Drop guard removes the waiter on answer, timeout, or cancellation. Same-account pipe-owner validation and ten-second framing deadlines are unchanged; legitimate long waits remain outside the frame deadline.

Launch-specific flow tuples are used consistently in insertion, single/batch acknowledgment, stop, and shutdown. I found no new handle leak caused by that tuple change. Early-exit publication retains an exit received before the successful spawn reply. Dictation rejects a destination changed during microphone startup before pasting its prefix. No new generation crossing was found in its recording-result path.

OpenCode publication is awaited inside its queue. State advances only on publication success. Session consume is exclusive and cannot unlink a newer mark written after its claim closes. These improvements do not require unique filenames for the ordinary shared-marker case.

Workspace pending data and copy fallback are flushed before replacement. Backup preparation is checked and ordinary failure retains the prior backup. Malformed recognized task values use the controlled history-unavailable path; the existing journal is not treated as empty or overwritten by startup. Manual workspace backup restoration remains a reasonable policy.

NSIS still passes the installation folder as environment data for PATH editing and preserves expandable PATH text. PowerShell stages and hashes both supplied executables before replacement and attempts all recorded restorations. A running renamed CLI image can keep serving the bridge; replacing the file does not upgrade the already running process. No registry or installed-image operation was performed.

## Review method

The 20 commits, in order, were `a565c6e`, `d948047`, `8014fe1`, `be78f43`, `9be8890`, `6f4ca14`, `b54febb`, `90cec02`, `a15e6a9`, `47d7ff5`, `9a5b8c8`, `686238e`, `c308ce9`, `b5bd751`, `68c1334`, `c9163b1`, `1ce3edc`, `b268ba8`, `ad7bf7c`, and `03dad3a`. This includes the prior report commit and three test/mock corrections.

One targeted in-memory/scratch script checked Windows rename/pin behavior, same-repository redirected-parent admission, original prompt cases plus a clock-shaped quote, the extracted launch/stop methods before and after `47d7ff5`, and Claude Stop routing/serialization. It did not call Loom's recursive remover. All diagnostic assertions completed. Cleanup initially hit Git's read-only object files, then the verified scratch directory was removed with force. No scratch worktree was a real user worktree.

I inspected the installed portable-pty implementation, existing generated NSIS template, and primary Rust/Microsoft/NSIS documentation. `git diff --check ed34c3e..HEAD` passed. Git needed a per-command `safe.directory` override because of sandbox ownership; no global Git configuration changed.

No cargo/npm build, heavy suite, flood test, headless app, responsive check, destructive root-swap experiment, power-loss test, cross-volume test, live old-hook setup, or installer rollback experiment ran. No UI changed and this review makes no responsive/mobile completion claim. Findings without an executed check are source scenarios, not claimed runtime reproductions.
