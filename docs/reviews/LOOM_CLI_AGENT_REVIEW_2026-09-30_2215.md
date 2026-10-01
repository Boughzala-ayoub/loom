# Fresh Loom CLI review for agent control

Reviewed on 2026-09-30 UTC from the perspective of a headless agent using the CLI to discover Loom, choose the right session, send work and determine what happened.

**Verdict: substantially improved, but not ready for reliable unattended orchestration.** All six exact reproduction cases from the previous agent review now have working fixes in the isolated checks. Four current defects remain. The most serious is that a menu revision can remain unchanged when an omitted part of the question or option changes. Task completion and safe retries also remain explicit, documented product gaps.

## Snapshot

- Worktree: `C:\Users\ayoub\loom\loom\go`, branch `loom/go`. Git worktree metadata confirms this checkout is separate from the main checkout under `Videos\claude\loom`.
- HEAD: `2278a3aead7a54b3afbb7fe1351f4a4bd3cc64ad`, `Make loomctl safe to drive agents with`.
- Comparison: `6e6d151..2278a3a`, ten files, 517 additions and 106 deletions.
- Initial verification: **2026-09-30T22:16:27Z**. No staged or unstaged tracked changes. The only untracked files were the two earlier review reports.
- At **22:23:37Z**, HEAD was unchanged and all 80 files in the bounded source snapshot matched their SHA-256 hashes. Findings refer to this snapshot, not to the earlier reports.
- Read applicable `C:\Users\ayoub\AGENTS.md` and the relevant review/prose skills. No additional repository AGENTS.md or relevant repository-local skills were found in the reviewed directories. No source changes, commits, installs or operations against live panes were performed.

## Confirmed findings

### R1. P1: menu revisions omit material question and option text

Locations: `src/prompt.ts:27`, `:31-36`, `:43-48`, `:59-63`; `src/main.ts:6535-6540`, `:3333-3335`.

The new revision hashes `readMenu`'s extracted question and options. That extraction keeps only four nonblank question lines and the first line of each numbered option. It skips wrapped option text and descriptions. A change in those omitted lines therefore produces the same revision. This is a deterministic omission, not a hash collision.

The current implementation accepted this transition under the original `--menu` revision:

```text
Which folder should be removed?
❯ 1. Build output
     C:\project\build
  2. Cancel
```

The second screen changed only `C:\project\build` to `C:\project\src`. `readMenu` and `menuRev` produced the same identity, and the actual choose handler sent Enter. Another fixture changed `rm -rf build` to `rm -rf src` above four common question lines. Both parsed menus were identical.

The old short-question case is fixed: changing "Read README?" to "Delete the project?" now rejects the queued selection, and a stale expected revision also rejects it. The broader approval guarantee remains incomplete because meaningful displayed text is missing from the identity.

**Impact:** a controller that reads a menu and later approves its revision can authorize different work. The isolated test recorded only mocked input; it did not delete anything or answer a live permission prompt.

**Smallest fix:** include the entire relevant prompt and wrapped option details in the revision. Keep the highlight out of the identity, but preserve substantive text. If the full prompt cannot be captured, refuse to promise a verified selection from that partial representation.

**Acceptance tests:** change only a wrapped option target, and change only a command above the last four question lines. Both old revisions must fail with zero Enter writes. Moving the highlight alone must preserve the revision.

### R2. P2: the protocol greeting can hang beyond the requested timeout

Locations: `src-tauri/src/bin/loomctl.rs:192-207`, `:208-224`.

The client performs a blocking write/read exchange for the greeting before starting its timeout watchdog. `info` returns before the watchdog is ever created. A pipe that accepts the connection but never answers the greeting leaves every command blocked without a client deadline.

**Reproduction:** compiled the unchanged current CLI and pipe source in an isolated minimal crate. A uniquely named mock pipe accepted `loomctl --json --timeout 0.05 info`, received only `{"hello":2}`, and deliberately withheld its answer. The CLI was still blocked after **22,540 ms**, beyond the requested timeout plus the existing 20-second watchdog margin. The test then terminated only that test CLI process. No Loom endpoint was contacted.

**Impact:** an agent can hang even while attempting discovery or recovery. The new compatibility check is useful, but an unresponsive peer must not prevent timeout handling.

**Smallest fix:** establish a deadline before the greeting and cover both greeting and command exchanges, including `info`. Preserve the distinction between a timeout before any command was sent and an uncertain outcome after sending one.

**Acceptance test:** a mock that never responds to hello causes a bounded exit with code 3 and a structured timeout result; the mock observes no mutation request. A normal hello and command still complete successfully.

### R3. P2: partial keys can report that nothing was submitted after sending Enter

Locations: `src/main.ts:3294-3297`, `:6518-6522`, `:6721-6723`.

The generation guard always throws `NotSubmitted(..., false)` after a stop/restart and says "nothing was submitted." That is accurate for a task still queued before its first write. It is false for a multi-key sequence that has already sent Enter before a later generation check fails.

