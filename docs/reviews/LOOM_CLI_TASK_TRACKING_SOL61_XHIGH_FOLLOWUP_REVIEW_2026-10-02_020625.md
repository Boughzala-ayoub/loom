# Loom CLI task tracking follow-up review

Saved: 2026-10-02T02:06:25.570Z

Four P1 findings and one P2 finding remain. Six of the nine prior findings are fixed. The durable-reservation, repeated-prompt and Claude Stop fixes each leave a reproducible failure path.

## Findings

### 1. [P1] Include the pending reservation in whole-journal rewrites

Location: `src/main.ts:3615-3616`. Related: `src/main.ts:3607`, `src/main.ts:3643-3649`.

When any prior write failed, or the line count passes 5000, `journal()` ignores its supplied reservation line and serializes `typedTasks()` instead. The new task still has no events because `reserveTask()` only adds its accepted event after that write resolves. The rewrite therefore omits the new task and key, succeeds, and allows its paste and Enter. The subsequent submitted event has no base task on disk, so replay discards it. `submit` nevertheless reports `saved: true`. This preserves the duplicate-submit risk from old F1 on recovery and compaction paths.

Reproduction on the actual built page with isolated Tauri mocks:

1. Submit an older task, then reject its next journal write. Its record correctly becomes `saved: false`.
2. Restore journal writes and submit `new task in rewrite` with key `review-rewrite`. The recovery rewrite succeeds and the prompt is entered.
3. Read the journal through the actual `readJournal()`. The returned task is absent despite `saved: true`.
4. Reload and retry the identical keyed request. It returns a different task and enters the prompt again.

Observed task IDs were `3ffe754ae8d04508` before reload and `8f20e06112a84d7b` after it, with `replayed: false`. Include the pending reservation in the rewrite before acknowledging its durability. Evidence: `review-followup-browser.json`, case `F1 recovery rewrite loses a newly reserved keyed task`.

### 2. [P1] Recover valid journal lines before a torn UTF-8 tail

Location: `src-tauri/src/lib.rs:1331-1332`. Related: `src/main.ts:3787-3794`.

The native reader uses `read_to_string(...).unwrap_or_default()`. An append interrupted inside a multibyte character makes the entire file invalid UTF-8, so the reader returns an empty string even when every preceding task and event is intact. The frontend then treats the journal as new, loses durable keys and task IDs, and resets the event counter. The TypeScript parser's torn-line handling never gets the valid prefix. This is a newly identified defect in the task-tracking changes against HEAD, present before the latest fixes.

Reproduction:

1. Save a valid journal produced by a successful keyed submit.
2. Append an incomplete final event ending in the first byte `C3` of a UTF-8 character, after `{"event":{"seq":3,"detail":"caf`.
3. Run the exact native read expression against this review-owned file. It returns zero bytes. Parsing the valid prefix, or decoding with a replacement character before the line parser, retains the original task.
4. Supply the measured native result to the built page's mocked read boundary and reload. The original task lookup fails, `watch --after 0` returns `next: 0`, and the identical keyed retry enters the prompt under a new task ID.

Observed IDs were `f5fe204b57754cc7` and `d7c0ff5828ef43bd`. Recover complete valid lines without silently converting read or decoding failures into an empty ledger. Evidence: `review-torn-journal.json`, `review-owned-torn.tasks.jsonl`, and `review-journal-read.rs`. The Rust wrapper replaces only the AppHandle path lookup with an argv path; this was not a live Tauri command test.

### 3. [P1] Keep a repeated prompt from proving a failed Enter

Location: `src/task.ts:144-147`.

Occurrence counting fixes the old fan-out, but the completion router still chooses the oldest matching task without establishing which submit reached the provider. If task A's Enter failed and task B later delivers the same text, B's single completion finalizes A, while B remains open. Setting `uncertain: "repeated-prompt"` does not repair the false final outcome and also replaces A's specific `uncertain: "submit"`. A final `completed` task can no longer be corrected by a later report. Old F3 is therefore only partially fixed.

Reproduction:

1. On a mocked Codex pane, reject only A's Enter for `retry same text`. A stays `submitted` with `uncertain: "submit"`; no prompt entered the provider.
2. Clear the draft as a user would, restore Enter, and submit the same text as B with a different key. Exactly one prompt is recorded as entered.
3. Deliver B's launch-tagged completion with one matching hash and a fresh turn ID.
4. A becomes `completed` with `uncertain: "repeated-prompt"`; B stays `submitted`.

Observed IDs were A `a418b92332a14ce5` and B `2cf1a6bb5cdd4c94`. Preserve ambiguity when the report cannot identify a delivered occurrence; the provider's identical text alone cannot prove A's Enter. Evidence: `review-followup-browser.json`, case `F3 same-text later turn completes a task whose Enter never arrived`.

### 4. [P1] Invalidate a blocked Stop when Claude continues working

Location: `src/main.ts:3765-3769`. Related: `src/main.ts:3690`.

