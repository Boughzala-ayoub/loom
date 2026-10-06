# Loom phone remote review, with performance, Claude Opus 5.5

Reviewed `main` at `9bc0f33` on 2026-10-06. Scope is the phone app (`remote.html`, `src/remote.ts`, `src/remote/*.ts`, `src/remote.css`, `src-tauri/src/remote-sw.js`) and what it calls on the PC (`src-tauri/src/remote.rs`, `control::ask`, the loomctl handlers in `src/main.ts` it polls). The installed `loom.exe` was built from this commit, and `dist/` serves the same bundle (`remote-BUqTHjCq.js`).

The user's report was "sometimes the mobile is lagging a bit and a bit buggy". I found no single cause. The phone does little work between polls. The lag comes from how the page waits on the network, and most of the bugginess comes from parts of the page that rebuild while you are typing or tapping. Every finding below was reproduced in headless Chrome against the built page, except where it says otherwise.

## Status

All nine findings and the `.when` nit are fixed in the working tree on `main`, uncommitted. The fixes:

- `read --menu` carries the question, and each screen turn is one request.
- `run()` gives up at the command's timeout + 10 s.
- `loop()` keeps a fixed cadence, and the banner shows only after two misses in a row, over the page instead of in it.
- `replaceAround` keeps the card or commit box you are typing in attached.
- The message box keeps a draft per agent, keyed by stableId.
- Toasts let taps through, and ⋯ opens at once.
- Usage redraws only when its markup changes.
- Diffs and files draw 1,000 rows at a time.

After the fixes, at 150 ms RTT and 4x CPU, the live screen reads every 1.2 s instead of 1.9 s. `src/main.ts` in Browse files blocks for 236 ms instead of 1,389 ms. ⋯ opens in 25 ms instead of 220 ms.

`scripts/remote-ui-check.mjs` has a new block that reproduces each finding, and it passes all 18 checks. `node src/main_cli.test.ts` covers `read --menu`. `scripts/remote-check.mjs` passes in full on a release build of this tree. One earlier full run failed at 1024 px on the "controls under 44 px" sheet check, which is flaky on the old code too. Two runs at 1024 px alone and the next full run passed.

## How this was measured

- PC side: each command the phone polls, run 8 times through loomctl, which takes the same `control::ask` path as `/api/cli`.
- Phone side: `dist/` in headless Chrome as a 393x851 phone (DPR 2.75, touch) with the CPU throttled 4x. A Node server answered `/api/cli` by running the real loomctl for read commands against the running Loom (6 threads, 8 panes, a Claude pane working) and answered every other command with `ok` without running it. Each reply was held 150 ms to stand in for Tailscale over mobile data.
- Bugs: the same page with `/api` mocked per scenario. One test used Chrome's IME emulation (`Input.imeSetComposition`) to type the way Gboard does.
- Baseline: `scripts/remote-ui-check.mjs` on the same `dist/`. Result at the end.

## Performance numbers

PC side is not the bottleneck. Spawning loomctl costs about 15 ms, and every polled command finishes within about 5 ms of that, except `messages` (+30 ms) and `git status` (+80 ms).

| Command | Median | JSON | Gzipped |
| --- | --- | --- | --- |
| `threads` (every 2 s) | 18 ms | 6.0 KB | 1.4 KB |
| `read <pane> --styles` (every second on an agent) | 17 ms | 4.6 KB | 1.5 KB |
| `menu <pane>` (after each screen change) | 14 ms | 23 B | 43 B |
| `messages` (every 5 s on Activity) | 45 ms | 1.9 KB | 1.1 KB |
| `git <thread> status` (every 6 s on Changes) | 94 ms | 7.0 KB | 2.8 KB |
| `read --styles --lines 2000` (scroll back) | 17 ms | 22.6 KB | 5.2 KB |

The page costs little in steady state on a 4x-throttled phone. Busy time is in ms of main-thread work per second of wall time.

| View | Busy | Requests | Long tasks | Layout shift |
| --- | --- | --- | --- | --- |
| Agents, Threads | 5 ms/s | 0.33/s | 0 | 0 |
| Agents, Activity | 8 ms/s | 0.47/s | 0 | 0 |
| An agent streaming | 19 ms/s | 1.47/s, 5 KB/s raw | 0 | 0 |
| Changes | 4 ms/s | 0.40/s | 0 | 0 |

