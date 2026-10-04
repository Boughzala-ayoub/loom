# Review of startup turns and the v4 sender cutover through dee308f

Reviewed `e72f435..dee308f` on 2026-10-04: `2eb963e` (the review report), `91a80ed` (N1, buffer startup turns) and `dee308f` (N2, exclusive v3-to-v4 cutover in `docs/turn-tracking-and-notifications.md`). The findings answered are in [LOOM_OWNER_HOLDS_V4_SOL61_XHIGH_REVIEW_2026-10-04_123534.md](LOOM_OWNER_HOLDS_V4_SOL61_XHIGH_REVIEW_2026-10-04_123534.md). Loom locations are at `dee308f`. Bridge locations are in `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`, read only.

N1 is closed for both scenarios it reported. N2 is closed as a written plan, with one wording correction about which sender is deployed. I found three more problems. Two are in the startup path that N1 touched. The third is older, but it breaks the v3 bridge on journal numbering.

| # | Severity | Summary | Introduced here |
| --- | --- | --- | --- |
| F1 | P2 | Startup turns are numbered before this run's policy snapshot, so a pane that is "on" under a global "off" loses their notices | No, but N1's fix leaves it |
| F2 | P2 | A failed submit reservation leaves a hole in event numbers; the v3 bridge exits and has no way to recover | No, older |
| F3 | P3 | Replay puts buffered startup reports behind reports held for an Enter in flight; an earlier turn is lost | Yes, `91a80ed` |

## N1: closed

The fix makes every path that allocates a number during startup wait for replay. `turnTask`, `enterTurn`, `manualFailed`, `moveTask` and `taskSignal` push closures onto `startupTurns` (`src/main.ts:3679`), and `reserveTask` refuses through `requireJournal()` (`src/main.ts:3773`). `loadTasks` now sets `taskSeq = writtenSeq = got.seq` from the journal alone (`src/main.ts:4315`) and replays the buffer after that (`src/main.ts:4317`, `4332`). The catch path replays too (`src/main.ts:4306`), so an unreadable journal keeps the turns in memory, unsaved and invisible to watch.

Both reported scenarios behave correctly now:

- Existing history. Startup events get numbers above `got.seq`, so the existing-history scenario returns unique numbers from watch and from the rewritten journal.
- Empty journal, failed first write. `writtenSeq` stays 0 until a write lands, so watch returns `events: [], last: 0, next: 0` while the write is held and after it fails.

I ran the four committed cases (`TASK_REVIEW=startup-turns`: existing, empty, failed-enter, unreadable) against the served bundle, and all four passed.

One side effect is harmless. The restart moves at `src/main.ts:4329` now run inside the buffer, after the startup turns, because `startupTurns` is still set when that loop runs. Pane ids are new each start (`Pane.id = uid()`, `src/main.ts:1457`), so a buffered report can't route to a loaded task. The first journal write runs after `finishTaskReplay()` as a whole rewrite, so its snapshot holds both sets of events.

## N2: closed as a plan

I checked each claim in the new cutover section against the bridge code:

- A v3 `Store` takes the directory lock and then refuses any `native_source` other than `loom-durable-events-v3` (`email_bridge/bridge.py:154-166`). A v4 marker, or a retirement marker on a moved-away source, does stop an accidental v3 start, as the doc says.
- The `Store` constructor rewrites `sending` rows to `uncertain` (`email_bridge/bridge.py:198`). The doc is right that a snapshot must not go through it.
- `runner.lock` is a byte lock on a file in each state directory (`adapter/bridge.py:645-667`). It can't stop a sender on another directory, which is why the doc adds a namespace lock.
- `--after-review` accepts only v2 state (`scripts/run_email_foreground.py:16-30`).
- The settings, tables, outbox columns and outbox states the doc says to preserve match `email_bridge/bridge.py:168-196`. All seven outbox states have a mapping, `sending` goes to uncertain, and old `held` rows stay review-only.

The procedure covers each part of the N2 fix. It stops and locks v3 before the snapshot, prefers an in-place transaction, and keys a lock to the namespace. A move must retire the source before the destination is activated. The doc also gives rollback rules for before and after activation and lists the tests the future tool must pass. No code enforces any of this yet, and the doc says so (`docs/turn-tracking-and-notifications.md:197-201`). That's fine while no v4 bridge exists.

One correction. The deployed sender is v2 code, not v3. PID 180064 runs `run_email_foreground.py --state-dir .\email-production-v2` and started 2026-10-03 16:01. `email_bridge/bridge.py` was rewritten to v3 at 18:40 that day, and a running Python process keeps the code it loaded. The doc's own line 127 says the same. Line 201 ("continue using the unchanged v3 sender") and step 1 ("the sole authoritative v3 state directory", line 211) describe a deployment that doesn't exist yet. Suggested wording: "This cutover starts from a v3 directory made by the v2 switch below. Until that switch, the deployed sender is v2."

