# Grok support review, 2026-10-14

The review covered `4095561..e428017` on `loom/grok`, the one commit "Run xAI's Grok CLI as a Loom agent". It found four P2 cases. The existing checks all passed at `e428017`:
- All 38 frontend test files (`node --test --test-concurrency=1 src/*.test.ts`, `grok-last-unit.log`).
- `npm run build`, TypeScript and Vite (`grok-last-build.log`).
- `cargo test --lib --offline`, serial, with `LIBCLANG_PATH` set to `src-tauri/.build/clang/native`: 160 passed, 6 ignored, none failed (`grok-last-native.log`).
- `cargo build --bin loom --offline` for the debug helper (`grok-last-native-build.log`).
- `scripts/ui-check.mjs` on a fresh production preview on port 4211 (HTTP 200): 1547 rendered states at 320, 375, 768, 1024 and 1280 (`grok-last-ui-check.log`).

`git diff --check` passed, and the reviewer made no tracked edits. Those checks don't reach any of the four cases. The logs and repros sit in the ignored scratch folder `node_modules/.cache/review`:
- `grok-last-native-probe.mjs` runs the debug `loom.exe --grok-hook` on valid, documented synthetic payloads. It points `TEMP`, `TMP` and the session marker at its own folder and never opens the app. `grok-last-native-probe.json` holds the events and marker contents it got.
- `make-grok-last-review-repro.cjs` builds `grok-last-review-repro.mjs` from the production methods in `src/main_context.test.ts`' fixture and feeds it those native events. All four expected-outcome assertions fail, and `grok-last-review-repro.log` ends with `GROK REVIEW FINAL FAILURES 4`.
- `grok-last-ui-repro.mjs` runs the gate, nested and blocked cases on a fresh served production bundle with the ui-check mocks. Each fails its expected outcome, with no page errors (`grok-last-ui-gate.json`, `-nested.json`, `-blocked.json`, and a 375 px screenshot of each).
- `node_modules/.cache/ui-check/grok-approval-320.png`, `-768.png` and `-1280.png` show the approval card. At 320 px the first option's scope is gone.

The review didn't run a live Grok, and it changed no Grok hooks, config or trust. `~/.grok/hooks/loom.json` was absent when it checked. The first case follows from opening a Grok pane, which installs that file.

The provider documentation is `C:/Users/ayoub/.grok/docs/user-guide/10-hooks.md` (Grok Build 1.0.52). UserPromptSubmit decision control is near line 115, and Stop decision control and the observer limits near lines 463 to 510.

## 1. A Grok started by another agent reports into that agent's pane

`grok_hook` (`src-tauri/src/helper.rs:238`) checks only `LOOM_PANE` from the environment it inherited. `pty_spawn` exports `LOOM_PANE`, `LOOM_LAUNCH` and `LOOM_SESSION_FILE` to every pane, and the hooks file Loom installs, `~/.grok/hooks/loom.json`, is global. Grok runs global hook files without asking.

Once a Grok pane has installed that file, take a Claude pane where Claude runs `grok --single` for a second opinion. That grok inherits Claude's pane, launch and session marker. It is a root Grok session with no `subagentType`, so the subagent filter doesn't drop it. The helper writes a start and an end with `src: "grok"` into Claude's pane and overwrites the pane's session marker with the child's session. `parseSignal` (`src/task.ts:377`) doesn't look at `src`. The child's turn id maps to no task, so the end reaches the Claude task that has no turn mapping, and `route` completes it while Claude still works. A completion notice goes out early.

The native probe changed the marker from `parent-session\n1` to `child-session\n1`. The served UI showed a completed task while the Claude pane stayed Working. Cursor panes read their markers, so a child grok there would also replace a Cursor pane's session. That wasn't tested live.

The fix needs an owner boundary for both the reports and the session write, and the page should reject a report whose source isn't the pane's agent. Filtering ends alone leaves the marker corrupted. True root Grok reports, events without a source, Grok's own subagent filter and the stale-launch protection must keep working.

**Observed live during this fix (2026-10-14).** My own probes from the previous session hit this case against the user's running Loom. They ran `grok.exe` from a Claude Code session that runs in a Loom pane, so it inherited that pane's `LOOM_PANE`, `LOOM_LAUNCH=1` and `LOOM_SESSION_FILE`. `~/.grok/hooks/loom.json` existed from about 00:01 to 02:07 local, pointing at the debug `loom.exe`. At 00:09 local (23:09:32Z), probe `p8` pressed Ctrl+C on a Grok card. Its StopCancelled became an interrupt in that Claude pane, and the installed Loom (`4095561`) cancelled the pane's working manual task `76934160a1e44e2e` as `interrupted` while Claude was still working on it. Probes `p9` to `p11` (01:2x local) then rewrote the pane's marker, `session-marks/mv78soo0-8`, to `01a137cd-8de0-74d2-b205-41f417af4b51\n1`. The installed Loom reads markers only for Codex, OpenCode and Cursor panes, and the pane's saved `sessionId` is still unset, so its resume isn't affected.

## 2. A blocking Stop hook makes a false completion

