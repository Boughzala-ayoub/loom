# Loom CLI task-tracking review

Saved at 2026-10-02T07:49:59.716Z. Source captured at 2026-10-02T07:26:35.650Z.

One P1 delivery-proof defect remains. Both exact P1 reproductions from `LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_035349.md` now pass. Concurrent typing no longer enters the task's captured Enter counter, and permission-answer retries preserve unresolved submit uncertainty. An earlier untracked prompt can still supply a delayed start that the new evidence rule falsely treats as proof of this task's Enter. The reproduced false completion also reaches the journal.

## Finding

### 1. [P1] Keep submit uncertainty when an earlier prompt can supply the start

Primary location: `src/main.ts:3731`. Related changed location: `src/main.ts:3535`. Native timestamp producer: `src-tauri/src/helper.rs:215-219`.

The proof rule assumes that no busy hint at the Enter attempt, a later start timestamp and an unchanged input counter exclude an earlier prompt. They do not. A previously delivered untracked prompt can still be awaiting its start report and busy output when the tracked task attempts Enter. `enterIdle` checks only the absence of `INTERRUPT_HINT`. The native helper stamps `t` when it writes the report, after reading stdin, rather than carrying the earlier prompt's Enter/acceptance time. Its delayed report therefore satisfies `s.at >= e.at`, and the counter also matches because the earlier input happened before this task. Line 3731 clears `uncertain: "submit"` with `proof: true`. That earlier prompt's Stop then completes a task whose own Enter never reached the provider.

Reproduction against the current copied production bundle:

1. Deliver an untracked `send work:1 "earlier pending same text"`. Confirm that this is the one prompt received by the fake provider.
2. Model the earlier prompt's busy output and start report as delayed. The input screen still has no busy hint when the tracked task is sent.
3. Submit task A with the same text. Fail its native Enter before applying the write. The task becomes `submitted`, uncertainty `submit`, and no second prompt is delivered. No input follows A's Enter attempt.
4. Deliver the earlier prompt's start with a timestamp written after A's Enter. A becomes `working`, uncertainty `null`.
5. Deliver the earlier prompt's Stop and show the idle input. A becomes `completed`, and replay of the mocked journal also says `completed`.

The first runner reproduced this with a simulated start timestamp. A second runner used the exact current helper source, compiled with the actual extracted root/rollout lookup, to produce the timestamp. It started the helper for a review-only pane ID and wrote the earlier prompt's payload before A's Enter, while holding stdin EOF until after that Enter failed. The helper then produced its real event. Only its match and timestamp were bridged into the fake page's current-generation event boundary. The report file was immediately removed, and the helper exited 0. No live provider or Loom pane was involved.

Measured second-run evidence from `review-native-earlier-start.json`:

```json
{
  "earlierUntrackedPromptDelivered": true,
  "taskEnterDelivered": false,
  "inputAfterTaskEnter": 0,
  "taskEnterAt": "2026-10-02T07:38:52.501Z",
  "nativeStartAt": "2026-10-02T07:38:52.526Z",
  "afterFailure": "submit",
  "afterEarlierStart": null,
  "outcome": "completed",
  "persistedOutcome": "completed",
  "prompts": ["earlier pending same text"]
}
```

Expected: A keeps submission uncertainty and ends `unknown` with `reason: "submit-uncertain"`. Neither the screen's missing hint nor the helper's report-write time identifies which Enter delivered the prompt. This affects `task`, `wait --task`, watch and keyed replay consumers that use a completed task as evidence their submitted work ran.

Correction direction: do not clear submit uncertainty from this evidence while an earlier input submission may still supply the start. Require evidence that identifies the task's own delivered prompt, or retain the uncertainty when the start is ambiguous. Tightening the timestamp comparison alone does not fix a report written later for an earlier prompt. The docs at `docs/cli-control.md:303-308` and `docs/loomctl.md:552-557` should describe the same conservative rule.

Evidence: `review-delayed-earlier-start.mjs`, `.json`, `.log`; `review-native-earlier-start.mjs`, `.json`, `.log`; `review-claude-hook.rs`, `.compile.log`. The controlled delays establish a code/protocol ambiguity. They do not measure how often busy output or hook input is delayed in a live provider. The existing new tests cover an already-visible busy hint and a start stamped before the Enter, but this case has neither.

## Disposition of the two preceding P1 findings

| Previous finding | Disposition | Current code and observed result |
| --- | --- | --- |
| P1 1: a counter captured after Enter fails incorporates concurrent typing | Fixed for the stated cause. The broader delivery-proof invariant still has the finding above. | `sendReply` calls `submit`, then captures `p.inputSeq` at `src/main.ts:3536-3538`, before awaiting the promise. `sendText` copies that attempt evidence at `src/main.ts:7067`. Replaying the old held-Enter/window-input scenario leaves uncertainty `submit` after the later start, then ends `unknown`, reason `submit-uncertain`. |
| P1 2: a permission-answer failure and successful retry erase submit uncertainty | Fixed, including checked persistence paths. | `Pane.wrote` sets `answerInDoubt` at `src/main.ts:2336`; `route` clears only that flag on resume at `src/task.ts:208`; `changeFields` at `src/task.ts:93-96` prevents replacement or clearing of `submit` without proof. The old reproduction retains `submit` through both answer attempts, toggles the answer flag true then false, and ends `unknown`. |

