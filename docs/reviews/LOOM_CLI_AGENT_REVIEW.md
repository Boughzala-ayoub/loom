# Loom CLI review: using it as an agent controller

Reviewed 2026-09-30 UTC. Verdict: **not ready for reliable unattended agent control**. The current CLI can list panes, read output and operate a known instance, and the recent fixes resolve most earlier defects. Six confirmed defects still affect target safety, cancellation, permission selection and exact task delivery. Separately, the interface cannot yet establish a task's completion and exit outcome or safely reconcile an uncertain send.

## Snapshot and scope

- Worktree: `C:\Users\ayoub\loom\loom\go`, branch `loom/go`.
- HEAD: `6e6d1519bdff7289767fb867de3602e68d3f07d7` (`Fix what the loomctl review found`), following `bfeb731`.
- Snapshot started at **2026-09-30T21:03:32Z**. At **21:12:55Z**, HEAD was unchanged and all 77 hashed snapshot files still matched. There were no staged or unstaged tracked changes. The only untracked file was the earlier `LOOM_CLI_REVIEW.md`.
- Reviewed the fresh 11-file fix commit (662 additions, 256 deletions), current CLI and pane lifecycle code, transport, routing, output/state helpers, documentation, updater and relevant tests. The previous report was background, not reused as current findings.
- Read applicable `C:\Users\ayoub\AGENTS.md` and relevant review/prose skill instructions. No source, Git state, application process or live pane was changed. Only this requested report is added to the worktree.
- Paths and line numbers below refer to this HEAD. P1 means fix before unattended control; P2 means a reproducible functional failure under a specific input or display condition.

## Confirmed defects

### A1. P1: incompatible client/server versions silently lose the target

**Evidence:** `src-tauri/src/bin/loomctl.rs:178`, `src-tauri/src/control.rs:125`, `src/main.ts:6662`, `src/main.ts:6560`; updater at `scripts/update.ps1:26`.

The protocol changed from an `args` object to an `argv` array without version negotiation. A new server forwards a missing `argv` as null, and its frontend converts that to an empty argument list. The previous server does the corresponding thing with a missing `args`. Consequently, a targeted command can become an untargeted command. `close` resolves an absent target to the current pane and permits closing a shell without `--yes`.

**Reproduction:** isolated tests ran both versions' actual frontend event handlers with the request shape their transport produces for the other client version. In both directions, the intended target was lost, the current shell pane was closed, and the reply was `ok: true`. These were mocked panes, not live sessions. This is a realistic upgrade state: the updater replaces `loomctl.exe` while deliberately leaving an already running Loom open until its next normal launch.

**Impact:** an agent can close the wrong pane while believing it operated on a stable explicit ID. Other commands with current-pane defaults have the same target-loss risk.

**Smallest fix:** negotiate a protocol version before any mutation, reject unsupported peers, and reject missing or malformed command arguments instead of treating them as an intentional empty list. The new client must also detect an old server; hardening only the new server is insufficient.

**Acceptance test:** old client/new server and new client/old server each return an explicit compatibility error, with zero pane mutations. A current/current targeted close affects only the supplied ID.

### A2. P1: queued input is delivered to a replacement process after restart

**Evidence:** `src/main.ts:3269` (`inTurn`), `src/main.ts:6456` (`send --no-enter`), `src/main.ts:6531` (`restart`).

Input serialization is now present, but queued input is bound to the Pane object, not its process generation. The queue checks only that the pane is currently alive and still belongs to its thread. A restart reuses that object and pane ID. An old queued task therefore passes the checks after the replacement process starts.

**Reproduction:** hold one input turn, enqueue `send p1 "old-session task" --no-enter`, restart p1, then release the held turn. The current CLI implementation writes the old task into generation 2. The restart's stop/spawn operations were mocked; the queue and command handlers were the actual current implementation.

**Impact:** an agent can send work to a different session from the one it inspected, especially after a timeout or recovery attempt. Serializing two sends does not protect sends against lifecycle changes.

**Smallest fix:** capture the existing `launchGen` when input is queued and reject if it changes, including before later writes or Enter within a sequence. Stop/restart should invalidate pending input for the old generation.

**Acceptance test:** input queued before stop/restart fails with a stale-session error and produces no writes to the replacement process; newly queued input still works.

