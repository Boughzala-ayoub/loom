# Pane 7 changes and completion notifications

Reviewed on 2026-10-01 UTC. Source snapshot at 19:50:17 UTC.

Checkout: `C:\Users\ayoub\Videos\claude\loom`, branch `main`, HEAD `3d5756ad39213b15a6b0d36f78e6269786358090`. The changes are uncommitted. There is one registered worktree, the main checkout. No branch was switched or recreated.

The target was Claude in `loom:7`, pane `mupi1loe-22`, generation 1, thread `mupi1lme-15`, on Loom PID 20088. At 19:49:10 UTC it was waiting, had completed two turns, and showed its final report. It was not still editing during the captured snapshot.

## Assessment

The changes address the previous review's three priorities, but I would fix the three reproduced P2 issues below before relying on guarded sends. Ignored files now block deletion unless their loss is explicitly allowed. Normal successful sends retain a digest and useful receipt metadata. Claude draft detection and input revision checks are useful additions, but they miss a prompt shape present in the actual control records and do not protect the whole paste-to-Enter interval.

The new features are not active in the running Loom session. At 20:03 UTC, read-only `help receipt` and `help close-plan` returned unknown-command failures. `help send` still listed only the old options. The protocol and version remain 3 and 3.0.0, so those values alone cannot establish that these source changes are running. This review did not rebuild, install or restart Loom.

For notifications, add durable task-correlated events with a replay cursor. Notify separately when an agent ends a turn, needs input, reports completion, or exits. A task-completed event needs stronger evidence than `idle`, a terminal bell or the next agent turn. A local event also needs an approved external delivery mechanism to wake this assistant after the current turn ends.

## Confirmed findings

### P2: Human input during the paste wait can join a guarded submission

Files: `src/main.ts:6851`, `src/main.ts:6874`, `src/main.ts:6879`, `src/main.ts:3448`, and `src/main.ts:1734`.

The input revision is checked in `beforePaste`. Loom then writes the text and waits for its echo. Window typing increments `inputSeq` and writes directly to the PTY. The final `beforeEnter` callback checks suggestion leftovers but never checks whether another writer changed `inputSeq` during that wait. With an initially empty composer, the leftover check returns immediately.

The isolated reproduction uses the actual `send`, `sendReply`, `inTurn`, `keys`, `submit` and `inputState` bodies. Start with empty input and a valid revision, then call send with `--input REV --replace`. During `settle`, inject a simulated human write and increment the same counter used by the window input handler. Loom sends Enter and submits:

```text
approved text AND AN UNRELATED HUMAN EDIT
```

The response still contains the digest of `approved text`. The digest accurately describes Loom's own text, but the submitted input contains more. CLI-to-CLI queuing works; this reproduction concerns a writer outside that queue. No human input or live PTY was used to run it.

Impact: a conditional send can submit a combined task or command that the caller did not authorize. The revision guard currently protects the interval before typing, rather than the whole guarded submission.

Smallest fix: record the expected counter advance for Loom's own paste before issuing the write. Check that expected value again immediately before Enter. An intervening writer should hold back Enter, preserve the input, retain its receipt and return a conservative typed or uncertain result. Reading the counter only after the paste completes would miss a writer that arrived during that write. Keep generation checks and the current queue.

Acceptance tests: delay the paste echo and inject window typing, dictation and another unqueued write. Each must stop automatic Enter without clearing the combined draft. A normal queued send must still submit once. Test both initially empty input and a suggestion.

### P2: The new input parser misses Claude's observed non-breaking separator

Files: `src/prompt.ts:89`, `src/prompt.ts:106` and `src/main.ts:6855`.

`PROMPT` accepts an ASCII space or the end of the line after the prompt glyph. The retained actual pane 7 read-back contains `❯` followed by U+00A0 and `[Pasted text #1]`. Its first character codes are 10095, 160 and 91. The confirmation read-back used the same separator before normal text.

The current `readInput` function recognizes an ASCII-space fixture as a draft or suggestion. Substituting the observed U+00A0 separator returns `unknown` for both. This failure happens before style classification, so having accurate dim attributes does not fix it. The added tests build their prompt with ASCII `> ` and do not cover this observed form.