Independent counter reproduction: `review-counter-fixed.json` records 16 concurrent window writes, only one manually delivered prompt, uncertainty `submit` before and after the start, and final `unknown`. It uses the actual xterm window input handlers against a held/rejected mocked native Enter.

Independent answer reproduction: `review-answer-fixed.json` records `submit` before the answer, after its failure and after its retry. `answerInDoubt` is true after failure and false after retry. The final state is `unknown`, reason `submit-uncertain`.

The additional combined persistence scenario in `review-answer-persistence.json` failed the journal write after a failed approval answer, confirmed `saved: false`, recovered through a whole rewrite on a delivered answer, failed another answer and reloaded. The disk retained submit uncertainty and the separate answer flag. After reload the task was `unknown`, uncertainty `submit`, `answerInDoubt: true`, reason `loom-restarted`. A keyed retry replayed the same task and typed zero prompts.

`taskFields` and `taskRecord` expose the separate answer flag at `src/task.ts:262` and `src/task.ts:312`. All task changes in the checked runtime path use `changeFields` through `moveTask`; the proof marker itself is removed from persisted task fields. Enter evidence remains transient, and reload ends open tasks `unknown` rather than recreating proof from a reset input counter. No new actionable defect was found in these checked field-update and reload paths.

## Prior fixes and regression checks

Seven independent built-page cases passed in `review-prior-fixes.json`:

- Whole-journal recovery preserves the new reservation and key; retry after reload replays without typing.
- The exact native reader salvages valid records before a torn UTF-8 tail. Keys replay, numbering advances from 2 to 3, and an outright unreadable journal refuses submit without changing the file.
- A delivered repeated prompt completes its delivered task. A later untracked prompt leaves the absent older task `unknown`, uncertainty `submit`.
- Reported approval invalidates an old Stop and requires a new Stop after answering. An unreported unnumbered dialog keeps the task working and makes wait time out.
- A failed answer's separate flag is saved, cleared by a delivered answer, and retained across reload if not cleared.
- Queued changes covered by a whole snapshot do not undo its final state. The reproduced task remains `failed` in memory, on disk and after reload, with `saved: true`.
- With 1001 unwritten events held, watch exposes none and retains cursor 3. Reload produces event 4, visible after cursor 3 with no gap.

Some inherited labels in the independent runner describe the old defects. The assertions and result fields expect fixed behavior; all seven scenarios passed. The label wording is not evidence of failure.

The current existing task-browser suite also passed all 30 checks, including its new concurrent-window-input, busy-at-Enter, pre-Enter timestamp and combined submit/answer cases; full 30-second idle outcomes; launch guards; Esc handling; recovery reservations; torn reads; queued snapshots; 1100 stalled watch events; key dedupe and prune watermark across reload. Its positive lost-Enter-reply case clears uncertainty with no competing prompt. That positive case does not exclude the earlier pending prompt in the finding above.

## Test results and limits

| Check | Outcome | Evidence in the isolated directory |
| --- | --- | --- |
| CLI, prompt, Git parsing and task unit checks | 64, 53, 46 and 91 passed, 254 total | `cli-result.json`, `prompt-result.json`, `gitparse-result.json`, `task-result.json`, and logs |
| OpenCode plugin checks | Both provider versions passed | `plugin-result.json`, `plugin.log` |
| TypeScript | `tsc --noEmit` passed | `typecheck-result.json`, `typecheck.log` |
| Production frontend build | 34 modules built in 1.53 seconds; existing large-chunk advisory | `build-result.json`, `build.log` |
| Existing task-browser suite | All 30 passed, full idle waits enabled | `taskbrowser-result.json`, `taskbrowser.log` |
| Independent old P1 reproductions | Both passed with fixed-state assertions | `review-counter-fixed.*`, `review-answer-fixed.*` |
| Combined uncertainty persistence | Passed failure/recovery/reload/key-replay case | `review-answer-persistence.*` |
| Independent prior-fix cases | Seven passed | `review-prior-fixes.*` |
| New remaining P1 case | Reproduced with simulated and exact-native-helper timestamps, including journal result | `review-delayed-earlier-start.*`, `review-native-earlier-start.*` |
| Exact-source native focused tests | 19 passed: 11 CLI/pipe, five helper, two drain/config and one journal reader | `native-results.json`, `loomctl-native.log`, `helper-native.log`, `drain-native.log`, `journal-native.log` |
| Compiled CLI fake-pipe follow checks | Reconnect, timeout and fatal JSONL error cases passed | `review-follow.json`, `review-follow.log` |
| OpenCode pending permissions | Partial reply leaves wait active with no resume; final reply resumes | `review-plugin-pending.json`, `review-plugin-pending.log` |
| Full existing UI suite | Incomplete. Scroll precondition failed at 320px and again at 1280px | `ui-default-widths.log`, `ui-default-widths-result.json`, `ui.log`, `ui-result.json` |

