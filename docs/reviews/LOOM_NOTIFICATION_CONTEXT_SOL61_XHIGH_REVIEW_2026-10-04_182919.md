# Loom notification context review

Reviewed 2026-10-04 18:29:19 Africa/Tunis (UTC+1). Target: `bbf054a..0039487`; checked HEAD `00394879401e06ad97038425ec72fb6bbd4c2f24`.

## Verdict

`351f5a0` and `7917fd4` close F1 and F2 of `LOOM_CLOSED_PANE_POLICY_SOL61_XHIGH_REVIEW_2026-10-04_163650.md`. Both notification directions, saved owner aliases, prior history, failed-write recovery and another restart passed focused checks.

The notification-context work has three confirmed findings below. Two startup interleavings export the wrong thread/pane snapshot; malformed optional replay metadata can export a private path. These failures persist once journaled. No new correlation, policy, numbering or legacy bridge incompatibility was found in the focused checks. Phase 2 also leaves the plan's display-only refresh unfinished, as the new documentation acknowledges.

Scope includes the report commit `adab186`, policy fixes `351f5a0`/`7917fd4`, plan/contracts `f8c20fd`/`4efcb39`, capture/persistence `554bf15` and export `0039487`. Earlier `docs/reviews/*2026-10-04*.md` reports supplied the review history. The external bridge source was read only.

## F1 — P2: replay's thread ID validator admits private paths

Location: `src/task.ts:103`. Related: replay validation at `src/task.ts:440` and projection at `src/task.ts:122`.

`taskContext` accepts any 1–96 printable ASCII characters as `threadId`. Consequently, a Windows path, POSIX path or recognizable secret can pass through this identifier field even though the label filter would reject the same value. Replay checks every optional context with this function, and `contextRecord` exports the accepted ID unchanged.

Concrete failing scenario:

1. Keep a valid task and completed event at sequence 3 in the journal.
2. Damage or supply its optional event context with `threadId: "C:\\private\\customer-repo"`, a safe thread name, valid number/time/origin, and otherwise valid core task data.
3. Restart and read `watch --metadata --policy --notification-context`.

The enriched completed event contains the exact private path in `context.threadId`. No invalid/private diagnostic is attached to that ID. The startup rewrite retains it. In the same fixture, an extra `dir` and prompt field were discarded and a raw pane title became null, showing that the ID is the remaining export route.

This is a malformed optional-metadata case. Freshly captured runtime IDs do not contain this path; the finding concerns the promised defensive replay/privacy boundary, not a claim that ordinary pane capture substitutes directories for IDs.

Fix: validate IDs against the runtime identifier format, or at minimum reject path/recognized-secret patterns in addition to the ASCII/length check. Preserve the core event and its sequence; replace the rejected optional ID with null and a fixed diagnostic. Do not put the rejected value in diagnostics. An in-memory change adding the existing `PRIVATE` check nulled the path with `invalid-context` while retaining the event and remaining safe fields.

## F2 — P2: pre-close context misses tasks deferred outside the task map

Location: `src/main.ts:3736`. Related: deferred task insertion at `src/main.ts:3967` and missing-pane fallback at `src/main.ts:3728`.

`keepContext` correctly saves the pane's final location in `p.left`, but transfers it only to tasks already in `tasks`. A readable manual startup turn has a Task object immediately, yet `turnTask` does not insert it into that map until startup replay. If its pane closes first, its retained task context remains the initial Enter snapshot.

Concrete failing scenario, using an eligible completion:

1. Delay the startup journal read. Create a readable Codex manual turn in pane 2, in thread `At Enter`. Its Task is buffered in `startupTurns`.
2. Hold that Enter's acknowledgment. Receive the turn's matching completion while held.
3. Rename the thread to `At Close`, close pane 1, then close the task's pane. Its correct pre-close snapshot is now `At Close`, pane 1.
4. Finish startup replay and record policy. Release the successful Enter hold.

The task receives accepted, submitted and completed events at sequences 1, 2 and 3. The completion is eligible (`notify: true`), but its exported context is `At Enter`, pane 2, `origin: "last-known"`. `p.left` contains `At Close`, pane 1; the task never receives that copy, and `contextOf` cannot find the removed pane. Actual journal replay and compaction keep the wrong completion snapshot.

