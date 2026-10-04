# Loomctl gaps round 2 review

Reviewed `bb37e97..a8ddf84` on main, ten commits, ending at `a8ddf847bc3f0b3c159fdfa0bc098b5484f180ae`. Review date: 2026-10-05, Africa/Tunis. Loom file locations refer to this HEAD. Bridge locations refer to the source read from `C:\Users\ayoub\Documents\Codex\2026-10-02\task-2`.

There are seven P2 findings. Five concern the new Codex settings and survey paths; two are remaining persistence and cooldown gaps. The original directory, usage-error, identical task-end retry, held-receipt wait, and reset-format failures are closed. Codex settings and usage cooldowns need further work. Survey detection now rejects the original transcript false positive, but its positive fixtures use literal question marks where Claude draws Unicode glyphs, so real surveys are rejected.

The reference is [Loomctl gaps and fixes review](LOOMCTL_GAPS_FIXES_SOL61_XHIGH_REVIEW_2026-10-04_224652.md), committed by `0fb179e`. The other October 4 reviews supplied the startup, journal, ownership, policy, and notification-context history. Their previously reported interleavings were used to interpret this range, without treating an earlier test result as a new test run.

## Disposition of the nine fixes

| Finding and commit | Does it close the reported failing scenario? |
| --- | --- |
| N1, `b8c2f52`, invalid `new` directory | Yes. `src/main.ts:8020` invokes directory canonicalization before thread creation. `src-tauri/src/lib.rs:92` requires an existing directory and removes Windows extended-path prefixes for ordinary consumers. The native spawner also validates an explicitly supplied cwd at `:204`; an invalid supplied cwd no longer falls back to home. The missing-folder, existing-file, and trailing-dot cases are covered by the source and committed handler regression. Native Windows canonicalization was inspected, not executed in a newly built binary. |
| N2, `a3e0065`, credential-bearing usage errors | Yes for the reported curlrc/empty-body failure and provider-error-body variants. `src-tauri/src/usage.rs:769` puts `-q` first. At `:796` and `:801`, HTTP failure output contains only a parsed retry duration or curl exit number. Neither stderr nor the provider body crosses that error boundary. Credential and usage JSON parse errors are also fixed messages. R1 below is a separate disclosure route added by the session reader. |
| N3, `0794e8f`, identical task-end persistence retry | Yes. `src/main.ts:3865` retains the uncaught write promise. A concurrent same-outcome request awaits it, and an identical request after failure writes a recovery snapshot without another event. Production journal/handler checks confirmed both failed callers, hidden unwritten events, successful recovery, and replay of the operator outcome. A plain read's inaccurate `saved` field remains R7. |
| N4, `3efd0ba`, an existing held-receipt wait | Yes. `src/main.ts:7592` includes `unsent` in the wait predicate and `:7593` returns the explicit no-outcome error. The production wait and settlement paths wake an already waiting caller after held Enter is abandoned. No result or completion is invented. |
| N5, `0a19abb`, Codex settings with no producer | Partial. Explicit startup model/effort are retained, saved, restored, and exported as fallbacks. There is now a reader for the selected Codex rollout, with session/generation checks on delivery. R1, R3, and R4 cover untrusted setting values, loss of settings outside the tail, and indefinitely stale or absent readings while minimized. OpenCode context remains unavailable, as the updated help states. |
| N6, `fbdefe1`, usage fetch multiplication | The reported concurrent-fetch scenario is closed. CLI and background polling share `accountPlan` at `src/main.ts:7133`, with a five-minute cache and longer cooldowns for primary-request rate limits. Twenty concurrent callers plus the committed background-poll test use one provider fetch. Error and local-fallback paths carry primary retry information. R5 covers a reset-credit request whose rate limit is still discarded. |
| N7, `273b2d2`, incompatible reset strings | Yes at the shared account-export boundary. `src/main.ts:7125` normalizes all limit reset dates and banked expiry entries. The suites verify epoch seconds, offset dates, malformed dates, out-of-range dates, and null. `1791580233` exports as `2026-10-09T21:10:33.000Z` for either provider. |
| N8, `9465552`, quoted survey writes into a draft | Yes for the exact original negative scenario: a quoted survey above an ordinary composer is no longer actionable, and guarded choose writes nothing after dismissal. However, the commit breaks real survey recognition through R2 and lets an earlier quote suppress a later active survey through R6. It does not earn an overall survey-menu pass. |
| N9, `a8ddf84`, wrapped survey question | The logical-row reconstruction handles the committed ASCII fixtures, including a split word, while keeping numbered-menu rows physical. Real unwrapped and wrapped Claude footers still fail R2. Thus the actual reported feature remains unusable until the footer glyph checks are repaired. R6 is independent of wrapping. |

