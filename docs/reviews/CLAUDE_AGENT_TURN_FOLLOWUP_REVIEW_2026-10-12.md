# Claude agent-turn follow-up review, 2026-10-12

Range reviewed: `b2dabbf..1fdcfb0`, the fixes for the two findings in `CLAUDE_AGENT_TURN_REVIEW_2026-10-12.md`. A Codex pane reviewed it. The interruption fix and the unread-alert regression pass, as do `src/main_context.test.ts`, `src/task.test.ts`, `src/task_event_gate.test.ts`, `src/main_cli.test.ts` and `tsc --noEmit`. One finding remains.

## Finding. A turn's first report can still take the start of a turn that already ended

`agentTurn` (src/main.ts:4730) starts the task at `p.workSince` whenever that is positive and no later than the report. `workSince` keeps the start of the latest stretch of output until new output begins another. Nothing ties it to the turn being reported. When a turn's first report reaches Loom before any output of that turn, the stretch it finds is the previous turn's.

Reports and terminal output reach Loom separately, the reports through Claude's hooks and the output through the PTY, so neither is guaranteed to arrive first. The fallback to the report's own time covered only a pane that had never drawn anything, or a stretch newer than the report.

The new check in `src/main_context.test.ts` runs the production `activity`, `wake`, `taskSignal`, `agentTurn` and `sweepTasks`. A person's task works through output at 10000 and 10500, Claude rings at 11000 and reports its Stop, and the sweep completes the task at 11700 with Claude idle at a readable input. No output follows. A failure report (`rate_limit`) then arrives at 3,600,000. The new agent task ends `failed` with `startedAt` 10000, before the previous task's `endedAt` of 11700. A question reported first gets the same start, and a finish notice later in that turn would count the idle hour as working time. Both cases got 10000 where 3,600,000 was expected.

The fix should use the stretch only when it began after the pane's previous task ended. Otherwise the task starts at the report. The unread-alert case, the bell-before-Stop case, the interruption handling, the current-launch guard, the replay context, the journal and the notification policy must stay as they are.
