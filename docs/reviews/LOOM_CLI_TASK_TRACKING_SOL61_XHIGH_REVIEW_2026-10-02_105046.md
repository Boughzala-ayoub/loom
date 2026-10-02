# Loom CLI task-tracking review

Saved at 2026-10-02T10:50:46.487Z. Source captured at 2026-10-02T10:33:11.836Z.

One P1 remains in task correlation during a pending write. The exact delayed-start case from `LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_074959.md` is fixed: after Enter failure has been recorded, an agent's start cannot clear submit uncertainty. An earlier turn can still finalize a reserved task before its paste or Enter promise settles. The later write failure cannot update that final record, and the false completion survives reload and keyed replay.

## Finding

### 1. [P1] Defer definitive task outcomes until the task's delivery is established

Primary locations: `src/task.ts:162` and `src/task.ts:190`. Related locations: `src/main.ts:3712`, `src/main.ts:3680`, `src/main.ts:7042-7054`, and `src/task.ts:128`.

A reserved task is eligible for weak provider correlation while still `accepted`, with `uncertain: null`. `route` allows an accepted task to take a start by matching text, and Codex's end candidates also include accepted tasks. While the task's own native paste or Enter write is pending, an earlier untracked turn with the same text can therefore complete it. `unproven` protects only a task whose uncertainty is already `submit`, which is not assigned until the write rejects. Once completion is recorded, `moveTask` returns immediately for a final task, so the failure handler's attempt to record `submit` or `type` uncertainty is discarded.

Reproduction against the current copied production bundle:

1. Deliver an untracked prompt with text `earlier turn during pending enter`. Keep its busy output and provider reports delayed. Confirm only that earlier prompt reached the fake provider.
2. Submit a tracked task with the same text. Hold its selected native write without applying it, either Enter or the paste. The task has its persisted reservation, state `accepted`, and uncertainty `null`.
3. While that write is pending, deliver the earlier turn's events on the current generation. On Claude, its matching start followed by Stop and an idle input completes the task. On Codex, its end naming the text completes the accepted task directly.
4. Verify `completed` is already in the journal before resolving the pending write. In the Enter cases, the task's text is still waiting in the provider input. In the paste case, the task's text never reached the provider at all.
5. Reject the held write. The submit command returns failure with uncertainty `submit` or `type`, but the task record remains `completed`, uncertainty `null`. Reload and replay the key. Both retain the false completed result.

All three cases reproduced in `review-pending-enter-final.json`:

| Case | Task paste delivered | Task Enter delivered | Submit failure uncertainty | Task after failure and reload |
| --- | --- | --- | --- | --- |
| Claude, held Enter | Yes, still a draft | No | `submit` | `completed`, uncertainty `null` |
| Codex, held Enter | Yes, still a draft | No | `submit` | `completed`, uncertainty `null` |
| Codex, held paste | No | No attempt reached the provider | `type` | `completed`, uncertainty `null` |

Example measured result:

```json
{
  "agent": "codex",
  "phase": "paste",
  "taskEnterDelivered": false,
  "taskPasteDelivered": false,
  "onlyEarlierPromptDelivered": true,
  "finalBeforeEnterReply": "completed",
  "uncertainBeforeEnterReply": null,
  "submitReply": {"ok": false, "uncertain": "type"},
  "finalAfterFailure": "completed",
  "uncertainAfterFailure": null,
  "persistedOutcome": "completed",
  "reloadedOutcome": "completed",
  "keyReplayed": true
}
```

Expected: the earlier prompt's text/turn does not establish delivery or completion of the pending task. The task must retain its actual write outcome and uncertainty. In the Enter case, an ambiguous turn cannot produce confirmed completion; in the paste case, the not-submitted failure must not be replaced by completion. Consumers of `task`, `wait --task`, watch and keyed retry currently receive a successful final record for work that was never submitted.

Correction direction: distinguish a task whose write is still pending from one whose delivery was acknowledged. Do not finalize pending tasks using text or run-order evidence alone. Preserve or defer early provider signals until the task's write outcome can be reconciled, rather than allowing the final-state guard to swallow the failure. Account for events that arrive before the native reply on successful delivery as well, including a shell's strong task token. Only marking uncertainty after rejection leaves this window open.

This is one root issue, demonstrated at two write stages and on two providers. The pending-write exposure was already present in the preceding task-tracking implementation; it is not caused by deleting the start-as-proof condition. It remains within the reviewed uncommitted task-tracking feature and the requested adjacent lifecycle/correlation scope. The latest fix closes the post-failure proof bug but does not close this earlier window.

