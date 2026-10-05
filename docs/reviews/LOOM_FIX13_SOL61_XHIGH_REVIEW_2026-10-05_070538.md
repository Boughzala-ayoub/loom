# Loom fix review

Reviewed main at ed34c3e72e78f132fe3cd0a990c8d0ab561d3cfd on 2026-10-05, Africa/Tunis.

I read LOOM_FULL_REVIEW_CLAUDE_OPUS55_2026-10-05_040834.md first, then every commit in ef14290..HEAD, and traced the changed functions through their callers. The range contains 35 commits, including three test corrections and the report commit. Git does not show the 37 commits stated in the request.

This review changed only this report. I did not build Loom, run a heavy suite, stage files, execute an installer, delete a worktree, or change the existing untracked documents. Line numbers refer to HEAD.

## Status of the earlier findings

"Closed for the reported case" means the changed code addresses that case on inspection. It does not mean I ran the app or proved every adjacent case safe. RF findings below identify remaining cases separately.

| Finding | Verdict | Does the fix close its own failing scenario? |
| --- | --- | --- |
| C1, worktree deletion follows junctions | Partial | Yes for an ordinary linked worktree containing interior junctions. Passing its real root to Rust's remove_dir_all removes interior links rather than their targets. No for a replaced or redirected deletion root, and no protection for another worktree nested inside it. RF1 and RF2. |
| C2, Codex shows busy during approval or after a quoted hint | Closed for the reported modern-title cases; incomplete fallback | codexAsking suppresses Working while an approval waits, and Ready is authoritative even when the transcript quotes the interrupt hint. RF9 shows premature acknowledgment; RF10 shows false matches when the title is unavailable. |
| C3, deletion approval rejects normal built or linked trees | Closed within the stated limits | Ignored build output now costs metadata, not content hashing. The walk skips interior reparse points and shares changed-file reads with writers. The 20,000-entry build-tree and ordinary junction scenarios no longer hit the old small limits. Two million entries, 15 seconds between blocking operations, and 256 MiB of changed contents remain explicit ceilings. This is not a hard timeout on a blocked filesystem call. |
| C4, preview bounds break Changes/numstat and noisy Git commands | Closed | Bounds apply only to requested previews. Ordinary numstat keeps its full output; excess stderr is drained instead of causing an error or blocking the child. |
| C5, folder canonicalization blocks the window thread | Closed | The command now resolves the directory through the blocking worker. An unreachable share can still occupy that worker, but it no longer runs this resolution on the window thread. |
| C6, workspace save lacks durable data and a recovery copy | Closed for the ordinary NTFS save; backup guarantee incomplete | The pending file is written and sync_all completes before rename. The replaced snapshot becomes a hard-linked .bak, and malformed/empty workspace reads fail visibly. Manual restoration is a reasonable recovery policy. RF16 covers ignored backup failures. |
| C7, quoted Claude interrupt text prevents completion | Closed for ordinary quoted text; one false match remains | The normal hint is restricted to the input footer. The retry-banner exception still searches the entire transcript and accepts a quoted retry line. RF10. |
| C8, an existing workspace lease aborts startup | Closed | Lease acquisition retries for roughly two seconds, then reports refusal and exits with status 1 instead of panicking through setup. A PID display is optional; its absence does not reopen the crash case. |
| C9, answering an untracked approval leaves waiting stuck | Closed for a delivered Enter; acknowledgment is too broad | A successfully delivered Enter clears approval without requiring a tracked task. Failed writes preserve the question; arrows and bracketed pastes do not acknowledge it. Treating every single letter or digit as an answer introduces RF9. |
| C10, failure to recreate a pipe stops the listener | Closed | A later create failure retries after one second instead of ending the listener. Initial name conflicts also produce a visible warning. |
| C11, a torn journal tail consumes the next appended record | Closed | Appends first establish a newline boundary. The damaged record remains unreadable, but the following record is independently parseable. |
| C12, partial worktree deletion is reported as kept | Closed | A changed tree during retries and an exhausted removal attempt return failed, with a partial-deletion warning. The branch stays when folder removal fails. |
| C13, cached Codex readers retain oversized pending buffers | Closed for the measured retention case | Completed oversized buffers release their allocation, and an overlarge pending record resets it. Keeping readers across scoped queries is justified: a scoped query does not enumerate every live pane. The 128-reader cap still permits about 8 MiB of normal pending capacity, plus reader state, rather than the old roughly 32 MiB of large capacities. |
| C14, a partial rollout fold is exported as current usage | Closed | A reader advances within its per-call budget, but usage is withheld until caught_up. Later polls continue the fold. A growing rollout may delay an update; it no longer presents the intermediate fold as a complete current result. |
| C15, plan usage ignores CODEX_HOME | Closed | Plan discovery now uses the same CODEX_HOME preference as rollout discovery. |
| C16, Overview scans arbitrarily far backward for messages | Closed with deliberate truncation | The scan has an 8 MiB window and a 256 KiB record limit. Missing results preserve previous displayed fields. An exceptionally old or large message can be omitted; that is the documented tradeoff rather than an unbounded scan. |
| C17, running CLI replacement, backup accumulation, PATH expansion | Partial | Moving a mapped loomctl image aside handles an existing watch process. Subsequent installs/updates remove deletable old images. PATH remains REG_EXPAND_SZ with raw variable references preserved. The installer still lacks pair rollback when its second executable fails. RF11. |
| C18, dictation lock, duplicate drains, stale markers, slash collision | Partial | dictate_level uses try_lock; competing drainers claim immutable task-event files once; setup prunes old status/transcript/session markers; configuration slash commands use inTurn. Exclusive claiming conflicts with writers that rewrite a shared wake filename. RF8. |
| F7, an old stop/exit affects a new launch | Partial | The frontend stop continuation checks its generation, and native exit events carry a launch. Native stop checks and removal are not atomic, and the frontend publishes launched only after the spawn reply. RF5 and RF6. |
| F8, close loses the last journal writes | Partial | Writes already queued in JavaScript are drained before destruction, with a second drain after shutdown. Shutdown removes the native sessions before their final marker drain, so the second JavaScript drain cannot include reports it never received. RF14. |
| F9, a transcript is pasted into a restarted pane | Closed for restart during transcription; another window remains | micStop validates the captured generation before paste and before Enter. micStart captures that generation after awaiting audio-device startup, allowing a restart during that await to become the accepted destination. RF13. |
| F10, loomctl trusts a pipe owned by someone else | Closed at the stated account boundary | loomctl checks the pipe owner SID before hello or command traffic. Loom explicitly makes the user SID the owner, avoiding an elevated token's default Administrators owner. A bridge running under that same account passes; a different service account is refused. I inspected this logic, not live elevated/service-account tokens. |
| F11, updating the app and CLI independently | Partial | update.ps1 stages and hashes both supplied executables, replaces mapped images, and attempts to restore earlier replacements on an ordinary later failure. It still proceeds when the CLI source is missing. NSIS deletes rollback images before installing the CLI and has no pair rollback. RF11. |
| F12, a large event history fails before the journal write | Closed | The argument spread is gone from the sequence minimum. Serialization/pre-IPC failures set dirty and unsaved and enter the error path. The large-history test would expose the old spread limit; I did not run that memory-heavy fixture. |
| F13, malformed journal shape stalls startup | Closed for the reported object-shape cases; validation incomplete | Invalid task objects now throw a controlled history-unavailable error; startup finishes and workspace saving remains usable. The original journal is preserved. A recognized task field containing a non-object is still silently skipped. RF15. |
| F14, old session/wake markers mutate a new launch | Partial, Claude case open | Codex and OpenCode session/wake payloads carry LOOM_LAUNCH, and the frontend rejects mismatches. Claude's loom-tx and loom-status writers/readers still have no launch check, and an outstanding Claude usage result can overwrite a replacement's session id. RF7. Session read/unlink also remains racy, RF8. |
| F15, folder traversal follows junction loops | Closed | Both walks use canonical visited directories, a depth limit, and an entry limit. Aliases may cause omissions or extra work if they canonicalize differently, but those walks no longer expand an unbounded directory loop. |
| F16, descendant processes survive Loom | Partial | An ordinary child created after successful job assignment inherits the job, including normal hook helpers. Abrupt Loom process termination closes the handle through the OS. Assignment occurs after spawn, failure is best effort, and BREAKAWAY_OK allows explicit escape. Normal teardown can block before the job handle closes. RF3. |
| F17, pipe clients have no framing/admission bounds | Partial | Hello, request, and response frames have ten-second deadlines; active connections are capped at 64. A legitimate long wait is outside the framing timeout, so watch --follow can still work. Disconnected clients with complete long-wait requests keep their slots. RF12. |
| F18, closed panes remain reachable through receipts/caches | Closed for the reported owners | Receipts keep a pane id, dashboard caches are deleted, the output map entry is removed, and the current channel handler is replaced with an acknowledgment-only closure. Ongoing native output can retain older channel state until it ends; the named permanent owners no longer retain the Pane. |
| F19, an apostrophe in INSTDIR breaks/injects PATH code | Closed | INSTDIR reaches PowerShell through an environment variable. The command reads PATH without expanding it and writes ExpandString. nsExec's result is checked and failure produces a message. An apostrophe is data rather than PowerShell source. |

