# Review of f80a83e

Reviewed commit `f80a83efd3d766ccc38a667171115a122857d135`, "Track sends and typed turns as tasks, with a notification policy", against its parent `0af066ac19967072080daac7889d76c46b09f383`. Review date: 2026-10-04, Africa/Tunis.

Five new correctness findings remain: one P1 and four P2. The earlier Loom-side fixes are present, including the two follow-up fixes. The external bridge implementation and its deployment cannot be verified from this commit.

All source references below use line numbers in `f80a83e`, not the concurrently edited working tree.

## Findings

### [P1] Prevent automatic tracking from writing an unreadable journal

Location: `src/main.ts:3867`. Related paths: `src/main.ts:4016`, `src/main.ts:4217`, `src/main.ts:3696`, and `src/main.ts:7747`.

`loadTasks` sets `journalUnreadable` and returns without loading tasks, policy history, or the event counter when the startup read fails. Only explicit `submit` checks that flag. The new `turnTask` and `recordNotify` paths still call `journal`, whose append and rewrite paths have no equivalent guard.

Failing scenario:

1. An existing journal contains completed tasks and their events. Its startup read fails temporarily.
2. A person submits a readable Codex prompt, or an ordinary agent `send` reaches Enter. Automatic tracking starts numbering from zero and attempts to append its task.
3. If that append succeeds, event numbers already present in the unseen journal are reused and can be exposed through `watch`.
4. If the append instead fails once, it marks the new task unsaved. Its next successful state write triggers a whole rewrite from the incomplete in-memory task map, erasing the previous journal's tasks, keys, events, and policy history.

The in-memory reproduction used the committed `loadTasks`, `turnTask`, `enterTurn`, and `journal`. The successful-append case replayed event numbers `[1, 1]`. The recovering-write case attempted an append, then a rewrite; the previous task disappeared and only the new task remained.

Fix: enforce the unreadable-history guard at the shared journal boundary. Do not append, publish new durable events, or compact until the existing journal has been loaded successfully. Manual terminal input can remain usable, but durable tracking and policy changes must report that history is unavailable. Add a regression covering automatic turns and policy changes after a startup read failure, including a failed append followed by a recovering write.

### [P2] Make failed notification journal writes trigger recovery

Location: `src/main.ts:4016`. Related failure handling: `src/main.ts:3715`.

Policy records call `journal` with an empty task-ID list and discard its rejection. A failed write therefore adds nothing to `unsaved`. The next successful write remains an append instead of restoring the missing policy transition through a whole rewrite.

Failing scenario:

1. A completion at sequence 2 is durable and still eligible for a queued notice.
2. Turn its pane off. The policy journal append fails once, but the in-memory policy records the mute.
3. Turn the pane back to inherit after writes recover. This policy append succeeds. No task event intervenes.
4. Restart Loom. The journal contains the re-enable record but not the intervening mute, so the old completion becomes eligible again.

The committed functions reproduced `notify: false` before replay and `notify: true` after replay. Both attempted writes were appends; the dirty-task set stayed empty after the failed mute. This differs from the earlier same-sequence replay defect: replay now preserves every line it receives, but this transition never reaches it.

Fix: mark the journal dirty after any failed write, including records with no task IDs, and force the next successful write to restore the full retained policy history. Surface policy persistence failures instead of silently acknowledging a durable change. Add a failed-mute/re-enable/restart regression.

### [P2] Apply restored-pane mutes to its historical notice IDs

Location: `src/main.ts:4005`. Related paths: `src/main.ts:1457`, `src/main.ts:2811`, and `src/main.ts:4025`.

Pane IDs are generated again on restart. Saved pane slots preserve the notification setting, but do not preserve an identity linking the restored pane to its historical tasks. `currentNotify` retains old overrides as archived IDs and adds changes only under the new live ID.

Failing scenario:

1. A pane completes a task while enabled. The v3 bridge queues its notice without sending it yet.
2. Restart Loom and restore the same pane and conversation.
3. Turn that pane's bell off, or run `notify work:1 off`.
4. The bridge checks the old completion. `notify --check` still returns true because the task names the previous pane ID, while the mute names only the restored ID.

The reproduction retained a completed task for `old-pane`, restored it as `restored-pane`, and used the committed `setPaneNotify` and `currentNotify`. The old completion remained allowed while a new completion for the restored pane was muted. The existing restart test checks preservation of decisions, not changing a restored pane's policy against its previous queue.

Fix: persist a logical pane identity for task notification ownership across restores, or persist historical-ID aliases and apply a pane's changes to those aliases too. Preserve independent settings for genuinely closed or unrelated panes. Add a completion/restart/mute/pre-send-check regression.

### [P2] Reject a known prompt-hash mismatch during manual adoption

Location: `src/task.ts:392`. Callers: `src/main.ts:3969` and `src/main.ts:3984`.

When no exact hash matches, `claimManual` falls back to any pending Enter in the time window, including one whose non-null hash names different text. The commit describes time-based Claude adoption as a fallback when the input could not be read. The implementation also uses it when the input was read and contradicts the report. Codex uses an unlimited fallback window.

Failing scenario:

1. A person submits a local slash command such as `/clear` that produces no agent turn report. Its known prompt hash remains pending.
2. Within ten seconds, send a different prompt through `send --no-enter` followed by `keys enter`, a documented untracked path. `keys` retains the earlier marker because its hash is non-null.
3. Claude reports the CLI prompt's start, or Codex reports its completion.
4. The different hash consumes the slash command's marker and fabricates a `source: manual` task for the CLI-only turn. Codex immediately completes it and can generate a finish notice.

