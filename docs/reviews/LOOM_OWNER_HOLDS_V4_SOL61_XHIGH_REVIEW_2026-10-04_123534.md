# Review of owner holds and the opt-in v4 policy through e72f435

Reviewed `8a968a8..e72f435`, ending at `e72f435bccc5ad0d82b2bb90bf3f1d8bfecef104`. Review date: 2026-10-04, Africa/Tunis. Loom source locations refer to committed files at `e72f435`. External bridge locations refer to the implementation read from `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`.

The original F1 policy-write scenario and F2 captured-watch scenario are closed. F3 now has a correct opt-in consumer contract, and its addition preserves v3 compatibility. Two findings remain: automatic turns during startup can corrupt event numbering or publish unwritten events, and the v4 migration checklist lacks an exclusive sender cutover. The latter is a migration-plan defect, not a failure observed in the running bridge.

The reference report is [Review of notification policy fixes through 8a968a8](LOOM_POLICY_FIXES_SOL61_XHIGH_REVIEW_2026-10-04_111400.md). `dab8c00` adds that report; `d83f318`, `0d41c2e`, and `e72f435` address F1, F2, and F3 respectively.

## Findings

### N1. [P1] Initialize automatic-turn numbering before publishing loaded history

Location: `src/main.ts:4288`. Related locations: `src/main.ts:3718`, `src/main.ts:3733`, `src/main.ts:3896`, `src/main.ts:3940`, and `src/main.ts:8767`.

The new readiness guard stops journal writes before the startup read finishes, but automatic task creation still allocates event numbers and inserts tasks into the live map. `manualEnter` immediately creates a Codex task for a readable prompt. Its accepted and submitted events increment the counter, initially zero, even while `journalLoaded` is false. The rejected journal calls leave those tasks in memory as unsaved.

`loadTasks` subsequently takes the maximum of the old journal counter and the in-memory counter and assigns that value to both `taskSeq` and `writtenSeq`. That does not renumber the early events, and it also treats their numbers as durable before their writes succeed.

Failing scenario with existing history:

1. The journal contains an old task's accepted, submitted, and completed events at sequences 1, 2, and 3.
2. Delay the startup read until a restored Codex pane can accept input. Type a prompt and press Enter while that read is pending.
3. The new manual task gets accepted/submitted sequences 1 and 2. Its writes are rejected by the new guard.
4. Finish the read. The loader merges both tasks, then its recovery rewrite persists both sets of events without renumbering.
5. `watch --metadata --policy --after 0` returns sequences `[1, 1, 2, 2, 3]`. A v4 watch has the same sequence defect. The existing bridge rejects this batch as `invalid_event_order`; the sequence IDs are now ambiguous in the saved journal as well.

The focused check ran the committed `manualEnter`, `turnTask`, loader, journal queue, and watch handler. Replaying the rewritten journal confirmed the new task retained sequences 1 and 2 and was marked saved. Feeding the returned v3 batch to the actual external bridge parser reproduced `invalid_event_order`.

A second scenario exposes the durability problem without any collision. Start with an empty journal and create the same early Codex turn. After the read returns, hold the first recovery write. Watch already returns sequences `[1, 2]`, `last: 2`, and `next: 2`, although the journal remains empty and the task reports `saved: false`. Rejecting that write leaves the same unwritten events published. A consumer can acknowledge them; a crash then removes events Loom represented as durable.

Fix: buffer automatic turns/signals without journal sequence numbers until replay has initialized the counter. Allocate their numbers after `got.seq`, then journal them normally. Initialize `writtenSeq` from the replayed journal alone and advance it only after successful writes. Add both delayed-read/manual-Codex cases: existing history with unique numbers after replay, and an empty journal with a failed first write that exposes no unwritten events.

This is a remaining startup variant, not a claim that the reported F1 pane-policy scenario still fails. Early allocation was already unsafe before this range; blocking its writes does not complete startup isolation.

### N2. [P2] Specify an exclusive v3-to-v4 sender cutover

