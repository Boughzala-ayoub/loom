[P1] Complete the sender integration before relying on notification switches - src/main.ts:7858

The new policy affects only `watch --metadata --policy` and `notify --check`. The current bridge still probes `loom-durable-events-v2`, reads `watch --metadata`, creates an outbox row for every finish/fail/blocked event, and sends pending rows without a policy check. Switching a pane off therefore does not prevent an email or the corresponding Ash wake-up, including an already queued unsent completion. This is an unfinished requested integration, rather than a regression in the deliberately preserved v2 contract; `docs/turn-tracking-and-notifications.md:72` explicitly admits the bridge is unchanged. Preserve compatibility as needed, but complete capability/contract migration, pre-outbox filtering and pre-send checking before presenting the requested suppression as working end to end.

Reproduction: in a fresh served-bundle context, turn a pane off, complete a task, and compare v3 `notify: false` with the retained v2 completion. Feed that actual v2 batch into the current copied bridge's real `Store.ingest` and `deliver_one`, replacing only SMTP with a recorder. It creates one outbox row and makes one send call. A second case captures a completion while enabled, disables and re-enables the pane, and obtains `notify --check: false`; the unchanged bridge still sends the pending row. Both cases used temporary stores and made zero network calls. Relevant external code: `email_bridge/bridge.py:28`, `:53`, `:219`, `:365`, `:439` under `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`. Evidence: `policy-v2-reproductions.json` and `external/actual-relay-policy-result.json`.

[P2] Propagate a failed manual Enter into the task's delivery uncertainty - src/main.ts:1752

`manualEnter` runs before `pty_write` resolves. Codex immediately creates a submitted task with `uncertain: null`; Claude retains a pending Enter that `adoptManual` can later turn into a task. The rejection handler calls `wrote(..., false)`, which changes only tasks already asking for approval, so neither new manual path records that the submit write failed. A subsequent matching report can complete the manual task even when the Enter never reached the PTY. Carry the write outcome through the pending Enter or created task, and apply the existing uncertain-submit rule rather than treating a later report as delivery proof.

Reproduction for both Claude and Codex: deliver an earlier, untracked prompt through `send --no-enter` and `keys enter`; type the same words using the real xterm keyboard handler; reject only this manual Enter's mocked PTY write; emit the earlier prompt's delayed start/Stop or turn-end report with the current launch and a later timestamp. Only the earlier prompt was delivered, the write-error toast appears, yet the new `source: manual` task ends `completed` with `uncertain: null`. Relevant new paths: `src/main.ts:3861` and `:3886`; failure handling: `:2363`. Evidence: the Claude and Codex entries in `feature-browser-result.json` and `feature-browser.log`. This independently reproduces the uncertainty problem on the new manual path; it does not claim the older explicit-submit guard regressed.

[P2] Preserve repeated policy transitions at the same event number - src/task.ts:306

Journal replay deduplicates each policy snapshot against every earlier snapshot with the same `at`. Changes made between task events share that number, so `off -> inherit -> off` loses its final `off` even though the intervening `inherit` remains. A completion that happened under the final mute then reads as enabled after replay, defeating the promised permanent suppression when notifications are re-enabled. Preserve transition order; an identical non-consecutive snapshot is not a duplicate record.

Reproduction through the served bundle: start a task, set its pane `off`, `inherit`, then `off` without another task event, complete it, and return the pane to `inherit`. The completion at sequence 4 has `notify: false` and `notify --check: false` before reload. Reloading the task journal changes its decision to `true`. A separate direct `writeJournal`/`readJournal` round trip uses snapshots off/on/off at 10 and on at 11: four snapshots become three, and event 11 changes from false to true. Evidence: `feature-extra-result.json` and `policy-roundtrip-loss.json`. This defect persists even after the bridge integration is completed.

[P2] Discard empty OpenCode Enters before adopting later turns - src/main.ts:3853

