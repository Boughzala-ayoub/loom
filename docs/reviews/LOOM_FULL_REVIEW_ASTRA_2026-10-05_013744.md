# Loom full review

Reviewed `main` at `b60f9572b1846e548c924bd746a7c9c4950f055f` on 2026-10-05. This is a whole-app review, not a review of the last commit.

## Overall verdict

Loom has substantial safeguards around input correlation, journal replay, and CLI retries, but still has release-blocking reliability and data-loss risks. The highest priorities are removing synchronous ConPTY work from the main thread, enforcing one writer per workspace, preserving unreadable state, and strengthening destructive-worktree checks. Several asynchronous paths also escape the generation checks used elsewhere.

Windows Application event 1002 confirms that **loom.exe 3.0.0.0 hung at 2026-10-05 00:55:50 and Windows closed it**. The event provides no blocked-thread stack. Findings F1, F5, and F6 identify credible sources of unresponsiveness or accumulated work; none is established as the cause of that incident. The reported 13-second loomctl latency was not reproduced against the running application.

The installed version string does not establish which commit the hung process loaded. This report reviews the checkout above, not a verified copy of that process's loaded bundle.

## Findings, ranked by impact

P1 means possible data loss or whole-app failure that should block a reliability release. P2 means a material defect with a narrower trigger. Source analysis, in-memory reproductions, and untested native behavior are distinguished below.

### F1 — P1: ConPTY resize can block the native main thread while holding the global PTY lock

**Location:** `src-tauri/src/lib.rs:472–483`; output flow control in `src-tauri/src/output.rs`.

`pty_resize` is a synchronous Tauri command. It locks the entire PTY map and calls `master.resize()` before releasing that lock. The Windows operation beneath this is synchronous; Microsoft's implementation sends the resize packet with `WriteFile`. A stalled console can therefore block the command handler and prevent unrelated panes from looking up their sessions. Output acknowledgements also need the main-thread command path. Backpressure makes this a particularly poor place to wait for the console to make progress.

**Failing scenario:** resize a window containing a stalled or output-saturated pane. A blocked resize freezes window processing and delays input, stop requests, and CLI operations that depend on the page. This is a source-confirmed blocking path, not a reproduced deadlock or attribution of the 00:55 incident.

