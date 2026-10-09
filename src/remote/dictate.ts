/** Dictation on the phone (docs/phone-dictation-study.md): the page records, Loom's whisper on the PC
 * turns the clip into text (POST /api/dictate, remote.rs), and the text comes back for the Message box,
 * with the language and prefix the PC's mic uses. */
import { act, app, BODY_MS, el, hooks, iconButton, run, sheet, sleep, store, toast, button, ui } from "./core";

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

/** The PC's mic menu on the phone: tap a row to pick it, ⏎ to have that prefix send what was said
 * (which picks it too), ✕ to drop one, or add one under its list. Each change is a loomctl dictation
 * command, so F4 and the PC's menu change with it. `after` runs after each change (Settings redraws). */
export function dictationSheet(after = () => {}) {
  const box = el("div", "dictation");
  const change = (argv: string[]) => void act(async () => {
    const got = await run<Lists>("dictation", argv, { change: true });
    if (Array.isArray(got?.langs) && Array.isArray(got?.prefixes)) lists = got;
    draw();
    after();
  });
  const row = (label: string, detail: string, on: boolean, pick: () => void, ...more: Node[]) => {
    const r = el("div", "dict-row");
    const b = button(on ? ui("check") : el("i"), pick, "pick");
    b.setAttribute("aria-pressed", String(on));
    const what = el("span", "what");
    what.append(el("b", "", label), el("span", "", detail));
    b.append(what);
    r.append(b, ...more);
    return r;
  };
  const adder = (placeholder: string, label: string, add: (v: string) => void) => {
    const form = el("form", "pair");
    const input = el("input");
    Object.assign(input, { placeholder, autocapitalize: "off", spellcheck: false });
    input.setAttribute("aria-label", label);
    form.append(input, el("button", "primary", "Add"));
    form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) add(input.value.trim()); };
    return form;
  };
  const draw = () => {
    const l = lists;
    if (!l) return box.replaceChildren(el("p", "hint", "Reading the PC's lists…"));
    // Keep one of each: an empty list leaves nothing to dictate with (main.ts langMenu, prefixMenu).
    const drop = (what: string, name: string, label: string, n: number) => (n > 1 ? [iconButton("close", `Remove ${label}`, () => change(["remove", what, name]))] : []);
    box.replaceChildren(
      el("p", "hint", "F4 on the PC uses the same pick."),
      el("p", "head", "Language"),
      ...l.langs.map((x) => row(x.label, x.code || "detected per clip", x.on, () => change(["lang", x.code || "auto"]), ...drop("lang", x.code || "auto", x.label, l.langs.length))),
      adder("Add a whisper code: ja, ko, hi", "Add a language", (v) => change(["lang", v])),
      el("p", "head", "Prefix"),
      ...l.prefixes.map((x) => {
        const name = x.text.trim(), label = name || "(no prefix)";
        const auto = iconButton("enter", `${label} sends what was said`, () => change(["prefix", name, "--enter", x.enter ? "off" : "on"]));
        auto.setAttribute("aria-pressed", String(x.enter));
        return row(label, x.enter ? "Sends what was said" : "Waits for Send", x.on, () => change(["prefix", name]), auto, ...drop("prefix", name, label, l.prefixes.length));
      }),
      adder("Add a prefix: /review", "Add a prefix", (v) => change(["prefix", v])),
    );
  };
  draw();
  void sheet([box], "Dictation", "Done");
  void readLists().then(draw, (e) => toast(e instanceof Error ? e.message : String(e), true));
}

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
/** Drops the running clip, a microphone still opening included: nothing is sent to be transcribed. */
export const cancel = () => stopNow?.(false);
/** Clips on their way to whisper. */
let busy = 0;
/** Settles once every clip sent so far has landed or failed: whisper may answer a later clip first, and
 * the text must still go in the order it was said. */
// ponytail: one queue for every agent, so a slow clip for one holds back another's. Per-agent queues if
// two agents are ever dictated to at once.
let landed: Promise<void> = Promise.resolve();
export const transcribing = () => busy > 0;
/** Set by agents.ts: repaint the mic as recording and transcribing come and go. */
export const repaint = { mic: () => {} };

