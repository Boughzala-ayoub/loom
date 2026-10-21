/** Pane state events: what `loomctl watch --panes`, `wait --until` and
 * webhooks hear when a pane settles into a new state. The parts that need no
 * Loom state, so they run under plain node; main.ts feeds them from paint(). */
import { claudeDivider, hash32 } from "./prompt.ts";

/** How long a new state must stand before it counts. Output that pauses for a
 * tool call, or a blip that goes back to the old state, sends nothing; a turn
 * that ends in less than this sends waiting>waiting, or idle>idle if looked at at once. */
export const SETTLE_MS = 2000;
/** Events kept for readers that fall behind. */
export const KEEP_EVENTS = 500;
/** How much of the screen an event carries. */
export const TAIL_LINES = 10;
export const TAIL_WIDTH = 200;

export type PaneEvent = {
  seq: number; at: string;
  pane: string; stableId: string; ref: string; thread: string; threadId: string;
  agent: string; title: string; old: string; state: string;
  /** Waiting on a numbered question (an approval), not just finished. */
  asking: boolean;
  exit: number | null; generation: number; turns: number;
  tail: string[];
  /** @ash requests in the pane's output that no event of it carried before (AshSeen). */
  ash?: string[];
};

/** Which pane events the webhooks hear (loomctl set ash-listen, Preferences):
 * every one, only one carrying a new @ash request, or none. watch --panes and
 * wait --until hear every one either way. */
export const ASH_LISTEN = ["full", "ash", "off"] as const;
export type AshListen = (typeof ASH_LISTEN)[number];
/** A pane's own: one of those, or inherit, the global one. */
export const PANE_ASH_LISTEN = ["inherit", ...ASH_LISTEN] as const;
export type PaneAshListen = (typeof PANE_ASH_LISTEN)[number];
export const hears = (mode: AshListen, e: PaneEvent) => mode === "full" || (mode === "ash" && !!e.ash?.length);
/** How far up an event looks for @ash requests: far past its tail, so lines an
 * agent drew after its request (a todo list, a notice) don't hide it. */
export const ASH_LINES = 500;
const ASH = /^\s*(?:[●⏺•]\s*)?(@ash\b.*)$/i;
const KEEP_ASKED = 100;

/** The part of xterm's buffer a reader needs. */
export type Rows = { length: number; getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined };

/** A buffer's last `n` rows as lines, up to its last with anything on it, each
 * row cut at `cols` (the alternate screen keeps cells past it after a
 * narrowing resize). A row xterm wrapped joins the line above it, so a long
 * line reads the same at any width, and the rows start where a line does. Not
 * after a rule: Claude pads its rules to the width, and xterm flags the row
 * after one as its wrap. `wraps` false keeps every row as drawn: Grok cuts its
 * rows at the width, yet xterm flags nearly every one as a wrap (liveScreen). */
export function bufferLines(buf: Rows, n: number, cols: number, wraps = true): string[] {
  let to = buf.length;
  while (to > 0 && !buf.getLine(to - 1)?.translateToString(true, 0, cols).trim()) to--;
  let from = Math.max(0, to - n);
  while (wraps && from > 0 && buf.getLine(from)?.isWrapped) from--;
  const lines: string[] = [];
  for (let y = from; y < to; y++) {
    const row = buf.getLine(y), text = row?.translateToString(false, 0, cols) ?? "", last = lines.length - 1;
    if (wraps && row?.isWrapped && last >= 0 && !claudeDivider(lines[last])) lines[last] += text;
    else lines.push(text);
  }
  return lines.map((l) => l.trimEnd());
}

/** The @ash requests in `lines`, a screen's last lines, oldest first: each
 * line that starts with @ash (after a message's bullet). An agent wraps a long
 * one onto lines indented to where its text starts (Claude's message text, 2
 * columns in), so those lines join it, up to a blank one; one at the left edge
 * (a shell's output) is its line alone. */
export function ashRequests(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ASH.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1].trim()], indent = " ".repeat(lines[i].length - m[1].length);
    const goesOn = (l: string) => indent.length > 0 && l.startsWith(indent) && /^[^\s─━│┃╭╮╰╯┌┐└┘⎿]/.test(l.slice(indent.length)) && !ASH.test(l);
    while (i + 1 < lines.length && parts.length < 20 && goesOn(lines[i + 1])) parts.push(lines[++i].trim());
    out.push(parts.join(" ").replace(/\s+/g, " ").slice(0, 2000));
  }
  return out;
}

/** Each pane's @ash requests seen so far, by their text with every space
 * removed: a redraw at another width (a resize, a resumed session) wraps one
 * differently, and it's still the one already sent. Its case stays: Ash's
 * paths are Linux's, where Foo.log and foo.log are two files. Only the
 * marker's doesn't count.
 * ponytail: the last KEEP_ASKED per pane, in memory; an older one redrawn goes out again. */
