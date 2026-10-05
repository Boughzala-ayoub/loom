# Loom FIX16 follow-up review

Review date: 2026-10-05. Branch: `main`, HEAD `66d959292305b30c83eec8a06402e9b00772d0e4`.
Range: `9261b36..HEAD`, eight commits. `857430e` adds the preceding report only.
Baseline: [FIX15 review](LOOM_FIX15_SOL61_XHIGH_REVIEW_2026-10-05_152604.md), with the [FIX14 review](LOOM_FIX14_SOL61_XHIGH_REVIEW_2026-10-05_131013.md) read for the deletion design.

## Status of the R15 findings

| Finding | Does the fix close its own failing scenario? | Assessment |
|---|---|---|
| R15-1, second trash move fails and retry erases administration | Yes for transactions created by this version | `remove_worktree_at` resumes before handling a missing source. The pending record and Git `locked` file preserve the administration through a blocked second move and ordinary prune. A completed older deletion no longer hides a newer pending one. Recovery still trusts pathnames after a crash, R16-2. An incomplete record written by the preceding version is not migrated, R16-9. |
| R15-2, thread creation prunes an unavailable worktree | Yes | The blanket prune is gone. `createThread` prepares only its candidate path, and native preparation resumes only a matching pending transaction. An unrelated unavailable worktree's index stays registered. |
| R15-3, purge erases a manually repaired checkout at its trash path | Yes | Purge detects restored administration or a matching live backlink and cancels the manifest. The original manual repair scenario is covered. The new restore operation shares the manifest lock with purge, but its own Git transition has R16-3 and R16-4. |
| Branch undo note | Yes when the saved objects remain available | The manifest records the branch and commit. Restore recreates an absent branch with a zero-old-value `update-ref`, restores the index, and refuses a ref already pointing elsewhere. The recorded hash does not retain its objects, R16-1. An existing branch checked out elsewhere is also accepted, R16-8. |
| R15-4, final journal failure leaves normal work running with reports closed | Yes | The surviving page stays in a committed close-retry state. Panes are marked dead, spawn and CLI admission refuse new work, the final events are consumed once, and the journal's failed write remains retryable. A normal second OS close can save it after storage recovers. |
| R15-5, final reports precede older batches or the barrier silently expires | Yes for the reported delayed-delivery and failed-emission cases | Batches route in contiguous sequence order before returned final events. A failed native emission retains its reports without advancing `emitted`. Deadline expiry keeps the shutdown result for another close attempt. A page reload creates an irrecoverable sequence gap, R16-5. |
| R15-6, unavailable parent causes the manifest to be forgotten | Yes | Both retained parents must be reachable before either location is erased. The administrative-parent check also prevents mistaking an unavailable parent plus a reused entry name for restoration. A returning parent permits the next purge to finish. |
| R15-7, same-millisecond IDs overwrite another transaction | Yes | Exclusive manifest creation reserves ownership before either move. A collision advances the numeric suffix. Failure cleanup removes only the reservation obtained by that operation. |

## New findings, ranked

### R16-1. P1. Git collection can destroy the retained commit and staged contents before expiry

Location: `src-tauri/src/deletion.rs:137`, `src-tauri/src/deletion.rs:227`, `src-tauri/src/deletion.rs:239`, `src-tauri/src/deletion.rs:331`. Branch deletion follows native removal at `src/main.ts:5365`.

A worktree has a branch-only commit and a staged file version that differs from its working file. Those objects were created weeks ago. Delete its worktree and branch today, then run normal `git gc` in the repository before the 24-hour trash period ends.

Loom moved the worktree's HEAD, reflog, and index out of Git's `worktrees` directory. Deleting the branch removes its other ref and branch reflog. Git does not discover recovery roots from `.git/loom-trash` or Loom's JSON. It can collect the old commit and staged blob even though the retained index, manifest, and working folder still exist. Restore cannot recreate the missing commit. Even with the branch kept, a staged-only blob can lose its only Git-visible root.

