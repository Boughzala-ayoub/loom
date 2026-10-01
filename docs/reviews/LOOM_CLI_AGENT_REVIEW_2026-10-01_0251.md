# Loom CLI review for agent control

Fresh review of `8f875ed1222230abdd70026ef40a4af8ffc1cb2c`, branch `loom/go`, on 2026-10-01 UTC.

All five findings from the previous review at `0a93ec2` are fixed in the isolated rechecks. Three additional defects were reproduced in current code. The remaining problems concern delayed agent notifications and the promised retention of completed keys and receipts. I would use this version for explicitly targeted control that checks outcomes and stops on uncertainty. I would not yet trust it for unattended task completion or automatic retries under concurrent load.

## Snapshot and review boundaries

- Worktree: `C:\Users\ayoub\loom\loom\go`.
- HEAD: `8f875ed1222230abdd70026ef40a4af8ffc1cb2c`, `Hold loomctl's retry keys and receipts to their boundaries`.
- Comparison: `0a93ec29dc6bf78a7b821d7ba1d0aad6a4c3a341..HEAD`, seven changed files, 239 additions and 69 deletions.
- Initial Git inspection: 2026-10-01T02:51:18Z. An 80-file snapshot of source, scripts, documentation and manifests was copied into a separate review directory and hashed.
- No staged or unstaged tracked changes. The six untracked files shown by Git were previous review reports. Their hashes were recorded and they were preserved.
- At 03:00:20Z, HEAD and all 80 source hashes still matched the snapshot. Final verification is recorded in the evidence directory after saving this report.

This pass read the current diff and related implementation, rather than saving the previous findings unchanged. It reviewed the five fixes, request/result retention, turn and receipt correlation, input queue behavior, lifecycle resets, protocol compatibility, JSON errors and the new tests. No relevant untracked CLI implementation was shown.

Git used only the approved command-scoped exception `-c safe.directory=C:/Users/ayoub/loom/loom/go`. No global trust, settings or security configuration was changed. Optional locks and fsmonitor were disabled; diffs disabled external diff/textconv execution. The common repository configuration was checked for hook, filter and external-diff settings before test work. Git warned that the user's global ignore file was unreadable but returned status successfully. Ignored build/dependency content is outside this bounded review.

Applicable `AGENTS.md` and the previously read local `unslop` writing instructions were followed. No source fixes, commits, pushes, installs, live-agent messages, live-pane commands or app lifecycle operations were performed. Only this requested report is added to the go worktree. Test programs, copied source and unique mock pipes stayed in the separate review workspace.

## Confirmed current findings

### B2. P1: a delayed duplicate notification can complete the next agent task

Evidence: `src/main.ts:1737-1740`, `src/main.ts:2088-2094`, `src/main.ts:3407-3408`, `src/main.ts:6633`, `src/main.ts:7249-7254`. The marker path is polled every 250 ms at `src-tauri/src/lib.rs:1432-1436`.

The generation fix correctly binds a receipt to one process. Within that process, however, a notification is treated as a new turn whenever input happened after the last counted signal. There is no source or turn identity distinguishing a second notification for task A from a completion for task B. `turnReceipts` records an outcome for B as soon as that counter advances.

The source explicitly anticipates a bell and a hook for one turn. Both terminal notifications and the separate `wakes` event enter `Pane.wake`. The current duplicate check works when no new input lies between the two signals; it fails when the controller submits its next task after the first signal but before the delayed second one.

The deterministic fixture used the current send, wake, receipt and wait handlers with a controlled clock:

| Time in fixture | Event | Result |
| ---: | --- | --- |
| 1000 | Send task A with a receipt | A waits at turn baseline 0 |
| 1010 | First completion notification for A | Turn 1 is recorded; A's receipt completes |
| 1020 | The same caller sends task B with a receipt | B waits at baseline 1 |
| 1250 | Delayed duplicate notification for A | Turn 2 is recorded; B's receipt reports `done:true` |

B produced no completion signal. The test used one caller, one pane and an unchanged generation, so this is separate from the documented limitation about two callers whose prompts are answered in one turn.

An automated controller can advance dependent work or stop a pane before B finishes. This behavior predates this fix commit; it is newly confirmed here, not one of the five earlier findings. The test establishes the current handler's behavior for that event ordering. It does not establish how often any installed provider configuration emits the duplicate, and no live provider was driven. The bundled Claude hook JSON currently contains SessionStart rather than Stop/Notification, so the bell-plus-hook case depends on a setup using the supported hook path described in the code and documentation. The independently scheduled paths make it unsafe to promise correlation when both are active.

Smallest fix: choose one authoritative completion path for each provider, and keep additional attention signals from incrementing completion again. Where multiple paths are needed, preserve and deduplicate source/turn identity through the wake pipeline before satisfying a receipt. New input alone cannot prove that a delayed signal belongs to the newly submitted task.

