# Turn tracking and task notices

Implementation notes for tracking every turn Loom can see go in, and for the
notification policy that decides which task events may go out as notices.
User-facing behavior is in [loomctl.md](loomctl.md), under Tasks and Task
notices.

## Turns that are tasks

Every task has a `source`. A task journaled before sources existed reads as
`submit`.

| Source | Made | Correlated by |
| --- | --- | --- |
| `submit` | `loomctl submit`, journaled before typing | unchanged |
| `send` | `loomctl send` to Claude, Codex or OpenCode with Enter, right before its Enter (`sendText`, `beforeEnter`) | the same rules as a submit: the agent's report of its text, after its Enter |
| `manual` | A person's Enter in Loom's window: the pane's own terminal (`onData` of a bare `\r`), the Overview's reply box and bulk reply, and dictation's Enter (`manualEnter`) | Claude: its prompt hook, matched to the Enter by prompt hash, or within 10 s when the input couldn't be read. OpenCode: its first run after the Enter. Codex: at the Enter when its composer reads as a draft, otherwise its turn report naming an unclaimed prompt (`adoptManual`) |

A manual Enter becomes a task only when the agent's own report shows it sent a
turn, so an Enter that sent nothing never fabricates one. An Enter on an empty
input or a suggestion, one with a numbered question on screen, a report no
pending Enter explains (Claude's background notices arrive as prompt reports),
and a report from a launch the pane has since replaced make no task. A report
another task claims (a submit's or a send's own turn) never makes a manual one,
so a tracked turn isn't counted twice.

Two more rules come from the review of 2026-10-03 15:52:

- A person's Enter whose write to the process fails may have sent nothing.
  `manualEnter` returns what it noted, and the write's failure marks it
  (`manualFailed`). A task made from it carries `uncertain: "submit"` and ends
  `unknown` (`submit-uncertain`), never `completed`, because a report of the
  same words can come from an earlier prompt. While the write is out, the pane's
  reports wait in `enterHeld`, as they do for a send's Enter, so a report
  arriving first can't decide the task before the failure is known. A person's
  Enters don't take turns as sends do, so several may be out at once: each
  holds the pane on its own (`holdSignals`, a count per pane and a one-shot
  release per Enter), and the held reports go in only after the last of them
  has its outcome (review 2026-10-03 19:10). Reports and `sweepTasks` are the
  only ways an open task ends, and both wait, so no task is final before its
  own Enter's outcome is on it, a pane exit during the write included.
- Loom can't read OpenCode's input. An Enter there counts only if something was
  typed or pasted into this launch since its last Enter (`Pane.typed`: the
  launch that got it, never what was typed; Enter, Ctrl+C and Ctrl+U reset it).
  A draft left in a process before a relaunch is no sign for the next launch,
  so an empty Enter there claims no run (review 2026-10-03 19:10). And
  an Enter Loom writes itself (`keys`: loomctl's, the Overview reply's) drops
  any earlier Enter of a person's that named no prompt, so that Enter can't
  claim the turn loomctl sent.

Kept: the prompt's FNV-1a match (the same name a submit's prompt has), the
Enter's time and launch. Never kept: keystrokes, the prompt's text, or for a
manual task even its SHA-256 and size. The input is read off the screen only at
the Enter, and only to hash it.

Still untracked: a shell's ordinary send (no turn to follow; `send --receipt`
gives a receipt), `send --no-enter` followed by `keys enter`, input from outside
Loom, and a Codex turn whose input Loom couldn't read until it reports the end
(so an approval earlier in that turn is not a task event).

Codex turn ids are deduplicated per pane and launch now, so a relaunch can't
collide with an earlier launch's turn id.

## Notification policy

State in the workspace file: `notify: { on, kinds: { finish, fail, blocked },
newPanes }`, and each pane slot's own `notify: "on" | "off"` (absent is
inherit). Effective for a pane and kind: the pane's own on or off if it has one,
else every pane's `on`; and the kind's switch, always. `completed` is a finish
notice, `failed` a fail, `approval` blocked; no other state is a notice.

