# Loom CLI agent-control review

Fresh review of `8667a8e`, completed on 2026-09-30 UTC.

**Verdict: the four previous findings are fixed in the tested cases. The CLI is suitable for supervised, explicitly targeted control, but still lacks the guarantees needed for general unattended orchestration.** Two current P2 findings concern delivery certainty and exact shell outcomes. Task-correlated completion and retry deduplication remain separate design gaps.

## Snapshot and scope

- Checkout: `C:\Users\ayoub\loom\loom\go`, branch `loom/go`.
- HEAD: `8667a8edf834f0e1017d96886e38071c9bfdd992`, `Close the gaps the second agent review found in loomctl`.
- Initial snapshot: **2026-09-30T23:12:16Z**. No staged or unstaged tracked changes. The three existing review reports were the only untracked files.
- Compared `2278a3a..HEAD`: eight changed files, 451 additions and 127 deletions. Re-read the changed CLI, prompt, lifecycle/output handlers, documentation and tests, plus the transport and shell integration they depend on.
- At **23:20:30Z**, HEAD was unchanged and all 80 files in the bounded source snapshot still matched their SHA-256 hashes.
- Applied the existing AGENTS.md review/prose instructions. This review changed no application source, Git state, installed software, running Loom instance or live pane. It adds only this report to the worktree. Test files and build outputs are in the separate review workspace.

## Confirmed findings

### S1. P2: a failed command write is classified as definitely unsent without a sound framing guarantee

Locations: `src-tauri/src/bin/loomctl.rs:220`, `:240-243`; `src-tauri/src/control.rs:120-126`.

The new error contract returns `sent:false` for any failure from the command write. The supporting comment says Loom reads whole lines, so a request that did not fully go out never ran. The server does not actually require a terminating newline. `read_line` also returns a nonempty final fragment at EOF, and the server parses and dispatches that fragment if it is valid JSON.

**Evidence:** an isolated Rust fault-injection check used the current client send expression, `writeln!` followed by `flush`, with a writer that accepted the complete JSON object and failed on its final newline. It then used the same Tokio reader, byte limit and request validation as the server's command phase. The send returned an error, but the delivered JSON without a newline passed the dispatch gate. Thus the client would take its `sent:false` branch for a byte sequence the server accepts as a command.

This verifies the mismatch in the two protocol rules. It is a component test with an injected write boundary failure, not an observed failure against a live Windows Loom pipe. The existing total input limit is another reason the server must distinguish a complete framed message from a valid JSON fragment at a reader boundary.

**Impact:** an agent relying on `sent:false` as permission to retry can duplicate a mutation in this boundary case. The normal lost-reply path is correctly conservative now and reports `sent:true`; the write-error path needs the same care.

**Smallest fix:** once a command write is attempted, report uncertain delivery conservatively unless zero delivery can be established. With the current boolean contract, `sent:true` plus an uncertainty message is safer than `false`. Also reject command frames without their required newline at EOF or the size limit. Neither change requires a retry subsystem.

**Acceptance tests:** inject failure after a complete JSON body but before its terminator, and failure after some request bytes. Neither result may promise safe retry unless the server provably refused the request. Verify that an unterminated request never reaches dispatch, while a normal terminated request still executes once. Add a real isolated named-pipe boundary test before treating this guarantee as production-verified.

### S2. P2: the new exit field presents an approximate shell status as an exact exit code

Locations: `src/main.ts:2233-2235`, `:6202`; `src-tauri/src/shell-init.ps1:37-44`; `README.md:539`, `docs/cli-control.md:130-136`.

The new `panes` JSON publishes the OSC command-end number as `exit`, described as the last shell command's exit code. The existing PowerShell integration deliberately substitutes 1 when a nonzero native exit code repeats. Its comment explains that this was sufficient for coloring a failure, but the new machine-readable field exposes that approximation without a qualifier.

**Reproduction:** in a separate PowerShell process, dot-sourced the copied current shell integration, stubbed only `Get-History` as the repository's own test does, and ran `cmd /c exit 7` twice. The emitted command-end codes were **7, then 1**. A separate current-handler fixture confirms that `Pane.mark` passes such a code directly into the new JSON field.