**Reproduction:** the actual event handler processed `keys p1 enter x`. The fixture recorded the first Enter write, then changed the process generation during the settle between keys. The second key was correctly blocked, but the JSON result was `ok:false`, `typed:false`, with "nothing was submitted" in its error. An existing command in the shell input could already have run on that first Enter.

**Impact:** a controller reconciling a partial operation receives an incorrect assurance. Restarting the terminal does not undo a command's filesystem or other external effects, so retrying based on that result can duplicate work.

**Smallest fix:** distinguish rejection before the first write from interruption after any writes. For `keys`, report the number of delivered keys or a partial/unknown outcome and never say no submission occurred after Enter was delivered. Keep the useful `typed:false` response for an untouched queued send.

**Acceptance test:** interrupt `keys enter x` after its first write. The result must acknowledge the partial delivery and possible submission. A generation change before the first key must still report zero writes.

### R4. P2: --json failures are still plain stderr on greeting and transport paths

Locations: `src-tauri/src/bin/loomctl.rs:163-165`, `:187-206`, `:229-239`.

The new JSON failure path runs only after a command reply is received. Parse errors, connection errors, greeting failures and transport write/read errors return through earlier branches without emitting a JSON result. The watchdog path likewise writes only stderr. This differs from the new help/documentation statement that a failure under `--json` prints its answer as JSON.

**Reproduction:** the compiled current client ran `--json close explicit-pane --yes` against an isolated mock of an old server. The compatibility protection worked: only hello was sent, and the process exited 2. However, stdout was empty and the error existed only on stderr. A separate mock command error after a valid hello correctly produced JSON and exit 1.

**Impact:** a headless wrapper cannot uniformly decode errors or distinguish protocol mismatch, absence, timeout and uncertain delivery from structured data. It must retain special stderr handling for exactly the recovery paths where structured errors matter most.

**Smallest fix:** route client-side and server-side failures through one small JSON-aware error formatter with stable codes. Keep the existing exit codes and human stderr if desired. Include whether a command was sent when the outcome is uncertain.

**Acceptance tests:** under `--json`, test malformed options, an absent uniquely named pipe, an old greeting, a dropped connection and a timeout. Every failure should produce one parseable JSON result with its error code and delivery certainty.

## Disposition of the previous six findings

| Previous finding at 6e6d151 | Current disposition and evidence |
| --- | --- |
| A1, mixed protocol versions lose the target | Fixed for the reviewed compatibility paths. The current binary sends only hello to a mock old server and exits 2. The current server refuses a missing/mismatched hello before `ask`, and validates command/argv shape in `control.rs:102-127`. A direct frontend check rejects missing argv without closing the current pane. The actual Tauri server was not launched. |
| A2, queued input reaches a restarted session | Fixed in the exact queue reproduction. Old queued text is rejected with no writes to the new generation; fresh text succeeds. Restart during the paste's settle also prevents the old Enter. The native IPC scheduling boundary was not stress-tested. |
| A3, stop misses a dead Codex pane's pending restart | Fixed. Using current spawn/launch/stop methods, stop cancels the held session lookup. The call sequence is `has_codex_session`, `pty_kill`, with no `pty_spawn`, and restart reports cancellation. |
| A4, same options conceal a changed question | The exact short-question case is fixed, including an explicit stale `--menu` check. Mark the broader finding partially resolved because R1 still permits changed omitted text. |
| A5, stdin beginning -- becomes options | Fixed. The actual client transmits stdin separately, and the current frontend substitutes it after option parsing. Both ordinary `-` and `-- -` preserve leading options as text. It removes one final line break, which README now explicitly documents. |
| A6, long task prefix scrolls offscreen | Fixed for the previous screen state and the added collapsed-paste states. The current send issues one paste and one Enter for a long scrolled task or a collapsed placeholder. When text never becomes visible, it issues one paste, no Enter, and returns `typed:true`. This is echo confirmation, not a durable task receipt. |

## What I could do through the CLI alone

For a known Loom endpoint, the practical workflow is now clearer:

1. Run `loomctl --json info`. Record the returned `protocol`, `pid`, `pipe` and `via`. Pin subsequent calls to that returned process pipe through `LOOM_PIPE`, then use `threads` to verify the intended checkout directory. Handle a timeout with an outer process deadline until R2 is fixed.
2. Use `threads` and `panes` JSON to choose exact thread/pane IDs and inspect the configured `agent`. Avoid current-pane defaults, name prefixes and pane positions when operating asynchronously.
3. For a fresh terminal in an existing thread, use `add <thread-id> --cmd=` and retain its returned ID. `new <folder>` resolves to the Git top level and may reuse an existing thread. It is not an arbitrary nested-cwd terminal constructor. A thread's `dir` is context, not proof of the shell's current directory.
4. Send task text through stdin, account for the documented single trailing-newline removal, and inspect the result. Use `read` for recent output. A `typed:true` failure means do not paste the same task again blindly. Check the pane before deciding whether any further key is appropriate.
5. Read a numbered question, inspect its full visible content, and use `choose --menu` when appropriate. R1 currently prevents treating the revision as complete approval identity. Unnumbered prompts still require keys and cannot use that guarantee.
6. Use `wait` to observe a state, not to declare the task successful. Capture a task-specific result marker and exit code in a controlled shell workflow, or use an agent-specific completion signal where available. Do not automatically retry an ambiguous mutation.

