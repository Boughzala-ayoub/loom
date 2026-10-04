# Review of fixes through a414496

Reviewed `08960a2..a414496` on main, ending at `a414496421a267ffa8ae9972fb53485f4bec876a`. Review date: 2026-10-04, Africa/Tunis. All source locations below refer to the committed files at `a414496`.

Three P2 findings remain. The unreadable-journal, manual-adoption, and complete-draft findings are closed. The failed-policy-write fix closes the original replay scenario, but a concurrent request can still acknowledge an unsaved policy. Restored-pane muting works for saved slots with the new aliases and leaves the original failure open for older slots. The delayed-paste and hidden-Codex-status fixes passed focused checks.

The reference report is [Review of f80a83e](LOOM_LAST_CHANGES_SOL61_XHIGH_REVIEW_2026-10-04_013921.md).

## Findings

### R1. [P2] Migrate historical notice ownership for saved panes without notifyIds

Location: `src/main.ts:2559`. Related locations: `src/main.ts:1514`, `src/main.ts:2825`, and `src/main.ts:4036`.

This is the remaining case of earlier finding 3, rather than a new regression.

A restored pane imports historical owners only when its saved slot already contains `notifyIds`. Slots written before `25b252d` have no such field. Those panes keep only their newly generated runtime ID. `currentNotify` therefore treats their old task owners as archived, unrelated owners and does not apply the restored pane's mute to them.

Failing scenario:

1. Under the earlier version, a pane completes a task while enabled. Its finish notice remains queued.
2. Upgrade to this commit and restart Loom using that version's saved pane slot, which has no `notifyIds`.
3. Restore the same conversation and run `notify work:1 off`.
4. Check the queued completion with `notify --check`. Its historical owner remains allowed, although the live pane reports its bell as off.

The focused check used the committed restore initialization, `setPaneNotify`, `currentNotify`, and `notifies`. A slot containing the historical ID produced `false` for the old completion. The legacy slot produced `true`. Saving that legacy restore now records only the new ID, so subsequent saves alone cannot recover the missing association.

The commit message explicitly preserves archived decisions for older slots. That avoids guessing ownership from a reusable pane reference, but does not close the original failure for existing workspaces. The new restore regression starts with a slot saved under the fixed code, so it does not exercise this migration.

Fix: add an explicit migration for owners that cannot be linked to a saved pane. If ownership cannot be established safely, hold those historical notices until an explicit policy or ownership decision is supplied, and expose the unresolved owners in notification output. Preserve independent ownership for closed panes. Do not infer identity from `work:1` alone or silently treat a live pane mute as covering its old queue.

### R2. [P2] Await an outstanding policy write before acknowledging the same setting

Location: `src/main.ts:4047`. Related locations: `src/main.ts:4048`, `src/main.ts:4050`, `src/main.ts:4061`, and `src/main.ts:8241`.

`recordNotify` pushes the new snapshot into `notifyHistory` before awaiting its journal write. An identical request arriving during that write sees `same === true`. Until the write actually fails, `journalDirty` is still false, so the identical request returns successfully without waiting for persistence. Independent unkeyed CLI requests can overlap through `installCli`.

Failing scenario:

1. A durable completion is still eligible for its notice, and the durable policy is on.
2. Request `notify --all off`. Its journal write is pending.
3. Issue the same command from another client before the first write settles. The second command reports success immediately.
4. The first write fails. The journal still contains the permissive policy.
5. If Loom exits before the debounced workspace save runs, restart loses the mute despite the second command's successful reply. The old completion can be sent.

The focused check held the actual journal invocation pending. The second setter resolved while the first was unresolved, with exactly one journal write attempted. Rejecting that write left the replayed policy on and the old completion allowed.

This is a remaining durability variant of earlier finding 2. Its original failed-mute/re-enable/restart sequence now recovers correctly once the first failure has been observed. The race occurs before `journalDirty` can record that failure.

Fix: retain the uncaught persistence promise for the current policy version. An equal-value request must await that promise and propagate its failure, or await a successful recovery rewrite before acknowledging. Waiting only for `journalQueue` is insufficient because that queue deliberately catches write failures.

### R3. [P2] Apply a combined global and pane policy before awaiting its write

Location: `src/main.ts:7938`. Related locations: `src/main.ts:7941` and `src/task.ts:366`.

The notify handler now awaits the global setter before applying the pane setter. This exposes an intermediate policy while the journal write is pending. A notice forbidden during that interval stays forbidden because `notifies` checks every subsequent policy, even after the final pane override allows it.

Failing scenario:

1. `work:1` inherits the enabled global policy and has a task running.
2. Run `notify work:1 on --all off`. The intended result enables this pane and disables inheriting panes.
3. While the first policy write is pending, the task completes. The global policy is already off, but this pane still inherits it.
4. The write succeeds and the handler finally sets the pane to on.
5. The new completion remains permanently muted, including after journal replay, despite the final policy allowing this pane's finish notices.

The focused check executed the actual committed CLI handler and journal queue. Its completion at sequence 4 returned `false` from `notifies`, both before and after replay, while `allows(currentNotify(), pane, "finish")` returned `true`. Running the same interleaving against `08960a2` returned `true` for the completion because both settings were applied synchronously before any intervening task event.