// Hiding the page (another app, a call, the lock button) or leaving the agent ends the clip and
// transcribes what it caught: a microphone never stays open behind your back.
document.addEventListener("visibilitychange", () => { if (document.hidden) stopNow?.(true, false); });
window.addEventListener("hashchange", () => stopNow?.(true, false));

type Land = (text: string, pick: Pick, byHand: boolean) => void | Promise<void>;

/** Records until stopped, then hands what whisper heard to `land`, with the pick it was made with
 * and whether you stopped it yourself. A cancel uploads nothing. The next clip lands once `land`'s
 * promise, a send it started, has settled. */
export async function record(land: Land) {
  if (stopNow) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return toast("This browser can't record here. Open Loom's https address in Chrome.", true);
  // Its place in line, taken as you tap, before another clip can start: it lands after the clips before
  // it, and the next waits for it, however late a recorder stops or whisper answers. Every way out of
  // the clip, a cancel or a failure too, gives the place up.
  const before = landed;
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  landed = before.then(() => mine);
  try {
    await take(land, before);
  } finally {
    done();
  }
}

async function take(land: Land, before: Promise<void>) {
  let byHand = true;
  // Ends this clip once, whoever asks first: a tap, the page hiding, the recorder stopping by itself, or
  // the cleanup below. A later call is a no-op, so it never touches the next clip's bar or stop.
  let end!: (send: boolean, hand?: boolean) => void;
  const stopped = new Promise<boolean>((resolve) => (end = (send, hand = true) => {
    if (stopNow !== end) return;
    stopNow = null;
    bar.hidden = true;
    byHand = hand;
    resolve(send);
  }));
  stopNow = end;
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
    end(false);
    repaint.mic();
    void audio.close();
    if (stream instanceof Error) toast(stream.name === "NotAllowedError" ? "The microphone is blocked for this page: allow it in the browser's site settings." : `The microphone didn't open: ${stream.message}`, true);
    return;
  }
  const parts: Blob[] = [];
  let type = "", send = false, tick: number | undefined, lock: Promise<WakeLockSentinel | null> | undefined;
  // A recorder that fails to start, or anything after it, still closes the microphone and gives the box back.
  try {
    const rec = new MediaRecorder(stream);
    type = rec.mimeType;
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    // It stops by itself when its track ends (a call takes the microphone) or on an error: that ends the
    // clip as hiding the page does, transcribed and never sent on its own.
    const ended = new Promise((r) => (rec.onstop = () => { r(null); end(true, false); }));
    rec.start();
    const began = performance.now();
    // Phones turn the screen off after 30 s without a touch, and nobody touches it while talking.
    lock = navigator.wakeLock?.request("screen").catch(() => null);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(stream).connect(analyser);
    const frame = new Float32Array(analyser.fftSize);
    void audio.resume().catch(() => {});
    chime(audio, 660, 990);
    navigator.vibrate?.(20);
    tick = window.setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      draw(frame.reduce((m, s) => Math.max(m, Math.abs(s)), 0));
      const ms = performance.now() - began;
      const s = Math.floor(ms / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (ms >= LIMIT_MS) {
        toast("Three minutes is the most one clip holds: it stopped there.");
        end(true);
      }
    }, 60);
    send = await stopped;
    if (rec.state !== "inactive") rec.stop();
    await ended;
    chime(audio, 990, 660);
  } catch (e) {
    send = false;
    toast(`The microphone didn't record: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    end(false);
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    void lock?.then((l) => l?.release()).catch(() => {});
    setTimeout(() => void audio.close().catch(() => {}), 400);
  }
  if (!send) return repaint.mic();
  busy++;
  repaint.mic();
  let sending: void | Promise<void> = undefined;
  try {
    const clip = new Blob(parts, { type });
    if (!clip.size) return toast("Nothing was recorded.");
    const p = await pick;
    const text = await post(await decode(clip), p.lang?.code ?? "en");
    await before;
    sending = land(text, p, byHand);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    busy--;
    repaint.mic();
  }
  await sending; // transcribed: the mic is free while it is sent, the next clip's landing isn't
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

/** How long one try may take: all the time Loom gives the body (6 MiB arrives at 0.09 Mbps), then up to
 * 3 minutes of whisper on the PC, which may wait its turn for the model first. */
const POST_MS = BODY_MS + 180_000;

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
        signal: AbortSignal.timeout(POST_MS),
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
