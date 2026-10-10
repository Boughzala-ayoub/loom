# Study: Loom as a full-Rust native app

Status: study only, nothing implemented. 2026-09-29, against commit `7d0c956`.
This picks up from `docs/tauri-replacement-study.md`, option C, after the
decision to go all the way to Rust: no webview, no JavaScript, no Tauri.

## Short answer

It is feasible, and most of the hard parts already have working Rust references.
Zed ships a stable Windows build on GPUI and runs its terminal on
`alacritty_terminal`. Warp ships a Rust agentic terminal on Windows. Roughly
2,700 of Loom's 3,240 runtime lines of Rust move into a UI-free crate as they
are. What gets rewritten is the frontend: `main.ts`, 6,353 lines, plus
`styles.css` and the checks built around them. My estimate is 4 to 5 months for
one person to reach parity, and 12,000 to 20,000 lines of Rust.

The pick:

- **UI:** GPUI with `gpui-component`, pinned to a Zed tag.
- **Terminal:** `alacritty_terminal` fed by the existing `portable-pty` threads,
  with a small scanner for the OSC codes Loom depends on.
- **Layout:** one process, and a workspace of a UI-free `loom-host` crate plus a
  `loom-ui` binary.
- **Order:** a week or so of spikes first, with numeric go and no-go gates.
  Then extract the host while the Tauri app keeps shipping, then build the UI in
  four phases.

Two things could stop it, and the spikes test both: GPUI cannot take
screenshots headlessly on Windows, and nobody has confirmed the window chrome
(snap layouts, Mica) on this exact setup. GPUI's GPL license chain, which I
first flagged as a third, was relicensed to Apache-2.0 on 2026-09-01.

## What the rewrite replaces

| Today | Native |
| --- | --- |
| WebView2, 7 processes, 617 MB private on this machine | One process. Terminals, glyph atlas and GPU buffers |
| xterm.js plus WebGL addon, 12 GL contexts then a DOM fallback | One terminal widget. No context budget |
| `Channel<String>` to JS, one eval per chunk, batched acks | The reader thread parses bytes straight into the emulator |
| `take_utf8`, the 64 KiB coalescer, `output.rs` flow control, `pty_ack(s)` | Deleted |
| A second WebView2 renderer for the overlay | A second small window in the same process |
| `pty-exit` event racing the stdout channel, so `[exited N]` can print early | Exit is a message in the same ordered stream as output |
| DOM rebuilds with focus and caret restore, plus signature diffing | Retained state in entities. The problem does not exist |
| Overview preview moves one live terminal's DOM into a modal | Two views render the same terminal entity |
| CSS variables, 52 `color-mix()` calls, `backdrop-filter` | Palette tokens in Rust, and Mica from the OS |
| Tauri plugins, capability files, `webview_profile_dir`, `sweep_stale_profiles` | About 230 lines of `lib.rs` deleted, window-state redone in about 40 |

The frontend is 6,353 lines in `main.ts`. About 790 of those are the 38 theme
palettes, 720 the pane, 660 the Overview, 600 the Changes and diff panel, and 350
the thread. There is no markdown and no syntax highlighting anywhere, so nothing
heavy is missing from the port. About 1,000 lines in `main.ts`, plus the six
helper modules (`agent`, `prompt`, `gitparse`, `apply`, `links`, `drop`, 538
lines) are pure logic that ports nearly line for line. `agent.ts` and `links.ts`
use regex lookahead, so they need `fancy-regex` or a rewrite. Their 569 lines of
tests become Rust golden tests.

## Stack choice

### UI framework