Location: `docs/turn-tracking-and-notifications.md:185`. Related locations: `docs/turn-tracking-and-notifications.md:175` and `docs/turn-tracking-and-notifications.md:194`.

The five v4 steps describe parser, queue, checking, and deduplication changes, but step 5 only says to migrate the capability marker and queued v3 rows explicitly. There is no v3-to-v4 procedure requiring the old sender to stop, requiring exclusive access to its state during migration, or preventing two independently active state directories. The following stopped-sender procedure explicitly applies to v2, and the bridge's `--after-review` entrypoint accepts v2 state only.

Failing cutover scenario:

1. The running v3 sender has an eligible pending notice. A v4 migration copies its state to a new directory, preserving the cursor, event IDs, seen records, and completion deduplication as step 5 requests.
2. The old sender remains active. Its runner lock protects the old directory only; the new directory has a different lock.
3. V3 checks the notice as true and sends it. V4 checks the copied notice as `send` and sends it too.
4. Each database correctly records one delivery. Preserved local deduplication cannot prevent the two senders from delivering the same event independently.

The actual bridge takes `single_runner(self.root)` at `email_bridge/bridge.py:154`; that lock opens the directory's own `runner.lock` at `adapter/bridge.py:646`. An in-memory check cloned the entire bridge database, including identities and deduplication tables, then ran actual `deliver_one` on both copies with fake senders. Both copies sent the same event ID: two send calls.

The cutover must also preserve delivery-state meaning. Existing `sending` rows recover as `uncertain` at `email_bridge/bridge.py:198`; existing `held` rows mean an unavailable event requiring manual review, not a recoverable ownership hold. Neither may become an automatically retryable v4 owner hold. The document's SMTP section already correctly forbids automatically resending uncertain delivery; the migration procedure needs to carry that invariant across the schema/state transition.

Fix: add an ordered cutover procedure and enforce it in the future bridge migration command. Stop the v3 sender and obtain its runner lock before taking a migration snapshot. Prefer an in-place transaction, or keep the old directory disabled throughout a move. Preserve namespace, epoch, cursor/baseline/halt settings, identities, seen/attempt/completion records, and queued mail. Define every old outbox state's mapping: pending remains eligible for a v4 pre-send check; sent/muted/dead remain final; sending becomes uncertain; uncertain and old manual-review holds remain review-only. Distinguish new owner holds from those manual-review states. Commit the new schema and capability marker together, define rollback before either sender resumes, and start exactly one sender after validating v4 capability. Include interrupted migration and dual-directory sender tests.

## Status of the three previous findings

| Previous finding | Verdict, including the reported failing scenario |
| --- | --- |
| F1. Migration marker published before loading legacy history | Closed for the reported pane-bell interleaving. With the committed read held, `setPaneNotify(p, "off")` rejects as still loading, changes no pane policy, and makes zero writes. `currentNotify` omits the owners marker while unloaded. After replay, the old owner is classified held before policy writes become available. N1 describes the separate automatic-turn path that remains unsafe. |
| F2. Captured watch loses an owner decision after pruning | Closed. A task-specific watch captured the old task, 500 newer settled tasks pruned it, and a new policy snapshot omitted its owner. `notifyOwner` at `src/task.ts:362` found the last explicit decision in earlier history. Held and muted owners stayed false in v3 and were refused in v2; v4 returned held and muted respectively. An explicitly released owner remained allowed. Absence no longer releases an owner. |
| F3. A temporary hold becomes permanent consumer suppression | Closed at the opt-in v4 protocol boundary. At `src/main.ts:8059` held is distinct from muted, and `src/main.ts:7959` returns the same disposition for v4 checks. A retained eligible hold becomes send after durable release and still does after Loom replay. The v3 permanent-discard behavior remains deliberately unchanged, including for the running Ash bridge. That bridge has not adopted v4, so this commit does not recover its previously discarded notices or provide deployed recoverable delivery. |

The original ownership argument still holds: a closed legacy pane and its replacement can share `work:1` without sharing identity. These fixes correctly require explicit owner decisions rather than guessing from that reusable reference.