### A3. P1: stop can report success while a Codex restart continues and spawns

**Evidence:** `src/main.ts:6549`, `src/main.ts:1800`, `src/main.ts:1812`, `src/main.ts:1841`.

During restart of a dead Codex pane with a saved session, launch awaits `has_codex_session` before clearing the old `dead` flag. `stop --yes` sees that flag and returns "has already exited" without calling `p.stop()`, so it never advances the generation that would cancel the pending launch.

**Reproduction:** delay the session check, invoke restart, invoke stop, then resolve the check. Using the actual current spawn/launch/stop methods and CLI handlers, stop returned "already exited" and the subsequent native call sequence was `has_codex_session`, then `pty_spawn`. No cancellation occurred. Native operations were mocked.

**Impact:** the controller cannot rely on a successful stop to prevent a pending process from starting. This is a remaining case of the previous lifecycle finding, despite the new generation guards fixing other startup races.

**Smallest fix:** distinguish "no running process" from "no running or pending launch". Cancel a pending launch even when `dead` is true, and ensure the stop result reflects that cancellation.

**Acceptance test:** pause a dead Codex pane's restart inside the session check, stop it, then resolve the check; there must be no `pty_spawn` call.

### A4. P1: choose can approve a different question with identical option labels

**Evidence:** `src/main.ts:3293-3300`, `src/main.ts:6487-6492`.

The CLI captures a menu before entering the input queue. The later safety comparison checks only joined option text, not the question, menu type or revision. A different question with the same Yes/No options is accepted as the original menu.

**Reproduction:** hold the input queue; call choose for option 1 while the question is "Read README?" with Yes/No choices; change it to "Delete the project?" with the same choices; release the queue. The actual choose implementation sends Enter and succeeds. The menu reader and native writes were mocked; no permission prompt was answered in a real app.

**Impact:** an agent can approve a materially different action from the one it inspected. There is also no expected-menu token to bind a separate `menu` read to a later `choose` call.

**Smallest fix:** compare the full question, options and menu type throughout selection. Expose a menu revision or content hash and accept an expected revision on choose, so a controller can bind approval to its earlier read.

**Acceptance test:** changing only the question while preserving options must reject selection with zero Enter writes; a stale expected revision must likewise fail.

### A5. P2: stdin text beginning with `--` is parsed as command options

**Evidence:** `src-tauri/src/bin/loomctl.rs:53`, `src-tauri/src/bin/loomctl.rs:89`, `src/cli.ts:27-45`.

The Rust client substitutes stdin for `-` by inserting its contents into the argument array. The frontend then parses any argument starting with `--` as an option, even when it is an opaque task payload. For example, stdin containing `--no-enter` becomes a flag rather than text; a SQL-style `-- task` header becomes an unknown option. Placing `--` before `-` does not repair stdin delivery because the Rust parser's rest branch preserves `-` literally.

**Reproduction:** the isolated Rust parser tests produced the affected argv forms; the current TypeScript parser and send handler consumed `--no-enter` as a flag and rejected the request for missing text. A multiline payload beginning `-- task` failed option validation.

**Impact:** stdin is not a reliable arbitrary-text channel for scripted tasks. The failure depends on task content, not shell escaping.

**Smallest fix:** transmit stdin/task text as an opaque field, or give an explicit stdin/text-file option an opaque payload path through both parsers. Preserve whitespace and multiline text without feeding it back through option parsing.

**Acceptance test:** send payloads starting with `--`, `--no-enter`, `--json`, and multiline SQL comments; the PTY must receive exactly those bytes as text, with no option side effects.

### A6. P2: a long pasted task can fail after delivery because its prefix scrolls offscreen

**Evidence:** `src/main.ts:3280-3286`, `src/main.ts:2952-2961`, `src/prompt.ts:61`.

The send guard searches for the first 24 non-whitespace payload characters in the visible terminal screen. If a long task fills the screen and its beginning scrolls away, the full paste has already been written, but the guard reports that the agent did not show the text and withholds Enter.

**Reproduction:** a 51-line task with a unique header was pasted into a fixture exposing the final 24 visible rows, as `liveScreen` does. The actual send implementation wrote the entire bracketed paste once, then threw the echo error. This proves the guard's failure for that screen state; it is not a live terminal/TUI rendering test.

