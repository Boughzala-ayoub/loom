# Loomctl gaps and fixes review

Reviewed `0039487..bb37e97` on main, 18 commits, at `bb37e9796a0d43c3d3d797a50203c3f3b0ea773d`. Review date: 2026-10-04, Africa/Tunis. File locations refer to this HEAD. Today's earlier review reports supplied the task, persistence, startup, notification-policy and bridge context.

There are nine findings below: two P1 and seven P2. The three notification-context fixes close their reported failures. The command work closes several original gaps, but Codex session data is still missing, manual settlement has persistence and receipt-wait problems, and the new folder path can launch a process in the wrong directory. Usage exposes an inherited credential-error leak and bypasses fetch coalescing. The reset-time format and survey parsing also need fixes.

The installed read-only probe confirmed null model, effort and context in both Codex pane records, while Claude records contained values. It returned a non-null zoomed pane ID on the current thread, with exactly that pane's `zoomed: true`. The other threads were unzoomed and returned null. The earlier zoom observation was not reproduced.

**Disposition of the notification-context findings.**

Reference: [LOOM_NOTIFICATION_CONTEXT_SOL61_XHIGH_REVIEW_2026-10-04_182919.md](LOOM_NOTIFICATION_CONTEXT_SOL61_XHIGH_REVIEW_2026-10-04_182919.md).

| Finding and fix | Does it close the failing scenario? |
| --- | --- |
| F1, `c67a77b` | Yes. `src/task.ts:103` applies the existing private-value filter to thread IDs. Replay of the reported Windows path retains sequence 3 and the safe context, exports a null ID and adds only `invalid-context`. POSIX paths and recognized secret forms also pass the regression checks. This remains a heuristic privacy filter, not validation against the exact runtime ID grammar. |
| F2, `813ca12` | Yes. `src/main.ts:3740` includes deferred readable tasks in pre-close capture. The weak map at `:3727` keeps the close copy separately, and `:3872` prevents replayed earlier events from replacing it. The reported close-before-replay case yields accepted/submitted at At Enter, pane 2, and the held completion at At Close, pane 1, last-known. The no-held-completion control also keeps the correct close copy. Journal round trips preserve it. |
| F3, `b912774` | Yes. Held entries retain the captured context at `src/main.ts:4220`, and release forwards it at `:3928`. A's report captured at At Report survives B's later Enter hold and pane closure. Held and control cases both complete A with At Report, pane 2, event origin, including after journal replay. |

The previously disclosed display-only rename/reorder refresh remains unfinished at `docs/turn-tracking-and-notifications.md:566`. These commits do not complete that separate plan item.

**Disposition of the loomctl items.**

Reference: [LOOMCTL_OPEN_ISSUES_2026-10-04.md](LOOMCTL_OPEN_ISSUES_2026-10-04.md).

| Item | Result at bb37e97 |
| --- | --- |
| 1. Bound window show | Implemented at `src/main.ts:7747` and `:8413`. Each native step has a two-second race. Tests with each of unminimize, show and focus stuck leave another handler runnable and return a timeout. The original Windows/native stall was not reproduced; frontend timers cannot establish that the native UI thread itself stays responsive. |
| 2. Current task references | Closed for the reported renumbering scenario. `src/main.ts:3818` resolves the current pane identity; closing preceding panes changes the displayed reference. Closing the owner returns null with paneClosed true. Stored task refs and historical events remain unchanged. The pane filter also stops selecting another task solely through an obsolete positional ref. |
| 3. Claude completion after extra prompts and survey | Closed in the production routing/sweep scenario. `323a73c` adds a regression, rather than changing production routing. The original task and two tracked sends complete after Stop and survey dismissal; three unmatched background prompt reports neither overwrite correlation nor create tasks. The completion retains the Stop response. No live Claude turn was sent during this review. |
| 4. New outside Git | The original refusal is removed. Git is required when name/base requests a worktree. N1 covers invalid targets and folder identity, which the command now needs to check independently of Git. |
| 5. Survey in menu/choose | Works for the exact unwrapped survey and sends the chosen digit without Enter. Generation and revision checks remain. N8 and N9 cover transcript false positives and wrapped surveys. |
| 6. Usage and banked resets | Command added, including explicit requests with polling disabled and the native Codex banked-reset fields. N2, N6 and N7 cover credential errors, concurrency/rate limits and reset formatting. |
| 7. Model, effort and context | Partial. Claude session data is exported. Codex remains null even when model/effort were selected at startup; OpenCode also has no session-data producer for these fields. N5. |
| 8. Add/new model and effort | Command construction works for the tested Claude/Codex selections. Both commands accept the flags; shell syntax, empty/unsafe model IDs, shell startups with selections, effort on OpenCode and combinations with cmd are rejected. Actual provider/model support is delegated to the agent and was not exercised. Selecting a model does not repair item 7. |
| 9. Ctrl-U | Closed as documentation/test coverage of an already supported key. It emits byte 0x15 without Enter. The documentation correctly limits its behavior to the agent's line editor. |
| 10. End a stuck task | Basic transition, journal event, final-state refusal and notification contracts work. N3 and N4 prevent a complete durability/receipt-wait pass. |
| 11. Task wait with idle fallback | Meets its documented weak fallback. Same pane ID and generation are required. Closed, restarted, starting, exited and working panes do not satisfy it. An already waiting pane returns immediately with pane-idle; approval takes task precedence. The fallback creates no event and changes no task state. |
| 14. Zoom records | Implemented and verified in the installed response as well as command tests. `src/main.ts:7378` reports the actual explicit zoom target. Null means no explicit zoom on that thread; focus, a single-pane thread and window maximization do not imply zoom. `revealPane` at `:2911` moves an existing zoom to another shown pane. |

