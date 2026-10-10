# Resumed independent review of manual turns and notification policy

No findings.

I found no additional confirmed defect introduced in the inspected fixes through `e72f435bccc5ad0d82b2bb90bf3f1d8bfecef104`. The two P2 findings in the October 3 19:10 follow-up are closed: overlapping Enter writes retain independent holds until each write has an outcome, and manual typing evidence belongs to the launch that received it. The newer startup-history and pruned-owner fixes also pass the relevant checks. The v4 contract preserves recoverable ownership holds at Loom's consumer boundary; the existing external v3 bridge still discards those holds permanently. Full application browser validation is incomplete because of the recorded timeouts below.

## Exact review scope

ROOT is `C:\Users\ayoub\Videos\claude\loom`, branch `main`. The final source capture completed at **2026-10-04T10:54:30.341Z**, HEAD **`e72f435bccc5ad0d82b2bb90bf3f1d8bfecef104`**, ahead 86 and behind 0 against the recorded upstream. It contains 172 pre-existing nonignored files, including 32 reports, and 20 captured Git metadata files. The pre-existing `src-tauri/Cargo.toml` status modification and untracked studies/reports were preserved. Working and staged patch hashes were both the empty SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; this does not remove the recorded Cargo status difference.

The earlier resumed capture at **2026-10-04T10:12:10.648Z** was at `8a968a8283ac29701f143733f6e9dc7128df82cf`. ROOT advanced during that review. Its preservation check detected changed `src/main.ts` and `scripts/task-check.mjs`; I did not write either file. I retained those results as evidence for that snapshot, captured ROOT again, inspected every subsequent source/documentation delta, and tested the latest affected paths. The intervening commits are `dab8c00`, `d83f318`, `0d41c2e` and `e72f435`. The final six changed files are `src/main.ts`, `src/task.ts`, `src/task.test.ts`, `scripts/task-check.mjs`, `docs/loomctl.md` and `docs/turn-tracking-and-notifications.md`; one additional prior report was captured.

The unfinished October 3 capture at **2026-10-03T23:22:31.655Z**, HEAD `0af066ac19967072080daac7889d76c46b09f383`, remains separate. Its tool interruption prevented a final report/save audit. No successful report write or recovered final diagnostic result is assumed from that interrupted turn.

References independently checked against actual files:

- `LOOM_PANE7_CLI_CONTROL_REVIEW_2026-10-01_211246.md`, SHA-256 `6fe099532c9f6d86837307704959e9bc2c2bcfd45978834699c0d013b9475209`.
- `LOOM_MANUAL_TURNS_NOTIFICATION_POLICY_SOL61_XHIGH_FOLLOWUP_REVIEW_2026-10-03_191035.md`, SHA-256 `bab98b0474a956ff71dee25c0f5c5c4f951c234f175f6ae4936563d053eac63a`.
- The later 01:39, 04:08 and 11:14 reports, including their concrete startup, pruning and consumer-hold scenarios. Their conclusions were treated as hypotheses, not as this review's test results.

Instructions applied: `C:\Users\ayoub\AGENTS.md`, `C:\Users\ayoub\.codex\skills\.system\review-agent\SKILL.md`, and `C:\Users\ayoub\.agents\skills\unslop\SKILL.md`. No repository-local instructions were found in the captured instruction scan. No subagents were used. Sol6.1 Extra High was requested; tool results do not independently attest the model or reasoning setting.

## Findings disposition

