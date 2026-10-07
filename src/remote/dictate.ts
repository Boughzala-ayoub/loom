/** Dictation on the phone (docs/phone-dictation-study.md): the page records, Loom's whisper on the PC
 * turns the clip into text (POST /api/dictate, remote.rs), and the text comes back for the Message box,
 * with the language and prefix the PC's mic uses. */
import { app, el, hooks, iconButton, run, sleep, store, toast, button, ui } from "./core";

export type Lang = { label: string; code: string; on: boolean };
export type Prefix = { text: string; enter: boolean; on: boolean };
/** `loomctl dictation`: the PC's two lists, each with its pick. */
export type Lists = { langs: Lang[]; prefixes: Prefix[] };
export type Pick = { lang: Lang | null; prefix: Prefix | null };

/** The lists as Loom last told them. */
export let lists: Lists | null = null;
export const picked = (l = lists): Pick => ({ lang: l?.langs.find((x) => x.on) ?? null, prefix: l?.prefixes.find((x) => x.on) ?? null });
export async function readLists() {
  const got = await run<Lists>("dictation");
  if (Array.isArray(got?.langs) && Array.isArray(got?.prefixes)) lists = got;
  return lists;
}
/** "English · /prompt ⏎": what the next clip will use. */
export const pickLabel = (p = picked()) => `${p.lang?.label ?? "English"} · ${p.prefix?.text.trim() || "no prefix"}${p.prefix?.enter ? " ⏎" : ""}`;

/** The most one clip holds: 3 minutes of 16-bit samples at 16 kHz is 5.5 MiB, under /api/dictate's 6. */
const LIMIT_MS = 180_000;
const RATE = 16_000;
const BARS = 24;

/** The recording bar, in the Message box's place while you talk: cancel, the wave and the time, stop. */
export const bar = el("div");
bar.id = "rec";
bar.hidden = true;
const cancelBtn = iconButton("close", "Cancel dictation", () => stopNow?.(false));
const wave = el("div", "wave");
wave.append(...Array.from({ length: BARS }, () => el("i")));
const time = el("b", "", "0:00");
const what = el("span");
const info = el("span", "info");
info.append(time, what);
const mid = el("div", "mid");
mid.append(wave, info);
const stopBtn = button(ui("stop"), () => stopNow?.(true), "stop");
stopBtn.setAttribute("aria-label", "Stop and transcribe");
bar.append(cancelBtn, mid, stopBtn);

/** The running clip's stop: send it to be transcribed (`by` says whether you asked, so ⏎ may send), or drop it. */
let stopNow: ((send: boolean, byHand?: boolean) => void) | null = null;
export const recording = () => !!stopNow;
/** Clips on their way to whisper. */
let busy = 0;
export const transcribing = () => busy > 0;
/** Set by agents.ts: repaint the mic as recording and transcribing come and go. */
export const repaint = { mic: () => {} };

// Hiding the page (another app, a call, the lock button) or leaving the agent ends the clip and
// transcribes what it caught: a microphone never stays open behind your back.
document.addEventListener("visibilitychange", () => { if (document.hidden) stopNow?.(true, false); });
window.addEventListener("hashchange", () => stopNow?.(true, false));

/** Records until stopped, then hands what whisper heard to `land`, with the pick it was made with
 * and whether you stopped it yourself. A cancel uploads nothing. */
