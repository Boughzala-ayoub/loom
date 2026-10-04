[P2] Wait for every overlapping manual Enter before releasing reports - src/main.ts:3915

`holdForEnter` returns a no-op when another Enter already holds the pane. Manual keyboard writes do not use the CLI's per-pane send queue, so two can overlap. The first write's completion releases every buffered report while the second write still has no outcome. A matching end report can then complete the second task with `uncertain: null`. When that Enter later fails, `manualFailed` calls `moveTask`, which ignores a task already final. The incorrect completion remains in the journal and can become a finish notification. Give each outstanding Enter ownership of the hold, or otherwise keep reports blocked until every relevant write has an outcome.

Independent served-bundle reproduction on Codex: first deliver an untracked prompt, keeping its end report delayed. Type a different manual prompt and the earlier words as two distinct manual inputs, holding both Enter writes. Emit the delayed end report naming the second input. No task completes while both writes are held. Resolve only the first write. The second task immediately completes with no uncertainty. Reject its own Enter next. It remains `completed`, `uncertain: null`, in both the API and task journal. The only prompt delivered by the fixture was the earlier untracked one. Evidence: `overlap-browser-result.json` and `overlap-browser.log`. Relevant failure path: `src/main.ts:1777`, `:3907`; final-state guard: `:3749`. This extends the original failed-Enter finding to overlapping writes. The single-write fixes pass.

[P2] Reset manual typing evidence when a pane changes launch - src/main.ts:3888

The new empty-input guard relies on `Pane.typed`, but a new launch resets commands, turn counters and screen state without resetting this flag. An unsent draft typed into the previous process therefore qualifies an empty Enter in the new process as a potential manual submission. `manualEnter` stamps that marker with the new generation, so the generation check cannot reject it. The next otherwise unclaimed OpenCode run creates a completed manual task even though the new process received no prompt. Clear the evidence at a launch boundary or bind it to the generation that received the input.

Independent served-bundle reproduction: type an unsent draft in OpenCode generation 1, deliver the fixture's process-exit event, use the application's Enter/restart and Start new controls, and reach generation 3 with an empty new input. Press Enter without typing anything in that launch, then emit its start/end report. Loom creates one `manual`, `completed` task despite zero prompts delivered in the new launch. Evidence: `generation-browser-result.json` and `generation-browser.log`. New flag: `src/main.ts:1514`; typing path: `:1766`; launch resets: `:1881`. The original same-launch empty-Enter/CLI-only-turn reproduction now passes.

## Assessment of the five previous findings

This follow-up reviews actual current files in ROOT `C:\Users\ayoub\Videos\claude\loom` and the affected bridge in `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`. Its reference is `docs/reviews/LOOM_MANUAL_TURNS_NOTIFICATION_POLICY_SOL61_XHIGH_REVIEW_2026-10-03_155201.md`. The original reproductions pass after the fixes, but the two new boundary cases above prevent a clean manual-tracking assessment.

| Previous finding | Independently verified result |
| --- | --- |
| P1 bridge ignores policy | The current v3 bridge suppresses muted events before the outbox and checks pending rows before sending. A muted v2 read is refused. The already running v2 sender is a separate deployment limit, detailed below. |
| P2 failed manual Enter | Claude and Codex end `unknown`, `uncertain: submit`, `reason: submit-uncertain`, including reports arriving while the write is pending. The journal preserves this. Overlapping manual writes still fail as described above. |
| P2 replay reverses mute | Off/inherit/off without another event retains the mute through task-journal replay. The current task tests preserve all same-number policy transitions. |
| P2 empty OpenCode Enter captures CLI turn | The original empty-Enter followed by `send --no-enter` and `keys enter` creates no task. Typing evidence carried across a launch still bypasses the guard. |
| P2 invalid notify mutates global | Six independent invalid-command variants leave effective policy, journal and saved workspace unchanged. Pane/value resolution now precedes applying changes. |

Explicit submit, ordinary send and valid manual input each produce one distinct completed task for Claude, Codex and OpenCode in the positive cases, with sources `submit`, `send`, `manual`. Current-launch correlation works, stale-generation reports leave the new task unfinished, and the records survive journal reload. Saved global policy, kind selection, new-pane defaults and pane overrides also survive a saved-workspace browser reload. These positive tests do not cover the two defective paths above.

## Remaining deployment limit from the original P1

Source changes do not replace code already loaded by a running Python process. Refusing future v2 source reads cannot stop mail that the old v2 sender previously queued. Its runtime drains pending rows before its next read and has no pre-send policy check. This is a remaining condition for end-to-end suppression, rather than a new defect in the v3 `deliver_one` implementation.

I independently loaded the exact bridge code from the preceding review capture, populated a temporary v2 store from an actual all-on batch produced by the new served bundle, and supplied a source that refused the next v2 read. The current policy decision for the queued completion was false. The old runtime made one recorder send call first, then attempted the refused source read. The row had been pending, not already sending or SMTP-accepted. Evidence: `external/independent-policy-boundary-result.json`, entry `old-v2-runtime-existing-pending`.

The new runbook correctly requires stopping v2 and starting v3 in a fresh directory. That transition must precede relying on mute controls for the existing queue. The UI's unqualified promise at `index.html:168` does not identify the active sender version. This reviewer did not stop, restart or inspect the production sender and does not attest which version it currently runs. Pending v2 mail must remain a reviewed migration item; it cannot be described as prevented merely because the new Loom refuses a later read.

