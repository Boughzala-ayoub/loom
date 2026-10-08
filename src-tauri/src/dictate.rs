//! Click-to-dictate. cpal captures the mic, whisper.cpp turns it into text, and
//! the pane that asked gets it. Handy's other half — a global hotkey plus
//! system-wide text injection — has nothing to do here: Loom already owns the
//! pty, so the text goes back to the webview and out through `pty_write`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// The only rate whisper accepts.
const RATE: u32 = 16_000;
/// Multilingual base: ~142 MB, about a second of CPU per utterance. Drop any
/// other ggml-*.bin in the models dir to override it (large-v3-turbo is the
/// one to reach for if base fumbles your flags and paths).
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
// The language comes from the toolbar's picker; `None` there means whisper runs
// its own detection pass per clip.
/// Sinc lobes each side of a resampled sample. 16 is transparent for speech.
const LOBES: f64 = 16.0;
/// Drop segments whisper itself scores as more likely silence than speech.
/// Room tone otherwise comes back as a confident "Yes." or "Thank you." — its
/// favourite ghosts — and no amplitude gate catches that: a quiet room here
/// still measures rms 0.02, louder than a soft-spoken sentence elsewhere.
/// 0.6 is whisper.cpp's own no_speech_thold default.
const NO_SPEECH: f32 = 0.6;

#[derive(Default)]
pub struct Dictation {
    rec: Mutex<Option<Rec>>,
    ctx: Mutex<Option<WhisperContext>>,
}

struct Rec {
    samples: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
    rate: u32,
    channels: usize,
    /// How far `dictate_level` has already looked, so each poll reports the
    /// peak of what arrived since the last one instead of the whole clip.
    read: usize,
}

/// Start capturing. The model loads on a second thread meanwhile, so the first
/// click's download waits out your sentence instead of following it.
pub fn dictate_start(app: AppHandle, state: State<Dictation>) -> Result<(), String> {
    let mut slot = state.rec.lock().unwrap();
    if slot.is_some() {
        return Ok(()); // already recording — stop is what ends it
    }
    let samples = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    {
        let (samples, stop) = (samples.clone(), stop.clone());
        std::thread::spawn(move || capture(samples, stop, tx));
    }
    let (rate, channels) = rx.recv().map_err(|_| "audio thread died".to_string())??;
    *slot = Some(Rec { samples, stop, rate, channels, read: 0 });
    drop(slot);

    std::thread::spawn(move || {
        if let Err(e) = ensure_ctx(&app) {
            eprintln!("dictate: {e}"); // the stop call re-runs this and reports it
        }
    });
    Ok(())
}

/// Loudest sample since the last call — what the overlay's wave is drawn from.
/// `0.0` when nothing is recording.
// ponytail: polled, not emitted. The webview asks ~16 times a second; an event
// per audio buffer would be an order of magnitude more IPC for the same wave.
// A sync command, on the main thread: try_lock, since dictate_start holds the
// slot while the audio device starts, and a poll must not wait that out.
#[tauri::command]
pub fn dictate_level(state: State<Dictation>) -> f32 {
    let Ok(mut slot) = state.rec.try_lock() else { return 0.0 };
    let Some(rec) = slot.as_mut() else {
        return 0.0;
    };
    let (lvl, end) = {
        let buf = rec.samples.lock().unwrap();
        // Stop drains the buffer, so a poll racing it can find it shorter.
        (peak(&buf[rec.read.min(buf.len())..]), buf.len())
    };
    rec.read = end;
    lvl
}

/// Stop, transcribe, hand back the text. `""` = nothing worth pasting.
pub fn dictate_stop(
    app: AppHandle,
    state: State<Dictation>,
    lang: Option<String>,
) -> Result<String, String> {
    let Some(rec) = state.rec.lock().unwrap().take() else {
        return Ok(String::new());
    };
    rec.stop.store(true, Ordering::Relaxed);
    // ponytail: the capture callback runs a buffer behind the mic, and you click
    // the moment you stop talking — without this pause the last syllable is the
    // one that goes missing.
    std::thread::sleep(std::time::Duration::from_millis(150));

    let raw = std::mem::take(&mut *rec.samples.lock().unwrap());
    clip(&app, &to_mono(&raw, rec.channels), rec.rate, lang.as_deref())
}