| Candidate | For | Against | Verdict |
| --- | --- | --- | --- |
| GPUI plus `gpui-component` | Zed ships it on Windows, DirectX 11. Mica and MicaAlt backdrops are selectable. AccessKit built in. `gpui-component` lists a resizable dock with draggable tabs and nested splits, virtual lists and tables, trees, dialogs, popovers, notifications, a command palette, a Tree-sitter editor and charts. Animation with easing, and a canvas for custom drawing | crates.io `gpui` has been frozen at 0.2.2 since 2025-10-22, and forks churn (`gpui-ce` 0.3.2 and 0.3.3 yanked 2026-08-28). You pin a Zed tag such as `v1.21.0`. No headless screenshots on Windows | Pick |
| WarpUI (`warpui_core`, `warpui`) | Built for a Rust agentic terminal that runs on Windows | Labeled MIT, but its internal dependencies (`sum_tree`, `warp_util`, `warp_errors`) inherit Warp's AGPL-3.0. No docs, not on crates.io | Skip |
| egui, as Geist uses it | Mature, 13 million downloads. Geist shows egui plus `libghostty-vt` plus a custom wgpu pipeline on Windows | Geist lists no IME and no accessibility. No text shaping, and the visual ceiling is lower | Skip |
| WinUI 3 with Rust (`windows-reactor`) | Best Windows fit, native IME and accessibility, Microsoft-authored | Pre-1.0 and five months old. You write the terminal renderer | Fallback |
| Slint, iced, Makepad, Xilem, Dioxus Blitz | Each has a niche | See `docs/ui-stack-study.md` | Skip |