This limit differs from the documented v3 SMTP race. The v3 sender checks each row before marking it sending. A mute after a true check can no longer stop that one send, and an already accepted message cannot be recalled. An independent recorder case confirms this expected boundary. A v3 row disabled before its check becomes permanently muted, survives store restart and is not released by re-enabling. A completion muted before ingestion creates no outbox row. The changed contract, probe and entrypoints require v3; v1/v2 state directories are refused without changing their database bytes.

## Scope and validation

ROOT was captured at 2026-10-03 18:49:22 UTC, HEAD `0af066ac19967072080daac7889d76c46b09f383`, branch `main`, ahead 66 and behind 0 against the recorded upstream. Existing dirty and untracked work was captured and preserved. The changed source, tests, metadata fixtures, trigger contract, entrypoints and documentation were inspected against the preceding capture. The external workspace is not a Git repository. Review instructions applied: global `C:\Users\ayoub\AGENTS.md`, local review-agent `C:\Users\ayoub\.codex\skills\.system\review-agent\SKILL.md`, and unslop `C:\Users\ayoub\.agents\skills\unslop\SKILL.md`. No subagents were used. Sol6.1 Extra High was requested; tool responses do not independently attest the runtime model or reasoning setting.

All test execution used the owned copy at `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-notification-review-20261003T184913Z`, copied cached dependencies, synthetic Tauri/provider events, temporary databases and fake senders.

| Check | Result and evidence |
| --- | --- |
| Current task tests | 134 checks passed, `task-result.json` and `task.log` |
| TypeScript checking and isolated Vite build | Passed, `typecheck-result.json` and `build-result.json` |
| Independent baseline and provider browser cases | 12 passed, `followup-browser-result.json` |
| Overlap reproduction and saved-workspace restoration | Both passed, `overlap-browser-result.json` |
| New-launch typing-evidence reproduction | Passed, `generation-browser-result.json` |
| Current bridge, entrypoint, setup and 24-cell provider matrix tests | 79 test outcomes passed after completing the isolated fixture copy, `external/bridge-tests.log` and `external/bridge-fixture-rerun.log` |
| Independent actual-v3 outbox/pending/re-enable/restart checks, SMTP race and old-v2 pending case | Four passed, `external/independent-policy-boundary-result.json` |
| Served notification controls | Global, finish-kind, new-pane and pane buttons work at 320/375/768/1024/1280, `notification-ui-result.json` |

The bridge run initially passed 78 tests and hit one missing historical fixture in the review copy. Copying only `loom-proposal/durable-watch.patch` and `evidence/loom-source-baseline.json` from the external workspace resolved that test on its targeted rerun. This was an incomplete isolated copy, not an application failure. No broad unrelated suite was repeated. The current fixture tests use fake SMTP factories and synthetic credentials, not credential input or external SMTP connections.

Fresh headless Chrome contexts loaded the served compiled bundle after confirming HTTP 200. Preferences fit horizontally at all five widths; 320 and 1280 screenshots were visually inspected. This is targeted control validation, not a whole-application responsive claim. The tested bundle is byte-identical to ROOT's ignored `dist/assets/main-DWG2S2cl.js`, SHA-256 `641a018537c7d47e0c19ab53c4e4c8cd39ca0f4fe4a3570080b3027f4e582381`. The owned review preview was stopped after testing.

Manual tracking keeps prompt matches, timestamps, launches and a boolean typing flag. The new uncertainty marker also contains no input text. Metadata validation rejects extra prompt/detail/secret fields, and notification emails retain the existing bounded payload without source, notify or response hash. This conclusion comes from the changed code and fixture validation; it is not an audit of every storage path. The author also documents same-launch Backspace-erased OpenCode input and nameless pending Enters overtaken by CLI Enter as remaining correlation limits. They were not treated as additional newly discovered defects here.

## Installer and live-runtime limits

Current installer: `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`, 2,056,411 bytes, modified 2026-10-03 18:39:39 UTC, SHA-256 `fc3e444d21158a3372accdab4737812ee71898d40ad7cd290b2a3037ea8922c3`.

Release `loom.exe`: 5,532,160 bytes, SHA-256 `9712efe0205cec0c2423b58cf4404b784235097e5e5198909ab56d13368da10d`. Release `loomctl.exe`: 303,104 bytes, SHA-256 `08288dda1e9423be99549b7397802ac4bb4ae860f8a406e809fa3d631694ce17`. These, both debug executables and ROOT dist were hashed and remained unchanged. The installer was neither built nor run by this reviewer. File hashes do not prove the currently installed or running application's embedded bundle.

No production pane commands, installed-app queries, live provider turns, real emails, credentials, production stores, sender restart or configuration changes occurred. The delegation's genuine completion callback at 18:41:52 and connected-PC checkpoint at 18:47 were supplied context, not independently re-proved. Native Rust/provider tests and the complete task/UI suites were not rerun. The counterexamples control event timing in the fixture; they prove the application paths, not the frequency of those timings in live providers.

## Preservation

The pre-save audit verified unchanged hashes for all 168 pre-existing nonignored ROOT files, including 28 prior reports; all 19 captured Git metadata files; and all 31 captured external files, including the two historical test fixtures. HEAD, index, refs, config, working/staged diff hashes and porcelain status were unchanged. Release/debug executables, installer and ROOT dist were unchanged as well.

The sole authorized ROOT write is this fresh timestamped UTF-8 report. Final verification requires it to be the only addition. Machine-readable evidence is in `pre-save-verification.json`, `report-verification.json`, `artifact-inventory.json`, `artifact-final-comparison.json` and `preview-cleanup.json` under the isolated evidence directory. No source fixes, commits, pushes, installs, trust/security changes, notification implementation or production process changes were made. Git's optional global-ignore read warning did not change the captured enumeration and that file was untouched.