This is a retention defect inherited from the trash design, exposed by the new promise to restore the index and deleted branch. The two-week object-age rule does not mean two weeks since Loom deleted the worktree. Git documents object-age pruning and protection through refs, indexes, and reflogs. [Git gc documentation](https://git-scm.com/docs/git-gc)

Evidence: real scratch Git, `2.39.1.windows.1`. Loose-object modification times were aged 31 days to represent an old checkout. `git prune --dry-run` found nothing eligible while the worktree was live. After the two directory moves and branch deletion, ordinary `git gc --quiet`, without `--prune=now`, removed both the branch-only commit and staged-only blob. The manifest, index, and working file remained. This executed the Git boundary, not compiled Loom deletion.

Fix: retain Git-visible roots or a protected retention pack for the saved HEAD and every object referenced by the retained index until restore or purge finishes. A ref for the saved commit alone does not preserve staged-only versions or conflict stages. Establish that protection before removing Git's normal administration or deleting the branch.

### R16-2. P1. Pending deletion resumes against a replacement or redirected source without checking its identity

Location: `src-tauri/src/deletion.rs:120`, `src-tauri/src/deletion.rs:133`, `src-tauri/src/deletion.rs:156`, `src-tauri/src/deletion.rs:201`.

Loom writes A's pending manifest and its Git lock, then crashes before the first folder rename. During recovery, the user moves A's parent aside and redirects the old parent to B, another worktree of the same repository. This is the earlier R14-1 layout, established while Loom is stopped, not an attacker swapping a path between checks.

Delete A again, or restore its pending trash ID. `resume` matches the recorded path text and repository administration parent, then calls `finish_record`. Because the trash destination is absent, it renames `r.from` directly. It never repeats `entry_of`, the final-root check, or the nested-checkout check. B moves into A's trash transaction. A's administration then moves beside it. B's own backlink still names B's old path, so the restored-check guard does not recognize the new trash location as live. Normal expiry can erase B's working files.

The same missing association affects the second move. If the user unlocks and prunes a stale entry, then Git reuses its administrative name for another checkout, resume accepts that new entry, adds the generic pending lock, and moves it as the old transaction's administration. The lock reason identifies no particular transaction or file identity.

Evidence: source path from `remove_worktree_at` and `restore` through `finish_record`. The normal fresh-deletion identity guard is bypassed on these paths. No native wrong-target deletion or purge was executed.

Fix: persist and verify the folder and administrative identities for the transaction before each resumed move. Refuse a replaced source or entry instead of adopting it. Reapply the worktree backlink, final-root, and nested-checkout checks when a first move has not happened. Bind the Git lock to the transaction ID rather than accepting any entry bearing the same generic reason.

### R16-3. P1. Restore exposes its index to Git prune before repairing the links

Location: `src-tauri/src/deletion.rs:339`, `src-tauri/src/deletion.rs:341`, `src-tauri/src/deletion.rs:345`.

Restore a checkout to a different free path while a trusted agent runs `git worktree prune` in the repository. Restore first moves the working folder, then moves its administration back into `worktrees`. That administration is unlocked. Its `gitdir` still names the missing original folder until the subsequent repair command.

If prune runs after the administrative rename but before repair, Git treats the restored entry as missing and recursively deletes it, including the retained index. The manifest lock excludes another Loom restore or purge, but Git does not consult that manifest. Repair then has no administration to repair, and a retry cannot recover the erased index from `entry_at` either.

Evidence: real scratch Git reproduced exactly this intermediate layout. A staged version differed from the working file. After the two restore-order renames, before either link repair, normal `git worktree prune` removed the whole administrative entry. The restored working folder remained. No Loom build or native restore was run.

Fix: install a transaction-owned Git `locked` file in the retained administration before moving it back into `worktrees`. Keep it through both backlink repairs and the durable restore transition, and remove only that transaction's lock after the checkout is valid. Resume must validate the administration's identity as described in R16-2.

### R16-4. P1. Retrying a half-restored record can overwrite another checkout's Git link

Location: `src-tauri/src/deletion.rs:311`, `src-tauri/src/deletion.rs:334`, `src-tauri/src/deletion.rs:344`.

Restore A to `C:/recovered`. Its folder rename succeeds, but moving the administration fails because an index handle temporarily denies rename. The command returns an error with `restoring` set. The user moves that incomplete folder aside and creates a different checkout B at `C:/recovered`, then later retries the same trash ID.

The retry checks only that the requested destination's spelling equals `restoring`. The occupied-destination guard belongs to the first attempt. With `r.at` absent, the later move block and its second destination check are skipped. After moving A's administration, restore unconditionally truncates B's `.git` file and writes A's pointer into it. B's working files now use A's index and HEAD. B's original administrative mapping is no longer the one its checkout selects.

A redirected destination parent after the partial restore has the same problem. The first-attempt refusal of occupied paths does not protect resumption.

Evidence: source scenario. The blocking-index failure is an ordinary Windows failure already exercised by the deletion tests. I did not execute native restore against a replacement checkout.

Fix: record the identities and phases of the restored folder and administration. On every retry, verify that an existing destination is the folder this transaction moved there before writing its `.git` file. Refuse a replacement, redirected target, or mismatched administrative pair. Absence of the trash source is not evidence that the destination belongs to the transaction.

### R16-5. P1. Reloading the page permanently blocks report routing and ordinary window close

Location: `src/main.ts:4369`, `src/main.ts:4374`, `src/main.ts:8878`; native counter at `src-tauri/src/lib.rs:1018` and `src-tauri/src/lib.rs:1028`.

After at least one numbered report batch, focus a nonterminal part of the window and reload the WebView, for example with Ctrl+R. The JavaScript page starts again with `agentBatch = 0`, but native `Reports.emitted` survives. Later batches start at 2 or higher. The new contiguous router buffers every batch while waiting for batch 1, which Rust already sent and cleared.

Close the window. Native shutdown kills the panes and returns the surviving emitted number. Every close attempt waits three seconds for the same impossible gap, then refuses destruction. The body stays inert and all new CLI commands are refused. A second close reuses `shut`, so it does not ask native code for missing batches. The user must terminate the process to leave this state. Before closing, the map can also keep growing as later batches accumulate behind the gap.

This is reachable without development tools. The repository does not handle Ctrl+R in the global key handler. The installed Wry source defaults browser accelerator keys to enabled, and Tauri's builder does not disable them. WebView2 documents Ctrl+R as reload and enables browser accelerators by default. [WebView2 accelerator settings](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3)

Evidence: the actual `receiveAgentBatch` function and production close callback were extracted and executed in a small VM harness. A fresh page receiving batches 2 and 3 routed neither. Two close attempts both timed out waiting for batch 1 of 3, with one native shutdown, no final-event routing, no destruction, and an inert body. The clock was controlled to avoid real three-second waits. The native lifetime and reload route were inspected in source, not exercised in a live installed WebView.

Fix: give each page a report-stream handshake with a defined starting sequence and replay of unacknowledged batches. Preserve emitted batches until the page acknowledges them, or let shutdown return a missing batch. Do not leave a committed window with no way to resolve an unrecoverable gap. Disabling reload alone would cover one trigger but would not recover a genuinely lost delivery.

### R16-6. P2. An empty or damaged manifest disables unrelated trash operations and new worktree creation

Location: `src-tauri/src/deletion.rs:112`, `src-tauri/src/deletion.rs:155`, `src-tauri/src/deletion.rs:233`, `src-tauri/src/deletion.rs:240`, `src-tauri/src/deletion.rs:293`.

A process exits after exclusive manifest creation but before the initial write, or a full disk makes that write fail. The reservation remains as an empty or partial `.json` file. Later state updates also overwrite JSON in place, so a crash or failed write can damage an existing pending or restoring record.

Every `resume` opens and parses every central JSON record before checking its repository or folder. One bad record therefore aborts deletion and preparation for unrelated repositories. Creating any named thread whose candidate path is absent reaches this scan and fails. `trash list` fails on the same record, while purge silently skips it. Freeing disk space and restarting does not repair its contents.

An unrelated record currently held by another Loom operation also aborts the whole scan, though that failure is transient. The manifest lock is per record; the scan accidentally makes its availability affect every transaction.

Evidence: source error propagation. The initial write's `?` has no reservation cleanup, and record updates use rewind, write, and truncate rather than an atomic valid-state replacement. No disk-full or process-kill experiment was performed.

Fix: remove a failed initial reservation before any move or Git lock has occurred. Publish later state changes atomically while keeping a stable per-record lock. Report or quarantine damaged records without aborting unrelated operations. A busy unrelated record should not block a different repository's candidate path.

### R16-7. P2. A rejected restore permanently fixes its destination and disables expiry

Location: `src-tauri/src/deletion.rs:322`, `src-tauri/src/deletion.rs:328`, `src-tauri/src/deletion.rs:337`, `src-tauri/src/deletion.rs:360`.

Run restore with a free destination on the wrong volume. Before testing the rename, the command writes `restoring = destination` and may recreate the deleted branch. The cross-volume rename then fails. Correct the command to use a free path on the retained folder's volume. It is refused with "Resume this restore at" the first destination, even though neither retained directory moved.

The record is now excluded from expiry indefinitely. There is no cancel operation. A branch-conflict refusal has the same early state mutation: it marks the record restoring before discovering that the branch moved, and can unnecessarily reserve an administrative suffix and destination.

Evidence: source ordering. This was not tested on a second volume. It does not erase retained data; its worst case is a stuck recovery operation and retained storage.

Fix: perform the branch and volume preflight before committing the restoring state. Track whether a move actually happened. Permit changing the destination or cancelling a failed attempt while both retained locations are still intact. If an attempt created a branch, undo that side effect only with a checked old ref value.

### R16-8. P2. Restore silently puts two live worktrees on the same branch

Location: `src-tauri/src/deletion.rs:327`, `src-tauri/src/deletion.rs:345`.

Delete a worktree while keeping its branch. Open that branch in a new Git worktree at the same commit, then restore the old trash record to another free folder. The existing ref matches the saved commit, so Loom accepts it. `git worktree repair` permits both administrative records to retain the same symbolic HEAD.

The normal `git worktree add` guard against sharing a checked-out branch has been bypassed. A commit or branch change from one checkout changes the HEAD seen by the other while that other checkout retains its older index and working files. Restore does not warn that it has created this shared state.

Evidence: the scratch diagnostic executed the relevant moves, Git-link rewrite, and repair. `git worktree list --porcelain` then reported two live worktrees with `branch refs/heads/shared`. This tested Git repair's behavior, not compiled Loom restore.

Fix: inspect current worktree branch occupancy before repair. Refuse a branch checked out elsewhere, or explicitly restore detached at the recorded commit and explain that outcome. Continue refusing changed branch refs.

### R16-9. P2. An older half-move is not recognized as pending, so CLI undo refuses it

Location: `src-tauri/src/deletion.rs:95`, `src-tauri/src/deletion.rs:169`, `src-tauri/src/deletion.rs:222`, `src-tauri/src/deletion.rs:239`, `src-tauri/src/deletion.rs:315`.

The preceding Loom version moved the working folder into trash, failed its administrative move, and left its four-field manifest. Install this version and run `loomctl trash restore ID` for that record.

Deserialization defaults the old record's new `pending` field to false. Restore therefore skips `finish_record` and refuses the record because `entry_at` is absent. The retained working folder and original administration are both still available, but the new recovery operation does not join them.

The native removal retry also mishandles this format if invoked for the absent original path. `resume` sees a completed record, finds the administration still registered, and returns `None`. Removal creates a second transaction with `from = None`, moves only the administration to a new `entry_at`, and reports a nonexistent folder destination. The old record then owns the working folder and the new one owns the administration. Restore refuses both. This is an additional method-level consequence, not a claim that the already-closed thread remains available through `close-thread` after restart.

Nothing has been erased immediately, but the advertised CLI undo does not recover the preceding version's failing state. The user must join the original and retained locations manually.

Evidence: comparison with the manifest written at `9261b36` and the current deserialization, resume, and restore paths. This was not executed with an older application binary.

Fix: recognize an old record whose retained folder exists while its original administration remains registered and its retained administration is absent. Validate that association and migrate it into one pending transaction before creating a new missing-folder record. Do not infer this solely from a reused administrative basename.

## Transaction and shutdown checks

The following distinctions matter when assessing the remaining risk.

- Before a valid manifest and Git lock exist, no directory has moved. An interrupted reservation can nevertheless cause R16-6. A partially written Git `locked` reason can also remain after a crash or write failure. Resume refuses a reason other than the exact pending string, and purge skips pending records. The user can explicitly unlock it, but this is not automatic recovery.
- Between the two deletion moves, a complete transaction-owned Git lock survives a process crash. Ordinary Git prune honors it. Git list can still show the missing, locked original worktree, and ordinary remove or reuse is blocked until recovery finishes or the user unlocks it. Loom has no startup sweep that completes every pending transaction; its CLI restore or a matching deletion/preparation must resume it.
- If both deletion moves succeeded but the final pending-state update did not, a valid earlier pending record can settle the already moved locations without moving them a second time. That is safe while their identities remain unchanged. The in-place record write and path-replacement cases prevent a broader crash-safety claim.
- The exclusive Windows manifest handle serializes the reviewed version's resume, restore, and purge for that record, including across Loom instances. Purge skips a held record rather than racing that restore. This lock does not serialize Git's own commands, R16-3, or establish that a saved pathname still identifies the same object, R16-2 and R16-4.
- ID reservation has no small retry limit. It advances a `u64` suffix until exclusive creation succeeds or a non-collision error occurs. I found no ordinary timing path to overwrite another reservation or exhaust that suffix. The fixed-clock test meaningfully forces collisions. Extremely long basenames remain a checked filename-length failure rather than proof of support for every legal source path.
- The unavailable-parent policy intentionally retains both halves until both parents return. If a repository or parent is permanently deleted, its manifest and any surviving central folder can remain indefinitely. Restore also requires the repository's Git common directory to exist. These are conservative retention limits and can consume disk; they are not evidence of a new wrong-target recursive deletion. There is no CLI purge or abandon command in this change.
- Fresh restore refuses an occupied original or `--to` path, allocates another administration name when the old one is occupied, and does not overwrite an already changed branch ref. IDs reject path separators, colon, and dot traversal names. The destination must be absolute. CLI parsing rejects unsupported options and missing values, and the new outputs use the existing response envelope with list records or `{ restored, dir }`. The same-volume restriction is enforced by rename failure, with the state problem in R16-7.
- The recursive purge uses Rust's remover, whose child-link behavior is unchanged. I found no new ordinary static redirected-parent path through fresh deletion's backlink guard. The concrete new redirect path is the pending resume in R16-2. Purge can be partial on a locked child and keeps its manifest for retry. Neither its record lock nor `read_dir(parent)` pins ancestor identities. I did not treat forged records or deliberate swaps between checks as findings.
- For a final journal failure with a satisfied report barrier, `shut.events.splice(0)` routes final events once. A second close does not repeat native shutdown or requeue those reports. `drainJournal` retries the failed journal as a whole snapshot. The inert page does not disable the native window close control. Failure before native shutdown resets the page latch; failure after it keeps the committed close-retry state. No new lock-order deadlock was found between report admission and the Session map.
- The expired barrier performs bounded 20 ms waits for three seconds per close attempt, not a busy spin or an automatic infinite retry loop. A batch that eventually arrives can make the next attempt succeed. A missing batch that can never arrive gives R16-5. Native failed-emission retention is an uncapped vector until successful emission or shutdown; I found no separate normal-delivery duplicate path from its exclusive draining and sequencing.
- `runCli` rejects all new commands in the committed state, including read-only watch and help. Existing admitted waits can still settle, and existing keyed replies can replay. A storage failure therefore affects the bridge's availability while the app stays open. It does not change the v3 serialization contract.

## Regression-test quality

These are source comparisons unless an executed check is explicitly described above. I did not compile an old tree or rerun the fixer's mutations.

| Change | What the new checks prove against earlier behavior |
|---|---|
| `4b39208`, pending-administration test | Meaningful old failure. Holding the index permits the folder move but prevents the administrative move. The old retry entered recursive `forget`, whereas the test requires HEAD and index preservation, protection from real Git prune, and eventual recovery. It also exercises an older completed transaction at the same path. It does not replace a pending source or administrative identity. |
| `c067983`, creation check | Meaningful old failure. It executes the actual `createThread` with real scratch Git and temporarily moves another worktree's parent. The old blanket prune removes that index. The native preparation test separately checks candidate-only recovery; that newly introduced function cannot compile unchanged against a tree where it does not exist. |
| `7c57d48`, repaired-trash test | Meaningful old failure. The old purge deletes the folder after manual administration restoration and repair; the test reads the recovered working file and staged version afterward. The separate CLI restore test establishes the new feature's ordinary contract and record-lock exclusion, not an executable old restore regression. It uses fresh objects and leaves no interrupted restore to resume. |
| `e5eb5cd`, fixed-clock reservation test | Meaningful collision regression. Three operations share a basename and supplied clock tick, with one independent move failure. The old overwrite/remove behavior loses a prior manifest. It tests collisions deterministically without requiring real concurrent scheduling. |
| `f4f3957`, unavailable-parent test | Meaningful old failure. It moves the retained-folder parent aside, requires both the record and administration to survive, then returns the parent and requires purge. It also tests unavailable administrative ancestry with a replacement worktree. This simulates the NotFound behavior of an offline location; it does not execute cross-volume error 17 on an unplugged physical drive. |
| `3dfb88b`, shutdown VM and task-check cases | The production close callback runs, and a failed final drain must leave panes dead, reject restart, retain the write, and destroy after a second close without another shutdown. The VM's persistence queue is a mock, so that assertion alone is weaker than the task-check case reading the journal saved at destruction. Neither resets the page after native reports have been sent. |
| `66d9592`, ordered-batch and delayed Start/Stop checks | Genuine ordering coverage. The VM delivers 2 before 1 and requires contiguous routing and duplicate suppression. The task-check fixture delivers Claude Start before the returned Stop is finally routed, including after the first barrier expires. The old code routes final Stop first and silently closes on expiry. They assume the missing batch eventually arrives. |
| `66d9592`, Rust emission checks | Meaningful retained-report invariant. False emission must not advance the counter, shutdown must return the report, and a later successful emission must contain the old Start before the newly drained Stop. This does not prove that successful Tauri scheduling is a page receipt or survives navigation. |

The R15-1 to R15-3 assertions have real failure conditions; they are not merely round-trip tests that restate the new fields. Disabling pending resume, restoring blanket prune, or removing restored-check protection should break the relevant checks. That supports the claimed purpose of those mutations, but does not independently verify that the fixer ran them. The available `.rust-tests.log`, `.unit-current.log`, and `.task-check-full.log` predate this range and are not evidence of those runs. Five close-retry screenshots exist, and the new fixture explicitly loops over 320, 375, 768, 1024, and 1280. I found no layout change that justified rerunning or auditing the claimed responsive pass. I do not certify its served bundle, server, or all-view coverage.

## Checked and found clean

The reviewed range changes no mail formatter or `src-tauri/src/bin/loomctl.rs`. The `watch --metadata --policy` handler still emits `loom-durable-events-v3`, the task source, boolean `notify`, and the existing metadata fields. `response` remains a hash or null, and v4 remains an explicit `--policy-v4` choice. ASH-LOOM-EVENT formatting is not edited by these commits. The external bridge was not run and no mail was sent.

Fresh deletion still refuses a final-root link, a mismatching Git backlink, a nested checkout, and a user-locked worktree. The reviewed retry no longer recursively deletes administration as a substitute for moving it. Normal same-volume trash moves retain whole folders rather than allocating a second copy. Cross-volume retention uses the recorded sibling destination. Restore and purge share a real per-record Windows exclusion mechanism. Normal failed journal writes remain recoverable in the same page, and native spawn admission closes before shutdown takes the sessions.

## Review method and recommendation

I read the eight commits, their changed tests, and the relevant deletion, creation, CLI, journal, event-routing, shutdown, Tauri event, and Wry paths. `git diff --check 9261b36..HEAD` passed. A focused scratch diagnostic checked Git collection, shared-branch repair, and the prune-sensitive restore transition, and extracted the real JavaScript batch router and close callback. All final assertions passed. Its initial Node `.git` rewrite hit Windows hidden-file behavior and was corrected to use an existing-file handle. I did not promote that harness failure into a Loom finding: Rust's Windows file open implementation handles that case differently. [Rust Windows file implementation](https://raw.githubusercontent.com/rust-lang/rust/1.90.0/library/std/src/sys/fs/windows.rs)

All scratch directories were created under the temporary directory, their resolved cleanup targets were checked, and they were removed. No repository worktrees, builds, heavy suites, installed application, production trash, staging, or commits were touched. Existing untracked documents were left alone. The only repository write is this report. Source-only scenarios are labeled; no live native crash, restore race, power-loss, removable-volume, or WebView reload experiment is claimed.

Do not install this as the final fix yet. R16-1 has a direct Git data-loss witness, R16-3 has a direct index-erasure witness, and R16-5 has a production-handler witness for a permanently unclosable committed window. The pathname recovery defects can also erase or attach the wrong checkout after ordinary recovery actions. These are more than unlikely missing notices or retained folders. Fix those boundaries, then stop expanding the loop once the remaining issues are only the explicit retention and rare notice limits.