## Findings

### R1. [P2] Reject recognizable secrets in the new Codex setting export

Location: `src-tauri/src/usage.rs:361`. Related: `:362`, `src/main.ts:7433`, and `:7434`. Added by `0a19abb`.

The reader checks only byte length for model and effort. It exports those strings verbatim after accepting a matching session metadata record. There is no identifier, effort-enum, control-character, or recognized-secret check. The frontend then copies them directly into pane records, including nested thread/status JSON. JSON escaping preserves a secret's bytes; it does not redact them.

Concrete failing scenario: an imported or damaged rollout named for a pane's known session has a valid first `session_meta` row, followed by a top-level `turn_context` whose model contains `sk-` plus a credential-sized value, or whose effort is `password=synthetic`. Both fit the length limits. Polling accepts them, and `loomctl panes --json` exports the values into monitoring output and any caller logs.

This concerns malformed or untrusted structured metadata, not an ordinary user message quoting JSON. The parser ignores a quoted record inside a `response_item`. A synthetic credential fixture passed the native predicates by inspection, and the extracted production `paneSettings` exported both values unchanged. The existing notification-context filter rejects the same recognizable secret when it is a thread label. No real token or live rollout was read.

Fix: validate model identifiers and effort values before serialization. Reject controls and recognized secret patterns across the entire value before truncation; use null or an empty internal value with a fixed diagnostic. Apply the same export check to startup fallbacks and restored startup metadata. Preserve legitimate custom model identifiers without passing arbitrary free text through the settings fields. Add malformed-rollout tests asserting that the private value appears in neither data nor errors.

### R2. [P2] Use Claude's actual composer and divider glyphs

Location: `src/prompt.ts:16`. Related: `:18`, `:19`, `src/main.ts:3166`, `src/main_cli.test.ts:129`, and `:344`. Introduced by `9465552`; the same literal characters were carried into `a8ddf84`.

The committed expressions really contain `[???-]` and `[?>]`. These are ASCII question marks, not a display or terminal encoding artifact. The first class accepts question marks and hyphens, while the second accepts question mark or greater-than. Neither recognizes Claude's `─` divider or `❯` composer. The repository's existing input parser and `docs/loomctl.md` already identify the real prompt glyph.

Concrete failing scenario: Claude draws an active survey beneath the ordinary `─` rule, `❯` composer, and second `─` rule. Run `loomctl menu`. It returns null at the divider check; `choose 0` refuses instead of dismissing it. Splitting the question across physical or soft-wrapped rows does not change this failure.

The production survey parser returned null for a real-glyph footer. The actual menu/liveScreen/choose functions also returned null for its wrapped form and wrote no keys. All committed positive tests still pass because their rules are `????????` and their composer is `?`. An in-memory replacement with the supported Unicode glyphs accepted the real footer and retained rejection of a transcript survey above a draft.

Fix: use explicit Unicode escapes or the shared supported composer/rule predicates in both `readSurvey` and `liveScreen`. Replace the positive fixtures with real terminal characters, including U+00A0 after the prompt. Cover an unwrapped survey, hard wrapping, a word split by xterm wrapping, and the ordinary numbered-menu control.

### R3. [P2] Retain settings when a large tool result pushes turn_context outside the tail

Location: `src-tauri/src/usage.rs:351`. Related: `:355`, `:359`, `src/main.ts:7412`, and `:7433`. Introduced by `0a19abb`.