Impact: the new metadata fails on a prompt shape already used by this PC's Claude session. `--replace` refuses rather than overwriting input, which is safe, but the intended Claude workflow remains unreliable. A post-paste read can also become unknown and hold back Enter.

Smallest fix: accept the observed horizontal separator without loosening menu recognition or style checks. Preserve cell positions and attributes. A fixture using the actual glyph and U+00A0 should cover a draft, a dim suggestion and a collapsed paste. Keep unsupported shapes unknown.

Acceptance tests: replay the saved pane read-back prefix, verify draft and suggestion classification with their respective styles, and exercise a guarded replacement through the post-paste check. Test an unfocused suggestion as well.

### P2: An Enter-write failure deletes the receipt after the text was typed

Files: `src/main.ts:6878`, `src/main.ts:6884` through `6889`, and `src/main.ts:6894`.

The new receipt gets `typedAt` after the paste succeeds. If the later Enter write rejects with a normal IPC error, the catch block treats the operation as untyped because it recognizes only `NotSubmitted` errors with `typed: true`. It deletes the receipt and rethrows the generic error.

The isolated reproduction allows the first write to succeed and makes the Enter write reject. The input still contains `approved text`, but the receipt map is empty and the error has no typed or receipt fields. This defeats the new audit behavior on a common failure boundary. The client transport's `sent: true` still discourages blind retries, but the useful application record is lost.

Impact: a caller cannot look up the digest, stage or key of text already delivered to the input. A native write failure can also leave uncertainty about Enter delivery, so an error must not promise it was never pressed.

Smallest fix: retain a receipt whenever its paste is known to have succeeded, independently of the thrown error class. Return the receipt token and typed evidence. Model an uncertain Enter attempt explicitly when the native error cannot rule out partial delivery. Retain the same-key response and do not automatically send again.

Acceptance tests: inject failures before paste, after paste, during Enter and after an accepted Enter response is lost. Keep the correct audit stage and uncertainty for each. Only a positively unwritten request may be reported safe to retry without inspecting input.

## Status of the earlier review

| Earlier issue | Verified disposition |
| --- | --- |
| Ignored files omitted from deletion protection | Basic fix verified. `inventory` uses `--ignored=matching` at `src/main.ts:4192`. A mocked ignored-only tree refuses before cleanup unless `--discard ignored` is supplied. |
| Missing deletion plan and partial cleanup result | Added. `closePlan` at `6536` binds target identity, pane generations and inventory. Rename invalidation passed. `removeThread` at `4243` rechecks inventory after pane cleanup and reports kept/failed/removed steps. |
| Plain output cannot distinguish draft and suggestion | Partly addressed. `read` adds cursor, input and optional styled rows at `6683`. Claude-only classification exists; other providers remain explicitly unknown. The separator defect above remains. |
| Missing input revision guard | Added, and pre-paste writer refusal passed. The post-paste race above remains. Real drafts are refused by `--replace`; no universal draft-clearing command was added. |
| Receipts lack submitted-text audit data | Normal-path fix verified. SHA-256, UTF-8 size, key and stage are queryable. The Enter-failure record-loss defect remains. |
| Documentation chooses the first matching pane | Fixed at `docs/loomctl.md:526` through `528`. The example requires exactly one Claude pane. |
| Durable retries and task-level completion | Still design gaps. Keys and receipts remain in memory, and agent outcomes still refer to a turn. |

The deletion revision covers inventory paths, HEAD, unique-commit count and target identities. It does not hash the contents of already-listed dirty files, and a wholly ignored folder is one entry. Changes inside that folder need not change the plan. Do not describe this as a byte-for-byte filesystem snapshot. Those limits are stated in the inventory helper and should remain explicit in the user-facing guarantee.

## Completion behavior available now

The existing mechanisms are useful for attention and turn tracking:

