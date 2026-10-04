# Review of reservation gaps and startup replay through 38eaaca

Reviewed `dee308f..38eaaca`, ending at `38eaaca2e4bd5ec85b4c0d336e43576337c0c834`. Review date: 2026-10-04, Africa/Tunis. Loom locations refer to committed files at `38eaaca`. Bridge locations refer to the implementation read from `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`.

All three reported failing scenarios pass. Retaining a refused reservation as a cancelled task preserves the sequence stream, releases its journal key, and creates no notice. One P2 remains in startup notification policy: closing a pane before replay removes its saved override from the snapshot, which can send a muted completion or permanently suppress an enabled one.

The reference report is [Claude's review of startup turns](LOOM_STARTUP_TURNS_CLAUDE_REVIEW_2026-10-04_134628.md). `ecf9aef` adds that report. `189a1a7` addresses F2, `d00b258` addresses F1, and `38eaaca` addresses F3.

## Finding

### R1. [P2] Preserve a closed startup pane's override before replay

Location: `src/main.ts:4344`. Related locations: `src/main.ts:4067`, `src/main.ts:4074`, `src/main.ts:2601`, and `src/main.ts:3928`.

The new pre-replay `recordNotify()` call fixes the policy for panes that remain live. Its snapshot still reads overrides only from `threads[*].panes`. `Thread.closePane` removes a pane from that array immediately. A startup task/report can remain buffered after the pane closes, but its fresh runtime owner has never appeared in a policy snapshot. The previous run's snapshot names older owner IDs, even when the restored pane carries their saved aliases.

Failing scenario:

1. Save a Codex pane with notices off while the global policy is on. Its previous runtime owner is `old-id`, with a completed task ending at sequence 3. The saved pane carries that owner alias.
2. Restart with the journal read delayed. The restored pane has a new runtime owner, `p1`, and still has notices off.
3. Type a startup prompt, press Enter, and receive its completed-turn report while history is loading. The turn and report wait in `startupTurns`.
4. Close the pane before the read finishes. Its turn completed before the close; this is not an interrupted turn.
5. Finish the read. The new snapshot preserves `old-id: off` for the old retained task, but it contains no setting for `p1` because that pane is no longer live.
6. Replay creates the new task's accepted/submitted/completed events at sequences 4, 5, and 6. The completion inherits global on: v3 permits it and v4 returns send. It should remain muted.

The focused check used the committed loader, manual turn/report handlers, `Thread.closePane`, policy snapshot, journal queue, and notify/watch handlers. It retained the saved owner alias and the older task. The old owner remained off, the new owner was absent from every snapshot, and `notify --check 6 --policy-v4` returned send. Journal replay preserved that answer.

The reverse case also fails. With a saved pane on and global off, a completed startup turn whose pane closes before replay becomes muted. The actual v3 bridge ingests that false completion into permanent suppression and creates no outbox row. V4 also returns muted rather than a recoverable hold, so adopting v4 does not repair this policy error.

A separate in-memory bridge check reproduced both delivery consequences. A closed pane set off generated one fake send call; a closed pane set on generated one permanent muted record and no send. No real email was sent.

Fix: capture each startup pane's runtime owner and saved override while the pane exists. Include overrides needed by buffered turns/reports in the snapshot at `got.seq`, even if those panes have since closed. Preserve that captured policy through numbering and journal recovery, then release the startup bookkeeping. Use the captured runtime owner identity, not the reusable pane reference. Add both closed-pane directions to the startup-policy regression, including a saved owner alias, prior history, and replay after another restart.

This is a remaining variant of F1. The reported scenario with a live pane is closed.

## Status of the reported fixes

| Finding | Verdict and failing-scenario check |
| --- | --- |
| F1. Startup turns precede this run's policy | Closed for the reported scenario. `loadTasks` records this run's snapshot at `src/main.ts:4344`, before `finishTaskReplay` numbers buffered events. The empty-journal branch follows the same order at `src/main.ts:4333`. With global off and the live Codex pane on, its buffered completion returned v3 true and v4 send before and after journal replay. The reverse live-pane case returned false/muted. R1 covers a pane removed before that snapshot. |
| F2. Failed reservation leaves a sequence hole | Closed for the reported scenario and tested concurrent reservations. At `src/main.ts:3788`, the failure clears the journal key, retains the accepted event, and creates a cancelled event with reason not-recorded. Completing a submit, refusing the next reservation, then completing another returned `[1,2,3,4,5,6,7,8,9,10]`, `last: 10`, and `gap: false`, including after replay. The actual bridge advanced to 10 with no halt and queued only the two real completions. |
| F3. Older startup reports follow newer held reports | Closed. `finishTaskReplay` at `src/main.ts:3686` temporarily removes the later held reports, replays the startup buffer, and then appends those later reports. With A's start/Stop buffered, B's Enter outstanding, and B's start held, A became completed with A's response and B remained working without a Stop. Releasing B before the read produced the same result. An additional overlapping B/C hold case tracked all three turns and kept A's response on A. |

## Refused-reservation behavior

The new cancelled task behaves correctly in the checks below. No additional confirmed defect was found in this part of the change.

- Nothing is typed when the reservation fails. The failure returns `typed: false` and a task ID. The retained task is final, cancelled, key null, reason not-recorded, with accepted and cancelled events.
- The receipt is removed by the existing unwritten-send catch at `src/main.ts:7564`. The refused ID remains a task ID, not an available receipt token. `receipt` reports unavailable, and `wait --task` returns the cancelled task.
- Accepted/cancelled events are v3 false and v4 none. They create no finish, fail, or blocked notice and do not become a completion-dedup entry in the bridge.
- While the cancellation recovery write is held, task-specific watch returns no events, `last: 0`, and `done: false`; checks return null. After the write lands, both events become visible and watch reports done. Unwritten cancellation events are not published as durable.
- The durable cancelled task releases its journal key. After a restart, retrying the refused request creates a new task and types once. Repeating that successful retry returns the same new task and types nothing further.
- Same-process retries still return the cached refusal through `installCli` at `src/main.ts:8334`. Clearing `t.key` does not evict the request cache. This matches the existing contract at `docs/loomctl.md:909`, where a key returns its first answer while retained. The new regression tests the retry after reboot, not an immediate retry in the same process.
- A successful reservation followed by a draft/question guard refusal remains the distinct not-sent cancellation. Its key stays spent, and a retry after restart returns that task without typing. The new reservation-failure path does not weaken that protection.

Concurrent recovery checks used two panes with both reservations queued before rejecting the first write. They covered a successful second reservation, a failed second reservation, and the first write leaving complete bytes before reporting failure. Every case produced contiguous event numbers in both live watch output and journal replay, with the refused task's key null after recovery. These checks used the VM's native promise realm for the journal queue and reservation awaits.

## V3 and v4 bridge contract

The committed watch and notify handlers are textually identical between `dee308f` and `38eaaca`. Their policy inputs and event retention change in this range, but their output formats do not.

The on-disk bridge still accepts v3 only. Its capability is `loom-durable-events-v3` at `email_bridge/bridge.py:30`; `event` requires the same nine fields at line 57; and `batch` requires the same six batch fields at line 90. The existing help probe, watch command, and boolean/null checks succeeded against values returned by the committed handlers.

Actual bridge `Store.ingest` accepted the complete reservation test stream, advanced its cursor to 10, and retained the refused attempt as cancelled. There were two outbox rows and two fake deliveries, both for real completed tasks. Replaying the batch created no additional rows or deliveries. The contiguity guard at `email_bridge/bridge.py:249` did not fire, and halt remained empty.

V4 retains the same batch fields and event identity fields, replacing notify with disposition. Its accepted/cancelled events returned none, its allowed completions returned send, and v4 checks agreed with those event dispositions. A validation-only conversion to the existing bridge's parser/store confirmed the same sequence and terminal-state transitions. The actual v3 parser still rejects an unconverted v4 batch as `blocking_source_update_required`, as intended. A v4 consumer remains necessary for the opt-in protocol; this review does not claim the current bridge can consume it.

R1's failing batches also pass schema validation. Their problem is incorrect eligibility, not a changed format.

## Validation and preservation

Committed unit modules passed all 151 task checks, seven event-gate checks, and 64 CLI checks. Focused cases executed the committed reservation, send, receipt, CLI request-cache, startup replay, policy, watch/check, task routing, sweep, and journal functions. The installed TypeScript parser extracted the needed functions from Git objects, and Node's native type stripping ran them in isolated contexts. Exception-class fields and terminal/native I/O were modeled. Pane closing used the committed method with UI disposal mocked.

Bridge checks used `python -B`, the real parser/store/delivery/source-adapter methods, SQLite `:memory:`, and fake command/sender callbacks. The disk-opening Store constructor was bypassed. No production database, journal, credential, SMTP connection, live pane input, or running bridge process was accessed. No native UI or served-bundle reproduction is claimed. The new bundle-dependent `scripts/task-check.mjs` regressions were inspected, not run.

This report is the only file written. No source edit, build, staging, or commit occurred. HEAD, the Git index, and all 156 tracked working files remained unchanged, including the pre-existing Cargo.toml modification. SHA-256 checks also confirmed all ten examined bridge source/docs/test files unchanged.
