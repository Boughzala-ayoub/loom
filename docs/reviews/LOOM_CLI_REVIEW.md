# Loom CLI review

Fresh review of `C:\Users\ayoub\loom\loom\go`, completed on 2026-09-30 UTC.

Ten confirmed findings remain: five P1 issues and five P2 issues. Fix the P1 issues before relying on unattended CLI control. All eight findings from the earlier review remain present. This review also confirms a startup/stop race and a pane-count validation defect.

## Snapshot and scope

| Item | Reviewed state |
| --- | --- |
| Worktree | `C:\Users\ayoub\loom\loom\go` |
| Branch | `loom/go` |
| HEAD | `bfeb731d2eaaf8aae69e91c1bd2ed3313f09a55e` |
| Commit | `Control the running Loom from a terminal with loomctl` |
| Comparison base | `2659e4c10c65ea533bfbb250b87e74d1af0416c5` |
| Initial verification | 2026-09-30 20:08:20 UTC |
| Latest source hash verification before drafting | 2026-09-30 20:11:27 UTC |
| Initial working tree | Clean; no staged, unstaged, or untracked changes |
| Reviewed change | 15 files, 1,487 insertions, 17 deletions |

The CLI changes are now committed, so this review compares the CLI commit with its parent. It covers the client parser and output, named-pipe routing and access controls, frontend command handlers, pane/process lifecycle, reused thread/worktree operations, installer/update changes, documentation, and tests. Source line numbers below refer to the reviewed HEAD.

A fresh 78-file source snapshot was copied into the review workspace. All 78 files still matched the worktree at the verification time above. The 76 files shared with the earlier review's source snapshot were also byte-identical, which explains why the earlier defects remain. Current code was reread and the isolated checks were rerun; earlier test results were not used as current validation.

No source files, Git index, commits, app settings, services, or live panes were changed. The requested Markdown report is the only intended addition to the Loom worktree. Diagnostic code and compilation output were kept outside it.

## Findings

### F1. P1: Boolean options consume positional arguments and can change the action

Locations: `src-tauri/src/bin/loomctl.rs:80-91`, `src/cli.ts:21-24`, `src/main.ts:6373-6374`, `src/main.ts:6468-6471`.

The parser treats every option other than its few global options as taking the following word when available. This includes boolean flags such as `--no-enter` and `--yes`, despite the usage text saying options can go anywhere.

The fresh Rust parser checks and frontend command checks reproduced both cases:

```text
send p1 --no-enter echo hello
  -> args._ = ["p1", "hello"], no-enter = "echo"
  -> writes ["hello", "\r"]

close --yes target-pane
  -> args._ = [], yes = "target-pane"
  -> closes the current shell pane instead of target-pane
```

In the second case, a current agent pane would normally refuse because `yes` is false, but a current shell pane needs no confirmation and is closed. These are unintended execution and wrong-target defects, not just syntax errors.

Suggested fix: define which options are boolean, parse a bare boolean without consuming a positional argument, and validate any explicitly supplied boolean value. Add regressions for flags before, between, and after positional arguments. Preserve `--` handling.

Evidence: isolated Rust parser tests and actual current frontend handlers with mocked pane writes/closure. No real pane received these commands.

### F2. P1: Development and installed Loom route to the same default pipe

Locations: `src-tauri/src/pipe.rs:6-11`, `src-tauri/src/control.rs:36-38`, `src-tauri/src/lib.rs:124-130`, `src-tauri/src/lib.rs:264`, `src-tauri/src/lib.rs:1358-1372`.

Both default instances use `\\.\pipe\loom-<user>`. The rest of Loom explicitly separates development and release workspace data and allows those instances to run together. The second pipe server fails its first-instance check, but that Loom continues running and still gives its panes the colliding `LOOM_PIPE` value. A command launched from those panes reaches the other Loom.

This breaks the documented promise that a pane controls its owning instance. Input, stop, close, and workspace operations can affect another workspace. Duplicate explicit-profile launches have the same ownership problem even though the saved profile path is shared.

Suggested fix: include the resolved workspace identity and the development/release distinction in routing. For launches that may coexist, use a distinct instance endpoint for child panes or reject the duplicate clearly. Do not advertise another instance's endpoint after a bind failure.

