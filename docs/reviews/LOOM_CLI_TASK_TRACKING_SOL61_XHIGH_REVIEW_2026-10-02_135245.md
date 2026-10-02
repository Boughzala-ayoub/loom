# Loom CLI task tracking review

Saved: 2026-10-02T13:52:45.766Z UTC.

No findings.

The remaining P1 from `LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_120244.md` is fixed in the independently checked orderings. An older Claude task no longer completes from an obsolete Stop while its failure or approval report waits behind another task's Enter. The earlier pending-write fix also remains intact. I found no new actionable regression introduced by the latest changes.

## Scope and source

Checkout: `C:\Users\ayoub\loom\loom\cli-task-tracking`.

Capture: `2026-10-02T13:32:55.798Z`. Branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. The initial state had 11 modified tracked files, four untracked implementation/test files, eight untracked review reports and no staged changes.

Reference report: `docs/reviews/LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_120244.md`, 15,230 bytes, SHA-256 `ea0f06ebbf048bbae80ba1d89fe92e10b481cbf236799358a21968c4d1de0dbf`.

Isolated source and evidence: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T133253Z`.

I inspected the complete changes since the preceding captured review and the surrounding event, write, task-routing, sweep and journal paths. Four files changed since that capture: `src/main.ts`, `scripts/task-check.mjs`, `docs/cli-control.md` and `docs/loomctl.md`. `fixes.diff` records that comparison; `working.diff` records the current working diff against HEAD. The task-routing implementation and native helper/journal code match the preceding capture byte for byte and were rechecked with the tests below.

I read `C:\Users\ayoub\AGENTS.md`, the local `review-agent\SKILL.md`, and the required `unslop\SKILL.md`. No additional AGENTS.md or local .agents/.codex instructions were found along the target path or in the checked project tree, excluding Git, dependency and generated trees.

Requested review lane: Sol6.1 Extra High. Available tools do not expose independent runtime-model or reasoning-setting attestation. This report records the review work and does not certify those settings.

## Previous P1 disposition

The fix is at `src/main.ts:3792-3795`. Before reading pane state, interrupt state, idle time or a Stop candidate, `sweepTasks` now skips every task whose pane has an `enterHeld` buffer. It also clears `quietSince`, so the idle period observed before the hold cannot expire immediately after release. `releaseSignals` at `src/main.ts:3721-3724` removes the buffer and synchronously replays its signals before the next sweep can judge the pane.

That closes the reported race. Previously, `taskSignal` held the decisive failure/approval report, but the sweep still completed an older task from its Stop. Final-task immutability then discarded the held report. In the current code, the older task remains working during the hold. Failure or approval is applied before any sweep-based outcome can become final.

I ran the original two defect cases against a copy of the preceding production build. Both still reproduce the false completed outcome in memory, journal, reload and keyed replay. This confirms the comparison still detects the old defect. I then tested the current production build with both failed and successfully delivered held Enter writes.

| Older Claude report | Newer Enter result | During hold | After release | After reload/key replay |
| --- | --- | --- | --- | --- |
| Failure | Rejected before delivery | working | failed | failed |
| Failure | Delivered successfully | working | failed | failed |
| Approval | Rejected before delivery | working | approval | unknown |
| Approval | Delivered successfully | working | working, with approval/resume recorded | unknown |

No completed event is recorded in any of those current cases. An approval task is open, so reload correctly makes its outcome unknown. In the successful Enter case, Pane.wrote records the Enter as a resume after the held approval; the old Stop has already been invalidated. The independent successful-write cases actually pass the held Enter through the fake native handler before resolving its reply, rather than merely resolving an unexecuted write promise.

Safe reproduction and comparison files are `review-sweep-recheck.mjs`, `review-sweep-recheck.json`, `review-sweep-recheck.log`, `review-previous-buffer-defect.mjs` and `review-previous-buffer-defect.json`. All run against copied builds with Tauri mocks, not live panes.

## Lifecycle and evidence checks

| Checked ordering or invariant | Observed result |
| --- | --- |
| Older failure arrives during the hold, then the pane exits | The older task stays working while held. On release it fails with its reported `overloaded` detail and no pane-exit reason. The report wins and is persisted. |
| Codex failure then matching completion, or matching completion then failure, during a hold | Ordered replay preserves the first terminal outcome: failed in the first case, completed in the second. Each survives journal, reload and keyed replay. |
| Held approval, resume and failure for Claude and Codex | Replay records approval, working, failed in order. The task remains working during the hold and the final failure persists through reload and replay. |
| Claude approval followed by another Stop while asking | The earlier Stop is invalidated, the Stop while asking does not complete it, and resume leaves it working. A fresh Stop is required for completion. |
| Quiet time across a hold | A controlled-clock case advances 28 seconds of idle time, holds Enter for a 60-second clock advance, then advances 28 seconds after release. The older task remains working and its later failure report decides it. The pre-hold idle time does not carry over. |
| Restart while an old report is held | The old failure is retained. After release it decides the old task. A stale launch's matching report leaves the new task open; only the new launch's report completes it. |
| Earlier same-text turn during a task's pending paste or Enter | Claude and Codex remain accepted during the pending write. Failed Enter ends unknown with submit uncertainty; failed paste ends failed with type uncertainty. Journal, reload and keyed replay preserve the outcome without typing again. |
| Delivered Enter with a failed/lost reply | Claude, Codex and OpenCode retain submit uncertainty even when their end reports arrive before the failed native reply. These tasks end unknown. Ordinary delivered submissions still complete. |
| Two queued Codex sends | The second does not paste during the first Enter hold. Reports are released in order, prompts remain separate, both successful outcomes persist and both keys replay without typing. |
| Concurrent window input during a failed Enter | The manual input is counted and cannot prove the tracked Enter arrived. The task retains submit uncertainty and ends unknown. |
| Earlier prompt's delayed start, including the actual native Claude helper | Its late timestamp cannot clear failed-Enter uncertainty. Unknown persists, late reports cannot reopen the final task, and replay types nothing. |
| Journal failure while held reports are released | The unknown task is marked unsaved. Watch exposes only the durable accepted event. A later successful whole rewrite recovers unknown and submit uncertainty; reload/replay preserve them. |
| Existing journal and watch fixes | Reservation survives recovery rewrite. Native lossy read retains keys before a torn UTF-8 tail. An unreadable journal refuses submit untouched. Queued updates do not undo a whole snapshot. More than 1000 unwritten events do not expose a cursor reused after restart. |
| Failed answers | `answerInDoubt` persists. A delivered answer clears that flag while retaining uncertainty about the task's own Enter. Combined doubts survive failed writes, recovery and reload. |
| Input and receipt protections | Queued writers after the last revision guard hold Enter. U+00A0 input detection, stale revisions, draft/suggestion checks, missing echo, generation guards and failed-write receipt digest/progress/uncertainty all pass. A later receipt turn acknowledges activity without proving the uncertain Enter arrived. |
| Ignored-file protection | Exact current functions with mocked Git retain `--ignored=matching`, explicit ignored-loss requirements, plan invalidation and refusal on unreadable inventory. A changed ignored inventory retains the fake worktree and branch. No real deletion was attempted. |

The 12 new lifecycle cases are in `review-sweep-recheck.json`. The preceding independent regression runners were also rerun against this fresh build, producing another 30 passing cases. Existing runner names sometimes describe the historical defect; their assertions and structured outcomes show the current fixed behavior.

## Tests and build

| Check | Result |
| --- | --- |
| CLI unit checks | 64 passed |
| Prompt/input unit checks | 53 passed |
| Git parsing/loss-inventory unit checks | 46 passed |
| Task unit checks | 99 passed |
| Total unit checks | 262 passed |
| OpenCode plugin checks | Both fixture variants passed |
| TypeScript `tsc --noEmit` | Passed |
| Production Vite build | Passed, with the standard large-chunk warning |
| Full current `scripts/task-check.mjs` | 38 passed, including real-time quiet cases and the supplied native helper |
| Independent task/browser cases | 42 passed against the current build |
| Prior-build defect comparison | Both original variants reproduced against the preceding build |
| Exact-function input/receipt/deletion checks | 33 passed |
| Focused native Rust checks | 19 passed: 11 loomctl, five selected helper checks, two drain/config checks, one journal-reader check |

Each build and test output went to the isolated review directory. Existing Node dependencies were copied; the Rust tests used the installed compiler and an existing serde_json artifact. No dependencies were installed. The frontend checks serve the freshly built bundle. The native delayed-start case runs the captured Claude hook, and the torn-journal case runs the captured native reader.

Structured results and logs include `*-result.json`, `*.log`, `native-results.json`, `review-sweep-recheck.json`, `review-pending-enter-fixed.json`, `review-buffer-adjacent.json`, `review-outcome-matrix.json`, `review-prior-fixes.json`, `review-native-earlier-start.json` and `review-cli-controls.json`.

## Execution issues and limits

Default process creation rejected an attempted additional check with `CreateProcessWithLogonW failed: 1909`. That attempt ran no new checks. The already running checks finished, a read-only availability probe succeeded through the approved execution path, and all remaining checks then completed through that path. No credentials, trust configuration or security settings were changed.

The initial added Codex restart fixture was refused because it supplied no resumable session. Adding only a session id was insufficient because a fresh launch clears it. I corrected the reviewer-owned fixture to restore a fake session with both its sid and session id, verified the restart case alone, then completed all 12 lifecycle cases. This fixture refusal is not a regression in the reviewed change.

No checks remain blocked. These limits remain:

- No live Loom instance, pane command, provider session or named-pipe request was used. Mocked writes prove the checked orderings, not their frequency in real sessions.
- The idle-time reset case uses a controlled browser clock. The repository browser suite separately runs its real-time 30-second quiet cases.
- Full Cargo/Tauri build, packaging, native window integration, pipe ACL/transport tests and `scripts/task-live-check.mjs` were not run. The 19 native checks cover the named source paths, not the full Rust suite.
- Full `scripts/ui-check.mjs`, screenshots and responsive audits were not run. The previous scroll-test precondition remains outside this report's verification.
- A native write that never returns leaves the pane's tasks open while reports and sweeping are held. The current code and documentation acknowledge that behavior. Restarting Loom restores open tasks as unknown. No deadline was implemented or live blocked writer tested.
- The initial sandbox Git read warned about access to the global ignore file. Read-only post-checks through the working execution path produced identical status and diffs without changing that file or Git configuration.
- Preservation hashes cover tracked and untracked nonignored project files and the captured Git metadata. Ignored dependency/build trees were read for copying or compilation artifacts, not given a complete before/after hash inventory.

## Preservation and readback

Before the report save, all 143 captured pre-existing project files, including all 17 prior reports, matched their original SHA-256 hashes. All 13 captured Git metadata files matched, including index, HEAD, refs, packed refs and repository configuration. Branch, HEAD, working diff and staged diff were unchanged, and no project files had been added.

The report is saved with exclusive creation under a fresh timestamp. The save procedure repeats preservation checks before and after, reads the report back as strict UTF-8 without a BOM, compares its hash with the isolated evidence copy, and requires the sole project/status addition to be this report. `saved-report.json` and `report-verification.json` record its exact path, size, hash and preservation results. Earlier reports are not overwritten.

Both reviewer-owned Node preview processes were stopped after verifying their PID, executable and script identity. Both localhost ports then refused connections. `preview-cleanup.json` and `preview-port-cleanup.json` record this. The native helper's temporary review event file was cleaned. No live Loom process was stopped, and no source fixes, commits, merges, installs, Claude dispatch or notification implementation were performed.