A Claude Stop now records a pending timestamp rather than ending the task immediately, but that timestamp survives continued work and subsequent approval requests. The completion check also runs before the approval-state guard. After another Stop hook makes Claude continue, a later permission dialog without the interrupt hint makes the sweep finalize the task from the earlier blocked Stop. `wait --task` then returns `completed` while the permission remains unanswered. Old F4 remains partially fixed.

Reproduction:

1. Submit a Claude task and deliver its prompt start followed by a Stop report.
2. Keep Claude visibly busy for one second, representing continued work after a blocking Stop hook. The task remains `working`.
3. Deliver `approval` for Write and show a permission menu with no `esc to interrupt` hint. The task becomes `approval`.
4. Send no further Stop. Within the next sweep it becomes `completed`, and `wait --task` returns that outcome.

The official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#stop-decision-control) permits Stop feedback to continue the conversation. Clear or supersede a Stop candidate when subsequent work disproves that stop, and do not use an approval pause as confirmation of it. Evidence: `review-followup-browser.json`, case `F4 blocked Stop followed by approval becomes completed`. The continued-work and dialog sequence was simulated, not exercised in a live Claude pane.

### 5. [P2] Persist failed-answer uncertainty even when the state stays approval

Location: `src/main.ts:2335`. Related: `src/main.ts:3659-3660`.

The new failed-answer path calls `moveTask()` with the same `approval` state and `uncertain: "answer"`. `moveTask()` applies the field in memory and returns before journaling when the state is unchanged. The task therefore reports `saved: true` while the journal still contains `uncertain: null`. A reload loses the delivery uncertainty that the approval fix added. This is a new persistence defect in the F7 fix; the original premature state transition itself is fixed.

Reproduction: submit and start a Claude task, deliver an approval request, then reject `keys ... enter`. The command fails and the in-memory task correctly remains `approval` with `uncertain: "answer"`, but its persisted record has `uncertain: null`. Persist changed audit fields independently of state changes, and make `saved` reflect those writes. Evidence: `review-followup-browser.json`, case `F7 failed answer and navigation preserve approval but uncertainty is not journaled`.

## Disposition of all nine prior findings

F1 through F9 refer to the findings in order in [the prior review](LOOM_CLI_TASK_TRACKING_SOL61_XHIGH_REVIEW_2026-10-02_005726.md). Its SHA-256 remains `ec0afd11d6c63b60ab7c42ca42f79238220d16f675a2f0fd386988f4f2490cc1`.

| Prior finding | Disposition | Independently checked result |
| --- | --- | --- |
| F1 P1, persist before typing or keyed acknowledgement | Partially fixed | Ordinary reservations block typing until written; rejected reservations type nothing; a crash after Enter but before its event retains the key. Recovery rewrites lose the new reservation, finding 1. |
| F2 P1, bind reports to the producing launch | Fixed | Native spawn supplies `LOOM_LAUNCH`; helpers and plugin include it; untagged reports are rejected; routing selects that generation's tasks. A late generation 1 Stop cannot complete a generation 3 task; a current Stop can. |
| F3 P1, repeated Codex prompts and completion identity | Partially fixed | One mention completes one task; two mentions can complete two; the same turn ID is ignored on replay. The native root-rollout filter now gates task reports and rejects subagent/ephemeral rollouts. TypeScript and Rust preserve word separators, so `edit foo bar` differs from `edit foobar`. A later delivered occurrence can still complete an earlier undelivered task, finding 3. |
| F4 P1, distinguish Stop from actual completion | Partially fixed | Stop becomes a candidate, and persistent busy output delays completion. Continued work followed by approval still consumes the blocked candidate, finding 4. |
| F5 P2, preserve prompt/Stop lifecycle order | Fixed | UserPromptSubmit no longer runs async. The helper writes before this synchronous hook returns; Stop and StopFailure remain async. Exact native configuration and drain tests pass. A slow helper can still fail to report, but the demonstrated async start/end reordering path is removed. |
| F6 P2, persist the prune watermark | Fixed | `writeJournal()` writes both `seq` and `pruned`; `readJournal()` restores both and startup restores the watermark. With 501 settled tasks, `gap: true` and first retained event 3 survive two reloads and whole rewrites. |
| F7 P2, advance approval only after delivered answers | Fixed, with a new audit defect | Failed Enter and arrow navigation preserve `approval`; successful Enter resumes `working`; failed Enter adds `uncertain: "answer"`. That new field is not journaled, finding 5. |
| F8 P2, preserve other pending OpenCode approvals | Fixed | The real plugin entrypoint emits no resume for the first of two replies and retains the waiting marker. The final reply emits resume and returns the task to working. Existing 1.x and 2.x plugin checks pass. |
| F9 P2, make follow errors valid JSON lines | Fixed | The exact compiled CLI emits compact timeout/fatal error lines with numeric `next`. Every line parses separately. Cursor resume after a socket drop requests 0, 1, 1 and prints events 1 and 2 once each. |

## Scope and verification