Each change appends `{ notify: { on, kinds, panes }, at }` to the task journal,
`at` being the last event number before it, and whole rewrites keep the
snapshots any kept event still depends on (`keptNotify`). Pane ids are new each
time Loom starts, so a snapshot carries the settings of panes no longer present
while Loom keeps tasks of theirs; a restart is then no policy change for their
events.

An event may go out (`notifies`) only if its kind was allowed for its pane by
the snapshot in force when it happened and by every snapshot since. The answer
only ever turns from true to false through policy changes. Turning a pane or kind off therefore also
holds back events from before that weren't sent, and turning it on again
releases none of them.

Saved pane slots now retain `notifyIds`, the historical runtime owners of their
retained tasks. Before ownership migration has been recorded, owners not linked
by an explicit alias are held separately, never matched by reference. This also
keeps the hold if the workspace saves new slots but the migration write fails.
The policy snapshot's `owners` map records `held`, `released` or `muted` decisions.
Its presence, including an empty map, marks the migration complete so later
closed panes are not mistaken for legacy owners. Replay and compaction retain it.

`notifies` checks the latest owner decision before the ordinary policy history.
An explicit `notify --resolve-owner ID release` removes only an ownership hold;
it cannot undo a historical policy mute. `mute` permanently suppresses that
owner. `notify` exposes unresolved owners and their historical references and
task IDs for review. A relay may already have discarded a held notice, so release
does not promise delivery or recreate its outbox entry.

Every change is its own journal line, in the order made. Changes between two
events share a number, so off, on and off again are three lines, and replay
keeps all three in order (a stable sort, no deduplication). A muted completion
stays muted after a restart.

`loomctl notify` checks every argument, the pane included, before it changes
anything. A refused command leaves the policy, each pane's setting, the journal
and the saved settings as they were. `--check` only asks and takes nothing else.

Loom exposes the decision at three points:

- `loomctl watch --after N --metadata --policy`: `loom-durable-events-v3`, the
  v2 fields plus `source` and `notify`.
- `loomctl notify --check SEQ,...`: the decision now, per event, `null` for an
  event Loom doesn't have.
- `loomctl watch --after N --metadata`: `loom-durable-events-v2`, the seven
  fields as before, but only while no event in the answer is a notice the
  policy holds back. Otherwise Loom refuses the whole answer and names v3. A v2
  reader can't see the policy and would send every outcome, so it gets none it
  mustn't send. With every pane on, the default, v2 answers exactly as before.
  Turning a pane off also holds back that pane's earlier outcomes, so a v2 read
  that reaches back over them is refused too.

## Email bridge contract (v3)

