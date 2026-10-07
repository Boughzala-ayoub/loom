# Dictation on the phone

Study, 2026-10-07. The goal is Loom's dictation in the phone app. You tap a
mic on an agent's screen, talk, and the words land in its Message box, with
the languages and prefixes you keep on the PC.

## What happens now

On the PC, F4 or the Speak button records the PC's microphone with cpal,
whisper.cpp turns the clip into text on the PC, and Loom pastes it into the
focused agent pane (`src-tauri/src/dictate.rs`, `micStart` and `micStop` at
`src/main.ts:1505` and `:1529`). The prefix (`/prompt ` by default) is typed
into the pane when recording starts. A prefix marked `⏎` presses Enter once
the text lands. The language list starts with English, auto, French, Arabic,
Spanish and German, and takes any other whisper code. Both lists live in
`workspaces.json`. The model is `ggml-base.bin` in
`%APPDATA%\dev.ayoub.loom\models`.

The phone app has none of this. `docs/phone-remote-study.md:180` settled on
the phone keyboard's microphone. That works today, since Gboard's mic types
into the Message box. It misses what makes Loom's version good for prompts:

- No prefix, so a dictated prompt goes out bare instead of as `/prompt …`.
- No `⏎`, so you always tap Send.
- Google's recognizer, not the whisper model and language list you set up on
  the PC.
- You open the keyboard first, and it covers half the agent's screen.

## Where the speech becomes text

| Where | Cost | Verdict |
| --- | --- | --- |
| Gboard's mic | Nothing, it works now | The baseline above |
| The Web Speech API in the page | About 40 lines | Chrome on Android sends the audio to Google's recognizer, as Gboard does. It adds prefixes, not Loom's model |
| whisper in the phone's browser (WebAssembly) | A 142 MB model per phone, and the phone's CPU doing the PC's job | Slower and heavier for nothing. The PC has to be on for the phone app anyway |
| The phone records, the PC's whisper transcribes | About 60 lines of Rust and 200 of TypeScript, no new crates or packages | Recommended |

The last one reuses everything `dictate.rs` does after the microphone: the
silence gate, the model cache, the `no_speech` filter and the tag cleanup.
Only the capture moves to the phone.

## How it works

1. You tap the mic in the dock. The page asks for the microphone (Chrome asks
   once for the site), starts a `MediaRecorder`, takes a screen wake lock, and
   plays the PC's rising chime with a short vibration. It also sends Loom an
   empty `POST /api/dictate`, which loads the model on a thread while you
   talk, as `dictate_start` does.
2. While you talk, the Message box turns into a recording bar: a cancel ✕,
   the wave, the time, and a stop button where the mic was. The wave comes
   from a Web Audio `AnalyserNode` on the phone, so nothing polls the PC.
3. You tap stop. The page decodes the recording to 16 kHz mono with
   `OfflineAudioContext.decodeAudioData`, converts it to 16-bit samples, and
   posts them as the raw body of `POST /api/dictate?lang=fr`. No `lang` means
   detect.
4. Loom checks the phone's token. On a blocking thread it converts the samples
   to floats, applies the gate `dictate_stop` uses (under 0.2 s or silent
   gives `""`), loads the model if needed and transcribes. The reply is the
   text. The audio never reaches the PC's window or loomctl.
5. The page puts the prefix and the text in the box. A `⏎` prefix sends it
   through the existing `submit` path (`src/remote/agents.ts:681`). Otherwise
   it waits for your Send.

I ran step 3 in headless Chrome with a fake microphone. A 2-second recording
came out as `audio/webm;codecs=opus`, 24 KB. `decodeAudioData` on a 16 kHz
`OfflineAudioContext` returned 1.98 s of mono at 16 kHz in 7 ms, 63 KB to
upload. Chrome resamples during the decode, so the phone needs no resampler,
and the PC's `resample` sees 16 kHz and hands the samples back untouched. Your
phone's real microphone still needs a try (phase 1).

### Upload size

16-bit samples at 16 kHz are 32 KB a second, 1.9 MB a minute. On Wi-Fi a
minute uploads in under a second. On a 2 Mbit/s mobile uplink it takes about
8 seconds, which you wait out after tapping stop.

`remote.rs` refuses bodies over 1 MiB (`BODY`, line 25) and gives a client 10
seconds to send its whole request (`FRAME`, line 27). `/api/dictate` gets its
own limits, 6 MiB and 60 seconds, and the phone stops recording at 3 minutes
so a clip always fits. `read` (line 244) knows the path once it has the head,
so it picks the limit there. `/api/cli` keeps 1 MiB.

Opus is 2.6 times smaller (12 KB a second in the check above). Loom has no
Opus decoder, though, and adding one puts a C library in the build. Raw
samples keep the Rust side to a cast. If uploads on mobile data turn out slow,
the upgrade is one-second chunks sent while you talk, so stop only waits for
whisper.

### Text goes in the box, not the pane

The PC types the prefix into the pane at the start and pastes the text there,
because the pane is its only input. The phone has its own box, and a send
from it is already a tracked task. So the phone builds the message in the box:

- You see what whisper heard before it goes, and can fix a misheard path.
- No prefix needs backspacing out when you said nothing. The PC has to
  (`main.ts:1564`).
- The prefix goes first only when the box was empty as you tapped the mic.
  Dictating onto a draft appends the text after a space.