Reviewed `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. The capture completed at `2026-10-02T01:41:47.177Z`. The target has 11 modified tracked files and four new implementation/test files, with no staged changes. Both the full changes against HEAD and the delta against the prior captured source were inspected. The fix delta changes 13 non-report files, including provider hooks, CLI formatting, task tests, live-check scripts and documentation. Live-check scripts were inspected only.

The requested review lane is Sol6.1 Extra High. Runtime model selectors are not exposed to the reviewer. Applicable instructions read were `C:\Users\ayoub\AGENTS.md`, the local review-agent skill, Unslop, and Ponytail. No additional worktree or ancestor AGENTS.md was found in the checked repo paths. The user expressly authorized this new report; source edits and delegation were excluded.

All executions used a review-owned copy under:

`C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T014145Z`

| Check | Result | Evidence in that directory |
| --- | --- | --- |
| CLI unit checks | 64 passed | `cli.log`, `cli-result.json` |
| Prompt checks | 53 passed, including no-break-space cases | `prompt.log`, `prompt-result.json` |
| Git parser checks | 46 passed | `gitparse.log`, `gitparse-result.json` |
| Task rules and journal checks | 65 passed | `task.log`, `task-result.json` |
| Existing OpenCode plugin checks | Both provider versions passed | `plugin.log`, `plugin-result.json` |
| TypeScript | `tsc --noEmit` passed | `typecheck-result.json` |
| Production frontend build | Passed, 34 modules; existing chunk-size advisory | `build.log`, `build-result.json` |
| Existing task browser suite | All 18 checks passed, full 30-second idle cases enabled | `taskbrowser.log`, `taskbrowser-result.json` |
| Existing UI suite | 171 rendered states passed at 1280px; 80 writer trials gave 10 pre-paste refusals and 70 held Enters | `ui.log`, `ui-result.json` |
| Independent built-page scenarios | Nine browser scenarios and synchronous-hook configuration assertion completed | `review-followup-browser.mjs`, `.log`, `.json` |
| Exact native CLI source plus pipe tests | 11 passed; executable compiled for isolated pipes only | `loomctl-native.log`, `loomctl-review-tests.exe` |
| Exact helper with real extracted root lookup | Five focused provider tests passed | `helper-native.log`, `review-helper.rs` |
| Exact native event drain/config tests | Two passed | `drain-native.log`, `review-drain.rs` |
| CLI reconnect, timeout and fatal watch errors | Three fake-pipe scenarios passed | `review-follow.mjs`, `.json`, `.log` |
| OpenCode partial/final approval replies | Passed with review-only pane ID and launch 7 | `review-plugin-pending.mjs`, `.json` |
| Torn UTF-8 native read and browser recovery | Confirmed finding 2 | `review-torn-journal.mjs`, `.json`, `.log` |

The UI suite passed draft protection, revision guards, numbered questions, generation guards, failed writes, failed-Enter receipts, no-break-space handling, guarded deletion plans, concurrent writers and unrelated turns after a failed receipt Enter. The workspace and draft-reply screenshots were also visually inspected. The guarded deletion checks exercised mocks and did not delete source files. No new actionable regression was found in those paths.

## Limits

No live Loom pane was controlled. No real Claude, Codex or OpenCode prompt was submitted. No source fix, commit, merge, package install, trust/security change, notification implementation or external message was made. `scripts/task-live-check.mjs` and a complete Cargo/Tauri app build were not run. The successful Rust checks are isolated compilation and focused tests, not proof of the entire native app build.

Browser tests execute the actual copied production bundle, with fake agents and Tauri boundaries. Crashes are page reloads at held-write boundaries. The torn-file test uses an actual review-owned damaged file and the exact native decoding expression, then supplies its output to the mocked read boundary. No real crash, reconnect to a live Loom, power-loss durability test or protected-file deletion was attempted. Native tests read an existing serde_json dependency artifact without changing the original target directory.

Git was accessed with explicit worktree/git-dir paths and optional locks disabled because normal discovery reports ownership ambiguity. Sandbox reads also warn that the user's global ignore file is inaccessible. These were not repaired by changing trust or configuration. Preservation compares the same captured file inventory and Git outputs; ignored build/dependency artifacts in the original worktree were not used as writable test locations.

## Preservation

Before saving, SHA-256 checks confirmed that all 137 pre-existing nonignored tracked/untracked files, including all 11 prior reports, were unchanged. All 13 captured Git metadata files were unchanged, including the index, branch/HEAD, refs and configuration. Full working and staged diff hashes and porcelain status matched the capture. See `snapshot.json` and `pre-save-verification.json`.

The report save uses exclusive creation and UTF-8 without BOM. Its post-save verifier checks the same source/report and Git hashes again and allows exactly this new report in `docs/reviews` as the only added source-worktree file. The final preservation result and this report's SHA-256 are recorded in `report-verification.json` and `saved-report.json` beside the isolated evidence.

The review-only preview at `127.0.0.1:55811`, PID 150836, was identity-checked as the Node `serve-review.mjs` process and stopped. Its port then refused connections. Fake named pipes and review-specific provider marker/session files were cleaned up by their test runners. Existing reports and source were retained.

Assessment: the fixes improve normal submission and replay paths, but durable-key loss and false final completion remain release-relevant. Findings 1 through 4 should be resolved before relying on task outcomes for unattended submit/status/wait/watch operation.
