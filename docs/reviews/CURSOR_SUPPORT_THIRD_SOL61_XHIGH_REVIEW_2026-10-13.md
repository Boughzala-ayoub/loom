# Cursor support, third review, 2026-10-13

The review covered `76a2dd1..92a6614` on `loom/cursor`. The fixes for the second review and the guard for quoted Cursor menus pass their regression cases. Its checks on `92a6614` passed. These were all 38 frontend test files, `npm run build`, and `scripts/ui-check.mjs` on a fresh preview at 320, 375 and 768. Its first run at 1024 stopped on the group-focus refresh assertion at line 2095. An unchanged copy, `ui-third-review.mjs`, then passed 1024 and 1280 (612 rendered states), that assertion included, so the review doesn't count it as a defect of this range. The review didn't run a native or release build, or a live Cursor account. It found three P2 cases, each reproduced. `node_modules/.cache/review/cursor-third-review-repro.mjs` runs them through the production methods of `main_context.test.ts` and fails seven assertions. `cursor-third-native-poll.cjs` runs the real hook writer in isolation.

## 1. A late stop finishes the newer turn's receipt early

`agentReport` (`src/main.ts:5081`) sends an old turn's report to that turn's task, as it should. It also calls `p.wake(undefined, "hook")` for every stop that isn't an interrupt, including an old turn's completion or genuine failure while a newer turn runs. The wake marker's stale-turn guard doesn't cover that call. A starts at 1000, and B starts at 2100 with `lastIn` 2100. A's error or completed stop arrives at 2300. A's task ends and B's stays working, which is right. But B's pane goes to busy false and waiting true, `p.turns` goes to 1, and `turnReceipts` finishes B's pending receipt. With the production `finishReceipt` and `turnReceipts`, B's `receipt.result.turn` is 1 while B still works. Send-and-wait automation would move on before B ends.

Only a report for the current turn should change the pane's status and finish receipts. The old turn's report must still reach its task and send its notice. Tests should cover a late error and a late completion, with the real receipt results.

## 2. A second Esc loses the first cancellation

`cursorEsc` (`Pane.wrote`, `src/main.ts:2992`, and `agentReport`, 5078) holds one interrupted turn. A starts at 1000, Esc goes in at 2000, B starts at 2100, and Esc goes in again at 2200. A's error and aborted arrive at 2300, then B's at 2400. The second Esc replaced `gA` with `gB`, so A's error reads as a genuine failure and its aborted is dropped as the duplicate. The result is [failed, cancelled, waiting], where [cancelled, cancelled, not waiting] is expected.

Each interrupted turn should keep its interruption until its stops are handled. Both stop orders, overlapping cancellations, old stops after a new start, an Esc before the start's poll, and a genuine failure of a new turn nobody interrupted must all work.

## 3. One poll can leave a running turn marked idle

The hook writer replaces the pane's single wake marker on every hook and keeps every task report. Every 250 ms Rust sends that one marker, then the reports in order. `agentReport` starts a task on a start report, but it doesn't restore the pane's current turn or its running state when the busy marker was overwritten.

A starts at 1000 and Esc goes in at 2000. B's Enter goes in at 2100 and its start report is stamped 2150. A's delayed aborted and error reports are stamped 2200 and 2250, and one poll reads them all at 2300. Only A's `cursor:error` marker is left, and it clears `cursorTurn` and `busy` for A. The reports then start B and cancel A, but leave `cursorTurn` false, `cursorGen` `gA`, and the pane neither busy nor waiting, where `gB` and a busy pane are expected. A fresh `activity` call can't recover, because `cursorTurn` false overrides the screen's hint. The sweeps at 2400 and 32400 then end B's running task unknown, reason `no-end-signal`.

The real hook writer, run on its own, showed the same: B's start and A's aborted and error task files were all kept, 92 ms apart, and the only marker left was `cursor:error`, launch 1, turn `gA`. That run invoked the hooks directly, with no live Cursor turn.

The pane's status and turn should follow the ordered start and stop reports, so an old marker coalesced into the poll can't erase a newer start. A start and its own stop in one poll, the stale-launch guard, and the fixes for findings 1 and 2 must keep working.
