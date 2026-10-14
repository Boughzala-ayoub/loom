# Grok support, fifth review

What this change does: Each pane now tracks the Grok session-log reads started by `grokOver`, and shutdown waits for them before its final task sweep and journal drain. The fourth review's lost-completion race is fixed in both reported cases.

Reviewed `bdf2935..12ca9ec`, comprising report commit `0ad29fc` and fix `12ca9ec`. The worktree was clean at the start. Expected use is one Windows desktop with several agent panes. This review changes no tracked source, tests, hooks, configuration or user sessions.

Looks good. Ship. No new correctness, safety or scope issue was found in this change.

## Previous finding

The fourth review's P2 is closed. Both the queued-start and idle-notification shutdown batches now wait while `grok_turn_end` is deferred. Releasing `end_turn` completes A with its own response, and the journal at window destruction already contains that completed event. The window no longer closes with the read outstanding. This passes in the current production-method fixture and the reviewer's original served-browser reproduction, using fresh headless contexts against `main-GgrpNWN1.js`. Both browser cases have no runtime errors.

The permanent `grok-close-read` check also passes through the real close handler. Its non-success case publishes no false completion. The unit tests additionally cover a missing log result.

Extra production-method checks confirm that two overlapping reads are both awaited even when B's reply arrives before A's. A replaced hold does not lose the first read, each turn keeps its own response, and an older launch's read completes only its own task while shutdown waits for it. The changed method's callers do not use its old return value, and the close handler still waits for the final journal writes before destroying the window.

The four third-review false-success cases remain fixed. The served `grok-late`, `grok-gate`, `grok-close` and `grok-dispose` checks pass, as do their connected production-method tests. The existing source filtering, Stop continuations, forced gate exits, successful queued turns, cancellation/failure distinction, disposal and Cursor/Claude/Codex tracking remain covered by the passing unit suite. Rust and the native log format were not changed in this round.

## Verification

- All 38 frontend unit files pass serially. Log: `node_modules/.cache/review/grok-seventh-unit.log`.
- Five focused served-browser checks pass: `grok-close-read`, `grok-late`, `grok-gate`, `grok-close` and `grok-dispose`. Logs: `node_modules/.cache/review/grok-seventh-grok-*.log`.
- Both original served shutdown reproductions pass. Log: `node_modules/.cache/review/grok-seventh-ui-repro.log`. Results: `grok-seventh-shutdown-next.json` and `grok-seventh-shutdown-idle.json`, with matching 375px screenshots.
- Extra production-method checks pass for the original cases, overlapping/out-of-order replies, replaced holds and older launches. `make-grok-seventh-repro.cjs` extracts the current production methods and fixture into `grok-seventh-repro.mjs`; `grok-seventh-repro.log` ends `GROK SEVENTH EXTRA FAILURES 0`.
- The owned preview on port 4215 returns HTTP 200 and serves `main-GgrpNWN1.js`, the bundle from the fixer's final build. No desktop application or installer was run or restarted.
- Full `scripts/ui-check.mjs` passes 1,547 rendered states at 320/375/768/1024/1280, without a retry, including overflow and visible-control checks. The fresh Grok approval screenshots at all five widths were inspected and readable. Log: `node_modules/.cache/review/grok-seventh-ui-check.log`.
- The fixer's logs separately record all 120 full task checks, the final Tauri build and all five responsive widths passing. The initial native suite had one GUI-lifetime test failure; that test and then the full suite passed on rerun, with 162 passed and six ignored. Those broader native/task/build results were inspected, not independently repeated by this reviewer.
- HEAD stayed at `12ca9ec`, and `git diff --check` passes. The report is the only repository change. All reviewer tests, browsers and the owned preview have stopped.

Verdict: Ship.

Not checked: a new live Grok turn, the installed desktop, a fresh native build, or independent reruns of the full native and task suites. This verdict covers the reviewed fix and verified browser behavior; installation remains the user's step.