**Impact:** the controller receives a failure after a partial side effect. Retrying the same task can duplicate the text already present in the input buffer, and a later Enter can submit the wrong combined task.

**Smallest fix:** make paste and submit outcomes explicit, and use an echo check that accounts for scrolling and output changes. Return whether bytes were written when submission fails so callers do not blindly retry. Do not treat echo as proof of task acceptance or completion.

**Acceptance test:** a payload longer than the viewport either submits once with a reliable acknowledgement or returns a typed-but-not-submitted receipt; retry/recovery never pastes a duplicate.

## Agent workflow gaps, separate from confirmed defects

These are missing guarantees needed by an unattended controller, rather than claims that the current state-only API promises task execution semantics.

| Workflow | Current behavior and implication | Minimum useful improvement |
| --- | --- | --- |
| Discover the intended instance | Per-process `LOOM_PIPE` and separate debug/release prefixes fix the earlier routing collision inside panes. An external agent still needs an endpoint/profile and cannot verify its server identity from a handshake. A shared profile alias does not uniquely identify multiple instances. | Read-only `info` with instance identity, protocol version, profile/workspace and capabilities; a way to discover endpoints. Require explicit IDs for automation. |
| Keep target identity | Pane/thread IDs are stable during the app lifetime, as now documented. They do not identify a process generation, survive app restart, or safely bind a prior observation to a later send. | Include instance and process-generation identifiers in status and optional mutation preconditions. Refresh IDs after reconnect/restart. |
| Establish task completion | `cliState` reports starting/waiting/busy/idle/dead. Claude's activity heuristic clears busy after about 1.5 seconds of quiet (`src/main.ts:1947-1968`). `wait --state idle` is level-triggered (`6503`) and can immediately observe a pre-existing idle state. Waiting also represents attention/turn completion, not a durable task result. | Expose command/turn sequence, completion marker, timestamps and outcome. For shells, retain the exit status already emitted by OSC command-end markers. Let a wait bind to a sequence after a particular send. |
| Capture outcomes and freshness | `paneData` (`6149`) has no command exit code, output revision, last-output timestamp or observed-task token. `Pane.mark` (`2216`) handles `D;7` as an end marker without retaining 7. The isolated test confirmed quiet becomes idle and the failed-command code is absent from pane JSON. Recent output helps inspection but cannot establish freshness or task success alone. | Add existing shell-command sequence/exit data and output timestamps/revisions. Distinguish unknown/stale from observed completion; do not label quiet as successful work. |
| Retry after timeout/disconnect | A timeout explicitly does not cancel the operation. The transport's internal request ID (`control.rs:119-141`) is not a caller-supplied retry key or durable result receipt. An uncertain send/new may already have applied. | Caller request IDs, bounded per-instance deduplication/result lookup, and an explicit partial/unknown outcome. Until then, never automatically retry a mutation after an ambiguous response. |
| Create a terminal in a chosen directory | `new` resolves to the Git top level (`main.ts:6407`) and reuses an existing thread (`5100`), so it does not always create the requested fresh shell or start in a nested cwd. The practical existing-thread path is `add` with an explicitly empty startup command, followed by an explicitly quoted shell directory change if needed. Pane `dir` is thread context, not a verified current shell cwd. | Document this recipe and expose actual process/shell identity and cwd where known. An explicit cwd for a newly added shell would remove a separate send. |
| Recover without GUI | `restart` can require choosing a missing session in Loom (`main.ts:6537`). There is no corresponding CLI selection path. Creating a new pane is available, but is not resuming the chosen session. | CLI session list/select if headless recovery is a supported goal; otherwise expose this limitation as a capability and a structured error. |
| Parse capabilities and errors | Successful `--json` now always emits JSON, including null. Errors still use human stderr and exit codes (`loomctl.rs:185-188`), not a JSON error envelope. Help is useful but does not establish a versioned schema/capability contract. | A small versioned info/error schema with stable error codes and applied/retryable state. Do not infer recovery behavior from error wording. |