The same missing transfer also affects a readable deferred startup task without a held completion: after close/replay, the sweep's `pane-closed` cancellation uses the initial snapshot. That outcome is not a notification, but confirms the gap does not depend solely on completion routing.

Fix: retain the latest pre-removal copy for pending startup tasks as well as tasks in the map, keyed by owner and generation. Keep this last-known copy separate from already captured accepted/submitted event snapshots. Make the missing-pane fallback use it, persist it with the task, and release the bookkeeping once no deferred task/report needs it. Simply overwriting `t.context` at close is insufficient: deferred acceptance currently reads that same field, and replayed submission can overwrite it again.

A small in-memory owner/generation lookup fixed the completion to `At Close`/1/`last-known`, preserved accepted/submitted as `At Enter`/2/`event`, and preserved the correction through replay and compaction. No source file was changed.

The committed held-startup test at `scripts/task-check.mjs:1083` uses a collapsed composer, so its task is adopted after close and can use `p.left` directly. It misses this already-created readable Task.

## F3 — P3: a later Enter hold discards an already captured startup report context

Location: `src/main.ts:4206`. Related: release at `src/main.ts:3916` and startup capture at `src/main.ts:4210`.

Startup deferral carries `ctx` into `taskSignal`, but an Enter hold retains only the Signal. Its release calls `taskSignal(p, s)` without the context. A startup report can therefore lose the snapshot already copied for it.

Concrete failing scenario:

1. Delay startup read. Enter readable Codex prompt A in pane 2, thread `At Enter`.
2. Rename the thread to `At Report` and receive A's matching completion. No Enter hold is active, so startup correctly captures `At Report`/2/`event` in its deferred action.
3. Enter prompt B and keep B's acknowledgment outstanding.
4. Rename to `At Close`, close the preceding pane, then close this pane.
5. Finish startup replay while B's hold remains. A's replayed report enters that hold. Release B's successful acknowledgment.

A still completes once, with the expected task correlation and event numbering, but exports `At Enter`/2/`last-known` instead of the captured `At Report`/2/`event`. The control case without B's hold exports the correct report snapshot. The wrong snapshot is written into A's event and survives replay/compaction.

F2 and F3 require different fixes. F2 needs a missing pre-close last-known transfer; F3 already had the correct event snapshot and must preserve it rather than replacing it with a close snapshot.

Fix: retain a typed held-report entry containing both the Signal and its optional captured context. Forward both on release, and preserve these entries in `finishTaskReplay`'s older-before-newer ordering. Reports that enter the hold without an existing captured context can retain their current last-known behavior. An in-memory carry/forward change restored `At Report`/2/`event` in both the held and control cases.

## Disposition of the earlier policy findings

Both fixes are present in `currentNotify` at `src/main.ts:4120`:

| Earlier finding | Result |
| --- | --- |
| F1: captured inherit failed to remove a closed historical alias's explicit override | Closed. `!startupNotify.has(id)` excludes the archived override even when the captured value is inherit. The closed alias now follows global off and stays muted through restart. |
| F2: a closed pane's override disappeared before its Enter-held task was adopted | Closed. `kept.has(id) || enterHeld.has(id)` retains the runtime override until adoption gives it a task owner. |

For F2, saved off/global on stayed false in v3 and muted in v4 for both the historical completion at sequence 3 and the new completion at sequence 6. Saved on/global off stayed true/send for both. Each direction passed with a successful first write, a rejected first write followed by recovery, and another startup with fresh runtime IDs.

The sixteen original R1 cases also passed: legacy/migrated history, readable/report-adopted turns, both directions and recovery. A prior historical mute remained permanent; an eligible newer completion still sent. A replacement pane at the same reference did not acquire the closed owner's identity. New events stayed uniquely numbered and hidden until durable.

## Other checks and remaining plan scope

Ordinary capture paths passed focused checks for submit reservation, ordinary send and manual turns. Rename and pane renumbering affected subsequent live-event snapshots without changing earlier ones. `Thread.closePane` captures before splice at `src/main.ts:2609`; thread disposal captures the complete pane array before removal at `src/main.ts:2778`. Historical events kept their original owner and agent/provider rather than borrowing a replacement pane's identity.

