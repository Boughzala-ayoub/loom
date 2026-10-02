# Review of Loom CLI task tracking

Saved 2026-10-02T00:57:26.948Z UTC.

## Findings

### [P1] Persist the task before sending text or acknowledging a keyed submit - src/main.ts:3596

`taskTyping` queues the accepted record, but neither the paste nor the successful `submit` reply waits for that write. `journal` also swallows every write error. A process crash after Enter but before the queued write loses the task and its key, so the documented retry can send the prompt again. In the built frontend, I held `task_journal_write` unresolved. Submit returned success and the fake agent received the prompt while the journal was empty. After reload, the identical request and key returned a different task id and entered the prompt a second time. Rejecting every journal write also returned successful submit. Persist a recoverable task/key reservation before the side effect, propagate storage failures, and retain uncertainty if a later write fails. Any added wait must precede a fresh synchronous input/generation/counter guard, so it does not reopen the earlier concurrent-writer gap.

Evidence: `review-task-browser.json`, cases `undurable acceptance duplicates a keyed submit after reload` and `journal failure still returns successful submit`. The former recorded two entered prompts and `secondReplayed: false`. This simulates the crash boundary with Tauri mocks; it does not claim a native process-crash test.

### [P1] Bind provider events to the launch that produced them - src/main.ts:7923

The event listener resolves a stable pane id to the pane's current launch. `taskSignal` then selects tasks using that current generation, rather than the event's originating generation. Neither helper reports nor plugin reports carry a launch token. An async Stop from a previous process can therefore complete a new task on the same pane. The built frontend reproduced an old task on generation 1, a restart, and a new prompt-correlated task on generation 3. Delivering the old Stop changed the new task from `working` to final `completed`, even with its event timestamp earlier than the new submission. Carry a per-launch identity through process environment, event files and parsing, and reject a mismatched identity before routing. Draining once at exit cannot exclude an async helper that writes afterward.

Evidence: `review-task-browser.json`, `old launch Stop completes a new launch task`. Supporting code is `src/main.ts:3638`, `src-tauri/src/helper.rs:200`, and `src-tauri/src/loom-opencode.js:40`. The test injected the provider envelope at the production frontend listener; it did not launch or restart a real pane.

### [P1] Match Codex completion occurrences without completing every repeated prompt - src/task.ts:127

The Codex end branch treats `matches` as a set and completes every open task whose prompt hash appears. Two distinct submissions with the same text therefore both become `completed` when one reported turn contains that text once. There is no occurrence count, submission-time boundary or consumed turn identity. The Rust helper also discards `thread-id` and `turn-id`, and emits task events before its existing root-thread validation. I submitted the same text twice with different keys, delivered one hash occurrence, and observed both tasks complete. Distinct prompts such as `edit foo bar` and `edit foobar` also share the hash because it deletes separators. Preserve provider thread/turn identity, reject unrelated roots and replayed turns, and avoid a definitive completion when repeated or normalized text leaves ownership ambiguous.

Evidence: `review-task-browser.json`, `one Codex input occurrence completes two distinct tasks`; `review-prompt-collision.json`; isolated Rust check `reviewer::codex_turn_and_thread_identity_are_discarded`. The latter confirmed different thread and turn ids produce identical events. Codex documents both identity fields in its [notification payload](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications). Supporting conversion is `src-tauri/src/helper.rs:94` and `src-tauri/src/helper.rs:118`.

### [P1] Confirm Claude actually stopped before completing a task - src-tauri/src/helper.rs:151

Every Claude Stop hook becomes an unconditional end event, and `route` makes every prompt-correlated working task final. Loom's settings are additive, so the user's own Stop hook can block that stop and tell Claude to continue. Loom still reports `completed` at that intermediate Stop, and subsequent work or failure cannot change the final task. This breaks the stated meaning that the turn carrying the task ended. Claude's [Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control) permits that continuation. Use evidence of an accepted end, or explicitly retain an uncertain outcome for configurations where the hook cannot prove it. Checking only `stop_hook_active` does not resolve the first blocked Stop, whose value can still be false.

Evidence: source trace through `src/task.ts:129` and `src/main.ts:3611`, plus isolated Rust check `reviewer::blocked_stop_has_the_same_completion_payload`, which confirmed that the helper drops continuation and session context. The continued-agent behavior follows the provider's documented contract. I did not run a real Claude session with a blocking hook, so this finding combines executable conversion/routing evidence with that contract.

### [P2] Preserve Claude lifecycle order across asynchronous helpers - src-tauri/src/claude-hooks.json:24

UserPromptSubmit and Stop run in separate background processes. `task_event` timestamps when each helper writes, so filename sorting preserves write order rather than the order Claude fired the hooks. If Stop writes first, the task still has no prompt correlation and the router discards its end. The later start leaves an already completed turn `working`, then `unknown` after the quiet interval. The built frontend reproduced `end`, then the matching `start`, followed by `unknown` with `no-end-signal`. Serialize or identify lifecycle events so an end can be reconciled with a late start. The new drain test only proves ordering of filenames whose timestamps were already supplied in the desired order.

