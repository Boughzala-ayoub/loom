# Claude agent-turn short-gap review, 2026-10-12

Range reviewed: `90225c8..4f421a9`, the fix for the pruning finding in `CLAUDE_AGENT_TURN_PRUNING_REVIEW_2026-10-12.md`. A Codex pane reviewed it. The pruning case and every earlier case pass. One finding remains.

## Finding. A turn that starts drawing soon after a task ends never gets a start

Since `4f421a9`, `moveTask` sets `Pane.workSince` to 0 when a task of the pane settles. `Pane.activity` sets `workSince` only when output comes 1.5 s or more after the previous output (`now - workAt >= 1500`), and every output moves `workAt`. When Claude's next turn starts drawing less than 1.5 s after the last output, and keeps drawing, that condition never holds again. `workSince` stays 0 for the whole turn, and its task starts at its Stop.

The new check in `src/main_context.test.ts` runs the production `activity`, `wake`, `taskSignal`, `moveTask` and `sweepTasks`. A person's task starts at 9000, its output comes at 10000 and 10500, Claude rings and reports its Stop at 11000, and the sweep completes it at 11700, which clears `workSince`. Claude's own turn then draws first at 11800, 1300 ms after the last output, and every 500 ms for 65 s. Its Stop at 76800 makes an agent task, and the sweep completes it at 77500. The task got `startedAt` 76800 and ran 700 ms, where 65,700 ms was expected, so its finish notice would leave out the minute it worked. The same turn drawing first at 13000, 2.5 s after the last output, gets the full 65,700 ms.

The fix should let the first output after `workSince` was cleared start a stretch, however recent the last output was. A report with no output after the task ended must still start at the report. The pruning case, the unread alert, the bell before the Stop, interruption handling, the current-launch guard, the replay context, the journal and the notification policy must stay as they are.
