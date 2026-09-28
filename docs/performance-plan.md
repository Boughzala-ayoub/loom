# Loom performance plan

This plan comes from the performance review of 27 September 2026 at commit `72d4741`. It was updated for `26f0e96` (OpenCode 1 and 2 support), and every file and line reference below is against `26f0e96`. It fixes every finding from that review. The rule for all of it: **every current behavior stays as it is**. Where a fix could change behavior if done the obvious way, the phase says how to do it instead and which check proves nothing changed.

Work one phase per commit, in order. A phase is finished when every item in its "Done when" list passes. Install it with `npm run update`, use it for a while, then start the next phase.

## What the review measured

These are the baselines each phase is judged against.

| Finding | Measured | Where |
| --- | --- | --- |
| Sidebar spinner animates `content`, so style is recalculated every frame | 1 busy row: 12.7% main thread vs 1.3% with the animation off. 8 rows: 52% vs 4%. Headless Chrome, real GPU, uncapped frame rate, so the real app pays about half | `styles.css:883` |
| Blocking command bodies run on Tauri's 16 Tokio workers | Keystroke round trip 2 to 5 ms normally, 2,109 ms with 18 slow Git calls in flight. The saved workspace reaches 26 concurrent Git calls once a minute | `lib.rs` commands marked `#[tauri::command(async)]` on a plain `fn` |
| OpenCode 2 reads hold a worker for seconds (new in `26f0e96`) | Session list and Overview export start a private server. The code's own comment measured 6 to 11 s, with a 20 s deadline, after a `--version` check with a 3 s deadline. With the Overview open, each OpenCode pane gets its own call. On this machine both `opencode` and `opencode2` resolve to 2.0.18, so all 5 saved OpenCode panes take this path | `opencode.rs:18`, `opencode.rs:51`, `opencode.rs:62` |
| OpenCode version check before every launch, list and export (new in `26f0e96`) | `cmd /c opencode --version` took 160 to 220 ms here | `opencode.rs:18` |
| Shutdown runs `taskkill` one pane at a time | 13.6 s for 24 panes. One `taskkill` spawn is about 0.45 s on this machine | `lib.rs:400`, `lib.rs:44`, awaited at `main.ts:5683` |
| Every output chunk costs an `eval` plus a `pty_ack` round trip | 311 msg/s (24 panes at 10 Hz, 110 bytes) cost about one core: loom.exe 19% (main thread 14%), WebView2 browser 42%, renderer 34%, utility 8%. Acks alone at the same rate: 59% of a core | `lib.rs:290-323`, `main.ts:1744` |
| Git polling | 10 Git processes per Changes refresh every 10 s, plus 2 per other thread per minute: about 76 a minute. Each goes through the `cmd\git.exe` wrapper, so two processes. About 110 to 170 ms CPU per `status` plus 60 to 90 ms for the wrapper | `main.ts:4271`, `main.ts:4537`, `lib.rs:412` |
| Overview rebuilds every card each second while an agent works | 5 rebuilds in 5 s with 27 cards, about 5% main thread | `main.ts:2781` |
| SessionStart hook launches PowerShell | 0.4 to 0.6 s per Claude start, resume, /clear or compaction. It sits inside the 2-slot boot gate at restore | `src-tauri/src/claude-hooks.json` |
| Window state written on every Moved/Resized event, on the main thread | Not measured | `lib.rs:1135` |
| Codex rollout walk | 795 files, 1.08 GB, 198 ms per walk. Runs on every `has_codex_session`, Overview read with a Codex pane, and Codex turn | `lib.rs:754` |
| First usage scan reads the whole transcript | Largest transcript here is 38.8 MB | `usage.rs:159` |
| Changes drawer blur over live terminals at 1100 px and below | Not measured. Only phone-window mode for the current window size | `styles.css:2791` |

Checked and fine: idle cost (0.5 to 2.3% main thread headless for 27 idle panes), the 250 ms `take_wakes` poll, the per-chunk `screen(true)` scan (about 0.045 ms), `session_usage` tailing from stored offsets, and hidden views using `display: none`.

Not planned: caching the OpenCode version. It would save about 0.2 s per call, but `opencode` resolves through an npm shim that an upgrade can leave unchanged, so a cache could not guarantee today's routing between the v1 and v2 commands. The v2 read cost itself has no fix that keeps its results identical without reading OpenCode's storage directly. Phase 2 stops it from blocking anything else, and the Overview already skips panes whose state hasn't changed.

## Setup notes for the worktree

