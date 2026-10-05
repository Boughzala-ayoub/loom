# Loom FIX15 follow-up review

Review date: 2026-10-05. Branch: `main`, HEAD `9261b36b14c157f489c1c3a714ef974ffd675514`.
Range: `03dad3a..9261b36`, ten commits; `58e8c7e` adds the preceding report only.
Baseline: [FIX14 review](LOOM_FIX14_SOL61_XHIGH_REVIEW_2026-10-05_131013.md).

## Status of the R14 findings

| Finding | Does the fix close its own failing scenario? | Assessment |
|---|---|---|
| R14-1: same-repository worktree through a redirected parent | Yes | The backlink must now name the requested path as text, rather than merely resolve to the same file. A's redirected path reaches B's checkout, but B's recorded path differs, so deletion is refused. |
| R14-2: writes after approval/claim disappear | Yes for immediate erasure; retention has a limit | Deletion moves the whole folder into trash, retaining later writes for 24 hours. This replaces the destructive race with a recovery interval, rather than proving that the final contents match the approved inventory. The new recovery and purge defects are below. |
| R14-3: stopping the pending launch misses the installed process | Yes at the method boundary | Stop now addresses `installed`, while `launchGen` invalidates the pending launch. Normal stop/restart paths remain consistent. The previous report overstated the reachability of its live-Claude relaunch example through today's public callers. |
| R14-4: final reports/Claude Stop lost at shutdown | Partly | Numbered batches and a final Stop sweep handle the tested cases. A failed final journal write leaves report delivery permanently closed, and the ordering/deadline handling does not establish the claimed barrier in every case. See R15-4 and R15-5. |
| R14-5: installer accepts an incomplete executable pair | Yes | Failure to preserve the old executable aborts. POSTINSTALL writes both executables again, checks the sticky error flag, and restores both backups on failure. An Ignore at the template's first extraction no longer makes the pair count as installed. |
| R14-6: hung-up loomctl leaves a page wait alive | Yes | Cancellation identifies the request, and unkeyed waits/watches consume its signal. Keyed execution and mutations continue. Listener/timer cleanup is present. |
| R14-7: wrapped approval shortcut omitted from acknowledgement | Yes | Shortcut extraction uses the option's joined physical lines, while the displayed option summary stays unchanged. The old code fails the original wrapped `(y)` case. |
| R14-8: a quoted clock-shaped status reads as working | Yes for the reported plain quote | The matcher checks the status row's location and dim clock cell. The old plain quote is rejected; a real dim status is accepted. Modern run-state titles still take precedence. The admitted legacy narrow-pane limitation remains. |

### R14-1 and R14-2: scope of the deletion fix

The fixer's identity argument is correct: if A's parent has already been redirected to B when approval happens, capturing the resolved identity at approval captures B. Requiring Git's backlink to name A's requested path closes that static scenario (`src-tauri/src/deletion.rs:184`). The existing fixture specifically exercises two worktrees of the same repository and a redirected ancestor.

The claim that every path through a junction is refused is broader than the implementation. The final folder must be a real directory, but ancestors are not inspected for reparse points. A different recorded spelling is refused; a worktree whose Git record already contains the same junction spelling can pass. That is not, by itself, a wrong-target deletion. I did not find another ordinary static A-to-B redirect that passes the new backlink check. Deliberately swapping an ancestor between checks is outside this review's trusted-process threat model.

Nested `.git` files and directories are refused before traversal skips links, including submodules and another checkout, even with force. This protects checkouts present during the native walk. A checkout or other data created after the walk is retained with the whole moved folder, then becomes subject to expiry. Trash does not enforce an indefinitely immutable approved inventory.

R14-2 therefore closes its immediate failing scenario under the revised 24-hour recovery policy. It is not a guarantee that unapproved late data can never be erased. The manifest and recovery behavior must make that policy reliable; they currently do not.

### R14-3: correction to the earlier reachability claim

The ordinary callers either spawn a dead pane or stop a live pane before restart (`src/main.ts:8506`). The previous report's direct `spawn()`-while-live Claude example did not establish a currently reachable public path. I agree with the fixer's pushback on that example.

