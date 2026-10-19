# Pane events plan

Goal: an outside app (Ash, a script, a phone relay) learns when a pane finishes,
asks, or exits, without polling and without setting anything up per project.

## Where the state comes from

`Pane.paint()` already runs on every change the UI shows (Ready, Working,
Waiting, Exited, Starting). `cliState(p)` names the same states for loomctl. A
small `Settler` per pane watches that value from `paint()`: a new state has to
stand for 2 s before it counts, so a tool pause or a burst of output that comes
back to the old state sends nothing. Each settled change becomes one event in
an in-memory ring (the last 500). No timer polls the panes.

Event fields: `seq`, `at`, `pane`, `stableId`, `ref`, `thread`, `threadId`,
`agent`, `title`, `old`, `state`, `asking` (a numbered question is on screen),
`exit` (exited only), `generation`, `turns`, `tail` (the last 10 non-blank
lines).

`seq` starts from the clock at page start and only grows, so numbers stay
unique across Loom restarts and window reloads. A reader holding a number from
an earlier run gets `gap: true` and everything this run has.

## Ways to subscribe

1. `loomctl watch --panes [--thread T] [--pane P] [--state S] [--after N] [--follow]`.
   Plain `watch` stays the task journal stream: the email bridge reads it.
   `--thread`, `--pane` and `--state` imply `--panes`. `--follow` reuses
   loomctl's existing reconnecting loop.
2. `loomctl wait <pane> --until idle[,waiting...]`: blocks until the pane's
   settled state is one of those. `--until` without `--task` used to be an error,
   so no existing call changes meaning.
3. Webhooks, kept in the workspace file beside the other settings:
   `loomctl webhook add <url> [--header "Name: value"] [--secret S] [--thread T] [--pane P] [--state S]`,
   `webhook [list]`, `webhook remove <n>`, `webhook test [n]`. Delivery goes
   through the existing `push_post` command (Windows curl.exe on a blocking
   thread, no lock held). With a secret, `X-Loom-Signature: sha256=<HMAC of the body>`.
   Retries after 2, 4, 8, 16, 32 and 64 s, in order per hook, at most 100 queued.
   Failures go to the console and to a per-hook log that `webhook list` shows.

Skipped: a global command hook. `loomctl watch --panes --follow --json | script`
does the same job with nothing to configure. Also skipped: a Preferences screen
for webhooks; loomctl sets them.

## Crash investigation

loom:4 is chasing heap corruption in loom.exe. This feature adds no native code
to loom.exe: events, filters and webhook queues live in the page, and HTTP goes
through a command that already exists. The only Rust change is loomctl.exe's
text line for a pane event.

## Tests

- `src/pane_events.test.ts`: settling, ring and gap rules, filters, retry
  schedule and signature.
- `scripts/pane-events-check.mjs`: a debug Loom on a temp profile, a local HTTP
  server as the webhook, a shell pane that works for a few seconds. It checks
  `watch --panes`, `wait --until idle`, a signed delivery, a retried one and an
  exit event.
