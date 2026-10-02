# Loom CLI task tracking review

Saved: 2026-10-02T12:02:44.757Z (UTC).

Outcome: the pending-write P1 in `LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_105046.md` is fixed in the checked cases. One new P1 remains: buffering a new task's Enter reports can let an older Claude task complete from an obsolete Stop while its failure or approval report waits in the buffer. Both variants reproduce, persist, survive reload, and return through keyed replay.

## Scope and captured state

- Checkout: `C:\Users\ayoub\loom\loom\cli-task-tracking`.
- Capture: `2026-10-02T11:44:51.344Z`.
- Branch: `loom/cli-task-tracking`; HEAD: `1858588a4501bc80bd3ea4e1cd3865a15d556026`.
- Before this report: 11 modified tracked files, four untracked implementation/test files, seven untracked review reports, and no staged changes.
- Reference report: `docs/reviews/LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_105046.md`, SHA-256 `4c6755e71f2c56a780710e8419cbe1f931a5e991f154ed13cfba094bd74fbc33`.
- Evidence and isolated copy: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T114449Z`.

I inspected the current working changes against HEAD and compared source bytes with the preceding review capture. Since that capture, six files changed: `src/main.ts`, `src/task.ts`, `src/task.test.ts`, `scripts/task-check.mjs`, `docs/cli-control.md`, and `docs/loomctl.md`. The checks below use the newly captured source and its production build, not a running Loom instance.

I read the applicable `C:\Users\ayoub\AGENTS.md`, the local `review-agent\SKILL.md`, and the required `unslop\SKILL.md`. No additional AGENTS.md or local .agents/.codex instructions were found along the target path or within the checked project tree, excluding Git and generated/dependency trees. This is a report-only review. No source fixes, commits, merges, installs, live pane commands, Claude dispatch, trust/security changes, or notification implementation were performed.

Requested review lane: Sol6.1 Extra High. Available tools do not expose an independent runtime-model or reasoning-setting attestation; this report does not certify those settings.

## Findings

### 1. [P1] Keep an older task's Stop from winning while its decisive report is buffered

**Introduced location:** `src/main.ts:3727-3728`, the pane-wide early return in `taskSignal`. Related paths are `src/main.ts:3737-3741` (Stop tracking and approval invalidation), `src/main.ts:3822-3824` (idle Stop completion), `src/main.ts:3730` (final tasks excluded on replay), and `src/main.ts:3679-3680` (final task immutability).

Once a new task reaches Enter, `enterHeld` holds every signal for the pane, including reports for older tasks whose own Enter has already succeeded. `sweepTasks` still examines those older tasks. If one already has a Stop candidate, its later StopFailure or PermissionRequest is held instead of failing it or clearing that candidate. When the screen becomes idle with a readable Claude input, the sweep completes it from the old Stop. Releasing the held reports cannot correct the result: the task is final and excluded from routing. The journal and keyed replay then preserve `completed` despite the decisive report having arrived before completion.

This occurs with distinct prompt texts and correctly stamped launch numbers. It does not depend on the same-text ambiguity addressed by the previous P1. For the approval variant, the permission report precedes the screen displaying its dialog. The failure variant needs no permission dialog.

**Safe isolated reproduction:** `review-buffer-older-task.mjs`, driven against the current production build through Tauri mocks.

1. Submit and successfully Enter Claude task A. Emit its matching `start`, then a `stop` while the pane still shows busy, leaving A working with a Stop candidate.
2. Submit a distinct task B to the same pane. Hold B's native Enter promise before delivery. B remains accepted; A's Enter was already delivered.
3. Emit A's `fail` (`StopFailure`, `rate_limit`) or `approval` (`PermissionRequest`, `Write`) report while B's Enter is pending. Remove the busy hint while leaving Claude's input readable. Wait 1.2 seconds.
4. A becomes completed and is journaled as completed. Reject B's held Enter, then release/replay its buffered reports. A remains completed.
5. Reload the page and replay A's original submit key. A still returns completed.

| Report received while B's Enter is pending | Current A before B replies | Persisted A | A after release | A after reload/key replay |
| --- | --- | --- | --- | --- |
| Failure | completed | completed | completed | completed |
| Approval | completed | completed | completed | completed |

Observed current task ids: failure case A `cf80402e43404e5e`, B `11f650baf9504a38`; approval case A `43284bfe7d92411a`, B `b1a38670f71e48f5`. A's events in both cases are accepted, submitted, working, completed; the failure/approval event never reaches its task record.

**Comparison:** the identical orderings against the preceding captured production build keep A failed in the failure case and in approval in the approval case. Failed remains failed after reload. Approval becomes unknown on restart, as expected for an open task, rather than completed. This comparison isolates the new pane-wide hold as the regression.

**Impact:** task polling, waiting, watching and replay can expose a false successful completion for an already delivered task while a later input write is slow. That false completion survives persistence and prevents the later decisive report from changing it.

**Required invariant:** a pending Enter's hold must not let the sweep finalize an older task from a Stop superseded by a report already received. Either handle reports for already delivered tasks without exposing the pending task to weak correlation, or coordinate Stop/quiet sweeping with the hold and ordered replay. No fix was applied.

Evidence: `review-buffer-older-task.json`, `review-buffer-older-task-control.json`, their `.mjs` runners, `baseline-dist`, `fixes.diff`, and `snapshot.json` in the evidence directory. These are deterministic isolated orderings; their frequency in real provider sessions was not measured.

## Previous finding and adjacent checks

| Area | Disposition and evidence |
| --- | --- |
| Previous P1: an earlier turn completes an accepted task while its paste/Enter is pending, then the late failure is discarded | Fixed in independently rerun Claude/Codex paste and Enter variants. Mid-write state and journal remain accepted. Failed Enter ends unknown with `uncertain: submit`; failed paste ends failed with `uncertain: type`. Reload and keyed replay preserve those outcomes. |
| Enter boundary | Weak text/order correlation now requires non-null `submittedAt` no later than the report. Events during Enter are replayed after its outcome is assigned, using the Enter-start timestamp. Reports stamped before Enter do not complete the task. |
| Successful held Enter and strong shell token | Current browser suite checks successful Claude/Codex held reports, ordered release, and shell-token completion whether the write resolves or fails. Only the shell token can clear a task's submit uncertainty. |
| Queued sends | Independent two-submit Codex case sends only A's paste while A's Enter is held, releases A's reports before B sends, delivers both prompts separately, persists both completions, and replays both keys without typing after reload. |
| Delivered Enter whose reply is lost | Independent held-write cases for Claude, Codex and OpenCode deliver one prompt, report its end before the native reply fails, and keep the task unknown with submit uncertainty through journal, reload and replay. Ordinary delivered submissions still complete. |
| Late native Claude start and earlier same-text prompt | The actual compiled helper stamps a delayed earlier prompt after the failed task's Enter began. It still proves no task delivery. Uncertainty remains, the task ends unknown, late reports cannot reopen it, and replay types nothing. |
| Journal failure while releasing held reports | The unknown outcome is marked unsaved; watch exposes only the durable accepted event. A later successful write recovers by whole rewrite. Unknown and submit uncertainty survive reload and keyed replay. |
| Prior journal fixes | Reservation survives recovery rewrite; actual native lossy read retains keys before a torn UTF-8 tail; unreadable journal refuses submit untouched; queued older updates do not undo a newer whole snapshot; more than 1000 unwritten events do not expose a cursor reused after restart. |
| Answer uncertainty | Failed answers persist `answerInDoubt`; a delivered answer clears that flag without clearing uncertainty about the task's original Enter. Combined doubts survive failed writes, recovery, reload and replay. |
| Stop/approval handling without a pending new Enter | Reported approval clears a previous Stop; an answer needs a new Stop. An unnumbered dialog without a report does not count as idle input and leaves the task open. The finding above identifies the pending-Enter exception. |
| Launch identity and duplicate turns | Current browser suite verifies stale generation refusal, restart/close cancellation, late Stop from a replaced launch, and duplicate Codex turn deduplication. |
| Earlier CLI-control P2 queued-writer gap | Exact current `sendText`/`sendReply` function checks retain the fix: a writer queued by the final input check holds Enter, including empty/suggestion inputs. Writers during preflight, paste or settling also produce conservative refusal/receipt progress. |
| U+00A0 and input guards | ASCII space and U+00A0 prompts recognize empty, suggestion and draft. Other tested whitespace remains unknown. Stale revisions, drafts, failed suggestion replacement, missing echo and generation changes refuse the relevant writes. Submit also refuses drafts and numbered questions in the current browser suite. |
| Failed-Enter receipt retention and earlier documentation P3 | Digest, byte count, key, progress and conservative write uncertainty remain available after paste/Enter failure. A later receipt turn acknowledges input activity without proving this Enter arrived; current receipt documentation states that limit and the independent check verifies it. |
| Ignored-file protection | Exact current inventory/close functions with mocked Git retain `--ignored=matching`, require explicit ignored-loss authorization, reject changed plans and unreadable inventory, and retain the fake worktree/branch if ignored files change while panes close. No real worktree was closed or deleted. |

The original P1 is closed for the checked orderings. That disposition is separate from the new older-task regression; the overall lifecycle still permits a false persisted completion in that case.

## Validation performed

| Check | Result |
| --- | --- |
| CLI unit checks | 64 passed |
| Prompt/input unit checks | 53 passed |
| Git parsing/loss-inventory unit checks | 46 passed |
| Task unit checks | 99 passed |
| Total unit checks | 262 passed |
| OpenCode plugin checks | Both supported fixture variants passed |
| TypeScript `tsc --noEmit` | Passed |
| Production Vite build | Passed; standard large-chunk warning |
| Full current `scripts/task-check.mjs` | 37 passed; 30-second quiet cases enabled and native helper supplied |
| Independent task/browser cases | 30 expected fixed/positive outcomes passed, plus two reproduced defect variants and two preceding-build comparison cases |
| Exact-function CLI/input/receipt/deletion fixtures | 33 passed |
| Focused native Rust checks | 19 passed: 11 loomctl, five selected helper checks, two drain/config checks, one journal-reader check |

Logs and structured outcomes are retained locally: `*-result.json`, `*.log`, `native-results.json`, `review-pending-enter-fixed.json`, `review-buffer-adjacent.json`, `review-outcome-matrix.json`, `review-prior-fixes.json`, `review-cli-controls.json`, and the other `review-*.json` evidence files.

The native tests compile captured source or exact extracted functions with the already present Rust toolchain and serde_json artifact. The delayed-start case runs the actual captured Claude hook and the torn-journal case runs the actual native reader. The page tests execute the newly built frontend over isolated Tauri mocks and a persistent fake journal. Existing dependencies were copied/read; no dependencies were installed. The older CLI fixture was adapted for the current `sendText` delegation and Pane.wrote interface; its initial missing-method fixture failure was corrected in reviewer-owned files before all 33 checks passed.

## Limits

- No live Loom instance, pane, provider session or named-pipe command was used. Fake writes make the tested orderings repeatable; these checks do not measure real IPC latency or provider behavior frequency.
- Full Cargo/Tauri build, packaging, native window integration, pipe ACL/transport checks and `scripts/task-live-check.mjs` were not run. The 19 native checks cover the listed source paths, not all Rust tests.
- Full `scripts/ui-check.mjs`, screenshots and responsive/visual audits were not run in this pass. The previous scroll-test precondition is not resolved or recertified by this report.
- The pane-wide buffer's documented never-returning-write/deadline limitation remains. This review demonstrates the Stop-sweep defect without requiring an indefinitely hung write.
- Git warned that the sandbox could not read `C:\Users\ayoub/.config/git/ignore`. The same explicit Git commands were used before and after; no trust/configuration change was made.
- The preservation baseline covers tracked and untracked nonignored project files and the listed Git metadata. No complete byte-hash baseline of ignored dependency/build trees was taken. Those source trees were only read for copying or compilation dependencies; all test/build outputs went to the isolated review directory.

## Preservation and report readback

Immediately before saving, all 142 captured pre-existing project files, including all 16 prior reports, matched their initial SHA-256 hashes. All 13 captured Git metadata files matched, including index, HEAD, branch refs, packed refs and repository configuration. The tracked working diff and staged diff matched their captured hashes; branch and HEAD were unchanged. Before this save there were no added project files.

The save procedure repeats those checks, creates a fresh timestamped report with exclusive creation, reads it back as strict UTF-8 without a BOM, compares its SHA-256 with the isolated evidence copy, and requires the sole project/Git-status addition to be this report. Results and its exact byte count/hash are saved in `saved-report.json` and `report-verification.json` in the evidence directory. Earlier reports are not overwritten.

Both reviewer-owned Node preview processes were stopped only after checking their PID, executable and script identity. Their two localhost ports refused subsequent connections. `preview-cleanup.json` and `preview-port-cleanup.json` record the checks. Native helper temporary event files were cleaned by the isolated checks. No live Loom process was stopped.