| Issue | Verified result and latest source location |
| --- | --- |
| Overlapping manual Enter releases another write's reports | Closed. `src/main.ts:3838` gives every Enter its own counted hold. Releasing the first leaves the second held; only the last release replays reports. `sweepTasks` also excludes held panes. The independent served-bundle reproduction at `8a968a` leaves the rejected second input `unknown`, `uncertain: submit`, including its journal record. Both mixed ordinary/manual and recovered-submit/manual cases pass. These function bodies are unchanged at the final capture. |
| Typing evidence crosses an OpenCode launch | Closed. `src/main.ts:1523` stores a generation number; `src/main.ts:3936` requires the current generation for unreadable-input adoption. The independent reproduction restarts from generation 1 to 3: empty Enter creates no task; newly typed input does. The affected function body remains unchanged. |
| Pending startup history publishes an empty migration marker | Closed. `journal` at `src/main.ts:3717` and `requireJournal` at `:4266` reject before history has loaded. `currentNotify` at `:4033` omits `owners` until then. `loadTasks` at `:4274` classifies legacy owners before setting `journalLoaded` and publishing migration. The final bundle test delays the read, clicks the restored pane's Off control, observes zero journal writes, releases the read, verifies the old completion is still held, and verifies Off works after classification and replay. |
| Pruning forgets an owner captured by watch | Closed for the reproduced interleaving. `src/task.ts:362` finds the latest explicit owner decision across retained history rather than inferring release from a filtered latest snapshot. Production-function tests capture a watch, prune its task with 500 newer settled tasks, publish a filtered policy snapshot, then resume. Held and muted owners remain suppressed in v3 and refused to v2; an explicitly released owner remains allowed. This check uses actual extracted functions and synthetic scheduling, not 500 real submissions. |
| An identical policy request acknowledges a pending failed write | Closed. `src/main.ts:4051` awaits the existing uncaught promise. Both success and failure paths, identical retry, full recovery write and replay pass. |
| A combined setting publishes an intermediate mute | Closed. `src/main.ts:4065` applies all global and pane fields synchronously before one snapshot and one await. A completion during the held write remains eligible before and after replay. |
| Temporary ownership hold is lost by a permanent-mute consumer | Addressed at the opt-in Loom protocol boundary, with a remaining deployment limit. `src/task.ts:379`, `src/main.ts:7959` and `:8059` expose `send`, `held`, `muted` and `none` in v4; v3 retains its exact boolean contract. Latest tests cover ingestion and pre-send holds, durable release, restart, cursor-independent recheck, replay deduplication and historical mutes. The external bridge was not upgraded and still consumes v3. Its discarded notices are not revived by owner release. The new documentation explicitly requires a v4 consumer upgrade. |

The five original October 3 cases also pass the independent `8a968a` reproductions: v2 refusal/current v3 mute enforcement; failed Claude/Codex manual Enter retaining uncertainty; equal-number policy replay; empty OpenCode Enter followed by CLI-only input remaining untracked; and six invalid notify variants leaving policy, journal and saved workspace unchanged. Positive Claude/Codex/OpenCode cases each keep distinct `submit`, `send` and `manual` tasks, reject stale launches and survive replay.

For the older pane 7 safeguards, the current `sendReply` at `src/main.ts:3579` still captures the counter before asynchronous preparation, rejects an intervening writer, and performs the final guard, echo baseline, expected counter and paste call synchronously. The post-paste counter check still precedes Enter. `docs/loomctl.md:484` explicitly says a later turn acknowledgement does not prove that the uncertain Enter or task reached the agent. Failed writes retain the receipt and uncertainty at `src/main.ts:7532`. Inventory still includes `--ignored=matching` at `src/main.ts:4987`. Prompt helper tests cover the supported U+00A0 separator and reject unsupported shapes.

## Validation evidence

Final evidence directory:

`C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-notification-review-resumed-20261004T105412Z`

All execution used owned copies, cached dependencies, synthetic Tauri/provider events, headless Chrome, temporary stores and recorder senders. No dependency installation was needed. The final built bundle is byte-identical to ROOT's captured `dist/assets/main-BVzZ09oE.js`: **711,823 bytes**, SHA-256 **`d14e1281dd3eb918b74e8f34c1b902d46a4ead7b8302fa09dcf5d67e7c31f190`**. This proves correspondence to the captured dist, not to an installed or running application.

