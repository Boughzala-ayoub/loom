# Grok support follow-up review, 2026-10-14

What this change does: `e428017..05b0a76` scopes Grok's hooks to the pane's own process, waits for evidence that a turn ended, clears Working after prompt rejection, and restores the full always-approve caption. All four original reproductions pass. Two turn-handling failures and one timer leak remain.

The review covers the report commit `adf73a5` and fixes `4c3687a`, `5d5cde1` and `05b0a76`. HEAD is `05b0a7695c7370afe36416c4999b05a020b4626b`. The worktree was clean at the start. Expected use is one person's desktop, with several agent panes and successive prompts in a pane.

## Must fix

### 1. P2: A new prompt can complete a cancelled Stop gate

Location: `src/main.ts:3056`, `Pane.grokReport`.

What this is: Grok's Stop is tentative because another hook can continue the turn. The new code holds it, but calls `grokEnd()` immediately when a different prompt's start arrives.

Problem: A user presses Ctrl+C while the Stop gate runs and then submits another prompt. Grok's documented cancellation report can arrive after the next UserPromptSubmit. The next start completes the cancelled turn and records it in `turnsSeen`. Its delayed cancellation is then ignored. The production fixture and fresh served UI both produced `old task = completed`, `new task = working`, with the old response hash retained. The fixture also recorded a false completed notice.

The installed Grok guide explicitly allows this order in `C:/Users/ayoub/.grok/docs/user-guide/10-hooks.md`, near lines 488-510. The same assumption is unsafe for cancel-and-send, which replaces a turn without a StopCancelled report. Its send-now keys are documented in `03-keyboard-shortcuts.md`, near lines 372-390. A new turn proves the previous one is over, but does not prove it succeeded.

Fix: Do not turn a held Stop into successful completion solely because another prompt starts. Keep the previous turn correlated to its own outcome, including an interrupt already written into its gate. Preserve normal queued prompts that follow a successful turn. Add a permanent check for Stop, Ctrl+C, next start, delayed cancellation, plus the send-now replacement case.

If we skip it: Loom records cancelled work as successful and sends a completion notice that the later cancellation cannot correct.

### 2. P2: Shutdown prevents a held Stop from settling

Location: `src/main.ts:3069`, `Pane.grokSettle`; shutdown sets `dead` at `src/main.ts:10455` before the closing sweep.

What this is: `sweepTasks(true)` asks Grok to settle a held Stop against its saved terminal screen before the final journal drain.

Problem: The close handler first marks every pane dead. `grokSettle("closing")` returns immediately on `this.dead`, so it never reads the saved idle screen. Close Loom after a Stop and idle screen arrive, before the half-second timer settles them, and the journal still contains a working task. A Stop returned by native shutdown has the same problem because reports are routed after panes become dead. The production fixture and the actual served close handler both reproduced a working journal entry, with no completed event.

Fix: Let closing judge the held Stop using the saved screen even though the process is dead. Drain the resulting event before destroying the window. Preserve an honest outcome when the screen cannot confirm success, and avoid restarting a timer for a dead pane. Add a permanent served close check with a held Grok Stop and idle screen, including a Stop returned by shutdown.

If we skip it: A confirmed completion is missing from durable task history and notifications when Loom closes or relaunches during this window.

## Should fix

### 3. P3: Removing a pane leaves its Stop timer polling

Location: `src/main.ts:3073`, the new recurring timer in `Pane.grokSettle`. `Pane.dispose`, near line 2895, does not cancel `grokTimer`.

What this is: A held Stop polls the status bar every 250 milliseconds until it can settle the turn.

Problem: Close a Grok pane while its Stop gate is still working. Disposal removes its event listeners and terminal, but neither cancels this timer nor marks the pane dead. `grokSettle` checks `dead`, not `disposed`. It keeps reading the discarded terminal's last working screen and scheduling itself. In a fresh served UI context, the task correctly became cancelled, but four more Grok polling callbacks ran during the next 1.2 seconds, after removal. No browser errors occurred.

