# Phone dictation timing fix review

Reviewed `96c1d6d..fcf8e89` on 2026-10-07. No new actionable findings in this range.

The previous timing finding is closed by `b2c0b42`. The new `outgoing` map identifies the message already being sent for each agent. Starting a recording during that send now treats the recording as its own message. The landing callback still checks the box after the preceding send settles, so a retained draft from a refused or unanswered send prevents automatic resubmission.

The original reproduction at `.cache/review-dictation-next-during-send.mjs` now passes against fresh `assets/remote-CjrHUtvi.js`, served with HTTP 200. Its two submits are `/prompt first sentence` and `/prompt second sentence`, the draft clears, and there are no browser errors.

The full browser suite also passes both lost-acknowledgement cases: recording the second clip before the first transcription lands, and recording it while the first send is pending. Four attempts with the original key create one accepted task, and the next clip stays beside the unanswered text in the draft.

## Validation

- `npm test`: all 17 test files passed.
- `npm run build`: passed, producing `assets/remote-CjrHUtvi.js`.
- Original recording-during-send reproduction: passed.
- `node scripts/remote-ui-check.mjs`: passed in full, including cancellation, unpairing, recorder failure, clip order, delayed recorder stop, automatic sends, lost acknowledgements and navigation.
- All 216 layout states passed at 320, 375, 768, 901, 1024 and 1280 pixels. Inspected the 375-pixel recording and 901-pixel settings screenshots.
- `git diff --check 96c1d6d..fcf8e89`: passed.

The browser checks use the built frontend with mocked API responses. Native integration was not rerun in this review. Production source was not changed.