Items 12 and 13, push delivery to a local consumer and storing whole replies, remain open and are not implemented by this range. No new reply-text retention or command-running notification consumer was added.

**N1. [P1] Invalid new targets launch in the home directory while claiming the requested folder.**

Location: `src/main.ts:7946`. Related: `src/main.ts:7950`, `:5048`, and `src-tauri/src/lib.rs:312`.

Skipping Git also skips the only directory check on this CLI path. `createThread` catches its branch-query failure and proceeds. The native spawner filters out a supplied cwd that is not a directory and silently substitutes the user's home. The pane can start successfully, so the new handler's dead-pane check does not detect the wrong cwd.

Concrete failing scenario: run `loomctl new C:\missing-project --cmd=`, or give an existing file instead of a directory. Loom creates a thread labelled with that target, but PowerShell starts in the user's home. With the default agent startup, the agent instead operates from home while Loom reports the requested project directory. A later relative-file instruction can affect the wrong files.

Production-handler probes confirmed that a nonexistent path and an existing package.json reached `openThread` without validation. The native home substitution is established by the source above; no real pane was created.

Fix: resolve and validate an existing directory before thread insertion or process startup. Resolve relative forms against the caller and canonicalize the resulting directory. In the native spawner, reject an explicitly supplied invalid cwd; use home only when cwd was omitted. Canonicalization also repairs the demonstrated `new <absolute-folder>` followed by `new <absolute-folder>\.` duplicate-thread case. The old Git top-level lookup normalized that form, whereas the new path reaches `createThread`'s literal equality check at `src/main.ts:6284`.

**N2. [P1] Usage errors can return a bearer token from curl diagnostics.**

Location: `src/main.ts:7801`. Underlying locations: `src-tauri/src/usage.rs:703`, `:738` and `:739`.

This is an inherited native error-handling defect newly exposed through usage's raw machine-readable error output. Curl is launched without disabling its default curlrc. A normal diagnostic configuration enabling verbose output makes stderr include the Authorization request header. On an HTTP failure with an empty body, `get_headers` returns that stderr unchanged. The CLI puts the resulting string in its error field.

Concrete failing scenario: the user's curlrc enables verbose logging, an authenticated usage endpoint returns an empty-body HTTP error, and no local usage fallback is available. `loomctl usage --json` exposes the bearer token to its caller and any caller logs. A clean curl configuration does not trigger this particular leak.

A loopback-only reproduction used the installed Windows curl, a fake bearer and an empty-body 401. Verbose output, standing in for the inherited curlrc setting, put the fake bearer into exactly the stderr branch returned by the native helper. No real credential or external endpoint was used.

Fix: make `-q` the first curl argument to disable default configuration. Return bounded, sanitized failure messages rather than raw stderr/body text. Redact the actual credential values before any error crosses the native boundary, including provider-generated errors. Keep credentials on stdin and the existing control-character rejection.

**N3. [P2] A same-outcome task-end retry acknowledges an outstanding write and cannot recover a failed one.**

Location: `src/main.ts:8178`. Related: `:8180`, `:3866`, `:3809` and `:3814`.

The first command makes the task final synchronously, then waits for its journal write. A concurrent identical command sees a final task and skips the await. Unsaved is set only after the write fails, so the second command can return saved true before persistence. After failure, an identical retry skips the write again and rejects solely because unsaved is set.

