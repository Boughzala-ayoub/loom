# Study: the best UI and performance stack for Loom

Status: study only, nothing implemented. 2026-09-29, against commit `7d0c956`.
This widens `docs/full-rust-study.md`. Five research passes covered 30-odd
stacks, and I measured what could be measured on this machine. Every 1-to-5
score comes from those passes and is a judgment on uneven evidence.

## Short answer

Use GPUI with `gpui-component`, `alacritty_terminal` for emulation, one shared
GPU pipeline for all terminals, and the ConPTY package bundled with Loom. That
is still the best pick for UI and performance, but the case for it is now
narrower and better measured than in the last study:

- **Memory.** A blank Loom window costs 215 MB, all of it WebView2. Your live
  session costs 617 MB. So the stack change buys the 215 MB floor. The other
  400 MB is mostly terminal history, and any stack can shrink that.
- **CPU.** Parsing is not the cost. The cost is IPC, JavaScript and rendering,
  and only a native renderer removes all three.
- **Ranking.** On cost and risk weighted scoring, a tuned WebView2 ties GPUI
  (4.10 against 4.00). GPUI wins when only UI ceiling and performance count
  (4.50 against 3.50). Nothing in the evidence separates them further, so a
  bake-off with hard numbers decides. Section "Recommendation" defines it.

Corrections to the earlier studies, from this research: the GPL problem in
GPUI's dependency chain is fixed. WarpUI is out, because its internal crates
inherit AGPL. `alacritty_terminal` uses more memory per cell than xterm.js, so
a compact scrollback store is a requirement, not an option.

## What I measured

Measured today on this machine, an RTX 3050 laptop plus Intel UHD with 15.6 GB
of RAM. Other sessions were running, so treat timings as rough.

| Measure | Result |
| --- | --- |
| Blank Loom, empty state, one window | 7 processes, 215 MB private, 412 MB working set. `loom.exe` itself is 7 MB |
| Your live Loom session | 617 MB private, 395 MB working set, 7 processes |
| Content on top of the blank floor | about 400 MB |
| xterm.js headless, 24 panes at 120x45, 1,500-row history | 74 MB heap and buffers, 114 MB RSS |
| xterm.js headless, 5,000-row history | 220 MB heap and buffers, 325 MB RSS |
| `alacritty_terminal` 0.26, same stream, 1,500 rows | 141 MB, or 196 MB private with about 55 MB fixed |
| `alacritty_terminal`, 5,000 rows | 360 MB, or 415 MB private with the fixed part |
| A run-length history store, 24 panes x 1,500 rows | 12 MB, at 356 bytes a row and 17 style runs a row |
| Parse speed, single thread | xterm.js 57 to 70 MB/s, `alacritty_terminal` 109 to 146 MB/s |
| `alacritty_terminal` cell size | 24 bytes |

Method: `docs/bench/terminal-memory/`. Both benches replay the same two byte
streams, 70,000 scrolling lines and 2,000 full-screen redraws, with heavy
truecolor. The stream is more color-dense than real output, and the xterm.js
figure excludes its renderer, so read the ratios, not the absolute numbers.
The public tracker agrees: alacritty issue #9049 measured about 26 bytes a cell,
and a compaction prototype cut 32 MiB to 4.5 MiB at 12 to 25% slower ingest.

What the numbers say:

1. **The web floor is 215 MB and the content is 400 MB.** Native removes the
   floor for good. The content is mostly history: xterm.js buffers alone come to
   74 to 325 MB for 24 panes, depending on how full they are.
2. **A native grid is not leaner than xterm.js.** At 24 bytes a cell against
   xterm's 12, it holds about twice as much. A compact history store, kept in
   any stack, is the biggest single memory lever. It is 6 times smaller than
   xterm.js and 12 times smaller than `alacritty_terminal` on this stream.
   `libghostty-vt` has an 8-byte cell and LZ4 history, but that compression is
   Linux and macOS only.
