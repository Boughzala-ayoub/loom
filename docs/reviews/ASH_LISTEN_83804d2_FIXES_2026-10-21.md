# Ash listening, review fixes for 83804d2

The review of `83804d2` (Ash listening: which pane events the webhooks get)
confirmed three findings. Ayoub asked for all three to be fixed. Each fix gets
its own commit, with a regression shown failing before the fix.

## 1. A request xterm wrapped is cut short, then sent twice

`ashRequests` (`src/pane_events.ts`) joins a continuation row only when it
repeats the request's indent, which is how an agent wraps a long line itself.
A row the terminal wrapped starts at column 0, so it never joins. `paneEvent`
(`src/main.ts`) reads the rows through `tailLines`, one buffer row each.

Reproduced with the installed `@xterm/xterm`: a 32-column terminal is
written `  @ash: inspect /srv/builds/alpha-backend.log and check the latest failure`,
then a blank line and `$ prompt`. `AshSeen.fresh` over its rows returns
`@ash: inspect /srv/builds/alph`. Resized to 90 columns, xterm reflows the line
into one row, and the same request comes out again, whole, as a new one.

The fix should join rows xterm wrapped before reading requests, and keep the
indent rule for agent wraps, ordinary line ends, and Grok's rows, which xterm
flags as wrapped though Grok cuts them at the width itself.

## 2. Turning listening off doesn't stop a signed event being prepared

`Courier.clear()` empties the queue, but a delivery already in `attempt()`
is awaiting `sign()`. After signing, `attempt` checks only `stopped`, which
`clear()` doesn't set, so it posts anyway.

Reproduced: a courier with a secret, one event pushed, `clear()` called at
once. After a tick, the event has been posted once.

The fix should check, after signing and right before the POST, that the job
is still queued. A global or one-pane clear must stop it, while other panes'
events and later events still go, and `webhook test` still posts.

## 3. Requests differing only in case are taken for one

`AshSeen` keys a request by its text with spaces removed and lowercased.
`@ash: inspect /srv/Foo.log`, then `@ash: inspect /srv/foo.log`: the second
is dropped as already sent. Ash runs on Linux, where those are two files.

The fix should keep the request's case in its key. Only the `@ash` marker may
be normalized. Redraws that differ only in spacing, and a request still on
screen, must still count as the one already sent.