Every scan starts with a fresh default Usage and searches only the last 256 KiB. A model/effort record outside that tail is forgotten even if a later token-count record remains inside it. The returned object replaces the previous complete pane reading, so this is not merely a missed initial observation.

Concrete failing scenario: a selected session has a `turn_context` for model `gpt-current`, effort high, then a 300,000-byte tool result and a small token-count record. The reader returns context but empty model and effort. A pane initially started with `gpt-old` and low then reports those obsolete startup selections again. Without explicit startup selections, the fields return to null. They remain wrong until a later turn writes another context record.

A synthetic JSONL byte stream demonstrated that the exact 262,144-byte tail contains the complete token-count row and no turn-context row. The extracted production projection then exported `gpt-old`/low alongside current context usage. This proves the truncation and projection; it does not claim execution of the Rust reader in a new binary.

Fix: retain the latest validated settings per selected session and file identity, and incrementally fold complete appended records into that state. Initialize from a bounded streaming scan or separate bounded settings lookup rather than assuming the last tail contains every field. Invalidate on session changes, replacement, or truncation. A missing field in one tail must not overwrite an already observed setting or revive an older startup fallback. Add a large-tool-output case and a model change followed by that output.

### R4. [P2] Refresh Codex session data for CLI reads while Loom is minimized

Location: `src/main.ts:8975`. Related: `:8948`, `:4708`, and `:7904`. The new producer in `0a19abb` inherits the UI-only polling suspension.

Codex settings collection runs only inside `pollUsage`, whose timer skips work when the document is hidden or Loom is minimized. Session-ID collection continues on a separate timer. Pane, thread, and status reads serialize the cached objects without requesting session usage, so a valid session ID does not make these fields current.

Concrete failing scenario: minimize Loom before a Codex session's first completed turn and drive it through loomctl. Its notify report supplies the real session ID, and its rollout contains settings and token usage. Repeated `panes --json` calls nevertheless return null context indefinitely. Alternatively, minimize after a good reading, change the model or consume much more context, and continue querying. The old model/context remain without an age or stale indication until the window becomes visible.

Executing the actual extracted timer expression with the minimized condition made zero polling calls. The collection and CLI handlers establish the remaining path by source inspection. Generation/session checks correctly reject a late response once a fetch does occur; they do not initiate the missing fetch.

Fix: coalesce a bounded session refresh at the CLI query boundary for panes being returned, independently of UI visibility. Keep expensive UI repainting paused while minimized. Alternatively keep lightweight provider collection running and expose explicit reading age/staleness, but a first reading must still be obtainable through the CLI. Cover minimized initial collection, a later settings change, and a session/generation change during the fetch.

### R5. [P2] Carry reset-credit rate limits into the shared cooldown

Location: `src-tauri/src/usage.rs:908`. Related: `:914`, `:837`, and `src/main.ts:7141`. Remaining N6 gap in `fbdefe1`, rather than a newly introduced request path.

A successful primary Codex usage request can trigger a second request for banked-reset expiry details. The `if let Ok` discards every failure from that second endpoint, including the newly parsed Retry-After. The returned plan retains `retryAfterSeconds: None`, and the shared cache schedules another refresh after five minutes.

Concrete failing scenario: primary usage succeeds and reports two available credits. The reset-credit endpoint returns 429 with `Retry-After: 7200`. Loom returns a successful-looking usage reading with missing expiries and `nextRefreshAt` five minutes away. Each subsequent primary refresh asks the rate-limited detail endpoint again during its two-hour cooldown.

The native branch directly proves the dropped error. A production accountPlan check with the exact success shape that reaches the frontend scheduled 300 seconds, rather than 7,200. No real endpoint was called or deliberately rate-limited.

Fix: parse the second request's sanitized error and retain its retry deadline. Either extend the provider cooldown to the longest required duration, or maintain a separate detail-endpoint cooldown while continuing authorized primary reads. Report that expiry details are unavailable or stale without exposing the provider body. Add a primary-success/detail-429 test through the native result and account cache.

### R6. [P2] Search the active footer instead of stopping at the first quoted survey

Location: `src/prompt.ts:11`. Related: `:12`. Introduced by `9465552`.

