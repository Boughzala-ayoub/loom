# Phone dictation send acknowledgement review

Reviewed `2bd2100..21ce67c` on 2026-10-07. The delayed recorder-stop ordering and overlapping automatic-send findings are fixed against their earlier failing scenarios.

## Status

Fixed in `b465ba6`. The cause was in the dictation callback. `run()` retried the lost answer four times with one key, then threw. `act()` caught that and returned false, and `sendPrompt()` settled with the text still in the box. The next clip was added to that text, and its `⏎` sent the whole box under a new key. A dictated `⏎` now sends only when the clip is the whole message, meaning the box held nothing as it landed. Otherwise the clip joins what is there and waits for Send. Clips that each find the box empty still go as separate messages, and every word stays in the box.

The regression check is in `scripts/remote-ui-check.mjs`. The mock takes a submit, cuts off every answer to its key, and counts one task per key, as Loom does. On `01c5d6e` the agent got `/prompt first sentence` and `/prompt first sentence second sentence`. On `b465ba6` it got only the first, after four tries with one key, and both sentences wait in the box. The earlier refused-send case now expects the same wait.

After the fix, `npm test` passed all 17 files, `scripts/task-check.mjs` passed all 115 checks, and `scripts/remote-ui-check.mjs` passed 28 checks and 216 layout views at 320 to 1280 px on the served bundle `assets/remote-Rjec72eF.js` (HTTP 200). `npm run tauri build` built the installer, and `scripts/remote-check.mjs` passed on the release `loom.exe` and its embedded bundle at 320, 375, 768, 1024 and 1280 px, with the real whisper.

## Remaining finding

### P2: Lost acknowledgements can repeat an accepted prompt

`src/remote/agents.ts:705` awaits `act()` but does not use its failure result. The dictation callback returns that fulfilled promise, so the next clip proceeds after an uncertain send outcome. The first draft remains in the box.

Reproduction against the fresh served bundle `assets/remote-DPKHVIed.js`, HTTP 200:

1. Enable an automatic Enter dictation prefix and record two clips while holding the first transcription.
2. Return `first sentence` for the first clip and `second sentence` for the next clip.
3. Have the submit endpoint accept the first keyed request once, but return truncated JSON for all four attempts using that key. Model the existing same-key task deduplication.
4. Answer the next request normally.

The endpoint accepted two distinct tasks: `/prompt first sentence` and `/prompt first sentence second sentence`. There were five submit attempts: four with the first key and one with a new key. Thus same-key retries are safe, but the next automatic send repeats already accepted text under a new key.

Keep subsequent clips as drafts after an uncertain send, or reconcile the original keyed request before resuming automatic sends. Preserve all transcript text. A definitive refusal and a lost acknowledgement have different outcomes.

## Validation

`npm run build`, all 17 unit test files, and the full `scripts/remote-ui-check.mjs` suite passed. The browser suite checked 216 layout states at 320, 375, 768, 901, 1024 and 1280 pixels. Recording and settings screenshots were inspected. Native integration was not rerun in this review.
