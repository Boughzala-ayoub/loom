# Grok support, fourth review

What this change does: A tentative Grok Stop now completes a task only when Grok's session log records `end_turn` for that turn. This closes the third review's false-success finding in all four of its failing cases. The new asynchronous log lookup leaves one shutdown race.

Reviewed `ab2129b..bdf2935`, comprising the previous report commit `c24a55a` and fix `bdf2935`. Expected load is one Windows desktop with several agent panes. No tracked source, tests, hooks, configuration or user sessions were changed by this review.

## Must fix

1. **P2: Shutdown can destroy the window while a Grok success lookup is still out.** `src/main.ts:3085`, `src/main.ts:5370`, `src/main.ts:10503`.

   `grokOver` checks a held Stop when the next turn starts, an idle notification arrives, or an older launch's Stop arrives. It clears `grokStop` before awaiting `grokOutcome`. Its callers discard the returned promise. `closeTasks` then looks only for panes whose `grokStop` is still set, so it does not wait for these outstanding lookups.

   A concrete case is a shutdown batch containing Stop A and the queued turn B's start. A's session log already says `end_turn`, but its native command reply is deferred. The batch starts that lookup and clears the hold. `closeTasks` finds no hold, the journal drain sees no completion write yet, and the window is destroyed with A still recorded as working. On restart, `loadTasks` changes that unfinished record to unknown. The real success and its completed notice are lost. A Stop followed by an idle notification in the shutdown batch has the same problem, without a second task.

   Both cases fail against the served `main-NZ3eDXlW.js` through the real close handler in fresh headless browser contexts. With the native reply held for 200 ms, the window was destroyed with one lookup outstanding. Its journal recorded A as working. Releasing the reply afterward produced A's completion only in the mock window, which stays alive after its mocked destroy call. A real destroyed WebView cannot apply that later reply. Both cases had no browser runtime errors. The current production-method fixture also shows `closeTasks` resolving before that lookup returns.

   The smallest fix is to retain and await outstanding Grok outcome work before the closing sweep and final journal drain, preserving each lookup's original launch and turn. Include work started while routing shutdown's returned reports, even when its Stop has already been cleared or replaced. Add a deferred `grok_turn_end` regression that proves destruction waits and that A's completed event is in the journal at destruction. Cover the queued-start and idle-notification cases together. Do not restore success inference from an idle screen or elapsed time.

   If skipped, closing or restarting Loom during this lookup can lose a successfully finished task's completion and notice. This is a narrower bug than the previous false-success finding, but the close handler explicitly promises to save final outcomes before destroying the window.

## Earlier findings

- The third review's queued rate-limit failure, queued runtime turn limit, idle-before-failure, and mouse cancellation all pass in the current production-method tests and served-browser regressions. No premature completed event appears, and the delayed failure or cancellation reaches the correct task.
- Successful turns complete on session-log evidence. The held-Stop shutdown cases pass with `end_turn`, and end unknown without it. Changing the earlier idle-screen-only completion expectation is correct.
- Pane disposal still stops Grok's polling. Agent source filtering, blocked Stops, later Stops, forced gate exits, Ctrl+C, turn correlation and the connected Cursor cases remain covered by the passing unit suite.

## Verification

- All 38 frontend unit files pass serially. Log: `node_modules/.cache/review/grok-fifth-unit.log`.
- The focused `grok-late`, `grok-gate`, `grok-close` and `grok-dispose` served-browser checks pass. Logs: `node_modules/.cache/review/grok-fifth-grok-*.log`.
- Six native Grok-related tests pass using the fixer's existing `loom_lib-2b0adbb5d4021765.exe` test binary, including the log reader, helper event fields and native ownership check. This review did not rebuild that binary. Log: `node_modules/.cache/review/grok-fifth-native-grok.log`.
- A reviewer-owned preview on port 4214 returns HTTP 200 and serves `main-NZ3eDXlW.js`, the bundle from the fixer's final build. No application or installer was run or restarted.
- Full `scripts/ui-check.mjs` passes 1,547 rendered states at 320/375/768/1024/1280, without a retry, including overflow and visible-control checks. The fresh Grok approval screenshots at all five widths were inspected and readable. Log: `node_modules/.cache/review/grok-fifth-ui-check.log`.
- New failing reproductions: `node_modules/.cache/review/make-grok-fifth-repro.cjs`, generated `grok-fifth-repro.mjs`, and `grok-fifth-ui-repro.mjs`. Logs: `grok-fifth-repro.log` and `grok-fifth-ui-repro.log`. Browser results: `grok-fifth-shutdown-next.json` and `grok-fifth-shutdown-idle.json`, with matching 375px screenshots.
- Existing Grok 1.0.52 probe and harness logs confirm the session log shapes used by the reader. They were inspected read-only; no new live provider turn was run.
- HEAD stayed at `bdf2935`, and `git diff --check` passes. The report is the only repository change. All reviewer tests, browsers and the owned preview have stopped.

Verdict: fix 1 first. A focused final fix with these deferred-read checks is sufficient; the user need not keep repeating the whole review loop for this one lost notice.

Not checked: a live Grok turn, the installed desktop, a fresh native build, the full native suite or the full task harness. The existing build and live-harness logs were inspected, not independently repeated.