## Compatibility with the running bridge

Read the actual `email_bridge/bridge.py`, its source adapter and runner lock, foreground entrypoint, outbox-review script, email contract/runbook, and relevant tests in the external workspace. No bridge file or production state was changed.

V3 remains the default policy contract:

- `watch --metadata --policy` returns `loom-durable-events-v3`, the same six batch fields, and exactly the same nine event fields. `notify` remains a boolean; `disposition` appears only with the explicit v4 selector.
- `notify --check` returns boolean values or null. V4 strings require `--policy-v4`.
- The bridge's existing help probe still succeeds. Its unchanged read and check commands select v3. The actual parser accepts the emitted v3 batches and rejects a v4 batch as `blocking_source_update_required`.
- Comparing the pre-F3 commit `0d41c2e` with `e72f435` passed 1,536 policy cases and 32 actual watch/check handler cases. The intentional F1/F2 fixes correct previously unsafe race outcomes; F3 adds no further v3 eligibility or shape change.
- Actual bridge ingestion/delivery methods, using an in-memory database and fake sender, queued and delivered an allowed event once and permanently suppressed held/muted v3 events. A queued notice checked false became permanently muted and remained unsent after a later true check. This confirms compatibility and the acknowledged v3 limitation.

## V4 held-notice recovery and its limits

The committed Loom handlers passed all eight task states against absent, held, muted, and released owners. Non-outcomes return none. Historical policy mutes take precedence over a hold and remain muted after release. Invalid v4/resolve-option combinations make no journal mutation.

Release creates no task event: a watch after the acknowledged cursor returns an empty batch, while a check of the retained event returns send. Therefore independent held-row rechecks are necessary; the migration checklist correctly requires them.

A reference v4 adapter exercised the actual bridge's existing transaction, event identity, completion deduplication, and outbox methods against SQLite in-memory databases. It passed:

- Held ingestion with a retained outbox row and cursor, then consumer restart modeled by copying committed database state to a fresh connection.
- A notice queued before its owner becomes held, followed by release and one delivery.
- Release without new watch events; an unrelated eligible notice can pass a held row.
- Replay with changed disposition and a repeated completion at a later sequence, producing no second delivery.
- Batch failure rolling back both notice insertion and cursor advancement.
- Permanent historical mutes and null checks kept for manual review without automatic release.

These checks establish that the v4 contract can preserve and deduplicate held notices when the consumer implements the stated queue rules. They do not establish crash durability or SMTP delivery for a deployed v4 bridge: no such bridge implementation is included here. `scripts/task-check.mjs:498` likewise uses in-memory pending/sent sets; its restart check restarts Loom, not a durable external consumer. The protocol changes alone cannot enforce a consumer's cursor transaction, cutover exclusivity, or treatment of uncertain SMTP acceptance. N2 must be addressed before treating the adoption list as a complete safe migration plan.

## Validation and preservation

Committed unit modules passed: `src/task.test.ts` 151 checks, `src/task_event_gate.test.ts` seven checks, and `src/cli.test.ts` 64 checks. Focused cases used committed functions extracted with the installed TypeScript parser and executed with Node's native type stripping. Production sources came from Git objects, not the working tree. Journal I/O, pane state, and terminal input were synthetic.

Python used `-B`, the real bridge parser/store/delivery methods, SQLite `:memory:`, and fake source/sender callbacks. Its disk-opening Store constructor was bypassed. No live Loom command, production journal access, SMTP connection, credential access, native UI reproduction, build, staging, or commit occurred. The bundle-dependent task-check additions were inspected, not run.

This report is the only file written by this review. HEAD, the Git index, and all 154 tracked working files remained unchanged, including the pre-existing Cargo.toml modification. SHA-256 checks also confirmed all ten examined bridge source/docs/test files unchanged. A separate untracked `LOOM_MANUAL_TURNS_NOTIFICATION_POLICY_SOL61_XHIGH_RESUMED_REVIEW_2026-10-04_111612.md` appeared between preservation snapshots and was left untouched.