/// A clip the phone app recorded (remote.rs, docs/phone-dictation-study.md):
/// 16-bit samples at 16 kHz, mono. None yet means it just started recording,
/// so the model loads while you talk, as dictate_start has it do.
pub fn phone(app: &AppHandle, pcm: &[u8], lang: Option<&str>) -> Result<String, String> {
    if pcm.is_empty() {
        return ensure_ctx(app).map(|_| String::new());
    }
    let mono: Vec<f32> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
    clip(app, &mono, RATE, lang)
}

/// What the PC's mic and the phone's both end in: the gate, the model, whisper.
/// `""` = nothing worth pasting. The model's lock makes them take turns.
fn clip(app: &AppHandle, mono: &[f32], rate: u32, lang: Option<&str>) -> Result<String, String> {
    if silent(mono, rate) {
        return Ok(String::new());
    }
    let audio = resample(mono, rate);
    ensure_ctx(app)?;
    let state = app.state::<Dictation>();
    let slot = state.ctx.lock().unwrap();
    transcribe(slot.as_ref().ok_or("no model")?, &audio, lang)
}

/// A stray double-click, or a muted/dead mic: nothing to transcribe. Actual
/// non-speech is whisper's job to spot, see NO_SPEECH.
fn silent(mono: &[f32], rate: u32) -> bool {
    mono.len() < rate as usize / 5 || peak(mono) < 0.001
}

fn transcribe(ctx: &WhisperContext, audio: &[f32], lang: Option<&str>) -> Result<String, String> {
    let mut st = ctx.create_state().map_err(|e| e.to_string())?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(lang);
    p.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as _);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    st.full(p, audio).map_err(|e| e.to_string())?;
    Ok(clean(
        st.as_iter()
            .filter(|s| s.no_speech_probability() <= NO_SPEECH)
            .filter_map(|s| s.to_str_lossy().ok().map(|t| t.into_owned())),
    ))
}

