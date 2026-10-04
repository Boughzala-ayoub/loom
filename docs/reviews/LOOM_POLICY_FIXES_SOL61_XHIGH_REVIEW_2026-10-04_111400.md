# Review of notification policy fixes through 8a968a8

Reviewed `a414496..8a968a8`, ending at `8a968a8283ac29701f143733f6e9dc7128df82cf`. Review date: 2026-10-04, Africa/Tunis. All source locations refer to committed files at `8a968a8`.

R2 and R3 close their reported races. The author's R1 identity argument is correct, and explicit owner decisions are a reasonable alternative to guessing a migration. R1 remains incomplete: two paths bypass the ownership hold, and representing a temporary hold as a v3 permanent mute can lose a notice before its owner is released. Three P2 findings follow.

The reference report is [Review of fixes through a414496](LOOM_REVIEW_FIXES_SOL61_XHIGH_REVIEW_2026-10-04_040806.md). `03b79b0` adds that report, `266edba` implements owner holds, `3cf2563` handles pending equal-policy writes, and `8a968a8` applies combined settings together.

## Findings

### F1. [P2] Do not publish the migration marker before loading legacy history

Location: `src/main.ts:4038`. Related locations: `src/main.ts:4289`, `src/main.ts:4263`, `src/main.ts:8758`, and `src-tauri/src/lib.rs:1348`.

Every `currentNotify` snapshot contains `owners`, including an empty map before task history has loaded. Presence of that field is also the only test for completed migration in `loadTasks`. Policy controls can call their setters while the asynchronous startup journal read is outstanding. `requireJournal` rejects an observed read failure, but does not reject or defer writes while the initial read is pending.

Failing scenario:

1. Start with a legacy saved pane and a journal containing an enabled completion for its old runtime owner. The journal has no ownership migration marker.
2. Delay the startup read. While the restored pane is visible, turn its bell off.
3. The setter appends a snapshot containing `owners: {}`, although no legacy owner has been examined.
4. The startup read returns journal bytes that include that append. This interleaving is possible because the native read and write run through separate blocking jobs.
5. `loadTasks` sees the empty map and skips migration. The old owner is neither held nor listed as unresolved. Its completion remains allowed despite the live pane's mute.

The focused check delayed the actual committed `loadTasks` read, completed the actual pane-policy write, and then returned the updated journal. The result was an empty persisted marker, zero unresolved owners, and `notifies === true` for the legacy completion. No owner-resolution command was issued.

Fix: distinguish history-not-loaded from a successfully loaded empty journal. Block or defer policy journal writes until loading and ownership classification finish. Emit the migration marker only after that classification, rather than deriving completion from the initially empty `notifyOwners` object. Add a startup-read/pane-mute interleaving regression.

### F2. [P2] Keep a held owner's decision when pruning a task captured by watch

Location: `src/task.ts:367`. Related locations: `src/main.ts:4038`, `src/main.ts:3813`, `src/main.ts:8037`, and `src/main.ts:8042`.

`notifies` checks ownership only in the latest policy snapshot. `currentNotify` removes owner decisions once that owner's tasks leave the task map. A task-specific watch deliberately retains its captured task across pruning, so it can still return that task's events after the latest snapshot has forgotten the owner. Absence then acts as an implicit release.

Failing scenario:

1. A legacy owner's completion is held, with no explicit release decision.
2. Start `watch TASK --metadata --policy --after 0`. It captures the task, then reaches its asynchronous wait.
3. Before the reply resumes, 500 newer settled tasks prune this task. A policy command records the next snapshot, which filters out the now-unretained owner's decision.
4. The watch builds its reply using the captured task and the latest snapshot.
5. It returns the held completion with `notify: true`. A v2 metadata watch also returns the completion instead of refusing it.

The focused check ran the committed watch handler, `keepTasks`, policy setter, and `notifies`. The underlying `notifyOwners` entry still said held, but its latest snapshot entry was absent. The v3 reply allowed the event. The corresponding v2 check bypassed the refusal. Both replies marked a retention gap; that flag does not revoke their returned notice or restore the ownership check.

Fix: absence from a filtered snapshot must not undo an explicit hold or mute. Find the latest explicit decision for this owner in retained history, or retain its decision while readers still hold the task. Alternatively refuse a notification read whose captured owner has become unavailable. Add task-specific v2 and v3 watch/pruning regressions requiring an explicit release before delivery.

### F3. [P2] Preserve unresolved notices instead of reporting them as permanent v3 mutes

Location: `src/main.ts:8050`. Related locations: `src/main.ts:8052`, `src/main.ts:7951`, `src/task.ts:367`, and `docs/turn-tracking-and-notifications.md:139`.

The new hold returns the same `notify: false` and pre-send `false` used for permanent policy suppression, under the unchanged `loom-durable-events-v3` source. Explicit owner release can later turn that result true. Existing v3 consumers cannot distinguish these temporary holds from permanent mutes.

