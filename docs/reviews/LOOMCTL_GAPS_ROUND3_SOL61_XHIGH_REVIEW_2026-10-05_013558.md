# Loomctl gaps round 3 review

Reviewed `a8ddf84..b60f957` on `main`, nine commits, ending at `b60f9572b1846e548c924bd746a7c9c4950f055f`. Review date: 2026-10-05, Africa/Tunis. Loom file locations refer to this HEAD. External bridge locations refer to `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`, read only.

Seven P2 findings remain. Two are credential-filter gaps, one hides valid custom model identifiers, and four concern session refresh or retained reader state. R2, R5, R6, and R7 close their reported scenarios. R1 rejects the original secrets but still admits other recognizable credentials. R3 closes the large-tool-output scenario but has retention and invalidation gaps. R4 refreshes minimized panes when native reads finish within its deadline; slow reads can still leave them indefinitely stale.

The on-disk email bridge's v3 contract remains compatible. Sixty production-handler cases passed its actual parser, in-memory ingestion, pre-send policy check, and replay deduplication. No v4 or notification-context bridge upgrade is included or implied.

The reference is [Loomctl gaps round 2 review](LOOMCTL_GAPS_ROUND2_SOL61_XHIGH_REVIEW_2026-10-05_001321.md), committed by `5550922`. The October 4 review reports supplied the journal, startup, ownership, policy, notification-context, and earlier CLI history. Their test results were not counted as runs in this review.

## Disposition of R1 through R7

| Finding and commits | Does the fix close its failing scenario? |
| --- | --- |
| R1, `be67fb6` and `b60f957` | Yes for the original `sk-` model, `password=synthetic` effort, controls, malformed identifiers, and restored fallbacks. Native validation is at `src-tauri/src/usage.rs:342`; the final pane export check is at `src/main.ts:7457`. The follow-up's GitHub fine-grained PAT, Google key, temporary AWS ID, and JWT fixtures are rejected as settings. N1 and N2 prevent a broader credential-output pass. N5 covers false positives. |
| R2, `786f817` | Yes. `src/prompt.ts:8` and `:9` recognize actual Unicode divider/composer glyphs and U+00A0 after the composer. `src/main.ts:3166` uses those same predicates while reconstructing survey rows. Production menu/choose regressions pass for captured glyphs, hard wraps, and a word split across a soft wrap. |
| R3, `90cd4dd` | Yes for the original model change followed by a 300,000-byte tool result and token-count record. `CodexReader` retains settings across appended records and skips oversized tool output without clearing them. Native source and an in-memory byte-state model establish that behavior; the Rust reader was not compiled or executed. N4, N6, and N7 cover remaining reader-state failures. |
| R4, `f8b4e1e` | Partial. `panes`, `threads`, and `status` now invoke collection independently of window visibility at `src/main.ts:7932`, `:7913`, and `:7880`. Concurrent reads share an outstanding frontend promise, and changed generation/session replies are rejected. N3 shows why a slow native reading is never applied and why coalescing ends before the native work ends. |
| R5, `e704d6f` | Yes. `src-tauri/src/usage.rs:1020` carries the detail endpoint's sanitized retry duration into a successful primary plan. `src/main.ts:7147` extends the shared cooldown. The committed frontend regression using the native detail-429 result schedules 7,200 seconds, makes no fetch at one hour, and fetches after expiry. Primary limits remain available with a fixed missing-details note. The native HTTP regression was inspected, not run. |
| R6, `de98f32` | Yes. `src/prompt.ts:13` considers later matches and selects the candidate with no trailing content. An earlier complete quote no longer suppresses the real footer. Production menu/choose checks accept the active survey, then reject the same revision after dismissal without writing another key. |
| R7, `5196892` | Yes. `src/main.ts:3797` tracks the latest queued mutation per task; `:3827` clears only the matching mutation. `:3837` reports false for pending or failed writes. The regressions pass for plain task/tasks reads, success, failure, recovery, and two newer same-state mutations. Durable watch and notify checks still exclude unwritten sequences. |

## Findings

### N1. [P2] Recognizable GitLab and Hugging Face credentials still pass as model identifiers

Location: `src/task.ts:64`. Native counterpart: `src-tauri/src/usage.rs:347`. Export: `src/main.ts:7457`. Remaining R1 coverage gap.

