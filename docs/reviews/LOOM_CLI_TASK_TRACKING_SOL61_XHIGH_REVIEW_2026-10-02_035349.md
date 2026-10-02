# Loom CLI task-tracking review

Saved at 2026-10-02T03:53:49.311Z. Source captured at 2026-10-02T03:32:44.923Z.

Two P1 false-completion paths remain. The four exact reproductions in `LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_030207.md` now pass, but the failed-Enter fix does not yet preserve delivery uncertainty through concurrent input and a failed permission answer. No additional actionable persistence defect was found in the checked snapshot, replay, pruning and watch paths.

## Scope and source

The target is `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. This is a report-only follow-up against the 03:02:07 report, SHA-256 `e1ef93b0defad7abcd499294423bc76ca8cc7b2f85590704f65e260efde4bf79`. The requested review lane is Sol6.1 Extra High; the workspace tools do not expose a model-selector attestation.

The captured worktree has 11 modified tracked files, four untracked implementation/test files, four untracked prior reports and no staged changes. The latest fix delta changes six files: `docs/cli-control.md`, `docs/loomctl.md`, `scripts/task-check.mjs`, `src/main.ts`, `src/task.test.ts` and `src/task.ts`. Findings below cite the actual current worktree's line numbers. Tests used a hash-preserved copy of that source and existing dependencies in a separate writable review directory.

Evidence directory: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T033242Z`. It contains the inventory and hashes in `snapshot.json`, the full current HEAD diff in `working.diff`, the latest fix delta in `fixes.diff`, isolated runners, logs, JSON results and preservation checks.

Instructions checked: `C:\Users\ayoub\AGENTS.md`, the ancestor paths and target tree for additional `AGENTS.md`/`.agents`/`.codex` instructions, the review-agent skill, Ponytail coding-review skill and Unslop prose instructions. No target-specific instruction file was found. The workflow stays within the authorized report write and isolated tests.

## Findings

### 1. [P1] Capture the Enter proof counter before its asynchronous write can fail

Primary location: `src/main.ts:7050-7053`. Related locations: `src/main.ts:3715-3717`, `src/main.ts:3430-3435`, `src/main.ts:3525-3528` and the window input handler at `src/main.ts:1734-1738`.

The new `enterSeq` proof is captured in `sendText`'s catch after awaiting the failed Enter write. Window input increments `p.inputSeq` and writes directly while that promise is pending. Consequently, the saved value includes any concurrent typing and Enter, rather than identifying the task's own Enter attempt. A delayed start for the other prompt then compares equal at line 3717 and clears `uncertain: "submit"`. The later Stop reaches `completed`, even when the original task's Enter was definitely rejected without delivery.

Isolated reproduction against the actual production bundle:

1. Submit task A with text `race same text`. At the mocked native boundary, hold its Enter promise without applying the write; confirm the fake provider has received zero prompts and A is `accepted`.
2. Focus the real xterm textarea and press Ctrl-U, type the same text and press Enter through the window's actual input handlers. Model Ctrl-U's draft-clearing effect in the fake provider. Confirm that exactly one prompt, the manually entered prompt, reached it.
3. Reject A's still-pending Enter promise. The CLI returns failure with `uncertain: "submit"`; A becomes `submitted`, and the catch stores the already-advanced input count.
4. Emit the manually entered prompt's delayed, current-generation start report. A moves to `working` and its uncertainty becomes `null`.
5. Emit Stop and show the idle input. A becomes `completed` after the confirmation sweep.

Observed result from `review-proof-race.json`:

```json
{
  "originalEnterDelivered": false,
  "manualUntrackedPrompts": ["race same text"],
  "concurrentWindowWrites": 16,
  "afterFailure": "submit",
  "afterLaterStart": null,
  "outcome": "completed"
}
```

Expected: A retains submission uncertainty and ends `unknown` with `reason: "submit-uncertain"`; the other prompt's start cannot prove A's delivery. This can make `task`, `wait --task` and keyed retries report successful completion of a job that did not enter the provider. The docs' new unchanged-input proof at `docs/cli-control.md:301-303` and `docs/loomctl.md:554-555` assumes a counter boundary the implementation does not capture.

Correction direction: record the expected input sequence at the task's own Enter attempt, after its sequence increment and before awaiting the native result. Compare later starts against that attempt value. Keep the doubt if any writer advanced it. The existing lost-reply test has no input during the pending native result and therefore does not cover this race.

Evidence: `review-proof-race.mjs`, `review-proof-race.json`, `review-proof-race.log`. The runner holds and rejects only the selected mocked `pty_write` promise; it uses the copied application's real window input handlers. The fake provider's Ctrl-U effect and delayed start are explicit test inputs. This is not a live PTY measurement.

### 2. [P1] Preserve submit uncertainty when an approval answer also fails

Primary location in the latest fix: `src/task.ts:104-106`. Interacting locations: `src/main.ts:2333-2336`, `src/task.ts:187-188` and final Stop confirmation at `src/main.ts:3803-3804`.