Evidence: confirmed by current naming, bind-failure, child-environment, and instance-startup code. No live second instance was launched. The existing pipe test only compares profile path spellings and distinct profile paths.

### F3. P1: Duplicate deletion requests can drop an unrelated thread

Locations: `src/main.ts:6479-6490`, `src/main.ts:3946-3951`.

Two `close-thread alpha --yes --delete worktree` requests can resolve the same thread before either asynchronous risk check finishes. The first request removes `alpha`. The second then reaches `threads.indexOf(th) === -1` and executes `threads.splice(-1, 1)`, removing the last unrelated thread.

Starting with `alpha` and `beta`, the fresh isolated reproduction left the thread array empty after two requests targeting only `alpha`. The unrelated thread is dropped from the workspace and subsequent save without disposing its own panes. This finding does not claim that beta's files are deleted.

Suggested fix: revalidate membership after asynchronous checks, guard against negative indices in `removeThread`, and serialize destructive operations per thread. Return an explicit already-closed result or error for the second request.

Evidence: current CLI handler and current `removeThread`, with delayed mock risk checks and mocked Git/disposal. No worktree was actually removed.

### F4. P1: Concurrent input commands combine text before submission

Locations: `src/main.ts:6368-6374`, `src/main.ts:6391-6393`, `src/main.ts:6407`, `src/main.ts:3236-3241`, `src/main.ts:6561-6567`.

Each incoming command runs independently. `send` writes its text, waits for terminal output, and then submits, but there is no per-pane exclusion around that sequence. Two simultaneous sends reproduced:

```text
["echo one", "echo two", "\r", "\r"]
```

A shell or agent receives combined input instead of two separate submissions. Multi-step `keys` and `choose` operations can also overlap this sequence. The existing dashboard answer lock at `src/main.ts:3260` does not protect CLI callers.

Suggested fix: queue complete input operations per pane and coordinate them with dashboard actions. Revalidate the pane before execution. Keep reads and waiting commands independent so a waiting request cannot block the action that satisfies it.

Evidence: current `send` and `sendReply` functions with controlled terminal-settle promises and recorded mock writes.

### F5. P1: Stop can succeed while a pending startup later launches the process

Locations: `src/main.ts:1765-1767`, `src/main.ts:1815-1823`, `src/main.ts:1847`, `src/main.ts:6456-6461`, `src/main.ts:7015-7016`.

`stop()` kills the currently registered PTY and marks the pane dead, but it does not cancel an in-flight `spawn()`. A restoring Claude pane can be awaiting `has_session` or a startup slot before a PTY exists. The CLI is installed before restored panes finish starting.

The fresh lifecycle check held `has_session` pending, called `stop()`, and then released the session check. The actual methods produced:

```text
has_session -> pty_kill -> pty_spawn
```

Stop had already succeeded when the new process was launched. The pane remained marked dead in this interleaving, so later `stop` commands can also return "already exited" while the process runs. A user or script cannot rely on successful stop to prevent further agent work.

Suggested fix: give each spawn attempt a generation or cancellation token. Invalidate it on stop and check it after each await and before publishing the spawned process. Cover startup, stop, restart, and close races without serializing unrelated panes.

Evidence: current `Pane.spawn`, `Pane.stop`, and `Pane.exited` methods, with a delayed session-check mock and recorded native-command calls. No process was launched by the reproduction. This is an additional finding in this review.

### F6. P2: Concurrent new commands can return another request's thread ID

Location: `src/main.ts:6330-6334`; related helper: `src/main.ts:4988-5037`.

The handler finds its result by comparing the global thread list before and after asynchronous creation. If request A waits on worktree creation and request B opens its thread first, B can be the first new thread visible to A. The fresh reproduction returned beta's ID for both `new alpha` and `new beta`.

An automation that uses the returned ID for subsequent input or closure can target another thread even though creation itself succeeded.

Suggested fix: return the exact created or selected `Thread` from `createThread`. Do not infer request ownership from changes to a shared list.

Evidence: the current CLI handler with controlled asynchronous creation ordering. The helper's existing awaits before insertion make that ordering possible.