Evidence: `review-pending-enter-final.mjs`, `review-pending-enter-final.json`, `review-pending-enter-final.log`. The fixture holds the selected native promise before applying its write. Provider reports and output are controlled test inputs. The Enter cases keep the waiting draft intact; they do not clear it to manufacture an idle input. These tests establish code outcomes, not the frequency or duration of live native-write delays.

## Previous finding disposition

The stated P1 at the previous `src/main.ts:3731` is fixed in its original ordering. `taskSignal` at current `src/main.ts:3710-3725` no longer converts a text-matched agent start into `proof: true`. The Enter counter, idle flag and associated transient proof state were removed. `changeFields` at `src/task.ts:96-99` retains submit uncertainty without proof; the only remaining runtime proof producer is the shell-token start at `src/task.ts:171`.

The independent simulated and native-helper reproductions both now end `unknown`, uncertainty `submit`, reason `submit-uncertain`, and are saved that way. The native run used the exact captured helper source with the actual extracted root/rollout lookup. Its stdin was held open past the failed Enter to produce a real later timestamp. Only the event's match and timestamp were bridged into the fake page's current-generation boundary.

Measured native-case result in `review-native-earlier-start.json`:

```json
{
  "taskEnterDelivered": false,
  "taskEnterAt": "2026-10-02T10:40:08.578Z",
  "nativeStartAt": "2026-10-02T10:40:08.603Z",
  "afterEarlierStart": "submit",
  "outcome": "unknown",
  "persistedOutcome": "unknown",
  "lateEventsIgnored": true,
  "reloadedOutcome": "unknown",
  "keyReplayed": true,
  "retypedPrompts": 0
}
```

Additional start, end, failure and Stop reports after that task finalized changed no event count. Reload retained its unknown result, and keyed retry replayed without typing. The native helper ran with a synthetic review-only pane ID, exited 0, and its event file was removed. The existing task-browser suite also ran its new native-helper case using the isolated exact-source wrapper through `LOOM_TEST_EXE`; it was not skipped.

The remaining P1 differs in ordering. Its earlier provider events arrive before the write failure is observed, when the task still has no uncertainty to preserve.

## Regression checks

The nine-case cross-agent matrix passed against the actual production bundle in `review-outcome-matrix.json`. Claude, Codex and OpenCode each completed an ordinarily delivered task. Each ended a fail-before-delivery or delivered-but-lost-reply task as `unknown`, retaining `submit` and reason `submit-uncertain`. The disk matched every result. Extra `proof` and `token` fields in an agent-event payload granted no shell proof. OpenCode's cases used unnamed run start/end signals, rather than Claude-style prompt matching.

The deliberate behavior change is documented: an agent task whose Enter really arrived but whose write reported failure remains uncertain and ends unknown. The lost reply cannot be distinguished from non-delivery using a text-matched report. A shell's task token still proves its own line ran; the existing suite passed its lost-Enter-reply shell case with completion, uncertainty cleared, token correlation and exit 0.

Earlier fixes also passed independent checks:

- Concurrent window typing while Enter is held retains submit uncertainty after the later start and ends unknown. The reproduction records 16 intervening window writes and only the manually delivered prompt.
- A failed permission answer toggles `answerInDoubt` true; its successful retry toggles it false while retaining submit uncertainty. The task ends unknown.
- Combined submit/answer uncertainty survives a failed journal write, recovery through a whole rewrite, another failed answer and reload. Key replay types nothing.
- Whole-journal recovery retains a new reservation and key. Retry after reload replays without typing.
- The exact native reader salvages records before a torn UTF-8 tail. A genuinely unreadable journal refuses submit without changing the file.
- Delivered repeated prompts retain priority over failed Enter tasks. A later untracked prompt leaves the absent task unknown.
- Reported approval invalidates an old Stop; an unreported unnumbered dialog does not confirm completion.
- Queued changes covered by a whole snapshot do not undo its final state. Memory, journal and reload all retain `failed`.
- Watch exposes none of 1001 held unwritten events, preserves cursor 3, and sees restart event 4 without a gap. The existing suite also passed its 1100-event case and prune watermark across reload.

The seven-case prior-fix runner has inherited labels naming the old defects. Its assertions and result fields expect the fixed outcomes, and all seven passed. Those labels are not evidence of failure.

## Tests and limits