3. **Parse speed does not matter.** Loom's own perf test at 24 panes and 10 Hz
   produced 311 messages a second of about 110 bytes, roughly 34 KB/s. Even a
   worst case of tens of MB/s is within either parser. The 84% of streaming CPU
   that sits on the web side is IPC, the JavaScript eval, acks and rendering.

## What every stack shares: the terminal

The terminal is the performance-critical part, and its design is the same
under any chrome toolkit.

1. **Engine.** `alacritty_terminal` 0.26. Pure Rust, has a damage API, buffers
   DEC 2026 itself and is proven in Zed. Snapshot its state behind a small
   trait, so `libghostty-vt` can replace it if its API settles. Its Windows
   build needs Zig 0.16, which is not installed here.
2. **History.** Convert rows to a run-length store as they scroll off. Cap by
   bytes, not lines, for example 5,000 rows for the focused pane and 1,500 for
   the rest. Panes on the alternate screen need almost none. This is my
   inference, and it matters because Claude Code's fullscreen mode is the
   default for accounts first used on or after 2026-05-06.
3. **Threads.** One reader per pane, as `lib.rs:313-376` has now. Coalesce
   events for 4 ms or 100 events, as Zed does. Hold the term lock only to copy
   dirty rows.
4. **Renderer.** One device, one swapchain and one instance buffer for all
   panes. Draw backgrounds, then glyphs, then cursor and selection. Use an R8
   coverage atlas keyed by glyph and style, never by color, so Claude Code's
   truecolor gradients don't blow up the atlas (xterm.js #6074). Add a BGRA
   atlas for color emoji. Track dirty rows and present only when something
   changed.
5. **Pacing.** Flip-model swapchain with a waitable object and a maximum frame
   latency of 1, capped at 60 Hz. Idle means no presents. On this hybrid laptop,
   pick the Intel UHD by minimum power, with an override. One report shows a
   held-busy discrete GPU drawing 13 W against 3.8 W idle.
6. **ConPTY.** The in-box ConPTY on Windows 11 build 26200 ignores passthrough
   mode, so DEC 2026 frame boundaries can be lost and full panes repaint on
   resize. Bundle Microsoft's `Microsoft.Windows.Console.ConPTY` package, which
   forwards them. `lib.rs` already allows app-local DLLs on purpose. Load-test
   the bundled host first, because `docs/performance-review-2026-09-27.md`
   recorded another OpenConsole spinning at 100% CPU.
7. **Query replies.** Claude Code probes the terminal at startup. A silent
   terminal can freeze it on the trust screen. Answer DA1, XTVERSION, the kitty
   keyboard query, DECRQM 2026 and the OSC color queries. xterm.js does this
   today. A native terminal has to do it itself.

## The candidates

### Dropped

| Stack | Why |
| --- | --- |
| Electron 43, Tauri with CEF | The same Chromium as WebView2, so no engine gain. One small app measured about 80 MB against 120 MB idle and 2.5 MB against 85 MB installed. The CEF runtime is unreleased and its Windows path is untested |
| Servo 0.6.0, Blitz | Servo has no `backdrop-filter` and no WebGL2 by default. Blitz has no JavaScript, so xterm.js cannot run |
| Qt 6 with `cxx-qt` | No built-in Mica. `cxx-qt` has no scene-graph bindings, so the terminal item is hand-written C++ with its own shader build. LGPL terms. No precedent renders 24 full-screen TUIs |
| Flutter with `flutter_rust_bridge` | Impeller on Windows spikes to 650 MB on resize against 350 MB without, and leaks GPU memory when a secondary view closes. Windows IME bugs are open. Terminal widgets are old, or AGPL |
| WarpUI | The crates are labeled MIT, but their internal dependencies inherit Warp's AGPL-3.0. No docs, not on crates.io |
| iced, egui, Xilem, Floem | iced has no accessibility. egui has no text shaping and a low visual ceiling. Xilem is alpha with a slow release cadence. Floem's releases lag its main branch |
| Avalonia, WPF | An HWND terminal cannot be rounded, animated or covered by menus, and neither has a performance story |
| Win32 and DirectComposition, or a custom wgpu toolkit | Highest ceiling and speed, and the worst rewrite cost. Every widget, IME and accessibility hook is yours |

