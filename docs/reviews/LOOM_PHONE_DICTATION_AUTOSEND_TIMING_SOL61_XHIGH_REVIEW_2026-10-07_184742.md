# Phone dictation automatic send timing review

Reviewed `21ce67c..96c1d6d` on 2026-10-07. The lost-acknowledgement duplication is fixed against its reported scenario. One new regression remains.

## Status

Fixed in `b2c0b42`. The cause was `wasEmpty`. It counted a message still being sent as a draft, so a clip recorded during that send lost its prefix as well as its automatic Enter. With the prefix decision unchanged and automatic sending decided only as the clip lands, the clip in the reported scenario would have sent `second sentence` without `/prompt `. The box now remembers what it is sending (`outgoing` in `src/remote/agents.ts`), and text on its way no longer counts as a draft as you tap. Whether the clip sends is still decided as it lands, after the send before it has settled. Alone in the box, it goes after its prefix. Behind text whose send was refused or never answered, it joins that text and waits for Send, so the lost-acknowledgement guard holds.

The regression check is in `scripts/remote-ui-check.mjs`. It holds the first clip's submit while the second is recorded. On `3af3ea1` it timed out with only `/prompt first sentence` sent. On `b2c0b42` the submits are `/prompt first sentence`, then `/prompt second sentence` once the first answers, and the box empties. The same case then loses every answer to a third send while a fourth is recorded. The agent gets the third once, after four tries with one key, and the box holds `/prompt third sentence fourth sentence`. `.cache/review-dictation-next-during-send.mjs` passes on the fixed bundle, with `["/prompt first sentence","/prompt second sentence"]` sent and no errors.

After the fix, `npm test` passed all 17 files, `scripts/task-check.mjs` passed all 115 checks, and `scripts/remote-ui-check.mjs` passed 29 checks and 216 layout views at 320 to 1280 px on the served bundle `assets/remote-CjrHUtvi.js` (HTTP 200). `npm run tauri build` built the installer, and `scripts/remote-check.mjs` passed on the release `loom.exe` and its embedded bundle at 320, 375, 768, 1024 and 1280 px, with the real whisper.

## P2: Recording the next clip during a successful send disables automatic Enter

`src/remote/agents.ts:740` makes `alone` depend on `wasEmpty`, captured when recording starts at line 733. Line 749 now requires `alone` before automatically sending. If the preceding clip's submit is still awaiting its reply, its text is in the box when the next recording starts, so `wasEmpty` is false. The queue correctly waits for that submit. A successful reply clears the box before the next transcript lands, but `wasEmpty` stays false and the next clip never automatically sends.

Reproduced against fresh `assets/remote-Rjec72eF.js`, served with HTTP 200 in headless Chrome:

1. Enable an automatic Enter prefix and record `first sentence`.
2. Let its transcription land and hold the successful submit reply. The box contains `/prompt first sentence`.
3. Record `second sentence` while that reply is held. Let its transcription answer while it waits in the queue.
4. Release the successful first reply.

Observed one submit, `/prompt first sentence`, with `second sentence` left in the box. Both recordings were stopped by hand on the same visit. No browser errors occurred. The runnable check at `.cache/review-dictation-next-during-send.mjs` fails its assertion that both automatic Enter clips send after successful replies.

Before this change, automatic sending did not require the recording-start `wasEmpty` value. Keep that prefix decision separate from automatic-send eligibility. Decide whether the clip is the whole pending message after the preceding send settles. An unanswered send's retained draft must still prevent automatic resubmission under a new key.

The existing successful-two-clips check records the second clip before the first transcription lands, so the box is empty at both recording starts. It does not cover a second recording begun during the first submit.

## Validation

- `npm test`: all 17 test files passed.
- `npm run build`: passed, producing `assets/remote-Rjec72eF.js`.
- `node scripts/remote-ui-check.mjs`: passed in full, including the lost-acknowledgement regression and 216 layout states at 320, 375, 768, 901, 1024 and 1280 pixels.
- Inspected the 375-pixel recording and 901-pixel settings screenshots.
- `git diff --check 21ce67c..96c1d6d`: passed.

Native integration was not rerun. Production source was not changed during this review.