This is a regression introduced by awaiting the two setters separately. The loss concerns a completion created during the new await interval, not the older issue of applying successive policy snapshots to already queued events.

Fix: validate the entire command, then apply its global and pane fields together in one synchronous update. Record one complete policy snapshot before awaiting its persistence. Do not expose or journal a temporary global-only policy for a command that also specifies a pane override.

## Status of the five earlier findings

| Earlier finding | Verdict and original scenario |
| --- | --- |
| 1. Automatic tracking writes an unreadable journal | Closed. The shared guard at `src/main.ts:3718` rejects every journal path before invoking a write. After a synthetic startup read failure, automatic acceptance and submission attempted no writes, preserved the existing bytes, left `writtenSeq` at zero, and marked the provisional task unsaved. Policy changes also refused before mutation. Thus neither the successful duplicate-number append nor the recovering destructive rewrite can occur in the reported scenario. |
| 2. Failed policy writes lose the mute after replay | Original scenario closed; concurrency remains open as R2. Any write failure sets `journalDirty` at `src/main.ts:3746`. The next write makes a whole snapshot, including retained policy transitions. The exact sequence-2 completion, failed pane-off write, inherit change, and replay kept the old completion muted. A same-value retry after an observed failure also rewrote successfully. |
| 3. Restored pane mute misses its old notice IDs | Partially closed. `src/main.ts:2559` restores aliases and `src/main.ts:4037` applies a pane override to every alias. The completion/restart/mute check passes when the saved slot contains the historical ID. It still fails for the slot format from the reviewed version, as R1 demonstrates. |
| 4. Manual adoption accepts a known different hash | Closed. `src/task.ts:392` permits named-report timing fallback only for unknown markers. The original known `/clear` marker followed by a different `send --no-enter`, `keys enter`, and provider report created no manual task for either Claude or Codex. OpenCode's nameless sequence rule remains separate. |
| 5. Ordinary send matches only the appended text | Closed. The ordinary-send guard now reads the initial composer at `src/main.ts:7428`, and `src/main.ts:7477` hashes the readable complete draft immediately before Enter. With `Please fix ` already present and `send work:1 "the test"`, both providers tracked `893a702d32302325`, the hash of `Please fix the test`, and completed the task. Caller digest and byte metadata still describe the requested appended text. If the complete composer cannot be established, the task gets an empty correlation match and an explicit warning instead of the caller-only hash. |

## The two loomctl fixes

`9c8573a` closes the reported late-draw case. The loop at `src/main.ts:3600` checks fresh echo evidence repeatedly for up to five seconds rather than treating the first quiet interval as proof that the paste failed. The committed `Pane.settle` waits from each call's start, so the retry loop yields to rendering and timers.

With a 600 ms delayed draw, both Claude's visible text and Codex's collapsed-paste placeholder produced exactly one Enter after the draw. A competing input at 350 ms produced no Enter. A paste that never appeared also produced no Enter and returned the bounded failure. The input-sequence and launch checks still precede submission.

Held Enter recovery also passed its focused cases. A completion received during the recovery write remained held. Success completed the original task with its uncertainty cleared and no duplicate task. A failed Enter write ended that same task unknown with `uncertain: submit`. The `a414496` test change correctly allows a delivered Enter's task to advance from submitted to working while still checking the submitted event and cleared held-Enter uncertainty.

`04fea96` closes the reported hidden-status-row case. Launch arguments request the run state at `src/agent.ts:31`. The title callback stores it at `src/main.ts:1758`; both pane activity at `src/main.ts:2052` and task sweeping at `src/main.ts:4211` consult it. A new launch clears it at `src/main.ts:1901`.

With an empty screen, each of Working, Thinking, and Waiting kept the pane and task working across a 31-second quiet interval. Ready cleared pane busy, and a matching provider end completed the task. Title state does not itself name or complete a task, so prompt-based completion remains required.

The `fc28599` fixture change targets the submitted event instead of rejecting snapshots merely because they contain a submitted task. Neither test-only commit changes production task behavior. No additional confirmed held-Enter, task-routing, or Codex-title defect was found.

## Validation and preservation

Source inspection used `git log 08960a2..a414496`, the committed diff, and `git show a414496:<path>`. The committed agent tests passed all 48 checks, and the committed task tests passed all 137 checks.

Focused checks extracted committed functions with the installed TypeScript parser and removed type annotations using Node's native type stripping. They executed in isolated, in-memory contexts. Policy cases used the real journal queue, snapshot, and replay logic with synthetic disk contents and delayed or failed write promises. Pane state, terminal output, clocks, and provider reports were synthetic. Some task-flow fixtures supplied minimal state-update or screen implementations. These results do not claim a native-provider or served-bundle reproduction.

The bundle-dependent `scripts/task-check.mjs` suite was inspected but not executed. No build, live pane input, production journal access, bridge execution, email send, staging, or commit was performed. The external sender is outside this commit range.

The requested report is the sole file written. HEAD, the Git index, and all 152 tracked working files were checked against the initial snapshot and remained unchanged, including the pre-existing Cargo.toml modification.