`grok_event` (`src-tauri/src/helper.rs:260`) turns `Stop` with `reason: "end_turn"` into `kind: "end"` at once. Grok's Stop is a gate. Another Stop hook can reply `{"decision": "block", "reason": "Run tests first"}`, return `additionalContext` or exit 2, and Grok goes on under the same `promptId` with no new `UserPromptSubmit`. Loom has already completed the task, sent its final notice and cleared Working by then. `agentReport` (`src/main.ts`) also puts that first stop in `turnsSeen`, so it ignores the turn's real final stop or failure, and the task keeps the preliminary response's hash.

With the helper's real event, a GROK_WORKING screen that went on drawing still had the task completed, `paneBusy` false, `paneWaiting` true and a completed notice. The fresh served bundle showed the same.

The documentation says a passive observer can't tell a continuation fire from the final one: `stopHookActive` is true for both. After 8 continuations Grok forces the stop and runs no hook for it, and its `idle_prompt` Notification comes about a minute after the session settles. A Stop should count as provisional until there's evidence that the turn is over. A one-second timer is no such evidence, and a false final notice repaired only in the journal doesn't count. The fix should cover a continuation, a cancel during the gate, a final failure or completion after a block, and the forced stop. It should prefer screen evidence to `idle_prompt`.

**Observed live during this fix.** Probe `p13` (Grok Build 1.0.52, 120 columns) ran a test-owned Stop hook that blocked the first `end_turn` Stop once. The first Stop fired 10.2 s after the prompt with `stopHookActive: false`, the continuation ran, and the second fired 37.7 s after it with `stopHookActive: true`. Replayed chunk by chunk through xterm.js, the shortcuts bar read `Shift+Tab:mode │ Ctrl+c:cancel │ Ctrl+x:shortcuts` without a break, from 17 ms after the Enter until the turn ended, through both Stops. It turned to `Shift+Tab:mode │ Ctrl+x:shortcuts` only then.

## 3. A prompt another hook rejects leaves Grok Working

`helper.rs:259` reports a start on `UserPromptSubmit`, before other UserPromptSubmit hooks have decided. One of them can reject the prompt. The guide says a blocked prompt is never recorded and starts no model turn, so no turn-end report is owed. Grok goes back to its idle composer and holds the prompt for editing. Meanwhile `reportsTurns(grok)` lets `cursorTurn` override the screen, in `activity` (`src/main.ts:2561`) and in `sweepTasks`' busy check (near 5318). So `cursorTurn` stays true, and the task stays working.

After a simulated 65 seconds, the production fixture still had the task working, `paneBusy` true and `cursorTurn` true. The fresh served UI showed Working over a blocked, idle screen.

The fix must settle such a task honestly, as blocked, pending, unknown or cancelled, never completed, and must not pin Grok busy forever after a prompt hook. Accepted prompts, long turns, queued prompts, permission cards and slow or silent output must keep working. Findings 2 and 3 can share one small lifecycle fix rather than two state machines.

**Observed live during this fix.** Probe `p12` blocked a prompt from a test-owned UserPromptSubmit hook. The bar read `Ctrl+c:cancel` for 1.3 s while the prompt hooks ran. Then Grok drew a card, "Prompt blocked by global/zz-loom-review-probe", with the hook's reason, the prompt, `1 (○) Edit`, `2 (○) Resend`, `3 (○) Discard` and the bar `Tab:next answer │ Esc:scrollback`. About a second after the block, Grok 1.0.52 fired `StopCancelled` for the same `promptId`, with `reason: "unknown"`, `cancelledBy: "unknown"` and the hook's message in `reasonDetails`. The documentation doesn't promise that report, so the fix can't depend on it.

## 4. A narrow card hides the scope of always-approve

`grokMenu` (`src/prompt.ts:148`) takes each option's text as drawn, `options.map(m => m[3])`, and `full` gets the same clipped text. Grok cuts option rows at the terminal's width. Its first option is "Yes, and don't ask again for anything (always-approve mode)", and choosing it saves always-approve for every later session in `~/.grok/config.toml`. The live harness avoids that option for this reason.

The 320 px screenshot shows only "Yes, and don't ask again for". A 34-column capture, made by clipping the real `approvalNarrow` fixture, still reads as a menu, with both `options[0]` and `full[0]` equal to "Yes, and don't ask agai". Choosing it still sends native option 1 and changes the global permission mode, while the Overview hides what it grants.

This known option should get a full, accurate caption that shows its global, permanent scope, or stay disabled until its scope is known. The fix mustn't guess the scope of unknown options, change native option indices, turn always-approve on itself, or add a confirmation to every choice. "Yes, proceed" must stay safe to choose, and both action bars, arrows with Enter, and digits must keep working. Narrow fixtures and the served phone UI need checks, and no test may choose this option on the user's live config.

## Limits

The reviewer's evidence is synthetic: native helper runs and mocked UI, no live Grok. The live probes noted above ran Grok Build 1.0.52 at 120 columns from `pywinpty`. Their hook files lived in `~/.grok/hooks` only for the run, did nothing without the probe's environment variable, and were removed afterwards. The user's `~/.grok/config.toml` was compared byte for byte before and after.