| Check | Exact result and snapshot |
| --- | --- |
| Latest task helpers | 151 passed at `e72f435`; `task-result.json`, `task.log`. |
| Latest TypeScript and Vite | Both passed at `e72f435`; `typecheck-result.json`, `build-result.json`. Vite emitted its existing large-chunk warning. |
| Latest focused policy suite | 11 passed: 10 served-bundle groups plus the pruning production-function group. `TASK_REVIEW=all`; `taskbrowser-start.json`, `taskbrowser-result.json`, `taskbrowser.log`. This is not the full task suite. |
| Latest notification controls | Passed at 320, 375, 768, 1024 and 1280 px. Global, finish-kind, new-pane and pane controls change effective policy; Preferences fits horizontally. `notification-ui-result.json` and ten screenshots. All five Preferences screenshots and the 320/1280 pane screenshots were visually inspected. |
| Unchanged agent, CLI and prompt helpers | 48, 64 and 98 passed respectively in the `8a968a` capture. Those files are unchanged at `e72f435`; earlier `*-result.json` and logs. |
| Independent original/provider cases | 12 passed at `8a968a`; `followup-browser-result.json`. |
| Independent overlap/replay, generation, and mixed-write cases | 2, 1 and 2 passed at `8a968a`; `overlap-browser-result.json`, `generation-browser-result.json`, `mixed-browser-result.json`. Relevant production functions are hash-identical at the final snapshot; `function-comparison.json`. |
| External bridge tests | 82 passed in the October 3 23:22 capture; `external/bridge-tests.log`. A ResourceWarning about a test's unclosed pipe was emitted. The 31 external source/fixture files remain hash-identical through the final capture; these 82 tests were not repeated after restart. |
| Actual-v3 consumer boundary fixture | Four passed on resumed execution using the `8a968a` served-bundle samples and unchanged copied bridge: muted ingestion, pending mute/re-enable/restart, the expected post-check race, and old-v2 pending delivery before its refused read. `external/independent-policy-boundary-result.json` in the 10:12 evidence directory. Recorder calls only; no network sends. |

The final bundle also passed **five original CLI safeguard groups** at 1280 px. The owned `review-cli-focus.mjs` retains the original `scripts/ui-check.mjs` assertions and stops after its CLI block at source line 1107, before the unrelated whole-UI flow. All **80 queued-writer scheduling cases** prevented a combined submission: **10 refused before typing, 70 held Enter**. The same run passed input revisions/kinds, U+00A0 prompts, writers during paste/settling, retained receipts on failed paste/Enter, an unrelated turn after failed Enter, shell/agent receipt behavior, and ignored-only cleanup refusal plus plan/inventory rechecks. Git and deletion actions were mocked. Evidence: `cli-focus-extraction.json`, `cli-focus-result.json`, and `cli-focus.log`; the log was recorded verbatim from the completed execution output. No assertion or production source was changed.

## Failed runs and unrun limits

The full repository task-browser run at `8a968a` exited 1 after 64 passing checks. Its failure was `page.goto` exceeding 15 seconds while waiting for `load`, at `scripts/task-check.mjs:2398` via `reboot:198` and `boot:144`. Passing checks already included the overlap and launch fixes, 510-receipt retention, the 24-cell provider matrix, slow paste and hidden Codex run-state cases. The optional native helper was skipped because the isolated copy had no executable. No full-task pass is claimed for the latest snapshot.

The augmented whole-UI attempt at `8a968a` exited 1 at 320 px waiting for `#dashboard-bulk-done` to be visible, enabled and stable. Its added preview connection, key persistence, refresh and keyboard-reopen check had passed. An unmodified whole-UI retry then exited 1 at `scripts/ui-check.mjs:1137`, waiting 60 seconds for `?restore` to reach `load`. A separate notification-control attempt at that snapshot also timed out at initial navigation; the final sequential five-width control run succeeded. These failures are retained in `taskbrowser.log`, `uifocus.log` and `ui.log` in the 10:12 directory. Their cause is not established as an introduced product defect. They prevent a clean whole-application UI claim.