- `Pane.wake` at `src/main.ts:2087` increments turns after input, chooses one signal source for that launch, marks the pane waiting, beeps and optionally flashes the taskbar.
- Claude activity at `src/main.ts:1981` remains a screen-output heuristic. Quiet output can become idle; it is not completion evidence.
- `turnReceipts` at `3508` settles agent receipts on the next counted turn. Several pending sends can share that turn. Generation checks at `3492` prevent a different pane launch from supplying a result.
- `waitReceipt` at `6575` returns a turn and reads numbered-menu status. Plain-text questions are not recognized by `readMenu`.
- `wait`, `wait-any` and `--turn-after` exist at `6947` through `6995`. They block an active caller; they do not independently send a later message to this assistant.
- The new `receipt` command provides audit data in the source. It is not yet available in the running instance.

The actual control session shows why the distinction matters. Receipt `6eb58745789542c5` completed turn 1 after Claude said it had not started and asked whether to proceed. `asking` was false because the question was unnumbered. The follow-up authorization receipt `3b9054cb268a4240` completed turn 2 after Claude reported its changes. Both are turn completions. Only the second had a final work report, and this review then found defects in that work.

The same result was reproduced against the current `waitReceipt` function with a plain-text authorization question: `done: true`, `turn: 1`, `asking: false`. That documented behavior is a notification-design gap, rather than a new claim that receipt delivery failed.

The supplied Claude hook file, `src-tauri/src/claude-hooks.json:7` through `18`, currently configures only SessionStart. Comments elsewhere still refer to Stop and Notification markers, so the comments do not establish an installed completion hook. Codex uses OSC notifications and its notify helper. The OpenCode plugin maps permission, question, success, failure and interruption events into busy/waiting markers. The marker file contains only pane ID and a small status string. `send_wakes` and `drain_wakes` at `src-tauri/src/lib.rs:802` and `1090` consume it and emit a transient WebView event. It is not a durable event log and discards much of the provider event's original meaning.

The named-pipe protocol at `src-tauri/src/control.rs:100` through `130` is one request and one reply per connection. There is no external task-event subscription or verified transport to wake this assistant in the reviewed code.

### Current read-only example

These commands work with the recorded session and do not submit a task:

```powershell
$env:LOOM_PIPE = '\\.\pipe\loom-ayoub-pid20088'
$turn = loomctl --json --timeout 3600 wait --receipt 3b9054cb268a4240 |
    ConvertFrom-Json
loomctl --json read mupi1loe-22 --lines 120
```

The result means that a turn ended. Read the answer and verify relevant artifacts before reporting that the requested fixes succeeded. A process pipe and pane identity must be rediscovered after restart. This example does not create background monitoring.

## Proposed notification design

The following API and behavior are a proposal. None was installed or implemented during this review.

### Keep one logical task across its submissions

Add a caller-supplied task ID to the send workflow. Store the task before input is written, along with its request key, prompt digest, workspace identity, Loom instance ID, pane ID, generation and provider session ID. Permit one active logical task per pane generation. Reject or explicitly queue another task instead of letting an unrelated turn settle both.

A clarification reply or permission response should be a continuation of that task with a separate request ID and receipt. The two pane 7 submissions above would belong to one task. An unclassified manual input must taint correlation or require an explicit continuation decision; it must not silently become evidence for the original task.

Keep event types separate from a single coarse status:

| Event or state | Required meaning |
| --- | --- |
| `request_accepted` | Loom durably registered the request; no provider acceptance is implied. |
| `input_written` | The paste write succeeded. Partial failures retain uncertainty. |
| `submitted` | Enter was written; processing is still unconfirmed. |
| `provider_prompt_observed` | A provider adapter observed the matching session and prompt. A pre-processing hook alone is not proof that later policy checks accepted it. |
| `working` | A provider processing event or tool activity was observed. Screen-output activity may be recorded as advisory evidence. |
| `waiting_user` / `waiting_permission` | Non-terminal pause with a task-bound question or permission request ID. No automatic approval. |
| `turn_ended` | One provider response ended. This may be a question, refusal or final report. |
| `reported_completed` | A structured task result names this task and reports completion. It is an agent claim. |
| `verified_completed` | The controller's declared acceptance checks passed. |
| `failed` / `cancelled` | Explicit task failure or confirmed cancellation. A failed tool call does not by itself fail the whole task. |
| `pane_exited` / `interrupted` | The relevant launch ended without a complete result. Preserve exit code and reason where known. |
| `disconnected` / `execution_unknown` | Observation was lost. Do not relabel the task completed or resend it. |

