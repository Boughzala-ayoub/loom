# Loom CLI task tracking fix verification

Saved: 2026-10-02T03:02:07.036Z

Two P1 completion defects remain, and the latest fixes introduce two P2 persistence/replay defects. Three of the five findings in the preceding report are fixed in their demonstrated paths. The repeated-prompt and blocked-Stop findings are partially fixed.

## Findings

### 1. [P1] Keep later untracked turns from completing an undelivered task

Location: `src/task.ts:152-155`. Related: `src/task.ts:128`, `src/task.ts:135`.

Prioritizing tasks whose Enter succeeded fixes the original two-task example, but the router still falls back to the task whose Enter is in doubt once the delivered task becomes final. A later identical prompt sent through `send` or typed in the window has no task record, so its completion finalizes the earlier undelivered task. The new turn ID prevents replay of the same notification, but does not identify which submission produced a fresh turn. Retaining `uncertain: "submit"` records the uncertainty while still returning a false final `completed` outcome. The previous repeated-prompt finding therefore remains partially fixed.

Independent reproduction against the actual built bundle and fake Codex pane:

1. Reject A's Enter for `same again`, leaving A `submitted` with `uncertain: "submit"`. The fake provider received no prompt from A.
2. Clear that draft and submit the same text as B under another key. Deliver B's completion. B now correctly completes and A stays open, confirming the exact previous case is fixed.
3. Send the same text through the ordinary `send` command, without creating task C.
4. Deliver C's completion with a fresh turn ID and the same prompt hash. A becomes final `completed`, although its Enter never arrived.

Observed A was `fa74e5df94f648b3`. The hash can identify text but cannot distinguish this later occurrence from A. Preserve an ambiguous outcome unless the report identifies A's delivered occurrence. Evidence: `review-fix-browser.json`, case `F3 delivered repeated prompt wins over failed Enter`.

### 2. [P1] Require an idle input before confirming a blocked Stop

Location: `src/main.ts:3778-3779`. Related: `src/main.ts:3696-3699`, `src-tauri/src/helper.rs:220-224`.

Reported approvals now clear the pending Stop, and numbered menus delay completion. The screen check still accepts an unnumbered permission dialog as idle when its approval report has not arrived or was lost. `readMenu()` returns null for that dialog and the interrupt hint is absent, so an old blocked Stop completes a `working` task while the user is still being asked for permission. Provider-file writes and renames are best effort, so absence of an approval event is not proof that no permission is pending. This remains a branch of the previous blocked-Stop finding.

Independent reproduction:

1. Submit `unreported dialog`; deliver its prompt start and a Stop candidate.
2. Keep the pane visibly busy for 800 ms, representing work continued after another Stop hook blocked the stop.
3. Show the current fixture's unnumbered `Allow Bash(ls)?` dialog with `Enter to allow` and `Esc to deny`, no interrupt hint, and no approval report yet.
4. Deliver no new Stop. The task becomes `completed` on the next sweep, and `wait --task` returns `completed` while the dialog remains visible.

The same test first confirmed that a reported approval remains `approval`, an answer resumes `working`, and a new Stop is needed to complete it. Positive evidence of an idle agent input is needed for the screen-only fallback. Evidence: `review-fix-browser.json`, case `F4 reported approvals invalidate Stop; unreported unnumbered dialogs still complete`. The dialog and missing report were simulated; no live Claude pane was used.

### 3. [P2] Prevent queued field updates from undoing a whole-journal snapshot

Location: `src/task.ts:248-249`. Related: `src/main.ts:3617-3619`, `src/main.ts:3666`.

The new `{update, set}` records are applied unconditionally during replay. A recovery rewrite snapshots the current tasks, including state events whose append operations are still queued. Later queued update records can then overwrite that newer snapshot with older fields and an older state. Subsequent queued state events are ignored because their sequence numbers already exist in the snapshot. In the reproduced case, the task is `failed` and `saved: true` in memory, but the journal reads it as `working`; restart changes it to `unknown` and loses the known provider failure. This is a new defect in the same-state persistence fix.

Independent reproduction:

1. Submit two Claude prompts, initially keeping the fake agent idle so both reservations and submitted events persist.
2. Reject journal writes, show the agent busy, and let the sweep mark both tasks `working` with `correlation: "screen"`. Both writes fail, leaving tasks unsaved.
3. Restore journal writes and deliver one event-file batch containing prompt starts for A and B, then StopFailure. Each start upgrades a task's correlation without changing its state, and the failure finalizes both.
4. The first queued write takes a whole snapshot with both failed tasks. B's older queued update then restores B's working fields; its already-snapshotted failure event is skipped on replay.

Observed B `fc5d0c18f5c1464e` was `failed`, `saved: true` in memory; `working` after `readJournal()`; and `unknown`, reason `loom-restarted`, after reload. The native drain emits batches and the real event listener processes them synchronously, so this does not require modifying implementation functions. Order updates against the snapshot or discard updates already covered by it. Evidence: `review-fix-browser.json`, case `Recovery whole snapshot is undone by a later queued same-state update`.

### 4. [P2] Make restart numbering safe for more than 1000 unwritten events