Changed in `Documents\Codex\2026-10-02\task-2` (not a git repository; the
files before this change are kept in this session's scratchpad). The running
v2 sender (`email-production-v2`) and its process, settings, SMTP setup and
credentials were not touched; a running Python process doesn't reload its
code.

- `email_bridge/bridge.py`: `CAPABILITY` is `loom-durable-events-v3`. `event()`
  accepts exactly the nine fields; `source` is `submit`, `send` or `manual`;
  `notify` is a boolean and true only on an outcome. `batch()` refuses a v2
  answer as `policy_capability_required`, never reading it as v3. The probe
  asks `help watch` (`--metadata`, `--policy`, the v3 name) and `help notify`
  (`--check`) and refuses with `policy_capability_required`; each part alone
  fails it. `read` asks `watch --metadata --policy`; `check(seq)` asks
  `notify --check`.
- Before the outbox: an outcome with `notify: false` goes to a new `muted`
  table and never gets an outbox row. Its completion record still suppresses a
  repeat of the same final message. The seen digest covers the seven v2 fields
  only, since `notify` may turn false between two reads of one event.
- Before SMTP: `deliver_one(store, sender, *, approved, check)`, with `check`
  required. `true` sends; `false` marks the row `muted` for good; `null` marks
  it `held` for review; an exception leaves it `pending` and sends nothing.
  Outbox rows keep their event number (`seq`).
- Re-enabling sends nothing muted: muted rows never return to `pending`, the
  cursor never moves back, and Loom never turns `notify` back to true.
- State directories: v1 and v2 directories are refused untouched
  (`state_from_other_native_source`), their mail listed read-only by
  `scripts/review_outbox.py`, which gives each row a disposition and the
  listing a `reviewToken`. `run_email_foreground.py --after-review OLD
  --review-token T` starts a new v3 directory from a stopped v2 directory's
  cursor (below).
- `docs/email-trigger-contract.json`: v3, the nine fields, and a
  `notificationPolicy` section. The email payload, subject and headers are
  unchanged; neither `source` nor `notify` goes into an email.
- `send_email_test.py` (the one synthetic message, no pane behind it) passes a
  check that always allows it.

### Recoverable owner holds, v4

Loom preserves the v3 bridge contract. `watch --metadata --policy` still
returns `loom-durable-events-v3` with exactly the existing event fields, and
`notify --check` still returns boolean values or null. Unresolved owners
still return false in v3. A bridge that permanently discards false results
cannot recover those notices merely because the owner is later released.

The opt-in v4 contract fixes that distinction. To adopt it, the external
bridge must make these changes together:

1. Probe for `--policy-v4`, read `watch --metadata --policy-v4`, and require
   `loom-durable-events-v4`. In the event parser, replace the `notify` boolean
   with `disposition`, allowing `send`, `held`, `muted`, and `none`.
2. Persist both `send` and `held` outcomes before advancing the watch cursor.
   Keep `held` outcomes in a retryable queue. Only `muted` outcomes belong in
   permanent suppression. `none` events create no notice.
3. Call `notify --check SEQ --policy-v4` before every send and when revisiting
   held rows. Send only on `send`, retry `held`, permanently suppress `muted`,
   and treat `none` as no notice. Keep null results for manual review and
   leave rows retryable on command errors.
4. Recheck held rows even when watch returns no new events. Release changes
   disposition without creating a new task event. Avoid letting one held
   row block unrelated eligible rows.
5. Preserve the existing event and completion deduplication. Exclude the
   mutable disposition from event identity. Perform the state migration
   through the exclusive cutover below. Do not automatically revive old
   permanently muted rows, since they may reflect real historical mutes.

Loom's checks cover the protocol's ingestion and pre-send dispositions,
release across a Loom restart, replay deduplication, and historical mutes.
They do not validate a deployed v4 consumer's durable queue or cutover. The
external bridge is not modified by this change.

#### Exclusive v3-to-v4 cutover

This procedure specifies requirements for a future bridge migration command
and v4 sender. Those tools must enforce the steps before v4 deployment.
The existing `--after-review` entrypoint accepts v2 state only; it cannot
perform this migration. Until the v4 migration is implemented and tested,
continue using the unchanged v3 sender.

Prefer migration in the existing state directory. The current `runner.lock`
protects one directory only. Copying its database to another directory does
not prevent both copies from sending the same notice. V4 must also hold a
sender lock keyed by the preserved namespace, at a canonical location
independent of the state directory. The migration command must hold that
lock as well. Existing v3 does not know that lock, so stopping and disabling
v3 and making its retired state unusable are still required.

1. Identify the sole authoritative v3 state directory and every launcher
   that can start its sender, including scheduled tasks and restart loops.
   Disable those launchers and stop the sender. Wait for it to exit and for
   any SMTP operation to finish. If delivery might have reached SMTP before
   termination, retain that uncertainty; do not infer that nothing was sent.
2. Acquire the source directory's existing runner lock before taking any
   snapshot or changing state. Refuse migration while another process holds
   it. Then acquire the namespace lock. If either lock fails, change nothing
   and send nothing. Hold both through snapshot, migration and validation.
   Do not use the ordinary Store constructor to take the snapshot: opening
   that Store already changes `sending` rows to `uncertain`.
3. Create and verify a consistent SQLite backup under those locks, including
   any committed journal or WAL contents. Keep the backup offline, with its
   existing private permissions, never as another configured sender
   directory. Record the migration ID, canonical paths, namespace, versions
   and phase durably so an interrupted command can resume or roll back
   without guessing which copy is authoritative.
4. Migrate in one database transaction. Commit the schema, state mappings,
   migration record and `native_source=loom-durable-events-v4` together.
   Preserve all other settings, including `namespace`, `epoch`, `cursor`,
   `baseline_set`, `halt` and `purpose`. Preserve event IDs and digests,
   attempt identities, `seen`, `attempts`, `completions` and `muted` records,
   and every outbox row. Keep queued body and mail bytes, retry counts, due
   times, reasons and dry-run flags. Record any required reason change in
   the migration audit rather than discarding the old value. Apply the
   outbox mappings below; do not reset the cursor or generate a new namespace.
5. While delivery remains disabled, validate the migrated state against the
   snapshot. Check settings, row counts, identities, queued payload hashes
   and every state transition. Probe Loom for the v4 watch and check
   contracts without sending mail. A failed check leaves delivery disabled.
   Preserve an existing halt; migration does not authorize clearing it.
6. Resolve the rollback decision before enabling either sender. Before v4
   has ever been activated, a failed transaction leaves the original v3
   state intact. A committed migration can be reversed from its verified
   snapshot under the same locks, provided the destination remains disabled
   and no sender has run since the snapshot. Restore schema and capability
   together, validate the result, then enable exactly one v3 sender. Once
   v4 has been activated, never restore a stale backup or restart its old
   v3 copy: that could resend delivered mail. Stop and lock v4, preserve its
   latest state, and repair it or perform a separately reviewed reverse
   migration that retains subsequent deliveries and uncertain attempts.
7. Mark the validated v4 state as the sole active destination and hand off
   the locks to exactly one v4 sender. It must acquire both its directory
   lock and namespace lock and validate the committed migration and v4
   capability before sending. Keep all v3 launchers disabled. The v4
   capability marker also makes an accidental old v3 start refuse the
   migrated state. Pending notices receive a fresh v4 pre-send check; no
   queued notice is sent merely because it survived migration.

If a directory move is necessary, hold both directory locks and the same
namespace lock. Prepare and verify the destination with delivery disabled.
Before activating it, durably retire the source with a capability marker
that the existing v3 Store refuses, and remove its launch configuration.
A marker understood only by new v4 code is insufficient to stop old v3.
Record and verify source retirement before committing destination activation.
An interruption between those steps leaves both senders disabled. Recovery
must inspect the recorded phases under the locks, then complete the handoff
or roll back before either resumes. Never leave two runnable state copies.

| Old outbox state | V4 mapping |
| --- | --- |
| `pending`, including retry backoff | Preserve pending state, retry count and due time; require a fresh v4 check before any send. |
| `sent`, `muted`, `dead` | Preserve as final. Do not requeue, including notices v3 permanently muted during an owner hold. |
| `sending` | Convert to `uncertain`; SMTP might already have accepted the message. No automatic resend. |
| `uncertain` | Keep review-only with its delivery evidence. No automatic resend. |
| `held` | Keep review-only: this means an unavailable event, not an unresolved owner. |

New recoverable owner holds must use a distinct state or typed reason, such
as `owner-held`. Only those holds are automatically rechecked for owner
release. Neither old `held` rows nor `uncertain` rows may enter that retry
path. Review must resolve SMTP uncertainty separately from Loom policy.

The future migration and sender implementation must pass these checks before
deployment, using temporary databases and fake senders:

- A running v3 sender prevents migration before any state change or send.
- Concurrent starts against source and destination directories cannot both
  deliver, even though their directory locks differ. A cloned pending event
  produces at most one send; retired v3 state refuses startup, and competing
  v4 copies contend on the namespace lock.
- Crash injection before and after schema commit, source retirement,
  destination activation and lock handoff leaves a resumable recorded phase.
  Repeating migration preserves all state and never enables both senders.
- Snapshot comparison covers every preserved setting and table, mail bytes,
  deduplication and the state mappings above. `sending`, `uncertain` and old
  manual-review holds never become automatically retryable owner holds.
- Rollback before activation restores one valid v3 store. Rollback after
  activation refuses stale-state restoration, including when SMTP accepted
  mail but the sender failed before recording `sent`.

### Switching from the v2 sender

Loom's refusal of v2 reads can't reach mail the v2 sender already queued. That
sender has no pre-send check, and before each read it sends every row in its
outbox. Until it stops, turning a pane off doesn't hold back what it queued
earlier. Switching is the user's step, in this order, and the v3 start enforces
the review:

1. Stop the v2 sender. Only that stops its queue.
2. Review its directory read-only with `review_outbox.py`. Rows not `sent` or
   `dead` are `held`: queued without the policy, so whether a mute covers them
   can't be established. They stay in that directory and no v3 bridge sends
   them; a resend is a separate reviewed step after checking the mailbox for
   the `eventId`.
3. Install the new Loom and start v3 with `--after-review` the old directory
   and its `reviewToken`. It refuses with `v2_sender_still_running` while the
   old runner lock is held, `v2_review_stale` when the outbox changed after the
   review, and `v2_state_required` for anything but a v2 directory, each before
   it reads Loom, asks for a credential or creates its directory. Then it
   continues the old cursor: later events are read with the policy, none
   before it again, so no muted history is replayed. It reports the held rows
   as `heldInV2Directory`.

Against the new Loom, a v2 sender still running keeps mailing allowed notices
and stops at the first answer holding a muted one (`loom_disconnected`,
retrying). Mail any sender's SMTP server accepted can't be recalled.

## The SMTP race

The pre-send check is the last point a mute can stop a notice. A message past it
is beyond reach. Between the check and the SMTP server's 250 after DATA, which
the bridge's 20-second SMTP timeout bounds, muting the pane changes nothing for
it. The end-to-end check below reproduces this on purpose: the check says yes,
the pane goes off, and the message is still sent once.
Once the server has accepted a message it cannot be recalled; Gmail delivers it
and Ash wakes. A message whose connection dropped after DATA is `uncertain`: it
may have been accepted, so it is held for review and never sent again
automatically. Muting stops every notice not yet past its check, never one
already in flight or accepted.

## Review 2026-10-03 15:52: fixes and evidence

| Finding | Fix | Evidence |
| --- | --- | --- |
| P1 bridge ignores the policy | Bridge v3 above; Loom refuses v2 over a muted notice | Bridge `PolicyTests` (8), the probe and v2 refusal tests, `test_loom_matrix` on the regenerated v3 matrix; task-check's policy block; the end-to-end check |
| P2 failed manual Enter | `manualEnter` returns its mark, `manualFailed`, `holdForEnter`, `replyAsPerson`, dictation | task-check "A person's Enter whose write failed": Claude failing at once, Claude and Codex failing after the agent reported, Codex succeeding |
| P2 policy replay | `readJournal` keeps every policy line, stable sort | `task.test.ts` same-number replay (4 checks); task-check's off-on-off before a restart |
| P2 OpenCode empty Enter | `Pane.typed` evidence, reset by Enter, Ctrl+C, Ctrl+U; `keys()` drops nameless Enters | task-check: an empty Enter then an unexplained run, an Enter that ran nothing then a loomctl turn, an empty Enter then a loomctl turn, a cleared input, a typed Enter still tracked |
| P2 notify validation | Validate all, then apply | task-check: seven refused commands, policy, journal and saved state unchanged; the end-to-end check |

## Review 2026-10-03 19:10: fixes and evidence

| Finding | Fix | Evidence |
| --- | --- | --- |
| P2 overlapping manual Enters | `holdSignals`: a hold per Enter, counted per pane, released once each; `holdForEnter`, `sendText` and `enterTask` all use it, so none can drop another's held reports | task-check "Overlapping Enters": Codex with the second Enter going in, then failing; the first going in while the second is out; reports for both turns arriving in the overlap; Claude's start in the overlap with the second failing; a pane exit during a held write |
| P2 typing evidence across a launch | `Pane.typed` is the launch that got the typing; `manualEnter` needs the current one | task-check "Typing evidence": a draft in one launch, a relaunch, an empty Enter then an unexplained run and then a loomctl turn making no task, typing in the new launch tracked on it |
| Deployment, old v2 queue | `--after-review` with a `reviewToken` replaces `--after N`; held v2 rows stay in their directory | Bridge entrypoint tests: continuing the cursor with the v2 database unchanged, a running v2 sender (a second process holding its lock), an outbox changed since review, a missing token, v1 or missing directories, and `--start-now` together with `--after-review` |

## Tests

- `src/task.test.ts`: precedence, the true-to-false rule, policy history kept
  and read back from the journal (every line, in order), sources, and matching
  an Enter to a report (134 checks).
- `scripts/task-check.mjs`, over Tauri mocks with fake agents (57 checks):
  - Ordinary send on Claude, Codex and OpenCode, with none for a shell or
    `--no-enter`.
  - The manual paths through the real terminal keyboard and the real Overview
    reply box, each provider, and an empty Enter or unexplained turn making no
    task.
  - A failed manual Enter, at once and after the agent's report, and
    OpenCode's empty Enter against unexplained and loomctl turns.
  - Two of a person's Enters out at once, each outcome on its own task, and
    typing evidence that doesn't outlive its launch.
  - A typed prompt overlapping a tracked submit, repeated idle reports, the same
    words in two turns, and fast completion.
  - Approval and failure of a manual turn, a relaunch's stale report, and a Loom
    restart.
  - The policy: default inheritance, a pane's own setting, kinds, queued
    notices of a muted pane, re-enabling without history, refused `notify`
    commands changing nothing, v2 refused over a muted notice, new panes and a
    restart, checked through a reference relay.
  - The 24-cell provider matrix, written as v3 for the bridge's fixture, with
    v2 equal to it minus the two fields while every pane is on.
- Bridge (`python scripts\validate_email_bridge.py`): 82 tests over temporary
  stores and the fake SMTP server `SMTPFixture`, which records every exchange.
- End to end (`bridge-live-check.py`, kept outside both repositories): the
  debug Loom on a temporary profile and its own pipe, a PowerShell pane making
  real finish and fail events from exit codes, the v3 bridge reading it through
  loomctl into a temporary store, and `AppPasswordSMTP` talking to
  `SMTPFixture`. Twelve checks: defaults, probe, all-on delivery, a queued
  notice muted before send, a muted notice kept out of the outbox, v2 refused
  (and the old v2 bridge code stopping without sending), re-enabling without
  history, v2 still served where nothing is muted, `--fail off`, refused
  `notify` commands, and the SMTP race.
- Mutation checks: each of 13 defects re-inserted one at a time (nine in Loom,
  four in the bridge) fails a test. Two had been missed by overlapping guards
  until a test only that guard could pass was added. After review 19:10, three
  more (a second Enter taking no hold of its own, the first release freeing
  every hold, typing from any launch counting) fail the new tests, and the five
  earlier cases whose code moved still fail theirs.

## Remaining limits

- The keyboard tests type into xterm in headless Chrome. They exercise the
  window's input path, not a person at a live Loom with real Claude, Codex or
  OpenCode panes; live provider runs remain to do.
- `Pane.typed` says something was typed, not that the input still holds it.
  Text typed and then erased with Backspace still counts, so an OpenCode Enter
  after that is noted, and could claim an unexplained run that follows.
- A person's OpenCode Enter that a loomctl Enter follows before OpenCode
  reports the run is dropped, so that run, if it was the person's, is no task.
- No mute stops a message past its pre-send check, nor one the SMTP server
  accepted. An `uncertain` row stays held for review.
- Until the v2 sender is stopped, mutes don't reach the rows it already
  queued: it sends them before its next read, with no policy check. Against
  the new Loom it stops reading at the first answer holding a muted notice and
  reports `loom_disconnected`. Stopping it, reviewing its outbox and starting
  v3 with `--after-review` is the user's step; its held rows stay unsent.
- `--after-review` takes the old runner lock only while it reads the old
  outbox. Starting the v2 sender again afterwards isn't prevented.
