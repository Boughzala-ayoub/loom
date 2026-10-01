# Loom CLI review for agent control

Fresh review of `0a93ec29dc6bf78a7b821d7ba1d0aad6a4c3a341`, branch `loom/go`, on 2026-10-01 UTC.

I would not yet use this version for unattended control that trusts a receipt or automatically retries an uncertain mutation. Five new defects were reproduced. Three are P1 blockers: retry keys silently disappear when talking to the previous Loom, an old agent receipt can complete from a replacement process, and a queued shell receipt can send into a running program. The earlier framing and shell-exit findings remain fixed.

The new features do work in ordinary cases. Concurrent requests with the same key typed once, a different command with that key was refused, a shell receipt retained its own exit code after another command, and an agent receipt completed on an attention signal rather than a quiet screen. The failures below concern the boundaries of those guarantees.

## Snapshot and scope

- Worktree: `C:\Users\ayoub\loom\loom\go`.
- HEAD: `0a93ec29dc6bf78a7b821d7ba1d0aad6a4c3a341`, `Add retry keys, agent turns and receipts to loomctl`.
- Comparison: `cd5b24d46406eb36673374949db8cf8f8bdb8e57..HEAD`, seven files, 371 additions and 59 deletions.
- Initial inspection: 2026-10-01T01:55:52Z. HEAD and status were rechecked at 01:59:06Z. An 80-file snapshot was then copied into the review workspace and hashed.
- No staged or unstaged tracked changes. The five untracked files were previous review reports; they were preserved. No other untracked CLI implementation was shown.
- Source hashes and HEAD remained unchanged at 02:06:09Z. A final verification is recorded beside the isolated test evidence after the report is saved.

I reviewed the new CLI options, frontend request cache, shell and agent receipt paths, turn counting, lifecycle resets, documentation and regression tests. I also checked related identity, input validation, transport, JSON failure and permission boundaries. The unrelated menu-position change in this commit was inspected but not browser-tested.

Git used the approved command-scoped trust exception for exactly `C:/Users/ayoub/loom/loom/go`. No global trust or configuration was changed. Git commands disabled optional locks, fsmonitor and external diff/textconv execution. Git warned that the user's global ignore file was unreadable, but returned status successfully. This is a bounded source review, not an audit of ignored dependencies or build artifacts.

Applicable `AGENTS.md` and the local `unslop` writing skill were read. No source fixes, commits, pushes, installs, live-pane commands, live-agent messages or app lifecycle operations were performed. The only addition in the worktree is this report. Temporary programs, native-operation mocks and uniquely named mock pipes lived in the separate review workspace.

## Confirmed findings

### A1. P1: require retry-key support before sending a keyed mutation

Evidence: `src-tauri/src/bin/loomctl.rs:240-252`, `src-tauri/src/pipe.rs:14-18`, `src-tauri/src/control.rs:106-107,184`.

The client accepts any successful protocol-2 hello and then sends `key`. This commit leaves `PROTOCOL` at 2 and the package version at 3.0.0. The previous app at `cd5b24d` also answers with protocol 2 and version 3.0.0. Its `control.rs:184` forwards only `id`, `cmd`, `argv`, `stdin`, `cwd` and `timeout`, so the key never reaches its frontend. That frontend runs each request normally.

This matters in the documented update workflow, where the CLI can be replaced while the previous GUI remains running. The current executable advertises safe retries, accepts the older app and gives no warning that deduplication is absent. A lost acknowledgement followed by the same keyed `send`, `new` or `add` can repeat the mutation.

Reproduction used the compiled current CLI, a unique mock pipe with the actual previous hello shape, and the actual previous frontend handler extracted from `cd5b24d`. The mock transport forwarded exactly the previous control event fields. Two calls equivalent to these both exited 0:

```text
loomctl --json --key old-app-task send p1 --no-enter task
loomctl --json --key old-app-task send p1 --no-enter task
```

The mocked native writer received `task` twice. These were isolated calls, not input to a user pane.

Smallest fix: raise the protocol for this request-semantics change so the existing hello refusal stops before any command. Alternatively, advertise an explicit deduplication capability in hello and refuse `--key` before sending when it is absent. Comparing the current package version alone is insufficient because both revisions use the same version.