### F7. P2: Native launch and deletion failures can return CLI success

Locations: `src/main.ts:6449-6450`, `src/main.ts:1856-1868`, `src/main.ts:6490-6491`, `src/main.ts:3966-3968`.

The CLI reuses functions whose UI error handling consumes failures. `Pane.spawn` catches a failed `pty_spawn`, marks the pane dead, and resolves. `restart` then returns "restarted". `removeThread` catches a failed worktree or branch deletion and only shows a toast, after which `close-thread` returns success.

Fresh injected-failure checks reproduced a restart result with `state: "exited"` and text `alpha:1 restarted`, and a deletion result `Closed alpha` after every mocked removal attempt failed. The dispatcher wraps these fulfilled results in `ok: true`, so the client exits 0.

Suggested fix: propagate failure or return explicit results from the shared helpers. The CLI must acknowledge successful completion of the requested operation. If deletion partly succeeds, return a failure describing what remains rather than hiding the error in a UI toast.

Evidence: current helpers and handlers with injected native and Git failures. This item retains the two failure paths grouped in the previous review.

### F8. P2: Relative repository paths use the GUI process's working directory

Locations: `src-tauri/src/bin/loomctl.rs:156-160`, `src/main.ts:6322-6327`, `src-tauri/src/lib.rs:501-509`.

The client sends the folder argument unchanged and sends no caller working directory. The server then runs `git -C <folder>`. For `loomctl new .`, the dot is interpreted by Git launched from Loom, not from the invoking terminal.

When the terminal and GUI have different working directories, the command can open the wrong repository or reject a valid one. Absolute-path examples in the current integration test do not cover this case.

Suggested fix: resolve `new`'s folder argument against the caller's working directory before sending it, or transmit that directory and use it explicitly. Test a terminal directory different from the GUI launch directory, including paths with spaces.

Evidence: current request serialization and backend process construction. No live GUI command was run.

### F9. P2: Successful null results are not valid JSON output

Locations: `src-tauri/src/bin/loomctl.rs:172-180`, `src/main.ts:6247`, `src/main.ts:6272`.

With `--json`, the output code prints data only when it is non-null. `menu` with no menu and `next` with nobody waiting are successful commands that return null. Their output is empty instead of the valid JSON value `null`.

A standalone program containing the exact current output block and a successful null reply exited 0 with zero stdout bytes. A JSON consumer cannot distinguish this result from missing or truncated output and `JSON.parse` fails.

Suggested fix: when JSON mode is selected, serialize the data value even when it is null. Add null-result cases alongside array and object output tests.

Evidence: isolated compilation and execution of the exact current output block. It contains no pipe connection code.

### F10. P2: Fractional pane counts create a worktree before validation fails

Locations: `src/cli.ts:27-32`, `src/main.ts:6329-6331`, `src/main.ts:5026`, `src/main.ts:5037`.

`num` accepts any finite number in range, including `1.5`. In `new <repo> --name task --panes 1.5`, `createThread` performs `git worktree add` before evaluating `Array(n)`, which then throws `Invalid array length`.

The fresh isolated check confirmed that the worktree-add call occurred before the exception. A rejected argument can therefore leave a branch and worktree behind, and retrying with a corrected count can create a suffixed second worktree.

Suggested fix: require an integer pane count before any worktree operation. Validate other integer-only options separately and reject missing numeric values instead of coercing a bare flag to 1.

Evidence: current `new`, `num`, and `createThread` with recorded mocked Git calls. No branch or folder was actually created. This is an additional finding in this review.

## Status of previous findings

| Earlier finding | Current result |
| --- | --- |
| Boolean option parsing | Still present, F1; rerun parser and handler reproductions |
| Default pipe collision | Still present, F2; current routing and startup code traced |
| Duplicate deletion removes another thread | Still present, F3; rerun isolated reproduction |
| Concurrent input interleaves | Still present, F4; rerun isolated reproduction |
| New returns another thread ID | Still present, F6; rerun isolated reproduction |
| Failed operations return success | Still present, F7; both failure paths rerun |
| Relative repository paths | Still present, F8; current client/backend path flow traced |
| Null JSON output | Still present, F9; current output block compiled and checked |

