# Loom performance review

Reviewed commit `4cd19e4` on 27 September 2026, around 13:40 to 13:50 local time. This pass inspected the current code, sampled running processes, rebuilt the frontend, and tested the served bundle in fresh headless browsers. It changed no application code and stopped no existing user processes.

The highest current cost is two console hosts consuming nearly two CPU cores. Two additional code paths still duplicate work or delay updates: Changes refresh and Overview message refresh.

## Findings by priority

### P1: console hosts continuously consume CPU

**Previously reported; observed again in this review.** Two five-second samples, several minutes apart, measured:

| Process | First sample, percent of one core | Second sample | Ownership |
| --- | ---: | ---: | --- |
| OpenConsole 39352 | 101.2% | 99.1% | Child of running Loom 67060 |
| OpenConsole 50116 | 97.2% | 93.4% | Recorded parent 62056 no longer exists |

Both executables came from `C:\Program Files\WezTerm\OpenConsole.exe`. Running Loom had loaded `C:\Program Files\WezTerm\conpty.dll`. Its `portable-pty` dependency prefers a sideloaded `conpty.dll` before the Windows implementation. The launch enters that dependency at `src-tauri/src/lib.rs:166`.

This confirms the resource cost, not the cause of the spin. The orphan's original owner is unknown. Capture the hot thread's stack and compare an isolated reproduction using Windows ConPTY with the WezTerm implementation before changing console selection. Do not treat the earlier normal-exit cleanup test as proof that this failure is fixed.

### P1: Codex account discovery can prevent startup

**Previously reproduced; still open.** The earlier investigation reproduced the same 15-second `workspace routing discovery timed out` error in a direct `codex app-server` process without Loom launch flags or an agent thread. Local session-index seeding cannot fix this path.

Keep this separate from Loom startup timing. `node scripts/codex-account-check.mjs` probes it without sending a model prompt. This review did not rerun the account request or change authentication. The service, connection, and Codex client remain possible causes.

### P2: one Changes refresh starts two complete Git refreshes

**New, reproduced.** `src/main.ts:5612` calls both `pollStats()` and `refreshChanges()`. When Changes is open, `pollStats()` also calls `refreshChanges()` at `src/main.ts:4423`. The panel refresh at `src/main.ts:4126` has no in-flight guard.

With one-second simulated Git responses, one real button click emitted 20 Git commands and two concurrent copies of every measured status/diff command. Three quick clicks produced six concurrent copies. This adds process launches and disk work, especially in large repositories; late responses can also repaint older results.

Remove the duplicate caller and coalesce overlapping panel refreshes. Preserve a refresh requested after a Git mutation so coalescing does not leave stale state.

### P2: a stalled OpenCode export blocks later Overview message updates

**New, reproduced with a stalled-response test.** `refreshDashboardMessages()` sets one global busy flag at `src/main.ts:2545` and clears it only after every provider batch finishes. The native OpenCode export at `src-tauri/src/lib.rs:824` waits for process output without a timeout.

In a mixed-provider fixture, exports that never completed left the call count at seven even after a Claude pane finished work and five seconds elapsed. With successful exports, the same trigger caused an eighth read for Claude. Initial fast results appear, but subsequent refreshes are blocked by the outstanding exports.

Track outstanding work per provider or pane, and bound export duration with cleanup of the timed-out process. A slow OpenCode session should not hold unrelated message refreshes.

### P2: terminal output has no end-to-end queue limit

**Already deferred; code risk, not a measured failure in this review.** `src-tauri/src/lib.rs:284` uses an unbounded channel, and `src/main.ts:1613` queues output into xterm. The 1 MiB emit limit bounds individual messages, not total pending output.

The normal 24-pane workload passed. A controlled sustained-output test with a deliberately slow renderer is still needed. Measure backlog, memory growth, input latency, and close latency before adding flow control. Bounding only the Rust queue would leave downstream queues unbounded.

### P3: private Codex state grows without a retention policy

**Already identified; remeasured.** The private state root held 64 directories, 856 files, and 1,045.8 MiB. The earlier audit recorded 914 MiB. Some directories belong to diagnostic runs, so this is not a measured user-only growth rate.

Inventory references from every saved profile and running instance before considering age-based cleanup. No directories were deleted during this review.

## Measurements and limits

`npm run build` and `node scripts/performance-check.mjs` passed against the served production bundle. The latter covered 24 mixed panes, hidden output, GPU eviction, thread switching, Overview scroll retention, duplicate background polls, and disposal during startup.

| Browser workload | Wall time | Main-thread work | JS heap snapshot |
| --- | ---: | ---: | ---: |
| 24 panes idle | 3.015 s | 16.5 ms | 7.2 MiB |
| 1,800 lines delivered to each pane | 2.013 s | 362.5 ms | 14.7 MiB |
| 24 panes streaming while hidden | 3.480 s | 328.0 ms | 26.6 MiB |

