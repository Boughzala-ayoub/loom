// Self-check for pane state events. Run: node src/pane_events.test.ts
// @ts-ignore Node-only test.
import { createHmac } from "node:crypto";
import { Courier, hookHeader, hookTag, hookUrl, matches, MAX_QUEUE, PaneEventLog, RETRY_S, Settler, sign, type PaneEvent } from "./pane_events.ts";

let fails = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) fails++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = (over: Partial<PaneEvent> = {}): Omit<PaneEvent, "seq"> => ({
  at: "2026-10-19T00:00:00.000Z", pane: "p1", stableId: "s1", ref: "loom:1", thread: "loom", threadId: "t1",
  agent: "claude", title: "x", old: "working", state: "idle", asking: false, exit: null, generation: 1, turns: 1, tail: [], ...over,
});

{
  const fired: string[] = [];
  const s = new Settler((old, state) => fired.push(`${old}>${state}`), 40);
  s.see("idle");
  await sleep(60);
  check("the first state is where the pane starts: no event", fired.length === 0 && s.settled === "idle");
  s.see("working");
  await sleep(20);
  s.see("idle");
  await sleep(60);
  check("a blip that comes back to the settled state sends nothing", fired.length === 0);
  s.see("working");
  await sleep(20);
  s.see("working"); // repaints of the same state don't restart the count
  await sleep(30);
  check("a state that stands for the settle time fires once", fired.join() === "idle>working" && s.settled === "working");
  s.see("idle");
  await sleep(20);
  s.see("waiting");
  await sleep(60);
  check("a state replaced before it settled never fires; the one that stood does", fired.join() === "idle>working,working>waiting");
  s.see("exited");
  s.stop();
  await sleep(60);
  check("stop drops a pending change", fired.length === 2 && s.settled === "waiting");
}

{
  // 2026-10-20: a turn shorter than the settle time ended unheard.
  const fired: string[] = [];
  const s = new Settler((old, state) => fired.push(`${old}>${state}`), 40);
  s.see("waiting");
  s.see("waiting");
  await sleep(60);
  check("a repaint while waiting sends nothing", fired.length === 0);
  s.see("idle");
  s.see("working");
  await sleep(20);
  s.see("waiting");
  await sleep(60);
  check("back at waiting before working settled is the next turn's end", fired.join() === "waiting>waiting" && s.settled === "waiting");
  // Review 2026-10-20, 2: one turn's bell, looked at, then its Stop hook's late signal.
  s.see("idle");
  s.see("waiting");
  await sleep(60);
  check("a second signal of the same turn's end, no work between, sends nothing", fired.length === 1);
  // Review 2026-10-20, 3: a quick turn whose end someone looks at at once.
  s.see("idle");
  await sleep(60);
  s.see("working");
  s.see("waiting");
  s.see("idle");
  await sleep(60);
  check("back at idle after a turn ended on the way is that turn's end", fired.slice(1).join() === "waiting>idle,idle>idle" && s.settled === "idle");
  s.see("working");
  s.see("idle");
  await sleep(60);
  check("work and back with no end on the way is still a blip", fired.length === 3);
}

{
  // Review round 1, 3: a pane can leave a state without a repaint (a relaunch's first awaits).
  const fired: string[] = [];
  let now = "idle";
  const s = new Settler((old, state) => fired.push(`${old}>${state}`), 40, () => now);
  s.see("idle");
  s.see("exited");
  now = "starting";
  await sleep(60);
  check("a state the pane left unseen never fires; where it is now starts counting", fired.length === 0 && s.settled === "idle");
  await sleep(40);
  check("and fires once it has stood", fired.join() === "idle>starting");
  s.see("idle");
  now = "starting";
  await sleep(60);
  check("left for the state that settled: nothing", fired.length === 1 && s.settled === "starting");
}

