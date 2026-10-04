# Loom notification metadata implementation plan

Prepared 2026-10-04 from read-only inspection of this checkout and the external Python bridge source.

## Goal and scope

Every eligible completion, failure and blocked notification should identify the Loom thread, pane and agent/provider that produced the event. Capture that context when Loom records the event and carry it through the journal and delivery queue. A delayed notification must describe the event's original location even after a rename, reorder, move, deletion or restart.

This is a documentation-only plan. It does not implement changes, commit files, submit agent prompts, access credentials, send email, edit subscriptions or change running Loom or bridge processes. Future implementation must preserve existing notification eligibility, ownership holds, authorization and security controls.

## What exists today

The following are source facts, not proposed behavior. Line numbers refer to the inspected checkout.

| Existing file | Observed behavior and relevant locations |
| --- | --- |
| [src/task.ts](src/task.ts) | `TaskEvent` at line 32 has event sequence, task, timestamp, state, signal and optional detail/response. `Task` at lines 39-78 retains `pane`, `ref`, `agent` and `gen`, but no separate thread ID/name or pane title snapshot. `readJournal`, `taskFields` and `writeJournal` at lines 279-333 support full task records, event appends, field updates and compaction. |
| [src/main.ts](src/main.ts) | `Pane` at line 1456 and `Thread` at line 2413 each create a runtime ID with `uid()`. That function at line 1048 uses timestamp plus a global counter. Its suffix is not a pane number. `Pane.paint` at line 2206 computes the visible title from the app title and agent. `paneData` at lines 7293-7298 already exposes runtime thread ID/name, pane ID, one-based number, label and agent for a live pane. |
| [src/main.ts](src/main.ts) | `reserveTask`, `moveTask` and `turnTask` at lines 3785, 3810 and 3922 create and journal task events. `journal` serializes writes and advances `writtenSeq` only after persistence. `watch` at lines 8080-8117 exports metadata from retained tasks/events rather than a thread-name snapshot. |
| [src/main.ts](src/main.ts) | `flushSave` at lines 2816-2835 saves thread names and pane settings, including historical `notifyIds`, but does not save current runtime thread/pane IDs. `openThread` at line 4987 constructs a new thread. `loadTasks` at line 4320 restores historical tasks and policy decisions and changes unfinished tasks to `unknown`. Runtime IDs and historical event ownership are distinct. |
| [src/main.ts](src/main.ts) | `Thread.closePane` at line 2591 removes the pane from its array before calling `dispose`. `Thread.dispose` at line 2768 removes all panes before cleanup. `removeThread` removes the thread at lines 5118-5125. Capturing a number after those operations can produce zero or the wrong position. |
| [src/agent.ts](src/agent.ts) | `Agent` is `claude`, `codex`, `opencode` or `shell`. `agentOf` identifies the CLI family. This is not evidence of an OpenCode session's upstream model vendor, account or model. |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs) | `task_journal_file`, `read_task_journal` and `task_journal_write` at lines 847-880 store the profile's `.tasks.jsonl`. Appends sync to disk; whole rewrites sync a pending file and rename it. A torn UTF-8 tail does not discard earlier records. |
| [docs/turn-tracking-and-notifications.md](docs/turn-tracking-and-notifications.md) | Documents the notification policy, historical owner aliases, v3 bridge and opt-in v4 owner dispositions. A display-metadata change must retain these controls. |

The native metadata contracts already have multiple versions:

- `loom-durable-events-v2` exports `seq`, `task`, `pane`, `generation`, `state`, `at` and `response`. Loom refuses a v2 read that includes a policy-suppressed notice.
- `loom-durable-events-v3` adds task `source` and boolean `notify` through `watch --metadata --policy`.
- `loom-durable-events-v4` replaces `notify` with `disposition` through `watch --metadata --policy-v4`. Its values are `send`, `held`, `muted` and `none`. The documented external v4 queue migration is future work; it is not part of this plan.
- Only `completed`, `failed` and `approval` map to email statuses `finish`, `fail` and `blocked`. `unknown` is not success, and neither `unknown` nor `cancelled` becomes an email notice through this change.

### External Python sender reference

Read-only source was accessible under `C:/Users/ayoub/Documents/Codex/2026-10-02/task-2`. No production state directories, credential files or running sender state were inspected. Source inspection does not establish which version is deployed.

