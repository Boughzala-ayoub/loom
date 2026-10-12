# Claude agent-turn pruning review, 2026-10-12

Range reviewed: `1fdcfb0..90225c8`, the fix for the follow-up finding in `CLAUDE_AGENT_TURN_FOLLOWUP_REVIEW_2026-10-12.md`. A Codex pane reviewed it. The interruption, unread-alert and report-before-output cases pass. One finding remains.

## Finding. Once the pane's last task is pruned, a turn can take that task's start again

`agentTurn` (src/main.ts:4733) finds when the pane's last task ended by scanning the `tasks` map, and uses `Pane.workSince` only when it is later than that. `keepTasks` keeps only the last 500 tasks to finish across all panes, so another busy pane can push this pane's last task out of the map. The scan then finds nothing and returns 0, while `workSince` still holds the start of that task's output. A report that reaches Loom before any output of its turn takes that old start again.

The new check in `src/main_context.test.ts` runs the production `activity`, `wake`, `taskSignal`, `sweepTasks`, `agentTurn`, `moveTask` and `keepTasks` with `pruneSettled`. A person's task starts at 9000, its output comes at 10000 and 10500, Claude rings and reports its Stop at 11000, and the sweep completes it at 11700. The pane then stays idle with no output. 500 tasks of another pane finish later, and `keepTasks` removes the person's task, leaving 500. At 3,600,000 a failure report (`rate_limit`) makes an agent task with `startedAt` 10000. The same run without the pruning gets 3,600,000. A question reported first goes through the same code, so its later finish notice would count the idle hour.

The fix should keep the boundary on the pane, independent of the task history: when a task settles, through the path every outcome takes before pruning, clear the pane's output start. A relaunch already settles the old launch's open tasks through the sweep, which takes the same path. No journal change is needed for a runtime timestamp. Fresh-output starts, the unread alert, interruption handling, the current-launch guard, the startup and Enter-hold context, the journal and the notification policy must stay as they are.
