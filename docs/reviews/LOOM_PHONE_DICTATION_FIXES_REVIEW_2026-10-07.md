# Loom phone dictation review

Reviewed the phone dictation commits `a38bdbb`, `886238a` and `5c4ae88` against `7ef92bf` on 2026-10-07. Scope is `src/remote/dictate.ts`, its use in `src/remote/agents.ts` and `src/remote.ts`, `/api/dictate` in `src-tauri/src/remote.rs`, and the checks in `scripts/remote-ui-check.mjs` and `scripts/remote-check.mjs`.

No tracked changes were present at the end of the review. The production build, all 17 TypeScript test files, the Rust suite (108 passed, 5 ignored) and `scripts/remote-ui-check.mjs` passed. That suite served the fresh `dist/` bundle, confirmed HTTP 200, and passed 216 layout checks at 320, 375, 768, 901, 1024 and 1280 px. Targeted checks against the same bundle found the three cases below, which the suite did not cover.

## Status

All three are fixed, each in its own commit with its regression check in `scripts/remote-ui-check.mjs`. Each check failed on the commit before its fix and passes after it.

- 1: `8e27a89`. `pairing()`, where every 401 lands, cancels the clip.
- 2: `c8b0939`. The recording runs in one `try`/`finally`, and the recorder stopping by itself ends the clip.
- 3: `2bd2100`. Clips land in the order they were recorded, and a failed clip holds up nothing.

After the fixes, `npm test` passed all 17 files, and `scripts/remote-ui-check.mjs` passed 25 checks and 216 layout views at 320 to 1280 px on the served `dist/` bundle. `npm run tauri build` built the installer. `scripts/remote-check.mjs` passed on the release `loom.exe` and its embedded bundle at 320, 375, 768, 1024 and 1280 px, with the real whisper.

## 1. [P1] Revoked pairing leaves the microphone recording with hidden controls

`src/remote/dictate.ts:254-256` calls `hooks.unpaired()` on a 401, and `pairing()` in `src/remote.ts` hides `#app` and shows `#pairing`. Nothing cancels the recording.

Reproduction: open an agent, make `/api/dictate` answer 401, then tap the mic. The empty warm-up request gets the 401 while the microphone opens. The pairing form shows, the recording bar is hidden with the rest of the app, and the `MediaStream` track stays live. The `visibilitychange` and `hashchange` listeners never fire, because neither the document nor the URL changed.

Expected: unpairing stops or cancels the capture, including a microphone that is still opening, on both the dictation 401 and the shared CLI 401 path. No recording or usable pending capture survives the switch to pairing.

## 2. [P2] Recorder startup failures bypass microphone cleanup

`src/remote/dictate.ts:143-147` makes and starts the `MediaRecorder` outside the `try`/`finally`, which covers only decoding and the upload.

Reproduction: end the returned `MediaStream`'s tracks just before recording begins. `start()` throws, the recording bar stays visible, and Cancel doesn't bring the prompt back. With a live stream and a `NotSupportedError` injected from `start()`, the track also stays live after Cancel.

Expected: capture setup and teardown sit under error handling that closes the tracks and the audio context, clears the stop state and timers, releases the wake lock and restores the UI on every exit. Recorder errors and a recorder that stops on its own belong to the same lifecycle. Cancelling while `getUserMedia` is pending keeps working, and a later retry works.

## 3. [P2] Overlapping clips can reverse the dictated text

`src/remote/dictate.ts:185` calls `land()` as each upload's reply arrives, and the mic takes the next clip while the last one is transcribing.

Reproduction: record "first sentence", hold its `/api/dictate` reply, record "second sentence" and let it finish, then release the first. The draft becomes `/prompt second sentence first sentence`.

Expected: results reach an agent in the order they were recorded. Recording another clip while the last one transcribes stays possible if a small ordered-delivery fix allows it. Per-agent drafts, the language and prefix snapshots, cancellation and the guards against sending after you navigate away stay as they are. A check holds the first reply until the second has arrived.

## Logs on the reviewed code

From `node node_modules/.cache/dictation-review.mjs`, which reuses the `remote-ui-check` fixture and serves the built `dist/`:

```
REVOKED_WHILE_OPENING {"pairingVisible":true,"barVisible":false,"live":["live"],"errors":[]}
ENDED_BEFORE_START {"barVisible":true,"errors":["Failed to execute 'start' on 'MediaRecorder': There was an error starting the MediaRecorder."]}
ENDED_BEFORE_START_CANCEL still had barVisible true.
ENCODER_ERROR_CANCEL {"barVisible":true,"live":["live"],"errors":["The encoder could not start"]}
CLIP_ORDER {"draft":"/prompt second sentence first sentence","clips":2,"errors":[]}
```

The scratch runner explores other edge cases too. Only the three findings above were asked to be fixed.