/// Owns the cpal stream for its whole life: `Stream` is !Send on Windows, so it
/// can never be handed to the caller — this thread parks on `stop` instead.
fn capture(
    buf: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Result<(u32, usize), String>>,
) {
    let started = (|| -> Result<(cpal::Stream, u32, usize), String> {
        let dev = cpal::default_host()
            .default_input_device()
            .ok_or("no microphone")?;
        let sup = dev.default_input_config().map_err(|e| e.to_string())?;
        let (rate, channels) = (sup.sample_rate(), sup.channels() as usize);
        let cfg = sup.config();
        let err = |e| eprintln!("dictate: audio stream: {e}");
        let (a, b) = (buf.clone(), buf);
        let stream = match sup.sample_format() {
            cpal::SampleFormat::F32 => dev.build_input_stream(
                cfg,
                move |d: &[f32], _: &_| a.lock().unwrap().extend_from_slice(d),
                err,
                None,
            ),
            cpal::SampleFormat::I16 => dev.build_input_stream(
                cfg,
                move |d: &[i16], _: &_| {
                    b.lock()
                        .unwrap()
                        .extend(d.iter().map(|s| *s as f32 / 32768.0))
                },
                err,
                None,
            ),
            f => return Err(format!("unsupported sample format {f:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, rate, channels))
    })();

    match started {
        Err(e) => {
            let _ = tx.send(Err(e));
        }
        Ok((stream, rate, channels)) => {
            let _ = tx.send(Ok((rate, channels)));
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            drop(stream);
        }
    }
}

/// Load the model into the context cache unless it is already there. Called from
/// both start (to overlap the load with your sentence) and stop (which reports
/// what the background attempt swallowed).
fn ensure_ctx(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Dictation>();
    let mut slot = state.ctx.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let path = ensure_model(app)?;
    *slot = Some(
        WhisperContext::new_with_params(&path, WhisperContextParameters::default())
            .map_err(|e| format!("{}: {e}", path.display()))?,
    );
    Ok(())
}

/// Any *.bin under `<data dir>\models\` wins, so swapping models is a drag and
/// drop; otherwise the default is fetched once with Windows' own curl.exe — no
/// http crate, no second TLS stack in the binary. `.partial` + rename so a
/// killed download isn't mistaken for a model next time.
fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::data_dir(app).join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(p) = existing_model(&dir) {
        return Ok(p);
    }
    let part = dir.join("model.partial");
    // ensure_ctx holds the model lock through this, so every other dictation
    // waits on it: 20 s to connect, a minute under 1 KB/s, an hour in all.
    fetch(MODEL_URL, &part, 20, 60, 3600)?;
    let dst = dir.join(MODEL_URL.rsplit('/').next().unwrap_or("model.bin"));
    std::fs::rename(&part, &dst).map_err(|e| e.to_string())?;
    Ok(dst)
}

/// `url` into `part` with curl.exe, giving up when it can't connect within
/// `connect` seconds, moves under 1 KB/s for `stall` seconds, or runs past
/// `total`. On any failure `part` is removed, so the next dictation starts over.
fn fetch(url: &str, part: &Path, connect: u32, stall: u32, total: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("curl")
        .args(["-sSfL", "--connect-timeout", &connect.to_string(), "--speed-limit", "1024", "--speed-time", &stall.to_string(), "--max-time", &total.to_string(), "-o"])
        .arg(part)
        .arg(url)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(part);
        // 28: a deadline passed (the transfer stalled or ran too long); 7: no connection.
        let why = match out.status.code() { Some(28) => "it stalled or took too long", Some(7) => "it couldn't connect", _ => "curl failed" };
        return Err(format!(
            "model download failed ({why}); dictation tries again next time: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn existing_model(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "bin"))
}

fn to_mono(raw: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return raw.to_vec();
    }
    raw.chunks(channels)
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect()
}

fn peak(a: &[f32]) -> f32 {
    a.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// Mic rate → whisper's 16 kHz. Decimation only (no mic runs slower), so the
/// sinc is stretched by the ratio, putting the anti-alias cutoff at the output
/// Nyquist: taking every Nth sample instead would fold everything above 8 kHz
/// straight back into the speech band.
// ponytail: ~1.5M mul-adds per second of audio, i.e. milliseconds per clip.
// Not worth a resampler crate; if this ever shows up in a profile, rubato.
fn resample(input: &[f32], rate: u32) -> Vec<f32> {
    if rate == RATE || input.is_empty() {
        return input.to_vec();
    }
    let step = rate as f64 / RATE as f64; // input samples per output sample
    let half = (LOBES * step).ceil() as isize;
    let last = input.len() as isize - 1;
    (0..(input.len() as f64 / step) as usize)
        .map(|i| {
            let c = i as f64 * step;
            let (mut acc, mut norm) = (0.0, 0.0);
            for k in (c.floor() as isize - half)..=(c.floor() as isize + half) {
                let x = (k as f64 - c) / step; // distance in output samples
                let w = sinc(x) * window(x / LOBES);
                acc += w * input[k.clamp(0, last) as usize] as f64;
                norm += w;
            }
            (acc / norm) as f32
        })
        .collect()
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let pix = std::f64::consts::PI * x;
    pix.sin() / pix
}

/// Blackman over [-1, 1], zero outside — the taper that keeps the truncated
/// sinc from ringing.
fn window(x: f64) -> f64 {
    if x.abs() >= 1.0 {
        return 0.0;
    }
    let t = std::f64::consts::PI * (x + 1.0);
    0.42 - 0.5 * t.cos() + 0.08 * (2.0 * t).cos()
}

/// Join the segments, dropping whisper's non-speech tags ("[BLANK_AUDIO]",
/// "(wind blowing)") — those are annotations, not something you meant to type.
fn clean(segments: impl Iterator<Item = String>) -> String {
    let mut out = String::new();
    for s in segments {
        let t = s.trim();
        let tag = |a, b| t.starts_with(a) && t.ends_with(b);
        if t.is_empty() || tag('[', ']') || tag('(', ')') {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{clean, peak, resample, silent, to_mono, RATE};

    /// A server that answers 200 with one byte of a long body, then sends nothing more.
    #[test]
    fn a_model_download_that_stalls_ends_and_leaves_no_partial_file() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ggml-test.bin", server.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            let _ = s.read(&mut [0; 4096]);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nx");
            std::thread::sleep(std::time::Duration::from_secs(120)); // stalled, connection open
        });
        let part = std::env::temp_dir().join(format!("loom-model-stall-{}.partial", std::process::id()));
        let (done, got) = std::sync::mpsc::channel();
        let target = part.clone();
        let started = std::time::Instant::now();
        // Short deadlines for the test; the real download's are the same kind, longer.
        std::thread::spawn(move || { let _ = done.send(super::fetch(&url, &target, 2, 2, 30)); });
        let result = got.recv_timeout(std::time::Duration::from_secs(20)).expect("a stalled model download never ended");
        let err = result.unwrap_err();
        assert!(err.contains("model download failed (it stalled or took too long)"), "the failure says what failed: {err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
        assert!(!part.exists(), "a failed download left its partial file");
    }

    fn tone(hz: f64, rate: u32, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize)
            .map(|i| {
                (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin() as f32
            })
            .collect()
    }

    fn rms(a: &[f32]) -> f64 {
        (a.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / a.len() as f64).sqrt()
    }

    #[test]
    fn resample_keeps_speech_and_kills_aliases() {
        let speech = tone(1000.0, 48_000, 0.5);
        let out = resample(&speech, 48_000);
        assert_eq!(out.len(), RATE as usize / 2);
        assert!(
            (rms(&out) / rms(&speech) - 1.0).abs() < 0.05,
            "1 kHz should survive intact, got {}",
            rms(&out)
        );

        // 18 kHz is far above the 8 kHz output Nyquist: a plain "every 3rd
        // sample" decimator would hand it back as a 2 kHz whistle.
        let ultra = tone(18_000.0, 48_000, 0.5);
        let aliased = resample(&ultra, 48_000);
        assert!(
            rms(&aliased) < 0.05 * rms(&ultra),
            "ultrasound aliased into the speech band: {}",
            rms(&aliased)
        );

        assert_eq!(resample(&speech, RATE).len(), speech.len()); // already 16k: untouched
    }

    #[test]
    fn mono_mix_and_silence_gate() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[1.0, 0.0], 1), vec![1.0, 0.0]);
        assert!(peak(&[0.0, -0.0004, 0.0002]) < 0.001); // dead mic, never sent to whisper
        assert!(peak(&[0.0, -0.2]) > 0.001);
    }

    /// The gate both stops share: under 0.2 s or silent never reaches whisper.
    #[test]
    fn short_or_silent_clips_are_not_transcribed() {
        let speech = tone(300.0, RATE, 1.0);
        assert!(!silent(&speech, RATE));
        assert!(silent(&speech[..RATE as usize / 5 - 1], RATE), "a tap, not a sentence");
        assert!(!silent(&speech[..RATE as usize / 5], RATE));
        assert!(silent(&vec![0.0004; RATE as usize], RATE), "a dead mic");
        assert!(silent(&[], RATE));
        // The PC's mic runs at its own rate: 0.2 s of it, not 3200 samples.
        assert!(silent(&tone(300.0, 48_000, 0.1), 48_000));
    }

    /// The capture path end to end on the real default device: start the thread,
    /// record a second, stop it. Ignored — a machine with no microphone can't
    /// run it. Silence is fine, the point is that samples arrive at all.
    #[test]
    #[ignore]
    fn captures_a_second_of_audio() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc, Mutex};

        let buf = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let (b, s) = (buf.clone(), stop.clone());
        let t = std::thread::spawn(move || super::capture(b, s, tx));

        let (rate, channels) = rx.recv().unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        stop.store(true, Ordering::Relaxed);
        t.join().unwrap();

        let got = buf.lock().unwrap().clone();
        let n = got.len();
        let want = rate as usize * channels;
        let rms = (got.iter().map(|s| (s * s) as f64).sum::<f64>() / n.max(1) as f64).sqrt();
        println!(
            "{n} samples in 1 s at {rate} Hz x{channels} — peak {:.4}, rms {rms:.4}",
            super::peak(&got)
        );
        assert!(n > want / 2 && n < want * 2, "expected about {want}, got {n}");
    }

    /// The whisper glue itself — params, segment iteration, tag filtering — on a
    /// real clip. Ignored by default: it needs a model and a wav, which no test
    /// run should be downloading.
    ///
    ///   LOOM_MODEL=...\ggml-base.bin LOOM_WAV=...\jfk.wav \
    ///     cargo test --lib -- --ignored --nocapture
    #[test]
    #[ignore]
    fn transcribes_a_real_clip() {
        use super::{transcribe, WhisperContext, WhisperContextParameters};
        let model = std::env::var("LOOM_MODEL").expect("set LOOM_MODEL");
        let wav = std::fs::read(std::env::var("LOOM_WAV").expect("set LOOM_WAV")).unwrap();
        // 16-bit PCM after the "data" chunk header; the samples are the point,
        // not the format, so no wav crate.
        let at = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let pcm: Vec<f32> = wav[at..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();

        let ctx =
            WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let text = transcribe(&ctx, &pcm, Some("en")).unwrap();
        println!("transcript: {text}");
        assert!(!text.is_empty(), "no text came back");
        assert!(!text.contains('['), "non-speech tag leaked: {text}");
    }

    #[test]
    fn clean_drops_non_speech_tags() {
        let segs = [" [BLANK_AUDIO]", " Run npm run build.", "(clears throat)", " "];
        assert_eq!(
            clean(segs.iter().map(|s| s.to_string())),
            "Run npm run build."
        );
    }
}
