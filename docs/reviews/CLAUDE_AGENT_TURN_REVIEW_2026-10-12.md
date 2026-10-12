# Claude agent-turn review, 2026-10-12

Commit reviewed: `b2dabbf5e3f9431e2c5fe04c130a5cfc2351dfa4`, "Notify when Claude finishes a turn it began by itself". It adds `agentTurn` to `src/main.ts` and the task source `agent` to `src/task.ts`. A Codex pane reviewed it and sent the two findings below. Both reproduce on that commit. The regression checks in `src/main_context.test.ts` that come with the fixes failed on it as shown here, running the production `taskSignal`, `agentTurn`, `route`, `moveTask` and `sweepTasks`, and Pane's own `busy` accessor, `wake` and `activity`.

Before the fixes, `node --test src/main_context.test.ts src/task.test.ts src/task_event_gate.test.ts src/main_cli.test.ts` and `tsc --noEmit` passed. The commit's own agent-turn tests stub the sweep, so they could not catch finding 1.

## Finding 1. An interrupted turn Claude began by itself notifies as finished

`agentTurn` (src/main.ts:4720) makes a `working` task with correlation `sequence` and leaves `submittedAt` null, because no Enter began the turn. `sweepTasks` judges Esc and Ctrl-C at src/main.ts:4970 with `esc > (t.submittedAt ?? Infinity)`. That is never true for an agent task, so the sweep never sees one interrupted.

Claude runs no Stop hook for a turn Esc or Ctrl-C interrupts, which leaves an earlier Stop to decide the task. Take a turn Claude began by itself. Its first Stop comes at 1000 and makes the task. Another Stop hook sends Claude on, so the screen shows it working. Ctrl-C goes in at 2000, and at 4500 the screen shows Claude idle at a readable input. The sweep then completes the task on the old Stop, and `pushNotice` sends a finished notice for a turn the person stopped. The check got `[agent, completed, null]` where `[agent, cancelled, interrupted]` was expected. The same sequence on a manual task, whose Enter Loom recorded, ends `cancelled` with reason `interrupted`.

A task made at a permission request has no Stop to fall back on. Answered and then interrupted, it stayed `working` in the check, and in the app the 30-second quiet rule would end it `unknown` where a person's task ends `cancelled`.

The fix gives an agent task a start to judge Esc against without inventing an Enter: its `startedAt`. An Esc or Ctrl-C from before the report that made the task can't have ended the turn, since Claude reported on after it. The sweep must not judge that one either, or a Ctrl-C that only cleared a draft during the turn would cancel the task Loom made when Claude then asked a question.

## Finding 2. A turn Claude begins under an unread alert takes the previous turn's start

`agentTurn` (src/main.ts:4722) starts the task at `p.busySince` whenever that is positive and no later than the report. Only the `busy` setter (src/main.ts:1870) moves `busySince`, when busy turns on. `Pane.activity` (src/main.ts:2491) returns while `waiting` is true, before it sets busy. So while the previous turn's alert is unread, fresh output never moves `busySince`.

In the check, the previous turn's work begins at 10000, and its bell at 11000 leaves `waiting` true and `busy` false. Claude's own turn draws from 3,600,000 and reports its Stop at 3,610,000. The agent task got `startedAt` 10000, so its notice would say 60 minutes for a ten-second turn.

The fix records when a stretch of output begins whether or not an alert is unread, and starts the agent task there, or at the report when no such start comes before it. The unread alert behaves as before: the pane still shows waiting, not working. Only `agentTurn` reads the new time, so manual, submit, Codex and OpenCode tasks don't change.

## What the fixes keep

The current-launch guard, the startup read and Enter-hold replays with the context they captured, the notification policy, journal durability, and the task sources that `loomctl watch --metadata --policy` (v3) and `--policy-v4` print all stay as they are. The email bridge that reads v3 is untouched.