## Remaining and new findings, ranked

These include gaps in fixes and newly exposed cases. I have not assumed that every remaining bug was introduced by this range. P1 denotes data loss, crash, hang, or security; P2 denotes wrong behavior; P3 denotes a minor gap.

### RF1 · P1 · Canonicalizing the deletion root can turn a junction into the directory to erase

Location: src-tauri/src/deletion.rs:87, :91, :95. Related: C1.

Create a linked worktree at W, move its directory aside, then replace W with a junction to an unrelated folder E or the main checkout. Git's administrative worktree list still records W. A forced removal needs no successful inventory. remove_worktree canonicalizes W to E, canonicalizes the listed W to the same E, accepts the match, and calls remove_dir_all on E. The linked-worktree-list check compares two resolutions of the same mutable pathname; it does not authenticate the folder now occupying it.

Rust safely removing links inside its argument does not help here. Loom has already replaced its argument with the root link's target. A root directory symlink or volume mount point has the same boundary problem. A root or ancestor redirected between approval and native admission also changes what that comparison admits.

Fix: reject a reparse-point worktree root, validate its worktree administration against the intended repository, and hold/check the directory's identity through admission and removal. Do not establish ownership by canonicalizing the requested path and the registered spelling independently. Fail closed on canonicalization errors other than a verified already-absent directory; the current generic error fallthrough also reaches Git's recursive --force removal.