The regex finds the first matching question/options block anywhere on the screen. If any content follows that match, the function returns null immediately. It never considers a later match at the actual footer.

Concrete failing scenario: the visible transcript contains the complete survey sentence and options as documentation. Beneath that transcript, Claude later draws its real active composer and survey. The first transcript match has content after it, so menu returns null despite the valid active survey at the bottom.

This reproduced with the current accepted ASCII fixtures. It also reproduced with real footer glyphs after repairing only R2 in memory, so R6 is an independent defect. The original N8 negative case is correctly refused; the mistake is allowing an earlier inactive match to suppress the active one.

Fix: identify the final active footer/composer region first and search only that region, or evaluate every candidate and select the one satisfying the footer checks. Revalidate that same region before writing. Add a complete earlier quote plus a real active footer, and retain the quote-only/dismissed-survey negative cases.

### R7. [P2] Report pending settlement writes as unsaved in plain task reads

Location: `src/main.ts:3831`. Related: `:3892`, `:3818`, and `:8259`. Inherited at bb37e97; `0794e8f` closes the identical-end command race but leaves this read variant.

The record helper treats absence from the failure set as proof that the latest change is saved. Pending writes do not enter that set. The new taskWrites promise is consulted by task-end retries, but ordinary task/tasks reads still ignore it.

Concrete failing scenario: a durable working task ends cancelled through `task ID --end cancelled`, with its sequence-4 journal write held. Another client reads `task ID` without --end. It receives cancelled and `saved: true`, while durable watch remains at sequence 3 and notify-check cannot find durable sequence 4. If the held write fails and Loom exits, replay restores the working record and startup settles it unknown rather than retaining the advertised cancellation.

The actual journal, transition, record, and CLI handlers reproduced cancelled/`saved: true` with `writtenSeq: 3` and no new durable watch event. The concurrent identical-end request correctly remained pending. Thus this finding does not undo N3's closure.

Fix: track whether each task's latest mutation is pending, durable, or failed. Make record return `saved: false` while its current persistence promise is outstanding, including same-state field updates and recovery writes. Clear pending state only for the version that was persisted, so completion of an earlier write cannot certify a newer mutation. Add a plain-read check during held success, held failure, and recovery.

## Native reader and credential boundaries

The new session reader uses Loom's `CODEX_HOME`, or the app home directory's `.codex`, at `src-tauri/src/lib.rs:934`. It enumerates the `sessions` subtree using `codex_rollouts`, which follows directory symlinks and junctions and collects `rollout-*.jsonl` paths. The new command does not read `session_index.jsonl`, `config.toml`, or `auth.json`.

For each requested session, `src-tauri/src/lib.rs:1385` accepts only 36 bytes of hexadecimal characters or hyphens. It matches the filename suffix, then the reader requires a first-row `session_meta` with the exact same ID and a non-object source. This prevents a path argument or an unrelated latest session from substituting for the selected session. The UUID check is permissive about hyphen positions, but permits no slash, backslash, or dot traversal. The frontend snapshots generation and session and checks both before assigning the result.

The file reads are a first line capped at 64 KiB and a tail capped at 256 KiB. Ordinary prompt, tool, and assistant text is parsed only as part of its enclosing JSON record and is not exported by this function. R1 is the missing validation for accepted top-level setting fields; R3 is loss of settings between scans. Enumeration itself is unbounded, follows links outside the nominal sessions tree, and has no visited-directory set. These are inherited helper properties newly used by a periodic reader. Cache selected paths and bound traversal when revising this code. No link-cycle crash or filesystem escape was executed, and I am not counting an unverified native crash as another finding.

Account usage has separate intentional credential reads: Claude's `.claude/.credentials.json` and Codex homes' `auth.json`. Those token/account values enter curl through stdin rather than argv. After N2, their failure paths omit diagnostics and provider bodies. The additional N6 header parsing exports only bounded numeric retry information. JSON parse failures and credential-control-character refusal have fixed messages. No new direct auth-file-to-error route was found in those changed paths. This is a scoped pass for account usage errors, not a guarantee that every free-text Loom output can never contain a secret. Screen reads intentionally contain displayed text, and R1 adds a distinct metadata disclosure route.