| External relative file | Observed behavior |
| --- | --- |
| `email_bridge/bridge.py` | `CAPABILITY` is v3. `event` at lines 55-83 requires exactly nine native fields and currently rejects human names and unexpected fields. `batch` requires the exact batch shape and capability. `BlockingLoomSource` at lines 445-489 probes help, reads metadata with policy and performs the pre-send policy check. |
| `email_bridge/bridge.py` | `Store.ingest` at lines 254-300 derives stable attempt/event IDs and atomically records seen events, attempts, completion deduplication, outbox rows and the cursor. Each outbox row stores canonical JSON `body` and serialized MIME `mail`. `deliver_one` at lines 391-427 retries stored mail bytes and performs the policy check immediately before delivery. Restart converts interrupted `sending` rows to `uncertain`. |
| `email_bridge/bridge.py` | `mail_bytes` at lines 131-145 sets the fixed subject, event/attempt headers and Message-ID, and emits JSON in `text/plain`. The entire serialized email is limited to 4096 bytes. The existing canonical serializer uses ASCII JSON escapes. |
| `docs/email-trigger-contract.json` | Defines the exact seven-field email body with `additionalProperties: false`, no body version marker, fixed sender/recipient and subject filter, native v3 policy checks and completion deduplication. |
| `tests/test_email_bridge.py`, `tests/test_email_entrypoints.py`, `tests/test_loom_matrix.py`, `tests/test_setup_path.py` | Existing fixtures cover bounds, injection, replay, distinct attempts with identical answers, persistence, policy checks and old state refusal. Extend these rather than replacing their guarantees. |
| `adapter/bridge.py`, `private-plugin/skills/loom-task-events/SKILL.md` | A separate MCP event adapter and explicit task subscription workflow exist. Their authorization and subscription selection are outside this email metadata change. |

The current email body contains only `eventId`, `attemptId`, `task`, `pane`, `status`, `resultReference` and `occurredAt`. Thread name, human pane number/title and agent/provider cannot be obtained from that email alone. The task's stored `ref` and `agent` are not exported in this body.

No built-in email sender or durable email outbox was found in tracked Loom `src`, `src-tauri/src` or `scripts` by searching for SMTP, the email subject prefix, outbox and sender symbols. Built-in waiting indicators, sound and taskbar attention do exist in `Pane` around lines 2165-2186. Treat integrated email transport as a proposed integration point, not an existing module.

## Proposed snapshot design

### Identity and meaning

Add an optional bounded notification context to retained task records and an immutable context snapshot to each new task-state event. Keep a last-known task context for cases where the pane has disappeared before an outcome is recorded. The email projection contains only approved display fields.

| Proposed context field | Meaning and source |
| --- | --- |
| `threadId` | Exact Loom runtime `p.th.id` when captured. Null for legacy history that has no reliable ID. Never use a provider conversation ID, name or filesystem path as this identity. |
| `threadName` | Notification-safe display name of that thread at capture time. Null when unavailable or excluded for privacy. |
| `paneId` | Exact task owner `Task.pane`. Must equal the existing top-level email `pane` value. |
| `paneNumber` | One-based position in the owning thread at capture time, from `p.th.panes.indexOf(p) + 1` while membership is valid. Null if membership cannot be established. Never parse the pane ID suffix or a historical `ref` to obtain it. |
| `paneTitle` | Notification-safe visible pane title or explicit safe display alias. Null if unavailable or derived from sensitive terminal content. |
| `agent` | Canonical CLI family from the task's captured `agent`, such as `codex`. A replacement process must not relabel an old task. |
| `provider` | Canonical notification provider family, currently the same CLI-family value. Render `claude` as Claude Code, `codex` as Codex and `opencode` as OpenCode. This field does not claim an upstream model vendor. |
| `capturedAt` | UTC timestamp when Loom copied the context. This may differ from the agent signal's timestamp used by `occurredAt`. |
| `origin` | `event`, `last-known` or `legacy`. This states whether context was captured for this event, reused from a retained snapshot or unavailable in old history. |
| `issues` | Bounded fixed reason codes, such as `missing-name`, `missing-number`, `private-label`, `truncated-label` or `invalid-context`. No raw input or exception text. |

The requested thread is the Loom thread, not Codex's `codexThread` or a provider session ID. For OpenCode, the known provider family is OpenCode. A future upstream-vendor field would require an authoritative structured source; this plan does not infer a vendor from a title, command, model name or output.

Historical thread/pane IDs remain exactly as recorded through a restart. Restored live objects may have new runtime IDs under the existing design. Do not replace historical IDs, change `notifyIds`, invent an ownership alias or match a recreated thread by its name. Persisting an old ID in the event is sufficient to identify that historical event; it does not grant control over a current pane.

