# Loom UI/UX analysis

Based on a full read of `src/main.ts`, `src/styles.css`, `index.html`, and the README (v2.9.0).

Overall verdict: the UI is already unusually coherent for a terminal app — consistent palette,
real tooltips everywhere, `prefers-reduced-motion` handled, native `<select>` where it matters.
The weak spots are almost all *discoverability and dead-ends*, not visuals. Ranked by impact:

## High impact

**1. Light themes break terminal text.** `termTheme()` (`src/main.ts:293`) hands xterm only
`background/foreground/cursor/selectionBackground`. The 16 ANSI colors stay xterm's dark-scheme
defaults, so on `solarized light` / `latte` / `paper`, anything Claude Code or PowerShell prints
in bright yellow, bright white, or cyan is unreadable-to-invisible on the light background. The
three light themes are effectively broken for their actual purpose. Fix: add an `ansi` block per
theme (at minimum per light theme) and pass it through `termTheme()`.

**2. A dead pane is a dead end.** On `pty-exit` the pane prints `[process exited]` and sits there
forever (`src/main.ts:747`). The only recovery is close-pane → `+ Pane` → re-pick the command —
and closing drops the pane's pinned session id from saved state, so the resume chain is lost.
A `↻ relaunch` affordance (button in the header, or "press Enter to restart" in the dead pane)
that respawns `this.startup` with the same `sid` would turn the most annoying moment in the app
into a non-event.

**3. No keyboard way to move between panes or tabs.** The app is clearly keyboard-centric
(F2/F3/F4/F5, Alt+arrows, Ctrl+F), yet switching workspace tabs or moving focus to a neighboring
pane always needs the mouse. With 16 panes × several folders that's constant friction.
`Ctrl+Tab` / `Ctrl+1..9` for workspaces and `Ctrl+arrows` for pane focus would complete the
story; the keydown handler at `src/main.ts:1825` already has the structure for it.

**4. Shortcuts are invisible.** Every binding lives only in tooltips and the README. One static
overlay on `F1`/`?` listing the ~10 bindings (including the ones with zero affordance:
drag-header-to-swap, Alt+arrows scroll, F3 jump-to-waiting) is a cheap fix that makes everything
else discoverable. The empty state (`index.html:58`) could also name two or three of them.

## Medium

**5. The pane-count box is backwards.** The `#count` input's meaning ("panes for the *next*
folder you open") is tooltip-only, and it must be set *before* clicking `+ Folder`. Moving the
count into the startup-picker menu — the moment you're already making choices about the new
workspace — would match the actual gesture order.

**6. Find gives no feedback.** `#find` (`src/main.ts:1714`) cycles on Enter but never says how
many matches or that there are none. `SearchAddon` exposes `onDidChangeResults` — a "3/17"
counter inside the input and search-as-you-type are both nearly free.

**7. "Waiting" signal doesn't survive zoom or scale across tabs.** Zoomed, sibling panes' yellow
borders are hidden; across workspaces the only cue is a 6px tab dot. An aggregate chip in the top
bar ("2 waiting", click = same as F3) gives one glanceable place, and doubles as the F3
discoverability fix.

**8. Pane close is instant and unconfirmed.** Workspace close confirms; a misclick on a pane's
`✕` kills the pty immediately and un-pins its session. Either confirm when the pane is running
`claude`, or (nicer) a 5-second "pane closed — undo" toast that delays the `save()`.

**9. Mic errors linger.** `micState("err", …)` stays until the next mic action; a stale `⚠ mic`
from an hour ago reads as currently-broken. Auto-revert to idle after ~5s.

## Small / polish

- **Tab overflow is invisible** — `#tabs` scrolls with `scrollbar-width: none`
  (`src/styles.css:185`), so nothing indicates more tabs exist off-edge. A fade-out gradient on
  the clipped side is enough.
- **Tabs can't be reordered**, though panes can (drag-swap). Same drag pattern applies.
- **Custom menus aren't keyboardable** — the shared dropdown (themes, startups, prefixes) has no
  arrow-key navigation or `role="menu"`; the config panel's native `<select>`s are the exception
  that shows how nice it could be.
- **Ctrl+scroll for font size** — the standard terminal gesture; Ctrl+=/− already exist.
- **README drift**: the "Command blocks" section (Warp-style accent bars, copy/rerun hover
  buttons) doesn't exist in the current code — `mark()` (`src/main.ts:931`) only drives the busy
  dot and explicitly ignores A/B/E. Either the feature was lost or the README oversells; both
  mislead a new user.

## One feature-sized idea

**Broadcast input.** Loom's whole premise is many `claude` panes at once, but there's no way to
send the same prompt to several of them. A toggle ("type to all claude panes in this folder") —
or even just making the dictation prefix menu offer "send to all waiting panes" — would serve
the core multi-agent workflow better than any visual polish above.

## Suggested starting point

Items **1** (per-theme ANSI palettes) and **2** (pane relaunch) fix actual breakage rather than
adding anything — start there.