OpenCode bypasses the empty/suggestion check, leaving an unmatched pending Enter even when the user submitted nothing. `adoptManual` later accepts the first otherwise unclaimed run-start with an unlimited matching window (`src/main.ts:3884`). A later CLI-only turn can consequently become a `manual` task because of an earlier empty Enter, contrary to the documented exclusion of empty input and `send --no-enter` followed by `keys enter`. Record evidence of an actual manual submission, or otherwise discard an empty Enter, before associating a later run with it.

Reproduction: on an idle OpenCode pane with an empty input, press Enter through the real xterm keyboard handler; no task is initially made. Then successfully call `send --no-enter` and `keys enter` and emit that turn's current-launch start and end. The only manual action was the empty Enter, but Loom creates a completed `source: manual` task for the later CLI turn. The simpler empty-Enter/unrelated-start case also creates a task despite zero delivered prompts. Evidence: `opencode-empty-cli-result.json`, `opencode-empty-cli.log` and the OpenCode entry in `feature-browser-result.json`. Provider events were controlled in the isolated fixture; no live OpenCode run was invoked.

[P2] Validate the full notify command before changing global policy - src/main.ts:7780

The command calls `setNotify(change)` before resolving the requested pane or validating its value. A bad pane reference or bad pane setting therefore returns an error after persisting global policy and journal history. This makes a failed control command capable of disabling unrelated panes and permanently suppressing unsent notices. Resolve and validate every supplied argument before applying any policy change.

Reproduction: with global notices on, call `notify work:99 off --all off` in the three-pane fixture. The reply is unsuccessful with `work has 3 panes.`, but a subsequent `notify` query reports `all: off`. Evidence: `feature-extra-result.json`. No production setting was changed.

## Review scope and assessment

This is the dedicated report-only follow-up for ordinary/manual turn tracking and notification policy. It inspected the current ROOT checkout at `C:\Users\ayoub\Videos\claude\loom`, not a linked checkout, and compared its captured files with the previous review capture and `docs/reviews/LOOM_V2_SETUP_INSTALLER_SOL61_XHIGH_REVIEW_2026-10-03_094211.md`. The previous report remains intact. Its earlier clean assessment does not cover these newly changed manual-tracking and policy paths.

Capture: 2026-10-03 15:20:18 UTC. HEAD: `0af066ac19967072080daac7889d76c46b09f383`, branch `main`, ahead 66 and behind 0 relative to its recorded upstream. Existing dirty files, including `src-tauri/Cargo.toml`, were preserved. The complete changed code/test/UI/documentation paths relative to the prior capture were inspected. All 29 captured external bridge source/test/contract/documentation files match the prior capture; the missing sender integration is confirmed in its actual code, not inferred from the new Loom documentation alone.

Ordinary `send` and valid manual input each create one task for Claude, Codex and OpenCode in the positive cases, with distinct sources and completed task records surviving task-journal replay. The new paths retain prompt matches, launch and time rather than manual prompt text or keystroke logs. That does not establish safe correlation on the failed-Enter and empty-Enter paths above. The current completion hash and v2 metadata contract remain compatible with the current sender; v3 is opt-in and the sender cannot consume it as written. No recommendation to install or rely on the new notification switches is justified until these findings are addressed.

Instructions applied: `C:\Users\ayoub\AGENTS.md`, the local review-agent skill at `C:\Users\ayoub\.codex\skills\.system\review-agent\SKILL.md`, and the local unslop skill at `C:\Users\ayoub\.agents\skills\unslop\SKILL.md`. The requested standalone review report is the sole authorized ROOT write. No subagents were used. The delegation requests Sol6.1 Extra High; the available tool responses do not independently attest the runtime model or reasoning configuration.

## Focused validation

All execution used an owned isolated copy at `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-notification-review-20261003T152008Z`, existing cached dependencies, fake Tauri/agent events and temporary bridge databases.