The Windows Terminal control is not a way out. There is no supported package.
The WPF control is a child window with no OSC, bell or buffer read, and 9,001
rows fixed. The WinUI 3 port is one person's alpha with no stars. Take its
design and its ConPTY package, not the control.

### Finalists

| | Tuned WebView2 | GPUI with `gpui-component` | WinUI 3 with Rust |
| --- | --- | --- | --- |
| Version and health | Evergreen | Zed tag `v1.21.0`, 2026-09-23. Components 0.7.0, 2026-09-28. crates.io `gpui` frozen at 0.2.2 | Windows App SDK 2.5.1. `windows-reactor` 0.100.0, created 2026-04-27, 1,340 downloads |
| Windows fit | Good | Own Win32, D3D11, DirectComposition and DirectWrite. Mica, MicaAlt. Snap layouts through `HTMAXBUTTON` in its source | Best. Mica, title bar, snap layouts and UI Automation are built in |
| Memory and speed | 215 MB floor, about 350 to 450 MB tuned | No browser. A blank window is unmeasured | Vendor gallery app 101 MB private, first window in 160 ms |
| UI ceiling | Full CSS | Quads, shadows, gradients, paths, animation. No in-app blur or user shaders | Composition and Fluent. Custom looks fight the templates |
| Terminal | xterm.js, or Rust VT with cell diffs into one canvas | Zed's terminal is the precedent. Scene batching matches the design above | You write the renderer, in a `SwapChainPanel` |
| Verification | Playwright, as today | `winapp ui screenshot` on any window, layout tests in a GPUI context. No pixel test on Windows | `winapp ui inspect` and `screenshot`, UIA tree |
| Iteration | Vite | None official. Compile and run | Hot reload only in Visual Studio. Rust builds in about 11 s |
| Main risk | Same engine, same floor | Zed-tag churn, IME and accessibility gaps | Pre-1.0 binding, five months old |

