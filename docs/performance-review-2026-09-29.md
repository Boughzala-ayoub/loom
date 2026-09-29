Loom performance review, 29 September 2026

Reviewed `d6712c6`. Normal multi-pane work is responsive in the measured workloads. The clearest remaining application bottleneck is the shared file and diff viewer: its 50,000-row limit still permits about 200,000 DOM elements and seconds of main-thread work. Large flat file trees also stall the frontend. WebView contributes most of the steady memory cost.

This review rebuilt the production frontend and native release, ran isolated browser and native probes, sampled the existing Loom process, and checked earlier performance decisions. It changed no application code, installed no executable, and restarted no existing user sessions.

The findings are ordered by practical impact.

1. **P2. Large previews still block the frontend. Newly measured.**

   `showTab()` at `src/main.ts:4090` prepares all rows before applying the display cap at line 4105. It then creates four DOM elements per displayed line and appends 2,000 lines per animation frame at line 4129. Splitting work across frames does not keep those chunks short as the document grows.

   The served production bundle produced these results in fresh Chrome contexts at 1280 pixels. The inputs used short text lines and remained below the native 4 MiB file-read limit.

   | Input | Displayed rows | Total DOM elements | Main-thread work | Longest blocking task | JS heap growth before GC |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | 1,000 lines, 8 KB | 1,000 | 4,446 | 250 ms | 122 ms | 1.0 MiB |
   | 50,000 lines, 400 KB | 50,000 | 200,446 | 2,414 ms | 162 ms | 7.4 MiB |
   | 250,000 lines, 2 MB | 50,000 | 200,447 | 2,566 ms | 243 ms | 18.6 MiB |

   The measurements include opening Files and the preview. The 50,000-line case contained 19 tasks longer than 50 ms. The extra allocation for the 250,000-line input shows that the display cap does not bound row preparation. This is transient allocation, not evidence of a leak.

   Prioritize rendering only the visible rows in this shared viewer, and bound preparation of unused plain-file rows. Preserve complete hunk data for stage and discard actions. A browser-only `content-visibility` comparison still needed 2,289 ms of main-thread work for 50,000 lines, so that CSS change did not remove the bottleneck. No CSS was committed.

2. **P3. A large expanded file tree is built synchronously. Newly measured.**

   `refreshFiles()` at `src/main.ts:4197` sorts the paths, builds the tree, and appends every expanded row synchronously. A flat directory with 20,000 files consumed 709 ms of main-thread work, including blocking tasks of 227 and 115 ms. A 1,000-file control consumed 191 ms with no recorded long task.

   This is a stress limit, not a claim that the current Loom checkout routinely reaches it. The native plain-folder scanner caps its results at 20,000 entries; the Git listing has no equivalent count cap. If large generated folders or repositories are a supported workload, draw expanded rows in smaller scheduled batches or render only the visible rows. Avoid rebuilding closed folders.

3. **P3. Background polling depends on an unreliable visibility assumption. Previously identified, observed again.**

   The polling gates at `src/main.ts:6327` rely on `document.hidden`. The native test confirmed that its own window was minimized through Win32, but WebView still reported `visibilityState: "visible"`. The same result was recorded in the 28 September performance work.

   The minimized-output test therefore verifies continued terminal output under this configuration. It does not verify that Git and transcript polling pauses. A native minimized-state signal is the appropriate source for that requirement. Confirm behavior without an attached debugging connection before making a power-saving claim.

4. **WebView memory and OpenCode read latency remain known costs. Remeasured or bounded, not new regressions.**

   A fresh empty Loom window used 216.5 MiB of private memory across Loom and six WebView processes. Loom itself accounted for 6.7 MiB. With 24 synthetic terminal panes redrawing at 10 Hz, the same process selection used 311.6 MiB. These are private committed bytes, not physical RAM or GPU-memory totals, and the synthetic terminals had little history.

   Five deliberately stalled OpenCode 2 reads failed after approximately 20.7 to 20.9 seconds each. Other input remained responsive. Normal OpenCode read latency was not remeasured with real conversations. The earlier decision against persistent version caching still applies: an executable shim can remain unchanged after the installed CLI changes version. The current code at `src-tauri/src/opencode.rs:18` shares queued version checks but rechecks later requests.

The current runtime measurements support the earlier performance fixes.

| Workload | Current measurement |
| --- | --- |
| 27 idle mixed panes, headless Chrome | 0.3% of one core on the frontend main thread |
| Nine Claude panes redrawing at 10 Hz | 3.3% main-thread CPU |
| Sixteen Codex and OpenCode panes redrawing at 10 Hz | 4.2% main-thread CPU |
| Overview idle, 27 cards | 0.5% main-thread CPU; no list rebuilds in five seconds |
| Real native frontend and backend, 24 panes at 10 Hz | 26.0% of one core for Loom and WebView combined |
| Output acknowledgements in that native workload | 9.2 batched calls per second |
| Native input with 18 slow Git calls | 4 ms median write, 6 ms maximum write, 18 ms maximum echo |
| Native input with five stalled OpenCode reads and 11 slow Git calls | 5 ms median write, 7 ms maximum write, 30 ms maximum echo |
| Shutdown of 24 quiet synthetic panes | 406 ms |
| Synthetic redraws while minimized for about a minute | Longest interval excess over the 100 ms target: 22 ms |