Transient idle must never produce a terminal task event. A timeout ends the caller's wait, not the task. A new generation, unrelated session or delayed event from an older task must not answer for the current one.

### Preserve provider event meaning

Use a structured local helper event instead of overwriting one marker per pane. Carry task ID, request ID, pane generation, session ID, provider event type, event ID and timestamp. Keep terminal bells as attention signals when they cannot be correlated.

Claude's official hook documentation provides UserPromptSubmit, Notification, Stop and StopFailure events. Submit payloads may wrap expanded pasted content, so their raw prompt hash need not equal the original CLI text hash. Stop marks a response ending, excludes user interruption, and can expose background work. Notification carries a typed reason. Confirm these fields in the installed version before using them. [Claude hooks reference](https://code.claude.com/docs/en/hooks)

For exact completion, require a task-specific structured result from a supported provider adapter or an explicit cooperating-agent result command. A bare Stop hook cannot reliably distinguish the authorization question observed here from finished work. If no reliable result is available, emit `turn_ended` or `needs_review`, not completed. Check outstanding background tasks before closing a task; a foreground answer can precede their results.

The existing OpenCode plugin already sees more detailed event kinds than it preserves. Forward those kinds, with session and task correlation, instead of reducing failure and interruption to the same waiting status. Validate Codex's installed notification payload before promising equivalent detail. Do not scrape or retain provider transcripts and full prompts merely to implement notifications.

### Put durable state in the backend

Move task and event records to a Rust-owned journal or transactional store. Do not persist JavaScript Pane references. Store metadata and bounded results; full prompts and terminal output remain opt-in because they can contain secrets. Apply the current account scope to the store and read API.

Give each event a durable ID and monotonic sequence. Update the task state and append its event atomically. Persist idempotency keys and command digests before dispatch. Append an attempt record before side effects, then record the observed outcome. A crash between input delivery and the outcome write must recover as uncertain, rather than execute the same request again.

Keep a per-consumer acknowledged cursor and return explicit retention or expired-cursor errors. Reconnect should replay unacknowledged events. Delivery is at least once; consumers deduplicate by event ID and task transition. Two hook channels describing the same turn must not generate two completion notices. Persisting a journal cannot by itself guarantee exactly-once PTY execution across a crash.

On Loom restart, mark unresolved old-instance tasks interrupted or execution unknown unless a provider session can be positively reconciled. Never attach them to a new pane solely because its numeric position, title or generation counter looks familiar. Preserve completed historical results and refuse reuse of an expired side-effect key until the caller resolves its prior outcome.

### Expose wait and replay through the existing transport

The smallest transport change is a read-only long-poll command returning an event batch and next cursor over the existing one-reply pipe. A CLI `watch` wrapper can repeat that request and print NDJSON. This avoids silently changing existing commands into streams. Publish a capability and event schema version, and fail safely on older apps.

Proposed examples, unavailable now:

```powershell
# Before a future authorized dispatch, verify instance, pane and input revision.
loomctl --json --key req-42 send <pane-id> - --gen 1 --input <rev> --task fix-42 --receipt

# Watch without cancelling the task when the watch exits.
loomctl watch --task fix-42 --after 120 --jsonl

# Reconnect and replay. Return nextCursor even when the filtered batch is empty.
loomctl --json events --task fix-42 --after 120 --timeout 30

# Query authoritative stored state after a timeout or lost connection.
loomctl --json task fix-42
```

An event could have this shape:

```json
{
  "schema": "loom.task-event.v1",
  "seq": "121",
  "eventId": "evt-unique",
  "taskId": "fix-42",
  "requestId": "req-42",
  "instanceId": "instance-uuid",
  "pane": "pane-id",
  "generation": 1,
  "sessionId": "provider-session",
  "type": "waiting_permission",
  "evidence": "provider-event",
  "questionId": "permission-17"
}
```

Send metadata in JSON and diagnostics on stderr. A watch timeout or Ctrl-C should only stop watching. A separate explicit cancel operation should identify the task and generation and return confirmed cancellation or uncertainty.