The shared-method fix is still useful: `stop()` increments the generation but kills the last successfully installed native launch (`src/main.ts:1882`); a spawn made stale before installation kills its own new child (`src/main.ts:2033`); installation is published only after that stale check (`src/main.ts:2042`). I found no regression in normal stop, restart, or stop-during-spawn from this change.

### R14-4: final Claude Stop and the bridge

The final sweep now settles an already routed Claude Stop from the last received screen: an idle, known composer without an approval menu can complete; a busy/unconfirmed Stop becomes unknown. Its response hash is put in durable event `detail`, while `response` is populated only for completed tasks (`src/main.ts:3982`, `src/main.ts:4474`). This respects the existing v3 contract.

`watch --metadata --policy` still emits the v3 metadata fields, with `response: null` for unknown, and omits `detail` (`src/main.ts:8463`). The targeted check exercised the real watch handler for this case. The v4 disposition remains opt-in. No mail formatter or ASH-LOOM-EVENT format was changed in this range. The external email bridge was not run.

I found no confirmed new case where the final sweep completes a task merely because it has an unknown Stop. It still requires the corresponding routed task and an idle composer. Its screen is the last one delivered to the page, not proof that every final console byte has reached the terminal. The report-ordering problem below can instead cause a Stop to be discarded before it is routed.

### R14-7 and R14-8: the original Codex cases

