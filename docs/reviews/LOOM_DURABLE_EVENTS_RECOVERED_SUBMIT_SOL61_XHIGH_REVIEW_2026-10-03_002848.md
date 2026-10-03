# Loom durable events and recovered submit review

Saved: 2026-10-03T00:28:48.496Z.

## Findings

### 1. [P2] Retain the receipt while its held task remains recoverable - src/main.ts:7161-7163

The new NotShown path keeps the task open for a later Enter, but its receipt has already been marked `unsent` and counted as settled at `src/main.ts:7147`. The existing `receiptSettled` and `keepReceipts` functions at lines 3574-3578 therefore put it in the last-500 settled history while its task remains accepted. After 500 later settled receipts, the original receipt is removed. `enterTask` then gets no receipt at lines 3772-3773 and silently proceeds. The task can complete under its original ID, but `receipt <original ID>` remains unavailable, so recovery no longer reconciles both records as intended.

I reproduced this in the freshly built production frontend over Tauri mocks. Submit a prompt whose paste reaches the fake provider but is not yet drawn, leaving `accepted`, `uncertain: "enter"`. Create 500 later `send --receipt` calls on other panes whose Enter is held back. The original task still has its recoverable input, but its receipt is unavailable. `keys <original pane> enter --task <original ID>` succeeds and a genuine matching Claude start/Stop completes the same task. The prompt is delivered once. Its receipt is still unavailable afterward.

This is an introduced lifecycle mismatch. Before the patch, NotShown finalized the task as failed, so the unsent receipt was legitimately settled. Now the task remains open, but the receipt retains that old classification. The defect loses receipt delivery evidence; it does not lose the task's durable completed event or duplicate the prompt.

Suggested fix: keep the receipt pending and protected from settled-history pruning while its Enter remains recoverable, then settle it when recovery finishes or the pane/input invalidates it. Establish that status before any pruning call in the NotShown catch. Clear the held status on the same cancellation, failure and changed-input paths that end the task. Do not rely on the optional receipt lookup during recovery to reconstruct lost evidence.

| Retention reproduction step | Original task | Original receipt |
| --- | --- | --- |
| Paste drawn late, Enter held | accepted, uncertain enter | Available, typed/not submitted |
| 500 later settled receipts | Still recoverable | Pruned |
| Explicit original-task Enter | Same task submitted | Still unavailable |
| Matching start and Stop | Same task completed, prompt delivered once | Still unavailable |

Evidence: `held-receipt-retention.json` extracts the actual retention functions and uses the actual `pruneSettled`; `review-retention-browser.json` reproduces the full path in the current served bundle. The frontend reproduction's original task ID is `a45dcdbe83014e60`. All panes and provider writes in that test were isolated fakes.

I found no second actionable defect in the reviewed changes.

## Scope and instructions

Target: root `C:\Users\ayoub\Videos\claude\loom`, branch main. Capture completed at `2026-10-03T00:05:49.077Z`, HEAD `41f9bc539f09d74bd5037110689f77241b78bd9e`, 64 commits ahead of origin/main, no staged changes. The capture includes 163 pre-existing nonignored project files, 24 prior reports and 17 Git metadata files.

The latest commit `41f9bc5` records the previously reviewed Codex composer changes. The preceding relevant commits are `c47a326`, task tracking, and `1858588`, CLI safety fixes. The notification, held-Enter recovery and Claude working-line changes reviewed here are uncommitted. Changed semantic paths are `src/main.ts`, `src/task.ts`, `src/prompt.ts`, `src/prompt.test.ts`, `scripts/task-check.mjs`, `src-tauri/src/lib.rs`, `docs/loomctl.md` and the new `src/task_event_gate.ts` and test. The pre-existing dirty Cargo.toml was preserved and excluded from semantic review.

I read the complete working diff, the relevant recent commit history, surrounding journal/write/task-routing code, the latest task-tracking report, the prior CLI-control reports and both Codex composer reports. I compared the notification path with the prepared `durable-watch.patch` and read the bridge runbook and trigger contract supplied by the parent. Those external context files were copied read-only into the evidence directory. This review does not certify the whole external mail bridge implementation.

I read the applicable `C:\Users\ayoub\AGENTS.md`, local `review-agent\SKILL.md` and required `unslop\SKILL.md`. The target ancestor/tree scan found no additional applicable AGENTS.md or local .agents/.codex instructions, excluding Git, dependency and generated directories. No source fixes or delegated reviewers were used.

Requested review lane: Sol6.1 Extra High. The tools do not independently attest the runtime model or reasoning setting; this report does not certify those settings.