The dual-directory risk from N2 doesn't carry over to that v2-to-v3 switch. The code on disk now refuses v2 state, so re-running the old command line can't bring back a v2 sender. Only a saved copy of the old code could.

## Findings

### F1. [P2] Startup turns are numbered before this run's policy snapshot

Location: `src/main.ts:4332` numbers the buffered turns, and `src/main.ts:8796` records this run's first snapshot only after `loadTasks` returns. Related code is the migration-only snapshot at `src/main.ts:4324-4328` and the in-force lookup at `src/task.ts:384-387`.

Pane ids change every start. The previous run's last snapshot keys each pane's own setting by the old ids. On a normal restart the journal already has `owners`, so `loadTasks` records no snapshot. `finishTaskReplay()` gives the startup turns numbers `got.seq + 1` and up. Only after that does `main()` call `recordNotify()`, which writes a snapshot that maps this run's ids, at the new `taskSeq`.

For a startup event, `notifyDisposition` treats the previous run's snapshot as the one in force. The new pane id isn't in that snapshot, so the global `on` decides. A later snapshot can only turn the answer from true to false. A pane set "on" while every pane is "off" therefore gets its startup notices muted for good.

The reverse case, a pane set "off" while the global setting is "on", comes out right, because the later snapshot mutes it. The comments at `src/main.ts:2570` and `8796` state the rule this breaks: a pane's own setting is recorded "before it can have a task".

Failing scenario, reproduced on the served bundle with a scratch copy of `scripts/task-check.mjs`:

1. `notify --all off`, then `notify work:2 on` for the Codex pane. Loom saves both.
2. Restart with the journal read held. Type a prompt into the Codex pane, press Enter, and let Codex report the turn's end.
3. Release the read.

Result: the startup turn's completion (seq 3) gives `notify --check` false, `--policy-v4` `muted`, and `watch --metadata --policy` `notify: false`. The next turn on the same pane (seq 6) gives true and `send`. `notify` shows the pane as `on`, with finish, fail and blocked all true. The v3 bridge files a `notify: false` outcome in its `muted` table at ingest and never queues it (`email_bridge/bridge.py:289-293`).

The window is the startup read. The previous review accepted that window for N1.

Fix: record the snapshot inside `loadTasks`, before `finishTaskReplay()`, on every path that sets `journalLoaded`. Make the call at `src/main.ts:4327` unconditional, right after `journalLoaded = true`. `recordNotify` is synchronous up to `notifyHistory.push`, so the snapshot's `at` is `got.seq`. Add the same call before `finishTaskReplay()` in the empty-journal branch at `src/main.ts:4317`. It changes no outcome there, but it keeps one rule. The call at `src/main.ts:8796` then finds an equal snapshot and does nothing, so it can go. Test: add the scenario above as a task-check review case that expects `send` for the startup completion.

I also checked the decision itself against the committed `notifyDisposition`. With the snapshot recorded at `at: 5`, after the event, the answer is `muted`. With it recorded at `at: 3`, before the event, the answer is `send`.

### F2. [P2, older than this range] A failed reservation leaves a hole that stops the v3 bridge

Location: `src/main.ts:3774-3781` (`reserveTask`). On the bridge side: `email_bridge/bridge.py:249-253` (contiguity check), `508-510` (`Runtime.run` re-raises) and `303-306` (gap recovery).

`reserveTask` takes `++taskSeq` for the accepted event. If the journal write fails, it deletes the task, so that number never gets an event. The next whole rewrite writes a header `seq` past it, so the hole outlives a restart.

Watch returns the events on both sides of the hole with `gap: false`. The bridge requires every number from its cursor up to `next`, so it raises `native_sequence_missing`. That error isn't `loom_disconnected`, so `Runtime.run` re-raises and the foreground sender exits. On restart it reads the same batch and exits again. `acknowledge_gap` only works when `halt` is `native_journal_gap`, and this path never sets it.

Failing scenario, reproduced on the served bundle:

1. A submit completes, producing events 1 to 4.
2. The next submit's reservation write fails (`qa.journalFail`, standing in for a full disk or a sync tool holding the file). Loom refuses it with "couldn't record the task in its journal ... so it typed nothing", and number 5 is gone.
3. Another submit completes, producing events 6 to 9.
4. `watch --after 0 --metadata --policy` returns seqs `[1,2,3,4,6,7,8,9]`, `last: 9`, `gap: false`.
5. I fed the same shape from cursor 4 to the real bridge `Store` and `Runtime` with a fake source and sender. It raised `native_sequence_missing` with the cursor still at 4 and `halt` empty, and `acknowledge_gap(9, explicit=True)` refused with `gap_recovery_requires_review`.

No mail goes out from then on. That lasts until 500 later tasks settle, the tasks around the hole are pruned, and watch finally reports a gap, which the bridge does know how to halt on.