Fix: Cancel the new timer in the existing pane disposal path and prevent a disposed pane from rearming it. Add a cleanup check that removes a pane with a held Stop and verifies polling ends. This does not require another timer abstraction.

If we skip it: Each pane removed during a Stop gate retains its terminal and continues doing work every quarter second until the page goes away.

## Original findings

| Original case | Result on this HEAD |
| --- | --- |
| Grok child in another agent's pane completes its parent and changes its session marker | Passes. The native process-chain check also permits the root Grok and rejects foreign and nested Grok processes. |
| Blocking Stop gate completes a turn that keeps running | Passes. The working status bar keeps the Stop provisional. Finding 1 above covers cancellation followed by another prompt. |
| Rejected UserPromptSubmit stays Working forever | Passes. The pane becomes idle and a missing end report settles unknown rather than completed. |
| Narrow always-approve label hides global scope | Passes. The 34-column reproduction retains the complete caption and native option mapping. |

## Reproduction evidence

Ignored scratch files under `node_modules/.cache/review`:

- `make-grok-second-repro.cjs` generates `grok-second-repro.mjs` from the existing test fixture and current production methods. The closing case uses the actual close sequence, setting `dead` before `sweepTasks(true)`. The cancellation case writes Ctrl+C through `sending` and `wrote`, starts the next task, then delivers the old turn's cancellation. Both intended-outcome assertions fail. `grok-second-repro.log` ends with `GROK SECOND REVIEW FAILURES 2`.
- `grok-second-ui-repro.mjs` tests the fresh production preview using the official UI harness mocks and separate headless browser contexts at 375px. It drives the actual close-request handler for the first case and terminal keyboard input for the second. `grok-second-ui-close.json` and `grok-second-ui-cancel-next.json` record the wrong states and empty browser-error lists. Both intended-outcome assertions fail in `grok-second-ui-repro.log`. Screenshots are `grok-second-close-375.png` and `grok-second-cancel-next-375.png`.
- `make-grok-second-dispose-probe.cjs` generates `grok-second-dispose-probe.mjs` from that served UI reproduction. It counts the production `grokSettle` timer callbacks, closes the pane through the CLI handler, then checks cleanup. `grok-second-dispose-probe.log` and `grok-second-ui-dispose.json` record a cancelled task, four callbacks after removal and no browser errors. The assertion that a disposed pane stops polling fails.
- `grok-second-baseline-repro.log` reruns all four original intended-outcome checks against the fixes. It ends with `GROK REVIEW FINAL FAILURES 0`.

## Validation

`npm run build` passed. All 38 frontend test files passed serially. All 115 browser task checks in `scripts/task-check.mjs` passed, along with its browser-free checks and native Grok owner check. The latter used the fixer's built release helper and isolated test-owned process chains and session files.

The fresh production preview at `http://127.0.0.1:4212` returned HTTP 200 and served `main-Ch2mF3ha.js`. An unchanged full rerun of `scripts/ui-check.mjs` passed 1,547 rendered states at 320/375/768/1024/1280, including overflow and visible-control assertions. The Grok approval screenshots at 320, 768 and 1280 were inspected and readable.

The first UI run stopped at a terminal-fit assertion in legacy session recovery at 320px. That view passed after a one-second settle in three fresh 320px contexts and at each other required width, then the full unchanged rerun passed. This intermittent fit assertion is recorded as a validation limitation, not attributed to the Grok changes. Evidence is in `grok-second-ui-check.log`, `grok-second-legacy-probe.log` and `grok-second-ui-check-retry.log`.

Build, unit and task logs are `grok-second-build.log`, `grok-second-unit.log` and `grok-second-task-check.log` in the same ignored scratch directory. All heavy checks ran serially.

Verdict: fix 1 and 2 before shipping. Fix 3 in the same pass; it is a small cleanup in the code this change adds.

Not checked: live Grok or the installed desktop build. The reproductions use production frontend code with mocked native IPC. The review changes no source code, user hooks, provider config or trust settings, and runs no installer.