Evidence: source trace. I did not perform this destructive test. The ordinary interior-link behavior is supported by [Rust's remove_dir_all documentation](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html); its symlink race protections do not cover Loom's earlier root canonicalization.

### RF2 · P1 · Removing one worktree recursively removes a nested worktree, including a locked one

Location: src-tauri/src/deletion.rs:90, :94, :95; src/main.ts:5304. Related: C1/C3.

Let linked worktree P contain another linked worktree C at P/nested. C can belong to the same repository or a different one, and can contain unsaved work. Lock C. Force-delete P, or approve P's ignored nested folder for discard. The native check finds P's registration and checks only P's locked flag. remove_dir_all then traverses C as an ordinary directory, deleting it and leaving C's registration dangling.

P's pane cleanup does not shut down a separate Loom thread for C. P's Git inventory also does not classify C's tracked edits and unique commits as a second worktree's loss. Permission to discard ignored output in P should not silently discard a locked, separately managed checkout.

Fix: refuse deletion when another registered worktree root is contained by the target, even with --force, unless the operation explicitly includes that other worktree. Check nested .git boundaries as well, since a different repository's worktrees will not appear in P's repository list.

Evidence: source trace. The added test rejects the main checkout and an ordinary repository subfolder; it does not cover a registered parent with a registered child.

### RF3 · P1 · Console teardown can block before the kill-on-close job is closed

Location: src-tauri/src/lib.rs:47, :58, :486, :578. Related: F16 and close hang risk.

Session declares master before _job. Rust drops those fields in declaration order. The installed portable-pty implementation closes its pseudoconsole before dropping the master's output read handle. The reader/emitter path can stop when its flow is closed.

On Windows versions before Windows 11 24H2, let a pane leave a descendant attached to its console, with enough final output to require draining. When the root exits, or shutdown stops the consumers, dropping master can wait in ClosePseudoConsole. _job is still open. Its kill-on-close action cannot terminate the remaining descendant to help teardown, because execution has not reached that field's drop. During pty_shutdown the scoped thread join waits for this destructor, so the frontend close waits indefinitely.

Fix: explicitly take and close the job before console teardown. Keep draining console output through teardown, or close the output-read handles in an order that cannot leave ClosePseudoConsole waiting on a handle Loom itself still owns. Merely moving teardown to several joined threads does not bound the wait.

Evidence: source/dependency trace, not a reproduced Windows hang. Microsoft's [ClosePseudoConsole documentation](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole) describes the blocking behavior on older Windows and its change in build 26100. Do not generalize this hang to systems with the newer immediate-return behavior.

The job is also a partial containment guarantee. Post-spawn assignment leaves an early-child window, assignment errors log and continue, and BREAKAWAY_OK permits a child using CREATE_BREAKAWAY_FROM_JOB to survive the job. Ordinary detached consoles do remain contained. Normal Claude/Codex helper processes inherit a successfully assigned parent's job; an escaped or pre-assignment child does not. Nested jobs are supported on Windows 8 and later, subject to job restrictions. These limits follow [Microsoft's job-object rules](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). A claim that every pane descendant is contained would require assignment before child execution, checked assignment failure, and a stricter breakaway policy.

