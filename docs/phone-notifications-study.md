# Phone notifications from Loom

Study, 2026-10-06. The goal: Loom itself tells the phone when an agent finishes
or waits on you, ntfy goes, and tapping the notification opens that agent in
Loom's phone app.

## What happens now

The phone alerts come from the `loom-watch` Claude Code mod
(`~/.claude/dev-mods/a3889c40-…/loom-watch/hooks/register.tsx`), not from Loom.
Every 15 seconds it runs `loomctl` and compares, and when a task finishes or a
pane starts waiting it POSTs to `https://ntfy.sh/loom-xvy6s1228zf7wegz69xwnz`.
That has four problems:

- It only runs while that one Claude Code session runs.
- Tapping the alert opens the Claude session on claude.ai, not the agent.
- ntfy.sh stores and serves the plain text. The topic name is the only secret.
- ntfy.sh's free tier stops at 250 messages a day.

Loom has the pieces this needs already. Every turn a person starts (typed in a
pane, sent from the Overview or the phone, dictated) becomes a tracked task,
and a task ends in one of three notices: `finish`, `fail` or `blocked` (asks
for approval or answers). The `notify` policy decides per pane and per kind
which notices go out, and the phone's Settings tab already shows it as Task
notices. Your Ash email bridge reads those notices through `loomctl watch`.

## How Web Push works here

1. The phone page registers a service worker and asks the browser for a push
   subscription. On Android, Chrome gets it from Firebase Cloud Messaging: an
   endpoint URL and two keys.
2. The page gives the subscription to Loom.
3. When a notice goes out, Loom encrypts a small JSON message for that
   subscription and POSTs it to the endpoint.
4. Android wakes Chrome's service worker, even with the page closed and Chrome
   not running. The worker shows the notification.
5. A tap runs the worker's click handler, which opens `/#/pane/<id>`.

What that buys:

- It costs nothing, and there is no daily cap.
- Google carries the message but can't read it, because it is encrypted for
  the phone's key (RFC 8291).
- Delivery doesn't need Tailscale on the phone. Opening the page after the tap
  does, as now.
- It needs an HTTPS origin. `https://ayoubb.taila51107.ts.net` is one, and the
  page already has a manifest, so it installs as an app.

One rule shapes the worker. Chrome subscribes only with `userVisibleOnly`, so
every push must show a notification, or Chrome shows its own "This site has
been updated in the background". So Loom decides whether to push, and the
worker always shows what it gets.

## The design

### Which events

Push the same notices the policy already sends: `finish` (the agent's turn is
done), `blocked` (it asks something) and `fail`. One set of switches then
governs email and phone. Add one switch per phone, "Notifications on this
phone", which subscribes or unsubscribes it.

Every notice the policy sends is pushed, even while you are looking at that
agent on the PC or the phone (your choice, 2026-10-06).

### What a notification says

| Notice | Title | Body |
| --- | --- | --- |
| finish | `Alpha:1 · Claude finished · 4 min` | The start of its last answer (`last_messages`, what Activity shows) |
| blocked | `Alpha:1 · Claude asks` | The question and its options (`readMenu`) |
| fail | `Alpha:1 · Codex failed` | Why, from the task |

- `tag` is the pane id, so a newer notification for an agent replaces the
  older one. `renotify` buzzes again when it does.
- The push carries a `Topic` header with the pane id. A phone that was offline
  gets only the latest message per agent, not a backlog.
- `Urgency: high` and a 12-hour `TTL`.
- An icon and a badge. Android notifications need PNGs; the manifest has only
  the SVG logo now.

### Tapping it

The worker's `notificationclick` focuses an open Loom window and sends it to
`#/pane/<id>`, or opens a new one there. Opening a waiting pane already calls
`seen`, so the pane goes idle on the PC too.

Pane ids change when Loom restarts. The message carries the ref as well
(`Alpha:1`), and the page falls back to it when the id is gone. When the page
opens, it closes notifications for agents that are no longer waiting.

### Subscribing

Settings gets "Notifications on this phone". Android asks permission on that
tap. The page registers `/sw.js`, subscribes with Loom's public key, and sends
the subscription with a new `loomctl remote push add`. Loom keeps it in
`<workspace>.remote.json` beside that phone's token hash:

- Revoking or unpairing the phone deletes it.
- A 404 or 410 from the push service deletes it.
- The page sends its subscription again every time it opens, so an expired
  one replaces itself.

`loomctl remote push test` sends a sample notification that opens the first
agent.

### Encryption and signing