The bundle is 45 KB gzipped (JS 31.5 KB + 2.4 KB + 2.9 KB, CSS 8 KB), and the hashed assets are cached for a year. So the page itself is light. Where it does stall is in the findings below: P2-4 (screen cadence), P2-1 (a stalled request) and P3-4 (big files).

I couldn't measure the glass bars' `backdrop-filter: blur(18px)`. Scroll frames came out identical with and without it (p50 7.0 vs 6.9 ms), but headless Chrome composites in software and tells nothing about a phone GPU. If scrolling the list feels rough on the real phone, removing the blur from `.top`, `nav#tabs` and `#dock` is the first thing I'd try. It's a CSS-only test.

## Findings, most severe first

### P2-1. A reply that never comes freezes the agent's screen, with no banner

Location: `src/remote/core.ts:56` (`fetch` with no timeout), `src/remote.ts:132-146` (each loop awaits its work before sleeping).

The page never gives up on a request. Each poll loop waits for its reply before the next turn, so one reply that never arrives stops that loop for as long as Chrome keeps the request open. Nothing throws, so the offline banner never shows. The page looks alive and shows a stale screen.

Reproduced: on an agent's screen I held one `read` reply forever. Over the next 18.5 s the page sent no further `read`, while `threads` kept going (9 calls), the banner stayed hidden, and the screen kept showing its old content. Typed keys stall the same way, because `sequence()` (`core.ts:220`) sends nothing new until the batch in flight returns. Everything typed meanwhile lands at once when it does. A reply can go missing like this when the phone switches between Wi-Fi and mobile data, when Tailscale moves to a relay, or when Loom's window doesn't answer.

Fix: give every request a deadline. `signal: AbortSignal.timeout(...)` on the fetch, about 10 s for a read without its own timeout and `timeout + 5 s` otherwise. An aborted change already retries with its key (`core.ts:64`), and the server answers a repeated key with the first run's result, so the retry is safe.

### P2-2. A word being typed doubles when the Activity list or the commit box redraws

Location: `src/remote/agents.ts:69-83` (Activity rebuilds every card when its key changes), `src/remote/changes.ts:86-124` (Changes rebuilds the composer when git status changes).

Both places replace the text field you're typing in and restore its value and focus. A phone keyboard can't survive that. Gboard keeps the current word "composing" until you hit space or pick a suggestion. The rebuilt field already holds the half-word, because `oninput` saved it to the draft, and then the keyboard commits the whole word into it.

Reproduced with Chrome's IME emulation. I typed "yes " in an Activity reply, started composing "do", had another agent change state, then committed "done". The box held "yes dodone". With nothing changing it held "yes done". In the commit box, after a git read that saw a new file, the field was a new element and the caret had jumped from position 4 to the end (17).

How often this hits: the Activity key includes every pane's state and title and what each agent last said. `messages` is read every 5 s, so with any agent working the cards rebuild about every 5 s. The commit box rebuilds when an agent in that thread changes files.

Fix: don't rebuild while a reply box or the commit box has focus. Set a flag and redraw on `focusout`. That's a few lines in each place, and it also retires the focus-and-selection restore in `drawList`.

### P2-3. One failed poll pushes the message box off the bottom of the screen

Location: `remote.html:13` (`#offline` sits before `#app`, in flow), `src/remote.css:344` (`position: sticky`), `src/remote/core.ts:65-72` (any failed fetch shows it, any reply hides it).

The banner takes space in the page instead of sitting over it. The agent screen is `height: 100dvh`, so the banner pushes it down and the page grows taller than the phone.

Reproduced: after one failed `threads` request, the dock's bottom moved from 760 to 825 px on a 760 px tall screen at 393 px wide, and to 802 px at 1280 px. The message box and Send were partly off screen, and the page scrolled 65 px. The banner then left about 800 ms later at the next good reply, and the dock jumped back. A phone waking from sleep, or a patchy connection, gives exactly this flashing jump.

Fix: `position: fixed; top: 0; left: 0; right: 0` on `#offline` so it overlays without moving anything. I'd also show it only after two failures in a row, so a single lost poll doesn't flash it.

### P2-4. The live screen updates about every 1.3 to 1.9 s, not every second

Location: `src/remote/agents.ts:565-577` (`read`, then `menu` after it), `src/remote.ts:132-146` (sleep 1 s after the work, not until the next second).