### Route the event to the user or this assistant

For a user sitting at this PC, Loom already beeps and flashes the taskbar for attention. Task-specific local notifications can use the durable event registry without claiming every waiting pane completed successfully.

For an external controller on this PC, the owner-only named pipe can provide wait and replay. The controller must remain running as the authorized account. Remote clients are rejected; do not widen the pipe ACL or turn it into a network endpoint for this feature.

To notify this assistant after a turn ends, there must also be a supported platform notification or connector transport that can trigger a new assistant run and route it to the correct conversation. No available API was verified here that does that for a Loom event. A locally printed JSON event cannot do it alone. A future approved bridge could forward selected task events to an authorized supported event source, with delivery acknowledgements, retry limits and event-ID deduplication. It requires separate verification of account access, recipient routing, supported triggers and privacy policy. No connector, webhook, credential or listener was configured in this review.

## Notification acceptance tests

1. A submitted prompt is visible but the provider has not processed it. Emit submitted, never completed.
2. Reproduce pane 7's pasted-task authorization question. Emit a pause or turn-ended event, then continue the same task after authorization. Do not announce success for turn 1.
3. An agent is quiet for more than 1.5 seconds while working. No terminal event may follow from idle alone.
4. Deliver duplicate bell, hook and provider events, including a delayed event after a new task starts. Emit one matching transition and ignore stale generation or task evidence.
5. A tool fails but the agent retries successfully. Do not fail the logical task prematurely. Separately test an explicit final failure and user interruption.
6. Stop arrives while background work is still running. Preserve the active task until the structured result and required work finish, or report an unresolved result.
7. Disconnect the watcher after persistence but before acknowledgement. Reconnect from its cursor and replay exactly the unacknowledged events; the consumer produces one notification.
8. Crash between paste or Enter delivery and durable stage recording. Recover uncertainty and refuse blind reexecution of the same key. Restarted panes cannot complete old-generation tasks.
9. Exercise cursor expiration and compaction. Return an explicit recovery path and stored task state rather than silently losing completion.
10. Test the external bridge separately. A local event with no bridge must not claim delivery to this assistant; an approved bridge must identify the correct recipient and deduplicate retried delivery.

## Verification and limits

| Check | Independently observed result |
| --- | --- |
| Current copied `cli.test.ts` | 64 passed, 0 failed |
| Current copied `prompt.test.ts` | 46 passed, 0 failed |
| Current copied `gitparse.test.ts` | 46 passed, 0 failed |
| Selected current-source integration mocks | Six protective checks passed and three defects reproduced |
| Live read-only pane check | Correct pane, generation and checkout; final response and waiting state |
| Existing authorization receipt | Completed turn 2, `asking: false` |
| Running-app capability checks | New receipt and close-plan commands unavailable; old send options |

The additional checks evaluated selected copied function bodies with fake panes, writes, timers, Git results and cleanup. They made no live IPC calls and performed no deletion. The reproduction script succeeds because it verifies the defect; it is not a passing acceptance test for the intended behavior.

Claude reported a successful build, 1,229 mocked UI states at five widths and six mutation checks. Those results were visible in its terminal report, but I did not independently rerun or inspect their full logs. I did not run a build that would replace repository artifacts, a real Loom instance, GUI or live-provider integration tests, Rust tests, crash/reconnect tests, or destructive worktree tests. Installed-version hook compatibility and an external notification bridge remain unverified.

Evidence is retained under `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-pane7-review-20261001T1950`: `snapshot.json`, copied sources, `working.diff`, `staged.diff`, the three helper test logs, `review-checks.mjs` and `review-checks.log`. The non-breaking separator comes from the earlier `loom-pane7-operator-review-fix-dispatch-20261001T175851.json` record. The prior operator review remains intact.

The final save uses a new filename and verifies strict UTF-8 read-back, the 142 pre-existing protected files and Git identity/status. Only this report is added to main. No fixes, commits, pane prompts, permission approvals, settings changes or process controls were performed for this review. Writing follows the global Unslop guidance; the Library skill uses the explicitly requested local-file destination.
