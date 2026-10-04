# Review of closed startup pane policy through bbf054a

Reviewed `38eaaca..bbf054a`, ending at `bbf054a9d6af57fb1a5240508eb3c94cfa2d3262`. Review date: 2026-10-04, Africa/Tunis. Loom locations refer to committed files at `bbf054a`. Bridge locations refer to the implementation read from `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`.

The exact R1 reproducer is closed in both directions, with its saved owner alias, prior completion, failed first write, and replay after another restart. The fix is incomplete for a completion still held behind an Enter write. It also introduces a legacy-owner recovery regression when a captured `inherit` setting conflicts with an older journal override. There is one P2 finding and one P3 finding.

The reference is [Review of reservation gaps and startup replay](LOOM_RESERVATION_GAPS_SOL61_XHIGH_REVIEW_2026-10-04_151304.md). `0b40a47` commits that report. `bbf054a` changes startup policy capture and its regression checks. I also read today's earlier task-journal, owner-hold, notification-policy, and startup-turn reviews to distinguish remaining cases from new regressions.

## Findings

### F1. [P2] Apply a closed startup pane's inherit setting before exempting its legacy alias from a hold

Location: `src/main.ts:4348`. Related locations: `src/main.ts:2560`, `src/main.ts:4080`, and `src/main.ts:4081`.

The new migration linkage includes every captured startup alias, including aliases captured with `inherit`. But `currentNotify` discards captured inherit entries while retaining the previous journal override for closed owners whose tasks remain. A saved alias now bypasses the legacy ownership hold without receiving the saved pane's actual policy.

Concrete failing scenario:

1. The journal contains a completed task for `oldOwner` at sequence 3. Its last policy has global off, `oldOwner: on`, and no `owners` migration marker.
2. Start Loom with the same saved pane and alias. Journal writes fail, including the migration rewrite.
3. Change that pane from on to inherit. The policy write also fails, but the separate workspace save succeeds. The saved pane now inherits global off and retains the owner alias. The journal still contains the older explicit on override and no migration marker.
4. Restart with writes working and the journal read delayed. Restore the inherited pane, then close it before replay.
5. The new linkage treats `oldOwner` as identified and skips its hold. The archived-snapshot filter retains `oldOwner: on`, and the captured inherit entry contributes nothing to replace it.
6. `notify --check 3` returns true, and the v4 check returns send. The completion should be muted by the restored inherited setting. Another restart preserves the incorrect send decision.

This sequence used the committed loader and `setPaneNotify` to generate the failed-write state. Every journal write in that first launch rejected. The workspace-save callback captured inherit and the alias, and the original journal bytes remained unchanged. The live-pane control correctly mutes the completion.

| Second-launch condition | At 38eaaca | At bbf054a |
| --- | --- | --- |
| Restored inherited pane stays live | false / muted | false / muted |
| Same pane closes before replay | false / held | true / send |
| Replay after that closed-pane launch | false | true |

The old closed-pane answer was an ownership hold, not a complete application of the saved inherited policy. This commit changes that safe refusal into permission to send. The actual bridge's parser, ingestion, and delivery code made zero fake send calls for the parent and one for the new closed-pane case. No network connection occurred.

Fix: make a captured setting authoritative over the archived override even when the captured value is inherit. Exclude IDs present in `startupNotify` from the first archived `last.panes` merge, then add only explicit captured on/off entries. This removes a stale explicit override for inherit while preserving the saved identity linkage. Add the failed-migration-write, failed-inherit-write, successful-workspace-save, close-before-replay case, including another restart.

### F2. [P3] Retain the captured override while an Enter-held completion can still create its task

Location: `src/main.ts:3695`. Related locations: `src/main.ts:4080`, `src/main.ts:4165`, `src/main.ts:4030`, and `src/main.ts:8820`.

Replay restores later Enter-held reports to their hold and clears `startupNotify`. A report-adopted turn can still have no task at that point. The immediate post-load `recordNotify` then drops its closed runtime owner's captured override because that owner is absent from both the live panes and the task map.

Concrete failing scenario:

1. Save a Codex pane off with global on, its historical alias, and an older completed task ending at sequence 3.
2. Delay the next startup journal read. Enter a collapsed-paste prompt, so `manualEnter` records a marker rather than immediately creating a task. Keep the successful Enter write's acknowledgment outstanding.
3. Receive its matching completed-turn report before closing the pane. The report remains in `enterHeld` until the write outcome arrives.
4. Close the pane, finish the journal read, and execute the normal post-load policy recording before releasing the Enter hold.
5. The first snapshot at sequence 3 contains the fresh runtime owner's off override. Replay clears the startup map. The next snapshot, also at sequence 3, removes that owner because its task has not been adopted yet.
6. Release the successful Enter hold. The retained completion creates accepted, submitted, and completed events at sequences 4, 5, and 6. The latest policy at sequence 3 has no runtime override, so the completion inherits global on and becomes send.

The reverse case, saved pane on with global off, becomes permanently muted. The saved historical alias still makes the correct decision for sequence 3. It does not repair sequence 6.

| Saved setting and global setting | Sequence 3 | Sequence 6 | Sequence 6 after another restart |
| --- | --- | --- | --- |
| Pane off, global on | false / muted | true / send | true / send |
| Pane on, global off | true / send | false / muted | false / muted |