The new regexes recognize a selected set of credentials, but their allowed model grammar also admits other well-known token formats. Neither rejection predicate recognizes `glpat-` or `hf_`. These are documented credential prefixes, rather than arbitrary opaque strings that no heuristic could classify. See [GitLab's detected-secret format](https://docs.gitlab.com/user/application_security/secret_detection/detected_secrets/) and [Hugging Face user access tokens](https://huggingface.co/docs/hub/main/en/security-tokens).

Concrete failing scenario: a selected rollout's `turn_context.model`, or restored `startupSettings.model`, contains a GitLab PAT-shaped value, `"glpat-" + "b".repeat(20)`. It satisfies the identifier grammar and length limit. The native predicate accepts it, and the final frontend check returns the entire value. `panes --json` and nested thread/status pane records expose it. `"hf_" + "a".repeat(34)` follows the same path.

The actual TypeScript `settingValue` returned both synthetic values unchanged. A synthetic `gsk_` value also passed, though the first two formats are enough to establish this finding. Native acceptance follows the identical grammar and missing patterns; it was not tested in compiled Rust.

Fix: extend recognized-token rejection at both boundaries, including token-length requirements and appropriate boundaries. Keep this check before serialization and before any shortening. Add the GitLab and Hugging Face cases to the shared fixture and assert absence from complete pane/thread/status replies and errors. Do not replace format checks with rejection of any long identifier.

### N2. [P2] The follow-up's rejected credentials still escape through notification context

Location: `src/task.ts:84`. Related: `:60`, `:64`, `:110`, `:129`, and `src/main.ts:8338`. This disclosure route predates the range; the R1 follow-up does not cover it.

`b60f957` adds its new credential formats directly inside `settingValue`. Notification-context labels and IDs still consult only the older `PRIVATE` expression. Consequently, a value rejected as a model remains accepted as a thread name or restored thread ID. Capture and journal replay both use `taskContext`, so replay does not repair it.

Concrete failing scenario: rename a thread to a fine-grained GitHub PAT-shaped value from the new private fixture, then complete a task. Read `watch --metadata --policy --notification-context`. The complete token-shaped value appears in `context.threadName`, without `private-label`. Supplying the same value as an optional journal context's `threadId` also preserves and exports it.

The actual `taskContext` and `contextRecord` exported all eight new private fixture values intact in both fields, while `settingValue` rejected all eight. This includes the fixture's provider-prefixed variants. The production enriched watch projection calls that same `contextRecord`. The current v3 email bridge does not consume context, so this is an enriched metadata disclosure, not evidence that it was mailed.

Fix: use the same complete recognizable-credential predicate for settings, labels, and optional restored IDs. Keep identifier validation separate from label cleanup. Rejected context values must become null with a fixed issue code, preserving the event and sequence. Test capture, replay, and both enriched watch variants with these fixtures, rather than testing settings alone.

### N3. [P2] A refresh timeout discards the late reading and permits duplicate native work

Location: `src/main.ts:7423`. Related: `:7429`, `:7434`, `src-tauri/src/usage.rs:460`, and `src-tauri/src/lib.rs:1378`. Introduced by `f8b4e1e`.

The two-second race wraps the fetch itself. When its timer wins, the only assignment loop receives an empty object and the pending entry is deleted. The underlying invoke is still running. Its later successful reply has no assignment continuation. A subsequent query can start another native call for the same pane while the first is outstanding.

Concrete failing scenario: minimize Loom with cached model old, change the session to model current, and query panes while each native read takes three seconds or more. Every CLI wait ends at two seconds with old settings. Every eventual fresh reading is discarded. Repeated queries can queue further workers behind the native cache mutex without ever updating the pane. A first reading similarly stays null.

An extracted production-function test manually fired the deadline, started a second query while the first invoke remained unresolved, then delivered both valid replies. There were two outstanding native calls and the exported model remained old. This confirms the scheduling failure without needing a slow disk.

Fix: keep one promise for the actual native operation until it settles. Apply its result in a generation/session-checked continuation even if a CLI caller has stopped waiting. Put the two-second race around each caller's wait, not around result collection or the lifetime of coalescing. Preserve a cached reading on timeout, and expose its age or stale status if it is returned.

### N4. [P2] A scoped pane query evicts other sessions' incremental readers

Location: `src-tauri/src/usage.rs:461`. Related: `:413`, `:487`, `src/main.ts:7412`, and `:7928`. Introduced by `90cd4dd` and exposed by R4's scoped CLI refresh.

`codex_usage` treats the panes in one request as the complete set of live sessions. But `panes --thread`, `panes --state`, and the frontend's set of fresh requests can all contain a subset. The retain call deletes every other reader, including its selected path, offset, partial-line state, and latest settings.

Concrete failing scenario: minimize Loom with Codex sessions in threads A and B. A's rollout contains an old turn context, a 34 MiB tool record, and a newer context afterward. Alternate `panes --thread A` and `panes --thread B`. Each A read starts over and consumes only its first 16 MiB. It always exports old settings and never reaches the newer record. Each request also repeats discovery rather than using the cached selected path.

A faithful in-memory model of the source's eviction and byte limits reproduced this. Four alternating A/B cycles all returned old; three uninterrupted A refreshes finally reached current. This was a source-algorithm check, not execution of the Rust reader.

Fix: do not evict a reader merely because its session is absent from a scoped request. Retain entries by session identity and prune against the complete live-session set supplied separately, or use a small bounded retention policy. Scoped reads must retain progress across intervening queries for other sessions. Add an alternating-thread regression with a record crossing the per-refresh bound.

### N5. [P2] The free-text assignment heuristic hides valid custom model names

Location: `src/task.ts:64`, through `:60`. Native counterpart: `src-tauri/src/usage.rs:344`. Startup acceptance: `src/main.ts:7541`. Introduced by `be67fb6`.

The same private-text expression used for labels now runs over model identifiers. Its `token\s*[=:]` and `secret\s*[=:]` alternatives interpret ordinary model-name segments followed by a colon tag as credentials. Colon tags and slash namespaces are explicitly allowed in the new model contract.

Concrete failing scenario: a custom provider exposes the model alias `vendor/token:latest`, or `vendor/secret:v2`. Start it with `add --agent codex --model vendor/token:latest`, or observe that identifier in a rollout. The startup command accepts the identifier and constructs the expected command, but exported model is null. The value is short, contains no control or credential-sized component, and fits the documented grammar.

The actual production `cliCommand` accepted both aliases; the actual `settingValue` rejected both. These are concrete custom alias cases, not a claim that a particular public model currently has those names. The committed public-model and provider-name fixtures pass.

Fix: separate model-token detection from free-text `password/token/secret: value` detection. Reject recognized credential formats while allowing normal namespace/name/tag syntax. A bare colon after a word naming a credential is not enough to classify a model ID as private. Add valid custom aliases alongside the existing provider/model fixtures.

### N6. [P2] Truncation followed by regrowth between reads preserves the old file's state

Location: `src-tauri/src/usage.rs:393`. Related: `:408`, `:410`, and `:423`. Introduced by the retained reader in `90cd4dd`.

Invalidation detects a new file identity, an observed shrink, and a changed modification time at exactly the same length. An in-place rewrite with the same identity and a larger final length takes the append path, even when every previously consumed byte was replaced. The reader does not verify its consumed prefix or the record boundary before its offset.

Concrete failing scenario: first read a rollout containing model gpt-old, a 300,000-byte tool record, and token count 10. Between polls, truncate and rewrite the same file with the same session header, model gpt-new, a 310,000-byte tool record, and token count 22. Its identity stays the same; its length grows. The reader seeks to the old offset inside the new tool record, skips the damaged suffix, and processes the new token count. It returns gpt-old with current context 22, even though gpt-old no longer exists in the file.

The in-memory byte-state model reproduced exactly that mixed reading. This is not a native filesystem reproduction. Ordinary observed shrink and changed-file-identity rotation controls reset correctly in the source and model.

Fix: verify that the previously consumed prefix still belongs to the same append history before extending it. Retain bounded byte checkpoints at the header and consumed boundary, or use a reliable producer/file generation marker; reset and revalidate on mismatch. Test truncate-and-regrow with a larger final size and with a pending partial line. File identity and monotonic length alone do not establish append-only content.

### N7. [P2] An unset effort in a newer turn context leaves the previous effort active

Location: `src-tauri/src/usage.rs:443`. Export: `src/main.ts:7458`. The folding omission predates this range; the incremental cache now retains its effect indefinitely.

The fold changes effort only when the newer row supplies a string. A null or omitted effort leaves the last effort in place even when the same row changes the model. That is different from retaining settings when a tool-output row contains no settings at all. A turn context is a newer settings snapshot.

Concrete failing scenario: read a turn context for a reasoning model with high effort. Append a new turn context for a different model whose effort is null or absent. Model changes, but the reading continues to advertise high effort. Later tool output and token-count records preserve the false pairing indefinitely.

Codex's [v0.159.0 TurnContextItem schema](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/protocol/src/protocol.rs#L3078) makes effort optional and omits it when unset. Its schema tests accept a context without that field. Thus absence is a supported producer shape. The source-algorithm check reproduced the null case, returning the new model with the previous high effort. Compiled Rust and a live model switch were not run.

Fix: distinguish no new turn-context observation from an observed current context with unset effort. Clear the old effort for the latter and preserve that observed-unset state through export, so an obsolete startup fallback does not revive it. Cover both null and missing effort, the legacy reasoning_effort alternative, and subsequent large tool output.

## Main-thread stalls and the 00:55 Windows hang

The Application log confirms the incident. Event 1002, record 92729, was written at `2026-10-04T23:55:50.0561791Z`, which is 2026-10-05 00:55:50 in Tunis. It names `loom.exe` 3.0.0.0, process `0x4f24`, decimal 20260, at the installed Loom path. HangType is `Top level window is idle`.

The event's process StartTime decodes to 2026-10-04 21:22:54.797 UTC, or 22:22:54 in Tunis. The installed executable's observed creation/write time is 21:17:20 UTC. Both precede this range's first commit at 00:26:53 on October 5. The R1 follow-up was committed at 01:07:20, after the hang. A version string does not identify a commit, and no loaded bundle or hang dump was examined. These observations do not establish that the hung process ran any fix reviewed here.

No new direct multi-second synchronous UI-thread wait was found in these diffs:

- `codex_session_usage` dispatches filesystem traversal and parsing through `spawn_blocking` at `src-tauri/src/lib.rs:1297` and `:1378`. The new file reader does not run on Tauri's main event thread.
- Nevertheless, `src-tauri/src/usage.rs:460` holds one mutex across discovery and all selected-file reads. A refresh can perform 20,000 directory-entry checks and scan 16 MiB per requested reader, not 16 MiB for the entire request. Filesystem calls can take seconds even with an entry/byte bound. N3 permits uncancelled work to accumulate; N4 repeatedly makes cached sessions cold. Those are credible native-worker latency and resource-load problems, not proof of a direct main-thread block.
- `panes`, `threads`, and `status` now await collection before replying. Their two-second deadline relies on the WebView's event loop and timers. A stalled or throttled page cannot provide a wall-clock two-second guarantee. The extracted tests prove handler scheduling while the event loop runs, not responsiveness of a hung native window.
- Codex account usage still performs a primary curl and, when credits exist, a detail curl serially. Each has a 20-second maximum at `src-tauri/src/usage.rs:892`; the detail call is at `:1045`. A 13-second usage call fits that path. It runs on the blocking pool at `src-tauri/src/lib.rs:1398`, so CLI latency alone does not prove a UI-thread hang. This serial request cost predates R5.
- Journal serialization at `src/main.ts:3806` and `:3807` still scans retained events and can stringify a whole recovery snapshot synchronously on the page. This work predates R7; the new pending map adds only operations over the mutation's task IDs. A large open-task history could make the existing scan/serialization expensive, but no seconds-long stall was measured here.
- Survey matching and row reconstruction operate on visible terminal rows. No unbounded transcript scan was added on the page by R2/R6.

A further native discovery limit remains: `src-tauri/src/usage.rs:475` starts a fresh 20,000-entry budget on every cache miss and retains no unfinished traversal. A selected file beyond that prefix is never discovered in a stable directory order. The 32-level/entry ceilings and 256 KiB record ceiling are documented. The separate 64 KiB first-record cap at `:399` also remains. These are collection limits, not evidence of the Windows hang. A future recovery of large session trees needs resumable discovery and an explicit incomplete-reading indication.

The read-only follow-up for the reported hang is a stack or dump for the affected process, or existing WER evidence identifying its waiting threads. This review did not generate a dump, attach a debugger, change the running app, or attribute the incident to a commit without that evidence.

## Task, notification, and email bridge contracts

Read the actual bridge parser, Store ingestion, completion deduplication, pre-send delivery gate, BlockingLoomSource, and contract documentation. Its on-disk capability remains `loom-durable-events-v3` at `email_bridge/bridge.py:30`. Event validation at `:57` requires exactly nine fields. Batch validation at `:89` requires exactly six. Its source adapter reads `watch --metadata --policy` at `:480` and checks default boolean/null eligibility at `:486`.

The additional matrix executed production `journal`, `moveTask`, `record`, watch, and notify-check functions. Native journal I/O was synthetic. It covered three sources, submit/send/manual, four owner conditions, absent/held/released/muted, and five outcomes, completed/failed/approval/cancelled/unknown, for 60 cases.

| Contract | Result in this review |
| --- | --- |
| v2 metadata | Seven event fields. Loom refused the 18 suppressed-notice cases. The bridge rejected the other 42 v2 batches as policy_capability_required. |
| v3 policy | Nine event fields with boolean notify. All 60 complete streams were accepted by the actual bridge parser and Store, advanced a contiguous cursor to 4, and accepted replay without collisions. |
| v4 policy | Nine event fields, with disposition replacing notify. All 60 replies agreed with v4 notify-check. Non-notices were none; completion/failure/approval followed send, held, or muted. The unchanged bridge rejected all 60 as blocking_source_update_required. |
| v3-context-v1 | Added exactly ten context fields and the explicit capability suffix. All 60 were rejected by the unchanged bridge as blocking_source_update_required. N2 is the separate privacy defect in this enriched contract. |
| v4-context-v1 | Preserved v4 disposition and added the same context shape under its own capability. All 60 were rejected by the unchanged bridge as blocking_source_update_required. |

While each sequence-4 write was held, plain record saved was false, default notify-check hid the unwritten event, and watch returned none of the new events. Both check modes use the same writtenSeq gate in the inspected handler. After success, saved became true, both check modes agreed with watch, and journal replay retained the new state. The existing suite separately passed rejection/recovery and newer-mutation cases.

Actual Store schema, ingestion, and deliver_one ran against SQLite `:memory:`, bypassing the constructor that opens a directory and obtains a runner lock. Eighteen eligible notices delivered once through a recorder sender. The 24 cancelled/unknown settlements created no notice or completion-dedup row. Replay produced no duplicate deliveries. BlockingLoomSource's real probe/read/check methods succeeded with a fake subprocess runner returning the production replies. In total, 222 incompatible batches were rejected as expected.

No legacy wire-format regression was found. The existing v3 limitation remains: an ownership hold becomes false and is permanently suppressed by this consumer. Later release cannot revive it. V4 requires the separately documented consumer and exclusive sender cutover; Loom's opt-in protocol does not implement that external migration. The on-disk bridge was read and tested with synthetic boundaries, not restarted. The currently deployed sender's loaded code and database were not inspected.

## Validation and preservation

The six source suites passed with Node 24.18.0 and `--experimental-strip-types`:

- `src/main_cli.test.ts`
- `src/main_context.test.ts`
- `src/prompt.test.ts`
- `src/task.test.ts`
- `src/task_event_gate.test.ts`
- `src/cli.test.ts`

Additional stdin-only checks extracted production TypeScript functions with the installed TypeScript parser. They reproduced late-reply loss and duplicate invokes, accepted startup aliases hidden by export, credential-validator omissions, notification-context disclosure, and the 60-case bridge matrix. None created a test file.

Native reader findings and native cooldown propagation were inspected from source. An in-memory model exercised the byte offsets, partial-line/oversized-line state, eviction predicate, ordinary shrink/rotation controls, larger in-place rewrite, and null effort. That model is not compiled production Rust and establishes no native filesystem timing or FileID behavior. No Rust suite, application build, served-bundle/headless-browser run, live provider request, live pane input, production journal/database access, credential read, or SMTP connection occurred. No responsive or installed-bundle pass is claimed.

`git diff --check a8ddf84..b60f957` reports only the committed round-2 report's extra blank line at EOF, at line 150. It is not a correctness finding.

Preservation hashes cover 168 tracked working files, the Git index, and 24 bridge source/documentation/test/script files, 193 files total. Final hashes matched the baseline. HEAD stayed b60f957 on main. The pre-existing untracked reports and studies remain. No edit to source or bridge files, dependency installation, staging, commit, or build occurred. This requested report is the sole file written.