Evidence directory: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-notification-review-20261003T000525Z`.

## Durable event path

The new watch path at `src/main.ts:7595` has no 100 ms journal-polling loop. It waits on `TaskEventGate` with one deadline timer. The gate registers the listener and checks readiness again, closing the initial-check/registration race. Notifications with no qualifying event leave the waiter asleep; completion or deadline removes its listener.

`journal` publishes the durable sequence watermark and notifies only after `task_journal_write` succeeds. `reserveTask` also notifies after joining its already-written accepted event to the in-memory task, covering the separate race between disk acknowledgment and reservation visibility. In the built-frontend test, watch returned nothing while the reservation write was held, then returned its accepted event after the mock journal commit. The event was present in the committed journal before it was exposed.

The native function at `src-tauri/src/lib.rs:871-879` calls `sync_all` after append and after writing the replacement file, before acknowledgment and rename respectively. Five checks exercised the exact captured function with a reviewer-owned path shim: initial append, append, replacement of an existing journal, append failure and rewrite/rename failure. The production source was not changed. This proves the tested file-operation results, not power-loss durability on every filesystem or a full Tauri integration.

`watch --metadata` returns the actual `loom-durable-events-v1` capability marker and exactly `seq`, `task`, `pane`, `generation`, `state`, `at` for each event. It omits prompt/report detail. The owner reference for a task-specific watch is retained even if that task is pruned while waiting. Replay still filters by the durable watermark, preserves global numbering through journal load, and reports reset/prune gaps. A gap with no event waits until the bounded deadline in the current implementation, rather than causing legacy task-follow calls to spin. The native CLI's finite-watch renewal and one-second disconnect retry are unchanged.

The 250 ms Rust hook-file scan remains at `src-tauri/src/lib.rs:1519`. The 500 ms task sweep also remains while tasks are open. The patch removes the new-path journal polling; it does not make every local Loom lifecycle operation timer-free. These are deterministic local processes, not an AI watcher.

## Held Enter and task identity

The normal recovered path passed for all three fake providers. A delayed screen echo leaves the task accepted with uncertainty enter. Explicit `keys <pane> enter --task <id>` presses only Enter, reuses the task/receipt ID, sends no second paste, and feeds the existing journal/watch stream. A plain lone Enter can adopt the held task when the same safety checks pass.

The checks run inside the pane's serialized input turn. They fence by task ID, pane ID, generation and the input counter, reject numbered questions, and require a readable draft for Claude or Codex. OpenCode has no supported input reader, so its recovery does not gain that draft check. That difference is deliberate in the current code and should be covered in the parent's live acceptance test.

I independently checked a queued send arriving behind the unseen paste. It changes the input count; recovery refuses before pressing Enter. Existing tests also cover a window writer during the paste and a restarted held task. Neither the old queued-writer gap nor failed-Enter uncertainty was reintroduced.

After a recovered Enter succeeds, the task records submitted before a genuine agent report arrives. A busy screen may give working with screen correlation, as in the existing task implementation. That is not proof of a completed task. Claude completion still needs the matching prompt start and Stop/idle combination; Codex's reported turn input names the prompt at its end; OpenCode uses its first run after Enter and therefore has sequence correlation rather than a text identity proof.

Unrelated text starts and old-generation Stop signals did not complete the tested recovered Claude task. Repeated approval reports produced one approval transition and metadata omitted the private detail. Resume followed by a genuine failure left the task final failed; later Stop reports did not change it. A recovered Enter write failure retained submit uncertainty through matching start/Stop, an unknown final outcome and journal reload. A later turn does not prove that failed Enter arrived.

Receipts remain pane-turn acknowledgments under the pre-existing policy. They are weaker than task correlation and should not be used as proof that a particular prompt started or completed. The patch updates a present receipt's write evidence on recovered Enter; it does not turn the next pane turn into task-specific proof. Use the durable task stream for the bridge's outcome identity.

The supplied live IDs, original task `3cdb43e19fd7404e` and follow-up `824a793213c14b09` on pane `murigdmg-69`, were context only. I did not inspect or mutate those runtime records. Final historical tasks remain immutable; prospective recovery coverage is not evidence that an old failed or unknown task was retroactively reconciled.

## Independent validation

| Check | Result |
| --- | --- |
| Prompt/input and Claude working-line units | 98 passed |
| CLI units | 64 passed |
| Git parsing/loss-inventory units | 46 passed |
| Task units | 99 passed |
| TaskEventGate units | Seven passed |
| Total units | 314 passed |
| TypeScript `tsc --noEmit` | Passed |
| Isolated production Vite build | Passed; standard large-chunk warning |
| Full current task browser suite | 44 passed, real-time quiet cases enabled |
| Focused notification/recovery browser cases | Seven passed across Claude, Codex and OpenCode |
| Receipt-retention source and built-frontend reproductions | P2 confirmed in both |
| Exact native journal function checks | Five passed |
| Independent pending paste/Enter cases | Four passed |
| Independent buffered/queued-write cases | Five passed |
| Independent delivery-outcome matrix | Nine passed |

The 18 prior lifecycle cases cover accepted tasks during pending writes, failure/approval buffering, distinct queued prompts, lost replies, journal recovery, reload and keyed replay. Successful delivered writes complete; failed/lost Enter replies remain uncertain. The new Claude 2.1.288 working-line case also passed the real 31-second test, keeping an active turn from being finalized by an obsolete Stop or quiet deadline after the older esc footer disappeared.

The browser checks used a fresh production bundle served with HTTP 200 in headless Chrome contexts at 1280x900, over Tauri mocks and real xterm cells. All build/test artifacts stayed in the isolated copy. The native hook wrapper was freshly compiled from captured root helper code using existing Rust and cached root serde_json artifacts. No dependency install or full Cargo/Tauri build was performed.

Logs and structured evidence include `*-result.json`, `*-browser.log`, `review-notification-browser.json`, `review-retention-browser.json`, `held-receipt-retention.json`, `native-journal-result.json`, `review-pending-enter-fixed.json`, `review-buffer-adjacent.json` and `review-outcome-matrix.json`. Their runners are retained.

## Build artifacts and live limits

Read-only artifact inspection found the release Loom executable, CLI executable and NSIS installer. The installer is `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`, 2,052,100 bytes, modified `2026-10-02T23:59:21.098Z`, SHA-256 `ddd4ca150f2e2df733442ee0a0809753248bd58edfe5f05bf0861d575bfdbe3e`. The release Loom executable is 5,526,528 bytes, modified `2026-10-02T23:59:21.141Z`, SHA-256 `8996b2a45888310b79c511fce431b624b0005f8f1a41d25c8dc541e10972a86a`.

The root ignored `dist/assets/main-Co2HwNZM.js` contains the capability literal. The newly built isolated bundle exercised here contains it too. `artifact-inventory.json` records all inspected artifact hashes and timestamps. File existence, versioned names and timestamps do not prove which embedded bundle the running app loaded. No installer or production executable was run, and no install/restart was performed by this reviewer.

No live Claude, Codex or OpenCode pane was controlled or prompted. The full UI/layout suite, all-width screenshots, full Cargo/Tauri tests, power-failure fault injection, and real-provider lifecycle/email tests were not run. No responsive-layout claim is made.

The parent reports a successful synthetic PC-to-second-Gmail-to-primary-filter-to-Ash proof and no active AI watcher. This reviewer did not repeat that proof. A real Loom lifecycle reaching Ash end to end is still untested here. The bridge contract and runbook describe the intended metadata/outbox/cursor route; reading them is not evidence that production mail ingestion or delivery ran.

The default sandbox initially blocked esbuild's ancestor lookup; the isolated build passed after approved escalation. The first native-hook compile referenced the old worktree cache and did not resolve the dependency in that execution. It passed after using the existing root cache. Initial failures are retained in `build-sandbox-blocked.log` and `review-hook-initial-failure.log`. No application code or repository test was edited for these corrections.

## Response-hash dedup handoff

The approved response-hash requirement is future work and is not scored as an unimplemented defect in this review. The current native metadata carries no response body/hash. Existing event sequence and turn dedup do not establish response-content dedup across restart.

The parent should send Claude this report together with the requested local dedup requirement: key a response digest by pane plus task/attempt identity, persist it across restart, and suppress repeated idle observations of the identical response for that same attempt. Include generation and the bridge's journal/attempt namespace where needed to fence reused pane identities. Two different tasks or attempts that both answer Done must each deliver their own outcome. Do not collapse them with a global response hash. Keep response content out of the metadata-only email payload unless its contract is separately changed.

After fixes, the parent controller owns the authorized live three-harness and real email acceptance test. It should correlate the original task, pane, generation, bridge attempt, event ID and one Ash response without typing the same prompt again. This reviewer did not reprompt Claude or start a watcher.

## Preservation and report readback

Before saving, all 163 captured pre-existing nonignored project files matched their hashes, including all 24 prior reports and the dirty Cargo.toml. All 17 captured Git metadata files matched, including HEAD, index, refs, logs and configuration. Branch/HEAD, working diff and staged diff matched the initial capture. Git warned that the sandbox could not read the global ignore file; the same read-only commands and direct hashes were used for the checks, and no ignore/configuration file was changed.

The report is exclusively created under root `docs/reviews` with a fresh timestamp. The save procedure repeats preservation checks before and after, requires the report to be the only added project/status path, reads it back as strict UTF-8 without a BOM, and compares it to an identical evidence copy. `saved-report.json`, `report-verification.json` and `final-readback.json` record the exact path, size, SHA-256 and preservation results.

The reviewer-owned Node preview was stopped after checking its PID, executable and script identity, then its port refused connections. No Loom process was stopped. Ignored dependency/build trees were read or copied but did not receive a full hash inventory. No source fix, commit, push, merge, install, trust/security change, production mail, live-pane command or notification implementation was made by this reviewer.
