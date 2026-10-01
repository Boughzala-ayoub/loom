# Loom CLI review for agent control

Fresh review of `86d47027e538303da19a32c7463d6ffdf2f12256`, branch `loom/go`, on 2026-10-01 UTC.

**No new confirmed correctness or security defects were found in the reviewed changes.** C1 from the previous review is resolved in both original reproductions. The slow mutation's immediate retry now replays one execution, and the slow shell receipt retains its newly recorded exit 7 after 500 newer submissions have already finished.

The reviewed source is a reasonable candidate for controlled agent use with explicit instance/pane identity, generation checks, keyed mutations and outcome inspection. This is an isolated source-level review, not certification of the running packaged app or real-provider notification behavior.

## Snapshot and boundaries

- Worktree: `C:\Users\ayoub\loom\loom\go`.
- HEAD: `86d47027e538303da19a32c7463d6ffdf2f12256`, `Keep loomctl's newest finished keys and receipts, not the oldest started`.
- Comparison: `f3385745b40f75de4e20d66e84708e8d64bcb702..HEAD`, six changed files, 76 additions and 38 deletions.
- Initial Git inspection: 2026-10-01T11:52:43Z. An 80-file snapshot of source, scripts, documentation and manifests was copied into a separate review workspace and hashed.
- No staged or unstaged tracked changes. The eight untracked entries were earlier review reports. Their hashes were recorded and they were preserved. No untracked CLI implementation was shown.
- HEAD and all 80 source hashes still matched at 12:00:08Z. The final verification file records the check after saving this report.

The current diff, related implementation and tests were reread. Review covered settlement ordering, pending capacity, receipt lifecycle, retry behavior, protocol compatibility, input/generation/prompt guards, structured errors and the updated agent-control documentation. Previous findings were revalidated rather than assumed to remain present.

Git used only the approved command-scoped exception `-c safe.directory=C:/Users/ayoub/loom/loom/go`. No global trust, configuration or security setting was changed. Optional locks and fsmonitor were disabled; diffs disabled external diff/textconv execution. The common repository configuration was checked for hook/filter/external-diff settings before test work. Git warned that the user's global ignore file was unreadable but returned status successfully. Ignored dependencies and build artifacts are outside this bounded review.

Applicable `AGENTS.md` and the previously read local `unslop` writing instructions were followed. No source fixes, commits, pushes, installs, live-pane commands, provider-session operations, live-agent messages or app lifecycle changes were performed. Only this requested report is added to the go worktree. Temporary source copies, logs, programs and unique mock pipes stayed in the separate review workspace.

## Previous finding C1 resolved

Relevant current locations:

- `src/cli.ts:85-92` filters settled entries, sorts by their settlement sequence and removes the earliest settled records beyond the limit.
- `src/main.ts:3403` defines the shared monotonic settlement counter.
- `src/main.ts:3407-3421` records a receipt's settlement sequence and uses it for pruning. An interrupted receipt takes a sequence when its lifecycle loss is first noticed, as documented.
- `src/main.ts:6924-6928` records each key's completion sequence before pruning its completed history.

The stores still insert records when work is submitted, but creation order no longer decides retention. A request that starts first and finishes last now has the newest settlement sequence. The limits remain independent of pending work: 256 completed keys and 500 settled receipts.

### Key reproduction now passes

Using the actual current dispatcher, key cache, pruning helper and input queue with mocked native writes, the test:

1. Held an early keyed `send --no-enter` with key `slow-job` while its native write remained pending.
2. Completed 256 newer, uniquely keyed `panes` requests.
3. Released the early mutation so it finished last.
4. Immediately retried the identical `slow-job` request.

The slow key stayed in the cache. The earliest completed read was evicted instead. The retry returned `replayed:true`, and the writer received `slow mutation` exactly once. This reverses the earlier duplicate-input reproduction.

### Receipt reproduction now passes

The current shell receipt creation, `Pane.mark`, outcome recording, pruning and lookup were exercised separately:

1. Submitted an early shell receipt on p1 and held its final command outcome.
2. Completed 500 newer shell receipts on p2.
3. Delivered p1's own `D;7` last.
4. Queried the original token with a new `wait --receipt` call.

The original receipt remained present and returned `failed:true`, `exit:7`. The earliest settled p2 receipt was evicted instead. This reverses the earlier missing-outcome reproduction, including a fresh query rather than a wait retaining an old object reference.

The checked-in helper tests also cover out-of-order settlement sequences and a first-created/last-completed record. The updated app-level regression includes retrying a held key after it finishes; that script was inspected but not driven against an app. The isolated review tests exercised the full receipt-store version as well as the helper, without controlling user panes.

## Regression results

The fresh checks retained the earlier fixes:

- Cross-source duplicate notifications did not complete the next task's receipt. Both bell/hook orders passed for Claude fixtures, and both OSC 99/hook orders passed for OpenCode fixtures. The selected source's own next signal completed turn 2. Restart reset the source selection.
- Pending entries did not consume the completed-key or settled-receipt budgets. A recent completed mutation replayed while 256 sends remained pending elsewhere; a completed shell result survived 500 pending agent receipts.
- Full pending capacity refused new work before native input. At 1024 keyed requests, replay of an existing pending key remained allowed. With 2000 valid pending receipt records, a new receipt send was refused and the records remained intact.
- An interrupted receipt was assigned one settlement sequence on first observation, kept that sequence on another scan and continued to return the restart error. It was not converted into a successful outcome.
- A pending old-generation receipt ignored replacement turns; one completed before restart retained its recorded outcome. Foreign panes and replacement generations could not complete a pending shell receipt.
- Queued shell receipt sends respected prompt readiness. An Enter consumed the prompt before delayed marks, and a subsequent receipt pasted only after a fresh prompt. Input queued for an older generation remained rejected.
- Protocol-2 peers were refused before a keyed mutation. JSON usage, version, connection, timeout and command failures retained their delivery/error semantics.
- Whole-line request validation, conservative uncertain-delivery reporting, exact-versus-unknown PowerShell exits, partial-key reporting, opaque multiline stdin and whole-visible-menu revisions remained intact.

No reviewed change reintroduced one of the previous confirmed defects in those tests. No prioritized defect finding remains from this pass.

## How I would control Loom with this version

For a known endpoint, read `info`, pin its process pipe, verify the intended checkout/worktree in `threads` and retain exact thread/pane IDs. Use the observed generation for send/keys/choose rather than a current target or pane position that can change under another writer.

For shell work, create a terminal in the chosen thread with `add <thread-id> --cmd=`, retain its returned ID and establish prompt readiness. Send opaque text through stdin, use a unique key for each logical mutation, retain the receipt and collect its recorded outcome. A failed call with `sent:true`, `typed:true` or partial `pressed` can represent an operation that already affected the pane; it is not permission to submit the mutation again with a new key.

For agent work, use the receipt together with state, recent output and menu inspection. The updated README now explicitly describes a question arriving through a source different from the one that counts turns: it raises attention without necessarily completing the receipt. A controller should use bounded waits and also observe waiting/menu state, inspect the full question and use its revision plus generation when choosing. It should assess the agent's answer before declaring task success.

These are documented capability limits rather than new defect findings:

- The pinned turn source must remain available for later completions. Real Claude/Codex/OpenCode notification continuity, focus/configuration effects and question routing were not validated live.
- Receipts do not prove agent task success or separate two callers' prompts answered in one turn. Quiet/idle and the attention dot are observations, not task-specific completion proof.
- Keys and receipts have finite per-instance retention and do not survive a Loom restart. Rediscover identity and reconcile uncertain mutations after a restart; do not assume an old key still protects them.
- The CLI does not enumerate all running Loom instances or report the profile path in hello. Some saved-session recovery still requires the window.
- Menu revisions cover visible content, and unnumbered questions need other inspection. Terminal output is unredacted and untrusted.

The owner/SYSTEM pipe ACL and remote-client rejection remain unchanged at `src-tauri/src/control.rs:54-58,63-92`. No new transport security bypass was confirmed. ACL enforcement was inspected in source, not tested with a second user account. No live terminal output or secrets were collected.

Verdict: no confirmed source-level blocker remains in this bounded change set. The previous retention defect is fixed. The next acceptance step for reliable unattended agent control is packaged-app/provider validation of the documented completion and question workflow; this review did not perform those live operations.

## Validation and evidence

Fresh checks passed:

- 52 CLI helper checks and 30 prompt helper checks.
- Eight PowerShell prompt assertions in a separate process.
- TypeScript `tsc --noEmit` and Git whitespace checking for `f338574..HEAD`.
- Eleven offline isolated Rust tests, ten current CLI/pipe tests and the server request-validation test. The extracted server function/test were compared with current `control.rs` and matched exactly. The standalone current CLI built successfully.
- Twenty-nine isolated frontend workflow scenarios using current declarations/methods extracted through the TypeScript AST, including both original C1 cases and interrupted-receipt settlement.
- Eleven unique mock-pipe exchanges with the freshly compiled CLI. Protocol-2 mutation attempts received version errors with `sent:false` and no command frame. A silent greeting timed out in 205 ms. Uncertain command exchanges remained conservatively `sent:true`.

No check failed unexpectedly. The isolated Rust request library emitted an expected unused-function warning, and Cargo warned that the user-home path could not be canonicalized. Builds/tests completed offline without installation or network access.

Not run: the full Tauri Cargo suite, clippy, `cli-check.mjs`, `ui-check.mjs`, `pty-close-check.mjs`, installer/release packaging or real provider workflows. App-level scripts were inspected but excluded because they start or drive apps. Prompt timing used controlled timer callbacks rather than a real five-second wait. Receipt capacity used seeded valid pending records rather than 2000 live jobs. The test binary and native mocks do not establish that the running installed app matches this source or behaves identically under every IPC schedule and terminal layout.

Evidence directory:

```text
C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20261001T1152
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

Final verification checks strict UTF-8 read-back, report hash, current HEAD, all 80 source hashes and all eight earlier report hashes. This is a bounded snapshot; later edits are not covered. No implementation change accompanies the review.