export async function record(land: (text: string, pick: Pick, byHand: boolean) => void) {
  if (stopNow) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return toast("This browser can't record here. Open Loom's https address in Chrome.", true);
  let byHand = true;
  const stopped = new Promise<boolean>((resolve) => (stopNow = (send, hand = true) => { stopNow = null; byHand = hand; resolve(send); }));
  // Made in the tap, so it may play: the chimes and the wave.
  const audio = new AudioContext();
  const pick = readLists().then(picked, () => picked()); // the PC's pick now; the last one read if Loom can't say
  void pick.then((p) => (what.textContent = pickLabel(p)));
  what.textContent = pickLabel();
  time.textContent = "0:00";
  draw(0);
  bar.hidden = false;
  repaint.mic();
  void post(new Int16Array(0), "").catch(() => {}); // Loom loads the model while you talk
  const asked = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const stream = await Promise.race([asked, stopped.then(() => null)]).catch((e: Error) => e);
  if (!(stream instanceof MediaStream)) {
    // Stopped while the microphone opened: it closes as soon as it has.
    void asked.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
    stopNow = null;
    bar.hidden = true;
    repaint.mic();
    void audio.close();
    if (stream instanceof Error) toast(stream.name === "NotAllowedError" ? "The microphone is blocked for this page: allow it in the browser's site settings." : `The microphone didn't open: ${stream.message}`, true);
    return;
  }
  const rec = new MediaRecorder(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const ended = new Promise((r) => (rec.onstop = r));
  rec.start();
  const began = performance.now();
  // Phones turn the screen off after 30 s without a touch, and nobody touches it while talking.
  const lock = navigator.wakeLock?.request("screen").catch(() => null);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  void audio.resume().catch(() => {});
  chime(audio, 660, 990);
  navigator.vibrate?.(20);
  const tick = setInterval(() => {
    analyser.getFloatTimeDomainData(frame);
    draw(frame.reduce((m, s) => Math.max(m, Math.abs(s)), 0));
    const ms = performance.now() - began;
    const s = Math.floor(ms / 1000);
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (ms >= LIMIT_MS) {
      toast("Three minutes is the most one clip holds: it stopped there.");
      stopNow?.(true);
    }
  }, 60);
  const send = await stopped;
  clearInterval(tick);
  rec.stop();
  await ended;
  stream.getTracks().forEach((t) => t.stop());
  void lock?.then((l) => l?.release()).catch(() => {});
  chime(audio, 990, 660);
  setTimeout(() => void audio.close().catch(() => {}), 400);
  bar.hidden = true;
  if (!send) return repaint.mic();
  busy++;
  repaint.mic();
  try {
    const clip = new Blob(parts, { type: rec.mimeType });
    if (!clip.size) return toast("Nothing was recorded.");
    const p = await pick;
    land(await post(await decode(clip), p.lang?.code ?? "en"), p, byHand);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    busy--;
    repaint.mic();
  }
}

/** The bars: the mic's own peak, tapered to the ends and rippling outward, flat while you don't talk
 * (the PC's wave, main.ts waveShow). */
let phase = 0;
function draw(peak: number) {
  const amp = Math.min(1, Math.sqrt(peak) * 1.3);
  phase += 0.45;
  [...wave.children].forEach((b, i) => {
    const bell = Math.sin(((i + 0.5) / BARS) * Math.PI);
    const ripple = 0.55 + 0.45 * Math.sin(phase - i * 0.5);
    (b as HTMLElement).style.transform = `scaleY(${(0.08 + 0.92 * amp * bell * ripple).toFixed(3)})`;
  });
}

/** The PC's cue (main.ts chime): rising as the mic opens, falling as it closes. */
function chime(audio: AudioContext, from: number, to: number, peak = 0.09, len = 0.18) {
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.setValueAtTime(to, t + len * 0.3);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + len + 0.01);
}

/** The recording as whisper takes it: 16 kHz mono 16-bit samples. Chrome resamples while it decodes. */
async function decode(clip: Blob) {
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await clip.arrayBuffer()).catch(() => {
    throw new Error("The recording couldn't be read on this phone.");
  });
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    pcm[i] = Math.max(-1, Math.min(1, s / channels.length)) * 0x7fff;
  }
  return pcm;
}

/** The clip to Loom, and what whisper heard. A connection lost on the way is tried again: the clip
 * is still here, and transcribing it twice changes nothing. */
async function post(pcm: Int16Array, lang: string) {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api/dictate${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/octet-stream" },
        body: pcm,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      if (attempt < 2 && pcm.length) { await sleep(1500); continue; }
      throw new Error("Can't reach Loom, so nothing was transcribed. Is the PC on, and Tailscale connected on both?");
    }
    const reply = await res.json().catch(() => null);
    if (res.status === 401) {
      store("");
      hooks.unpaired();
    }
    if (!reply?.ok) throw new Error(reply?.error ?? `Loom isn't answering (${res.status}).`);
    return String(reply.text ?? "");
  }
}