Each turn of the screen loop is `read` round trip, then a `menu` round trip whenever the screen changed (always, while an agent works), then a full 1 s sleep. At 150 ms RTT the mocked page read the screen every 1326 ms, and the live harness, with 4x CPU and real loomctl, every 1.9 s. Mobile RTT over Tailscale is often higher than 150 ms. An echo after typing costs the same three round trips: `keys`, `read`, `menu`.

Fix: have `read` return the menu (`read --styles --menu`, a few lines in the `read` handler at `main.ts:8221`, which already has the pane), so a turn is one round trip. Then have `loop()` sleep `every - elapsed`. The phone page and the handler ship in the same `loom.exe`, so no old-Loom fallback is needed.

### P3-1. A message typed for one agent stays in the box when you open another

Location: `src/remote/agents.ts:367` (one `promptText` for every agent), `showPane` at `:393-420` (never touches it).

Reproduced: typed "delete the old migrations" on alpha:1, went back, opened beta:1. Beta's box held the text, and Send would give it to beta. Activity already keeps a draft per pane (`drafts`, `:251`). The agent screen should do the same: save the box's text under the old id and load the new one's in `showPane`.

### P3-2. Toasts cover Back and ⋯ and swallow the tap

Location: `src/remote.css:341` (`#toast` fixed at the top, above the top bar), `core.ts:101-108`.

After a Send, a tap on Back or ⋯ lands on the toast for 2.5 s, or 7 s after an error. The toast has no action, so `pointer-events: none` on `#toast` fixes it in one line. Moving it under the top bar would also stop it hiding the agent's name.

### P3-3. The Usage tab rebuilds every 2 s, under your finger

Location: `src/remote.ts:127` calls `readUsage()` on every threads poll, and `src/remote/usage.ts:64` redraws the whole tab even when it skips the read.

Reproduced: the provider cards were new elements 4.5 s later. A tap whose press and release straddle a rebuild is lost, and `:active` flickers. The list guards against this with its key (`agents.ts:68`). Here the redraw only refreshes "Updated 2m ago" and the reset countdowns. Drawing after each real reading, once a minute, is enough, so `read()` can `return` instead of `return draw()`.

### P3-4. A big file or commit freezes the page

Location: `src/remote/changes.ts:367` (`CAP = 20000` rows), `showFile` at `:483`, `drawDiff` at `:378`.

Browse files, then `src/main.ts` (9,695 lines), built 39,600 nodes in one task of 1.4 s at 4x CPU, 1.05 s of it layout. The HEAD commit's diff took 274 ms. On a real mid-range phone that's a frozen page with no feedback. I tried `content-visibility: auto` per row. The load task fell to 505 ms but scrolling went to 139 ms per frame, so that's worse. A cap of about 2,000 rows with a "Show 2,000 more" button would keep every case well under 300 ms.

### P3-5. ⋯ on an agent waits a round trip before it opens

Location: `src/remote/agents.ts:717` (`await run("status")` before the sheet).

It reads `status` to label "Fit Loom to phone" correctly. Measured at 150 ms RTT: 218 to 222 ms from tap to sheet, and `status` itself can wait up to 2 s for Codex usage (`pollProviderUsage`, `main.ts:7700`). Open the sheet at once with `app.phoneSize` as known. `fitPhone()` reads the real value back anyway.

## Smaller things I noticed and didn't test

- `drawList` rewrites every `.when` age on each poll even when the text is the same (`agents.ts:86`). That's 14 DOM mutations every 2 s here. It's harmless, and a `textContent !==` check removes it.
- `submit` refuses when the agent's input holds a draft (`main.ts`, submit's help text). If you typed into the agent with the PC keys, then use the message box, Send fails with that error. The pane menu has "Clear the input (Ctrl+U)", but the error toast could say so.
- Each Settings reading runs `remote`, which spawns `tailscale status --json` (`remote.rs:139`), and every toggle re-reads Settings. That's one process per tap. It's cheap enough, but it's the one PC-side spawn the phone triggers.
- I read `remote-sw.js` and the request path in `remote.rs` and found nothing wrong. I didn't re-review the push crypto in `push.ts`, which has its RFC 8291 test.

## Baseline

`scripts/remote-ui-check.mjs` on this `dist/` passes all 17 checks, including 198 views fitting their width, exit 0. None of its checks types while a list redraws, holds a reply without end, or turns the offline banner on, which is how all of the above got past it. Each finding's reproduction above would make a regression check for its fix.