- Build the frontend with `npm run build`, serve it with `npx vite preview --port 4173` in the background, and point checks at `RESP_BASE=http://localhost:4173`. Vite preview binds `::1` only, so `127.0.0.1` gets connection refused. Stop it by PID from `netstat -ano | findstr :4173`.
- Playwright is not in `package.json`. Run `npm install --no-save playwright` in the worktree; `npm ci` removes it again.
- Before any Cargo command in a new worktree, run `node scripts/setup-native.mjs` once. Native checks use `src-tauri/target/release/loom.exe`; build it with `cargo build --release --features tauri/custom-protocol` from `src-tauri`. `cargo test` rebuilds the debug exe without `custom-protocol`, so rebuild before any check that launches the debug exe.
- A test Loom shares `%APPDATA%\dev.ayoub.loom\claude-hooks.json` with the installed app and rewrites it to point at itself when it spawns a pane. Back it up before a native check and restore it afterwards; the native probe does this.
- Kill test instances with `taskkill /T /F /PID <pid>`. Never kill by image name: the installed Loom and its agents run alongside.
- The OpenCode checks from the README run without model calls: `node src/agent.test.ts`, `node scripts/opencode-plugin-check.mjs`, `node scripts/opencode-cli-check.mjs` (needs the npm-installed v1 and v2 CLIs, or `OPENCODE_V1_EXE` and `OPENCODE_V2_EXE`), and `node scripts/opencode-status-check.mjs` against the preview, once plain and once with `OPENCODE_COMMAND=opencode2`.
- Claude Code's shell sets `NoDefaultCurrentDirectoryInExePath=1`, and then `cmd.exe` no longer runs an `opencode.cmd` from the working folder. The routing test in `cargo test --lib` fails with "Could not read opencode version" from that shell. Run it as `env -u NoDefaultCurrentDirectoryInExePath cargo test --lib`. `perf-native-check.mjs` puts its fake OpenCode first on PATH for the same reason.
- The machine often runs at 60 to 100% CPU from other agents. Compare CPU time and ratios between builds, not wall time, and rerun a measurement before calling it a regression.
- The global UI rule applies to phases 1 and 7: verify in a headless browser at 320, 375, 768, 1024 and 1280 px, including no horizontal overflow, and look at the screenshots.

## Phase 0: baselines

- Copy the probes from `C:\Users\ayoub\Videos\claude\loom\node_modules\.cache\perf-review\` into this worktree's `scripts/`:
  - `probe.mjs` becomes `scripts/perf-frontend-check.mjs`. Headless, mocked IPC, a fixture of 9 threads and 27 panes shaped like the real workspace. It measures idle cost, output cost by agent type, spinner cost, Overview rebuilds, and writes a CPU profile.
  - `native.mjs` becomes `scripts/perf-native-check.mjs`, with `proc-json.ps1` beside it. It launches the release exe on a temporary profile with CDP, and measures IPC cost per message and keystroke latency with slow Git calls in flight.
- Add the three variants the review ran by hand as modes of those scripts: a single busy spinner row, `pty_shutdown` time with 24 quiet panes, and `pty_ack` alone at 310 calls a second.
- Add one new measurement for `26f0e96`: keystroke latency while 5 OpenCode reads are stalled. Point `last_messages` at a folder whose `opencode.cmd` answers `--version` with 2.x and then sleeps, the way the `opencode.rs` routing test fakes the CLI. Record it beside the Git numbers, because Phase 2 has to fix both.
- Run everything on the unchanged build and put the numbers in the commit message.
- No app code changes in this phase.

## Phase 1: frontend only

1. **Overview.** Include `preview` in the signature at `main.ts:2781` only for shell cards, the only cards that display it. Search still matches screen text, because filtering runs before the signature, and a card joining or leaving the list changes the signature anyway. One visible side effect: busy cards' shuttle animation finishes its travel instead of restarting every second, which is how the CSS was written to look.
2. **Spinner, same glyphs.** Replace the `agent-spin` keyframes at `styles.css:883` with one JS timer that sets a `--spin` custom property on each busy row every 80 ms, and change the rule to `content: var(--spin, "⠋ ")`. Same `::before`, same ten strings, same 0.8 s cycle, same color.
   - The timer runs only while some pane is busy and skips rows that aren't rendered.
   - It checks `prefers-reduced-motion` itself, because the CSS rule at `styles.css:2866` stops animations but not a timer. Reduced motion keeps showing a still "⠋ " as today.
   - Each row's frame counts from `busySince`. The one difference from today: a sidebar re-render currently restarts a row at ⠋, and after this it keeps its place in the cycle.
   - OpenCode panes still enter and leave Working through the plugin's `opencode:busy` and `opencode:waiting` markers. The timer only reads `busy`, so it follows them unchanged.
   - If the probe shows the timer still costs more than about 2% for one busy row, switch to the compositor version: a clipped strip of the ten glyphs stepped with `transform: translateY()` and `steps(10)`. That needs a real span in the row instead of `::before`, placed outside `.agent-title` so the check at `ui-check.mjs:1027` still finds no spinner glyphs in titles.

Done when:
- `ui-check.mjs` passes every state at all five widths, including the new `opencode2-session-picker` and `opencode2-overview` states. Lines 1032 to 1041 are rewritten to read the `::before` content over time instead of `getAnimations()`, and still assert ⠋ then ⠙, and no motion under reduced motion.
- Screenshots of a busy row at each of the 10 frames match the old build pixel for pixel.
- The frontend probe shows 0 Overview rebuilds per 5 s while agents are busy and nothing visible changes, and spinner cost near the "animation off" baseline.
- `scroll-check.mjs`, `performance-check.mjs` and both runs of `opencode-status-check.mjs` pass.

## Phase 2: free the async pool

This moved ahead of the shutdown fix. Since `26f0e96`, each OpenCode 2 read can hold a worker for up to 23 s, so input stalls are now more likely than when the review ran.

- Every command that waits on a process or the disk becomes `async fn` with its body in `tauri::async_runtime::spawn_blocking`: `git_run`, `git_stdin`, `pty_spawn` (which now also runs the OpenCode version check), `pty_kill`, `pty_shutdown`, `last_messages`, `codex_sessions`, `opencode_sessions`, `has_codex_session`, `list_files`, `read_file`, the plan-usage curl calls, and `dictate_stop`. Names, arguments and return values stay identical, so the frontend doesn't change. `State<'_, T>` can't move into the closure; take `AppHandle` and call `app.state::<T>()` inside. The deadlines in `opencode.rs` and `export_output` stay as they are.
- `pty_write` sends to a writer thread per pane and awaits that thread's reply over a oneshot channel. It still returns the write's error, so the "Could not write" toast and the rule that a failed write keeps the waiting alert (`main.ts:1658`) still hold. Writes to one pane stay in order, which is stricter than today.
- `save_state` moves off the main thread the same way. `saveQueue` in `main.ts:2539` already keeps writes in order.

