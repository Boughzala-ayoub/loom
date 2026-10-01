# Loom CLI review for agent control

Fresh review of `cd5b24d` on 2026-10-01 UTC, continuing from the preserved snapshot and inspection.

**No new confirmed correctness or security defects were found in the reviewed change set. Both findings from the previous report are resolved in the fresh checks.** I would use this version for explicitly targeted control and automation that stops on uncertain outcomes. I would not yet enable blind retries or treat an agent's idle state as proof that its task succeeded.

## Snapshot and access

- Worktree: `C:\Users\ayoub\loom\loom\go`, branch `loom/go`.
- HEAD: `cd5b24d46406eb36673374949db8cf8f8bdb8e57`, `Run only whole loomctl requests and report unknown exit codes as unknown`.
- Comparison: `8667a8e..cd5b24d`, nine changed files, 159 additions and 46 deletions.
- Initial Git inspection: 2026-10-01T00:56:04Z. The 80-file snapshot was captured and verified at 00:57:32Z, then reused after the checkpoint.
- Rechecked at 00:59:32Z and **01:03:47Z**. HEAD and all 80 hashed files remained unchanged. No staged or unstaged tracked changes were shown. The only untracked entries were the four previous reports.
- Git required the user-approved command-scoped exception `-c safe.directory=C:/Users/ayoub/loom/loom/go` because the sandbox user differs from the repository owner. No global trust, security or repository configuration was changed. Repository configuration was inspected before proceeding; diffs disabled external diff/textconv execution.
- Git warned that the user's global ignore file was unreadable. It still returned status successfully. The bounded review covered the copied source, scripts, manifests and documentation; it was not an audit of ignored build/dependency files.

Applicable AGENTS.md and prose instructions were followed. No source fix, commit, push, install, live-pane input, agent message or running Loom mutation was performed. Only the requested report is added to the go worktree.

## Previous findings and current evidence

### S1 resolved: truncated framing and false unsent classification

Relevant current locations: `src-tauri/src/control.rs:122-146`; `src-tauri/src/bin/loomctl.rs:220`, `:240-245`.

The server now calls `request(line)` before dispatch. That function requires the newline delimiter, then validates JSON, command and argument shape. A complete JSON object cut off before its newline is rejected. The client serializes the entire frame before `write_all`, and a command write failure now reports `sent:true` with an explicit uncertain-delivery message.

The current `request` function and its checked-in unit test were extracted unchanged into an isolated Rust crate. The test passed for a valid terminated request, valid JSON without a newline, a cut-off body and the old missing-argv request shape. This directly reverses the earlier framing reproduction.

The compiled current CLI also passed a mock-peer disconnect check after greeting and during the attempted command exchange. It returned connection JSON with `sent:true`. That run reached the lost-reply branch, so it is not claimed as a runtime injection into the write-error branch. The write-error branch's conservative classification was verified in the current source. The new checked-in real-pipe regression test was inspected but not run against Loom.

The prior retry risk is addressed: neither the server's truncated-frame acceptance nor the client's definite-unsent promise remains in those reviewed paths. This does not add deduplication for operations that were actually accepted.

### S2 resolved: ambiguous shell exits are represented as unknown

Relevant current locations: `src-tauri/src/shell-init.ps1:37-47`; `src/main.ts:2232-2241`, `:6206-6211`.

The PowerShell integration now emits `D;1;exact=0` when it knows a command failed but cannot recover its exact exit code. `Pane.mark` preserves failure separately and exposes `exit:null` for that marker. It no longer presents the inferred 1 as an exact native result.

All eight assertions in the current PowerShell integration test passed in a separate process. These included native success, no duplicate end marker, exact native failures, a failing cmdlet, repeated exit 7 and subsequent success. The repeated 7 now produces an unknown-code failure as intended.

The current frontend handler and CLI JSON were checked separately with this sequence:

| Marker | commands | failed | exit |
| --- | ---: | --- | --- |
| `D;7` | 1 | true | 7 |
| `D;1;exact=0` | 2 | true | null |
| `D;0` | 3 | false | 0 |
| `D` without a code | 4 | null | null |

The distinction between failure and an exact exit code is now honest. Exact repeated native codes remain unavailable, as documented; callers must allow `exit:null` rather than inventing a recovery decision from it.

## Related changes and regression checks

The new reset at `src/main.ts:1821-1823` clears command count, failure and exit result when a replacement process begins. Using the current spawn/launch/stop methods with controlled native operations, a restart moved generation from 0 to 2, cleared an old count of 9 and exit 7 to `commands:0`, `failed:null`, `exit:null`, and counted the replacement's next command as 1. No result from the prior process was reported as the new process's command outcome in that fixture.

Fresh regression scenarios also passed for:

- Changed wrapped menu details and long questions invalidating their revision, with no Enter for queued or explicitly stale selections. Highlight movement alone preserves the revision.
- An interrupted `keys enter x` reporting `pressed:1` and withholding the second key.
- Stale `--gen` values rejecting send, keys and choose before input, while the current generation accepts input.
- Queued input refusing a replacement process.
- Opaque multiline stdin beginning with `--`, delivered as one paste and one Enter in the controlled echo fixture.
- Instance info, version refusal, structured usage/server/connection errors, partial-key details and bounded greeting timeouts. A silent mock greeting under `--timeout 0.15` exited with timeout JSON and `sent:false` in 183 ms.