For the completion gap, a controller can temporarily use unique explicit shell completion markers carrying an exit code, then read and correlate only output after that submission. This is a workaround for known shells, not a general proof of agent turn completion. Successful `send`, idle, and waiting should not be reported as successful task execution.

## Security and permissions assessment

The pipe uses a local-only setting and an owner/SYSTEM ACL (`src-tauri/src/control.rs:55`, `:80`), with a bounded request size (`:98`). Source inspection did not establish an ACL bypass. I did not perform a runtime ACL or installer test. The boundary is the Windows user, not an individual automation agent: a caller with access can address panes throughout the instance. `--yes` is an acknowledgement flag, not authentication or a scoped permission grant.

Terminal output is unredacted and may contain credentials or instructions from untrusted programs. A consuming agent should treat it as task data, read only what it needs and avoid copying secrets into logs/reports. No real pane output or credentials were read during this review. A4 is the concrete permission-selection defect, rather than a hypothetical transport exploit.

## Status of the earlier report

| Earlier finding | Current result |
| --- | --- |
| Boolean options consume adjacent operands | Fixed by typed command-option parsing; helper tests pass. |
| Debug/default instance routing collision | Fixed in the reviewed pipe naming and per-instance environment wiring; isolated Rust tests pass. Runtime multi-instance routing was not exercised. |
| Duplicate close removes another thread | Fixed; concurrent mocked closes preserve the unrelated thread and reject the duplicate. |
| Input sequences interleave | Fixed for concurrent sequences on one unchanged process; current test observes first, Enter, second, Enter. A2 is the remaining lifecycle boundary. |
| Stop during startup | Partly fixed by generation guards; A3 remains for a dead Codex pane restarting during session lookup. |
| Concurrent new returns another thread | Fixed; the current handler returns the exact creation result in the concurrency fixture. |
| Destructive/start errors reported as success | Fixed in the reviewed result propagation. A deletion failure now reaches the CLI; restart checks the spawn result. Full UI failure tests were not run. |
| Relative directory resolved in the wrong process | Ordinary relative paths now resolve against the CLI caller cwd; helper coverage passes. |
| Null JSON result produces empty output | Fixed; the Rust rendering test verifies `null`. |
| Fractional pane count accepted | Fixed; helper validation and an actual createThread fixture reject it before Git is called. |

## Validation and limitations

Passed on the fresh snapshot/current checkout:

- 47 current `src/cli.test.ts` helper checks.
- TypeScript `tsc --noEmit --incremental false` (exit 0; no emitted source/build files).
- `git diff --check bfeb731..HEAD` (exit 0).
- Nine offline tests in an isolated minimal Rust crate containing the copied current CLI/pipe code: seven existing tests plus two diagnostic stdin/parser tests. No connection to Loom was made.
- Thirteen isolated workflow scenarios using current implementation extracted through the TypeScript AST: seven defect reproductions (including both compatibility directions), one state/outcome gap, and five previous-fix checks. Final run passed all assertions. Passing reproductions mean the defect was observed, not that the behavior is correct.

The scenario harness uses controlled panes, session lookups, timers, menus and native invocations. It checks implementation behavior without sending to a real terminal. The long-paste result specifically assumes a valid scrolled-screen state rather than testing a particular agent TUI renderer. A fixture-only missing label was corrected before the final successful run.

Not run: live `scripts/cli-check.mjs`, live `scripts/ui-check.mjs`, a full Tauri build, runtime pipe ACL tests, installer/update execution, or any end-to-end command against an existing pane. Those would start applications or alter live state and were outside this review's authorization. Existing checked-in live tests were inspected but their results are not claimed here.

Local supporting evidence is preserved at `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-agent-review-20260930T2103`: the 77-file hash manifest, fresh commit diff, source snapshot, `checks/agent-checks.mjs`, `checks/agent-checks.log`, helper log and isolated Rust test crate. The earlier general report's SHA-256 remains `031F4A434551036F23DEB579E923D3C8ED53946F8EE1AA7FBB2DBE62394D93E9`.

The smallest release gate for unattended use is to fix A1-A4, make payload/partial-send handling deterministic, and provide enough identity, receipt and outcome data that a controller can prove which session received a task and whether that task finished. Until then, supervised operation with explicit IDs and manual reconciliation after uncertain sends is the supported confidence level of this review.