Fix, in Loom, so the v3 contract stays as it is: on a failed reservation, keep the task instead of deleting it. Set `key: null` so a `--key` retry types again. Push its accepted event and a final `cancelled` event with reason `not-recorded`, and leave the id in `unsaved`. `journal()` has already set `journalDirty`, so the next successful write is a whole rewrite that carries both events. Neither state is a notice kind, so no mail results.

The other option is a bridge change: accept missing numbers at or below `last` when `gap` is false. That needs Loom to promise in the contract that a number can go unused, and it weakens the bridge's check for lost events. Test: the scenario above as a task-check case asserting contiguous numbers after a refused submit.

### F3. [P3] Replay puts buffered reports behind reports held for an Enter in flight

Location: `src/main.ts:3680-3684` (`finishTaskReplay`) and `src/main.ts:4145-4150`. `taskSignal` checks `enterHeld` before `startupTurns`.

A report that arrives during startup waits in `startupTurns`. A report that arrives while a person's Enter is being written waits in that pane's `enterHeld` list. Suppose the read finishes while such a write is still out. Replay calls `taskSignal` for the older report, finds the pane held, and appends it behind the newer held reports. When the hold releases, the reports route newest first. This interleaving couldn't happen before `91a80ed`.

Failing scenario. I extracted the committed functions from `dee308f` (`finishTaskReplay`, `moveTask`, `holdSignals`, `turnTask`, `enterTurn`, `adoptManual`, `taskSignal`) and ran them with Node against the real `task.ts`, using a Claude pane with the read pending:

1. The person's Enter for prompt A is noted. Claude's start for A and then its Stop arrive with no hold, so both are buffered.
2. The person's Enter for prompt B is noted, and its write is still out, so the pane is held. B's start arrives and is held.
3. The read completes, then B's write lands.

Result: only B is a task. It is `working`, and A's Stop has set its `stopAt` along with A's response. A never becomes a task. `claimManual` matches B's start to B's note, and `adoptManual` drops every older note with `p.manual.slice(i + 1)` (`src/main.ts:4019`), so A's start finds nothing to adopt.

Control: with the write landing before the read completes, A is tracked with its Stop and B is working without one. Impact: A's completion notice is never produced. B could also complete with A's response if Claude looks idle between B's start and its working line.

The rating is P3 because replay has to land inside a terminal write, which normally takes milliseconds.

Fix, verified in the same harness (A and B then come out as in the control):

```ts
function finishTaskReplay() {
  const pending = startupTurns;
  startupTurns = undefined;
  // Reports held for an Enter in flight came after every buffered one.
  const later = [...enterHeld.values()].map((h) => [h, h.signals.splice(0)] as const);
  pending?.forEach((run) => run());
  for (const [h, s] of later) h.signals.push(...s);
}
```

This is safe because no replayed closure creates or releases a hold. Test: a task-check case that holds the manual Enter's write (`qa.holdWriteIf`) while it releases the startup read, then checks that both turns become tasks.

## Other notes

- If `readJournal` throws, `loadTasks` rejects before `finishTaskReplay()`, and every later turn and report is buffered for the rest of the session. That needs a task line whose `events` isn't iterable, which Loom never writes. The CLI is already dead in that case, because `installCli()` never runs. A `try/finally` around the replay part of `loadTasks` would cover it.
- The v3 shapes are unchanged in this range. `watch --metadata --policy` and `notify --check` still give the nine fields and booleans the bridge parser accepts. `91a80ed` changes when numbers are allocated, not what the answers look like.

## How this was checked

- `scripts/task-check.mjs` with `TASK_REVIEW=startup-turns` against the existing `dist` bundle, served by `vite preview` on port 4391 after a 200 check. `dist` was built at 13:17 today, after `dee308f`, and `src` matches HEAD. All four cases passed.
- A scratch copy of task-check, with two added cases (`startup-policy`, `reserve-hole`), against the same served bundle. These produced the F1 and F2 numbers above.
- A Node harness built from the committed `main.ts` functions for F3, run three ways: as committed, with the control order, and with the fix.
- `notifyDisposition` from the committed `task.ts` for the F1 decision.
- The bridge's real `Store`, `Runtime` and `batch` code with `python -B`, in scratch directories with a fake source and sender. I didn't open the production database, connect to SMTP or touch credentials.
- Not run: the full task-check, ui-check, cargo tests and the unit suites. `task.ts` doesn't change in this range.

## Preservation

HEAD is still `dee308f`, and `git status` matches the start of the session, including the earlier `src-tauri/Cargo.toml` modification. Nothing was built, staged or committed. This report is the only file written in the repo. The scratch scripts and logs are in the session scratchpad. I listed the bridge's `email-production-v2` directory for file times but didn't open its database. I briefly wrote a copy of `main.ts` to `/tmp` by mistake and deleted it. The preview server was stopped after the runs.