Replay, actual full-journal compaction, a refused append followed by full-write recovery, and pruning past 500 settled tasks preserved retained event contexts. While a write was outstanding or failed, watch hid unpublished events and `notify --check` returned null for them. Pruned history still reported a gap and unavailable checks. These checks do not repair the wrong snapshots in F2/F3; persistence faithfully retains whatever capture supplied.

The documented plan gap is at `docs/turn-tracking-and-notifications.md:566`. A rename/reorder alone does not refresh and journal open tasks' last-known display context. For example, an open task renamed from A to B without another event restarts as unknown with A's old last-known copy. The plan's phase 2 requests these hooks at `LOOM_NOTIFICATION_METADATA_PLAN.md:206`. Completing that item requires a display-only task-field update at the existing rename/reorder operations, preserving all prior event snapshots and creating no task-state event. This is already disclosed, and unknown remains ineligible for notification; it is separate from the three new findings.

Privacy checks confirmed that the new projection contains exactly ten context fields, canonical CLI-family provider values, and the core task owner as `paneId`. Extra directories/prompts were discarded; untrusted process titles were nulled; obvious private labels were excluded. F1 prevents an unconditional privacy pass for malformed replay contexts. Free-form safe thread labels retain the documented limitation that heuristics cannot recognize every secret.

## Legacy contracts, bounded batches and external bridge

Across 64 state/owner/global-policy cases, actual v2, v3 and v4 watch replies and both `notify --check` modes matched `7917fd4`, the pre-context parent. Removing only context and the capability suffix from enriched v3/v4 replies produced the same legacy core replies. V2 refusal of suppressed notices, v3 boolean policy and v4 owner dispositions remained intact. Plain watch explicitly strips context; `taskRecord` also excludes it.

Both enriched contracts returned every event exactly once when continued from `next`:

| Fixture | v3-context batch counts | v4-context batch counts |
| --- | --- | --- |
| 2,501 events, count bound | 1,000 + 1,000 + 501 | 1,000 + 1,000 + 501 |
| 1,500 events, large escaped labels, byte bound | 837 + 663 | 829 + 671 |

Each batch stayed within 1,000 events and 512 KiB of serialized event rows, and its whole JSON reply stayed below the bridge's 1 MiB limit. `next` named the last returned event, `last` stayed at the durable tail, and `done` became true only on the final batch. Invalid flag combinations were refused. Existing non-context reads remained uncut. The native follow loop already forwards the flag and continues from `next`.

The actual bridge at `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2` still selects v3 (`email_bridge/bridge.py:30`). Its exact parser, ingestion, policy recheck, fake delivery and replay deduplication accepted the 64 legacy v3 fixtures. Eligible notices delivered once; muted notices remained suppressed. Its source methods continued selecting `watch --metadata --policy` and default boolean `notify --check`. Actual v4 and enriched replies were rejected as `blocking_source_update_required`, as expected for this unchanged v3 consumer. No enriched email or bridge migration is implemented or implied by these commits.

## Validation and preservation

`src/task.test.ts`, `src/task_event_gate.test.ts` and `src/cli.test.ts` passed. Focused harnesses extracted production functions from the specified Git objects with the installed TypeScript parser and executed them using Node's native type stripping. Journal I/O, pane/input boundaries and acknowledgments were synthetic; tests used small Node heaps. These establish the failing function-level interleavings, not a served-bundle/native UI reproduction.

The full task-check and its browser/bundle-dependent additions were inspected rather than executed. No build, live pane input, production journal/database access, credential access or SMTP connection occurred. Python used `-B`, the bridge's real schema in SQLite `:memory:` and a fake sender. Proposed fixes existed only in memory.

`git diff --check bbf054a..0039487` reports the committed prior report's extra blank line at EOF (`LOOM_CLOSED_PANE_POLICY_SOL61_XHIGH_REVIEW_2026-10-04_163650.md:110`); this is not a correctness finding.

This report is the only filesystem artifact created. Preservation checks compare HEAD, the Git index, all 159 tracked working files and ten examined bridge source/docs/test files with the initial snapshot. The pre-existing Cargo.toml modification and untracked files remain in place. No staging or commit occurred.