Concrete failing scenario: start with a durable working task, issue task-end cancelled, hold its journal write, then issue the same command from another client. The second call reports cancelled/saved true while the durable tail is still sequence 3 and the cancellation is sequence 4. Reject the write and exit Loom. Replay retains the old working task, which startup will settle unknown, instead of the acknowledged operator cancellation. If the user retries before exit, the retry performs no recovery write. With no other journal activity, the outcome stays unsaved indefinitely.

The production journal/handler reproduction confirmed both branches. Watch and notify-check correctly hide sequence 4 during the failed write; they do not cause this acknowledgment bug.

Fix: retain the uncaught persistence promise for the task's settlement and await it on identical requests. After failure, an identical request must request and await a full recovery snapshot without allocating a second event. Do not await only journalQueue, which catches failures. The earlier policy fix already uses this pattern through notifyWrite at `src/main.ts:4146`.

**N4. [P2] Task-end settles a held receipt without waking an existing receipt wait.**

Location: `src/main.ts:7515`. Related: `:3883` and `:7501`.

Concrete failing scenario: submit types a task but holds Enter because echo was not proven. Start `wait --receipt ID`, then run `task ID --end unknown` while the pane stays alive. The final transition removes heldEnter and marks the receipt unsent. Receipt now reports outcome none, but the existing wait only tests result or pane loss. It runs until its timeout even after the task-end write succeeds.

This was reproduced with the actual wait, final-transition and journal handlers. A wait started after settlement rejects immediately; the defect is the already waiting caller.

Fix: include receipt settlement, particularly unsent, in the wait predicate. After waking, handle an unsent receipt with the same explicit no-outcome response as the initial guard. Preserve the distinction between an operator ending tracking and an agent actually acknowledging work; do not invent a result.

**N5. [P2] Codex pane settings have no data source, including explicit startup selections.**

Location: `src/main.ts:7356`. Related: `:7357`, `:8870` and `:7442`.

Concrete failing scenario: run `add --agent codex --model gpt-6.1-sol --effort xhigh`, then read panes or nested thread/status pane records. The CLI appends the correct startup flags but retains no structured selection in the pane settings. Model, effort and context depend on usage, and the usage poll selects only isClaude panes. The native session-usage reader is Claude-specific too, at `src-tauri/src/usage.rs:285`. Therefore running more Codex turns or widening the pane cannot populate these fields.

The installed thread response independently confirmed all three null fields in two Codex panes. The committed item-7 test assigns a fabricated Codex usage object; it verifies formatting, not collection.

Fix: add a Codex session-data reader tied to the pane's known session and generation, using bounded provider records for model/effort and context. Preserve startup selections as structured fallback data until observed provider settings take precedence. Track context from the provider's actual context usage/window, not cumulative session token totals. Supply an equivalent OpenCode producer if item 7 is meant to cover every supported agent. Keep null for values that truly remain unavailable.

**N6. [P2] Usage bypasses the account fetch coalescing and rate-limit policy.**

Location: `src/main.ts:7800`. Related: `:7090`, `:7103`, `src-tauri/src/usage.rs:722` and `:848`.

Concrete failing scenario: two monitoring sessions poll usage, or several clients request it while a top-bar poll is outstanding. Every request invokes the native fetcher independently, without sharing planPolls or a cooldown. Twenty concurrent production-handler calls started twenty separate Claude fetches in the reproduction. Codex can issue a second request for reset-credit details for each fetch.

The existing UI explicitly coalesces requests per provider and normally polls only every five minutes because the endpoint rate-limits hard. The CLI can consume that budget repeatedly, force stale fallbacks and create many overlapping curl processes. No external rate limit was deliberately hit.

Fix: share a per-provider fetch promise between explicit CLI reads and background polls. Add a bounded freshness/cooldown policy and honor rate-limit retry information; return the cached reading with explicit freshness/stale information during that interval. Separate explicit fetch authorization from the background polling preference so usage still works when plan-usage is off.

**N7. [P2] Usage exports incompatible reset-time strings under the same field.**

Location: `src-tauri/src/usage.rs:775`. Related: `src/main.ts:7800`, `:1251` and `src-tauri/src/usage.rs:903`.

Concrete failing scenario: a consumer parses both providers' limits.resetsAt with Date.parse or an ISO datetime parser. Claude's API reset date parses, but Codex's value `"1791580233"` does not. The consumer cannot schedule the Codex reset or orders it incorrectly as a string.

The bare epoch is deliberately produced by shape_codex for both live and local records. The GUI compensates with resetMs, but the new CLI returns the native object directly. Thus the observation is explained by source, rather than a stale installed frontend. Claude's statusline fallback can also supply numeric strings, so normalizing only the Codex live response would be incomplete.

Fix: normalize all exported reset times at a shared boundary to validated ISO UTC strings or null. For the observed value, the result is `2026-10-09T21:10:33.000Z`. Apply the same representation to fallback reset dates and banked-reset expiries. Do not change the account's reset instant.