**Impact:** a controller can still distinguish success from failure in this case, but cannot safely branch on an exact native status. Commands that use distinct exit codes for different recovery actions can be misclassified. This is newly exposed API behavior from an older UI-oriented shortcut, not a regression in the underlying prompt implementation.

**Smallest fix:** either capture the exact per-command native result, or explicitly expose the current value as an approximate success/failure status. Mark exactness or return an unavailable exact code when the integration cannot know it. Do not advertise the inferred 1 as the native exit code.

**Acceptance tests:** consecutive native exits 7 and 7 must both expose exact 7, or explicitly indicate that the second exact code is unavailable. A failing PowerShell cmdlet after native exit 7 must not inherit stale 7. Successful commands must still report success.

## Previous findings at 2278a3a

| Finding | Fresh disposition |
| --- | --- |
| R1: menu identity omits wrapped details and long questions | **Fixed in the previous cases.** The new prompt representation includes the path under an option and the command above the old four-line summary. Changed text gives a different revision. Both a queued choose and an explicit stale revision reject without Enter. Moving only the highlight preserves the revision. |
| R2: silent greeting bypasses timeout | **Fixed.** The actual compiled current CLI against a silent mock pipe exited 3 with timeout JSON and `sent:false` in 270 ms for `--timeout 0.15`. The mock received only hello. |
| R3: partial keys claim nothing was submitted after Enter | **Fixed for the restart case.** The current handler sends Enter, observes a replacement before the next key, returns `pressed:1`, names the delivered Enter and does not send the second key. The false no-submission claim is gone. |
| R4: greeting and transport errors omit JSON | **Fixed in the tested paths.** Fresh compiled-client checks verified JSON for malformed options, an old greeting, a silent greeting, a lost reply, a server error and a server timeout. Stable `code` and `sent` fields are present, and a server's `pressed` detail survives formatting. S1 concerns the truth of one delivery classification, not missing JSON. |

The report does not repeat these four as open defects. The remaining limitation that a prompt may extend above the visible screen is now documented. It is distinct from the omitted visible text that the new parser fixes.

## New capabilities verified

The new `--gen` precondition closes the earlier observation-to-send gap for input. Current handler tests reject stale generations for **send, keys and choose**, with zero writes. A matching generation succeeds. The existing guard against queued input entering a replacement session also still passes.

`panes` now exposes `generation`, `commands`, `exit` and `lastOutput`. A current-handler fixture verified an OSC `D;7` increments the count, exposes 7, and includes the output timestamp and generation. These are useful observations. S2 limits exact interpretation of the status that the PowerShell prompt supplies.

Opaque stdin, long-task paste handling, protocol negotiation and instance info remained intact in the exercised paths. The current client sends stdin in its separate field; the frontend preserves leading `--` as task text, removes the documented one final line break, pastes the multiline task once and submits once. The mock identity query issues only hello and returns the peer's identity without sending a pane command.

## Remaining requirements for unattended use

These are capability limits rather than additional confirmed regression findings.

**Completion still needs task identity.** Shell counters improve visibility, but the documented sequence of recording `commands`, sending and waiting for it to grow does not identify which caller's command completed on a shared pane. A prior in-flight command or another writer can increment it. Use an exclusive known shell with no pending work for that recipe. General orchestration needs a submission/completion sequence that identifies the particular task, or a task-specific output marker. `wait` remains a state observation at `src/main.ts:6580`, not a task receipt. For agent panes, the quiet-state heuristic still does not distinguish completed work from a pause or prove success.

**Retries still lack deduplication.** The new `sent` field usefully distinguishes many pre-send errors from uncertain replies. It does not identify an operation or let the caller query its result. A mutation that times out can still finish. The transport has no caller request ID, retained result or deduplication record. A controller must not automatically resend a task or recreate a thread after an uncertain outcome. A bounded per-instance request/result cache is the smallest direct solution if automatic retry is a requirement.