This is a usable basis for supervised control. The remaining gaps below prevent a general unattended controller from proving which task completed, with what result, and whether a retry is safe.

## Remaining design gaps, not new regression findings

**Task outcomes and freshness remain missing.** `paneData` at `src/main.ts:6185-6188` exposes state, session and directory but no process generation, output timestamp, command sequence or exit result. Claude's busy heuristic clears after 1.5 seconds of quiet at `:1977`. `wait` at `:6551` is level-triggered and can immediately see an existing idle state. The current fixture confirmed this, and `Pane.mark('D;7')` at `:2228-2232` still discards exit status 7. The docs now acknowledge this limitation. The smallest useful improvement is to retain the existing shell command-end status and sequence, expose output freshness, and let waits refer to the sequence following a particular submission. An agent TUI still needs an explicit completion/attention distinction rather than a quiet-screen inference.

**Retry reconciliation remains missing.** The transport's request IDs at `control.rs:149-168` are internal, with no caller retry key or queryable receipt. A timeout ends the wait but does not cancel the operation. The new partial-paste result addresses one failure mode, not a disconnect after an accepted command. Use a small per-instance request/result cache with caller-provided IDs if automatic retry is required. Until then, the controller must treat those outcomes as uncertain, and `threads` or `read` cannot always prove whether a task already ran.

**Identity is improved but does not yet bind observation to execution.** `info` supplies a process and its pipe, so the earlier lack of any handshake is resolved. An external shell still needs an initial endpoint/profile, and there is no CLI enumeration of all instances. The hello omits the profile/workspace path and a process-generation nonce. Pane IDs last only for the app lifetime, and the internal generation guard starts at queue time, not at an earlier `panes` observation. Exposing generation and accepting an expected generation would let an agent reject work intended for the session it previously inspected. After reconnect, rediscover rather than silently reusing names or positions.

**Headless session recovery and capabilities are still limited.** Restart can direct the caller to pick a saved session in the GUI at `src/main.ts:6585`; session selection through the CLI is explicitly not done. Help describes commands, but no structured capability/option schema establishes which recovery operations exist. Successful JSON answers remain command-specific data, while failures use an envelope. That can be supported by a wrapper if documented and versioned; R4 is the concrete inconsistency that still needs fixing.

**Security boundary remains the Windows account.** Source inspection found owner/SYSTEM pipe ACLs, refusal of remote clients and a bounded request size. No ACL bypass was confirmed. Anyone permitted to control the pipe has broad control of that Loom instance; `--yes` is not authentication. Terminal output is unredacted and can contain secrets or untrusted instructions. Treat it as data, minimize captured output and avoid copying credentials into orchestration logs. No live terminal output was collected in this review.

## Validation and limits

Passed on this fresh snapshot:

- 47 `src/cli.test.ts` checks and 22 `src/prompt.test.ts` checks.
- TypeScript `tsc --noEmit --incremental false`, and `git diff --check 6e6d151..HEAD`.
- All eight existing Rust CLI/pipe tests, compiled offline in a minimal isolated crate against unchanged copied source. The corresponding test CLI binary also built successfully.
- Thirteen isolated frontend workflow scenarios. They use the current implementation extracted with the TypeScript AST and controlled pane/native-operation fixtures. These cover the six earlier cases, the remaining menu cases, partial keys and task-state limitations.
- Five mock-pipe scenarios using the compiled current CLI: old server, info, opaque stdin, a JSON command error and a silent hello. The last scenario deliberately reproduced the hang and terminated only its own process after 22.5 seconds.

Passing a diagnostic scenario means its assertion was verified, including assertions that demonstrate a defect. The first frontend run exposed a missing `cli_ready` case in the review fixture after its assertions; that fixture was corrected and the full run then exited 0. The first subprocess test attempt was blocked by the execution sandbox, then completed after the narrowly scoped test execution was approved. Neither was a Loom source change.

Not run: the checked-in live `cli-check.mjs` or `ui-check.mjs`, full Tauri build, installer/update, runtime ACL tests, real terminal rendering tests or any command against an existing Loom pane. The new checked-in regression tests were read, but their claimed live results in documentation are not counted as this review's results. Mocked frontend tests do not validate real IPC scheduling, PTY behavior or every Claude/Codex prompt layout.

Evidence is kept locally at `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20260930T2216`, including the source hash manifest, current diff, `checks/agent-checks.mjs`, its successful log, `checks/transport-checks.mjs`, transport log/results and the isolated Rust crate. Earlier review files are preserved.

Before trusting this as an unattended controller, I would fix R1-R4 and add task-correlated outcome and retry reconciliation. The current fixes make ordinary targeted control safer; they do not yet make idle state or a CLI exit code proof that the requested task completed exactly once.