Location: `src/main.ts:3815-3816`. Related: `src/main.ts:7444-7446`.

Adding a fixed 1000 to the persisted counter does not ensure that a watcher never sees an event number reused. Task state changes are exposed before journal writes finish, and the queue has no 1000-event bound. If 1001 events were observed while a journal write was stalled, the restart event can reuse the watcher's last number. `watch --after` then returns no event and `gap: false`, hiding the task's transition to `unknown`. The documentation's guarantee that numbers are never reused is stronger than this implementation. This is a new defect in the restart-numbering change.

Independent reproduction using delivered keyboard answers, rather than only injected resume reports:

1. Persist one working task through event 3, then hold the next journal write.
2. Deliver an approval report, followed by 500 actual mocked `keys ... enter` writes, each followed by another approval report. The task produces 1001 state changes, which `watch` observes through cursor 1004, while the journal stays at 3.
3. Reload. Startup uses `3 + 1000`, then numbers the restart event 1004.
4. `watch --after 1004` returns `events: []`, `last: 1004`, `gap: false`, although the task has become `unknown` for `loom-restarted`.

Use a durable numbering reservation or an explicit restart/reset scheme that can identify the gap; a guessed offset does not cover an unbounded queue. Evidence: `review-watch-backlog.json`, `review-watch-backlog.mjs`. The shorter injected-report reproduction in `review-fix-browser.json` reaches the same result.

## Disposition of the five findings in the preceding report

The source was compared directly with [the 02:06:25 follow-up report](LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_FOLLOWUP_REVIEW_2026-10-02_020625.md). Its SHA-256 is unchanged at `b0bbae1220b69c7be52bf7db45c10143eecf20a8acd9e18d661ec257ac617b0a`.

| Prior finding | Disposition | Verified behavior |
| --- | --- | --- |
| 1 P1, reservation omitted by recovery rewrites | Fixed | The rewrite now includes its pending reservation line. A failed earlier write triggers a rewrite containing the new task and key; reload retains the task and an identical retry types nothing. Recovery and compaction use the same serializer, though the independent reservation reproduction specifically triggered recovery. |
| 2 P1, torn UTF-8 tail discards valid history | Fixed; new numbering defect above | The actual extracted native reader returns the valid prefix and a replacement character for the damaged final byte. Tasks and keys survive; the tested small torn-tail case resumes above the old event number. Non-NotFound read errors now stop submit and leave the journal untouched. The separate 1000-event bound is unsound, finding 4. |
| 3 P1, repeated prompt completes a failed Enter | Partially fixed | B's confirmed Enter is preferred over A's failed Enter, and A keeps `uncertain: "submit"`. A later untracked occurrence still completes A, finding 1. Claude starts use the same preference rule. |
| 4 P1, blocked Stop completes unanswered approval | Partially fixed | A reported approval clears the old Stop; a Stop while already asking is ignored; numbered screen questions delay completion. An unreported unnumbered dialog still completes from the old candidate, finding 2. |
| 5 P2, failed-answer uncertainty exists only in memory | Fixed in the original path; new replay defect above | A failed answer now writes an update with `uncertain: "answer"`; reload retains it. A delivered answer clears the field and persists null. Whole-snapshot replay can be undone by queued updates, finding 3. |

## Recheck of the six earlier fixed issues

These numbers refer to the original [00:57:26 task-tracking review](LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_005726.md). Its six fixed paths remain covered by current source inspection and rerun tests.

| Earlier issue | Current result |
| --- | --- |
| F2, launch correlation | Passed. Native spawn supplies launch; reports require it; generation filtering and late-report browser cases remain passing. |
| F5, Claude start/Stop ordering | Passed. UserPromptSubmit is synchronous; the exact configuration and native drain tests pass. Stop and StopFailure remain async. |
| F6, prune watermark | Passed. Both counters persist; 501 settled tasks retain `gap: true` through rewrites and two reloads. The new numbering issue above is separate from the retained prune watermark. |
| F7, delivered approval answers | Passed. Rejected Enter and navigation preserve approval; successful Enter resumes. The new persistence checks also confirm the answer-uncertainty field is written and cleared. |
| F8, multiple pending OpenCode approvals | Passed. The actual plugin sends no resume after the first of two replies; the final reply resumes. Both existing provider-version suites pass. |
| F9, JSON-line follow errors | Passed. Timeout and fatal lines parse independently with numeric `next`. The actual CLI reconnect test requests cursors 0, 1, 1 and prints events 1 and 2 once each. |

## Scope and evidence