### Capture before objects change

1. Copy a safe initial context when creating or reserving a task, including submit, ordinary send and manual turns. Do not retain a `Pane`, `Thread`, DOM node or mutable context object by reference.
2. At each new state transition, copy event context synchronously before yielding to journal writes or other asynchronous work. Validate pane ID and task generation before using a live pane. Capture at Loom event creation, not at email delivery or a later watch request.
3. Refresh last-known context for open tasks when authorized UI operations rename a thread, change a safe title, reorder a pane or move it. Journal these display-only updates without manufacturing task-state events. If an existing operation merely reorders threads, it does not change the number within a thread. Do not add a new move feature as part of this work.
4. Copy context before `closePane`, thread disposal or removal splices objects out of their arrays. Preserve the original position for any later close-related outcome. Last-known snapshots survive removal even when no live lookup succeeds.
5. Capture before `startupTurns` deferral and retain the copied value in the deferred action. Journal replay, compaction, retry after a failed write and pruning must not reconstruct context from current UI state. Retention continues to follow the existing task/event limits; the sender keeps its own queued payload after ingestion.

A rename after an event does not change that event's name. A rename before the next event changes the next event's snapshot. The same rule applies to position and safe title. When only a last-known snapshot is available, report that fact rather than describing it as an exact current location.

Loom currently receives some provider signals after their source timestamp. Without context captured by that source, it cannot reconstruct the UI as it was at an earlier provider timestamp. `origin: event` means context at creation of the durable Loom event, and `capturedAt` makes that limitation explicit.

## Proposed payload and alert

The examples are synthetic. They show the same event before and after enrichment; implementation must not recompute its identifiers from the added labels.

Existing email body:

```json
{
  "eventId": "event-0123456789abcdef0123456789abcdef",
  "attemptId": "attempt-fedcba9876543210fedcba9876543210",
  "task": "a1b2c3d4e5f60708",
  "pane": "mabc1234-27",
  "status": "finish",
  "resultReference": "loom-task:a1b2c3d4e5f60708",
  "occurredAt": "2026-10-04T18:00:00.000Z"
}
```

Proposed email body version 2:

```json
{
  "schemaVersion": 2,
  "eventId": "event-0123456789abcdef0123456789abcdef",
  "attemptId": "attempt-fedcba9876543210fedcba9876543210",
  "task": "a1b2c3d4e5f60708",
  "pane": "mabc1234-27",
  "status": "finish",
  "resultReference": "loom-task:a1b2c3d4e5f60708",
  "occurredAt": "2026-10-04T18:00:00.000Z",
  "context": {
    "threadId": "mabc1200-14",
    "threadName": "Loom notification work",
    "paneId": "mabc1234-27",
    "paneNumber": 2,
    "paneTitle": "Review",
    "agent": "codex",
    "provider": "codex",
    "capturedAt": "2026-10-04T18:00:00.005Z",
    "origin": "event",
    "issues": []
  }
}
```

Desired human alert after MIME decoding and validated JSON parsing:

```text
Loom task finished.
Thread: Loom notification work
Pane: 2, Review
Provider: Codex
Task: a1b2c3d4e5f60708
Occurred: 2026-10-04 18:00 UTC
Thread ID: mabc1200-14
Pane ID: mabc1234-27
Result reference: loom-task:a1b2c3d4e5f60708
```

Use the same identity lines for failure and blocked alerts. A blocked event says the task needs a decision; metadata never approves it. A result reference identifies a local task record and does not promise that result text is included in the email.

For legacy mail, render the stable pane ID and task, then one concise statement that thread/title/provider metadata is unavailable in this legacy event. For partial new context, render available fields and explicit unknown values. Do not invent a thread name, silently guess a pane number, or turn a missing name into task failure.

## Compatibility and versioning

Version the native stream and email body separately. The existing email has no version marker, so absence of `schemaVersion` means the exact legacy seven-field schema. The proposed body uses `schemaVersion: 2` and an explicit context allowlist. Unsupported versions must not be interpreted as a known schema.

Do not add context fields to existing v2, v3 or v4 native replies. The external parser's exact-field checks make that a breaking change. Add an opt-in native context flag, tentatively `--notification-context`, requiring `--metadata` and an existing policy mode. Use separate advertised capability names, tentatively `loom-durable-events-v3-context-v1` and `loom-durable-events-v4-context-v1`, and probe for the selected one. These names and the flag are proposed, not available today.