Each push needs RFC 8291 encryption (P-256 key agreement, HKDF-SHA-256,
AES-128-GCM) and an RFC 8292 VAPID signature (an ES256 JWT). Loom's Rust side
has none of these, and no TLS. `usage.rs` makes its HTTPS calls through
Windows' `curl.exe`.

| Where the crypto runs | Cost |
| --- | --- |
| WebCrypto in Loom's window (`main.ts`) | No new crates. Loom's WebView already uses `crypto.subtle` (`cli.ts:116`). About 80 lines of TypeScript, testable in Node, which has the same API |
| RustCrypto crates (`p256`, `aes-gcm`, `hkdf`) | About 15 new crates in `Cargo.lock`. About 60 lines of Rust |
| Windows CNG through the `windows` crate | No new crates, a feature flag. About 200 lines of unsafe calls, and the raw ECDH secret comes back in an odd byte order |

I recommend WebCrypto. The notices are raised in `main.ts` anyway, so the
message is built, encrypted and signed there. Rust only stores the
subscriptions and POSTs the finished bytes with `curl.exe`, off the UI thread.

The VAPID key pair is made once and its private half kept in
`<workspace>.remote.json`. It can only send pushes to phones you paired.

### ntfy goes

In `loom-watch`'s `register.tsx`, delete the `NTFY` constant, the fetch in
`notify()` and `sessionLink()`. Keep the band and the `/loom` commands. Remove
the topic from the ntfy app on the phone. The Ash email bridge stays as it is.

## What changes where

| File | Change |
| --- | --- |
| `src/push.ts` (new) | RFC 8291 and VAPID with WebCrypto |
| `src/push.test.ts` (new) | RFC 8291's worked example, byte for byte, and a VAPID signature that verifies |
| `src/main.ts` | A notice the policy sends becomes a push unless you're watching; `remote push add`, `remove`, `test` |
| `src-tauri/src/remote.rs` | `/sw.js` and PNG icon routes; subscriptions in `remote.json`; a `push_post` command through `curl.exe`; phone commands marked as such |
| `src-tauri/src/remote-sw.js` (new) | The service worker: show on push, open the pane on tap. About 40 lines |
| `src/remote/settings.ts`, `src/remote.ts` | The switch and test button, re-sending the subscription, closing stale notifications, the ref fallback |
| `docs/loomctl.md` | `remote push` |
| `loom-watch` mod | ntfy removed |

## Limits

- The PC must be on with Loom running, as for everything on the phone. Keep
  `loomctl set awake on`.
- Some Android builds delay pushes to apps they put to sleep. If they arrive
  late, set Chrome's battery use to unrestricted.
- Headless Chrome can't subscribe through Firebase. The real subscription and
  the tap get tested on your phone; everything else gets tested on the PC.

## Tests

- `src/push.test.ts` in Node, beside the other unit tests.
- A stand-in push service on `127.0.0.1`. Loom posts to it, and the test
  decrypts the body with the subscription's private key and checks the
  `Authorization: vapid`, `Content-Encoding: aes128gcm`, `TTL`, `Urgency` and
  `Topic` headers.
- `scripts/remote-ui-check.mjs`: the worker registers, the Chrome DevTools
  Protocol's `ServiceWorker.deliverPushMessage` hands it a message, and
  `registration.getNotifications()` shows its title, tag and link. The new
  Settings switch at every width.
- On the phone: `loomctl remote push test`, a tap that opens the agent, then a
  real finished task and a real question.

## Phases

| Phase | Gets you | Size |
| --- | --- | --- |
| 1. `push.ts`, storage and sending in `remote.rs`, the worker, the Settings switch, `remote push test` | A test notification that opens an agent | 1 day |
| 2. Notices become pushes, the ref fallback, stale ones closed | Real finish, question and failure alerts | half a day |
| 3. ntfy out of `loom-watch`, the phone test | One alert path | 1 hour |

Later, if wanted: answer a question from the notification. Android shows up to
two buttons, and the worker would call `choose` with the phone's token.

## Decided

Built on 2026-10-06 as above: the phone follows the same notify policy as the
email bridge, and pushes come even while you watch that agent.

Sources: [RFC 8030, Web Push](https://www.rfc-editor.org/rfc/rfc8030),
[RFC 8291, message encryption](https://www.rfc-editor.org/rfc/rfc8291),
[RFC 8292, VAPID](https://www.rfc-editor.org/rfc/rfc8292),
[Chrome's "updated in the background" rule](https://pushpad.xyz/blog/chrome-push-notifications-this-site-has-been-updated-in-the-background),
[Declarative Web Push, Safari only so far](https://pushpad.xyz/blog/declarative-web-push).