- The mic shows on agent panes only, as the PC's Speak button does. A
  `/prompt ` typed into PowerShell is an error.

### A late transcript

whisper takes a second or more after the upload, and you can open another
agent meanwhile. The phone review's rule applies here: a late completion must
check it still owns the screen. The clip remembers the agent it started on
(`draftKey`, `agents.ts:426`). If that agent is still open, the text goes in
the box and a `⏎` prefix sends it. If you moved, the text becomes that
agent's draft (`typed`, `agents.ts:425`). It is never sent on its own, and a
toast says where it went.

### When the page goes away

Hiding the page stops the recording and transcribes what it caught. That
covers switching apps, a phone call and locking the phone. The PC does the
same when you leave the window holding F4, so a mic never stays open behind
your back.

Many Android phones turn the screen off after 30 seconds without a touch, and
you don't touch the screen while you talk. Hence the wake lock, which ends
with the recording. `navigator.wakeLock` was there in the same check.

### Languages and prefixes

Both lists stay on the PC (`main.ts:1422` and `:1433`, saved with the
workspace). A new `loomctl dictation` command, shaped like `startups`, gives
the phone them:

| Command | What it does |
| --- | --- |
| `dictation` | The languages, the prefixes and which of each is picked |
| `dictation lang <code\|auto>` | Pick a language, adding it if new |
| `dictation prefix <text> [--enter on\|off]` | Pick a prefix, adding it if new, and set its `⏎` |
| `dictation remove lang <code>`, `dictation remove prefix <text>` | Drop one. The last one stays |

It runs the same code as the PC's mic menu (`speakMenu`, `main.ts:7703`), so
the menu, `workspaces.json` and the phone agree. There is one pick. Choosing
French on the phone chooses it on the PC.

On the phone, the pane's Actions sheet gets a row "Dictation · English ·
/prompt" that opens a sheet with both lists, laid out like the PC's mic menu.
The Settings tab opens the same sheet. The recording bar names the language
and prefix in use, so a wrong pick shows before you talk for a minute.

### Where the mic sits

The dock becomes keys, Message, mic, Send, every button 44 px. At 320 px the
box keeps about 140 px. The Activity reply boxes and the New agent prompt can
take the same button later, since the module takes any textarea.

## What changes where

| File | Change |
| --- | --- |
| `src-tauri/src/dictate.rs` | The part of `dictate_stop` after capture (gate, model, `transcribe`) becomes one function that the PC's stop and the phone's route both call. A `warm` that loads the model on a thread |
| `src-tauri/src/remote.rs` | `POST /api/dictate`: token check, an empty body warms, a body of samples is transcribed on a blocking thread. `read` picks the body limit and deadline by path |
| `src/main.ts` | The `dictation` loomctl command |
| `src/main_cli.test.ts` | New names in its fixture |
| `src/remote/dictate.ts` (new) | Record, wave, wake lock, decode, upload, and putting the text where it belongs |
| `src/remote/agents.ts` | The mic in the dock, the Actions row |
| `src/remote/settings.ts` | The Dictation sheet |
| `src/remote.css` | The mic and the recording bar |
| `docs/loomctl.md`, `README.md` | `dictation`, and dictation on the phone |

## Tests

- **Rust.** The gate on the new function (short or silent gives `""`), and
  `read` answering 413 past 6 MiB on `/api/dictate` while `/api/cli` still
  stops at 1 MiB.
- **`scripts/remote-ui-check.mjs`, mocked.** Chrome launched with
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, which is
  how the check above ran, through `channel: 'chrome'`. The mocked
  `/api/dictate` checks the body runs at 32 KB a second and the `lang` query,
  and answers with text. Then the text and prefix land in the box, a `⏎`
  prefix calls `submit`, a transcript that arrives after you opened another
  agent becomes that agent's draft, hiding the page stops the recording, and
  cancel uploads nothing. The recording bar and the Dictation sheet at every
  width.
- **`scripts/remote-check.mjs`, real Loom.** A WAV of a spoken sentence from
  Windows' own speech synthesizer (`System.Speech`), fed in with
  `--use-file-for-fake-audio-capture`, through the real whisper. The
  transcript has to contain the sentence's words.
- **On your phone.** The microphone prompt, the screen staying on through a
  minute, a minute's upload on mobile data, Arabic and French.

## Phases

| Phase | Gets you | Size |
| --- | --- | --- |
| 1. `/api/dictate`, `dictate.ts`, the mic in the dock, `loomctl dictation` reading the PC's pick | Dictation on the phone with the PC's language and prefix, tried on your phone | Half a day |
| 2. The `dictation` subcommands, the Dictation sheet in Actions and Settings | Languages and prefixes changed from the phone | 2 hours |
| 3. The mocked and real-Loom tests above | Every width and the late-transcript cases covered | 2 hours |

## Limits

- The PC has to be on with Loom running, as for everything on the phone.
- The phone and the PC share the model's lock. A phone clip that ends during
  an F4 transcription on the PC waits for it, a second or two.
- `ggml-base.bin` fumbles flags and paths on the phone exactly as on the PC.
  A larger model in `models\` fixes both, and makes every clip slower.
- Tap to start and tap to stop, not hold. Holding a finger still on glass for
  a minute is harder than holding F4.

## To decide

- One language and prefix pick shared by the PC and the phone, as above, or a
  pick per phone kept in the phone's own storage.