Acceptance test: complete A, submit B, deliver A's second notification through the other signal path and verify that B remains pending. Only B's actual completion/attention event may finish B's receipt. Cover both signal arrival orders and the ordinary duplicate-with-no-new-input case.

### B1. P2: pending keys reduce the completed-key retention window and permit duplicate retries

Evidence: `src/main.ts:6883-6889`, `src/main.ts:6905-6911`; promised behavior at `README.md:579-584` and `docs/cli-control.md:187-196`.

Pending entries now survive eviction, fixing A5. The eviction loop still compares the total map size with 256, however, rather than counting completed entries. Pending requests therefore consume the completed-result budget. With 256 requests pending, a single recent completed result can be evicted as soon as another keyed request arrives, even though it is the only completed mutation in the cache.

Reproduction used real current request/cache and input-queue code with mocked native writes:

1. Keep 256 uniquely keyed `send --no-enter` requests pending on pane p1 by holding the first native write.
2. Complete a keyed `send --no-enter` on p2 with key `recent-done` and text `mutate once`.
3. Complete one new keyed `panes` request. Its insertion removes `recent-done` because the total map is above 256.
4. Retry exactly the same p2 request with `recent-done`.

The native writer received `mutate once` twice. Both calls succeeded and the retry had no replay flag. All 256 pending requests remained pending during the completed-key retry; they were released only afterward. This is below the new 1024-pending limit, and only a few completed keys were involved, not 257 newer completed requests.

A controller following the documented last-256-finished retention rule can duplicate a recent mutation after losing its acknowledgement. The same cache is used by other mutating commands as well as sends.

Smallest fix: maintain a separate count/order for completed records and evict only when that completed history exceeds 256. Pending entries must neither be evicted nor consume those 256 slots. Apply pruning when requests settle as well as when new requests arrive.

Acceptance test: keep at least 256 requests pending, finish a keyed mutation on another pane, insert more read-only keys and retry the mutation. It must execute once and replay the stored answer until 256 newer completed results displace it. Retain the existing full-pending rejection test.

### B3. P2: pending receipts evict recent completed outcomes before the promised limit

Evidence: `src/main.ts:3398-3404`, `src/main.ts:6614-6615`, `src/main.ts:6363-6364`; documented retention at `docs/cli-control.md:183-185`.

`keepReceipts` has the same counting problem. It deletes completed receipts until the total map shrinks to 500, so pending receipts reduce the completed-result history. The documentation promises the last 500 finished receipts in addition to pending receipts up to their separate limit of 2000.

Reproduction completed one shell receipt successfully, then submitted 500 agent receipt sends without any completion signals. Creating the final pending receipt removed the sole completed shell receipt. `wait --receipt` for that completed command returned `No receipt` instead of its recorded success. There were only 500 pending entries, well below the documented pending limit, and only one finished receipt.

Delayed result collection or retry reconciliation can therefore lose a known command outcome under concurrency. The controller is forced back to uncertain pane/output inspection despite remaining within the advertised history limits.

Smallest fix: count/prune finished receipts independently from pending receipts. Keep the newest 500 recorded outcomes without reducing that number for pending work, and enforce/document pending capacity separately. Prune when outcomes are recorded so the retention policy also applies when a batch finishes without another send.

Acceptance test: finish a shell receipt, create 500 or more still-pending receipts and verify that the finished result remains queryable. Then complete more than 500 outcomes and verify that eviction follows the documented finished-history policy, while pending receipts below their own limit remain present.

## Disposition of the five previous findings

| Prior finding at `0a93ec2` | Current result |
| --- | --- |
| A1, protocol-2 Loom silently ignores retry keys | Fixed. `src-tauri/src/pipe.rs:20` now uses protocol 3. The freshly compiled client refused a mock previous app's protocol-2 hello with exit 2, `code:version`, `sent:false`. Only the hello frame was received; neither keyed attempt reached the previous frontend or wrote input. |
| A2, replacement agent turns finish an old receipt | Fixed. `finishReceipt` checks pane and generation; `turnReceipts` records a result from the original generation. A pending receipt remained an error after a replacement turned. A receipt finished before restart kept its recorded turn with `asking:null` afterward. |
| A3, prompt guard runs before the input queue | Fixed for the tested cases. The prompt guard now runs inside the serialized send. A queued send refused after the shell left its prompt, with `typed:false` and zero writes. Enter immediately consumed readiness before delayed `E`/`C`; a subsequent receipt pasted only after a fresh `B`. |
| A4, literal or another pane's marker miscorrelates a receipt | Fixed for the original reproductions. The exact trailing hexadecimal comment is selected. Literal marker-like text no longer hides the generated receipt. A foreign pane and a replacement generation were both unable to finish a pending receipt. |
| A5, a running key is evicted under 256 newer keys | Fixed. The held key survived 256 newer keyed reads, and retry shared one native write and returned a replayed result. B1 concerns the separate completed-history accounting introduced with that fix. |