{
  const log = new PaneEventLog(1000, 3);
  const a = log.add(event(), 1000), b = log.add(event({ state: "waiting" }), 1000);
  check("numbers start past the clock and grow within one ms", a.seq === 1001 && b.seq === 1002);
  check("after 0 gives everything, no gap", log.after(0).events.length === 2 && !log.after(0).gap);
  check("next is the newest number even when the filter keeps none", log.after(0, (e) => e.state === "exited").next === 1002);
  check("a number from an earlier run is a gap", log.after(500).gap && log.after(500).events.length === 2);
  check("a time past the newest event waits for later ones", log.after(5000).events.length === 0 && log.after(5000).next === 5000 && !log.after(5000).gap);
  log.add(event(), 2000);
  log.add(event(), 3000);
  check("the oldest is pruned past the limit", log.events.length === 3 && log.events[0].seq === 1002);
  check("reading from before a pruned event is a gap; from the pruned one itself, not", log.after(1000).gap && !log.after(1001).gap);
}

{
  const e = { seq: 1, ...event() };
  check("an empty filter wants every event", matches({}, e));
  check("thread by name or id", matches({ threads: ["loom"] }, e) && matches({ threads: ["t1"] }, e) && !matches({ threads: ["other"] }, e));
  check("pane by stable id or id", matches({ panes: ["s1"] }, e) && matches({ panes: ["p1"] }, e) && !matches({ panes: ["p2"] }, e));
  check("state", matches({ states: ["idle", "waiting"] }, e) && !matches({ states: ["exited"] }, e));
}

{
  check("http and https only", hookUrl("https://a.example/x") === "https://a.example/x" && hookUrl("http://127.0.0.1:9/h") === "http://127.0.0.1:9/h");
  let refused = 0;
  for (const bad of ["ftp://a/x", "not a url", "https://a/x\r\nHost: b", "file:///c:/x"]) try { hookUrl(bad); } catch { refused++; }
  check("other schemes, garbage and line breaks are refused", refused === 4);
  check("a header splits at its first colon", hookHeader("Authorization: Bearer a:b").join("|") === "Authorization|Bearer a:b");
  refused = 0;
  for (const bad of ["NoColon", ": v", "Bad Name: v", "X: a\nb"]) try { hookHeader(bad); } catch { refused++; }
  check("a header without a valid name or with a line break is refused", refused === 4);
  const body = JSON.stringify({ a: 1 });
  check("the signature is the hex HMAC-SHA256 of the body", (await sign("s3cret", body)) === "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex"));
}

