# Study: replacing Tauri in Loom

Status: study only, nothing implemented. 2026-09-29, against commit `7d0c956`.
The direction chosen afterward is option C. The full plan is in `docs/full-rust-study.md`.

The question was how to replace Tauri, what Loom gains, and how to end up with a
UI/UX that looks and feels first-class on Windows 11.

## Short answer

Tauri is not what makes Loom heavy. The web engine under it is. On this machine
Loom's own process holds 20 MB. The WebView2 processes it owns hold 617 MB. A
different shell on top of WebView2 fixes a list of window bugs and gives Loom
full control of its window, but it leaves memory and streaming CPU where they
are. Only dropping the web engine changes those numbers, and that means
rewriting a 6,353-line frontend and the test setup built around it.

The recommendation, in order:

1. Split a headless host out of `lib.rs` so the UI becomes a client of it. This
   is the change that unlocks the most, and it works with any shell.
2. Build the UI/UX overhaul on the current shell. A two-day spike decides whether
   Tauri can carry a frameless Mica window. If it can't, swap to an own shell on
   wry and tao, which is a small step once the host is split.
3. Run a one-week native terminal prototype. Start a native client only if it beats
   the web client by a wide, measured margin.

Don't rip Tauri out first. It is the cheapest thing to replace and the least
likely to change how Loom feels.

## What Tauri does in Loom today

| Area | Today |
| --- | --- |
| Commands | 32 `#[tauri::command]` functions, mostly in `lib.rs` |
| Frontend boundary | 71 references in `main.ts` and `overlay.ts`, from 7 `@tauri-apps` imports |
| PTY output | One `Channel<String>` per launch. Each chunk costs a JS eval, and `pty_acks` batches the flow-control acks |
| Events | `pty-exit:{id}`, `overlay-ready`, `overlay-open`, `overlay-dismiss` |
| Windows | `main`, and `overlay`, a second webview for a 300x240 always-on-top list shown with `SW_SHOWNOACTIVATE` |
| Plugins | opener, dialog (folder picker), single-instance (release only), window-state |
| Build | tauri-build, Tauri CLI, NSIS with `nsis-hooks.nsi`, two capability files, `csp: null` |
| Output size | 5.4 MB `loom.exe`, 1.9 MB installer |

Most of the Rust never touches Tauri. `cache.rs`, `codex_state.rs`, `helper.rs`,
`opencode.rs`, `output.rs` and `main.rs` contain no reference to it. `awake.rs`,
`dictate.rs` and `usage.rs` have two or three each, all on the command
signature. `lib.rs` has 65. ConPTY comes from `portable-pty`, dictation from
`whisper-rs` and `cpal`, and none of them depend on Tauri.

So the boundary is thin. Only `lib.rs` is really coupled, and the frontend
reaches Tauri through a handful of calls. That is why every option below is
feasible, and why the browser-serve study found the same seam.

## Where the cost is

| Measure | Value | Source |
| --- | --- | --- |
| Loom's own process | 20 MB private, 84 threads | sampled 2026-09-29, Loom started 10:42 |
| WebView2 owned by Loom | 7 processes (1 browser, 1 GPU, 3 utility, 2 renderer), 395 MB working set, 617 MB private | same sample, matched on `--webview-exe-name=loom.exe` |
| Streaming 24 panes at 10 Hz | about one core: loom.exe 19%, WebView2 browser 42%, renderer 34%, utility 8% | `docs/performance-plan.md`, measured before `pty_acks` batching |
| Crate graph | 308 crates, 277 of them under `tauri`. wry, tao and Loom's own dependencies alone come to about 122 | `cargo tree`, my count of unique lines |

Read together, about 97% of Loom's private memory and over 80% of its streaming
CPU sit on the web-engine side of the boundary. Any replacement that keeps
WebView2 leaves both untouched. The memory figure is one sample with an unknown
pane count, so treat it as the right order of magnitude, not a benchmark.

The two renderers in that sample are the main window and the overlay. A 300x240
agent list costs a whole extra renderer process today.

## What "replace Tauri" can mean