### RF4 · P1 · The approved inventory is not the inventory handed to native deletion

Location: src/main.ts:5289, :5304; src-tauri/src/deletion.rs:85, :88, :95. Related: C1/C3.

For a non-forced deletion, the final frontend inventory succeeds after the pane processes stop. An external editor, another Loom instance, or a dev server then writes a new untracked file or changes a tracked file while worktree_remove runs Git's worktree-list command. Native deletion receives only repo and dir. It does not receive the approved fingerprint or verify contents, and deletes the new data.

The checks before confirmation, after confirmation, after pane cleanup, and on retries reduce the window. They do not close it. The first native attempt has no approval check at its destructive boundary, and a handle-safe recursive delete protects against link races rather than newly written contents.

Fix: hand the expected directory identity and inventory to the native operation. Claim the intended root and validate after claiming it before removal. Define how concurrent writers are excluded, or refuse when exclusivity cannot be obtained. Another hash followed by an unlocked remove still has the same race; it should not be described as an atomic approval guarantee.

Evidence: source trace. This is an approval/data-loss race, separate from --force's intentional permission to discard the target worktree's contents.

### RF5 · P2 · Native stop validates one session and removes whichever session exists later

Location: src-tauri/src/lib.rs:559, :562, :565. Related: F7.

An old pty_kill(id, launch=A) passes the launch check while A occupies the map. The mutex is released. A concurrent pty_spawn installs B under the same id. The old kill then closes every flow bearing that pane id and removes B using a second map lock. B is killed despite its different launch. The frontend generation guard can suppress the stale status update, but cannot revive the process.

Fix: compare launch and remove the matching Session under one map lock. Scope flow closure to that launch/output channel as well; a missing old session must not cause an old stop to close the replacement's flow.

Evidence: lock/interleaving trace. Frontend spawn serialization does not make separate native IPC commands atomic with this map operation.

### RF6 · P2 · Exit filtering uses a launch id that is published after native events can arrive

Location: src/main.ts:1846, :1972, :2004, :2022. Related: F7/F14.

There are two failing interleavings:

1. A new process B exits before the pty_spawn promise resolves. Its exit event carries B's generation, while launched is still A or zero. The listener discards it. The successful spawn reply then publishes B and leaves dead=false, showing a live pane whose process has exited.
2. A's queued exit arrives after the replacement sets dead=false but before B's spawn promise resolves. launched is still A, so the exit marks the pane dead. B's reply updates launched but does not clear dead. The new process keeps running behind an exited pane.

The same publication window can discard B's launch-keyed wake/session marker if its poll finishes before the spawn reply.

Fix: establish the generation accepted by event handlers before native spawn can produce events. Handle spawn failure and superseded launches explicitly, and preserve a current-generation exit that arrives before the reply. Use the same rule for launch-keyed markers.

Evidence: both exit interleavings reproduced in a small in-memory check of the frontend state assignments and listener predicate. This did not exercise Tauri's scheduler.

### RF7 · P2 · Claude's session and status paths still cross launch boundaries

Location: src-tauri/src/helper.rs:31, :54; src-tauri/src/usage.rs:134, :308, :318; src/main.ts:9087, :9096. Related: F14.

Restart a Claude pane using the same Pane object. Its prior loom-tx marker remains and contains a bare transcript path. Before the new SessionStart hook writes, session_usage reads that old path and returns its old sid. pollUsage writes it back to p.sid and saves it. A delayed old SessionStart hook can overwrite the new path too. An already running usage IPC call can apply its old result after the restart because the response loop checks neither generation nor the sid it requested.

The comments saying pane ids are regenerated every launch are false for this restart path. Adding launch tags to Codex/OpenCode session markers does not change Claude's separate transcript/status readers.

