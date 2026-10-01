# Loom CLI review for agent control

Fresh review of `f3385745b40f75de4e20d66e84708e8d64bcb702`, branch `loom/go`, on 2026-10-01 UTC.

The three findings from the previous review at `8f875ed` are fixed in the original reproductions. One P2 defect remains in the new shared retention helper: it orders eviction by request creation rather than completion. A long-running mutation can lose its retry record immediately when it finishes, and a shell receipt can lose its newly recorded outcome. Both failures were reproduced with current code in isolated fixtures.

I would use this version for explicitly targeted, supervised control. I would still avoid automatic retries under concurrent load until the completion-order defect is fixed. No new P1 or transport-security defect was confirmed in this pass. Real-provider signal continuity remains an untested assumption of the new source-pinning design, rather than an additional defect finding.

## Snapshot and scope

- Worktree: `C:\Users\ayoub\loom\loom\go`.
- HEAD: `f3385745b40f75de4e20d66e84708e8d64bcb702`, `Count agent turns from one signal and keep finished keys and receipts`.
- Comparison: `8f875ed1222230abdd70026ef40a4af8ffc1cb2c..HEAD`, six changed files, 132 additions and 41 deletions.
- Initial Git inspection: 2026-10-01T11:12:38Z. An 80-file snapshot of source, scripts, documentation and manifests was copied into a separate review directory and hashed.
- Git showed no staged or unstaged tracked changes. The seven untracked files were earlier review reports. Their hashes were recorded and they were preserved. No untracked CLI implementation was shown.
- HEAD and all 80 source hashes still matched at 11:21:00Z. The final verification file records the check after saving this report.

This review reread the current diff and implementation. It checked signal-source routing and reset, completed/pending retention, capacity guards, receipt lifecycle, generation and prompt checks, compatibility, input parsing, structured errors and related tests. The previous reports were background; their findings were not assumed to remain present.

Git used only the approved command-scoped exception `-c safe.directory=C:/Users/ayoub/loom/loom/go`. No global trust, configuration or security setting was changed. Optional locks and fsmonitor were disabled; diffs disabled external diff/textconv execution. The common repository configuration was checked for hook/filter/external-diff settings. Git warned that the user's global ignore file was unreadable but returned status successfully. Ignored dependencies/build artifacts are outside the bounded review.

Applicable `AGENTS.md` and the previously read local `unslop` writing instructions were followed. No implementation edits, commits, pushes, installs, live-pane commands, provider-session operations, live-agent messages or app lifecycle changes were performed. Only this requested report is added to the go worktree. Copied source, test logs, compiled test programs and uniquely named mock pipes stayed in the separate review workspace.

## Confirmed finding

### C1. P2: a request that completes late can immediately lose its newly finished result

Primary evidence: `src/cli.ts:82-87`. Key-cache callers: `src/main.ts:6917-6921`. Receipt callers: `src/main.ts:3405-3415`. Result lookup: `src/main.ts:6373-6374`.

`pruneSettled` now correctly counts only settled entries, fixing the pending-versus-finished budget problem. It still walks the original Map insertion order when deleting the oldest settled entries. The key and receipt maps insert records when work is submitted, and settling a record does not move it or record a settlement order. A request created early but completed last is therefore considered the oldest finished record, even though its outcome is the newest one.

The documentation promises the last 256 finished keys and the last 500 settled receipts. An immediate retry or late result query after the following sequences falls outside that promise even though no newer completion has occurred since the affected job finished.

#### Key reproduction

The fixture used the actual current CLI dispatcher, key cache, shared pruning helper and pane input queue with mocked native writes:

1. Submit keyed `send --no-enter` with key `slow-job` and text `slow mutation`. Hold its native write so the request remains pending.
2. Complete 256 newer, uniquely keyed `panes` requests. The old key correctly remains present while pending.
3. Release the old write. `slow-job` finishes last and returns success.
4. Immediately retry the identical `slow-job` request.

The first request's completion handler marked it done and pruned it immediately. The cache no longer held `slow-job` when its first call returned. The retry ran again instead of replaying; the native writer received `slow mutation` twice, and the second reply had no replay flag. This requires neither 256 completions after the mutation nor a Loom restart.

The completion-pruning callback is registered before the dispatcher awaits the result. The record can consequently be removed before its first answer is returned to the transport. A lost acknowledgement after a long operation leaves no retry protection, despite the operation having only just completed.