| Option | Gains | Costs | Verdict |
| --- | --- | --- | --- |
| A. Own shell on WebView2 (wry and tao, or `windows` plus `webview2-com`) | Removes five documented bugs, own IPC, fewer crates, full window control | 1 to 2 weeks. Same memory, same CSS ceiling | Only with the host split, and only if the Win32 spike fails |
| B. Bundled Chromium (Electron, or Tauri's CEF runtime) | Pinned Chromium version, mature window options | Installer grows 45 to 100 times, Rust backend becomes a sidecar, same engine so no speedup | No |
| C. Native GPU UI (GPUI and a native terminal grid) | Most of the 617 MB, no eval and ack path, no second renderer, shader effects | 3 to 5 months, loses the web test setup, phone layout and DevTools | Not now. Earn it with a prototype |
| D. Native terminals under a web chrome | Keeps CSS for the chrome, native speed for panes | Unproven | Research only |

Effort figures are my estimates from reading the code.

### A. Own shell on WebView2

What gets replaced: the `Builder`, the four plugins, the IPC and the bundler.
The 32 commands become one match on a name. `Channel` becomes a WebView2 web
message, or a shared buffer. The folder picker becomes the Windows dialog API. A
named mutex replaces single-instance. Loom already triggers its own geometry
saves, so window-state shrinks to a few lines. Installation can stay on NSIS
through cargo-packager, or move to MSIX or Velopack, which also give an updater.

`loom-native-window-gotchas` records seven Tauri-shaped traps. An own shell removes
five of them: the synchronous-command deadlock when building a window, focus
events leaking between windows, the IPC fallback that turns raw responses into
`number[]`, `cargo test` rebuilding without `custom-protocol`, and the absolute
`frontendDist` read as a URL. It does not remove tao's activating `show()`, which
Loom already works around, or the per-launch WebView2 profile folder. That
becomes a plain decision instead of a workaround.

WebView2 has a documented shared-buffer call, `PostSharedBufferToScript`, that
shares memory between the host and the renderer. Feeding PTY output through a
ring buffer and one message per frame should cut most of the per-chunk eval
cost. That is expected, not measured.

What A does not change: the 617 MB, the ceiling CSS puts on visuals, and
WebView2 updating itself under you. It also drops Tauri's capability layer. With
`csp: null` and only local assets loaded that is a small loss, but the own IPC
must check where a message came from.

Frameless windows do not need A. Snap layouts on a custom maximize button need a
transparent native child window that answers `WM_NCHITTEST` with `HTMAXBUTTON`,
because the WebView2 child window swallows the mouse. Tauri plugins already do
this. An own shell writes the same hack itself, with better control.

### B. Bundled Chromium

WebView2 is already Chromium, so Electron does not change the renderer or its
speed. Electron installers land at 85 to 200 MB in 2026 comparisons against
Loom's 1.9 MB, the README promises "No Electron, no Node at runtime", and the
Rust backend would run as a sidecar. Electron's `backgroundMaterial` has open
bugs on frameless maximize (#46753, #42393, #48031).

Tauri's own CEF runtime would keep the Tauri API and pin Chromium. It is at
`3.0.0-alpha.4` (2026-09-26), and the standalone port says its Windows path was
"compile-ported blind". Check again in 2027.

### C. Native GPU UI

Candidates. GPUI is the only one with a Windows terminal in daily use, since
Zed ships on it. Its crates.io release has been frozen at 0.2.2 since
2025-10-22, and forks are churning: `gpui-ce` 0.3.2 and 0.3.3 were yanked on
2026-08-28. The stable path is a git pin to a Zed tag such as `v1.21.0`
(2026-09-23). `gpui-component` has 60+ widgets and `gpui-terminal` wraps
`alacritty_terminal`. libghostty-vt runs on Windows, but Ghostty has no Windows
renderer, input layer or ConPTY code, so it isn't an option. Dioxus Blitz is
alpha and runs no JavaScript, so xterm.js can't run in it.

What would be rewritten: `main.ts` (6,353 lines, 281 KB), `styles.css` (92 KB),
both HTML files, eight unit-test files, and the checks. `scripts/ui-check.mjs`
is 155 KB, and 17 scripts drive Chrome or the app over CDP. The rule to assert
`scrollWidth <= clientWidth` at 320 to 1280 px can't apply to a native window,
and the Galaxy A26 phone mode is a CSS layout today.

What it would gain, unmeasured: most of the 617 MB, the whole eval and ack
path, native DirectWrite text, blur and glow inside the frame budget, and no
second renderer for the overlay. It loses DevTools, CSS iteration speed, the
installer size, and xterm.js addons. Accessibility and IME support in GPUI, and
image-protocol support in `alacritty_terminal`, I did not check.

My estimate is 3 to 5 months for one person to reach parity, with a wide error
bar.

### D. Native terminals under a web chrome

WebView2 has a composition-hosting mode where the host draws its own visuals
next to the web content. That could put GPU terminal panes under an HTML
chrome. I did not test it against translucent regions or input routing. It is
worth a spike after the host split, not a plan.

## Recommended order

**1. Split the host (weeks 1 to 4).** Move the 32 commands, the channel and the
events out of `lib.rs` behind one transport. The first transport is in-process,
so the frontend doesn't change. The second is a named pipe to a separate host
process, as the live-update study designs. This buys three things. The UI can
restart or update without killing agents. A renderer or GPU crash stops killing
ConPTY children, which `pty_shutdown` does on window destroy today. And a
browser or phone client speaks the same protocol. After this, every shell choice
is a client swap. The live-update study budgets 4 to 7 weeks for the whole
update feature, and this is its core.

**2. Overhaul the UI/UX on the current shell, starting in week 1.** It is frontend
work and doesn't wait on the host. Gate it with a two-day spike on a frameless
Mica window: decorations off, `window-vibrancy` Mica, a hit-test child window for
snap layouts, rounded corners with a shadow, resize borders at 100%, 125% and
150% DPI, maximize and restore, and the overlay. It passes if it sits next to
Windows Terminal and looks the same. If it fails, do option A.

**3. Prototype native (one week, after step 1).** One GPUI window, an
`alacritty_terminal` grid, 24 live panes fed by the host. Compare it with the
web client on the same host: private memory across all processes, CPU at 24
panes and 10 Hz, keystroke to pixel, and launch to first frame. Go native only if
memory is a third or less of the web client's, CPU is half or less, and the
IME and accessibility check passes. Those thresholds are my proposal. Otherwise
stay on web and stop.

## UI/UX direction

Loom exists to route one person's attention across many agents. The bones are
good: navy and copper, a rail with a knot per agent, an Overview that puts waiting
agents first and lets you answer from the card. What holds it back from feeling
like a first-class Windows app:

- An OS title bar sits above the app's own bar.
- Glass is faked with `backdrop-filter`, which `styles.css` itself restricts
  because it re-blurs under live terminals every frame.
- Layout changes jump instead of moving.
- The Overview is a list of text cards.

| Move | What it is | New shell needed? |
| --- | --- | --- |
| One-piece window | The app bar becomes the title bar, with caption buttons and snap layouts. Mica behind translucent chrome, rounded corners, a shadow. It frees about 32 px of height, and DWM composites the material, so glass costs the page nothing per frame | No. Tauri plus `window-vibrancy` and a hit-test child does it. The spike decides |
| Mission-control Overview | Each card shows a live miniature of its terminal drawn from the xterm buffer, a context ring, an activity sparkline and elapsed time. Hover peeks, Enter previews. A triage mode shows one waiting agent full width, with its question and numbered buttons, and J and K to move | No |
| Motion | FLIP animation for adding, removing and zooming panes and for layout switches. View Transitions from sidebar row to pane and from card to preview. 150 to 250 ms, and reduced-motion is already handled | No |
| Ambient status | The window edge tint follows the worst state, amber when anything waits and red when all have exited. The overlay becomes a compact pill that expands on hover. Taskbar progress shows the working count and a badge shows the waiting count | No. Jump lists need Win32 calls under either shell |
| Type and density | One type scale, tabular numerals on every count, Segoe UI Variable optical sizes, a 4 px grid, two elevation levels. Audit contrast in every theme | No |
| Terminal craft | Smooth scroll, cursor glide, a ligatures toggle, inline images | No. Check that the xterm image addon works with the WebGL renderer |

If step 3 passes, a native client adds 120 to 240 Hz scrolling and shader-level
glow. Nothing in the table waits on that.

Every row runs on the current stack, and the headless width checks still apply.
A static mockup of the one-piece window and the new Overview, built in the
current CSS, is the fastest way to judge the direction before any of it starts.

## What I did not verify

- Memory came from one sample with an unknown pane count.
- Crate counts are unique lines from `cargo tree`. They exclude crates option A
  would add, such as a dialog crate.
- Every effort figure is an estimate from reading the code.
- GPUI accessibility, IME and image support are unchecked. Nobody has verified
  the CEF runtime on Windows, per its own README.
- WebView2 composition hosting is untested. The snap-layout plugins rest on one
  write-up and crate descriptions, and the spike tests them.

## Sources

- [tauri-runtime-cef v3.0.0-alpha.4](https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.4)
- [SableClient/tauri-runtime-cef](https://github.com/SableClient/tauri-runtime-cef)
- [GPUI dependency decision, runner #733](https://github.com/yicheng47/runner/issues/733)
- [gpui-component](https://crates.io/crates/gpui-component) and [gpui-terminal](https://crates.io/crates/gpui-terminal)
- [Ghostty on Windows, research notes (May 2026)](https://gist.github.com/stephengodderidge/efb468adcb5b75e8033c1dbede78dc17)
- [Snap layouts in a frameless Tauri app](https://dev.to/zbrooklyn/windows-11-snap-layouts-in-a-frameless-tauri-app-the-part-every-guide-gets-wrong-2fjh)
- [WebView2 SharedBuffer spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/SharedBuffer.md)
- [Electron Mica bug #46753](https://github.com/electron/electron/issues/46753)
- [Blitz](https://github.com/DioxusLabs/blitz)
- Repo: `docs/performance-plan.md`, `docs/live-update-study.md`, `docs/browser-serve-study.md`