The 1280px UI run reached and passed its CLI safeguards before stopping: input revisions/generations, drafts, numbered menus, U+00A0 detection, failed-write and failed-Enter receipt retention, unrelated receipt turns and ignored/protected-file deletion-plan checks in mocks. Its 80 writer trials produced 10 pre-paste refusals and 70 held Enters. No actual source-worktree file was deleted. The workspace and draft-reply screenshots from that run were visually inspected and showed no visible layout defect in those states.

The full UI run stopped at `scripts/ui-check.mjs:1934`, `The test must scroll into terminal history`. A retry at the usual 1280px review width failed at the same precondition. The latest fix delta does not change that script or terminal-scroll implementation. A short baseline diagnostic did not reach its busy-state setup, so it was inconclusive. This report does not attribute the UI failure to the latest changes, does not call the full UI suite a pass, and does not claim responsive verification at every width. Later UI cases were not reached.

An initial direct rustc invocation lacked Cargo's `CARGO_PKG_VERSION`. The isolated runner supplied the captured package version, 3.0.0, matching Cargo.toml, then compiled and passed the focused tests. Existing serde_json dependency artifacts were read from the original target directory. No dependency install occurred and all compilation outputs stayed in the isolated directory. The exact helper wrapper adds only a `main` that calls `claude_hook`, plus the actual extracted root/rollout functions needed to compile the source outside the app.

No live Loom pane was controlled, no real provider prompt or approval answer was submitted, and no command was dispatched to Claude. Browser tests use the actual copied production bundle with fake provider and native boundaries. The native helper case uses a synthetic pane ID and deliberately delayed stdin completion. These tests establish code outcomes for the specified inputs, not live failure rates.

`scripts/task-live-check.mjs`, a complete Cargo/Tauri build, actual process-crash and power-loss tests were not run. Focused native compilation does not verify the whole app build. There was no source fix, commit, merge, install, trust/security change or notification implementation. The requested review lane is Sol6.1 Extra High; workspace tools do not provide an independent model-selector attestation.

## Source and preservation

Target: `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. Comparison report SHA-256: `787ac01b04cde0a2ad0872b96747f7c2aaa369d50cc44950430c2ada4dff44d1`.

The latest delta changes six files: `docs/cli-control.md`, `docs/loomctl.md`, `scripts/task-check.mjs`, `src/main.ts`, `src/task.test.ts` and `src/task.ts`. The native helper and timestamp producer are unchanged from the preceding capture. The worktree still has 11 modified tracked files, four untracked implementation/test files, five untracked earlier reports and no staged changes. This report cites the current captured source lines.

Instructions read: `C:\Users\ayoub\AGENTS.md`, the local review-agent skill and required Unslop skill. Ancestor paths and the target tree were checked for additional `AGENTS.md`, `.agents` and `.codex` instructions; none were found for the target. The user expressly authorized the fresh report write. Source inspection and tests otherwise remained read-only in the target.

Evidence directory: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T072633Z`. `snapshot.json` contains the source inventory, SHA-256 hashes and Git metadata hashes. `working.diff` records current changes against HEAD; `fixes.diff` records the delta against the preceding review's preserved source copy. Existing dependencies were copied into the isolated directory. Original ignored dependency/build directories were read-only inputs.

Before saving, all 140 captured tracked/untracked nonignored files, including all 14 earlier reports, matched their hashes. All 13 captured Git metadata files matched, including index, branch/HEAD, refs and configuration. Working and staged diffs and porcelain status matched the capture. Evidence: `pre-save-verification.json`.

The save procedure exclusively creates a fresh timestamped UTF-8 file without BOM and immediately checks preservation again. It permits only this report as an added worktree file. `saved-report.json` records its path, byte count and SHA-256; `report-verification.json` verifies strict UTF-8 readback, matching hashes and preservation.

Git reads use explicit worktree/git-dir paths and disabled optional locks. Normal discovery has an ownership ambiguity, and sandbox Git warns that the user's global ignore file is inaccessible. No trust or configuration repair was attempted; preservation uses the same captured commands and inventory.

Both review-only previews, `127.0.0.1:50062` and `127.0.0.1:63747`, were identity-checked as Node running the corresponding review server scripts, stopped, and confirmed to refuse connections. The second served the earlier preserved bundle without modifying that older evidence directory. Fake pipes, the review-specific OpenCode marker/session files and the synthetic native start event were cleaned up. No live Loom process was stopped. Evidence: `preview-cleanup.json`, `preview-port-cleanup.json` and native-runner results.