The earlier October 3 diagnostic run has no recovered final result. It is not counted as a pass. A first resumed Python invocation preceded completion of a fixture copy and failed to find that owned fixture; after confirming the copy, the unchanged boundary fixture passed all four cases. This setup error is not an application finding.

Native Rust/provider integration, crash/reconnect behavior, installed app identity, live agent turns, production journals and sender deployment were not tested. The v3 relay's pre-send check cannot recall a message already accepted or stop a send after a true check. An old v2 process can send previously queued mail before asking Loom for another batch; its recorder reproduction remains valid. ROOT source changes alone neither replace that running process nor upgrade the separate sender worktree to v4.

## Preservation and cleanup

The pre-save audit at **2026-10-04T11:02:40.667Z** verified all 172 pre-existing ROOT file hashes, all 32 prior reports, all 20 captured Git metadata hashes, unchanged HEAD/index/refs/config, unchanged working/staged diff hashes and exact porcelain status. All 31 external files were unchanged. Six selected ignored build artifacts, including release/debug binaries, installer and ROOT dist, also matched their baseline. `pre-save-verification.json`, `artifact-final-comparison.json` and the snapshot manifests contain the hashes.

The first final save attempt stopped before writing because the protected build audit detected external changes. A fresh read at 2026-10-04T11:16:12.248Z confirms 3 changed native artifacts. The source/Git/worktree checks still pass, and ROOT dist plus both debug binaries remain hash-identical. These files were not built, executed, installed or rewritten by this reviewer. Current bytes, modification times and baseline/current hashes follow; they do not establish the installed app's identity.

| File | Current bytes and modified UTC | Baseline SHA-256 | Current SHA-256 |
| --- | --- | --- | --- |
| src-tauri/target/release/loom.exe | 5533696; 2026-10-04T11:09:31.432Z | 421ff715f0d70f874834d19c9f69b213ce750a381286426ddcdaad44c8d8890b | 242b5b666b3985d0c24e35db59d0052a7d10dceaf0bce325b4d0aade4f5c3d08 |
| src-tauri/target/release/loomctl.exe | 303104; 2026-10-04T11:06:29.555Z | cad0f8943d5758e848e1ba86fb5507564c7611bfeec49bd9dd40ef33534c336d | f053647a3370459e75282893e72efee0cd964fb2b90dae28ed3a8d12d5116495 |
| src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe | 2057811; 2026-10-04T11:09:31.339Z | 890fcc061a157740f1626ca9578963d5411f535ed0b55b8b043f06a8e7bed85a | 5507c6843757c6556aa83326b2398754a009cf19bd2455af3f301e0d9e7a6999 |

The separate worktree `C:\Users\ayoub\loom\loom\builtin-notification-sender` remained clean at **`0af066ac19967072080daac7889d76c46b09f383`**. Its 148 file hashes, five captured Git metadata hashes, `.git` pointer and file enumeration matched. No merge, rebase or sender implementation was performed. Its earlier foundation differs from reviewed main; any subsequent sender work must reconcile that difference separately.

The old interrupted preview PID 231224 was absent when checked, so no stop was attempted. The 10:12 review preview PID 246776 was stopped at 2026-10-04T10:58:24.3389942Z after validating its process name, command line, creation time and port 55091. The final isolated preview PID 228360 was stopped at 2026-10-04T11:12:18.7153397Z after the same ownership checks for port 65040; its listener was then confirmed closed. No other application process was stopped. Cleanup evidence is retained in each capture's preview-cleanup.json.

This timestamped report is the sole authorized new ROOT file. The exclusive write and immediate strict UTF-8/no-BOM read-back check require it to be the only addition and recheck source, prior reports, Git metadata and external files. The resulting path, digest and preservation evidence are stored in `saved-report.json` and `report-verification.json`. No source fixes, staging, commits, installs, credentials, live email, live pane inputs, agent prompts, trust/security changes or notification implementation occurred.
