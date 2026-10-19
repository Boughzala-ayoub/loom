/** Pane state events: what `loomctl watch --panes`, `wait --until` and
 * webhooks hear when a pane settles into a new state. The parts that need no
 * Loom state, so they run under plain node; main.ts feeds them from paint(). */

/** How long a new state must stand before it counts. Output that pauses for a
 * tool call, or a blip that goes back to the old state, sends nothing. */
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
};

/** One pane's state as it settles. `see` gets what the UI shows on every
 * repaint; the first value is where the pane starts and sends nothing. */
export class Settler {
  settled: string | undefined;
  private next: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fire: (old: string, state: string, since: number) => void;
  private ms: number;
  constructor(fire: (old: string, state: string, since: number) => void, ms = SETTLE_MS) {
    this.fire = fire;
    this.ms = ms;
  }

  see(state: string) {
    if (this.settled === undefined) { this.settled = state; return; }
    if (state === this.next) return;
    this.stop();
    if (state === this.settled) return;
    const since = Date.now();
    this.next = state;
    this.timer = setTimeout(() => {
      const old = this.settled!;
      this.settled = state;
      this.next = undefined;
      this.fire(old, state, since);
    }, this.ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.next = undefined;
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
  readonly queue: { seq: number; body: string }[] = [];
  readonly failures: Failure[] = [];
  sent = 0;
  lastOk: string | null = null;
  private running = false;
  private stopped = false;
  readonly hook: Webhook;
  private post: Post;
  private log: (msg: string) => void;
  private sleep: (ms: number) => Promise<void>;
  constructor(hook: Webhook, post: Post, log: (msg: string) => void = console.warn, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
    this.hook = hook;
    this.post = post;
    this.log = log;
    this.sleep = sleep;
  }

  push(e: PaneEvent) {
    if (this.stopped || !matches(this.hook, e)) return;
    this.queue.push({ seq: e.seq, body: JSON.stringify(e) });
    if (this.queue.length > MAX_QUEUE) this.fail(this.queue.shift()!.seq, `dropped: more than ${MAX_QUEUE} deliveries waiting`);
    void this.run();
  }

  /** Removed from the settings: what is queued goes nowhere. */
  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** One try: the status, or why there is none. */
  async attempt(seq: number, body: string): Promise<number | string> {
    const headers: [string, string][] = [["Content-Type", "application/json"], ["X-Loom-Event", "pane-state"], ["X-Loom-Delivery", String(seq)]];
    try {
      if (this.hook.header) headers.push(hookHeader(this.hook.header));
      if (this.hook.secret) headers.push(["X-Loom-Signature", await sign(this.hook.secret, body)]);
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
        await this.deliver(job.seq, job.body);
        if (this.queue[0] === job) this.queue.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(seq: number, body: string) {
    for (let i = 0; ; i++) {
      const got = await this.attempt(seq, body);
      if (typeof got === "number" && got >= 200 && got < 300) {
        this.sent++;
        this.lastOk = new Date().toISOString();
        return;
      }
      const why = typeof got === "number" ? `HTTP ${got}` : got;
      const final = (typeof got === "number" && got >= 400 && got < 500 && got !== 408 && got !== 429) || i >= RETRY_S.length;
      if (final || this.stopped) return this.fail(seq, `${why}${i ? ` after ${i + 1} tries` : ""}`);
      this.log(`Loom webhook ${this.hook.url}: event ${seq} ${why}; retrying in ${RETRY_S[i]} s.`);
      await this.sleep(RETRY_S[i] * 1000);
    }
  }

  private fail(seq: number, error: string) {
    this.failures.push({ at: new Date().toISOString(), seq, error });
    if (this.failures.length > KEEP_FAILURES) this.failures.shift();
    this.log(`Loom webhook ${this.hook.url}: event ${seq} not delivered (${error}).`);
  }
}