The license concern is resolved on Zed's main branch. `gpui` declares
Apache-2.0, but the chain `gpui → sum_tree → ztracing → zlog` used to link
GPL-3.0-or-later code (zed-industries/zed #55470, opened 2026-05-02). PR #63573
merged on 2026-09-01 and relicensed `zlog`, `ztracing` and `ztracing_macro` to
Apache-2.0, and `sum_tree` on main is Apache-2.0 too. The issue itself is still
open, and the pinned tag has to postdate the merge. `v1.21.0` (2026-09-23) does.
Spike 4 confirms it with `cargo deny` on the real tree.

### Terminal engine

| Engine | For | Against | Verdict |
| --- | --- | --- | --- |
| `alacritty_terminal` 0.26 | On crates.io, Apache-2.0. Zed's terminal and `gpui-terminal` use it. Warp forked its grid model | No key encoding in the library. No OSC 9, 99 or 133 handling. No image protocols, which Loom does not use today, since its xterm.js has no image addon | Pick |
| `wezterm-term` | Surfaces alerts and semantic zones, supports images | Not published on crates.io, so it is a git dependency | Fallback |
| `libghostty-vt` | Strong VT correctness, Windows-capable | Needs Zig 0.16, which is not installed here. Community-maintained Rust bindings, several forks | Skip for now |

Loom reads three OSC codes and BEL to know when an agent is busy or waiting:
133 marks, 9, 99, and the bell. `alacritty_terminal` raises the bell and the
title as events but drops the OSC codes. A 60-line state machine over the byte
stream, ahead of `Processor::advance`, catches them. The frontend also scrapes
the screen for "esc to interrupt" and reads menus with `readMenu`, so the host
needs a screen-text API. Only visible panes paint, but every pane parses, hidden
or not. That is cheap and it removes today's need to keep hidden panes on WebGL.

Two cost notes. Key and mouse encoding, bracketed paste, focus events
(`ESC[I`, `ESC[O`) and replies to terminal queries all move from xterm.js into
Loom. Zed's `mappings/keys.rs` is the reference, and I expect 300 to 400 lines.
And memory per cell matters, and I have measured it. `alacritty_terminal`'s
`Cell` is 24 bytes, and on the same stream its grid holds about twice what
xterm.js does: 141 MB against 74 MB for 24 panes with 1,500 rows of history.
A run-length history store came out at 12 MB. So the native saving comes from
dropping the browser and from a compact history store, not from the grid. See
`docs/ui-stack-study.md`.

## Architecture

```
loom-host (lib, no UI)                 loom-ui (bin, GPUI)
  pty threads: writer, reader, waiter    windows: main, overlay
  reader -> OSC scanner -> Term          views read Term under a lock
  git, files, sessions, usage            themes, layout, dock
  state, awake, dictation (feature)      terminal element, key encoder
```

- **One process.** Crash isolation from `docs/live-update-study.md` needs the
  host to ship grid snapshots to a separate UI. That work is deferred, but the
  host takes no UI types, so `loom-hostd` can be added later without touching
  the UI. Skipped now: a second process and any transport trait.
- **The emulator lives in the host.** Each pane owns a PTY and a `Term`.
  The existing reader, writer and waiter threads at `lib.rs:313-376` stay. The
  emitter thread goes, and the reader parses. Backpressure is natural, because a
  slow parse fills the pipe and the child blocks. Terminal replies to DA, CPR
  and DSR queries go through the same writer queue as keystrokes, so order holds.
- **Resize** hits `master.resize` and the emulator's `resize` under one lock.
- **Helper modes** (`--statusline`, `--session-start`, `--codex-notify`) stay as
  first-argument dispatch before any window exists, as in `lib.rs:1282`. A
  separate tiny exe only makes sense if the larger binary is measurably slower
  than today's 50 ms start. `claude-hooks.json` keeps its `__LOOM_EXE__`.
- **State compatibility.** `workspaces.json` is a TypeScript-owned JSON schema
  that Rust never parses. Port the schema and its migration, about 120 lines,
  to serde structs and keep the format. The old and new apps then open the same
  profile, one at a time, which makes A/B checks possible.
- **Workspace layout.** `loom-host`, `loom-ui`, and the existing `src-tauri`
  shrinking to a wrapper over `loom-host` until cutover, then deleted.

The host split, from the backend map:

| Module | Lines | Comes from |
| --- | --- | --- |
| pty | 370 | `lib.rs` 29-71, 133-149, 163-461 |
| launch | 330 | `helper.rs` codex_direct and split_args, `opencode.rs`, `codex_state.rs`, `cache.rs` |
| git, files | 290 | `lib.rs` 463-754 |
| sessions | 300 | `lib.rs` 756-1062 |
| usage | 976 | `usage.rs` |
| dictate | 324 | `dictate.rs`, behind a cargo feature because of `whisper-rs` and `cpal` |
| awake, state | 80 | `awake.rs`, `data_dir`, `state_file` |

Only `lib.rs`, `awake.rs`, `dictate.rs` and two attributes in `usage.rs` touch
Tauri types. The fixes are small: `PtyHost::spawn` takes a sink with `output`
and `exit`, `data_dir` uses the `dirs` crate with the same `dev.ayoub.loom` name
so existing state is found, and `read_image` returns bytes.

## What has to be built

Hardest first, from the frontend inventory.

1. **The terminal widget.** Cell paint, cursor with blink and hollow-when-unfocused,
   selection, copy and paste rules (Ctrl+C copies only with a selection,
   right-click pastes), mouse reporting, IME composition, scrollback and a
   scrollbar, find with highlights and a "3/17" count, file-path and URL links,
   Ctrl+wheel font zoom, and drops of files with the pointer position.
2. **Text input.** About 15 inputs plus the terminal. `gpui-component`'s `Input`
   is the start. Test IME, selection and Arabic and CJK shaping early, because
   dictation offers several languages.
3. **Overview.** Cards with inputs inside a variable-height list, keyboard
   navigation, and the live preview.
4. **Diff and Changes.** Up to 50,000 selectable rows with two gutters, per-hunk
   buttons and an overview ruler, and multi-select trees. The `gpui-component`
   editor in read-only mode may carry the diff. Spike it.
5. **Window behavior.** The always-on-top overlay that never takes focus. The
   existing `ShowWindow(SW_SHOWNOACTIVATE)` call carries over. Also the
   frameless chrome, and reproducing the glass styling from tokens.

Smaller items map to ready parts. Folder picker: `rfd`. Taskbar flash:
`FlashWindowEx`. Chimes: `rodio`. Panes, tabs and splitters: the dock. Popover,
dialog and toast: `gpui-component`. Themes are data: 38 palettes of 16 keys, and
ANSI derives from the palette exactly as `main.ts:938-959` does.

## Verifying without a browser

Your rule of asserting layout at 320, 375, 768, 1024 and 1280 px, and eyeballing
screenshots, has to survive. Today `ui-check.mjs` runs about 394 assertions and
685 layout checks per width against mocked IPC. The stock GPUI headless
screenshot path works only on macOS. Linux and Windows get the portable test
suite, which covers state, focus and layout but not pixels. So:

- **Layout tests in Rust.** Render each view in a GPUI test context at those five
  widths and at 100%, 125% and 150% scale. Dump every named element's bounds and
  assert what the audit asserts now: inside the window rect within 1 px, no
  sibling overlaps in the sidebar and header rows, pane-header buttons at their
  offsets, the terminal grid inside the padded pane, and minimum hit sizes. The
  137 named states in `ui-check.mjs` get rebuilt over a fake host that replays
  scripted bytes.
- **Screenshots from the real window.** `loom-ui --size 375x812 --scale 1.5
  --state fixture.json --screenshot out.png` captures the actual window with
  `PrintWindow`. I look at the images, at widths just above each breakpoint.
- **Theme checks without pixels.** The 38 palettes and their WCAG 4.5:1 contrast
  checks, about 270 evaluations, become one unit test over the data.
- **Driving the real app.** UI Automation over the AccessKit tree for clicks and
  typing. The Win32 checks in `overlay-check.mjs` and `window-state-check.mjs`
  keep working if window titles stay the same.
- **Backend checks** (`pty-close`, `git-direct`, `changes-equivalence`,
  `codex-lock`, half of `performance-check`) become `cargo test` integration
  tests over `loom-host`. `session-check`, the opencode checks and
  `codex-account-check` run unchanged. `perf-frontend-check` and the WebView2
  modes of `perf-native-check` are dropped.

## Plan

Estimates are mine, for one person working with agents, with wide error bars.

| Phase | Work | Weeks |
| --- | --- | --- |
| 0. Spikes | Four spikes below | 1 to 1.5 |
| 1. Host extraction | Move about 2,700 lines into `loom-host`. Tauri commands become thin wrappers, so the current app keeps shipping. Port the six logic modules and their tests. Backend checks become `cargo test` | 2 to 3 |
| 2. Shell and terminals | Window, chrome, sidebar and threads, dock, tabs, the full terminal widget, state load and save, all 38 themes. Ends as a daily driver for terminal work | 5 to 6 |
| 3. Attention | Overview, command palette, waiting chip, overlay, new-thread form, preferences, dictation | 3 to 4 |
| 4. Changes | Status trees, diff viewer, commit box, PR, files, image preview | 3 to 4 |
| 5. Polish and shipping | Motion, taskbar progress and badge, installer and updater, cutover checks | 2 to 3 |

Spikes, each with a pass condition:

1. **Window.** GPUI on Windows with a frameless title bar, Mica, snap layouts on
   the maximize button, rounded corners, DPI at 100%, 125% and 150%, and a
   no-activate topmost overlay. It also has to look right over the remote-desktop
   tool you use from the phone, because a D3D11 app under RDP can fall back to
   software rendering. Pass: it sits next to Windows Terminal and looks the same.
2. **Terminal.** `alacritty_terminal` and `portable-pty` painting 24 live panes
   in GPUI, running real `claude`, `codex` and `opencode`, with a compact
   history store and the bundled ConPTY package. Pass: at most 300 MB private
   across all processes with 24 panes at 1,500 rows of history filled, CPU at
   24 panes and 10 Hz at most half of a fresh baseline from
   `perf-native-check.mjs`, keystroke-to-pixel and launch-to-first-frame no
   worse than today, and mouse mode, IME, and AltGr and dead keys on a French
   layout working in all three agents. The 300 MB replaces my earlier "a third
   of 637 MB", which a blank WebView2 window (215 MB) makes the wrong yardstick.
   Full gates are in `docs/ui-stack-study.md`.
3. **Verification.** A layout-bounds test and a `PrintWindow` screenshot of one
   view at 375 px, run from a script.
4. **License and pins.** `cargo deny` on the real tree, and the pinning recipe
   for the Zed tag and `gpui-component`. Pass: no GPL in the tree.

The thresholds are my proposal. If a spike fails, phase 1 still pays off: the
Tauri app gets a UI-free host and every later choice becomes a client swap.

Cutover is when the areas from `ui-check.mjs` are covered natively: Overview
(about 205 assertions), themes (about 270), sidebar and threads (about 36),
terminal and agent I/O (about 42), persistence (about 32), Changes (about 25),
notifications and keep-awake (about 25), plan usage (about 15) and the new-thread
form (about 10).

## UI/UX direction

Loom exists to route one person's attention across many agents. The bones are
good: navy and copper, a rail with a knot per agent, waiting agents first in the
Overview with answers from the card. Natively, more of this becomes cheap.

| Move | How it is built | Why native helps |
| --- | --- | --- |
| One-piece window | Client-side title bar carrying the app bar, caption buttons, Mica or MicaAlt behind translucent fills, rounded corners, snap layouts | The OS composites the material. `styles.css` already restricts `backdrop-filter` because it re-blurs under live terminals every frame |
| Mission-control Overview | Each card renders the same terminal entity at a small font inside a clipped box, so the miniature is live and costs only for visible cards. Ring and sparkline drawn on a canvas. Triage mode shows one waiting agent at full width with its question and numbered buttons | No screenshots and no second buffer. One terminal, two views |
| Motion | Eased animation of the pane weights for add, remove, zoom and layout switch. Shared-element transitions from sidebar row to pane and card to preview, 150 to 250 ms | Display-rate frames with no layout thrash. Reduced motion stays respected |
| Terminal craft | Pixel-smooth scrolling by painting a sub-line offset, cursor glide, ligature toggle, DirectWrite text that matches Windows | The renderer is Loom's own, so nothing is out of reach of the page |
| Ambient status | A thin edge gradient follows the worst state, amber when anything waits, red when all have exited. Taskbar progress shows the working count, and a badge shows the waiting count. The overlay becomes a compact pill | `ITaskbarList3` through the `windows` crate. The overlay is already a separate window |
| System | One type scale with tabular numerals, a 4 px grid, two elevation levels, `color-mix` replaced by tokens mixed in code, Narrator and forced-contrast checks through AccessKit | Palettes are data, so contrast is a unit test |

I have not confirmed per-element backdrop blur in GPUI. The design does not need
it, since glass comes from Mica plus translucent fills.

## Risks

- **GPUI churn.** Every Zed tag bump can break `gpui-component`. Pin both, upgrade
  on a schedule, and keep a lockfile.
- **License.** See spike 4.
- **Verification.** Screenshots and layout tests are yours to build. Budget for
  it in phase 2, not at the end.
- **IME and accessibility.** The claims that GPUI handles IME and AccessKit come
  from documentation and one guide. Spike 2 tests them on Windows.
- **Build size.** A Zed git dependency is a large tree, so the crate count may
  not fall below today's 308, and I have not measured the binary. The
  installer, now 1.9 MB, will grow. Expect tens of MB, unmeasured.
- **Iteration speed.** No DevTools and no live CSS. Compile times will hurt. Plan
  a small theme-preview binary so palette work does not need the full build.
- **Installer.** The NSIS hook that renames a locked `loom.exe` (commit `80c5d2a`)
  carries over if the bundler stays NSIS. Otherwise MSIX or Velopack replaces
  it, and that is its own task.

## What I did not verify

- Whether GPUI's window-control hit test yields the snap-layout flyout on the
  maximize button. Sources conflict, and spike 1 decides.
- That GPUI's test context exposes element bounds by name. I recall it does.
- `alacritty_terminal`'s `Cell` size and its OSC handling. The OSC point comes
  from a read of the API in the backend map, not from running it.
- WarpUI's rendering backend beyond a summary, and any of its accessibility or IME.
- Whether RDP or your phone tool degrades GPUI to software rendering.
- All effort and size figures are estimates from the inventories.

## Sources

- [GPUI license chain, zed #55470](https://github.com/zed-industries/zed/issues/55470)
- [GPUI dependency decision, runner #733](https://github.com/yicheng47/runner/issues/733)
- [Mica backdrops in GPUI, zed PR #48340](https://github.com/zed-industries/zed/pull/48340)
- [Title bar maximize and restore in GPUI, zed discussion #45012](https://github.com/zed-industries/zed/discussions/45012)
- [GPUI Kit accessibility](https://gpui-kit.com/docs/accessibility/) and [testing](https://gpui-kit.com/docs/test/)
- [gpui-component](https://github.com/longbridge/gpui-component) and [gpui-terminal](https://crates.io/crates/gpui-terminal)
- [Zed on Windows](https://zed.dev/docs/windows)
- [Geist, a Windows terminal on egui and libghostty-vt](https://github.com/stvnksslr/geist)
- [Warp client, MIT UI crates](https://github.com/warpdotdev/Warp) and [How Warp works](https://www.warp.dev/blog/how-warp-works)
- [Ghostty on Windows, research notes](https://gist.github.com/stephengodderidge/efb468adcb5b75e8033c1dbede78dc17)
- [alacritty_terminal](https://docs.rs/alacritty_terminal/latest/alacritty_terminal/)
- [Publish wezterm-term, wezterm #6663](https://github.com/wezterm/wezterm/issues/6663)
- Repo: `docs/tauri-replacement-study.md`, `docs/live-update-study.md`, `docs/performance-plan.md`