No new shell injection was found in these commits. Startup selection values retain the existing restricted model grammar and effort set; cwd crosses native APIs as data. The canonical-directory changes reject invalid explicit paths instead of silently changing their meaning.

## Task, notification, and email bridge contracts

The external bridge remains `loom-durable-events-v3` at `email_bridge/bridge.py:30`. Its event parser at `:57` requires exactly nine fields and boolean notify. Its batch parser at `:89` requires the same six batch fields. Its source adapter at `:480` requests `watch --metadata --policy`, and `:486` uses the default boolean/null notify check. None of those files was edited.

Twenty-four production-handler settlement cases covered all three task sources, cancelled/unknown, and absent/held/released/muted owners. Each emitted one contiguous final event at sequence 4, with signal loomctl and the correct operator reason. An identical retry allocated no second event. Journal replay retained the final state. Pending and failed writes stayed invisible to durable watch; successful recovery restored the event without a sequence hole.

All five output contracts were checked for each settlement:

| Contract | Result |
| --- | --- |
| v2 metadata | Original seven event fields, including null response for these outcomes. The real v3 bridge rejects the batch with `policy_capability_required`. A separate held/muted completion control still causes Loom to refuse its v2 read. |
| v3 policy | Original nine event fields; cancelled/unknown notify is false for every ownership state. The actual bridge parser and Store.ingest accepted all 24 streams, advanced the cursor to 4, accepted replay without collisions, and created zero outbox, completion, or muted-notice rows for the non-notices. |
| v4 policy | Disposition replaces notify. Cancelled/unknown is none even for unresolved owners. Completion controls return send, held, or muted as appropriate. The unchanged bridge rejects actual v4 batches with `blocking_source_update_required`. |
| v3-context-v1 | Adds the ten-field context and explicit capability suffix. The unchanged bridge rejects it with `blocking_source_update_required`. |
| v4-context-v1 | Keeps v4 disposition and adds context under its separate capability. The unchanged bridge rejects it with `blocking_source_update_required`. |

The bridge's real probe, read, and check methods were run with a fake subprocess runner returning the production handler replies. The help probe succeeded and selected the unchanged v3 commands. The actual Store schema and ingestion/delivery methods ran against SQLite `:memory:`, bypassing the constructor that opens disk state. Eligible completion controls delivered once through a recorder sender; held/muted v3 controls produced no delivery. Replaying their batches added no duplicate mail. Task-end outcomes produced no send candidate.

This preserves the established consumer contract. A v3 ownership hold still looks like a permanent mute to this bridge; later release cannot revive a row it already suppressed. That is the previously documented deployment limitation, not a new regression in this range. No v4/context consumer, sender migration, or deployed process upgrade is established by these commits.

## Validation and preservation

The six existing Node suites passed: main_cli, main_context, prompt, task, task_event_gate, and cli. The new regressions in the committed suites passed, including their ASCII survey fixtures. Additional in-memory harnesses extracted the production TypeScript functions with the installed parser and exercised journal scheduling, retries, held receipts, account coalescing, real survey glyphs, duplicate survey text, minimized polling, and setting projection. Their native I/O, clocks, panes, and provider responses were synthetic.

Rust changes were reviewed from source. The bounded-tail fixture establishes actual byte retention and the production TypeScript export, not execution of a compiled Rust reader. The secondary-endpoint cooldown finding is established by the native error-discard branch plus the production cache's received success shape. No native suite, provider API call, installed-app probe, browser/served-bundle run, or build was performed. No responsive or installed-bundle behavior is claimed.

All custom harnesses ran from stdin in memory. Python used `-B`; no bridge bytecode cache, temporary database, or fixture file was created. No production journal, bridge database, real credentials, live pane input, SMTP connection, dependency installation, source edit, staging, or commit occurred. `git diff --check bb37e97..a8ddf84` passed.

Preservation checks cover all 164 tracked working files, the Git index, and 16 bridge source/documentation/test files. Their hashes matched the initial snapshot before and after writing this report. HEAD remained a8ddf84 on main. The pre-existing untracked reports and studies remain untouched. This requested report is the only filesystem artifact created.

