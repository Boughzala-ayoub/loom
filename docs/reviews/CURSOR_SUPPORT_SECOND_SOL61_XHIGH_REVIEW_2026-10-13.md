# Cursor support, second review, 2026-10-13

The review covered `a19d819..76a2dd1`, the Cursor CLI integration and the fixes for the first review. The fixes for lost hooks under parallel installs and for quoted Cursor menus above Claude's or Codex's input hold. Its checks on `76a2dd1` passed. These were the four frontend test files for agents, prompts, tasks and pane context, `cargo test --lib cursor::` (seven passed, one ignored), the helper's Cursor hook test, `npm run build`, and `scripts/ui-check.mjs` on a fresh preview at 320, 375, 768, 1024 and 1280 (1512 rendered states). None of them covers the five findings below, all P2. The review reproduced each one. The scratch fixtures are in `node_modules/.cache/review`: `cursor-second-review-repro.mjs` for findings 1, 2 and 5, `cursor-tab-repro.mjs` for finding 3 and `cursor-write-menu-repro.mjs` for finding 4.

## 1. A cancelled task completes when both of its stops land after the next turn starts

`agentReport` (`src/main.ts`, around 5050) drops every report for an older turn while a newer one runs. Turn A starts at 1000, Esc goes in at 2000, and turn B starts at 2100. A's aborted and error stops arrive at 2300, and Loom drops both, so A's task stays working. When B completes at 3000, `route` (`src/task.ts`) completes every active task that started, A included. The production-method fixture shows [working, working] after A's stops where [cancelled, working] is expected, and [completed, completed] after B's end where [cancelled, completed] is expected.

A Cursor task should be tied to the turn (generation_id) that started it, and a late report should go to that task. Duplicate stops must still count once, and the new turn must stay protected. Dropping every older report isn't enough.

## 2. Esc on an approval hides a genuine error for the rest of the turn

`Pane.wrote` (around 2985) marks the running turn as interrupted on every delivered Esc or Ctrl-C, then clears the question with `answeredCursor`. In Cursor 2026.10.01 (`7671.index.js`), Esc on a shell approval is the action "propose". It asks for feedback, and skipping the feedback rejects that one decision. The turn goes on. With the production methods, A starts at 1000, its approval shows at 3000, Esc goes in at 4000, the alert is acknowledged, and the feedback's Enter goes in at 5000. A genuine error for A at 60000 then leaves the task cancelled and the pane not waiting, where failed and waiting are expected.

`wrote` should tell an answer to a question from an interruption before it clears `cursorAsking`, and mark only the interruption. A genuine failure after approval feedback must still fail and notify. The review checked this against the installed CLI's handlers and the fixture, not against a live feedback turn.

## 3. Tab can hide the next approval

`Pane.answers` (around 2950) doesn't know Tab. Cursor maps Tab to "allowlistApprove" and Shift+Tab to "autoRunApprove". Tab on an approval therefore never reaches `answeredCursor`. `seen` clears the alert, but `cursorAsking` stays true. When a second approval replaces the first with no empty frame between them, `cursorQuestion` sees a menu again, as it did before, and returns. The second question raises no alert. The fixture shows `{answer: false, asking: true, waiting: false, busy: false}` after the second approval appears.

`answers` should take Cursor's Tab shortcut, and a test should cover the next approval appearing right away.

## 4. Write approvals merge two options

`CURSOR_KEY` (`src/prompt.ts`, around 53) allows one "or" in a key hint. Cursor's Write approval has four options:

```
Write to this file?
  → Proceed (y)
    Reject & propose changes (esc or n or p)
    Add Write(test.txt) to allowlist? (tab)
    Run Everything (shift+tab)
```

`cursorMenu` reads three. It joins the Reject row with the allowlist row, so the Overview loses the allowlist choice and shows a combined label. The regex should take any number of "or" alternatives. Tests should cover the real Write options, the highlight on each, and moving it, and keep the Claude and Codex transcript exclusions and the shell and trust menus as they are.

## 5. Esc before the first busy hook is polled reads as a failure

An Esc can go in after Cursor's prompt hook wrote its start but before Loom's 250 ms poll delivered it. `cursorTurn` and `cursorGen` are still unset, so the interruption is lost. A's Enter goes in at 1000 and Esc at 1100. Then the busy wake for gA and its start (stamped 1050) arrive, and the error stop at 1200 before the aborted one. The task ends failed and the pane waits, where cancelled and not waiting are expected. The error marks the turn ended, and the aborted that follows is dropped as its duplicate.

Loom should keep the pending interruption and tie it to the turn once that turn's first report arrives, by turn id and timestamps. Both stop orders must work, and a later genuine failure must still fail.