Evidence: `review-task-browser-extra.json`. Supporting code is `src-tauri/src/helper.rs:201` and `src/task.ts:129`. Claude's [async hook contract](https://code.claude.com/docs/en/hooks#how-async-hooks-execute) allows execution to continue while a hook runs. The frontend test injected the reversed delivery and advanced its clock; it did not measure real hook scheduling frequency.

### [P2] Persist the prune watermark across journal rewrites - src/task.ts:212

The journal records the high sequence counter and retained tasks, but omits `taskPruned`. Once the startup rewrite removes older settled tasks, the next restart initializes that watermark to zero and cannot reconstruct it from the remaining 500 tasks. A watcher then receives `gap: false` despite missing events, which hides loss from a controller resuming an old cursor. I seeded 501 completed tasks with sequences 1 through 1002. The first load pruned sequences 1 and 2 and returned `gap: true`. After the rewrite and another reload, `watch --after 0` returned `gap: false` with its first event still at sequence 3. Persist and restore the highest discarded sequence together with the counter.

Evidence: `review-task-browser.json`, `lost prune watermark hides a watch replay gap after reload`. Supporting code is `src/main.ts:3577`, `src/main.ts:3632`, `src/main.ts:3714`, and `src/main.ts:7325`.

### [P2] Change approval state only after a delivered answer - src/main.ts:3424

`keys` calls `Pane.typed` before invoking the PTY write, and `typed` treats every input as an approval answer. If Enter is rejected by `pty_write`, the CLI reports failure but the task has already moved to `working` with an `answered` event. A controller using `wait --task` loses the approval it still needs to handle. The same unconditional transition also treats navigation as an answer. I reproduced a prompt-correlated task in `approval`, rejected the Enter write, and observed `keys` fail while the task became `working`. Keep the counter increment before the write for concurrent-writer protection, but commit the lifecycle transition only on sufficient delivery/answer evidence. A failed write with ambiguous delivery must preserve that ambiguity.

Evidence: `review-task-browser.json`, `failed approval answer clears approval before the write`. Supporting code is `src/main.ts:2327` and `src/task.ts:140`.

### [P2] Keep OpenCode tasks asking while another approval remains pending - src-tauri/src/loom-opencode.js:90

The plugin's pending set correctly leaves the pane marker `waiting` until all questions are answered, but it emits `resume` after every individual reply. The task router clears approval on the first reply, so the task and pane disagree while another permission is unanswered. The second approval event already arrived while the task was in `approval`, so it does not restore the state. I exercised the actual plugin with a child permission and a root permission. Answering only the child left `opencode:waiting`, emitted `resume`, and moved the task to `working`. Emit resume when the pending set empties, or route approval identities individually. The existing plugin test currently expects both resume reports and therefore approves this defect.

Evidence: `review-plugin-pending.json`, using the real V1 plugin entrypoint and mocked session lookup. V2 shares this `loomPane` code. Supporting assertion is `scripts/opencode-plugin-check.mjs:74` and routing is `src/task.ts:140`.

### [P2] Keep follow-mode failures parseable as JSON lines - src-tauri/src/bin/loomctl.rs:351

`watch --follow --json` prints compact event records, then sends timeout and fatal failures through the existing pretty-printed `fail` function. A normal follow timeout therefore adds several invalid JSON lines to the same stdout stream. The documented PowerShell pipeline, which parses each line with `ConvertFrom-Json`, breaks at stream termination. Against an isolated fake named pipe, the exact compiled CLI printed one valid event followed by a nine-line timeout object, with eight lines that failed individual JSON parsing. A fatal unavailable-task error was multiline too. Use a compact failure record in follow mode, with a distinguishable error shape and consistent cursor type, while preserving the existing non-stream command output format.

Evidence: `review-follow.json`, timeout and fatal cases. Supporting print implementation is `src-tauri/src/bin/loomctl.rs:162`, and the other new call is `src-tauri/src/bin/loomctl.rs:390`. No running Loom pipe was contacted.

## Assessment

I would fix the four P1 findings before using this branch as an Ash task controller. The ordinary lifecycle works in the supplied tests, and the earlier send protections still pass. The remaining problems concern whether a task really owns an outcome, whether retry evidence survives a crash, and whether a watcher can detect missing history.

This review covers every tracked change and all new implementation files in `C:\Users\ayoub\loom\loom\cli-task-tracking`, branch `loom/cli-task-tracking`, against base and HEAD `1858588a4501bc80bd3ea4e1cd3865a15d556026`. The initial capture finished at `2026-10-02T00:26:49.053Z`. There were 11 modified tracked files and four new implementation files. The pre-existing untracked pane-control review was retained as a reference. Nothing was staged.