export class AshSeen {
  private seen = new Map<string, string[]>();
  /** Those in `lines` that no call saw for `pane`; all count as seen from now.
   * A startup's are only seen: a resumed session redraws the old ones. */
  fresh(pane: string, lines: string[], startup = false): string[] {
    const keys = this.seen.get(pane) ?? [], out: string[] = [];
    for (const r of ashRequests(lines)) {
      const key = r.replace(/^@ash/i, "@ash").replace(/\s+/g, "");
      if (keys.includes(key)) continue;
      keys.push(key);
      if (keys.length > KEEP_ASKED) keys.shift();
      if (!startup) out.push(r);
    }
    this.seen.set(pane, keys);
    return out;
  }
}

/** One pane's state as it settles. `see` gets what the UI shows on every
 * repaint; the first value is where the pane starts and sends nothing.
 * `now`, the pane's state when the wait ends: one it left without a repaint
 * never stood, and what it is now starts counting instead. `ends`, how many
 * turns the pane has ended: back where it settled is a blip unless that moved
 * meanwhile, a turn shorter than the settle time, its end looked at or not.
 * What the pane drew on the way (Claude shows any output as working) and a
 * second signal of one turn's end don't move it. */
export class Settler {
  settled: string | undefined;
  private next: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fire: (old: string, state: string, since: number) => void;
  private ms: number;
  private now?: () => string;
  private ends: () => number;
  /** `ends` when the state settled. */
  private endsThen = 0;
  constructor(fire: (old: string, state: string, since: number) => void, ms = SETTLE_MS, now?: () => string, ends = () => 0) {
    this.fire = fire;
    this.ms = ms;
    this.now = now;
    this.ends = ends;
  }

  see(state: string) {
    if (this.settled === undefined) { this.settled = state; this.endsThen = this.ends(); return; }
    if (state === this.next) return;
    this.stop();
    if (state === this.settled && this.ends() === this.endsThen) return;
    const since = Date.now();
    this.next = state;
    this.timer = setTimeout(() => {
      this.next = undefined;
      const now = this.now?.() ?? state;
      if (now !== state) return this.see(now);
      const old = this.settled!;
      this.settled = state;
      this.endsThen = this.ends();
      this.fire(old, state, since);
    }, this.ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.next = undefined;
  }

  /** A new launch: what was settling, and turns ended that no event reported, were the last one's. */
  restart() {
    this.stop();
    this.endsThen = this.ends();
  }
}

/** The last KEEP_EVENTS events, numbered.
 * ponytail: numbers start from the clock, not from 1, so they keep growing
 * across Loom restarts and window reloads with nothing saved, and `--after`
 * also takes a time in ms ("from now"). Two events in one ms take the next number. */
export class PaneEventLog {
  readonly events: PaneEvent[] = [];
  readonly boot: number;
  seq: number;
  private pruned = 0;
  private keep: number;
  constructor(now = Date.now(), keep = KEEP_EVENTS) {
    this.boot = this.seq = now;
    this.keep = keep;
  }

  add(e: Omit<PaneEvent, "seq">, now = Date.now()): PaneEvent {
    const event = { seq: (this.seq = Math.max(this.seq + 1, now)), ...e };
    this.events.push(event);
    if (this.events.length > this.keep) this.pruned = this.events.shift()!.seq;
    return event;
  }