CPU percentages refer to one logical core, not the whole machine. The native CPU total excludes synthetic child programs, console hosts, and agent CLIs. Each input scenario took five samples. The IPC-only probe acknowledges every message separately and bypasses the real frontend batching, so its higher CPU figures are diagnostic costs rather than normal application CPU.

The existing live instance used 5.5% of one core in Loom, 20.0% in its WebView renderer, and 19.5% in its GPU process during a six-second sample. It had ongoing work, so this is not an idle baseline. It had also started before the reviewed release was rebuilt; these observations are separate from the controlled current-code measurements.

Validation completed:

- `npm run build` passed. The production preview returned HTTP 200 before browser tests. The tested bundle was `main-BC11GJWt.js`.
- `cargo build --release --features tauri/custom-protocol`, run from `src-tauri`, passed with the repository's native build configuration. The rebuilt executable embeds the same frontend asset. Its SHA-256 is `382ecb665df94bc3609306a362de38cc74960bc6cda939c007260036c1f68106`.
- `scripts/performance-check.mjs` passed its 24-pane output, hidden-thread output, GPU eviction, switching, preview scrolling, poll coalescing, disposal, independent Overview refresh, startup retry, and acknowledgement checks.
- The large-view probe verified displayed row counts and captured browser long tasks and heap measurements in fresh contexts. The large-file screenshot was inspected.
- Native probes used temporary profiles, synthetic children, and an isolated hung OpenCode helper. They restored shared hook files and stopped only their own test process trees. Plan-usage requests were disabled in those profiles. No model prompts were sent.

Raw evidence is under the ignored `node_modules/.cache/performance-review-2026-09-29/` directory: `large-views.json`, `large-views-css.json`, `native-input-ipc.json`, and `native/results.json`. The probe sources and screenshots are beside them. The full mixed-pane frontend results and CPU profile are under `node_modules/.cache/perf-frontend-check/`.

To repeat the browser measurements, build and serve the bundle, set `RESP_BASE` to that preview, and run `node scripts/perf-frontend-check.mjs`, `node scripts/performance-check.mjs`, or the saved `large-views.mjs` probe. The review's `native-check.mjs` accepts the existing native probe modes and disables plan-usage requests. Run `ipc keys opencode shutdown` together, and `app` separately.

The history check used a read-only snapshot of the existing session-search index. The eight-phase performance implementation is recorded in session `d73a2dee-29f8-4966-8be4-a2308f4de374`; its phase-4 notes already identify the minimized-window visibility limitation. The 27 September review and plan are in session `b3aed255-80f5-44db-bb40-b28efaf627ea`. Resolved input stalls, duplicate Changes reads, spinner overhead, and shutdown costs were not reported as new problems.

Follow-up fixes, 29 September 2026

Large previews and expanded Files lists now render nearby blocks of 100 rows. Blocks retain measured heights when removed, and resizing preserves the scroll position while wrapped lines are measured again. Focused buttons and selected text stay mounted. Small lists retain ordinary DOM rendering. Plain-file parsing allocates only the first 50,000 preview rows; diff parsing keeps complete hunks for Git actions.

The native minimized state now gates periodic Git, usage, age and Overview refreshes. Restoration refreshes usage and Git immediately. Output acknowledgements, agent notifications and session identity reads continue while minimized.

The 50,000-line fixture fell from 200,446 DOM elements to 1,347. Initial main-thread work fell from 2,414 ms to about 170–215 ms across final runs. The 250,000-line fixture uses about 5.5 MiB of heap growth, compared with 18.6 MiB before the fix. The 20,000-file fixture uses fewer than 1,000 DOM elements, compared with 40,440 before the fix. Timings include opening the panel and preview and vary with machine load.

Validation passed the full UI suite's 1,218 rendered states at 320, 375, 768, 1024 and 1280 pixels. The new `scripts/large-views-check.mjs` checks bounded DOM size, scrolling to the final line or file, wrapped previews, resizing, text selection, file menus and staging a later hunk. The existing performance regressions also pass, including the added minimized-state check.

Native probes confirmed that Git reads pause while minimized, terminal output and notifications continue, and restoration resumes Git reads. A 24-pane redraw test recorded a maximum 19 ms excess over its 100 ms redraw interval while minimized. The packaged executable was checked against the served frontend asset and passed phone resizing and restoration from normal, maximized and fullscreen windows. External Windows minimize/restore also passed using a main-window handle captured before minimizing.

Final browser evidence is in `node_modules/.cache/large-views-check/`. Native evidence and probe sources are in `node_modules/.cache/performance-fix-2026-09-29/`. The installed executable is updated through `scripts/update.ps1`, which retains a backup and leaves running sessions open. The fixes take effect on the next normal launch.

The next application change with the strongest evidence is the shared large-preview renderer. The normal multi-pane measurements do not establish a need for a stack rewrite. Cold agent startup, real OpenCode exports, dictation, long-duration memory growth, and a full responsive-layout audit were outside this pass.