**N8. [P2] Quoted survey text becomes an actionable menu and passes the revision guard.**

Location: `src/prompt.ts:11`. Related: `src/main.ts:7860` and `:4427`.

Concrete failing scenario: Claude prints documentation containing the exact survey sentence and choices, with an ordinary draft composer below it. Menu reports that quoted sentence as a survey. `choose <pane> 0 --menu REV` rechecks the same transcript text, passes the guard and writes 0 into the actual composer.

The production menu/choose reproduction confirmed the single digit write. readSurvey searches anywhere in the visible screen and the revision covers only its match, with no evidence that the agent is currently consuming survey keys. This is new behavior; ordinary numbered-menu detection requires a highlighted option.

Fix: identify the active survey UI region and its position relative to the live composer/footer, instead of accepting transcript text anywhere. Revalidate that active region immediately before writing. Include negative cases for assistant/tool output quoting the survey and for a dismissed survey left above a normal draft.

**N9. [P2] A wrapped survey question is invisible to menu and choose.**

Location: `src/prompt.ts:11`. Related: `src/main.ts:7859`, `:8053` and `:4424`.

Concrete failing scenario: a narrow pane draws the question as `How is Claude doing` followed by `this session?`, or a terminal soft wrap splits a word. The command supplies physical rows through liveScreen with joined false. The regex requires literal spaces throughout the question, so readSurvey returns null. Menu returns no question and choose refuses it, despite all choices being visible.

Both word-wrapped and soft-wrapped question fixtures reproduced the miss. The committed tests wrap only between the question and options, so they miss this case.

Fix: reconstruct soft-wrapped logical rows for the survey region, using xterm's wrap metadata. Permit ordinary whitespace between question words when the agent inserts real line breaks. Keep numbered-menu parsing on physical rows where its divider logic needs them, and retain the active-region checks from N8.

**Task, notification and bridge checks.**

Twenty-four settlement fixtures covered submit/send/manual sources, cancelled/unknown outcomes and absent/held/released/muted notification owners. They used production command and transition functions; separate failure probes used the production journal queue.

- Each ordinary settlement produced one contiguous final event with signal loomctl and reason operator-cancelled or operator-unknown. The outcome survived journal replay. A settled same-outcome retry allocated no additional event, and a different final outcome was refused.
- Pending or failed final writes stayed hidden from durable watch and returned null from both notify-check modes. A later independent recovery write persisted the missing cancellation without a sequence hole.
- Cancelled/unknown events returned false in v3 and none in v4, including unresolved owners. The new command does not fabricate completion notices or responses.
- Actual external v3 parser and Store.ingest methods accepted 24 emitted v3 batches in SQLite memory, advanced the cursor, accepted replay without collisions and created no outbox or completion rows. The delivery method found no notice to send.
- The unchanged bridge rejected actual v4 and context-enriched batches as blocking_source_update_required. Its capability is still v3 at `email_bridge/bridge.py:30`. No v4 migration, bridge edit or deployed sender upgrade is implied by these Loom commits.

No new flag-value shell injection was found in the reviewed model/effort construction. Unsafe model characters are rejected before thread/pane creation, effort comes from a fixed set, folder paths cross native APIs as data, and the control pipe remains owner-only with remote clients rejected. N1 concerns the wrong working directory, and N2 concerns error disclosure, despite those boundaries.

**Validation and preservation.**

The six existing Node suites passed: main_context, main_cli, task, prompt, task_event_gate and cli. Additional in-memory harnesses extracted production TypeScript handlers with the installed parser and executed the specific interleavings above. Initial harness attempts with omitted VM dependencies were corrected before recording results. There was no application build, source edit, dependency install, staging or commit.

Native boundaries, provider reports and journal failures were synthetic except for the read-only installed info/threads probe and the installed curl loopback test with a fake token. The installed probe reached Loom PID 20260, version 3.0.0, protocol 3. That identifies the running instance and observed records, not its exact source commit. The initial sandbox pipe denial was resolved with an approved read-only probe. No live input, window mutation, production journal/database access, real credential read, external account API request or SMTP connection occurred.

The full served-bundle/browser and native Rust suites were not run. The request forbids building, and no responsive or native Windows stall closure is claimed from source-function tests. The additional tests and proposed fixes existed only in memory.

Preservation hashes cover all 163 tracked working files, the Git index and 16 bridge source/documentation/test files. All matched the initial snapshot both before and after the report was written. HEAD stayed bb37e97. The pre-existing Cargo.toml modification and untracked reports/studies remain. This report is the only filesystem artifact created.