{
  // Answers in turn; the sleeps between retries are recorded, not waited.
  const answers: (number | Error)[] = [];
  const seen: { headers: [string, string][]; body: string }[] = [];
  const slept: number[] = [], logged: string[] = [];
  const post = async (_url: string, headers: [string, string][], body: string) => {
    seen.push({ headers, body });
    const a = answers.shift() ?? 200;
    if (a instanceof Error) throw a;
    return a;
  };
  const courier = (over = {}) => new Courier({ url: "http://h/x", secret: "k", header: "X-Who: ash", ...over }, post, (m) => logged.push(m), async (ms) => { slept.push(ms); });
  const idle = async (c: Courier) => { for (let i = 0; i < 100 && c.queue.length; i++) await sleep(1); };

  let c = courier();
  answers.push(500, new Error("curl exit 7"), 204);
  const log = new PaneEventLog();
  c.push(log.add(event()));
  c.push(log.add(event({ state: "waiting" })));
  await idle(c);
  check("a failure is retried with backoff until it lands", slept.join() === "2000,4000" && c.sent === 2 && !c.failures.length);
  const first = log.events[0].seq;
  const tag = hookTag("http://h/x");
  check("each try is logged with its status, the delivery too", logged.join("\n") === [
    `Loom webhook ${tag}: event ${first} (loom:1 working>idle) HTTP 500; retrying in 2 s.`,
    `Loom webhook ${tag}: event ${first} (loom:1 working>idle) curl exit 7; retrying in 4 s.`,
    `Loom webhook ${tag}: event ${first} (loom:1 working>idle) delivered, HTTP 204 after 3 tries.`,
    `Loom webhook ${tag}: event ${first + 1} (loom:1 working>waiting) delivered, HTTP 200.`,
  ].join("\n"));
  // Review 2026-10-20, 4: the address can be the secret, in its user, path or query.
  const secret = "https://ash:pw1@hooks.example.com:8443/automations/7e9a7c1c?token=tk2";
  const named = hookTag(secret);
  check("a log names a webhook by host and hash, never its address", named.startsWith("hooks.example.com:8443 #") && !/ash|pw1|automations|7e9a7c1c|token|tk2/.test(named) && named !== hookTag(secret + "x"));
  check("events go out in order", seen.map((s) => JSON.parse(s.body).state).join() === "idle,idle,idle,waiting");
  const h = Object.fromEntries(seen[0].headers);
  check("each delivery is signed and carries the extra header", h["X-Loom-Signature"] === (await sign("k", seen[0].body)) && h["X-Who"] === "ash" && h["X-Loom-Event"] === "pane-state");

  slept.length = 0;
  c = courier();
  answers.push(...Array(RETRY_S.length + 1).fill(503));
  c.push(log.add(event()));
  await idle(c);
  check("it gives up after the last retry and logs why", slept.length === RETRY_S.length && c.failures.length === 1 && c.failures[0].error.startsWith("HTTP 503") && logged.some((l) => l.includes("not delivered")));

  slept.length = 0;
  c = courier();
  answers.push(404);
  c.push(log.add(event()));
  await idle(c);
  check("a 404 isn't retried", !slept.length && c.failures[0]?.error === "HTTP 404");

  c = courier({ states: ["waiting"] });
  const before = seen.length;
  c.push(log.add(event({ state: "idle" })));
  await idle(c);
  check("a webhook's filter holds back what it doesn't want", seen.length === before);

  c = courier();
  c.stop();
  c.push(log.add(event()));
  check("a removed webhook queues nothing", !c.queue.length);

  // A stuck receiver: the queue is capped, the oldest waiting dropped and logged.
  const asked: number[] = [], answer: ((status: number) => void)[] = [];
  const stuck = new Courier({ url: "http://h/x" }, (_url, headers) => {
    asked.push(Number(Object.fromEntries(headers)["X-Loom-Delivery"]));
    return new Promise((r) => answer.push(r));
  }, () => {}, async () => {});
  const pushed: number[] = [];
  for (let i = 0; i < MAX_QUEUE + 5; i++) { const e = log.add(event()); pushed.push(e.seq); stuck.push(e); }
  check("at most MAX_QUEUE wait; the oldest are dropped and logged", stuck.queue.length === MAX_QUEUE && stuck.failures.length === 5);
  check("the one being delivered is never the one dropped", stuck.failures.map((f) => f.seq).join() === pushed.slice(1, 6).join());
  answer.shift()!(500);
  await sleep(5);
  check("a failed delivery in flight is retried, not abandoned", asked.join() === [pushed[0], pushed[0]].join());
  answer.shift()!(200);
  await sleep(5);
  check("then the oldest kept goes next", asked[2] === pushed[6] && stuck.sent === 1 && !stuck.failures.some((f) => f.seq === pushed[0]));
  stuck.stop();
  answer.shift()!(200);
}

{
  // Review round 1, 2: removing a webhook stops what it was still going to send.
  const log = new PaneEventLog();
  let posts = 0, wake!: () => void;
  const post = async () => { posts++; return 500; };
  const c = new Courier({ url: "http://h/x" }, post, () => {}, () => new Promise<void>((r) => (wake = r)));
  c.push(log.add(event()));
  await sleep(5);
  c.stop();
  wake();
  await sleep(5);
  check("removed while waiting to retry: no further try", posts === 1);
  const signed = new Courier({ url: "http://h/x", secret: "k" }, post, () => {}, async () => {});
  signed.push(log.add(event()));
  signed.stop(); // the first try is signing
  await sleep(5);
  check("removed while signing: nothing is posted", posts === 1);
}

if (fails) throw new Error(`${fails} failed`);