The actual prompt functions pass the wrapped-shortcut and plain quoted-status cases; the functions at `03dad3a` fail them. A modern Working title remains authoritative when a narrow pane loses the status row, and a Ready title remains authoritative when output quotes a working hint. The style check agrees with [Codex's status renderer](https://github.com/openai/codex/blob/main/codex-rs/tui/src/status_indicator_widget.rs#L231), which dims the elapsed-time parentheses.

A legacy Codex without run-state titles, in a pane so narrow that even the elapsed-time parentheses disappear, still reads idle and ends unknown. That is a documented observation limit, not a newly fixed case. I would keep the title-capable version requirement/limitation explicit rather than extend the parser to treat arbitrary `Worki` text as a status. This case alone would not justify another review loop.

## Findings, ranked

The first three findings can destroy Git metadata or a recovered checkout. R15-2 predates this range, but is explicitly in the requested scope and is now relied on by the trash crash-recovery comment. The remaining findings concern report state and retained storage. No finding depends on a malicious same-user process forging paths or manifests.

### R15-1 - P1 - A failed second trash move becomes permanent Git-record deletion on retry

**Locations:** `src-tauri/src/deletion.rs:115`, `src-tauri/src/deletion.rs:142`, `src-tauri/src/deletion.rs:210`; retry at `src/main.ts:5340`.

**Failing scenario:** a Git operation or editor briefly holds the worktree's administrative `index` without delete sharing. This is outside the worktree folder, so moving the folder into trash succeeds. Moving its Git administration into `common/loom-trash` then fails. The manifest remains, and the function returns an error.

`cleanupWorktree` retries after 300 ms. The original folder is now absent. Rather than resume the manifest's second move, the retry calls `forget()`, which recursively erases the original administrative directory. Once the transient handle closes, a retry succeeds, returns an empty trash path, and can proceed to the requested branch deletion. This bypasses the promised 24-hour retention of the Git record. Recursive removal may also delete some administrative files before encountering the still-open index.

A staged version different from the working file loses its index mapping; worktree-specific HEAD/reflog state can be removed too. The object database may still contain a dangling blob, but putting the two directories back no longer restores the index and worktree metadata. The manifest points to an `entry_at` that was never created, so its advertised undo is incomplete. This is an ordinary transient lock, not an attacker or an overwrite approved by force.

**Evidence:** in a scratch Git worktree, a native read handle on `entry/index` blocked the second directory rename with Windows error 5 while the worktree folder had already moved. Another administrative file could be deleted with that handle held; the index could be deleted once it was released. The actual Loom retry-to-`forget` path was traced in source, not run against this repo. A metadata-only directory handle did not block rename; that initial proposed witness was ruled out and is not the basis of this finding.

A crash between the two moves has the same unfinished transaction. The new comment at `deletion.rs:151` expressly relies on blanket prune dropping its still-live administration, which also destroys the metadata instead of retaining it. A second instance encountering the missing original folder can take the `forget()` path as well.

**Fix:** before treating an absent source as already deleted, find and resume its pending trash transaction. Retry moving the administration, never recursively delete it as a substitute. Even an independently missing folder's administration should be retained if deletion promises a recovery interval. Preserve the pending record until both moves are settled, and prevent another instance or blanket prune from discarding that pending administration.

### R15-2 - P1 - Creating a thread prunes a temporarily unavailable worktree's index

**Location:** `src/main.ts:6407`; the new crash-recovery dependency is `src-tauri/src/deletion.rs:151`.

**Failing scenario:** this repository has another unlocked worktree on a removable drive, network location, or temporarily unavailable parent. It contains a staged version that differs from its working files. The drive is unplugged for a moment. Creating any new named Loom thread runs `git worktree prune` across the repository, even though that new thread does not need the unavailable path. Git deletes the other worktree's administrative directory, including its index. Reconnecting the drive brings the working files back but not their Git metadata.

This is existing behavior, not introduced by these commits. It matters here because the new trash implementation deliberately uses it to recover an interrupted move. Missing is not sufficient evidence that a worktree was deleted or approved for erasure.

There is no automatic three-month safety interval in this command's default invocation. [Git's prune implementation](https://github.com/git/git/blob/v2.51.0/builtin/worktree.c#L231) initializes its expiry to `TIME_MAX`; [the eligibility check](https://github.com/git/git/blob/v2.51.0/worktree.c#L844) protects locked worktrees, but an unlocked missing worktree qualifies. Git's manual specifically recommends locking worktrees on intermittently connected devices. ([Git worktree documentation](https://git-scm.com/docs/git-worktree))

**Evidence:** the targeted scratch check created fresh unlocked and locked worktrees, staged files, and renamed their common scratch parent to simulate unavailability. Real `git worktree prune` on Git `2.39.1.windows.1` removed the fresh unlocked worktree's administration; the locked one survived. The files under the temporarily moved parent remained. This was not an old stale record or a real removable-drive test.

**Fix:** remove the blanket prune from ordinary thread creation. Resolve only the specific Loom-owned missing-path transaction that blocks the requested path, retaining its administration in trash. Locking removable worktrees is a useful mitigation, but cannot justify erasing every existing unlocked missing worktree automatically.

### R15-3 - P1 - Purge can erase a checkout restored and registered at its trash path

**Locations:** `src-tauri/src/deletion.rs:153`, `src-tauri/src/deletion.rs:159`; startup/hourly caller at `src-tauri/src/lib.rs:1820`.

**Failing scenario:** a user undoes a deletion before expiry, but the original path has already been reused or is unavailable. They restore the administrative directory from `entry_at` to `entry`, keep the recovered working files at `at`, and run the standard `git worktree repair <at>` to register the recovered checkout at that current path. They then use the checkout in Loom or an editor, possibly from another Loom profile. This is a valid live Git worktree again; its old trash manifest still exists.

The hourly purge checks only manifest age. It does not check that the restored administration or a current Git backlink now identifies `at` as a live checkout. After 24 hours it recursively removes `at`, then treats the absent `entry_at` as successful removal and drops the manifest. It can erase the recovered checkout completely if idle. An open file or process cwd does not make recursive removal an all-or-nothing busy-folder test: other files can disappear before a locked component causes failure and leaves the record for another retry.

The code's claim that a folder put back by hand is safe holds only when it is moved away from the recorded trash path. There is no restore operation that cancels the manifest, and no guard for a standard repair that legitimately keeps that path. Processes in the user's session are trusted; the failing sequence is manual recovery, not forged JSON.

**Evidence:** source establishes the unconditional aged-path removal and the missing-path-as-success handling. [Git documents repair after a manual worktree move](https://git-scm.com/docs/git-worktree). [Rust documents recursive removal's link behavior and partial failures](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html); the native scratch probe also showed that an administrative neighbor can be deleted while an index is locked. I did not run the native purge against a repaired worktree or a live pane.

**Fix:** cancel or skip the trash record when its administration has been restored or its trash path is registered as a live checkout. Supply a restore path that clears the record before normal use, including restoration to a different destination. Coordinate restore and purge for that record. Do not rely on `remove_dir_all` to determine whether an entire recovered folder is unused.

### R15-4 - P2 - A failed final journal write leaves the surviving window's report channel closed

**Locations:** `src/main.ts:8840`, `src/main.ts:8844`, `src/main.ts:8848`; `src-tauri/src/lib.rs:1000`, `src-tauri/src/lib.rs:1009`.

**Failing scenario:** the initial journal drain succeeds. Shutdown then closes native report delivery and kills the panes. The final reports generate new journal writes, but those writes and the drain's retry fail, for example because storage fills or the journal becomes temporarily unwritable. The page catches the error, displays 'Could not close safely', clears `closing`, and keeps the window open.

Native `Reports.close()` has already set its permanent closed bit. There is no reopen operation. Every later `Reports.send()` returns immediately, before draining markers. A user can restart a pane in the surviving window, and native spawning still works, but subsequent task start/end/Stop reports never reach the page. Tasks and notices remain wrong until a full app restart. The initial successful journal drain does not protect against a later write failure.

**Evidence:** a targeted harness extracted and executed the real close callback. With the first drain successful and the final one rejected, the callback called `pty_shutdown`, did not destroy the window, and reset `closing`. The permanent native latch follows from the Rust implementation; the harness modeled it rather than executing native shutdown. Normal polling or another close does not reset that bit.

**Fix:** after native shutdown commits, keep the page in a close-retry state that preserves pending reports and prevents new work, or explicitly reopen native report delivery if the close is cancelled. A window allowed to continue normal operation must also update its killed pane state and have a working report channel. Retry the unsaved journal without discarding the final reports.

### R15-5 - P2 - The numbered barrier handles final events before older batches, and silently expires

**Locations:** `src/main.ts:8841`, `src/main.ts:8842`; `src/task.ts:344`; final drain returned at `src-tauri/src/lib.rs:611`.

**Failing scenario:** a submitted Claude task's correlated Start report was drained into batch N, but that batch has not yet been handled by the page. Claude's later Stop remains in the final shutdown drain. The invoke result is handled first: `agentEvents(shut.events)` routes Stop while the task is still submitted, or working only by screen correlation. The task router accepts Stop only for a started working task, so it discards this Stop. Batch N then arrives and starts the task. Waiting for its sequence number cannot recover the Stop already consumed. The final sweep has no pending Stop/hash to settle, and the task remains working or later becomes unknown without its response hash.

This depends on the delayed-delivery interleaving the barrier is intended to cover. The targeted check proves the state-machine consequence, not that an unmodified Windows WebView delivered these two messages in that order. If the current transport always preserves their order, that protects this particular interleaving; the close code itself does not enforce it.

Separately, the three-second wait silently falls through even if `agentBatch < shut.emitted`. It then journals and destroys the window as though the barrier succeeded. Native send increments the sequence while ignoring the result of `app.emit` (`src-tauri/src/lib.rs:987`). A failed delivery, or a batch still undelivered at the deadline, therefore loses its reports rather than making close visibly retryable. The limit avoids an indefinite wait, but is not a successful-delivery condition.

**Evidence:** the real task router and the actual `taskSignal` handler were executed with a submitted task. Stop-then-Start left it working without a pending Stop/hash; Start-then-Stop retained that Stop/hash. This is an in-memory ordering witness, not a live transport timing test. The new shutdown mock delays a Codex end batch by 150 ms and does not exercise the correlated Claude Start/final Stop combination or the expired barrier.

**Fix:** handle all prior numbered batches before routing the returned final events. If the deadline expires, preserve those final events and cancel/retry close instead of treating the barrier as satisfied. Account for emit failure rather than acknowledging a batch that was never delivered. Keep the bounded wait; make its failure explicit.

### R15-6 - P2 - An offline external drive is treated as successfully purged, orphaning its trash

**Locations:** `src-tauri/src/deletion.rs:135`, `src-tauri/src/deletion.rs:159`, `src-tauri/src/deletion.rs:160`.

**Failing scenario:** a worktree on D: is deleted successfully. The central trash directory is on C:, so its 11 GB folder is renamed to a sibling `.<id>.loom-trash` on D:, while its administrative record and manifest stay on C:. D: is unplugged when a startup/hourly purge finds the manifest older than 24 hours.

The folder removal returns NotFound, which is counted as success. Purge deletes the administration on C: and the central manifest. On reconnection, the 11 GB sibling is still there, but Loom has no record of it and never scans arbitrary old sibling locations. It will not reclaim this storage in subsequent purges. The same loss of tracking can occur if a renamed external parent is temporarily unavailable.

The administrative expiry is within the stated retention policy, so this is a storage/recovery-location defect, not an additional claim of unapproved pre-expiry data loss.

**Evidence:** source-only; no external drive was mounted or unplugged. The incorrect equivalence between an unavailable volume and an erased folder is explicit in the purge code.

**Fix:** retain the manifest while a recorded volume or parent is unavailable. Finalize removal only after the relevant location is reachable and the trash is absent/deleted, or a completed restore is known. Do not use NotFound alone to forget an external-volume transaction.

### R15-7 - P2 - Millisecond/basename trash IDs collide across ordinary concurrent deletions

**Locations:** `src-tauri/src/deletion.rs:125`, `src-tauri/src/deletion.rs:129`, `src-tauri/src/deletion.rs:139`; shared trash directory at `src-tauri/src/lib.rs:190`.

**Failing scenario:** two concurrent deletions, from different repositories or Loom profiles, both remove a worktree named `login` and finish their checks in the same millisecond. Both use the same central manifest name and central destination. The second `fs::write` replaces the first transaction's manifest. On the same volume, one folder rename succeeds and the other fails because the destination exists. The failing operation unconditionally removes the shared manifest, including the successful operation's record.

The successful folder and its administration remain retained but have lost automatic expiry and the origin information needed for the advertised two-path undo. A large folder can remain indefinitely. If both folders are on other volumes/parents, both sibling moves can succeed, but only the last manifest describes one of them. The other is untracked. No deliberate collision input or attacker is required; this is an unlikely timing race between trusted Loom instances. The central trash directory is not namespaced by profile.

**Evidence:** source-only; no forced clock/collision test or second real Loom instance was run.

**Fix:** reserve a unique record with exclusive creation before moving either directory, and retry on a collision. Never overwrite another transaction's manifest or remove a record owned by a different operation. An existing unique-ID facility plus `create_new` is sufficient; a new storage framework is unnecessary.

## Trash, recovery, and platform checks

- **Same-volume and 11 GB folders:** the worktree is renamed, not copied. There is no second 11 GB allocation, but deletion frees no space until purge. Retained folders continue occupying their original volume. A startup purge or the hourly pass can occur later than the exact 24-hour boundary; a closed app does not purge.
- **Another volume:** Windows error 17 selects a sibling `.<id>.loom-trash`, keeping the large folder on its own volume. Administration moves within the common Git directory's volume. The central manifest supplies the cross-volume association. This avoids copying, but makes external-volume availability important (R15-6). This fallback was traced, not exercised on an actual second drive.
- **Busy first folder rename:** if the folder cannot move, the first operation returns an error and its manifest is removed; the original folder and administration remain in place. The thread/panes have already been closed and removed from Loom's saved workspace. Cleanup retries eleven times; the branch is kept if cleanup still fails. A busy administration after a successful folder move is the different, destructive case in R15-1. Share-delete-capable open handles may permit rename, so 'anything open prevents a move' is too broad a Windows claim.
- **Crash points:** before the first move, the originals remain; between moves, the worktree is retained but its administration needs transaction recovery; after both moves, the two directories can be restored before expiry. There is no resumed pending-record path today. A plain `fs::write` manifest and two renames also do not establish a power-loss durability guarantee; no power-loss test was performed.
- **Old claim folders:** a missing original plus a regular `.<name>.loom-deleting` can enter the new trash path, using the backlink to the original requested path and the nested-checkout guard. An existing original takes precedence. There is no automatic reconstruction of a closed thread in the UI.
- **Branch order and undo:** branch deletion occurs only after native cleanup reports success (`src/main.ts:5352`), and a branch deletion failure reports the trash path. R15-1 can turn an unfinished cleanup into apparent success. Normal directory restoration requires both destinations to be free; it must not overwrite a replacement checkout. If the user also chose branch deletion, moving the directories back does not recreate that branch ref. The retention test restores with the branch kept; the manifest stores neither a branch recovery operation nor a commit snapshot. 'Undo deletion' needs that qualification.
- **Links and purge:** the native final-root check refuses a reparse point, the inventory does not traverse reparse children, and Rust's recursive removal removes links themselves rather than following their targets. Purge does not verify the manifest's association with an ongoing trash transaction or pin ancestor identities. I did not turn a forged manifest, deliberate ancestor swap, or an attacker moving unrelated data into trash into a finding. R15-3 uses legitimate recovery instead.
- **Concurrent purge:** two purgers reaching an already due, unchanged record generally converge on absence. That does not coordinate purge with restoration, a pending second move, or the shared-ID collision. No second real Loom process was launched.
- **Case and aliases:** normal Windows case differences are folded. A differing 8.3 or verbatim spelling is not resolved to the recorded long spelling and generally fails closed. Lowercasing is not a proof for NTFS directories explicitly configured to be case-sensitive: distinct recorded paths differing only in case can collapse to the same `spelled()` value. I did not create such directories or validate a Git-for-Windows A/B fixture there, so the confirmed R14-1 closure is for its original ordinary case-insensitive scenario, not a universal case-sensitive path guarantee.
- **Long paths:** the timestamp and `.loom-trash`/`.json` suffixes add length to already valid components. A near-limit basename can therefore fail at manifest creation or sibling rename; these checked failures usually happen before the worktree move. Long-path, 8.3, and filesystem-specific limits were not exercised. I found no source basis to claim that the new scheme supports every previously valid maximum-length path.
- **Inventory bounds:** the native walk has a two-million-entry limit, a 15-second deadline, and a 256 MiB content-hash cap. A folder's 11 GB size alone does not imply copying or hashing all 11 GB. Large/deep inventories can be refused by the guards. I did not scan an 11 GB fixture. Older prose describing smaller bounds should not be mistaken for the present implementation.

## Installer paths checked

I read the hook and the existing generated NSIS template's call sites. The generated artifact was used to inspect prompt placement, not as proof of a newly built installer.

PREINSTALL preserves the previous executable by rename and copies it back for the template's normal prompts. Failure to rename or copy aborts (`src-tauri/nsis-hooks.nsi:58`, `src-tauri/nsis-hooks.nsi:65`). `.onInstFailed` attempts restoration of both executable backups (`src-tauri/nsis-hooks.nsi:89`).

An Ignore at the template's main or loomctl extraction reaches POSTINSTALL, which uses `SetOverwrite try`, clears errors once, writes both files again, and checks the error flag after both writes (`src-tauri/nsis-hooks.nsi:109`). A successful second write does not clear a first-write error. If a still-locked loomctl prevents replacement, install aborts and restoration is attempted for the pair. If a lock prevents preserving the original loomctl during PREINSTALL, the already-preserved main is restored and the original loomctl remains. A blocked rollback is reported with the affected names and leaves its previous backup available; it does not falsely claim that restoration succeeded. This agrees with [NSIS overwrite semantics](https://nsis.sourceforge.io/Reference/SetOverwrite) and [its extraction error handling](https://github.com/kichik/nsis/blob/master/Source/exehead/exec.c#L527).

No new installer correctness finding was confirmed. I did not build or execute NSIS, and the existing test does not exhaust every post-replacement lock or failed-rollback case.

## Checks and regression-test quality

Every commit in the requested range was read, including its tests and relevant callers. The following distinguishes tests that exercise the former failure from tests that mainly establish the new contract.

| Commit | What the new checks establish / what they miss |
|---|---|
| `58e8c7e` | Report only; no production change. |
| `bf83813` | The native redirected-parent, same-repository fixture exercises the old wrong-target predicate and the new refusal, including force. Meaningful regression case; not compiled here. |
| `cbb9ede` | Native tests cover ordinary retention, restoring both directories, expiry, and the old claim folder. The writer fixture verifies that late files remain before purge. It does not exercise failed administration move/retry, disconnected volumes, re-registered trash, collisions, or branch-deleted undo. With the API changed, the tests cannot simply compile unchanged against the old implementation; the writer timing is also not a deterministic old-code data-loss proof. |
| `252e6d5` | The real Pane-method harness plus a native-generation model fails the old installed-A/pending-B stop case. It checks the method invariant, rather than proving that a currently exposed caller relaunches a live Claude pane. No real PTY was used. |
| `3119c18` | The Rust report-lock test and shutdown mocks exercise the mutex/barrier and final Stop behavior. Idle Stop completes and busy Stop becomes unknown, which differs from the old sweep. The 150 ms delayed Codex batch validates an expected ordering case with the new envelope. It misses delayed Claude Start plus returned Stop, deadline expiry, and a final journal failure after native shutdown. |
| `a6f7a7e` | The NSIS scratch test uses the real hook, simulates the ignored main extraction, and checks a blocked original main. The old hook would accept the ignored extraction's mismatched pair. It is stronger than a mock of the hook logic, but does not cover every locked-loomctl/rollback permutation. Not run: that would build an installer. |
| `059c217` | The page checks exercise hang-up cancellation and continued keyed execution; the latter is a control case that already worked. The gate abort check covers listener and long timer cleanup. Mutation safety was traced through callers: mutations do not pass the cancellation signal into their own completion wait. |
| `acc7377` | A genuine old-code failure: a continuation-line `(y)` was missing from acknowledgement keys. Actual old and new prompt functions were compared in the targeted check. Deep wrapping beyond the existing menu-gap limit was not a newly solved case. |
| `37cc3be` | A genuine old-code failure: a plain quoted clock-shaped row counted as status. Actual old/new functions reject/accept the respective quote/dim status cases as expected. Giving the working fixture realistic dim cells calibrates the test; that positive fixture alone would also pass the old broad matcher. Existing Ready/Working title checks are useful controls, not newly failing old-code tests. |
| `9261b36` | Repairs the mock's successful removal response to put `steps` under `data`. It makes the consumer checks match production. This is a test-contract fix, not independent evidence of a production regression or fix. |

One small combined diagnostic was used, with corrections to its handle-sharing assumption and Windows pipe/Unicode literals. It used scratch Git folders and native file handles, then in-memory TypeScript transpilation/AST extraction for actual production handlers. It confirmed the prune and second-move-lock witnesses, the two report-state cases, old/new prompt behavior, v3 unknown-Stop metadata, and gate cancellation cleanup. All final assertions passed. All scratch folders and handles were cleaned up.

The source-level findings are labeled as such; I did not execute native Loom deletion, purge, Tauri transport shutdown, or an actual external drive case. There were no builds, full task/UI suites, live bridge calls, or operations on this repo's worktrees. No served-bundle/responsive claim is made.

### Other behavior found clean

- Native report send and close share one mutex; send holds it through sequencing/emission. I found no new reverse lock order through the session map. The shutdown command also includes page-supplied IDs, so a pane removed from the native session map can still have its remaining markers drained.
- The final sweep callback is now an arrow function, so the periodic timer's callback argument cannot accidentally turn an ordinary sweep into a shutdown sweep.
- Native hang-up removes the pending reply slot. Request IDs are monotonic and not reused during ordinary operation; late replies have no matching slot. Page cancellation maps are removed on completion, polling waits release within one 200 ms tick, and event-gate waits remove abort listeners and timers. Keyed requests share their existing execution, are never resent on hang-up, and mutations continue.
- Both the activity path and task sweep pass real terminal-cell styles to the Codex status matcher. The heuristic is not protected only in its unit fixture.
- The report's unknown-Stop hash stays durable without becoming a non-completed v3 `response`. Policy and the opt-in v4 surface retain their existing separation. Nothing in this range changes ASH-LOOM-EVENT formatting.

## Review limits and recommendation

The only intended repository write is this report. Tracked code, staging, commits, and all pre-existing untracked documents were left alone. Range whitespace checks passed; diagnostic code and assertions ran in scratch/in-memory contexts. No installed application was changed.

Do not stop the loop yet: the remaining issues are not merely unlikely wrong or missing notices. The failed-move retry and blanket prune have concrete Git-metadata loss witnesses, and a recovered checkout is not protected from expiry at its registered trash path. Fix those transaction/recovery boundaries first. The legacy clock-less Codex row and rare report/storage timing cases should not become an open-ended heuristic or test expansion project after the data-loss paths are closed.