  /** Events numbered after `after` that `want` keeps. `gap`: some after it are
   * gone, because they were pruned or came from an earlier run of the window.
   * `next` is the number to ask from next time. */
  after(after: number, want: (e: PaneEvent) => boolean = () => true) {
    const events = this.events.filter((e) => e.seq > after && want(e));
    return { events, next: Math.max(after, this.seq), gap: after < this.pruned || (after > 0 && after < this.boot) };
  }
}

/** Which events a reader or a webhook wants: by thread (name or id), pane
 * (stable id or id) and new state. An empty list wants them all. */
export type PaneFilter = { threads?: string[]; panes?: string[]; states?: string[] };

export const matches = (f: PaneFilter, e: PaneEvent) =>
  (!f.threads?.length || f.threads.includes(e.thread) || f.threads.includes(e.threadId)) &&
  (!f.panes?.length || f.panes.includes(e.stableId) || f.panes.includes(e.pane)) &&
  (!f.states?.length || f.states.includes(e.state));

export type Webhook = PaneFilter & { url: string; header?: string; secret?: string };

/** Seconds before each retry of a failed delivery: about two minutes in all. */
export const RETRY_S = [2, 4, 8, 16, 32, 64];
export const MAX_QUEUE = 100;
const KEEP_FAILURES = 20;

/** An http(s) address with nothing that could break a request line. */
export function hookUrl(url: string) {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${url} isn't a URL.`); }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || url.length > 2048 || /[\x00-\x20\x7f]/.test(url))
    throw new Error("A webhook takes an http:// or https:// address.");
  return url;
}

/** A webhook as logs name it: its host and a hash of the address, never the
 * address, whose user, path or query can be the secret. */
export function hookTag(url: string) {
  let host: string;
  try { host = new URL(url).host; } catch { host = "an unreadable address"; }
  return `${host} #${hash32(url).slice(0, 6)}`;
}

/** "Name: value", split, or an error saying why not. */
export function hookHeader(header: string): [string, string] {
  const i = header.indexOf(":");
  const name = header.slice(0, i).trim(), value = header.slice(i + 1).trim();
  if (i < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`--header takes "Name: value", not ${header}.`);
  return [name, value];
}

/** sha256=<hex HMAC-SHA256 of the body, keyed by the secret>, as GitHub signs. */
export async function sign(secret: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Posts a body with headers; answers the HTTP status or throws. */
export type Post = (url: string, headers: [string, string][], body: string) => Promise<number>;
export type Failure = { at: string; seq: number; error: string };

/** One webhook's deliveries, oldest first, one at a time, so a receiver sees
 * events in order. A failure is retried after each of RETRY_S; a 4xx other
 * than 408 and 429 won't change on a retry and is dropped at once. */
export class Courier {
  readonly queue: { seq: number; body: string; what: string; pane: string }[] = [];
  readonly failures: Failure[] = [];
  sent = 0;
  lastOk: string | null = null;
  private running = false;
  private stopped = false;
  readonly hook: Webhook;
  private post: Post;
  private log: (msg: string) => void;
  private sleep: (ms: number) => Promise<void>;
  private tag: string;
  constructor(hook: Webhook, post: Post, log: (msg: string) => void = console.warn, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.hook = hook;
    this.post = post;
    this.log = log;
    this.sleep = sleep;
    this.tag = hookTag(hook.url);
  }

  push(e: PaneEvent) {
    if (this.stopped || !matches(this.hook, e)) return;
    this.queue.push({ seq: e.seq, body: JSON.stringify(e), what: `${e.ref} ${e.old}>${e.state}`, pane: e.stableId });
    // While running, queue[0] is the one being delivered: the oldest waiting goes, never it.
    if (this.queue.length > MAX_QUEUE) this.fail(this.queue.splice(this.running ? 1 : 0, 1)[0], `dropped: more than ${MAX_QUEUE} deliveries waiting`);
    void this.run();
  }

  /** Removed from the settings: what is queued goes nowhere. */
  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Ash listening off, for the panes `drop` names by stable id (every one by
   * default): what waits goes nowhere, and one being posted isn't tried again. */
  clear(drop = (_pane: string) => true) {
    for (let i = this.queue.length - 1; i >= 0; i--) if (drop(this.queue[i].pane)) this.queue.splice(i, 1);
  }

  /** One try: the status, or why there is none. A queued `job` goes only while
   * still queued: Ash listening off (clear) drops it while it's signed too. */
  async attempt(seq: number, body: string, job?: Courier["queue"][number]): Promise<number | string> {
    const headers: [string, string][] = [["Content-Type", "application/json"], ["X-Loom-Event", "pane-state"], ["X-Loom-Delivery", String(seq)]];
    try {
      if (this.hook.header) headers.push(hookHeader(this.hook.header));
      if (this.hook.secret) headers.push(["X-Loom-Signature", await sign(this.hook.secret, body)]);
      if (this.stopped) return "the webhook was removed"; // while signing
      if (job && this.queue[0] !== job) return "dropped: Ash listening is off";
      return await this.post(this.hook.url, headers, body);
    } catch (e) {
      return String(e instanceof Error ? e.message : e);
    }
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue[0];
        await this.deliver(job);
        if (this.queue[0] === job) this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(job: Courier["queue"][number]) {
    const { seq, body, what } = job;
    // Removed or cleared during a retry's wait: the next try never goes out.
    for (let i = 0; !this.stopped && this.queue[0] === job; i++) {
      const got = await this.attempt(seq, body, job);
      const tries = i ? ` after ${i + 1} tries` : "";
      if (typeof got === "number" && got >= 200 && got < 300) {
        this.sent++;
        this.lastOk = new Date().toISOString();
        return this.log(`Loom webhook ${this.tag}: event ${seq} (${what}) delivered, HTTP ${got}${tries}.`);
      }
      if (this.queue[0] !== job) return; // dropped by clear: no failure, no retry
      const why = typeof got === "number" ? `HTTP ${got}` : got;
      const final = (typeof got === "number" && got >= 400 && got < 500 && got !== 408 && got !== 429) || i >= RETRY_S.length;
      if (final || this.stopped) return this.fail(job, `${why}${tries}`);
      this.log(`Loom webhook ${this.tag}: event ${seq} (${what}) ${why}; retrying in ${RETRY_S[i]} s.`);
      await this.sleep(RETRY_S[i] * 1000);
    }
  }

  private fail({ seq, what }: Courier["queue"][number], error: string) {
    this.failures.push({ at: new Date().toISOString(), seq, error });
    if (this.failures.length > KEEP_FAILURES) this.failures.shift();
    this.log(`Loom webhook ${this.tag}: event ${seq} (${what}) not delivered (${error}).`);
  }
}