The first bridge integration can preserve its current v3 boolean-policy semantics while opting into richer context. A v4 integration must retain v4 dispositions and follow the separate documented owner-hold migration. Do not convert v4 to v3, treat held as permission to send or bundle automatic owner release into this metadata work.

Update the alert consumer to accept legacy and version-2 email bodies before a sender emits the new body. Then enable the new native capability and sender format in a separately authorized rollout. Old consumers keep receiving their existing native shapes. If richer native context is unavailable, a policy-capable legacy source may still produce the existing legacy email; never downgrade to a source without policy checks merely to obtain names.

Keep all of these unchanged:

- Subject format `ASH-LOOM-EVENT <status> <eventId>`.
- Subject filter `^ASH-LOOM-EVENT (?:finish|fail|blocked) event-[0-9a-f]{32}$`.
- Existing configured sender, recipient, exact sender filter, Message-ID and event/attempt headers.
- Authorized task selections, subscription scope, finish/fail/blocked switches, new-pane settings, historical mute rules, owner decisions and pre-send checks.

Names belong only in the bounded body. Do not add them to email headers or broaden an inbox/webhook filter to recognize enriched mail.

## Safe plaintext and privacy rules

Use a shared field specification and conformance fixtures for capture, native export, Python projection and any integrated sender. Proposed initial limits are 96 ASCII identifier characters, 128 Unicode scalar values and 256 UTF-8 bytes for each human label, a 2048-byte canonical context budget, a 3072-byte canonical body budget and the existing 4096-byte final MIME budget. Verify the encoded result, since JSON escapes and MIME encoding can increase size.

Accept strings only. Normalize labels consistently, remove ANSI/OSC escape sequences and control characters, replace line breaks/tabs with spaces, remove bidi/zero-width formatting controls, collapse whitespace and trim. Truncate at Unicode boundaries with a fixed issue code. Do not coerce arrays, objects or numbers into display text. Validate timestamps, exact provider/agent values, pane membership and `paneId` agreement with the core event. Missing fields become null, not guessed values.

The allowed body fields are display data. They never become instructions, a shell argument, a command, HTML, Markdown actions, a callback URL or an authorization decision. Consumers must parse JSON as data and render escaped/plain text. A label such as an instruction to ignore policy is displayed as a label and cannot change the user's requested response or permissions. Do not execute or fetch `resultReference` based on an email label.

Sanitization does not make arbitrary terminal content safe to email. `appTitle` is supplied by a running process, and `p.label` can derive from it. Extract title calculation into a pure helper, but export only a title with known notification-safe provenance or an explicit safe display alias. If that provenance cannot be established, leave the title unavailable. Do not scrape output, prompts, errors or transcripts to fill a name.

Use only thread/pane display fields approved for notifications. Exclude path-like or known secret-bearing labels and report `private-label`; provide a safe alias if the real display name itself contains private data. No heuristic redaction can guarantee that arbitrary free text contains no secret. This is a release criterion for title sources, not permission to send raw titles after stripping control characters.

Never project `dir`, `repo`, startup commands, environment, account/session IDs, prompts, response text, screen text, task `detail`, error output, credential material or private file paths into the email. Keep response hashes in local completion deduplication only. Do not include raw rejected metadata in logs, error mail or outbox diagnostics.

Preserve `text/plain; charset=utf-8` and use a MIME library. If the richer JSON exceeds safe SMTP line length, use a standard bounded transfer encoding rather than concatenating headers or emitting an oversized 7-bit line. The decoded content remains the JSON body. Enforce the 4096-byte limit on final mail bytes; reduce optional display labels with fixed issue codes if necessary, preserving core IDs and policy.

Apply existing raw native reply and event-count limits before processing. The Python source currently caps replies at 1 MiB and batches at 5000 events. Enriched native replies must also fit the byte budget. Return a bounded prefix of events with `next` equal to the last emitted sequence, so later reads receive the remainder without skipping events.

Malformed optional context on an otherwise valid known-version event should yield bounded unavailable context and a fixed diagnostic, allowing the valid core event to proceed under its existing policy. Oversized raw replies, unsupported contracts and invalid core identity/policy still fail closed before cursor advancement. Context validation must not weaken existing core validation or cause a valid notice to disappear because a human label is missing.

## Durable outbox, retries and sender parity

Build and validate the final body once, then persist the canonical body and serialized MIME bytes in the same transaction as the outbox row, cursor and dedup records. Retries send those bytes. They do not refresh names from a live pane, reserialize a changed payload or change headers. Only the existing policy eligibility is rechecked at send time.