`unproven` protects a task only while its single mutable `uncertain` field equals `"submit"`. The existing failed-answer handler unconditionally replaces that value with `"answer"` for every task in approval. A subsequent delivered answer clears `"answer"` to `null`. Neither action proves the original submit's Enter arrived, but both erase the fact on which the new final-outcome guard depends. The unchanged answer handler therefore bypasses the latest failed-Enter fix.

Isolated reproduction, without the counter race from finding 1:

1. Fail A's Enter before applying it; verify zero provider prompts and A's `uncertain: "submit"`.
2. Clear its waiting draft in the fake provider and run an untracked `send` of the same text. Emit that prompt's current-generation start. The input counter correctly differs from A's captured value, so A moves to `working` while retaining `"submit"`.
3. Emit a permission request for that turn and show its dialog. Fail `keys work:1 enter` before applying it. A stays `approval`, but its uncertainty changes from `"submit"` to `"answer"`.
4. Deliver a retry of that answer. A becomes `working` with uncertainty `null`.
5. Emit Stop and restore the idle input. A becomes `completed`, although its own Enter never reached the provider.

Observed result from `review-delivery-answer.json`:

```json
{
  "originalEnterDelivered": false,
  "untrackedPrompts": ["approval same text"],
  "beforeAnswer": "submit",
  "afterFailedAnswer": "answer",
  "afterDeliveredAnswer": null,
  "outcome": "completed"
}
```

Expected: the original submit uncertainty survives the answer's failure and retry. A remains eligible for `unproven` and ends `unknown`, not `completed`. Answer delivery acknowledges the permission response for the correlated turn; it does not acknowledge delivery of the earlier task. This is a separate cause from finding 1 and reproduces after the counter comparison correctly rejected delivery proof.

Correction direction: retain unresolved submit delivery uncertainty when recording answer uncertainty, and clear only the answer-related doubt on a delivered answer. Do not use successful permission-answer delivery to clear the original submit doubt. Add a combined submit-failure/answer-failure case; the existing failed-answer tests begin with a delivered submit and miss this interaction. The existing answer handler is not newly added, but its overwrite defeats the new guard's promised invariant.

Evidence: `review-delivery-answer.mjs`, `review-delivery-answer.json`, `review-delivery-answer.log`. This uses the actual built page and existing task fixture's fail-before-write branch at the mocked native boundary. No source modification or real permission response was made.

## Disposition of the four preceding findings

| Prior finding | Current disposition | Independent evidence |
| --- | --- | --- |
| R1, P1: an untracked later turn completes a task whose Enter failed | The exact old Codex and Claude cases are fixed. The broader delivery invariant is only partially fixed because of findings 1 and 2 above. | `unproven` returns `unknown` for ambiguous text/order finals. Delivered repeated prompt B completes B; a later untracked prompt C leaves absent A `unknown`, `reason: "submit-uncertain"`, uncertainty `submit`. The no-intervening-input lost-reply case also passes. |
| R2, P1: an unreported unnumbered permission dialog confirms an old blocked Stop | Fixed in the reproduction. | `idleInput` at `src/main.ts:3802-3804` requires a readable Claude input as well as no busy hint/menu. With only the unnumbered `Allow Bash(ls)?` dialog present, the task stays `working` and wait times out. Reported approval still invalidates the preceding Stop and needs a new one after answering. |
| R3, P2: queued same-state updates overwrite a newer whole snapshot | Fixed in the reproduction. | `journalCalls`/`snapshotCalls` at `src/main.ts:3605` and `src/main.ts:3627-3642` skip queued changes covered by a successful snapshot, retaining required reservations. The reproduced batch remains `failed` in memory, on disk and after reload, with `saved: true`. |
| R4, P2: more than 1000 unwritten events collide with restart watch numbering | Fixed in the reproduction. | `writtenSeq` at `src/main.ts:3611`, `src/main.ts:3638`, `src/main.ts:3839` and `src/main.ts:7467-7479` limits watch to written events and resumes numbering from the journal. With 1001 held events, watch exposes zero of them and keeps cursor 3. Reload produces event 4, visible after cursor 3 with `gap: false`. The existing suite also passes its 1100-event stalled-journal case. |

The independent seven-scenario results are in `review-four-fix-browser.json`. Some inherited scenario labels describe the old defect; their assertions and result fields were changed to expect the fixed behavior, and all seven scenarios passed. No finding is inferred from those stale labels.

The recovery reservation/key test also passed: the key remains persisted through a whole rewrite, and a keyed retry after reload replays without typing. The actual native reader salvages valid lines before a torn UTF-8 tail; keys replay, numbering advances from 2 to 3 and an outright unreadable journal refuses submit without changing the file. A failed approval answer's uncertainty is retained across reload when the original submit was delivered, and a successful answer clears that answer-only uncertainty. These positive results do not cover the combined submit/answer failure in finding 2.

## Verification