Done when:
- A keystroke with 18 slow Git calls in flight takes under 20 ms, down from 2,109 ms.
- A keystroke with 5 stalled OpenCode reads and a Git burst in flight also takes under 20 ms, and the stalled reads still end at their deadlines with the same error text.
- A pane with a full input pipe doesn't delay keystrokes in another pane or a `git_run`.
- A write to an exited pane still rejects.
- `pty-close-check.mjs`, `codex-lock-check.mjs`, `cargo test --lib` (which includes the OpenCode routing tests), `opencode-cli-check.mjs`, `opencode-plugin-check.mjs` and `node src/agent.test.ts` pass.

## Phase 3: shutdown

- `pty_shutdown` (`lib.rs:400`) collects every pane's PID and runs one `taskkill /T /F /PID a /PID b ...` per 32 PIDs, instead of `Session::kill` (`lib.rs:44`) spawning one each. It then drops the sessions in parallel threads, because `ClosePseudoConsole` can wait on draining output. `pty_kill` for one pane stays as it is.
- The same process trees die, and the close handler (`main.ts:5683`) still waits for all of them. Tested during the review: a PID that no longer exists makes `taskkill` exit nonzero but it still kills the others, and Loom already ignores its exit code.
- OpenCode 2 panes run with `--standalone`, so each pane's tree includes its private server. `/T` already covers it; the check below confirms it.

Done when:
- `pty-close-check.mjs` passes.
- 24 panes shut down in under 2 s instead of 13.6 s.
- A real Claude pane's whole tree, claude plus its node children, and a real OpenCode 2 pane's tree, including its private server, are gone afterwards.

## Phase 4: fewer ack round trips

- Keep the flow window at 4 unacknowledged batches in `output.rs`, so memory stays bounded exactly as now. Add `Flow::ack_n` and a `pty_acks([[channel, n], ...])` command. Keep `pty_ack` for the scripts that call it.
- Frontend: each xterm write callback adds to a pending count. When any pane reaches 2 pending, flush every pane's acks in one invoke. Otherwise flush on a 100 ms `setTimeout`. Never use `requestAnimationFrame`, which stops while the window is minimized and would leave agents blocked on a full console pipe.
- Why nothing stalls: a pane never has more than one ack waiting on the timer, so batching can't bring it to the window of 4. Screen output doesn't depend on acks at all.
- No coalescing delay on the Rust side. It would add latency to what you see.
- Only if phase 4 falls short: multiplex all panes into one channel. Each relaunch currently gets a fresh channel so a dead process's late output is ignored (`this.out !== out` at `main.ts:1746`), and a shared channel would have to carry that launch identity.