No earlier finding was marked fixed. F5 and F10 are newly reported here.

## Verification and test gaps

| Check | Result |
| --- | --- |
| `node src/cli.test.ts` against the fresh snapshot | 27 checks passed |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` in the worktree | Passed, exit 0 |
| `git diff --check 2659e4c..HEAD` | Passed, exit 0 |
| PowerShell parser on `scripts/update.ps1` | Zero parse errors |
| Offline isolated Rust CLI build/tests | Five existing tests passed; three added diagnostic assertions also passed |
| Fresh frontend diagnostic script | Ten diagnostic scenarios completed, exit 0; reproduced the defects and the pre-existing quoting limitation described below |
| Standalone JSON output check | Exit 0 with zero stdout bytes, confirming F9 |

The added diagnostic assertions deliberately assert the observed defective behavior. Their passing result confirms a reproduction; it does not mean the feature passes a correctness test. They should become expected-correctness regression tests when the defects are fixed.

The isolated Rust crate compiled the current client and pipe-name code with cached `serde_json`. It did not compile the full Tauri application or its control server. Node was v24.18.0 and rustc was 1.97.1.

Diagnostic files are retained outside the worktree at:

```text
C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-review-20260930T2008\checks\
```

Useful evidence files are `review-checks.mjs`, `diagnostic.log`, `helpers.log`, `loomctl-review.rs`, `render-check.rs`, and `json-render.log`. The parent snapshot directory contains `snapshot-hashes.json` and `cli.diff`. The frontend script extracts current source functions, transpiles them using the installed TypeScript compiler, and substitutes controlled Git, PTY, timer, and UI dependencies. It does not connect to Loom.

Not run: the full native build, installer compilation or installation, updater execution, live named-pipe/ACL tests, or `scripts/cli-check.mjs`. That integration script starts Loom, creates profiles and repositories, sends pane commands, and terminates its child process. Running it would exceed this review's read-only/live-app constraints. Existing documentation claims about prior live-test success were not treated as results of this review.

The checked-in tests do not cover boolean flags before positionals, simultaneous destructive/input commands, stop during startup, injected native/Git failures, caller-relative paths, null JSON output, or invalid pane counts before side effects. Add these cases along with a development/release routing test. Test installer/update behavior while a long `wait` command is running; that scenario was inspected but not executed here.

## Security boundaries and remaining questions

The control server builds an explicit DACL for the current token's user SID and SYSTEM at `src-tauri/src/control.rs:79` and requests remote-client rejection at line 54. It limits request reads to 1 MiB at line 97. I found no confirmed cross-account or remote-access bypass in this review. Runtime ACL enforcement remains untested. F2 concerns routing between instances of the same user, not a cross-account bypass.

`--cmd` intentionally launches commands and `send` intentionally writes terminal input. Those capabilities are part of the requested feature. A process that can use this control endpoint receives broad control over the user's Loom panes; there is no per-pane authorization boundary. Confirmation flags are safeguards against mistakes, not authentication.

Pane and thread IDs come from `uid()` at `src/main.ts:1042`, with allocations at lines 1442 and 2201, and are not saved in the workspace. Treat them as stable only during one app lifetime. Name/index references can change when panes are reordered or threads renamed. Whether IDs should survive restart is a product/API contract question, not a new regression claim.

The existing Claude startup parser at `src/agent.ts:83` splits arguments on whitespace. A fresh isolated check confirmed that a quoted settings path with spaces becomes two arguments when reached through `--cmd`. This code predates the CLI commit, so it is recorded as an inherited limitation rather than counted among the ten findings.

Timeouts currently bound waiting for a frontend reply rather than canceling an in-flight action. The client also has no independent read deadline. Document whether a timeout may leave an operation running and test retry behavior before scripts assume a timed-out mutation did not happen. This is a contract/test gap, not an additional reproduced defect in the count above.

This report reflects the specified commit and snapshot only. It does not certify the behavior of an installed executable or any edits made after the snapshot.

Final pre-save source verification: 2026-09-30 20:15:41 UTC. HEAD and all 78 snapshot hashes matched. The worktree was clean before the report was added.
