// Self-check for watch's wake-up. Run: node src/task_event_gate.test.ts
import { TaskEventGate } from "./task_event_gate.ts";

let fails = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) fails++;
}
const waiting = (g: TaskEventGate) => (g as unknown as { listeners: Set<unknown> }).listeners.size;

{
  const g = new TaskEventGate();
  let written = 0, woke = false;
  const w = g.waitUntil(() => written >= 1, 1000).then(() => (woke = true));
  g.notify();
  await Promise.resolve();
  check("a notify with nothing new doesn't wake it", !woke);
  written = 1;
  g.notify();
  await w;
  check("the write that lands does, and leaves no listener", woke && waiting(g) === 0);
}
{
  const g = new TaskEventGate();
  let calls = 0;
  await g.waitUntil(() => ++calls >= 2, 1000);
  check("ready between the first check and registering still returns", calls === 2 && waiting(g) === 0);
}
{
  const g = new TaskEventGate();
  const state = new Map<string, string>();
  let second = false;
  const a = g.waitUntil(() => state.get("a") === "completed", 1000);
  const b = g.waitUntil(() => state.get("b") === "approval", 1000).then(() => (second = true));
  state.set("a", "completed");
  g.notify();
  await a;
  check("two waiters wake on their own condition", !second);
  state.set("b", "approval");
  g.notify();
  await b;
  check("and both leave", waiting(g) === 0);
}
{
  const real = globalThis.setTimeout, realInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => (timers++, real(...args))) as typeof setTimeout;
  globalThis.setInterval = (() => { throw new Error("no polling"); }) as unknown as typeof setInterval;
  try {
    const g = new TaskEventGate();
    await g.waitUntil(() => false, 10);
    check("idle, it sets one deadline and no interval", timers === 1 && waiting(g) === 0);
  } finally {
    globalThis.setTimeout = real;
    globalThis.setInterval = realInterval;
  }
}
{
  const g = new TaskEventGate();
  let fail = false;
  const w = g.waitUntil(() => { if (fail) throw new Error("fixture"); return false; }, 1000);
  fail = true;
  g.notify();
  const err = await w.then(() => null, (e: Error) => e.message);
  check("a throwing condition rejects and leaves", err === "fixture" && waiting(g) === 0);
}
{
  // loomctl hung up: the day-long wait ends now, its timer with it (the process would stay up otherwise).
  const g = new TaskEventGate(), stop = new AbortController();
  const w = g.waitUntil(() => false, 86_400_000, stop.signal);
  stop.abort(new Error("hung up"));
  const err = await w.then(() => null, (e: Error) => e.message);
  check("an aborted wait rejects with its reason and leaves", err === "hung up" && waiting(g) === 0);
}

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