These tests cover the current implementation with isolated fixtures. They do not establish that every real terminal/TUI layout, native IPC schedule or process failure behaves identically.

## Remaining automation limits

These are documented capability gaps, not new defect findings against this commit. Their importance depends on whether the controller stops on uncertainty or is expected to recover unattended.

### Task-correlated completion

At `src/main.ts:6210`, shell counters and outcomes describe the pane's latest observations. They do not identify one caller's submission. The startup command is included, counters reset on restart, and another writer or a previously running command can advance them. A controller must establish a ready shell and baseline, keep the same generation, and have exclusive ownership before using a counter increase as its own completion signal. Otherwise it needs a task-specific marker or receipt.

For agent panes, `wait` still observes a state at `src/main.ts:6588`; Claude's busy heuristic can clear after 1.5 seconds of quiet at `:1980`. The retained fixture confirms that quiet can satisfy an idle wait without task-completion evidence. The updated documentation acknowledges this.

If general unattended completion is required, add a submission token that can be correlated with the corresponding completion/result. An acceptance test should interleave two callers and prove that neither consumes the other's completion. Agent providers need a completion/attention signal rather than a quiet-screen inference.

### Retry reconciliation

Conservative `sent` reporting is a useful safety improvement. A timeout or disconnect after acceptance still leaves an uncertain mutation, however. There are no caller request IDs, stored results or deduplication records. A controller must inspect state and stop for reconciliation when it cannot establish whether the action applied.

If automatic retry is required, the direct next step is a bounded per-instance request/result cache keyed by caller IDs. An acceptance test should drop an acknowledgement after execution, retry the same ID and verify one execution with the same recorded result.

### Discovery and headless recovery

For a known endpoint, `info` provides the process pipe and identity. Pin that pipe, verify the checkout through `threads`, select exact pane IDs and use observed generations for input. Avoid default/current targets or pane positions in concurrent automation. The CLI still does not enumerate all instances or include the workspace profile path in hello.

Some saved-session recovery still requires the GUI at `src/main.ts:6622`. This limits a controller that has no GUI access. It is not a failure of the reviewed fixes. A CLI session list/select operation would be needed if that recovery path must be unattended.

Menu revisions cover the bounded visible prompt, not content above the screen. Inspect the complete action before approving; do not treat a partial visible prompt as sufficient permission evidence.

## How I would use it now

1. Read `info`, pin its process pipe, and confirm the intended checkout in `threads` JSON.
2. Select an exact pane ID and record its generation. Inspect the pane's role and recent output before sending anything. For a fresh shell in an existing thread, use `add <thread-id> --cmd=` and retain the returned ID.
3. Use stdin for task text and `--gen` for send/keys/choose. Account for the documented removal of one final line break. For approvals, also use the revision from the inspected complete visible menu.
4. Interpret process exit status together with JSON. Respect `typed`, `pressed` and uncertain `sent:true` results; a failed CLI call does not undo an earlier side effect.
5. For an exclusively controlled, ready shell, track generation and the command baseline, then inspect `failed` and optional exact `exit`. For shared panes or agent tasks, require a correlated output marker or explicit task-result evidence.
6. Reconcile before retrying an uncertain mutation. Rediscover IDs after an app restart rather than silently substituting a similarly named pane.

The local owner/SYSTEM pipe ACL and remote-client refusal remain unchanged in the reviewed source. No bypass was confirmed. Access still grants broad control within that Windows account, and terminal output remains unredacted, potentially sensitive and untrusted data. No live terminal output was collected for this review.

## Validation and limits

Fresh checks passed:

- 47 CLI helper checks and 30 prompt helper checks.
- Eight assertions from the current PowerShell shell integration test.
- TypeScript `tsc --noEmit --incremental false` and Git whitespace checking for `8667a8e..HEAD`.
- Ten isolated Rust tests: nine current CLI/pipe tests and the current server request-validation test. The standalone CLI binary built offline from unchanged copied source.
- Eight isolated frontend workflow scenarios using current code extracted through the TypeScript AST.
- Nine mock-pipe scenarios using the compiled current CLI, including a peer closing after greeting before an attempted large command exchange.

No application test failed. The isolated Rust library build reported an expected unused-function warning because the extracted request function is consumed only by its tests. Cargo also emitted a home-path canonicalization warning; the build and tests completed successfully. No dependency installation or network fetch was used.

Not run: full Tauri build, live `scripts/cli-check.mjs` or `scripts/ui-check.mjs`, installer/update, runtime ACL checks, live pane operations, or real terminal/agent rendering tests. The full native server was not launched. The server framing check used its unchanged extracted function, and the disconnect mock did not force the exact write-error branch. Checked-in live tests were read, but documentation claims about their results are not counted as this review's results.

Evidence remains in `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20261001T0056`, including the snapshot manifest, diff, checkpoint, test scripts, logs and mock transport results. Earlier reports are preserved.

There is no new code fix requested by this review. The remaining decision is which guarantees Loom intends to provide for unattended orchestration. Explicit targeting and conservative uncertainty handling are now usable; task receipts and retry reconciliation remain the next requirements if automatic recovery is expected.