#### Receipt reproduction

The second fixture exercised real current shell receipt creation, `Pane.mark`, `finishReceipt`, pruning and receipt lookup:

1. Submit a shell receipt on p1. Process its `E` and `C` marks, but hold the final `D` so it stays pending.
2. Complete 500 newer shell receipts on p2. The original pending receipt correctly remains in the map.
3. Deliver p1's own `D;7`, recording its failure and exact exit 7.
4. Query the original token with `wait --receipt`.

Recording the newest outcome raised the settled count to 501. Pruning deleted that just-completed receipt because it had been submitted first. The query returned `No receipt` instead of the recorded exit 7. There were no completions after the affected command's final mark. A wait already holding the record may still finish through its local reference; a new result query or retry after a timed-out/disconnected wait cannot recover it from the map.

Both reproductions are one shared ordering defect. The key path risks duplicate input or other mutations after an uncertain acknowledgement. The receipt path removes the task outcome needed for reconciliation. The thresholds make this a concurrency/history-boundary problem rather than a failure of ordinary small workflows.

Smallest fix: order completed history by settlement, independently of submission order and pending records. Record a completion ordinal or maintain a completed queue, and evict the oldest completed/settled outcome when its own history exceeds the limit. Moving an entry to the completed end when it settles is another option, provided iteration and lifecycle-settlement handling are checked. Retain the separate pending-capacity guards.

Acceptance tests:

- Hold an old keyed mutation, finish 256 newer keys, then finish the old one. Its immediate retry must replay the original answer and produce one execution. An older completed result may be evicted instead.
- Hold an old shell receipt, finish 500 newer receipts, then deliver the old receipt's own outcome. A new `wait --receipt` must return that outcome. An older settled outcome may be evicted instead.
- Repeat with out-of-order successes, failures and lifecycle-interrupted receipts. Verify retention follows settlement order and pending records remain protected.

## Previous findings and current evidence

| Finding from the `8f875ed` review | Disposition |
| --- | --- |
| B2, a late task-A signal completes task B | Fixed for the reported cross-source duplicates. The bell-first/hook-late and hook-first/bell-late fixtures left B pending; B's own selected-source signal completed turn 2. The same two orders passed for OpenCode's OSC 99 and `opencode:waiting` hook path. The actual restart/launch method reset `turnSource` to undefined. |
| B1, pending keys consume the completed-key budget | Fixed for the original case. With 256 keyed sends still pending on one pane, a completed mutation on another pane survived an additional keyed read. Its retry replayed and produced one native write. Settled count is independent of pending count in `pruneSettled`. C1 concerns ordering among settled records, not this original counting defect. |
| B3, pending receipts evict a recent finished outcome | Fixed for the original case. A completed shell receipt remained present and returned exact success after 500 pending agent receipts were added. The map had 501 entries, rather than forcing the total down to 500. C1 concerns a much older submission whose outcome arrives last. |

Both capacity guards passed their checks. With 1024 keyed requests pending, a new keyed mutation was refused before dispatch, while a retry of an existing pending key still shared its one execution. With 2000 valid pending receipt records in the fixture, the actual send handler refused a new receipt send before any native write and preserved the existing records.

The five findings from `0a93ec2` also remained fixed in regression checks: protocol-2 refusal before keyed mutations, receipts rejecting replacement generations, prompt validation inside the input queue, exact trailing marker and pane/generation binding, and preservation of pending keys under newer traffic. Earlier framing, JSON failure, partial-key, generation, long-stdin, shell-exit and menu-revision safeguards also passed the retained current-source tests.

## Agent-consumer readiness and design limits

The current implementation supports the ordinary headless workflow: identify the known Loom endpoint, verify its worktree through `threads`, select exact IDs, create a terminal in that thread's directory, send opaque stdin text with a generation precondition, retain a receipt, inspect the outcome and handle numbered questions with their menu revision. Same-key overlap and ordinary shell/agent receipt paths passed isolated checks.

For an actual controller, the remaining assumptions and limits matter:

