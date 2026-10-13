# Cursor support review, 2026-10-13

The review covered the uncommitted Cursor CLI integration on `loom/cursor`, on top of `7123ae0`. Its baseline checks passed. These were `npm run build`, 38 frontend test files, 154 Rust tests with 6 ignored, the real-install Cursor direct-launch test, `scripts/ui-check.mjs` at five widths (1512 rendered states), and `scripts/remote-ui-check.mjs` with its 324 layout checks and behavior suite. The review reproduced three findings that those checks miss.

## P1. Parallel Cursor pane launches can erase the user's hooks

`cursor::install` (`src-tauri/src/cursor.rs:30-41`) reads `~/.cursor/hooks.json`, adds Loom's entries, and saves the result with `std::fs::write`. That call empties the file before it writes. A second installer can read the file in that gap, take the empty text for a missing file, and save Loom's defaults without the user's entries. Loom restores panes in parallel (`src/main.ts:5877` and `10572`), so a startup with several Cursor panes can hit this.

`node_modules/.cache/review/cursor-install-same-repro.rs` compiles the real `cursor.rs` and runs eight installers at once against a temporary hooks file, all naming the same `loom.exe`. At attempt 12 it lost an existing `afterFileEdit` hook. The file left behind was valid JSON of 236 bytes, and no installer reported an error.

The fix should write a unique temporary file and rename it over `hooks.json`. Every user entry must survive, and a failed write must leave the original file as it was.

## P2. Cursor-style text in a transcript becomes a live approval in other agents

`readMenu` (`src/prompt.ts:109`) falls back to `cursorMenu` for every agent. The numbered-menu reader drops a menu when a live input follows it, Claude's input row under a rule or Codex's `›` row. The Cursor reader checks only for Cursor's own `→` row. So Cursor-style options quoted in a Claude or Codex transcript, above that agent's live input, read as a pending question. Loom then refuses sends to the pane, and the Overview offers buttons that press Enter into ordinary input. `node_modules/.cache/review/menu-repro.mjs` reproduces the Claude case and the Codex case.

The Cursor reader should reuse the existing live-input check. Tests should put quoted menu text above each agent's real composer, and real Cursor approval and trust menus must stay actionable.

## P2. Esc on one Cursor turn hides a genuine error in the next

`agentReport` (`src/main.ts:5025`) turns every Cursor `fail` within 5 s of `interruptAt` into an interrupt, and the wake path (`src/main.ts:2670`) raises no alert for an error in that window. A new turn that fails inside the window gets the same treatment. `node_modules/.cache/review/cursor-repro.ts` adds a case to the existing `main_context.test.ts` fixtures. Task A is cancelled at 61000, B starts at 62000, and B reports a genuine error at 63000. B ends `cancelled`, the pane isn't waiting, and no failure alert goes out.

The duplicate aborted and error stops should be matched by the interrupted turn's Cursor `generation_id`, not by a 5 s window, with the hooks carrying the turn's id as far as needed. Both orders of the duplicate stops must still work. A genuine failure in a new turn must stay failed and raise its notice. A late duplicate stop from the interrupted turn must not cancel or fail the new turn.