Acceptance test: connect the new client to the previous protocol-2 app and request a keyed mutation. It must fail with a version/capability error and `sent:false`, with no mutation frame or native write. Then test the supported app with a dropped acknowledgement and verify one execution after retry.

### A2. P1: an agent receipt can complete from the replacement process

Evidence: `src/main.ts:6336-6349`; related reset at `src/main.ts:1822-1826`. The separate `--turn-after` path at `src/main.ts:6660-6664` already checks generation before returning success.

`waitReceipt` considers an agent done whenever its pane's current `turns` exceeds the receipt's baseline. It separately detects a changed generation, but checks only `!done()` before reporting a lifecycle error. If both are true, completion wins. Because restart resets the count and keeps the pane object, enough turns from the replacement can satisfy an old receipt.

Reproduction called the current `send --receipt` handler on an agent at generation 0 and baseline 0. The fixture then represented a stopped/restarted pane at generation 2, reset its count to 0 and advanced it to 1 for the replacement's own work. A delayed `wait --receipt` returned `ok:true`, `done:true`, `turn:1` for the original task. The original generation never finished that task in the fixture.

An agent controller can therefore advance dependent work or report completion after its task was interrupted. The documentation explicitly promises an error if the pane restarts before the receipt completes.

Smallest fix: accept a live turn-count completion only when the pane still has the receipt's generation and identity. Prefer recording an agent receipt's completed outcome when the matching generation produces its turn signal, so a completed receipt can remain queryable after a later restart without relying on the replacement's counter.

Acceptance test: send an agent task with a receipt, restart before its completion, let the new generation finish one or more turns, then query the old receipt. It must return an interrupted-generation error. Also test that a receipt completed before restart retains its recorded outcome.

### A3. P1: shell prompt readiness is checked before the queued send executes

Evidence: `src/main.ts:6582-6593`; queue at `src/main.ts:3341-3351`; actual paste and Enter at `src/main.ts:3359-3369`.

The shell's `atPrompt` guard runs before `sendReply` joins the pane's input queue. The queue rechecks pane identity and generation, but not prompt readiness. An earlier queued sequence can start a program after this receipt request passed the guard. The later sequence still pastes and presses Enter as long as that program echoes the text.

Reproduction held an earlier input sequence, queued a receipt send while `atPrompt:true`, delivered the current handler's `C` mark to represent the earlier command starting, then released the queue. The send returned success with a receipt and the mocked writer received the commented command followed by Enter while `atPrompt:false`.

This violates the stated restriction that a shell receipt is accepted only at Loom's PowerShell prompt. The text can reach an interactive program instead of PowerShell, and the returned receipt may never correspond to a shell command. Two controllers can trigger it without changing pane ID or generation.

Smallest fix: validate and reserve prompt readiness inside the serialized input sequence before any paste. Do not reuse a prompt-ready observation for a second send after submission; require a new prompt mark or refuse/wait until the preceding command completes. Account for the delay between the native Enter write and receipt of the shell's `E`/`C` marks.

Acceptance test: hold a first send that starts an interactive process, enqueue a receipt send while the old prompt is visible, then emit `E`/`C` and release the first sequence. The second send must wait for a fresh prompt or reject before writing any bytes. Add a concurrent two-receipt case where the marks arrive after the first Enter has returned.

### A4. P2: shell receipt markers are neither anchored nor bound to their pane

Evidence: `src/main.ts:2246-2260`, `src/main.ts:3378-3382`, `src/main.ts:6588`.

`Pane.mark` takes the first `loom-receipt:...` anywhere in the shell command line. It does not require the generated trailing comment. `finishReceipt` then updates the corresponding map entry without checking which pane or generation produced the result.

First reproduction sent this harmless text through the actual receipt handler:

```powershell
Write-Output "loom-receipt:example"
```

The handler appended its actual receipt comment. The command's mocked `E` and successful `D;0` marks were processed by the current `Pane.mark`. It selected `example` from the string literal, leaving the real receipt unresolved even though the command completed.