| Check | Result | Evidence in the isolated directory |
| --- | --- | --- |
| CLI, prompt and Git parsing unit checks | 64, 53 and 46 passed | `cli-result.json`, `prompt-result.json`, `gitparse-result.json` and logs |
| Task rules and journal unit checks | 85 passed | `task-result.json`, `task.log` |
| OpenCode plugin checks | Both supported provider versions passed | `plugin-result.json`, `plugin.log` |
| TypeScript and frontend production build | `tsc --noEmit` passed; Vite built 34 modules in 1.77 seconds | `typecheck-result.json`, `build-result.json`, `build.log` |
| Existing task browser suite | All 27 checks passed, including full 30-second idle cases | `taskbrowser-result.json`, `taskbrowser.log` |
| Existing UI suite | 171 rendered states passed at 1280px; 80 writer trials gave 10 pre-paste refusals and 70 held Enters | `ui-result.json`, `ui.log` |
| Independent fix/recovery browser cases | Seven scenarios passed | `review-four-fix-browser.mjs`, `.json`, `.log` |
| Independent new defect reproductions | Both P1 paths reproduced with assertions | `review-proof-race.*`, `review-delivery-answer.*` |
| Exact native CLI and pipe source | 11 tests passed; isolated CLI executable compiled | `loomctl-native.log` |
| Exact native helper and real extracted root/rollout lookup | Five focused provider tests passed | `helper-native.log`, `review-helper.rs` |
| Exact event drain and Claude hook configuration | Two tests passed | `drain-native.log`, `review-drain.rs` |
| Exact native journal reader | Test passed for torn tail, missing file and directory-as-file; isolated wrapper compiled | `journal-native.log`, `review-journal-read.rs` |
| Actual compiled CLI against review-owned fake pipes | Reconnect, timeout and fatal JSONL error cases passed | `review-follow.json`, `review-follow.log` |
| OpenCode pending permissions | Partial reply retains the wait marker and emits no resume; final reply resumes | `review-plugin-pending.json`, `review-plugin-pending.log` |

The UI suite reran draft, revision, generation, numbered-menu, U+00A0 input detection and concurrent-writer safeguards; failed-write and failed-Enter receipt retention; unrelated receipt-turn handling; and ignored/protected-file deletion-plan checks through mocks. No new actionable regression was found in those checked paths. The task Enter proof race is distinct from the guarded send/paste writer cases that pass. No actual source-worktree file was deleted. The workspace and draft-reply screenshots were visually inspected and showed no visible layout defect in those states.

The Vite build emitted the existing large-chunk advisory for the 690.80 kB main chunk; it exited successfully. Isolated Rust builds used existing serde_json dependency artifacts read from the original target directory. The journal reader and root/rollout lookup were extracted from the captured source; the reader's wrapper only selects a review-owned path and emits a JSON envelope. Compilation outputs stayed in the review directory. No dependency installation was needed.

## Limits

No live Loom pane was controlled and no real provider task or permission answer was sent. No source fix, commit, merge, install, trust/security change, notification implementation or external message was made. `scripts/task-live-check.mjs` and a full Cargo/Tauri application build were not run. Focused exact-source Rust tests do not establish that the complete native application builds.

Browser checks run the actual copied production bundle with fake providers and mocked native boundaries. Failure, event delay, missing approval reports, queued writes and reload conditions are deliberately controlled. They establish the code's result for those inputs, not the frequency of live-provider failures. The watch tests simulate lost unwritten writes with a reload; they are not real process-crash or power-loss tests. Successful native write promises were not tested for survival through an operating-system crash.

Two initial launches of the reviewer-owned permission-answer runner failed before opening a browser because its Playwright module locator was incorrect. The locator was corrected to the existing runtime module's file URL; the final run exited successfully and reproduced finding 2. No implementation or dependency change was made to address those harness errors.

Git reads used explicit worktree/git-dir paths and disabled optional locks because normal discovery has an ownership ambiguity. Sandbox reads warn that the user's global ignore file is inaccessible. No Git trust or configuration was changed. Preservation uses identical Git invocations and the captured inventory; source ignored dependencies/build directories were read-only inputs, not test destinations.

## Preservation

Before saving, all 139 captured tracked/untracked nonignored files, including all 13 earlier reports, matched their SHA-256 hashes. All 13 captured Git metadata files matched, including index, branch/HEAD, refs and configuration. Working and staged diffs and porcelain status matched the capture. Evidence: `snapshot.json`, `pre-save-verification.json`.

The save procedure exclusively creates a fresh timestamped UTF-8 report without BOM. It verifies preservation again immediately before the write and after it, requiring this report to be the only added worktree file. The source report's hash and final preservation outcome are stored in `saved-report.json` and `report-verification.json` in the evidence directory.

The review-only preview at `127.0.0.1:54592`, PID 156316, was identity-checked as Node running `serve-review.mjs` and stopped. Its port then returned `ECONNREFUSED`. Evidence: `preview-cleanup.json`, `preview-port-cleanup.json`. Fake named pipes and review-specific OpenCode marker/session files were cleaned up by their runners. No live Loom process was stopped.