The documented bridge contract makes this a delivery loss. A false event goes into its permanent muted table without an outbox row. A false pre-send check permanently mutes an already queued row. The cursor continues, and muted rows do not return to pending. The new paragraph acknowledges that release cannot recreate such rows, but the hold has already destroyed the pending decision's recoverability.

Failing scenario:

1. Upgrade with a legacy completion that is eligible under every historical policy.
2. The relay reads it while its owner is unresolved, receives `notify: false`, permanently suppresses it, and advances its cursor. The same loss occurs if a queued row receives false from its pre-send check.
3. Review that owner and successfully run `notify --resolve-owner ID release`.
4. `notify --check` now permits the event, but the relay has no pending notice to send. Reading after its acknowledged cursor returns no event for the release.

The focused check ran the committed watch and resolution handlers. The first batch returned the held completion as false and advanced to sequence 1. After a durable release, eligibility became true, but the next batch after 1 contained no events. The permanent-discard consequence follows the bridge contract documented at `docs/turn-tracking-and-notifications.md:139` and `docs/turn-tracking-and-notifications.md:144`; the external bridge implementation was not executed or inspected.

This is a documented limitation in `docs/loomctl.md:837`, not an undisclosed behavior. It still means the implementation provides a conservative suppression with possible permanent loss, rather than a recoverable hold awaiting the explicit release-or-mute decision.

Fix: preserve the distinction between held and muted at the consumer boundary. For unchanged v3 consumers, refuse reads and pre-send checks involving unresolved owners with a retryable error, so their cursor or pending row remains recoverable. A versioned protocol can instead expose a held disposition that consumers retain and recheck after resolution. Verify ingestion, queued pre-send checks, release, and resumed delivery against the consumer, including deduplication and permanent historical mutes.

## Judgment of R1's ownership argument

The argument holds. Historical task records contain a runtime owner ID, a reusable reference, an agent, and a launch generation. A legacy saved pane slot supplies no stable identity connecting that slot to the old owner. Closing a pane and adding its replacement can produce the same `work:1`, agent, and generation. Binding by reference would apply one pane's decision to another owner's notices.

A focused case loaded two distinct historical owners with the same `work:1` reference. Both appeared independently in `unresolved`. Releasing the closed owner allowed only that owner's completion; the other remained held, even with the replacement pane muted. This is the correct separation. Holds are a notification-policy migration, not an identity migration.

The normal hold and decision paths work:

- An unlinked owner is held before startup exposes the CLI.
- Holds remain effective across failed migration writes and another restart using modern saved slots.
- Release removes the ownership hold, while every historical policy mute still applies.
- Mute survives replay and cannot subsequently be changed into release.
- An identical decision retry after a failed write makes a recovery snapshot.
- Invalid owner IDs, decisions, and combined resolution/options requests mutate no journal state.

Thus an enabled historical event released after review is not incorrectly sent merely because a replacement pane with the same reference is off. Those are different owners. Events forbidden by historical policy remain forbidden. The incorrect sends are the unreviewed bypasses in F1 and F2; the incorrect loss is the permanent-consumer suppression in F3.

## Status of R2 and R3

| Previous finding | Verdict and failing scenario |
| --- | --- |
| R2. Equal policy acknowledges a pending failed write | Closed. At `src/main.ts:4051`, an equal request returns the current snapshot's uncaught write promise. With the first mute write held, the second request stayed pending and shared that one attempt. Rejecting it rejected both callers; succeeding resolved both. After failure, an identical retry made a whole rewrite and preserved the old completion's mute on replay. The identity check at `src/main.ts:4061` also passed a newer-version interleaving: completing the first write did not clear a second pending write or let its equal third request finish early. |
| R3. Combined global-off and pane-on exposes an intermediate mute | Closed. The handler calls one complete setter at `src/main.ts:7972`. That setter applies both fields synchronously at `src/main.ts:4067` and `src/main.ts:4068`, then records one snapshot before awaiting. With its write held, the original `notify work:1 on --all off` scenario already showed the pane on. A completion during that interval remained allowed before and after replay. Exactly one policy snapshot was written. |

No additional confirmed defect was found in the pending-write or combined-setting fixes.

## Validation and preservation

The committed `src/task.test.ts` passed all 144 checks. The committed `src/task_event_gate.test.ts` passed all seven checks. Focused checks used the committed policy setters, ownership migration, CLI notify and watch handlers, journal queue, replay logic, event gate, and task pruning.

Sources came from `git show 8a968a8:<path>` and `git diff a414496 8a968a8`. The installed TypeScript parser extracted functions; Node's native type stripping ran them in isolated in-memory contexts. Journal bytes, read/write scheduling, pane objects, and terminal behavior were synthetic. No native UI or served-bundle reproduction is claimed. The bundle-dependent task-check suite was reviewed, including its three new regression blocks, but was not run because this review forbids builds.

No source edit, build, staging, commit, live pane input, production journal access, bridge execution, or email send occurred. The requested report is the sole file written. HEAD, the Git index, and all 153 tracked working files remained unchanged, including the pre-existing Cargo.toml modification.