In the same fixture, a second pane's command line contained the first pane's pending token. Its `D;9` completed that token, and querying it returned `pane:p1`, `exit:9`, even though pane p2 supplied the result. A copied command containing an old marker, or a command that processes receipt text, can therefore hide completion or assign another command's outcome to a task.

Smallest fix: recognize only the exact generated suffix and token format, and require the receipt record's pane and generation to match the reporting pane before accepting a result. Keep terminal markers as observations, not authorization evidence. This reproduction does not establish a Windows pipe ACL bypass.

Acceptance tests: a command containing marker-like literal text still completes its appended receipt; a different pane cannot complete that receipt; a replacement generation cannot complete a pending old receipt by reusing its token.

### A5. P2: cache pressure evicts a keyed request that is still running

Evidence: `src/main.ts:6846`, `src/main.ts:6853-6863`; documented active-request promise at `README.md:574-578` and `docs/cli-control.md:179-185`.

The 256-entry map deletes its oldest key without checking whether the stored promise has settled. A retry of an evicted pending request starts `runCli` again. This breaks the promise that retries wait for the first answer while that request is still running.

Reproduction held the first `send --no-enter` native write for key `held-job`, issued 256 other uniquely keyed `panes` requests and retried the original command with `held-job` before releasing its first write. The original key had disappeared. After release, the mock writer received `long task` twice and the second response had no replay flag. The earlier ordinary concurrent-retry test, without cache pressure, typed once.

The documented limit means old completed keys can expire; this finding concerns eviction before the first attempt even finishes. Long Git operations, waits and concurrent controllers make that distinction important. The retry can duplicate a still-pending mutation.

Smallest fix: retain all pending entries and apply bounded eviction only to settled responses. If the pending-entry limit is reached, reject a new keyed mutation before dispatch rather than evicting another pending request. Document the retention/expiry rule for completed keys.

Acceptance test: keep a keyed mutation pending, add at least 256 other keys, then retry it. There must be one execution and a shared/replayed answer. Verify the full-pending case refuses new work without executing it.

## Previous issues and capability changes

| Previous item | Current disposition and evidence |
| --- | --- |
| S1, truncated request execution and incorrect `sent:false` | Remains fixed. `control.rs:138-146` requires the newline before dispatch. The exact current function and unit test passed in the isolated Rust crate. `loomctl.rs:235,256-260` uses a whole serialized frame and conservative `sent:true` on command write errors. A real-client mock disconnect also returned `sent:true`; it exercised lost reply, not forced partial write. |
| S2, guessed exact exit 1 after repeated native exit 7 | Remains fixed. Eight PowerShell assertions passed, including repeated exit 7 as `D;1;exact=0`. The current frontend exposes `failed:true`, `exit:null`; success still reports exact 0. |
| Earlier whole-menu revision, partial-key report, silent greeting and JSON failures | Regression checks passed. Changed wrapped details and long questions invalidate a menu revision; an interrupted `keys enter x` retains `pressed:1`; a silent mock hello times out before mutation; usage, connection, timeout and command failures remain JSON with delivery status. |
| Task-correlated completion gap | Partly addressed by shell receipts and agent turn receipts. Normal paths passed, but A2-A4 prevent treating the new receipts as reliable across lifecycle and concurrency boundaries. Agent task success and distinguishing two callers on one agent remain explicitly unsupported. |
| Safe retry gap | Partly addressed by per-instance keyed promises. Normal concurrent deduplication passed. A1 and A5 remain. Keys still expire and do not survive app restart, as documented. |

The generation guard still refused stale send/keys/choose calls, and queued input still refused a replacement session. Restart cleared prior command outcomes. These older safeguards do not fix the new receipt paths automatically.

## Remaining design limits and practical workflow

These are documented limits rather than additional confirmed defects:

