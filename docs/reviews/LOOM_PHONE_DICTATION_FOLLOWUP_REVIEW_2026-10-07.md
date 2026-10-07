# Loom phone dictation follow-up review

Reviewed the phone dictation fixes through `2bd2100` on 2026-10-07, after `docs/reviews/LOOM_PHONE_DICTATION_FIXES_REVIEW_2026-10-07.md`. Scope is `src/remote/dictate.ts` and the Message box's submit flow in `src/remote/agents.ts`.

The earlier pairing and `MediaRecorder` failure cases now pass. The dictation checks and all 216 layout checks were replayed against an isolated copy of the served bundle `assets/remote-BRS9CSGT.js`, with HTTP 200, and TypeScript checking passed. Two targeted cases with overlapping clips still fail.

## Status

Both are fixed, each in its own commit with its regression check in `scripts/remote-ui-check.mjs`. Each check failed on the commit before its fix and passes after it.

- 1: `03284c6`. A clip takes its place in line as you tap, and a `finally` around the whole clip gives it up.
- 2: `7c9e122`. A dictated `⏎` sends through `sendPrompt()`, and the clip keeps its place in line until that send has settled.

After the fixes, `npm test` passed all 17 files, `scripts/task-check.mjs` passed all 115 checks, and `scripts/remote-ui-check.mjs` passed 27 checks and 216 layout views at 320 to 1280 px on the served bundle `assets/remote-DPKHVIed.js`. `npm run tauri build` built the installer, and `scripts/remote-check.mjs` passed on the release `loom.exe` and its embedded bundle at 320, 375, 768, 1024 and 1280 px, with the real whisper. Its first run stopped at "Loom must start and answer loomctl", because the test Loom took more than 30 s to start. The rerun passed in full.

## 1. [P2] Clip order still depends on recorder shutdown timing

In `src/remote/dictate.ts`, `end()` (lines 130-135) clears `stopNow` and hides the bar, which lets a second recording start. The first clip takes its place in the landing queue only at line 209, after it has awaited the recorder's `onstop` at line 193. If that callback is late, the second clip can queue first.

Reproduction: wrap the native `onstop` so the first clip's callback runs 2000 ms late. Record the first clip for 1000 ms, then the second for 350 ms with its callback on time. The API answers by clip length, so each text stays tied to its recording. Result: `/prompt second sentence first sentence`, with no page errors.

Expected: a clip takes its place in line before another recording can start, and a cancelled or failed clip still gives its place up. Recording another clip while the last one transcribes, per-agent drafts and the language and prefix snapshots stay as they are.

## 2. [P2] Overlapping clips can submit the first sentence twice

`src/remote/dictate.ts:219` calls `land()` synchronously and releases the queue at line 223. In `src/remote/agents.ts`, `land` calls `promptForm.requestSubmit()`, whose async handler clears the box only after the loomctl reply.

Reproduction: turn on the prefix's `⏎`. Record the first clip and hold its transcription. Record the second and let its transcription answer. Hold the first submit's reply and release the first transcription. The queue lands both clips at once, and `submit` is sent `/prompt first sentence` and then `/prompt first sentence second sentence`. The first sentence goes twice, and the second request clears the box while the first is still pending.

Expected: the next clip lands only after the submission it depends on, or each clip goes as its own message through the existing submit flow. Dropping the second clip while Send is disabled is not a fix. Drafts survive a failed send, and nothing is submitted after you navigate away.

## Logs on the reviewed code

From `node node_modules/.cache/dictation-fixes-review.mjs`, which reuses the `remote-ui-check` fixture and serves the built `dist/`:

```
AUTOENTER_OVERLAP {"submissions":["/prompt first sentence","/prompt first sentence second sentence"],"draft":"","errors":[]}
STOP_COMPLETION_ORDER {"draft":"/prompt second sentence first sentence","errors":[]}
```

The scratch runner also explores an `AudioContext` setup error. Only the two findings above were asked to be fixed.