Target: `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. Capture completed at `2026-10-02T02:44:26.554Z`. Nothing was staged. The full diff against HEAD and the delta from the previous captured source were inspected. The latest fix delta affects seven non-report files: two documentation files, the task browser test, native journal reading, frontend task persistence/sweep logic, task tests, and task routing/replay.

Requested review lane: Sol6.1 Extra High. Runtime model selectors are not exposed to this reviewer. Current applicable instructions were read from `C:\Users\ayoub\AGENTS.md`, the review-agent skill, Unslop and Ponytail. No additional AGENTS.md was found in the checked ancestors or source-worktree paths. The user authorized a new report and excluded source fixes. The review-agent skill excludes delegation.

All test outputs were created in this isolated, review-owned directory:

`C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T024424Z`

| Check | Result | Evidence in that directory |
| --- | --- | --- |
| CLI unit checks | 64 passed | `cli.log`, `cli-result.json` |
| Prompt checks | 53 passed, including U+00A0 cases | `prompt.log`, `prompt-result.json` |
| Git parser checks | 46 passed | `gitparse.log`, `gitparse-result.json` |
| Task rules and journal checks | 78 passed | `task.log`, `task-result.json` |
| Existing OpenCode plugin checks | Both provider versions passed | `plugin.log`, `plugin-result.json` |
| TypeScript and production frontend build | `tsc --noEmit` passed; Vite built 34 modules with the existing chunk-size advisory | `typecheck-result.json`, `build.log` |
| Existing task browser suite | All 23 checks passed; full 30-second idle cases enabled | `taskbrowser.log`, `taskbrowser-result.json` |
| Existing UI suite | 171 rendered states passed at 1280px; 80 writer trials gave 10 pre-paste refusals and 70 held Enters | `ui.log`, `ui-result.json` |
| Independent built-page fix and failure cases | Seven scenarios completed, validating fixes and reproducing all four findings | `review-fix-browser.mjs`, `.json`, `.log` |
| Watch backlog with delivered answers | 500 successful mocked Enter writes confirmed the 1001-event collision | `review-watch-backlog.mjs`, `.json`, `.log` |
| Exact native CLI source and pipe tests | 11 passed; isolated CLI executable compiled | `loomctl-native.log` |
| Exact helper plus real extracted root lookup | Five focused provider tests passed | `helper-native.log`, `review-helper.rs` |
| Exact native event drain/config tests | Two passed | `drain-native.log`, `review-drain.rs` |
| Exact native journal reader and its test | Passed damaged-tail, missing-file and directory-as-file cases | `journal-native.log`, `review-journal-read.rs` |
| CLI reconnect, timeout and fatal follow errors | Three fake-pipe cases passed | `review-follow.json`, `review-follow.log` |
| OpenCode pending approvals | Passed partial/final reply test with a review-only pane ID | `review-plugin-pending.json` |

The UI suite reran revision, generation, draft, numbered-menu, no-break-space and concurrent-writer safeguards; failed-write/failed-Enter receipt retention; unrelated receipt turns; and protected/ignored-file deletion-plan checks in mocks. The workspace and draft-reply screenshots were also visually inspected. No new actionable regression was found in those checked paths. No real file was deleted by the mocked deletion checks.

The native journal reader was extracted verbatim with its existing test. Its wrapper adds argv-based path selection and a JSON result envelope, then passes the measured lossy read into the built page's mocked native boundary. Helper tests use the real extracted root lookup and rollout walker, with no root-lookup stub. Existing serde_json artifacts were read from the original target directory; compilation outputs stayed in the isolated directory.

## Limits

No live Loom pane was controlled, and no real provider prompt was submitted. No source fix, commit, merge, installation, trust/security change, notification implementation or external message was made. Existing task/live-check scripts were inspected, but `scripts/task-live-check.mjs` and a full Cargo/Tauri application build were not run. The isolated Rust compiles and focused tests do not verify the whole native app build.

Browser checks use the actual copied production bundle with fake agents and native boundaries. Crashes are reloads with selected writes held. Missing approval reports, provider batches and storage failures were deliberately simulated. They establish the code's outcomes for those conditions; they do not measure live-provider event-loss rates. The large backlog check validates the absence of a queue bound, not the frequency of that backlog in normal operation. There was no real crash or power-loss test.

Git was accessed through explicit worktree/git-dir paths with optional locks disabled because normal discovery reports ownership ambiguity. Sandbox Git reads warn that the user's global ignore file is inaccessible. No trust or configuration repair was attempted. Preservation uses the captured inventory and identical Git commands; original ignored dependency/build artifacts were not writable test destinations.

## Preservation

Before saving, all 138 pre-existing tracked/untracked nonignored files, including all 12 earlier reports, matched their captured SHA-256 hashes. All 13 captured Git metadata files were unchanged, including index, branch/HEAD, refs and configuration. Working and staged diff hashes and porcelain status matched the capture. Evidence: `snapshot.json`, `pre-save-verification.json`.

Saving uses exclusive creation, UTF-8 without BOM, and a post-save verification that permits exactly this report as the only added source-worktree file. The final report hash and preservation checks are saved beside the evidence in `saved-report.json` and `report-verification.json`.

The review-only preview at `127.0.0.1:57747`, PID 151628, was identity-checked as Node running `serve-review.mjs`, stopped, and its port then refused connections. Fake pipes and review-specific provider marker/session files were cleaned up by their runners. Source, prior reports and Git state were retained.

Assessment: the original data-loss paths are improved, but the two false-completion branches still make final task outcomes unreliable in the reproduced cases. The new journal-update and watch-numbering defects also need correction before restart/replay behavior can support unattended task orchestration.
