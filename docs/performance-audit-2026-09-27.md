# Loom performance audit, 27 September 2026

This audit covers Codex launch, Windows terminal lifetime, blocked input, background polling, pane disposal, and rendering with 24 panes. Tests use temporary native profiles and a served production frontend with simulated PTY output. The installed Loom instance and its active agents were left running.

## Confirmed problems fixed

| Problem | Evidence before the fix | Change and verification |
| --- | --- | --- |
| New Codex panes rebuild their private session index | Empty-index initialization took about 7.7 seconds. Earlier successful ready-screen measurements took 18.9 seconds. | Seed only the session index through SQLite's online backup API. Measured snapshot: 122 ms; seeded initialization: 219 ms. Successful ready screens: 8.1 and 4.6 seconds. Existing pane databases and shared logs remain untouched. |
| Finished processes retain their console host | Two live terminals plus one exited terminal left three OpenConsole hosts. | Remove the matching native session on process exit, outside the shared lock. Only the two live hosts remain; final output is retained. |
| A blocked paste freezes the whole window | A 2 MB write to a process that never reads input prevented the native window from responding within two seconds. | Run writes off the window thread and lock only the target pane's writer. The same blocked write now permits window requests and app shutdown. |
| Closing during startup leaves a process behind | Delayed spawn completed after pane disposal and remained live. | Stop late spawns, release startup slots, avoid reconnecting observers, and prevent a closed thread from creating a replacement pane. |
| Closed panes retain resize observers | The browser test found an observed terminal element after its pane was removed. | Disconnect pane and thread observers on disposal, including late-start completion. |
| Slow background reads overlap | Four visibility events with 24 threads sharing a folder queued 96 identical Git reads per command. Usage and notification polls also overlapped. | Share in-progress Git reads by folder and allow one usage/notification poll at a time. The same test reports one concurrent read for each operation. |
| Overview previews disable terminal follow-output | Reparenting a hidden terminal resizes its buffer before its renderer resumes. Stale scrollbar dimensions can turn a downward wheel movement into a history scroll; subsequent output eventually leaves the view at the top. | Fit after the renderer resumes and reconcile the scrollbar after resizing if the pane was following output. The shared pane fix passes all four pane types at five widths, with output beyond the history limit. Deliberately scrolled history stays in place. |

The startup timings above are local observations, not a guarantee for every launch. Codex account/workspace discovery also produced variable network delays and timeouts during the startup investigation. Seeding SQLite does not remove those external delays.

## Findings still open

- **Codex account startup timeout, reproduced after the audit:** the full Codex 0.157.1 TUI failed with `account/read failed: workspace routing discovery timed out (code -32603)`. A direct `codex app-server` process, without Loom's launch flags or an agent thread, produced the same error after a 15-second account lookup. Three other direct lookups succeeded in roughly 0.5 to 5.7 seconds. This isolates a remaining failure to Codex's account-discovery path; it does not establish whether the delay is in the service, connection, or client. One full TUI launch succeeded and the next failed. Existing pane logs also contained 307 account-rate-limit refresh timeouts across 14 panes in the preceding hour. No login, routing, or MCP settings were changed. Run `node scripts/codex-account-check.mjs` to probe the real lookup without sending a model prompt; it returns a nonzero exit code on failure and omits account details.
- **OpenConsole CPU spike:** two existing hosts each used roughly one CPU core in the initial sample. One had no living parent; the other belonged to the installed Loom. Both disappeared before the later sample without being stopped by this audit. The retained-host leak is fixed, but the specific spinning state was not reproduced in the isolated test.
- **Retained Codex state:** 57 private state directories occupied about 914 MiB at inspection. Some are diagnostic leftovers from earlier work. Automatic eviction is not implemented. These directories were not deleted because ownership across saved profiles and other running instances has not been established.
- **Heavy output:** the native output queue remains unbounded. Normal 24-pane workloads passed; sustained output faster than the renderer can consume still needs end-to-end flow control and a dedicated memory limit test.

## Validation

- `cargo test --lib`: 22 passed, four explicitly ignored hardware/live-service tests.
- `node scripts/pty-close-check.mjs`: native host cleanup, output drain, replacement-process isolation, blocked input, responsive pane close and application shutdown. Final window/sibling response was 8 ms during deliberately delayed 1,500 ms cleanup. The executable's embedded frontend asset was checked against the current build.
- `node scripts/session-check.mjs`: provider session identity, exact resume, notification markers, and subagent isolation.
- `node scripts/codex-lock-check.mjs`: fresh and resumed private indexes while the shared log database is locked; saved conversation retained.
- `node scripts/performance-check.mjs`: 24 mixed panes, slow polling, hidden output, renderer changes, scroll retention, and disposal during startup. Measurements are written to `node_modules/.cache/performance-check/measurements.json`.
- `node scripts/scroll-check.mjs`: Codex, Claude, OpenCode and PowerShell at 320/375/768/1024/1280, including wheel, drag, keyboard scrolling, Overview follow-output and alternate-screen mouse reports.
- `node scripts/ui-check.mjs`: 1,073 rendered states passed across all five widths. Layout assertions wait for the terminal's asynchronous render before checking canvas bounds. Screenshots of the preview, preferences, worktree dialog and restored phone panels were also inspected.

Browser timing measures main-thread work, not whole-machine CPU. Builds and other active agents affect wall-clock measurements. The 24-pane idle sample used about 0.36% of one core in the final stress run; it is not a before/after performance claim.

The installer is built from this work. Updating files on disk does not change already-running Loom code; these fixes take effect after launching the updated application.

Installer: `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`, 1,885,893 bytes.

SHA-256: `194636D7A36FC9CBF5EA8569561BFCAC7FAA34E2771AE221C0873B36C4F9E039`.