Preserve the current Python attempt key based on namespace, journal epoch, task, pane and generation. Preserve the event key based on attempt, event sequence and state. Keep completion deduplication keyed by attempt and response, including the existing unnamed-response behavior. Thread names, titles, numbers, provider labels, context version and mutable policy decisions must not enter these keys.

Keep the existing seven-field core event digest for replay compatibility. Store a separate context digest with the first durable enriched snapshot when needed. A changed context for the same event must not rewrite queued mail or generate another notification; record a bounded integrity diagnostic. Migrating an older event without context does not retroactively enrich its historical snapshot.

Legacy queued rows keep their original body, MIME bytes, IDs, sequence, delivery state, retry count and due time. No send-time backfill or rename lookup. `sent`, `dead`, `muted`, unavailable-event holds and `uncertain` retain their current meanings. An interrupted send remains uncertain because transport acceptance may already have occurred. Metadata migration does not revive, automatically resend or resolve any of those rows.

The current `Store` refuses a mismatched `native_source`. Therefore a new native capability requires an explicit offline store migration or a separately designed guarded cutover; changing the capability constant alone is insufficient. Preserve namespace, epoch, cursor, seen digests, attempts, completions, settings and exact old mail bytes. Hold the runner lock, make a verified backup and prohibit two sender copies. Reuse the safeguards in the existing notification documentation if a directory or policy-version migration is involved. This plan performs no migration or deployment.

The external Python sender and any future built-in sender must consume the same snapshot and produce the same logical payload, status mapping, bounds, subject, IDs and policy outcomes. Compare decoded MIME bodies and required headers; test stored-byte consistency within each transport. A Rust serializer may use different MIME wrapping, but that cannot change values or filters.

There is no current built-in email sender file to patch. A future integrated transport would need a separately reviewed durable queue and delivery owner. Suggested new modules are `src/notification_metadata.ts` for shared capture/projection rules and `src-tauri/src/notifications.rs` if Rust owns that transport. These are proposed paths. Do not put SMTP into provider hooks or create another sender alongside the active Python process. Switching transports must retain delivery identity or transfer the durable state under one delivery owner, never recreate notices with a new namespace.

## Implementation phases and likely files

1. Finalize the contracts and fixtures. Update `docs/turn-tracking-and-notifications.md` and, in the external bridge workspace, `docs/email-trigger-contract.json`. Specify the context schema, safe title source, byte limits, policy-preserving native extension and dual-format alert parsing. Keep legacy schema fixtures intact. The receiving alert formatter/filter configuration is not present in this checkout; locate its authorized implementation before enabling enriched email.
2. Capture and persist context in Loom. Extend `Task` and `TaskEvent` in `src/task.ts`; validate the optional context during replay and preserve it through `taskFields` and compaction. Update task construction/reservation, `turnTask`, `moveTask`, startup deferral and relevant rename/reorder/removal hooks in `src/main.ts`. Audit `Thread.closePane`, `Thread.dispose`, `removeThread` and title updates so capture occurs before topology mutation. No change to state correlation or notification policy.
3. Export the opt-in stream in `src/main.ts`'s `watch` command and its help. Reuse existing journal publication gates and preserve `seq`, `next`, `last`, gaps and event ordering. Bound enriched batches by serialized bytes. Review `src-tauri/src/bin/loomctl.rs` for help/follow passthrough; do not change it unless the new flag or capability needs handling. Review `src-tauri/src/lib.rs` for journal durability limits; its text persistence may need no implementation change.
4. Upgrade the external bridge in `email_bridge/bridge.py`. Add exact parsers for negotiated enriched contracts and legacy input, the email version-2 allowlist, bounded label projection and MIME builder. Keep `mail_bytes`, `Store.ingest`, the runner lock and `deliver_one` persistence/policy guarantees. Extend `tests/test_email_bridge.py`, `tests/test_email_entrypoints.py`, `tests/test_setup_path.py`, `tests/test_loom_matrix.py` and synthetic fixtures. Do not modify the separate adapter's task subscriptions as a side effect.
5. Implement built-in transport parity only if that sender is separately authorized. Use the same fixture/schema specification and durable event snapshots. Require queue ownership, retry/uncertainty and policy conformance before cutover. Existing sound/taskbar behavior can consume the same safe display helper if needed, without changing what causes an alert.
6. Validate in disposable profiles and bridge copies. Prepare any migration and rollout as a separate change with reviewed dry-run evidence. Enable the receiving parser before new-body emission. This document creates no approval, rollout or production action.