Idle main-thread work was about 0.55% of one core; streaming used about 9.4%. These exclude native backend, GPU, console-host, and agent CPU. Heap snapshots do not establish a memory leak. The live Loom/WebView sample included active work and is not an idle baseline.

The installed and locally built executables contain the same frontend asset, `main-D_ili6d5.js`, but their executable hashes differ. Native measurements from the installed app therefore must not be presented as measurements of the exact locally built binary.

The two new reproductions used the real frontend and mocked IPC delays. They prove request scheduling behavior, not Git execution time or the frequency of OpenCode hangs. Temporary reproduction scripts remain in `node_modules/.cache/changes-performance-probe.mjs`, `dashboard-performance-probe.mjs`, and `dashboard-performance-control.mjs`.

## Fixes after this review

The implementation now addresses each Loom-controlled cause or failure path. Two limits remain: the upstream Codex account lookup can still time out, and the original long-running WezTerm console spin was not reproduced in isolation. Existing user processes were not stopped or updated in place.

| Finding | Change | Evidence and limits |
| --- | --- | --- |
| Console CPU | Restrict DLL lookup to Windows, the application directory, and explicitly registered directories. Loom no longer picks up WezTerm's `conpty.dll` from `PATH`. Keep the earlier console cleanup on process exit. | Native checks confirm Windows ConPTY selection, zero measured CPU on two idle hosts during a two-second sample, and no remaining test console hosts after shutdown. This prevents the accidental dependency; it does not prove the cause of the old WezTerm spin. |
| Codex bootstrap timeout | Retry once, only for the exact account-discovery bootstrap error, exit code 1, within the first minute and before user input. Preserve the requested resume behavior. | Browser regression covers split output arriving after exit and verifies that a second failure stops retrying. A direct account probe succeeded in 1.19 seconds after 26.72 seconds of isolated initialization. The external failure remains possible. |
| Duplicate Changes reads | Coalesce refreshes, retain one follow-up for mutations during a read, and remove the duplicate call from Refresh. | One click starts 10 Git reads instead of 20. Rapid clicks never overlap identical reads. |
| Overview stalls | Track in-flight reads per pane. Limit OpenCode exports to five seconds and 32 MiB, terminating the export process tree on failure. Keep previous messages and allow later refreshes to retry failed exports. | A deliberately stalled OpenCode export no longer prevents Claude rows refreshing. Native tests cover export success and deadline enforcement; the packaged app rejected a hung export and terminated its child. |
| Output queues | Bound the reader queue to 16 reads and allow four output batches awaiting parser acknowledgement. Allocate a fresh channel for each process launch. Closing a pane also releases output from an already-exited child. | Native stress test stalls at exactly four batches, then drains all output after acknowledgement. Closing an exited pane with stalled output releases its console. Window and sibling resize remained responsive in 9 ms during simulated 1.5-second process cleanup. |
| Private cache growth | Expire managed caches after 30 days, with at most one scan per day per instance. File leases protect active panes; recorded profile references protect saved panes. Write ownership metadata atomically. | Unit tests protect active, saved, missing-profile, malformed-metadata, and legacy caches while removing expired, unreferenced caches. Legacy directories without ownership records remain untouched. This does not reclaim the previously measured 1.02 GiB automatically. |

Validation completed:

- `cargo test --lib`: 25 passed, four intentionally ignored.
- `scripts/performance-check.mjs`: 24-pane workload, hidden output, GPU eviction, Overview history, request coalescing, startup recovery, and output acknowledgements passed against the served production bundle.
- `scripts/scroll-check.mjs`: all four pane types passed at 320, 375, 768, 1024, and 1280 pixels.
- `scripts/ui-check.mjs`: 1,073 rendered states passed across those five widths against the final served bundle. Phone, tablet, and desktop screenshots were inspected.
- `scripts/pty-close-check.mjs`: console selection, bounded output, output draining, replacement isolation, blocked-input responsiveness, and shutdown cleanup passed.
- `scripts/codex-lock-check.mjs`: real fresh and resumed Codex panes started with synthetic credentials while the shared log database was locked; the saved conversation was preserved.

The UI fixture now follows the replacement output channel after relaunch. Its spinner check waits for CSS animation initialization before inspecting frames. These are test corrections; no layout or spinner styling changed.

`npm run tauri -- build` produced `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`, 1,893,951 bytes, SHA-256 `54827C36A7647A3AE65651966C155ABF6B8EAB84C0D6A54C43565E3846D67DA2`. The packaged executable embeds the tested frontend asset `main-BYgSA4vE.js`. The installer was prepared but not installed; existing sessions continue on their current version.

Address the console spin first, then the two confirmed scheduling defects. Keep the Codex account failure tracked separately. Broad renderer rewrites or dependency additions are not justified by these measurements.
