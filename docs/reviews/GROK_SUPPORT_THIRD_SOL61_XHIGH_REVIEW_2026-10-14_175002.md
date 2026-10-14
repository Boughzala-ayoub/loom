# Grok support third review, 2026-10-14

What this change does: `05b0a76..ab2129b` stops a new prompt from completing a turn that received input during its Stop gate, settles held Stops during shutdown, and cancels their timers when panes are removed. The shutdown and timer findings are fixed. The completion fix remains incomplete when the real outcome report arrives late.

HEAD is `ab2129bfdc1863c551fb50a0873b661b7586e7ca`. The review covers report commit `86593dd`, fixes `ef960aa`, `308aeb6` and `b5bdbe6`, and documentation commit `ab2129b`. The worktree was clean at the start. Expected use is one person's desktop with several agent panes, queued prompts and optional Stop gates.

## Must fix

### 1. P2: A tentative Stop can still turn failure or cancellation into success

Locations: `src/main.ts:3063`, `Pane.grokReport`, and `src/main.ts:3082`, `Pane.grokSettle`.

What this is: Grok's Stop is tentative because another Stop hook can continue the turn. The new code still completes it when the next prompt starts with no later input, or when the status bar becomes idle without a recorded keyboard interrupt. Both paths know the turn is over but cannot establish how it ended.

Problem: Prompt A runs and the user queues B. A fires Stop, another hook blocks it, and the continuation hits a rate-limit error or a runtime turn limit. B starts before A's observation-only failure report arrives. Nothing was typed after the Stop, so the new condition completes A, emits a completed notice and adds its turn to `turnsSeen`. A's real failure is then ignored as a duplicate.

Both queued variants reproduce in the production-method fixture and fresh served UI contexts. Each leaves A completed with its preliminary response hash and B working. The fixture records a completed notice instead of a failed notice. The served contexts have no browser errors.

The timer has the same failure without another prompt. After a blocked Stop, a failed continuation can show an idle bar before its observation-only failure hook arrives. The half-second timer completes it first. A mouse cancellation also reproduces this: the terminal mouse write is delivered, but `wrote` updates `interruptAt` only for Esc or Ctrl+C. An idle bar then completes the cancelled turn before its delayed cancellation report. Both additional production-method and served UI checks fail. The mouse UI test enables terminal mouse reporting and verifies that an actual browser click sends mouse bytes through `pty_write` before simulating the provider's idle screen and delayed cancellation. No live provider button is exercised.

Fix: Do not use absent later input, a new start, or an idle bar alone as proof that the tentative Stop succeeded. Wait for evidence of that turn's actual outcome and preserve its turn correlation. If reports and screen cannot establish success, keep the outcome uncertain rather than emit a completed notice. A fixed waiting period does not establish the outcome of an arbitrarily delayed observer hook. Extend the regression checks to cover both completion paths and mouse cancellation, rather than only Ctrl+C.

If we skip it: Failed work appears successful in durable task history and notifications, and the real failure cannot correct it.

The installed Grok documentation supports these event orders. `C:/Users/ayoub/.grok/docs/user-guide/10-hooks.md`, near lines 488-510, says final observation hooks run off the turn and can be delayed while the session continues. A turn that fails or is cancelled after a blocked Stop reports that outcome instead. The native helper maps runtime `StopCancelled` such as `max_turns` to a failed signal. No later keyboard input is required for either failure. Near line 514, the guide also documents the pager's mouse stop gesture.

The fixer's closing summary also identified this limit. It is the remaining part of the previous finding that a new start cannot prove success, rather than a new requirement to delay every queue by a guessed interval.

## Previous findings

| Finding | Result |
| --- | --- |
| Ctrl+C during a Stop gate, next prompt, delayed cancellation | The exact sequence passes. The old turn becomes cancelled and the next remains working. The queued runtime-failure variant above still fails. |
| Held Stop or Stop returned by shutdown cannot settle after `dead` | Fixed. The permanent served checks pass for idle completion, busy unknown, cancellation returned by shutdown and interruption without a final report. |
| Removed pane continues polling a held Stop | Fixed. Disposal cancels the timer, the callback also guards `disposed`, and the permanent served cleanup check passes. |

All four original Grok reproduction checks also pass on this HEAD. Their rerun ends `GROK REVIEW FINAL FAILURES 0`.

## Reproduction evidence

Ignored scratch files under `node_modules/.cache/review`:

- `make-grok-third-repro.cjs` generates `grok-third-repro.mjs` from the current production methods and existing test fixture. It tests queued `rate_limit: 429` and `max_turns`, then idle-before-failure and terminal-mouse cancellation. All four expected-outcome assertions fail. `grok-third-repro.log` ends `GROK THIRD REVIEW FAILURES 4`.
- `make-grok-third-ui-repro.cjs` generates `grok-third-ui-repro.mjs` from the served UI reproduction. It tests the two queued cases, idle-before-failure, and terminal mouse cancellation. The queued cases fail in `grok-third-ui-repro.log`; the idle cases fail in `grok-third-ui-idle-repro.log`. `grok-third-ui-late-rate-limit.json`, `grok-third-ui-late-runtime-cancel.json`, `grok-third-ui-late-idle-failure.json` and `grok-third-ui-late-mouse-cancel.json` record premature completion and empty browser-error lists. Corresponding 375px screenshots are saved in the same directory. Set `GROK_THIRD_UI_MODES` to a comma-separated subset to run selected cases.
- `grok-third-original-repro.log` records the passing four original Grok cases.

## Validation

`npm run build` passed. The fresh production preview at `http://127.0.0.1:4213` returned HTTP 200 and served `main-CSxWkwLw.js`. All 38 frontend test files passed serially. The three permanent browser checks selected by `TASK_REVIEW=grok-gate`, `grok-close` and `grok-dispose` passed independently.

The full `scripts/ui-check.mjs` passed 1,547 rendered states at 320/375/768/1024/1280, without a retry, including overflow and visible-control assertions. The Grok approval screenshots at 320, 768 and 1280 were inspected and readable.

Logs are `grok-third-build.log`, `grok-third-unit.log`, `grok-third-grok-gate.log`, `grok-third-grok-close.log`, `grok-third-grok-dispose.log` and `grok-third-ui-check.log` in the same ignored scratch directory. All heavy checks ran serially. HEAD stayed unchanged and `git diff --check` passed. The report is the only repository change, and all reviewer jobs have stopped.

Verdict: fix 1 before shipping. Both completion paths need evidence of the outcome, not another timing cutoff.

Not checked: live Grok, the installed desktop build, or a rerun of the full task harness and Rust suite. This round changes no Rust code. The review changes no source code, user hooks, config or trust, and runs no installer.