The scope includes guarded submit, pane/generation identity, receipt/text correlation, retry ambiguity, lifecycle states, wait/watch timeouts, replay and reconnect, persistence, JSON, latency, compatibility, and provider limitations. External wake transport is explicitly deferred and is not a finding.

The requested reviewer profile was Sol6.1 Extra High, separate from the Luna command controller. I followed the delegated report-only scope, the applicable global `AGENTS.md`, the review-agent skill and its defect criteria, Ponytail's minimal implementation guidance, and Unslop's prose audit. No repository-local `AGENTS.md` or `.agents` instruction tree was present.

## Verification

All tests ran from a hash-verified copy in:

`C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-task-review-20261002T002646Z`

The copied dependencies and an already installed Playwright module were used. No package or tool was installed.

| Check | Result and practical limit |
| --- | --- |
| CLI helpers | 64 checks passed |
| Prompt/input helpers | 53 checks passed |
| Git parsing helpers | 46 checks passed |
| Task routing/journal helpers | 49 checks passed |
| TypeScript | `tsc --noEmit` passed |
| Production bundle | Vite build passed, 34 modules; existing chunk-size advisory |
| Existing browser task script | All 12 scenarios passed, including the actual 30-second idle case; reported mocked submit round trip was 191 ms |
| Existing UI/guard script | 171 rendered states passed at 1280 px, plus the 80-run pre-paste writer sweep, with 10 pre-paste refusals and 70 held Enters |
| Existing OpenCode plugin script | Both entrypoints passed with fake sessions and their own temporary markers |
| Isolated Rust CLI/pipe tests | 10 passed, compiling the actual `loomctl.rs` with existing serde_json artifacts and release-style debug assertions |
| Isolated Rust provider tests | The three new helper payload/hash tests passed; two reviewer conversion checks passed. A compile-only root-lookup stub was necessary; root-rollout tests were not run |
| Isolated Rust event drain | The exact new drain function and its existing test compiled and passed, with normalized source line endings |
| Independent frontend cases | Seven reproduced cases, logged in `review-task-browser.json` and `review-task-browser-extra.json` |
| Independent plugin case | One reproduced outstanding-approval case, logged in `review-plugin-pending.json` |
| Exact CLI against fake pipes | Cursor requests 0, 1, 1 after a dropped connection printed events 1 and 2 exactly once and exited 0 in 1257 ms. Timeout exited 3; fatal error exited 1. Both error formatting issues were reproduced |

The existing guard checks covered U+00A0 input detection, retained receipts after failed Enter, suggestion/draft refusal, input revision checks, queued and interleaved writers, unrelated turns after a failed Enter, and worktree deletion plans requiring explicit ignored-file discard. I found no new regression in those covered paths. The earlier receipt documentation still says a later turn does not prove uncertain Enter delivery.

## Limits

I did not run full `cargo test`, build/package the Tauri application, run installer checks, or run `scripts/task-live-check.mjs`. The latter creates a real Loom profile and can launch a real Claude session. I did not invoke live agents, manipulate user panes, or contact a running Loom control pipe. Rust tests and fake-pipe checks do not verify native PTY delivery, WebView shutdown or provider scheduling under real load.

The provider lifecycle claims above distinguish actual conversion/routing results from documented-contract inferences. No new native provider latency measurements were made. The 191 ms mocked submit figure describes this test setup and cannot establish a production improvement over three CLI calls.

The documented unreadable-input behavior remains an explicit limitation: submit appends and reports `input: "unknown"` for inputs it cannot read. This is not proof that those inputs have no draft. Shell tasks with uncertain Enter rely on their token's OSC marks; their sweep does not apply the agent's 30-second quiet rule. OpenCode's sequence correlation remains weaker than named prompt or token correlation. These limits should remain visible to an Ash controller.

## Preservation

Before saving, all 136 pre-existing non-ignored files matched their captured SHA-256 hashes, including all 10 prior review reports and the four new implementation files. All 13 captured Git metadata files matched, covering worktree HEAD/index/pointers and common HEAD/config/packed refs/refs. Branch, status, working diff against the base and staged diff were unchanged. The staged diff remained empty.

The final save uses exclusive creation of a fresh timestamped UTF-8 Markdown file. The post-save verifier checks strict UTF-8 decoding, absence of a BOM, exact readback, the report's SHA-256, every prior file and Git metadata hash, and that this report is the only new worktree file. Its evidence is `report-verification.json`; the pre-save result is `pre-save-verification.json`.

All build outputs, reviewer scripts, fake-pipe executables and screenshots stayed in the isolated review copy. Only the requested report is added to the reviewed worktree. No source fixes, commits, merges, trust/security changes, installs or notification implementation were made. Git's sandbox warning about the global ignore file was handled by explicit Git directory/worktree arguments and preservation checks, without changing trust settings.