| Check | Result | Evidence in the isolated directory |
| --- | --- | --- |
| CLI, prompt, Git parsing and task unit checks | 64, 53, 46 and 93 passed, 256 total | `*-result.json` and corresponding logs |
| OpenCode plugin checks | Both provider versions passed | `plugin-result.json`, `plugin.log` |
| TypeScript | `tsc --noEmit` passed | `typecheck-result.json`, `typecheck.log` |
| Production frontend build | 34 modules built in 1.68 seconds; existing large-chunk advisory | `build-result.json`, `build.log` |
| Existing task-browser suite | All 33 passed, full 30-second idle waits enabled, native-helper case enabled | `taskbrowser-result.json`, `taskbrowser.log` |
| Independent positive browser scenarios | 21 passed, including the nine-case provider matrix | `review-outcome-matrix.*`, `review-prior-fixes.*`, counter/answer/native-start runners |
| Independent pending-write defect cases | Three reproduced with journal, reload and key-replay assertions | `review-pending-enter-final.*` |
| Exact-source native focused tests | 19 passed: 11 CLI/pipe, five helper, two drain/config and one journal reader | `native-results.json` and native logs |
| Actual compiled CLI on review-owned fake pipes | Reconnect, timeout and fatal JSONL error checks passed | `review-follow.json`, `review-follow.log` |
| OpenCode pending permissions | Partial reply leaves wait active with no resume; final reply resumes | `review-plugin-pending.json`, `.log` |

The task-browser checks include launch guards, Esc handling, quiet outcomes, failed answers, key replay, recovery reservations, torn reads, snapshot ordering, watch numbering and pruning. The independent native-start case was extended after its first pass to verify late-event rejection, reload and key replay; its final extended run passed. No new actionable persistence defect was found apart from persisting the false completion in the pending-write finding.

No live Loom pane was controlled and no real provider prompt or approval answer was submitted. No Claude dispatch, source fix, commit, merge, install, trust/security change or notification implementation occurred. Browser tests run the actual copied production bundle with fake providers and mocked native writes/storage. Native helper tests use review-only IDs or an isolated temporary directory. They do not measure live failure rates.

The exact helper wrapper adds only a `main` calling `claude_hook` and the actual extracted root/rollout functions needed to compile the source outside the full app. Focused Rust builds used the captured Cargo package version and existing serde_json artifacts read from the original target directory. Outputs stayed in the isolated review directory; no dependencies were installed. A reviewer preparation command had a syntax error before creating the helper wrapper; the preparation was corrected before the final native checks ran.

`scripts/task-live-check.mjs`, a full Cargo/Tauri app build, full UI suite, real process-crash and power-loss tests were not run. The previous report's UI suite stopped at its terminal-scroll precondition; this review does not claim that issue is resolved or that the full UI suite passes. This change does not claim responsive layout work. The requested lane is Sol6.1 Extra High; workspace tools do not provide independent model-selector attestation.

## Source and preservation

Target: `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. Comparison report SHA-256: `dd464ce7c301d128d36b7f8a58793b9acf8789b2ff7827d6267a795dde4bdeb9`.

The latest delta changes six files: `docs/cli-control.md`, `docs/loomctl.md`, `scripts/task-check.mjs`, `src/main.ts`, `src/task.test.ts` and `src/task.ts`. Native implementation files are unchanged from the preceding capture and were rechecked through focused compilation/tests. The captured worktree has 11 modified tracked files, four untracked implementation/test files, six untracked earlier reports and no staged changes. All finding locations refer to this current source.

Instructions read: `C:\Users\ayoub\AGENTS.md`, the local review-agent skill and required Unslop skill. Ancestors and the target tree were checked for additional `AGENTS.md`, `.agents` and `.codex` instructions; none were found for the target. The user expressly authorized this fresh report write. Other target access was read-only.

Evidence directory: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T103309Z`. `snapshot.json` contains the source inventory and hashes and 13 Git metadata hashes. `working.diff` records the full changes against HEAD. `fixes.diff` records the delta against the preceding preserved copy. Source and existing dependencies were copied for isolated tests; original ignored build/dependency directories were read-only inputs.

Before saving, all 141 captured tracked/untracked nonignored files, including all 15 earlier reports, matched their SHA-256 hashes. All 13 captured Git metadata files matched, including index, branch/HEAD, refs and configuration. Working and staged diffs and porcelain status matched the capture. Evidence: `pre-save-verification.json`.

The save exclusively creates a fresh timestamped UTF-8 report without BOM. Pre/post verification requires that it be the only new source-worktree file, performs strict UTF-8 readback and checks the saved hash. `saved-report.json` records the final path, byte count and SHA-256; `report-verification.json` records preservation and readback results.

Git reads use explicit worktree/git-dir paths and disabled optional locks. Normal discovery has an ownership ambiguity, and sandbox Git warns that the user's global ignore file is inaccessible. No trust or configuration repair was attempted. Preservation uses identical captured commands and the source inventory.

The review-only preview at `127.0.0.1:57390`, PID 164068, was identity-checked as Node running `serve-review.mjs`, stopped and confirmed to refuse connections. Review-owned fake pipes, OpenCode markers/session files and native helper events were cleaned up. The existing native-helper task test used its own temporary directory. No live Loom process was stopped. Evidence: `preview-cleanup.json`, `preview-port-cleanup.json` and runner results.