**Fix:** run resize off the main thread, take a session-specific handle under the map lock, and release the map lock before native work. Coalesce pending sizes per session so dragging cannot create an unbounded resize queue. Keep output draining independently. [Microsoft ConPTY implementation](https://github.com/microsoft/terminal/blob/main/src/winconpty/winconpty.cpp) and [ConPTY lifecycle guidance](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session).

### F2 — P1: Two instances of one profile can overwrite each other's task journal

**Location:** `src-tauri/src/lib.rs:1464–1469`, `src-tauri/src/lib.rs:861–892`.

Profile launches deliberately bypass the single-instance plugin. Both processes consequently use the same state and journal paths, but each has its own task map, sequence counter, idempotency keys, and write queue. Compaction rewrites the complete journal from one process's snapshot, using the same `.pending` name. The pipe's first-instance check only decides which process gets the public pipe; it does not prevent the other process from writing storage.

**Failing scenario:** open the same named profile twice, submit different tasks in each, then let either compact or reload its journal. One snapshot removes the other's tasks and reserved keys; sequence numbers can collide. Retrying a lost key can execute work again. This is more serious than the existing comment's “last save wins” workspace limitation.

**Fix:** acquire a process-lifetime lock for the resolved workspace storage path before opening it. A second launch should activate the owner or refuse writable access. Use the same identity for storage ownership and pipe routing; account for junction aliases. Merely locking individual appends cannot reconcile two independent task histories.

### F3 — P1: A read or parse failure silently becomes an empty workspace, which startup then saves

**Location:** `src-tauri/src/lib.rs:1276–1285`; `src/main.ts:8631–8635`, `src/main.ts:9057–9062`.

Native `load_state` converts every read error into an empty string. The page also catches JSON parsing failures without preserving an error state. Startup continues with defaults and eventually saves them over the original workspace.

**Failing scenario:** a temporarily inaccessible profile, malformed hand edit, or interrupted external write causes the next launch to show an empty workspace. Once saving succeeds, the original pane/session configuration is replaced. There is no recovery copy on this path. Atomic writes do not help when the input to the write is the accidental empty state.

**Fix:** return a distinguishable missing-file result and propagate other read errors. On invalid JSON, retain the original file and disable automatic saving until recovery is chosen. Reuse the journal's existing unreadable-storage behavior instead of inventing another recovery mechanism.

### F4 — P1: Worktree deletion approvals do not detect changes to already-listed files

**Location:** `src/gitparse.ts:34`; `src/main.ts:5122–5154`, `src/main.ts:5194–5224`, `src/main.ts:7568–7572`.

The deletion inventory contains HEAD, path lists, and a commit count. It contains no file contents, index identity, or file metadata. `lossInventory` even drops the status columns. Both the CLI revision and the pre/post-stop comparisons therefore remain unchanged when an already-dirty file receives more work.

**Failing scenario:** approve a plan listing dirty `important.txt`; an agent then changes that file again without creating another path or commit. The revision still matches and `git worktree remove --force` deletes the new work. An ignored directory represented as one entry can hide additional changes too. A small read-only check confirmed that ` M important.txt` and `MM important.txt` produce identical inventories.

**Fix:** bind approval to the data that would actually be lost: tracked/index changes and the contents of untracked/ignored entries, with bounded traversal that fails closed when it cannot finish. Recheck after stopping writers. Preserve a recovery copy when other processes may still write; an inventory comparison alone cannot make concurrent deletion atomic.

### F5 — P1: Large diffs are fully transferred and parsed before the display limit applies

**Location:** `src-tauri/src/lib.rs:520–541`; `src/gitparse.ts:114`; `src/main.ts:5463–5489`.

Git output is collected without a byte limit. `showTab` then calls `diffRows(text)` on the page thread before applying its 50,000-row limit. The parser splits and allocates rows for the complete diff. DOM virtualization limits mounted elements, but does not bound this work or the native/IPC/string copies preceding it.

**Failing scenario:** open the diff of a large generated file or repository-wide change on a memory-constrained PC. The page cannot process input, output acknowledgements, or loomctl requests while parsing, and memory pressure compounds the stall. A 60,000-line synthetic diff produced more than 60,000 parsed rows despite the downstream 50,000-row display cap; no large stress run was performed.

**Fix:** bound Git output before IPC and stop parsing at a byte/row budget. Show a truncated preview with an external-editor option. Reuse the existing bounded file-preview approach; a worker is optional after the total work is bounded.

### F6 — P2: Usage timeouts release the polling guard while native work continues

**Location:** `src/main.ts:7410–7435`; `src-tauri/src/usage.rs:459–467`.

The two-second `Promise.race` limits how long a caller waits, but does not cancel `codex_session_usage`. The timeout completes the promise stored in `providerPolls`, and its `finally` removes the guard. Another status request or poll then starts another native operation. The native reader holds a shared cache mutex while accessing files.

**Failing scenario:** antivirus, a slow profile directory, or a stalled file read holds one scan. Repeated CLI reads and background polls accumulate native jobs waiting behind it. The advertised frontend timeout does not bound resource use or the backlog. An in-memory check of the production function performed eight timed-out polls and observed eight unresolved native invocations.

**Fix:** retain the in-flight entry until the actual native promise settles. Race only each caller's wait against its deadline. Return cached data with its age while one scan is running. Add a backend scan budget if the reader itself must be interruptible.

### F7 — P2: A completed stop or queued exit can mark a replacement launch dead

**Location:** `src/main.ts:1831`, `src/main.ts:1841–1858`; `src-tauri/src/lib.rs:418–429`.

`Pane.stop()` increments the generation, awaits `pty_kill`, then calls `exited()` unconditionally. Launches are serialized with other launches, not with that final stop callback. The exit event also contains only an exit code and is addressed by reusable pane ID. The backend checks the current PID before emitting, but that cannot invalidate an event already queued for the page.

**Failing scenario:** stop a pane, start it again while termination is still pending, then let the old stop return. The replacement is marked dead and its task/receipt state becomes inconsistent with the live process. An in-memory check reproduced exactly that state transition. A delayed native exit event has the same missing identity guard.

**Fix:** capture and check the stop generation after the await. Carry a launch token through native spawn, exit, kill, and write operations so stale operations cannot target the current session solely by pane ID. Reuse the existing generation model rather than adding another lifecycle counter.

### F8 — P2: Normal window close does not drain the task journal

**Location:** `src/main.ts:3790–3830`, `src/main.ts:8681–8690`.

The close handler awaits session polling and workspace saving, shuts down PTYs, and destroys the window. It never awaits `journalQueue`. New task/notification activity can also continue during those awaits. Workspace persistence and task-journal persistence are separate queues.

**Failing scenario:** a task settles or notification policy changes just before close while an earlier journal write is slow. Later journal operations still exist only as page promise continuations when the page is destroyed. On restart, the final event or policy history is missing even though the user closed normally. Native `sync_all` protects operations that reached Rust, not JavaScript work that never started.

**Fix:** establish a closing state that stops accepting new work, collect the final exit/task events, and drain the journal before destroying the page. A write failure must keep the window open or explicitly preserve recoverable pending data. Follow the existing failed-workspace-save close behavior.

### F9 — P2: Dictation can paste and submit into a restarted pane

**Location:** `src/main.ts:1370–1424`.

The recording captures a `Pane` reference but no launch generation or input sequence. `micStop` clears `recording` before awaiting transcription, so disposal cannot cancel this already-pending result through the recording state. It later pastes, optionally waits and sends Enter, and focuses the pane without checking whether the target changed. The empty-transcript path blindly backspaces the prefix length even if newer typing replaced it.

**Failing scenario:** stop dictation, restart that pane while transcription runs, and receive the old transcript in the new agent or shell; an auto-enter prefix submits it. An in-memory check changed the generation during transcription and observed the paste. Typing while dictating can also lose unrelated input on the empty-result path.

**Fix:** capture generation and input sequence before starting/awaiting transcription, then validate before every paste, Enter, rollback, and focus operation. Reuse the guarded composer/send logic. If the target changed, offer the transcript as text instead of sending it.

### F10 — P2: loomctl authenticates the protocol version, not the pipe server

**Location:** `src-tauri/src/pipe.rs`; `src-tauri/src/control.rs:36–56`; `src-tauri/src/bin/loomctl.rs:141`, `src-tauri/src/bin/loomctl.rs:210`.

Loom's genuine pipe has a restrictive ACL, but its predictable name can be created before Loom starts. `first_pipe_instance` makes Loom refuse the occupied name; the CLI subsequently opens that name and trusts a compatible JSON hello. The hello's PID and version are assertions from the server, not verified identity.

**Failing scenario:** another local account pre-creates the victim's predictable pipe name with a permissive ACL. Loom cannot establish its public endpoint, while loomctl can send prompt text or stdin to the impostor and accept fabricated replies. This does not grant access to an already-running genuine pipe and was not tested by creating hostile endpoints on this PC.

**Fix:** obtain the server process identity through the connected pipe handle and verify its Windows SID before sending command payloads. Treat self-reported hello fields as diagnostics. SID-derived names reduce collisions but do not authenticate an endpoint. Report a failed public listener prominently. Windows provides [GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid); [pipe security documentation](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) describes ACL and ownership checks.

### F11 — P2: Updating loomctl and Loom is not one recoverable operation

**Location:** `scripts/update.ps1:28–61`; `src-tauri/nsis-hooks.nsi:35–39`.

The update script overwrites installed `loomctl.exe` before validating and staging `loom.exe`. Only the latter gets atomic replacement, checksum verification, and rollback. A long-running `loomctl wait` or watch can also keep the CLI image mapped, contradicting the comment that nothing keeps it open for long. The installer similarly overwrites the CLI directly.

**Failing scenario:** the new CLI copies successfully, then Loom's source validation or replacement fails. The script leaves the old app paired with the new CLI. Across a protocol change, normal control stops working. Conversely, a mapped CLI can abort the update before the app replacement.

**Fix:** validate and stage both executables before changing either, keep recovery copies for both, and restore the pair on failure. Reuse the existing rename/replace strategy for the CLI. Explicitly handle active long-running clients rather than assuming a short executable lifetime.

### F12 — P2: Long task histories can make every journal write throw before reaching disk

**Location:** `src/main.ts:3805–3823`, `src/main.ts:3920`; `src/task.ts:540`.

Every append builds a flattened array of all retained event sequence numbers and spreads it into `Math.min`, even when no whole-journal rewrite is needed. Task retention limits task count, not events in a task. At the JavaScript argument limit this throws before `invoke`, outside the rejection handler that marks the journal dirty and tasks unsaved. Smaller histories still impose repeated full-history allocation and scanning; event reads also flatten and sort history.

**Failing scenario:** a long-lived task accumulates many report/status events. Further writes fail in the page, and the normal storage-failure bookkeeping is bypassed. An in-memory production-function check with 130,000 events raised `RangeError: Maximum call stack size exceeded` before any native invocation. The precise threshold is engine-dependent.

**Fix:** compute the minimum with an iteration, and only when needed for compaction. Put serialization/preparation failures inside the same failure-accounting path as native write failures. Bound retained event history or retain a compact state plus a defined event window, preserving the existing watcher gap contract.

### F13 — P2: A valid-JSON but malformed journal record aborts startup outside recovery handling

**Location:** `src/task.ts:410–432`; `src/main.ts:4402–4412`, `src/main.ts:9057–9061`.

Replay catches JSON syntax errors but trusts the shape of a parsed task. Iterating `t.events` throws if that property is absent or not iterable. `loadTasks` handles native read failure, but the parser call is outside that handler. Startup awaits it before installing CLI handling and leaving the restoring state.

**Failing scenario:** a damaged, manually edited, or incompatible journal contains `{"task":{"id":"broken"}}`. The parser throws `t.events is not iterable` (confirmed by a direct read-only check); the window can be partly restored while CLI readiness and normal save initialization never finish. This is distinct from the already-fixed automatic-task journal encoding defect.

**Fix:** validate record shape and field types before replay. Fail into the existing unreadable-journal mode while preserving the original file; do not quietly discard malformed reservations and thereby forget idempotency keys. Catch replay errors at the startup boundary too.

### F14 — P2: Session and wake markers are identified by pane ID, not launch

**Location:** `src-tauri/src/lib.rs:273–279`, `src-tauri/src/lib.rs:902–914`, `src-tauri/src/lib.rs:1178–1199`; `src/main.ts:8939`, `src/main.ts:8960–8967`.

Session marker filenames and completion wakes reuse the pane ID across launches. Session polling applies a returned ID to the current pane without validating which launch produced it. Output channels have launch separation, but these side channels do not.

**Failing scenario:** restart a Codex/OpenCode pane before a queued session poll returns, or let an old hook complete during replacement. The old session marker becomes the replacement's saved resume target, or an old completion wake affects the new launch. The next restore can resume the wrong conversation. No timing-sensitive native reproduction was attempted.

**Fix:** include the existing launch token in marker payloads and events, and validate it on both consumption and page application. Polling should retain the generation snapshot it requested. Clearing a marker file on restart alone cannot reject a late old writer.

### F15 — P2: Junction-following walks can perform effectively unbounded work

**Location:** `src-tauri/src/lib.rs:626–642`, `src-tauri/src/lib.rs:1002`; bounded traversal precedent in `src-tauri/src/usage.rs:473`.

The non-Git file walk follows directories, including junction targets, without a visited-directory set or depth limit. Its 20,000-file cap does not bound traversal of empty directories. `codex_rollouts` also recursively follows directory targets without a comparable budget.

**Failing scenario:** open a non-Git folder with a junction back to an ancestor, or place a junction-heavy session archive below the Codex session directory. Enumeration repeats subtrees until path/OS limits intervene, wasting workers and memory; recursive traversal also risks stack exhaustion. A worker thread prevents direct page blocking but does not make the operation bounded or keep CLI callers from waiting.

**Fix:** skip reparse directories where following them is unnecessary. Otherwise track canonical visited directories and enforce depth, entry, and elapsed-time budgets. Reuse the bounded Codex usage walk. This is a traversal finding, not a claim that Rust's `remove_dir_all` follows junctions during deletion.

### F16 — P2: Detached descendants are not owned through pane exit or an app crash

**Location:** `src-tauri/src/lib.rs:34–74`, `src-tauri/src/lib.rs:415–433`, `src-tauri/src/lib.rs:499`.

Explicit stop uses `taskkill /T /F` against the root PID and ignores its result. There is no per-launch Job Object. Natural root exit and forced termination of Loom do not run that explicit tree-cleanup path. Closing a pseudoconsole terminates attached console applications, but it does not establish ownership of detached descendants with independent consoles.

**Failing scenario:** an agent starts a detached development server or helper, then its root exits or Windows kills hung Loom. The detached child keeps using RAM, ports, and worktree files; restarting the pane can start another copy. No processes were created or killed to test this on the user's machine.

**Fix:** use a per-launch Windows Job Object with kill-on-close, assigning the root before it can spawn outside the job. Make intentional detachment explicit if it is a supported feature. Report failures of explicit cleanup. [Windows Job Object behavior](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [ConPTY shutdown behavior](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session).

### F17 — P2: Pipe connections have a size limit but no admission or framing deadline

**Location:** `src-tauri/src/control.rs:36–49`, `src-tauri/src/control.rs:100–130`, `src-tauri/src/control.rs:179`.

Each connection spawns an independent task. The 1 MiB read limit bounds bytes per connection, but neither hello nor command-line reads have a deadline. Response writes can also wait indefinitely. Long requests remain pending without promptly observing a disconnected caller.

**Failing scenario:** a same-account script repeatedly opens pipes and never terminates its hello line, or clients abandon long watches. Handles, buffers, tasks, and pending page work accumulate on an already memory-constrained app. This is primarily robustness against buggy clients; same-account processes already have broad authority.

**Fix:** add short hello/request framing deadlines, a write deadline, and a fixed active-connection budget. Observe disconnects for cancellable read/watch requests. Preserve the distinction between cancelling a wait and undoing a mutation that may already have run.

### F18 — P2: Receipts and dashboard caches retain closed panes and their data

**Location:** `src/main.ts:3075–3084`, `src/main.ts:3654–3680`, `src/main.ts:2320`.

Receipts hold a strong `Pane` reference, including its Terminal and Thread. Keeping up to 500 settled receipts therefore also retains the corresponding object graphs after close. Terminal disposal releases resources/listeners but does not remove all references to its core buffers from the still-reachable terminal object. Dashboard message and draft maps likewise have no general eviction on pane close.

**Failing scenario:** repeatedly create output-heavy panes, obtain receipts, and close them in one long-running Loom session. Closing panes does not make those retained graphs collectable; dashboard text can grow with every unique pane. No heap/RSS benchmark was run, so the retained byte count is not asserted.

**Fix:** snapshot receipt identity/result fields and release the live pane reference once settled or closed. Remove dashboard cache entries on close and reject late refresh results for disposed panes. Preserve receipt lookup semantics without retaining a terminal to answer them.

### F19 — P2: Installer PATH commands treat the installation directory as PowerShell source

**Location:** `src-tauri/nsis-hooks.nsi:40`, `src-tauri/nsis-hooks.nsi:46`.

`$INSTDIR` is interpolated inside single-quoted PowerShell literals. A valid Windows directory containing an apostrophe breaks those literals. The hooks also do not consume/check the `nsExec` exit status, so PATH registration failure is silent. More contrived directory strings can change the script's meaning; this is not an elevation finding in the normal per-user installation.

**Failing scenario:** install under a user-selected path such as `C:\Tools\Ayoub's Loom`. Installation succeeds but PATH registration or removal fails, and `loomctl` may resolve to an older copy or not resolve at all.

**Fix:** pass the directory as data through an environment variable or correctly encoded script parameter, or update HKCU directly with the installer. Check the helper result and show a recoverable PATH-registration error. Also check move/copy errors in `LoomMoveAside` before relying on its fallback executable. A real NSIS installation was not run.

## Security boundary and other reviewed behavior

The genuine named pipe explicitly grants access to the current Windows account and SYSTEM and rejects remote clients (`control.rs:55–96`). It does not intentionally expose control to every local account. F10 concerns authenticating a pre-existing endpoint from the client side, not bypassing the genuine pipe's DACL.

Within that account, loomctl is a full-control API: a caller can inspect pane output, start commands, type into other panes, answer interactive prompts, stop work, change notification policy, and request destructive worktree operations. CLI confirmation flags and plan revisions protect against mistakes; they are not an authorization boundary between agents. An unsandboxed agent running as the same Windows user can control sibling panes. Nothing in this review assumes that an ordinary browser page can directly open the named pipe. If agent-to-agent isolation is required, it needs an explicit capability boundary; the current account-wide contract does not provide it.

The protocol already rejects incomplete request frames and mismatched protocol versions. The receipt path distinguishes input acceptance from completion, correlates results with a pane/generation, and limits retained settled receipts. The task path reserves keys durably before normal submission and accounts for pending persistence. These are useful guarantees; F2, F7, F8, F12, and F13 identify boundaries where they can break.

Held Enter deliberately delays relevant task signals until the actual PTY write settles. Current regression checks cover the recent ordering, startup ownership, closed-pane policy, and pending-save corrections. I did not re-file those fixed findings. A stuck native input write can still keep a hold alive; forcing it to “succeed” on a page timeout would make correlation less reliable. The fix belongs in session/input cancellation and lifecycle ownership. Dictation currently bypasses protections that the ordinary send path already has (F9).

Many expensive operations already use blocking workers: Git, PTY creation/termination, transcription, and session reads are not all running directly on the native main thread. Remaining synchronous filesystem probes, including `canonical_directory` and `load_state`, are also candidates for main-thread stalls on inaccessible network paths. Git subprocess collection has no general deadline; slow Git operations can delay dependent CLI commands even when the window remains responsive. Do not interpret a long CLI request as proof that the window thread hung.

Memory controls exist: terminal scrollback limits, a 12-context WebGL budget, bounded output flow, and a bounded native output queue. They reduce growth per pane, but every pane still carries a terminal, native reader/writer/emitter/waiter threads, and its agent process. Codex/OpenCode restore is less throttled than Claude restore. A many-pane restore can therefore create a large burst even without a leak. The confirmed avoidable retention is F18; native-work accumulation is F6. No total-memory estimate is justified without a measured workload.

Worktree removal uses Git and includes valuable checks before and after stopping panes. Cache cleanup contains reparse-point/containment defenses. The deletion finding is the incomplete inventory in F4, not a blanket claim that all Windows path handling or junction deletion is unsafe. Updater staging/checksums and atomic replacement of `loom.exe` are likewise useful; the remaining failure is extending that safety to the executable pair.

## Structural improvements worth doing

1. **Make one native session own one launch.** Use the existing generation/token across commands and side channels, per-session synchronization, and explicit process ownership. Remove blocking operations from the global PTY map lock. This addresses F1, F7, F9, F14, and F16 without adding a generic lifecycle framework.
2. **Give workspace and journal persistence a single owner and one close protocol.** Enforce the process lock, centralize unreadable-state handling, and expose a drain operation that includes task/policy writes. Keep the existing pure task reducer; separate storage scheduling from page rendering. This addresses F2, F3, F8, F12, and F13.
3. **Extract the duplicated input paths from `src/main.ts`.** Ordinary send, dashboard reply, dictation, configuration typing, and CLI input should use the same generation/input-sequence checks and Enter-hold release rules. Extract that concrete controller before attempting to split all 9,100 lines by arbitrary size.
4. **Bound work before returning it to the page.** Reuse bounded readers/walkers, retain native in-flight promises, cap diff transfer/parsing, and return cached status with an age. Apply a small shared concurrency limit to restore and background scans. Adding more workers alone would worsen the current low-memory failure mode.
5. **Measure the two halves of a slow CLI request.** Record monotonic durations for pipe connect/hello, page dispatch, handler awaits, native operations, and reply. Add native/page heartbeat timestamps and capture a hang dump when Windows reports another stall. This separates pipe contention, a blocked native main thread, a busy page, and slow Git/session reads; it is the shortest path to explaining the observed 13 seconds.
6. **Update the executable pair with one recovery procedure.** Reuse the current staging/replacement implementation for both binaries; add a failure-path check for a mapped CLI and for failure after the first replacement. Avoid a second installer-specific update algorithm where practical.

## Review evidence and limits

Read README.md, docs/loomctl.md, and docs/turn-tracking-and-notifications.md before implementation review. Used the existing `docs/reviews` reports and their fix dispositions, including the latest round-two R1–R7 findings, to avoid treating repaired behavior as new findings. Reviewed frontend lifecycle, input, task/receipt/policy and CLI paths; Rust PTY/output/control/pipe/session/usage/helper/cache paths; and installer/update behavior.

The concurrent [round-three review](LOOMCTL_GAPS_ROUND3_SOL61_XHIGH_REVIEW_2026-10-05_013558.md) appeared during final verification. Its N3 independently covers F6, including the additional consequence that late successful readings are discarded. Keep one fix for that shared defect. Its other open credential-filter and reader-state findings remain relevant; this report does not supersede them or claim they are fixed. Those checks were not counted as this review's executions.

Sequential read-only checks passed: `node src/task.test.ts`, `node src/main_cli.test.ts`, `node src/prompt.test.ts`, `node src/main_context.test.ts`, `node src/agent.test.ts`, and `node src/task_event_gate.test.ts`. The CLI checks include the latest secret-export, composer glyph, setting-retention, minimized usage, cooldown, survey, and pending-save regressions.

Additional small Node checks ran in memory, extracting/transpiling the relevant production functions where necessary. They confirmed F6's outstanding native calls, F7's late-stop state change, F9's cross-generation paste, F12's argument-limit failure, F13's malformed-record exception, F4's unchanged inventory, and F5's parsing beyond the display cap. These were mocked/unit-level checks, not native end-to-end tests. Windows event-log reading confirmed the Application Hang time stated above.

No build, package, installer, live mutation, stress test, process termination, live pipe attack, or memory-heavy browser session was run. Source and existing review files were not changed, staged, or committed. The only intended write from this review is this report. Existing untracked files belonging to other work were left alone. Native concurrency findings still need focused Windows tests and a hang dump; passing the pure-function suites does not establish native lifecycle safety.