## Required validation for a future implementation

| Scenario | Required evidence |
| --- | --- |
| Claude Code, Codex and OpenCode | Each provider family emits eligible finish, fail and blocked events with the correct task, thread, pane ID/number, safe title and provider label. Cover submit, send and manual task sources. Preserve current correlation limits; do not fabricate tasks to fill the matrix. |
| Multiple panes and threads | Two panes in one thread and equal titles in different threads remain distinguishable by IDs and true one-based positions. A pane with ID suffix `27` can correctly report pane number `2`. |
| Rename/reorder/move | Rename or reorder before an outcome gives the next event the new context. Rename or move after journaling but before ingestion/send leaves that event and all retries unchanged. Earlier blocked and later finished events can have different display snapshots for the same task. |
| Removal races | Capture an outcome before removal, then send after pane/thread deletion. Also remove the pane while outcome handling or startup replay is deferred. Preserve pre-removal position through close-generated outcomes; never emit number zero or attribute it to another pane. |
| Restart and compaction | Replay a journal, compact it and restart Loom and the bridge. Historical snapshots, owner IDs and queued mail bytes match exactly. A recreated same-name thread cannot acquire an old task's identity. |
| Failed persistence | Inject a failed append, whole rewrite and crash between event creation and publication. Watch exposes no unpersisted context; retry writes retain the original copy and event sequence. Torn-tail recovery keeps earlier metadata. |
| Legacy history and queued mail | Old journal lines without context remain readable. Versionless seven-field emails render the fallback. Migrated pending rows preserve old bytes, backoff and policy checks. Sent/muted/held/uncertain/dead rows do not requeue. An old sender refuses a migrated unsupported state rather than creating a second delivery owner. |
| Deduplication | Replay the same event and repeat a completion report for one attempt. Queue no second notification. Two distinct tasks with identical output still get distinct notices. Changing a label never changes event/attempt IDs or requeues mail. |
| Missing and unsafe names | Null/empty names retain useful IDs and provider. Raw OSC titles, prompts, paths, private output and secret-like labels stay out of email and rejection logs. No lookup by historical name or suffix. |
| Corrupt/oversized context | Test wrong types, unknown provider values, conflicting pane IDs, invalid timestamps, controls, ANSI, bidi, malformed Unicode and huge labels. Valid core events get bounded fallback context; invalid core/policy or oversized raw input sends nothing and advances no cursor. JSON escaping, multibyte text and final MIME bytes obey their limits. |
| Batch limits | A large enriched history returns bounded sequential batches below the native reply limit. Repeated reads consume every event exactly once, without cursor jumps or changed gap semantics. |
| Policy and authorization | Pane/kind off at ingestion or pre-send still suppresses the notice. Re-enabling does not replay muted history. Owner-held/muted/null/error decisions retain their selected contract's meaning. Same sender filter, subject filter, recipient and authorized task scope before and after enrichment. |
| Transport parity and retry | Feed the same fixtures to Python and any built-in implementation. Compare IDs, decoded payload and required headers for every status and fallback. A retry after rename/restart uses the original bytes. Interrupted delivery stays uncertain, and two transports cannot both deliver the same queue. |

Use the existing `node src/task.test.ts`, `node src/task_event_gate.test.ts` and `scripts/task-check.mjs` harnesses after implementation. The task harness requires a built page served by Vite and uses Tauri/provider mocks. Add context assertions and race cases to `src/task.test.ts` and `scripts/task-check.mjs`; use `src/agent.test.ts` for provider-family mapping if that helper changes. Run relevant Rust journal tests only if the Rust persistence/transport changes.

Run bridge tests against a disposable copy and temporary databases with fake senders. `scripts/validate_email_bridge.py` writes evidence into its workspace, so it is not a read-only inspection command. Real provider smoke checks and any production transport cutover require a later authorized session; no live tests or SMTP calls are part of this plan.

## Completion criteria and remaining dependencies

The implementation is complete when every newly created eligible notice includes a durable bounded context, retries preserve it, consumers render its true event location, and all policy/dedup/security regressions above pass. Legacy or unavailable private metadata remains explicitly unavailable. It cannot be reconstructed reliably after deletion and must never be fabricated.

Two integration points remain to locate or authorize before a future rollout: the receiving human-alert parser, which was not present in this checkout, and a built-in email sender, which does not yet exist here. The external Python reference is accessible but has only been read. No dependency blocks creating this planning document.