The committed `manualEnter`, `keys`, `claimManual`, `adoptManual`, and `taskSignal` reproduced this for both providers. Neither CLI input call created a task; the unrelated report then created a manual task. Claude's task became working, and Codex's became completed.

Fix: for a report that names a prompt, allow timing fallback only for markers with unknown or explicitly unreliable matches. A known different hash must not qualify. Keep OpenCode's separate sequence rule for reports that name no prompt. Add a known-hash mismatch test and a local-command/CLI-only-turn regression.

### [P2] Correlate an ordinary send with the complete submitted draft

Location: `src/main.ts:7420`. Related guard: `src/main.ts:7379`.

Ordinary sends can append to an existing draft, but the new task hashes only `asked`, the caller's appended text. With neither `--input` nor `--replace`, the guard returns without even reading the existing draft. Claude and Codex report the complete submitted prompt, so that report cannot match the task.

Failing scenario:

1. Leave `Please fix ` in a Claude pane's composer.
2. Run `loomctl send work:1 "the test"` without `--replace`.
3. The agent receives `Please fix the test` and completes it successfully.
4. Loom's new send task instead holds the hash of `the test`. The start or end report does not claim it, and it eventually ends unknown with no finish notice.

The reproduction ran the committed `sendText`, `sendReply`, input queue, Enter hold, routing, and sweep functions with a synthetic composer. The submitted prompt hashed to `893a702d32302325`; the task held `8395ded974e32c30`. A matching start for the actual prompt left the task submitted; after Stop and the quiet timeout it became `unknown`, `reason: no-end-signal`.

Fix: derive the correlation match from the complete composer content that Enter submits, including any pre-existing draft. Keep the caller's SHA-256 and byte count as receipt metadata. Preserve ordinary send's append behavior; where the full prompt cannot be established, report that correlation limit explicitly. Add readable-draft cases for Claude and Codex.

## Verification of the earlier review rounds

References:

- [Initial review, 2026-10-03 15:52](LOOM_MANUAL_TURNS_NOTIFICATION_POLICY_SOL61_XHIGH_REVIEW_2026-10-03_155201.md).
- [Follow-up review, 2026-10-03 19:10](LOOM_MANUAL_TURNS_NOTIFICATION_POLICY_SOL61_XHIGH_FOLLOWUP_REVIEW_2026-10-03_191035.md).

| Earlier finding | Status in the commit |
| --- | --- |
| Bridge ignores notification policy | Loom's v3 metadata, pre-send check, and refusal of muted v2 batches are present at `src/main.ts:7854` and `src/main.ts:7945`. `index.html:168` now qualifies the promise with the v3 bridge and warns about an older queue. The bridge code is outside this commit, so its implementation and running version are not attested here. |
| Failed manual Enter can complete | Fixed for the reported path. `manualFailed` carries uncertainty through both immediate tasks and pending markers, and reports wait for the write outcome. Focused failed-Enter checks end unknown with `uncertain: submit`. |
| Same-number off/on/off replay loses a transition | Fixed. `src/task.ts:309` keeps every policy line and preserves equal-number order. The committed task tests passed, including this round trip. The new failed-write finding above concerns an absent line. |
| Empty OpenCode Enter captures a CLI-only turn | The original path is fixed by current-launch typing evidence and clearing nameless markers on Loom's Enter. A focused check confirmed the CLI-only run makes no task. The known-hash mismatch above is a different path. |
| Invalid notify command changes policy | Fixed. Pane and value validation precede setters at `src/main.ts:7862`. Seven invalid variants executed against the committed notify handler called no policy setter. |
| First overlapping Enter releases the second's reports | Fixed. `holdSignals` counts each Enter separately and releases each hold once. Resolving only the first held write did not complete the second task; failing the second produced unknown with submit uncertainty. |
| Typing evidence survives a launch change | Fixed. `Pane.typed` stores the generation, and `manualEnter` requires the current generation at `src/main.ts:3904`. A previous launch's draft created no marker; typing in the current launch did. |

The old v2 sender's already queued mail remains the documented deployment limit. The commit supplies the Loom boundary and migration documentation, but contains no external bridge code or evidence of which sender is running.

## Held Enter recovery and validation limits

The focused `heldTask`/`enterTask` checks passed. A delayed completion report stayed buffered while the recovery Enter was pending. A successful write completed the original task, cleared its held-Enter uncertainty, and created no second task. A failed write ended that same task unknown with `uncertain: submit`. The overlapping-hold check also passed.

Source inspection used `git show f80a83e:<path>` and `git diff 0af066a f80a83e`. The committed `src/task.test.ts` ran to `all ok`, with its import redirected to the committed task module held in memory. Focused checks extracted the actual committed functions through the installed TypeScript parser, removed type annotations using Node's native type stripping, and executed them in isolated VM contexts. Journal contents, panes, clocks, PTY writes, and provider reports were synthetic. The notification durability cases used the real journal queue and replay functions. Some task-flow fixtures supplied a minimal state-update or screen-echo implementation, so these results do not claim a served-bundle or native-provider reproduction.

No frontend or native build, browser suite, installer operation, production journal access, live pane input, bridge execution, SMTP connection, or email send was performed. No source file, index, commit, branch, or build artifact was changed by this review. The requested report is the sole file written; concurrent edits to `src/main.ts` and `src/prompt.ts` were not read or used as review inputs.