Fix: key or validate Claude transcript and status markers by LOOM_LAUNCH. Send the expected generation through session_usage and reject stale results in pollUsage before changing sid or usage. A timestamp-based seven-day prune cannot provide this launch check.

Evidence: complete writer-reader-frontend source trace. Consequences include wrong usage/model/effort and resuming the old conversation on a later launch.

### RF8 · P2 · Exclusive marker claims lose a concurrent shared-filename update

Location: src-tauri/src/lib.rs:1006, :1074, :1078; src-tauri/src/loom-opencode.js:66, :68. Related: C18/F14.

The poller opens an existing OpenCode busy wake marker with share_mode(0) and delete-on-close. While that handle is open, OpenCode reports idle by calling writeFileSync on the same pane filename. Windows rejects the write with a sharing violation. signal catches and ignores it. When the claim closes, the old marker is deleted. If no later status event occurs, the final idle update is lost.

OpenCode's authoritative status flag prevents terminal-screen activity from correcting that state. A task completion report can reach the journal while the pane remains displayed as working.

There is a related lost-update window in take_sessions: it reads and closes the pane marker, a producer writes a replacement, and remove_file deletes that replacement. A launch tag identifies the text that was read; it does not make read-then-unlink an atomic consume.

Fix: preserve exclusive consumption for immutable task-event files. Change shared wake/session producers to a checked atomic publication/claim scheme, with retry on sharing conflicts, or use immutable per-report names as the task-event producer already does. Readers must not unlink a newer write after reading an older one.

Evidence: source trace of Windows sharing and the producer's swallowed error. The pushback against a naive rename claim is valid: a rename through an already-open handle can move a file another consumer already claimed. That does not make shared-filename write failures safe.

### RF9 · P2 · A single invalid approval key clears the approval latch

Location: src/main.ts:2442, :2445, :2446. Related: C2/C9.

Codex is paused at a numbered approval menu and its title remains Working. Type x, which that menu does not accept. The write succeeds, so wrote treats it as an answer solely because it is one alphanumeric character. It clears codexAsking, emits resume, and clears the old waiting alert. activity now trusts Working even though the menu still awaits an answer.

Typing the first letter of a free-text answer has the same premature acknowledgment behavior when submission still requires Enter. Successful byte delivery is not proof that the agent accepted an answer.

Fix: acknowledge delivered Enter for the original untracked case. Restrict one-key answers to the actual accepted keys of a detected prompt, or retain the approval latch until the agent leaves approval state. Navigation, arbitrary draft text, and ignored keys must not emit resume.

Evidence: source trace. The new tests cover Enter and write failure, not an invalid single key.

### RF10 · P2 · Hint matching still accepts nearby transcript/draft text and quoted retry banners

Location: src/prompt.ts:237, :247; src/main.ts:2092. Related: C2/C7 and older/narrow Codex.

Without run-state titles, interruptHint scans from two rows above the last Codex composer through the end of the screen. This includes the final transcript row and the composer draft. Both idle screens below return true:

~~~text
• You can press esc to interrupt.

› Ask Codex...

  ? for shortcuts
~~~

~~~text
• Done.

› Explain esc to interrupt

  ? for shortcuts
~~~

Claude's retry exception has no start-of-row or footer ownership check. An idle transcript row ending in "Overloaded · next try in 12s · attempt 3 · esc to interrupt" also returns true even with a normal idle composer/footer below it. This can keep the Claude stop sweep from completing the task.

Conversely, an older Codex with no run-state title whose narrow status row truncates before the interrupt hint returns false while working. Soft-wrap joining restores a wrapped hint; it cannot restore characters the renderer truncated. Modern Working titles cover this case, but older versions still retain the original busy-to-idle failure.

Fix: recognize the status/footer structure, exclude composer text and transcript rows, and constrain Claude's retry banner to its owned live status area. For legacy Codex, recognize the actual Working status rather than requiring a visible escape hint. If a narrow legacy screen cannot be distinguished reliably, expose that uncertainty instead of declaring it idle.

Evidence: direct function checks reproduced both legacy Codex false positives, the Claude quoted-banner false positive, and the missing-hint false negative. The existing quote fixture adds another "Done" row, placing the quote outside the two-row window, so it misses the adjacent-row case.

### RF11 · P2 · The installer discards rollback files before it has installed the executable pair

Location: src-tauri/nsis-hooks.nsi:48, :57, :58, :61; scripts/update.ps1:33, :36. Related: F11/C17.