Both cases reproduce with a successful policy write and with the first write rejected before recovery. The actual v3 bridge sends the muted pane's new completion in the first case. In the reverse case it records that new completion in permanent suppression and creates no outbox row for it. V4 also returns the wrong send/muted decision.

This variant already fails at `38eaaca`; it is a remaining R1 case rather than a new regression. P3 reflects the required ordering inside an outstanding Enter acknowledgment. Pane closure does not release the frontend hold. The terminal callback releases it when `pty_write` settles at `src/main.ts:1784`.

Fix: retain the pre-replay snapshot's closed runtime override while `enterHeld` contains that owner, even if the task map does not yet contain its eventual task. For this path, extend the archived-snapshot retention condition to `kept.has(id) || enterHeld.has(id)`. Once the hold releases, adoption synchronously creates the task, which takes over retention. Add both directions with an unreadable or collapsed composer, a held Enter acknowledgment, completion before close, post-load policy recording, and a later release. Include recovery and another restart.

## Original R1 disposition

The reported readable-Codex-prompt scenario passes. At `src/main.ts:2560`, startup capture records both the new runtime ID and saved aliases. At `src/main.ts:4081`, explicit captured overrides enter the pre-numbering snapshot even after the pane closes. At `src/main.ts:4352`, policy recording still precedes replay numbering.

Sixteen focused cases covered on/off, successful/failed first writes, legacy/migrated journals, and immediately tracked/report-adopted Codex turns. Each retained an old alias and sequence-3 completion, closed the restored pane, and replayed the resulting journal in another startup with fresh runtime IDs.

- Pane off with global on stays false in v3 and muted in v4 for both the old and new completion.
- Pane on with global off stays true in v3 and send in v4 for both completions.
- All events remain uniquely numbered 1 through 6, with no gap.
- While the first write is outstanding, the new completion's check is null and watch publishes none of the new events. Recovery writes the captured policy with the tasks.
- Another restart preserves both decisions.
- A prior historical mute remains permanent even when the saved pane is on; its newer eligible completion still sends.
- The unrelated pane that moves into the closed pane's reference acquires no identity link to it.

The committed regression at `scripts/task-check.mjs:819` covers the exact on/off reproducer, saved alias, prior history, failure recovery, and second restart. It uses a readable prompt whose task is already buffered, so it does not cover F2. It does not exercise captured inherit, so it misses F1.

## Other correctness and bridge checks

No additional confirmed numbering, recovery, or startup-order regression was found.

The existing failed-reservation path still retains its cancelled record and releases its key. A focused refusal followed by a completed turn produced contiguous sequences 1 through 8, no gap, and a replayable cancelled task. An unreadable startup attempted no journal write and published no durable event. Empty-journal closed-pane startup passed both directions. Older startup reports still precede newer Enter-held reports: the older Claude task kept its Stop and response, and the newer task stayed working without that Stop. An unlinked legacy owner remained held until explicit release.

The external bridge remains v3:

- `email_bridge/bridge.py:30` selects `loom-durable-events-v3`.
- Its real probe/read/check methods accepted the committed help and selected unchanged v3 commands.
- The actual parser and in-memory Store accepted all sixteen original-R1 v3 batches. Allowed completions delivered once through a fake sender; muted completions entered permanent suppression. Replaying Loom's restarted output created no duplicate delivery.
- V3 events retain exactly nine metadata fields and boolean notify. Default checks remain boolean or null. V4 uses disposition strings only with the explicit selector.
- Feeding an actual v4 batch to the unchanged v3 parser returned `blocking_source_update_required`, as expected. This change does not deploy a v4 consumer.
- The inherited-policy regression also survived replay against a fresh SQLite connection copied from the consumer's committed in-memory state.

The bridge consequences in F1 and F2 come from wrong Loom policy decisions, rather than a new output-shape incompatibility. Bridge suppression is permanent at `email_bridge/bridge.py:289`; its pre-send boolean check is enforced at `email_bridge/bridge.py:391`.

## Validation and preservation

Production function text came from Git objects at the specified commits. The installed TypeScript parser extracted the loader, startup buffer, Thread add/close methods, manual adoption and reports, journal queue, snapshot functions, and real notify/watch handlers. Node's native type stripping executed those functions in memory. Pane rendering, input acknowledgments, journal I/O, and workspace saving were synthetic. These checks establish the stated interleavings at the function boundary, not a native UI reproduction.

The proposed combined retention changes were tested only in an in-memory source copy. All sixteen original-R1 cases still passed. Both Enter-held directions then returned the correct result through recovery and restart, and the inherited closed alias became muted through restart. No repository source was edited.

`src/task.test.ts`, `src/task_event_gate.test.ts`, and `src/cli.test.ts` passed. `git diff --check 38eaaca..bbf054a` passed. The bundle-dependent task-check additions were inspected, not executed. No build, served-bundle claim, native pane input, live Loom command, production journal or bridge database access, credential access, SMTP connection, staging, or commit occurred.

Python ran with `-B`. The bridge Store constructor was bypassed; its actual schema, parser, ingestion, and delivery methods used SQLite `:memory:` and a fake sender. No bridge file was written.

This report is the only filesystem artifact created. Final preservation checks compare HEAD, the Git index, all 157 tracked working files, and ten examined bridge source/docs/test files with the initial snapshot. The pre-existing Cargo.toml modification and untracked files were left in place.

