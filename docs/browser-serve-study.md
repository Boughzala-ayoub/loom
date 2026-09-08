# Study: Loom in a browser (`loom.exe --serve`)

Status: study only — nothing implemented. (2026-08-05)

Goal: open production Loom in a normal browser tab and work with it like the
installed app — panes, themes, state, profiles — served by the same engine.

## Why it's feasible

The frontend is plain web already; it touches the native side through exactly
five doors (verified against `src/main.ts`):

1. **`invoke()`** — 14 commands: `pty_spawn`, `pty_write`, `pty_resize`,
   `pty_kill`, `load_state`, `save_state`, `open_vscode`, `take_wakes`,
   `session_usage`, `plan_usage`, `model_options`, `dictate_start`,
   `dictate_stop`, `dictate_level`.
2. **`Channel`** — one, PTY stdout (the hot path).
3. **`listen()`** — one event family, `pty-exit:{id}`.
4. **Dialogs** — `pickFolder` (native folder picker), `confirm`.
5. **Window** — `requestUserAttention` (taskbar flash).

Put a transport behind 1–3, substitutes behind 4–5, and the whole UI works
unchanged — no rendering logic moves.

## Recommended architecture

**Add a serve mode to the existing exe** — do not build a second backend.
`loom.exe --serve [state.json]` runs the same process, same `Ptys` map, same
`data_dir()` and profile-arg logic, plus:

- **HTTP** on `127.0.0.1:<port>` serving the embedded `dist/`
  (`tiny_http`-class crate, threads not tokio — matches codebase style).
- **One WebSocket** per browser tab for IPC:
  `{id, cmd, args}` → `{id, ok, data}`, plus pushed frames for channel output
  and `pty-exit`.

### Work items

Rust (~300–400 lines, the bulk):
- HTTP static serving of `dist/`.
- WS dispatcher for the 14 commands.
- Refactor: each `#[tauri::command]` fn is Tauri-flavored (`State`,
  `AppHandle`, `tauri::ipc::Channel`). Split the guts into plain fns both the
  Tauri command and the WS dispatcher call. Mechanical, touches all 14.

Frontend (~150 lines):
- Shim implementing `invoke`/`Channel`/`listen` over WS, chosen at runtime:
  `window.__TAURI_INTERNALS__` present → native, absent → WS. (Same seam
  already used for headless testing with a stubbed `__TAURI_INTERNALS__`.)
- On WS drop: "reconnect" overlay. PTYs survive server-side, so refresh can
  reattach — needs server-side scrollback buffering (+~100 lines) or accept
  blank terminals on refresh.

Substitutions:
- `pickFolder` → text prompt for a path, validated server-side (cheapest); or
  a small server-backed directory browser (+1 command, +small UI).
- `confirm` → browser-native `confirm()`.
- `requestUserAttention` → blink `document.title` / Notification API.
- **Dictation** — the real casualty. `cpal` records the *server's* mic: wrong
  mic from a remote browser, device contention locally. Phase 1: hide the
  dictate button in browser mode. Phase 2: `getUserMedia` → stream PCM over
  WS → existing whisper path server-side.

## Security (non-negotiable, even for MVP)

This service is "spawn PowerShell as the user, over HTTP":

- Bind `127.0.0.1` only. Never `0.0.0.0`.
- Per-launch random token in the URL (`http://127.0.0.1:7420/#<token>`),
  checked at WS upgrade — otherwise any website's JS can hit localhost ports
  (DNS-rebinding / CSRF class). Also check the `Origin` header.
- Remote access = Tailscale/WireGuard in front of the localhost bind, not
  TLS/auth built here. Zero extra code, much smaller hole.

## Phasing

| Phase | Gets you | Size |
|---|---|---|
| 1. `--serve` MVP | Full Loom in a local tab: panes, themes, state, usage, VS Code, profiles. No dictation; path typed, not picked. | ~2 days |
| 2. Reattach | Refresh/reconnect without losing running panes (scrollback ring server-side) | ~half day |
| 3. Browser dictation | `getUserMedia` → WS → whisper | ~a day |

## Verdict

Clean fit because the frontend was already IPC-shaped. Phase 1 alone adds
little over the installed app (same machine anyway); the real payoff is
**remote use via Tailscale** and **refresh-proof panes** (phase 2 — an
upgrade over the desktop app, where a crash kills panes).

## Related facts learned while testing profiles (2026-08-05)

- `loom.exe <path>.json` opens a profile: `state_file()` in
  `src-tauri/src/lib.rs` routes `load_state`/`save_state` to the arg; no arg →
  default `workspaces.json`. Single-instance is skipped for profile launches.
- `loom.exe --reset` deletes the state file before the webview loads → fresh
  start. Composes: `loom.exe p.json --reset` wipes that profile, not the
  default. Note: while Loom is already running, a release-build `--reset`-only
  launch is swallowed by single-instance (it just focuses the live window).
- Plain `cargo build --release` bakes the **dev URL** (localhost:1420) into
  the exe — the Tauri CLI enables `tauri/custom-protocol` during
  `tauri build`, and that feature (via `cfg(dev)`) is what selects the
  embedded `dist/`. Manual equivalent:
  `cargo build --release --features tauri/custom-protocol`.
- A killed Loom's WebView2 browser tree lingers ~10–30 s and keeps holding
  `--remote-debugging-port` — a relaunch on the same port silently talks to
  the ghost. Use a fresh port per debug launch.