NSIS has already replaced loom.exe when POSTINSTALL starts. It deletes the old main and CLI images, then executes File for loomctl.exe. If that write fails because of disk exhaustion, access denial, antivirus, or the user aborts at its retry dialog, the new app remains with an old or incomplete CLI. The old unmapped main image may already be gone. There is no pair rollback. CopyFiles in MoveAside is unchecked too.

update.ps1's ordinary staged pair path improves this substantially, including mapped CLI replacement and rollback on a later replacement failure. But supplying a loom.exe whose directory lacks loomctl.exe only issues a warning and still updates the app. That directly permits the mismatched pair F11 intended to prevent.

Fix: require the CLI source before changing either executable. Keep rollback images until both installed hashes succeed. On installer abort or either executable failure, restore both destinations and report restoration failures accurately. For update.ps1, attempt each restoration even if another restoration fails.

Evidence: source trace, without running NSIS or changing installed files. A running watch process can keep using its renamed old image; that is expected. Disk replacement does not upgrade the already running bridge process, and this range leaves its protocol compatible.

### RF12 · P2 · Disconnected long-wait clients occupy the entire admission cap

Location: src-tauri/src/control.rs:71, :77, :160, :241. Related: F17.

Start 64 valid long wait requests, each with a 24-hour timeout and a condition that will not complete, then disconnect the clients. Once request framing finishes, answer awaits ask without monitoring pipe EOF. The page still has those waits and ACTIVE is decremented only after answer returns. Both instance and profile listeners share that counter.

Every new request, including the mail bridge's watch and ordinary loomctl commands, is refused until an existing wait finishes, potentially the next day. The frame deadlines work against partial-frame clients, but do not release these complete disconnected requests.

Fix: monitor disconnect while awaiting the page reply, remove the pending native waiter, and release the admission slot on disconnect. Make cancellation clean up its bookkeeping. Do not resend a mutation whose result became unknown. Keep legitimate long waits outside the ten-second frame timeout.

Evidence: source/lifetime trace. One stuck client leaves 63 slots, so it does not alone starve everyone. The concrete exhaustion requires the full cap. watch --follow uses repeated long-poll exchanges and remains valid when its client stays connected.

### RF13 · P2 · Dictation captures the destination generation after audio startup

Location: src/main.ts:1380, :1381, :1382. Related: F9.

Press the microphone in pane A. Audio-device startup is slow. Restart A while dictate_start is pending. When it resolves, micStart pastes the prefix into the replacement and records the replacement generation. micStop's new generation guard now accepts the transcript for that replacement, although the recording action began on the old launch.

Fix: capture the generation before awaiting dictate_start and revalidate before prefix paste and recording assignment. If it changed, stop/discard the newly opened recording. Retain the existing checks around transcription and final Enter.

Evidence: source interleaving trace. The restart-during-transcription scenario is fixed; this earlier await remains outside its protection.

### RF14 · P2 · Shutdown prevents the final native reports from reaching the journal drain

Location: src/main.ts:8789, :8790, :8791; src-tauri/src/lib.rs:474, :475, :574, :1804. Related: F8.

A completion hook writes its immutable task-event marker after the first JavaScript drain but before shutdown kills the pane. pty_shutdown takes all Sessions out of the map before termination. The normal exit waiter subsequently finds no Session and skips send_task_events and send_wakes. The periodic drainer also obtains an empty id list.

The second drainJournal sees no queued completion because native code never delivered it. Destruction succeeds. On restart the previous task can remain unknown rather than completed, and the bridge receives no completion event.

Fix: capture the closing pane ids/launches, drain their final native marker/output reports during shutdown, and wait until the frontend has processed and journaled that delivery before destroying the window. Completion of an IPC call is not acknowledgment that unrelated emitted events have passed through their handlers.

Evidence: source trace. The queue-stability loop correctly drains already scheduled JavaScript writes and introduces no identified mutex cycle. Its protection ends before an undelivered native file.

### RF15 · P2 · A recognized malformed task record can still become silently shortened history

Location: src/task.ts:441. Related: F13.

The valid JSON lines below yield a readable journal with sequence 42 and no tasks:

~~~json
{"seq":42}
{"task":"corrupt"}
~~~

The reader checks a task's shape only if the field is truthy and an object. A string, number, false, or null task field is silently ignored. If it replaced a task reservation record, a later submit with the same idempotency key can be accepted again because the reservation vanished from the in-memory map. A whole-history rewrite can permanently drop that line.