GPUI's open gaps, with sources in the list below: IME candidate window bugs
(#64850, #64389), AccessKit merged only on 2026-05-27 and still being filled,
right-to-left text about 40% fixed, a no-activate overlay that is unproven, and
Windows headless rendering not yet covered. Slint and Freya 0.5 are the watch
list. Slint has the best agent loop (an MCP server, headless screenshots, live
preview) but no backdrop blur and a lower ceiling. Freya has a terminal crate on
the same emulator and portable-pty, but its 0.5 core rewrite is still in
release candidates. Makepad has the highest visual ceiling, but its Windows IME
and accessibility status is unknown.

Every winit-based toolkit shares two open bugs. Snap-layout support (#3884) is
missing, and keyboard events keep firing during IME preedit on Windows (#4508).
GPUI and WinUI do not use winit.

### Scores

Scores are from the research reports, not measured. Columns: UI ceiling,
performance, Windows fit, rewrite cost (5 is cheapest), risk (5 is safest),
agent friendliness.

| Stack | UI | Perf | Win | Cost | Risk | Agent | Balanced | Stated goal | UI and perf only |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tuned WebView2 | 4 | 3 | 4 | 5 | 5 | 5 | 4.10 | 4.00 | 3.50 |
| GPUI with `gpui-component` | 4 | 5 | 4 | 3 | 3 | 4 | 4.00 | 4.10 | 4.50 |
| WebView2 with a Rust VT core | 4 | 4 | 4 | 4 | 2 | 4 | 3.70 | 3.70 | 4.00 |
| WinUI 3 with Rust | 4 | 4 | 5 | 3 | 2 | 3 | 3.65 | 3.65 | 4.00 |
| WinUI 3 with C# | 4 | 3 | 5 | 2 | 3 | 4 | 3.55 | 3.55 | 3.50 |
| Makepad | 5 | 4 | 3 | 2 | 2 | 3 | 3.50 | 3.70 | 4.50 |
| Slint | 3 | 3 | 4 | 2 | 4 | 5 | 3.40 | 3.40 | 3.00 |
| Custom wgpu or D3D11 | 5 | 5 | 4 | 1 | 2 | 3 | 3.80 | 4.05 | 5.00 |

Weights: balanced is 25, 25, 15, 10, 15, 10 percent. Stated goal is 30, 30, 10,
5, 15, 10. The last column weighs UI and performance equally and ignores the
rest. GPUI ranks first among stacks you would not build yourself in the
stated-goal view, and shares first with Makepad in the last. In the balanced
view a tuned WebView2 edges it. A custom toolkit scores higher on ceiling and
lower on cost.

## Recommendation

Go with GPUI, and earn it in a bake-off of about 1.5 to 2 weeks before the
phases in `docs/full-rust-study.md` start. One process, `alacritty_terminal`
with the compact history, the shared renderer, bundled ConPTY, and the same
host code for both sides. Same 24 real panes for both, and the numbers below
decide.

Pass conditions, all measured against a fresh baseline from
`scripts/perf-native-check.mjs` on the current build:

- **Memory.** 24 panes at 120x45 with 1,500 rows of history filled, running real
  `claude`, `codex` and `opencode`: at most 300 MB private across all
  processes. The blank web floor alone is 215 MB.
- **CPU.** At most half at 24 panes and 10 Hz, and near zero with no output.
- **Latency and start.** Keystroke to pixel and launch to first frame no worse
  than today.
- **Input.** Mouse modes, IME composition in a text input, and AltGr and dead
  keys on a French layout. Your PowerShell errors come back in French, so I
  assume that layout, and Zed has shipped AltGr fixes for its terminal.
- **Terminal correctness.** Query replies answered, so Claude Code never sits
  on the trust screen. DEC 2026 frames intact under the bundled ConPTY.
- **Window.** The snap flyout on the maximize button, the overlay that never
  takes focus, and DPI at 100%, 125% and 150%. Also check it over the remote
  tool you use from your phone, since D3D11 apps can fall back to software
  rendering there.
- **Verification.** `winapp ui screenshot` captures a GPUI window at 375 px,
  and one layout-bounds test runs from a script.

If memory, CPU or IME fails, stop. The fallbacks are WinUI 3 with Rust for the
chrome and the same terminal renderer in a `SwapChainPanel`, or staying on
WebView2 with the tuning below. The host extraction in phase 1 pays off either
way.

### If you stay on WebView2 for now

The web levers are cheap and would take 617 MB to about 350 to 450 MB. That
range is an inference from the blank floor, not a result.

- Cap history for hidden panes and use a Rust-side compact store. The 400 MB of
  content is mostly history.
- Use WebGL only for visible panes. Chromium caps a page at about 16 contexts,
  and one VS Code report shows GPU-process memory of 3,551 MB with terminal
  acceleration on against 366 MB off.
- Send fewer, larger, frame-aligned messages. One project measured 650 times
  fewer messages after coalescing, and a raw `Channel` for chunks of 1 KiB or
  more.
- `MemoryUsageTargetLevel` on the hidden overlay window. No savings are
  published.

## UI/UX on this stack

The design work in `docs/full-rust-study.md` stands. Three constraints come
from this research. GPUI has no in-app backdrop blur and no user shaders, so
glass comes from Mica plus translucent fills, and glow from layered gradients
and shadows. Right-to-left text is incomplete, which matters only if you
dictate in Arabic or Hebrew. And every visual check goes through real windows on
Windows, so budget the capture path in the first week.

## Changes to the earlier studies

- `docs/full-rust-study.md`: WarpUI dropped as a fallback, the memory gate
  restated against the 215 MB floor, compact history added, ConPTY bundling
  added, and the GPL note corrected. Those edits are made.
- `docs/tauri-replacement-study.md`: its per-cell memory guess (xterm 12 bytes,
  alacritty 24) is now measured, and the bench confirms the 24.

## What I did not verify

- A blank GPUI window's memory, and Zed's baseline. The bake-off measures it.
- Whether GPUI's scene batching matches the renderer design above. I read that
  from its scene primitives, and did not run it.
- Every score is a judgment from thin evidence. There is no independent report
  of how coding agents fare with any of these toolkits. The only agent-side
  sources are vendor posts.
- The WebView2 tuning estimate. No published end-to-end result exists.
- `winapp ui screenshot` on a GPUI window, and whether GPUI's accessibility tree
  is complete enough for layout bounds.
- Windows Terminal, WezTerm, Alacritty, Ghostty and Warp latency on Windows in
  2025 to 2026. The last head-to-head found is from February 2024.
- The benches use one synthetic stream on a loaded machine.

## Sources

- Bench code: `docs/bench/terminal-memory/`
- [alacritty issue #9049, cell memory](https://github.com/alacritty/alacritty/issues/9049)
- [GPL chain relicensed, zed PR #63573](https://github.com/zed-industries/zed/pull/63573)
- [GPUI Windows renderer](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui_windows/src/directx_renderer.rs) and [window events](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui_windows/src/events.rs)
- [GPUI IME issue #64850](https://github.com/zed-industries/zed/issues/64850), [AccessKit PR #56065](https://github.com/zed-industries/zed/pull/56065), [RTL issue #31102](https://github.com/zed-industries/zed/issues/31102), [Linux headless PR #64718](https://github.com/zed-industries/zed/pull/64718)
- [GPUI Kit](https://gpui-kit.com/) and [its testing notes](https://gpui-kit.com/docs/test/)
- [Zed terminal source](https://raw.githubusercontent.com/zed-industries/zed/main/crates/terminal/src/terminal.rs)
- [windows-rs reactor benchmark, #4483](https://github.com/microsoft/windows-rs/issues/4483) and [winapp UI automation](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation)
- [Windows Terminal AtlasEngine PR #20723](https://github.com/microsoft/terminal/pull/20723) and [EasyWindowsTerminalControl](https://github.com/mitchcapper/EasyWindowsTerminalControl)
- [VS Code GPU memory issue #337393](https://github.com/microsoft/vscode/issues/337393) and [Clavyn IPC measurements #48](https://github.com/CodeAny-inc/Clavyn/issues/48)
- [WebView2 SharedBuffer spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/SharedBuffer.md)
- [winit snap layouts #3884](https://github.com/rust-windowing/winit/issues/3884) and [IME preedit #4508](https://github.com/rust-windowing/winit/issues/4508)
- [Flutter Impeller memory #191050](https://github.com/flutter/flutter/issues/191050) and [#193080](https://github.com/flutter/flutter/issues/193080)
- [cxx-qt](https://github.com/KDAB/cxx-qt), [QWindowKit](https://github.com/stdware/qwindowkit)
- [Slint 1.18](https://slint.dev/blog/slint-1.18-released) and [Slint MCP](https://slint.dev/blog/slint-and-AI-MCP)
- [Freya](https://github.com/marc2332/freya) and [freya-terminal](https://docs.rs/freya-terminal/latest/freya_terminal/)
- [Warp workspace manifest](https://raw.githubusercontent.com/warpdotdev/warp/master/Cargo.toml)
- [Servo 0.1.0 release](https://servo.org/blog/2026/04/13/servo-0.1.0-release/) and [Blitz](https://github.com/DioxusLabs/blitz)
- Repo: `docs/full-rust-study.md`, `docs/tauri-replacement-study.md`, `docs/performance-plan.md`