**Discovery is usable for a known endpoint.** `info` exposes the instance PID and process pipe. A controller can pin that pipe, list threads, verify the intended checkout directory, and select exact pane IDs with their generations. It still cannot enumerate all Loom instances or inspect the profile path from hello. This is now acknowledged in the documentation. After the app restarts, rediscover identities rather than falling back silently to names, pane positions or the current pane.

**Terminal and session targeting remain explicit.** For a fresh shell in an existing thread, `add <thread-id> --cmd=` returns a pane ID. A thread's directory remains context, not a verified current shell cwd. `new` resolves a Git root and can reuse an existing thread. Restarting a session without an available saved identity can still require the GUI. There is no CLI session picker yet.

**Approval identity covers the visible bounded prompt.** The parser now includes the previously missing visible command and description text, but cannot establish content above the screen. A controller should inspect `prompt` and refuse approval when it cannot see the complete requested action. Unnumbered prompts still require keys rather than the menu-revision path. The current review does not claim comprehensive coverage of real Claude/Codex prompt layouts.

**The transport boundary is the Windows account.** The owner/SYSTEM ACL, rejection of remote clients and request-size limit remain in the reviewed code. No bypass was confirmed, and runtime ACL testing was not performed. Access grants broad instance control; `--yes` is not authentication. Terminal output remains unredacted and untrusted task data. Avoid copying secrets or following instructions merely because they appear in another pane's output.

## Controller workflow I would use now

1. Read `info` JSON, pin the returned process pipe, then verify the intended checkout through `threads` JSON.
2. Select an exact pane ID and record its `generation`. Inspect its role and recent output before writing.
3. Send task text through stdin with `--gen`. For numbered approvals, also use the inspected `--menu` revision and require a complete visible prompt.
4. Interpret errors using exit status plus JSON. Respect `typed` and `pressed`; neither failed CLI execution nor a terminal restart undoes prior side effects. Treat S1's write-error boundary as uncertain until fixed.
5. Observe shell completion only under controlled ownership or with a task-specific marker. Treat `exit` as approximate until S2 is resolved. For agent work, require explicit evidence of the task's outcome instead of equating idle with success.
6. Reconcile uncertain mutations before retrying. Stop if the available observations cannot establish what happened.

That workflow supports supervised control. It does not provide general exactly-once task execution or fully automatic recovery.

## Validation and limits

Passed for the fresh snapshot:

- 47 CLI helper checks and 30 prompt helper checks.
- TypeScript `tsc --noEmit --incremental false` and `git diff --check 2278a3a..HEAD`.
- Nine existing CLI/pipe Rust tests, compiled offline against unchanged copied source in a minimal test crate. The corresponding test CLI binary built successfully.
- Six isolated frontend scenarios using current implementation extracted through the TypeScript AST. These cover the menu and partial-key fixes, generation preconditions, queued input, stdin/long paste, and new output fields.
- Eight isolated mock-pipe scenarios using the compiled current CLI. These cover identity, JSON error paths, greeting timeout, lost replies, partial-key details and opaque stdin.
- One additional Rust/Tokio fault-injection test demonstrating the write/framing mismatch in S1.
- One isolated PowerShell reproduction demonstrating the repeated-exit-code behavior in S2.

Diagnostic assertions that demonstrate defects also pass when the defect is observed. They are not claims that the behavior is correct. The test CLI connected only to uniquely named mock pipes. No commands were sent to real Loom panes, no existing agent was messaged, and no Loom process was started or stopped.

Not run: full Tauri build, the live `scripts/cli-check.mjs` or `scripts/ui-check.mjs`, installer/update, runtime ACL validation, real agent prompt rendering, or a real Windows named-pipe fault test for S1. New checked-in tests were inspected; documentation claims about live tests are not counted as results of this review. Mocked frontend tests do not exercise native IPC timing and actual terminal behavior.

Local evidence is preserved at `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20260930T2312`: source snapshot, hash manifest, current diff, frontend and transport scripts/logs, transport result JSON, the Rust framing fixture/log and PowerShell outcome fixture. The three earlier reports are preserved.

The next useful release gate is accurate delivery uncertainty, an honest shell-outcome contract, and task-correlated completion/retry behavior for the degree of automation Loom intends to support. The previous four fixes are real progress and should remain covered by their regression tests.