Fix: validate a recognized field when the property is present, before filtering by its value's type. An invalid task value should take the controlled history-unavailable path already added for invalid task objects. Keep the separate policy for syntactically torn lines.

Evidence: direct source branch trace, not an additional runtime suite. The new malformed-object test exercises missing events on an object, which enters shaped; it does not exercise this bypass.

### RF16 · P3 · Workspace backup creation is best effort despite the recovery promise

Location: src-tauri/src/lib.rs:1506, :1507. Related: C6.

Place a profile on a filesystem/share that does not support hard links, or deny creation of the backup while allowing replacement of the workspace. Saving removes an existing .bak if possible, ignores hard_link failure, replaces the workspace, and reports success. The recovery copy promised by the save comment is absent. Deleting the old backup before preparing its replacement can also discard the last usable recovery copy.

Fix: check backup creation. Preserve the prior backup until a new one is ready, and use a flushed copy when hard links are unsupported, or report that backup creation prevented the save. Automatic restoration is optional; silently failing to retain any backup is a different issue.

Evidence: source/error-path trace. sync_all still fixes the ordinary unsynced pending-data problem; this finding concerns the backup guarantee.

## Checks that held up

### Deletion boundaries and approval limits

An unchanged, ordinary linked-worktree root is admitted; the primary checkout and an ordinary subfolder merely located inside a repository are refused. The new removal test covers those two refusals and interior junctions. Interior junctions, symlinks, and mount-point links should be removed as links by the Windows standard-library implementation rather than traversed.

Canonical comparison generally handles stable case, short-name, and UNC spellings better than a string-prefix containment test. I did not find an alias-only route that admits a normal unregistered subfolder. The unsafe route is resolving a mutable registered root/ancestor, RF1, not merely changing its spelling. This was not verified against a live 8.3-enabled volume or every UNC form.

The fingerprint records an interior link's name and reparse classification, not its target text or reparse payload. It deliberately does not inspect the target. A directory can also change into a link between its metadata listing and a later read_dir, so the approval walk itself is not a handle-held, no-reparse traversal. That does not show that Rust's subsequent recursive delete follows interior links. The destructive root and inventory handoff gaps are RF1/RF4.

--force bypasses frontend inventory but retains the native registered-worktree and parent locked check. It intentionally discards ordinary data inside the target. It does not protect an outside root target or a nested checkout, RF1/RF2.

### Activity and regression-test quality

The new modern Codex cases are real regressions against the old source logic. Previously activity ORed a screen-wide interrupt hint with a Working title. A Ready title with quoted hint therefore still set busy. Focusing an approval could clear waiting, after which that same Working path set busy again. The new title authority and codexAsking guard change those outcomes.

The old Claude sweep accepted any screen-wide interrupt hint; the new ordinary quote case would prevent completion on that source. The old approval acknowledgment required a tracked asking task; the untracked Enter fixture would fail there too. These are source comparisons. I did not run an old served bundle or the full task-check suite.

The corrected Codex mock emits titles matching its turns, so its tests cover title-based behavior. It does not validate older Codex without those titles, a truncated narrow status, an adjacent final transcript quote, or an invalid one-key answer. The joined-screen path handles xterm soft wraps on inspection. A rendered truncation remains a different case.

OpenCode's delivered status marker takes precedence over terminal heuristics. Its fallback is restricted to the last three nonempty rows, rather than the entire screen. The shared-marker loss in RF8 can defeat the authoritative path. No UI was changed, and this review makes no responsive/mobile verification claim.

### Pipe ownership, framing, and bridge compatibility

The SID allocation remains alive while EqualSid uses it, and the security descriptor allocation is freed afterward. Owner validation precedes protocol traffic. Explicit owner SDDL is important for elevated Loom; relying on the token's default owner would reject its own same-user CLI. A service-account Loom/CLI pair uses that service SID; a bridge running as a different account is intentionally outside the boundary. Same-account impersonation is not prevented by an owner check.

loomctl gathers stdin before opening the pipe, so a human or slow stdin producer does not consume a connection slot. Legitimate wait duration is separated from the ten-second framing deadline. Responses are read before stdout is printed, which keeps an ordinarily slow mail consumer out of the server's frame write.

The v3 watch --metadata --policy contract still returns its source/notify metadata. v4 remains opt-in through --policy-v4. The reviewed changes do not alter the ASH-LOOM-EVENT mail format or introduce a new default policy version. I checked the repository-side watch/serialization paths; I did not run the external email bridge or send mail. RF12 and RF14 concern availability or missing events rather than a deliberate wire-format change.