| Check | Result | Evidence |
| --- | --- | --- |
| `node src/task.test.ts` | 130 checks passed | `task.log`, `task-result.json` |
| TypeScript `tsc --noEmit` | Passed | `typecheck.log`, `typecheck-result.json` |
| Isolated Vite build | Passed | `build.log`, `build-result.json` |
| Initial independent browser cases | 5 passed: two policy/source cases, failed manual Enter for two providers, empty OpenCode Enter | `feature-browser-result.json` |
| Additional independent browser cases | 5 passed: policy journal replay, invalid command mutation, valid send/manual turns and journal replay for all three providers | `feature-extra-result.json` |
| Concrete OpenCode empty-Enter/CLI-only turn | Passed reproduction | `opencode-empty-cli-result.json` |
| Current real bridge with recorder replacing SMTP | Both muted cases create an outbox row and make one fake send call; no network | `external/actual-relay-policy-result.json` |
| Pure notification journal round trip | Reproduces false-to-true decision | `policy-roundtrip-loss.json` |
| Served notification controls at 320/375/768/1024/1280 | Global, finish-kind, new-pane and per-pane buttons work; preferences fit horizontally | `notification-ui-result.json`, `notice-preferences-*.png`, `notice-pane-*.png` |

The server was confirmed to return HTTP 200 before fresh headless Chrome contexts loaded its compiled bundle. The isolated bundle is byte-identical to ROOT's ignored `dist/assets/main-B5kbEQAN.js`, SHA-256 `591d8b7e1677149815ead9dd8d73d946199183a34d4d8a1722c97f3f32a8fc36`; it contains the v3 capability marker. The 320 and 1280 preferences screenshots were visually inspected. These are targeted control checks, not a claim that every application view is responsive. The owned preview was stopped after testing.

The first sandboxed build could not read an ancestor dependency location; the isolated build then passed with approved access and no installation. A saved-workspace reload variant stalled in the mock fixture. The successful replay tests reload the task journal with the fixture's default workspace, so native saved-workspace/pane-setting migration is not established by them. Earlier fixture errors were corrected before recording the successful results above.

## Artifact and runtime limits

The current installer exists at `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`: 2,055,856 bytes, modified 2026-10-03 12:25:22 UTC, SHA-256 `b984f1a2105a60d658ac579cc5c11f30768e65f35afa5b74df2fda5beed5e29a`.

Current release `loom.exe`: 5,531,648 bytes, SHA-256 `45b1071f6d73316787b195a75bf99535667e9ec18aa10fecc2b4c607ab399cd8`. Current release `loomctl.exe`: 303,104 bytes, SHA-256 `7bb7004f5fd939c1c838eb089293784979f7958c22dcd1406c581b21f2683ce2`. These files and both debug executables were hashed and remained unchanged. The installer was not built, extracted, executed or installed during this review. The isolated frontend build matching ROOT dist does not prove the currently installed/running application's embedded bundle or its active native event paths match those files.

No live pane input, installed-app query, production sender restart/configuration change, credential access, SMTP connection or real email was attempted. The reported 12:27 genuine email and post-reboot sender state were context supplied by the delegation; this reviewer did not independently reproduce or alter them. Native Rust/provider suites, the full task/UI suites and unrelated CLI/Git/deletion suites were not rerun. Provider event timing in the reproductions is controlled and does not establish live-provider frequency. Old input-guard/U+00A0/ignored-file review conclusions were not expanded into a new whole-program claim.

## Preservation

The pre-save audit verified all 167 captured pre-existing nonignored ROOT files, including all 27 prior reports; all 19 captured Git metadata files; and all 29 captured external bridge files. Their SHA-256 values were unchanged. Branch, HEAD, index, refs and config hashes, working and staged diff hashes, and porcelain status were unchanged before saving. No source fixes, commits, pushes, installs, trust/security changes, pane commands, notification implementation or production process changes were made.

The final audit requires the same invariants and this fresh report to be the only new ROOT file. Machine-readable preservation results are recorded as `pre-save-verification.json` and `report-verification.json` in the isolated evidence directory. Artifact evidence is in `artifact-inventory.json` and `artifact-final-comparison.json`; preview cleanup is in `preview-cleanup.json`. Git emitted a sandbox read warning for the user's optional global ignore file; the same captured status/file enumeration was used throughout, and that file was not modified.