- Read `info`, pin the returned process pipe, and verify the intended repository/worktree in `threads`. The CLI does not enumerate every running Loom or include the profile path in hello. Avoid mutable current targets or pane positions.
- Retain exact pane IDs and observed generations. Use `--gen` on send/keys/choose and inspect the pane role/output before sending text. IDs, receipts and keys do not survive a Loom restart.
- Interpret exit status and JSON together. `sent:true`, `typed:true` or partial `pressed` can describe an operation that already affected the pane. A failed call does not undo a side effect. C1 currently prevents blind reliance on a just-finished key under the reproduced history pressure.
- The new turn counter pins the source that supplied the first counted turn for the entire launch. This solves the tested duplicate-source ordering, but requires that source to remain available for later completions and questions. Other sources still raise attention without completing receipts. Real-provider continuity, notification configuration and focus changes were not tested here. These are acceptance questions for provider validation, not an additional confirmed defect.
- Agent receipts do not establish task success or distinguish two callers whose prompts are answered in one turn. Read the answer and any question. State waits and the attention dot are observations rather than task-specific proof; an idle/quiet screen is still insufficient evidence of completion.
- Saved-session recovery can still require the GUI. Numbered-menu revisions cover only visible content and do not parse every unnumbered prompt. Review the complete action before approving it.

Transport identity and permissions are unchanged in this commit. The owner/SYSTEM pipe ACL and remote-client rejection at `src-tauri/src/control.rs:54-58,63-92` were inspected; no new bypass was confirmed. Same-account clients have broad control, and terminal output remains unredacted and untrusted. No live output or secrets were collected.

Verdict: the prior blockers have improved, and no new P1 defect was confirmed. Supervised, explicitly targeted control is reasonable within the documented limits. Reliable automatic retries and delayed result collection under concurrent work still need C1 fixed; unattended provider completion also needs real-provider validation of the pinned-source assumption.

## Tests and verification limits

Fresh checks completed against current source:

- 50 CLI helper checks and 30 prompt helper checks passed.
- Eight PowerShell prompt assertions passed in a separate process.
- TypeScript `tsc --noEmit` and Git whitespace checking for `8f875ed..HEAD` passed.
- Eleven offline isolated Rust tests passed, ten current CLI/pipe tests and the server request-validation test. The extracted server function and test were compared with current `control.rs` and matched exactly. The standalone current CLI built successfully.
- Twenty-eight isolated frontend scenarios completed using current declarations and methods extracted through the TypeScript AST. These cover previous fixes, both Claude/OpenCode signal-source arrival orders, restart reset, ordinary workflows, capacity guards and both C1 reproductions. A successful defect reproduction is not a correctness pass for that behavior.
- Eleven unique mock-pipe exchanges with the freshly compiled CLI completed their expected assertions. Protocol-2 peers were refused with `sent:false` before any mutation. A silent greeting timed out in 195 ms; uncertain command exchanges remained conservatively `sent:true`.

No application test failed unexpectedly. The orchestration tool rejected one call for a JavaScript syntax error before executing any checks; the call was corrected and the checks then ran normally. The Rust build reported the expected unused-function warning from the isolated request library, and Cargo warned that the home path could not be canonicalized. Builds/tests completed offline without installation or network access.

Not run: the full Tauri Cargo suite, clippy, `cli-check.mjs`, `ui-check.mjs`, `pty-close-check.mjs`, installer/release packaging or real Claude/Codex/OpenCode workflows. New app-level regression cases were inspected, but those scripts start or drive apps and were excluded from this review's no-live-control scope. Readiness/timing tests used controlled timer callbacks and mocked native operations, not a real five-second prompt wait. The receipt-capacity test seeded valid pending records rather than launching 2000 jobs. ACL enforcement was inspected in source, not tested with another Windows account. No claim is made that the reviewed source equals a currently running packaged Loom.

Evidence directory:

```text
C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20261001T1112
  changes.diff
  snapshot-hashes.json
  prior-report-hashes.json
  checks\agent-checks.mjs
  checks\frontend-results.log
  checks\cli-helper-results.log
  checks\prompt-helper-results.log
  checks\powershell-results.log
  checks\transport-checks.mjs
  checks\transport-results.log
  checks\transport-results.json
  checks\Cargo.toml
  checks\request.rs
  final-verification.json
```

Final verification checks strict UTF-8 read-back, report hash, current HEAD, all 80 source hashes and all seven previous report hashes. The review is a bounded snapshot; edits made after that final check are not covered. No implementation change accompanies this report.