### Persistence, cleanup, and installation

The journal append newline change preserves records after a torn tail. Long-history minima use a loop, and pre-write serialization failures enter the unsaved/error path. Startup catches journal shape failure, completes initialization, and keeps the damaged journal unavailable instead of treating it as empty history. The remaining recognized-value bypass is RF15.

The normal NTFS workspace path flushes pending data before replacement. A .bak hard link points to the previous file after replacement; it does not become an alias of the newly saved file. Refusing a second lease exits without the former panic. I accept the pushbacks against mandatory automatic backup restoration, live PID metadata, and pruning readers from a scoped usage query. They do not justify ignoring backup errors or claiming scoped queries enumerate closed panes.

The two journal drains await settled queue identities and do not hold the native process map while awaiting frontend work. Failed persistence intentionally cancels close. No new journal mutex deadlock was found. Close can still hang in the joined pseudoconsole teardown, RF3.

The changed cache/receipt/output owners release the reported closed-Pane references. Recent-message extraction is bounded and preserves old fields on omissions. Codex usage is withheld until the reader catches up, and oversized pending allocations are released. Folder walks have finite visited/depth/entry bounds.

NSIS passes the installation folder as environment data, preserving apostrophes. Its PATH read uses DoNotExpandEnvironmentNames, and its write uses ExpandString. The nsExec result is consumed without leaving that result on the NSIS stack. Mapped executable replacement and ordinary PowerShell rollback are plausible on inspection; no installer, registry, or live-bridge experiment was performed. RF11 prevents a full pair-transaction claim.

## Review method and coverage

I inspected every commit diff in chronological order and followed the final code rather than judging commit descriptions alone:

| Commits | Reviewed area |
| --- | --- |
| 32c901b | Original report and its claimed scenarios |
| 2c6ae76, 720bce2 | Worktree admission, removal, fingerprint, frontend inventory and force paths |
| a5f02a1, 6129c94, d3a2058, 7bd78ef | Activity, approvals, hints, mock titles, acknowledgment tests |
| 78f3eb5, a0a8d83 | Git preview callers/stderr and canonical-directory command scheduling |
| 954ddcc, 298b5b6 | Workspace replacement, .bak, read errors, lease refusal and exit |
| 3040ae1, d0916a8, f4edc2b | Pipe recreation, torn-tail appends, partial-removal result |
| 03eea16, 69712db, 9541d03, 0bbae40 | Codex reader retention/completeness, home selection, recent-message limits |
| f8d0b52, 09cad2f | Mapped CLI install/backups, marker claims/pruning, dictate_level, slash queue |
| 2c21cab, 2422e40 | Journal shape handling, startup availability, long histories and failed serialization |
| df36d89, 3acb227, 409e11a, 22a7f9d, 09b6a13 | Stop/exit generations, close drains, dictation generation, session/wake launch tags, closed-pane references |
| 4544b10, 902945c, 00826f1, 7844282 | Walk bounds, pipe SID boundary, frame/admission lifetime, Windows jobs |
| 0ed952b, 28fd27d | Paired update staging/replacement/rollback, installer PATH and error handling |
| e7e9bed, ed34c3e | Receipt-id test correction and malformed-journal fixture reset |

One small source/in-memory JavaScript check covered exit ordering and interruptHint cases. It reproduced the two frontend exit outcomes in RF6 and the hint outcomes in RF10. The first invocation lost Unicode prompt glyphs through the PowerShell-to-Node pipe; the corrected continuation used Unicode escapes for the same cases. No repository script or test file was created.

Other findings are source traces with explicit interleavings or error paths. I inspected the local portable-pty dependency and primary Rust/Microsoft documentation for the relevant deletion, ConPTY, and job semantics. I did not run cargo test, npm build, the full task-check suite, a headless app, destructive filesystem scenarios, account-switch tests, or installer rollback experiments.

The named pushbacks are accepted only where the concrete case supports them. C13's scoped-query argument holds. C6's manual restoration and C8's clean refusal policy hold. F12's non-spread loop fixes the long-history cause. C18's objection to a naive rename claim holds for competing drainers, while shared producers still need safe publication. F7/F14 launch checks remain incomplete across the specific native/IPC windows above. F17 correctly preserves long polling, while disconnected full requests still defeat admission availability.