- `info` identifies a known pipe's process and instance pipe, but does not enumerate all Loom instances or identify the workspace profile in hello. Read `threads` to verify the checkout, pin the returned process pipe, and use exact pane/thread IDs rather than current targets or changing pane positions.
- An agent receipt represents an attention/turn signal after input. It does not prove task success, distinguish concurrent prompts, or authenticate terminal output. Read the answer and any question before deciding that a task succeeded or approving a follow-up action. Quiet/idle status remains insufficient evidence of completion.
- Keys and receipts are in-memory records with bounded retention. They do not survive a Loom restart. A controller must detect changed instance identity and reconcile uncertain mutations instead of assuming an old key still protects them.
- Saved-session recovery can still require the window. `restart` at `src/main.ts:6701` tells the caller to pick a session in Loom. The documented CLI is therefore insufficient for every recovery path available to a controller without GUI access.
- Menu revisions cover what is visible on screen. Output above the viewport and unnumbered questions need additional inspection. A menu ID is not a substitute for reviewing the action being approved.
- Terminal output is unredacted. Do not place captured secrets in logs or reports, and treat task text, agent output and shell escape sequences as untrusted content.

The owner/SYSTEM ACL and remote-client rejection at `src-tauri/src/control.rs:54-58,63-92` are unchanged. No new transport security bypass was confirmed. Broad control remains available to authorized code running as the same Windows account. ACL enforcement was inspected in source, not tested with a second user account.

For a controlled workflow after these fixes, I would read `info`, pin its process pipe, verify `threads` against the desired repository/worktree, select the exact pane ID and generation, and inspect its role and recent output. `add <thread-id> --cmd=` creates a terminal in that thread's directory; I would retain the returned ID and wait for a ready prompt before sending shell work. I would send opaque task text through stdin with `--gen`, assign one key per logical mutation, retain the returned receipt, and query that receipt with a separate request. A failed call with `sent:true`, `typed:true` or partial `pressed` is an uncertain/partial operation, not permission to repeat it. Until A1-A5 are fixed, stop and reconcile those boundary cases instead of automatically advancing or retrying.

## Tests, evidence and limits

Fresh checks passed against current source:

- CLI helper checks and all 30 prompt helper checks.
- Eight PowerShell prompt assertions in a separate process.
- TypeScript `tsc --noEmit` and Git whitespace checking for `cd5b24d..HEAD`.
- Eleven offline isolated Rust tests, ten current CLI/pipe tests plus the server request-validation test. The extracted server function and test were compared to current `control.rs` and matched exactly. The standalone current CLI built successfully.
- Fifteen isolated frontend workflow scenarios using current declarations and methods extracted through the TypeScript AST. Four scenarios intentionally assert the reproduced incorrect behavior in A2-A5, so a successful reproduction is not a correctness pass for those features.
- Eleven unique mock-pipe exchanges with the compiled current CLI, including the two older-app keyed attempts establishing A1. The silent hello timed out in 191 ms with `sent:false`; no mutation was sent.

The test fixture initially needed corrections for redeclaring a temporary test class and using the wrong menu cursor glyph/time setup. Those were errors in review-only test code, not reported as Loom defects. The final runs completed successfully and recorded the five feature defects above. No project source was changed to make a test pass.

Not run: the full Tauri Cargo suite, clippy, `cli-check.mjs`, `ui-check.mjs`, `pty-close-check.mjs`, installer checks, release packaging, or real Claude/Codex/OpenCode workflows. The app-level scripts were inspected; they start or drive applications and were excluded from this review's no-live-control scope. No live production pipe or terminal output was read. The tests use native mocks and a compiled CLI over isolated pipes; they do not replace real packaged-app validation or exercise every scheduling/terminal layout.

The Rust build emitted an expected unused-function warning for the isolated request library, and Cargo warned that it could not canonicalize the user home. Both completed offline without dependency installation or network access.

Supporting evidence remains at:

```text
C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20261001T0159
  changes.diff
  snapshot-hashes.json
  prior-report-hashes.json
  checks\agent-checks.mjs
  checks\frontend-results.log
  checks\transport-checks.mjs
  checks\transport-results.log
  checks\transport-results.json
  checks\previous-main.ts
  checks\previous-control.rs
  checks\Cargo.toml
  checks\request.rs
  final-verification.json
```

Verdict: the ordinary command paths have improved, and the previous two defects remain resolved. Reliable unattended agent control still requires the three P1 fixes and the receipt/cache boundary fixes above. The documented provider and restart limits should remain explicit even after those fixes.