The new 1024-pending-key guard was also tested. New keyed mutation work was refused before dispatch when the limit was full, while replay of an already pending key remained allowed and did not duplicate the write.

Older safeguards remained intact in fresh checks: whole-line server framing, conservative `sent:true` after an uncertain command exchange, exact-versus-unknown shell exits, generation checks on send/keys/choose, queued input rejecting a replacement process, partial-key reporting and whole-visible-menu revisions. No previous finding is repeated here as unresolved without current evidence.

## Readiness and remaining design limits

The current CLI is sufficient for a controller to discover a known endpoint, inspect threads/panes and output, create a terminal in a selected thread's worktree, send text with a generation precondition, handle a numbered question with its menu revision and stop/restart a named pane. The fixes make ordinary shell receipts and per-instance retries substantially safer.

I would still require the following operating constraints:

- Pin the process pipe from `info`, verify the intended repository/worktree through `threads`, and retain exact thread/pane IDs. Default/current targets and pane positions can change under other writers. `info` does not enumerate all running Loom instances or name the profile file.
- Use stdin for opaque task text and `--gen` on input commands. Interpret `sent`, `typed`, `pressed` and the process exit code together. A failed CLI call can still represent partial input or an executed mutation.
- Read the agent's answer to assess success. An agent turn/receipt does not prove that the requested work succeeded or distinguish two callers' prompts. B2 also means the notification-derived receipt can finish early under the described duplicate ordering.
- Preserve instance identity when retrying. Keys and receipts live only in memory, do not survive a Loom restart and have finite retention. B1 and B3 currently make those retention windows narrower than documented under pending load.
- Headless recovery remains incomplete when a restart needs a saved session selected through the window. The CLI reports that condition rather than providing a session-selection command.
- Menu revisions cover the visible prompt; they do not recover text above the viewport or parse every unnumbered question. Inspect the action before approving it.

These listed capability limits are separate from the three confirmed findings. The owner/SYSTEM pipe ACL and remote-client rejection remain unchanged in `src-tauri/src/control.rs:54-58,63-92`. No new transport security bypass was confirmed. Same-account clients still have broad control, and terminal output remains unredacted and untrusted. No live output or secrets were collected for this review.

The readiness verdict remains limited: suitable for supervised, explicitly targeted control with outcome checks; not yet reliable for unattended completion and automatic retry across the identified concurrency boundaries.

## Validation and evidence

Fresh checks completed:

- 47 CLI helper checks and 30 prompt helper checks passed.
- Eight current PowerShell prompt assertions passed in a separate process.
- TypeScript `tsc --noEmit` and Git whitespace checking for `0a93ec2..HEAD` passed.
- Eleven offline isolated Rust tests passed, ten current CLI/pipe tests and the exact current server request-validation test. The extracted function/test were compared with current `control.rs` and matched. The standalone current CLI built successfully.
- Twenty-two isolated frontend workflow scenarios completed using current declarations/methods extracted through the TypeScript AST. They cover prior fixes, ordinary workflows, capacity protection and the three deterministic defect reproductions. Assertions that reproduce a defect are not correctness passes for that behavior.
- Eleven unique mock-pipe exchanges with the freshly compiled CLI passed their expected transport/error assertions. Protocol-2 refused both keyed attempts before a command. A silent hello exited in 205 ms with `sent:false`; connection loss after command delivery remained conservatively `sent:true`.

The completed checks did not fail unexpectedly. The Rust build emitted an expected unused-function warning for the isolated request library, and Cargo warned that the user-home path could not be canonicalized. Builds/tests completed offline without installation or network access.

Not run: the full Tauri Cargo suite, clippy, `cli-check.mjs`, `ui-check.mjs`, `pty-close-check.mjs`, installer/release packaging or real Claude/Codex/OpenCode workflows. The app-level scripts and newly added cases were read, but they start or drive apps and were excluded from this review's no-live-control scope. The shell-prompt wait tests used controlled timer callbacks, so they validate readiness/order/refusal rather than measuring a real five-second wait. ACL enforcement was inspected in source, not tested with another Windows account. The notification reproduction injects a defined event ordering, not a live-provider timing observation.

Evidence directory:

```text
C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20261001T0251
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

The previous reports and their source/test evidence remain available. Final verification checks this report's strict UTF-8 read-back, its hash, current HEAD, all 80 source hashes and the six earlier report hashes. No implementation change accompanies this review.