Done when:
- At 24 panes × 10 Hz, ack invokes fall from about 240 a second to about 10, and total CPU drops by close to half of the roughly one core measured.
- `pty-close-check.mjs` still stalls at exactly four batches and then drains.
- With the test window minimized for 60 s and 24 panes streaming, every child's output arrives and no child blocks longer than on the old build. Run the same test on both builds.

## Phase 5: Git polling

1. The Changes panel's status call (`main.ts:4271`) gets `--branch`. A new `parseBranch` in `gitparse.ts` reads the `##` record for the upstream name and ahead/behind, replacing `rev-parse --abbrev-ref @{upstream}` and `rev-list --left-right --count`. A gone upstream, a detached HEAD and "No commits yet" must map to exactly what those two commands produce now. `parseStatus` skips the `##` record. `pollStats` (`main.ts:4537`) keeps its own status call without `--branch`.
2. A new `git_midway(dir)` command resolves the worktree's own git dir and checks for `MERGE_HEAD`, `REVERT_HEAD`, `rebase-merge` and `rebase-apply`, in today's priority order. Only when one exists does it run the original command, `rev-parse -q --verify MERGE_HEAD` or `REVERT_HEAD`, or `rebase --show-current-patch`. Results match today exactly. During the review, `rebase --show-current-patch` exited 1 at an interactive rebase stopped on `break` while `.git/rebase-merge` existed, so today no rebase bar shows there, and it must stay that way. `git am` also creates `rebase-apply` without a rebase bar today. Normally no Git process starts.
3. Together, a Changes refresh drops from 10 Git processes to 5.
4. Only if it passes its gate: read-only polls (status, diff, log, rev-parse, rev-list) call the real `git.exe` from `git --exec-path`, with the environment the wrapper sets, instead of `Command::new("git")` at `lib.rs:412`. The gate: the environment seen inside Git (`git -c alias.e='!env' e`) and the output of every polled command match byte for byte across all 9 thread folders in the saved workspace. If anything differs, skip this step. Commit, push and anything that runs hooks, filters or credential helpers keep the wrapper.

Done when:
- A new `scripts/changes-equivalence-check.mjs` builds temporary repos, each as a main checkout and a linked worktree, covering: no upstream; upstream ahead, behind, both and equal; gone upstream; a local branch as upstream; detached HEAD; no commits; merge; revert; rebase stopped on a conflict; rebase stopped at `break`; `git am`. The old and new command sets give identical upstream text, gap text, midway state and file list.
- `node src/gitparse.test.ts` covers `parseBranch`.
- The assertion at `performance-check.mjs:207` ("One Changes refresh must launch one set of Git reads") changes from 10 to 5.
- `ui-check.mjs` passes.

## Phase 6: startup and background I/O

1. `loom.exe --session-start` in `helper.rs`, beside `--statusline`, replaces the PowerShell SessionStart hook. It does nothing without `LOOM_PANE` or on bad JSON, writes `transcript_path` to `%TEMP%\loom-tx\<pane>`, and keeps the 10 s timeout. For ASCII paths the marker file is byte-identical. The one difference: the PowerShell hook writes with `-Encoding ascii`, so a non-ASCII transcript path becomes `?` today and usage silently falls back to its other lookup. The helper writes it correctly.
2. Codex rollouts (`lib.rs:754`): skip parsing `session_index.jsonl` on session-ID lookups, which never use the names. Use `DirEntry::file_type()` and fall back to `metadata()` for symlinks and junctions, so linked folders are still followed. Don't cache the walk: a stale list would make `has_codex_session` miss a new session, and the pane would drop its session ID and ask you to pick one.
3. The first usage scan (`usage.rs:159`) streams the transcript with a `BufReader`, keeping the rule that a stored offset always lands after a newline.
4. Window state (`lib.rs:1135`) is saved 500 ms after the last move or resize, and still immediately on close. It keeps saving while running, which the comment at `lib.rs:1136` asks for. A crash within that half second loses only the last move.

Done when:
- `session-check.mjs`, `codex-lock-check.mjs` and `window-state-check.mjs` pass.
- New cargo tests cover a junction under `sessions/`, a transcript larger than the read buffer, and a partial last line.
- Old and new code give identical results on the real `~/.codex` and `~/.claude` data, read-only.
- Restoring 8 Claude panes is faster by about 4 × 0.5 s.

## Phase 7: the blur, measure first

Measure GPU-process CPU at 1000 px with the Changes drawer open over redrawing terminals, blur on and off. If the difference is small, leave it. If it is large, removing the blur changes how the drawer looks, so that one needs the owner's decision before any change.
