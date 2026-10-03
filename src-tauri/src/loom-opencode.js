// One local plugin for OpenCode 1.18.29+ and 2.x. V1 calls server(); V2 calls
// setup(). The named export also supports testing the V1 hooks directly.
// Each Loom pane runs its own OpenCode server and supplies these marker paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const validID = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const WAKES = new Set(["question.asked", "form.created", "permission.asked"]);
const REPLIES = new Set(["question.replied", "question.rejected", "form.replied", "form.cancelled", "permission.replied"]);
const BUSY = new Set(["session.execution.started", "session.retry.scheduled"]);
const IDLE = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.error"]);
// What loomctl's tasks (Loom's task.ts) hear of a run. OpenCode names no
// prompt, so Loom ties a task to the first run that starts after its Enter.
const TASK = { "session.execution.started": "start", "session.execution.succeeded": "end", "session.execution.failed": "fail", "session.execution.interrupted": "interrupt" };
// 2.x's finished assistant text blocks (`data.text`, OpenCode 2.0.19). A run's
// end names the last one as its final message; 1.x's server() names none.
const TEXT = new Set(["session.next.text.ended", "session.text.ended"]);
// How Loom names a prompt or a final message (task.ts promptMatch, helper.rs
// prompt_match): FNV-1a 64 of its words, never the text.
const match = (text) => {
  let h = 0xcbf29ce484222325n;
  const bare = text.replace(/<\/?pasted_content id="[0-9a-f]{4}">/g, " ").replace(/[\t\n\v\f\r ]+/g, " ").replace(/^ | $/g, "");
  for (const b of new TextEncoder().encode(bare)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
};
let reports = 0;

function loomPane(lookup) {
  let selected, state, answer, stopped = false, queue = Promise.resolve();
  const pending = new Set();
  const select = (id) => {
    if (stopped || !validID(id)) return;
    if (id !== selected) { state = undefined; pending.clear(); }
    selected = id;
    const file = process.env.LOOM_SESSION_FILE;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, id);
    } catch {}
  };
  // One file per report in %TEMP%\loom-task, named so a pane's sort in order
  // (16 digits, as loom.exe names Claude's and Codex's), written beside and
  // renamed in. Each names the pane launch it came from (LOOM_LAUNCH), so a
  // late one from a replaced process moves nothing; without one, none is sent.
  const report = (kind, detail, response) => {
    const launch = /^\d+$/.test(process.env.LOOM_LAUNCH ?? "") ? Number(process.env.LOOM_LAUNCH) : undefined;
    if (stopped || launch === undefined) return;
    try {
      const dir = path.join(os.tmpdir(), "loom-task");
      fs.mkdirSync(dir, { recursive: true });
      const t = Date.now(), n = ++reports;
      const name = path.join(dir, `${process.env.LOOM_PANE}.${String(t).padStart(13, "0")}${String(n % 1000).padStart(3, "0")}.${process.pid}-${n}`);
      fs.writeFileSync(`${name}.tmp`, JSON.stringify({ kind, t, launch, src: "opencode", ...(detail ? { detail: String(detail).slice(0, 200) } : {}), ...(response ? { response } : {}) }));
      fs.renameSync(`${name}.tmp`, `${name}.json`);
    } catch {}
  };
  const signal = (next) => {
    if (stopped || next === state) return;
    try {
      const dir = path.join(os.tmpdir(), "loom-wait");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, process.env.LOOM_PANE), `opencode:${next}`);
      state = next;
    } catch {}
  };
  // Hooks and events use the same queue: asynchronous lookups must preserve order.
  const enqueue = (fn) => queue = queue.then(() => {
    if (!stopped && validID(process.env.LOOM_PANE)) return fn();
  }).catch(() => {});
  const selectedSession = async (id, descendants = false) => {
    const seen = new Set();
    while (validID(id) && !seen.has(id)) {
      if (id === selected) return true;
      seen.add(id);
      const session = await lookup(id);
      if (!session || stopped) return false;
      if (!selected && !session.parentID) { select(id); return true; }
      if (!descendants || !session.parentID) return false;
      id = session.parentID;
    }
    return false;
  };
  return {
    stop: () => { stopped = true; },
    message: (id) => enqueue(async () => {
      if (!validID(id)) return;
      const session = await lookup(id);
      if (session && !session.parentID) select(id);
    }),
    event: (type, data) => enqueue(async () => {
      if (type === "session.created") {
        if (!data.parentID) select(data.sessionID);
        return;
      }
      // The root session's own text only: a child's answer isn't the run's.
      if (TEXT.has(type)) {
        if (typeof data.text === "string" && await selectedSession(data.sessionID)) answer = data.text;
        return;
      }
      const form = type === "form.created" ? data.form : data;
      const id = form?.sessionID;
      if (WAKES.has(type) || REPLIES.has(type)) {
        if (!await selectedSession(id, true)) return;
        const key = `${id}:${form.id || form.requestID || type.split('.')[0]}`;
        if (WAKES.has(type)) pending.add(key); else pending.delete(key);
        signal(pending.size ? "waiting" : "busy");
        // Working again only once nothing is left to answer, as the pane marker says.
        if (WAKES.has(type)) report("approval", type);
        else if (!pending.size) report("resume", type);
        return;
      }
      const status = BUSY.has(type) ? "busy" : IDLE.has(type) || type === "session.idle" ? "idle"
        : type === "session.status" ? data.status?.type : undefined;
      if (!status || !await selectedSession(data.sessionID)) return;
      const was = state;
      if (status === "idle") { pending.clear(); signal("waiting"); }
      else if (status === "busy" || status === "retry") signal(pending.size ? "waiting" : "busy");
      // 2.x reports each run's start and outcome; 1.x only its status, so a
      // start is the move to busy and an end the move to idle.
      const error = type === "session.error" ? data.error?.name || "error" : undefined;
      const task = TASK[type] ?? (error ? (/abort/i.test(error) ? "interrupt" : "fail")
        : type === "session.idle" || (type === "session.status" && status === "idle") ? "end"
        : type === "session.status" && status === "busy" && was !== "busy" ? "start" : undefined);
      if (task === "start") answer = undefined;
      if (task) report(task, error, task === "end" && answer !== undefined ? match(answer) : undefined);
    }),
  };
}

export const Loom = async ({ client }) => {
  const pane = loomPane(async (id) => (await client.session.get({ path: { id } })).data);
  return {
    "chat.message": ({ sessionID }) => pane.message(sessionID),
    event: ({ event }) => {
      const data = event.properties || {};
      return pane.event(event.type, event.type === "session.created"
        ? { sessionID: data.info?.id, parentID: data.info?.parentID } : data);
    },
    dispose: () => pane.stop(),
  };
};

export default {
  id: "loom",
  server: Loom,
  async setup(ctx) {
    if (!validID(process.env.LOOM_PANE)) return;
    const pane = loomPane((id) => ctx.session.get({ sessionID: id }));
    const controller = new AbortController();
    const stream = ctx.event.subscribe({ signal: controller.signal });
    void (async () => {
      try {
        for await (const event of stream) await pane.event(event.type, event.data || {});
      } catch { /* Aborting the subscription during disposal is expected. */ }
    })();
    try {
      await ctx.session.hook("prompt", ({ sessionID }) => pane.message(sessionID));
    } catch (error) { pane.stop(); controller.abort(); throw error; }
    return () => { pane.stop(); controller.abort(); };
  },
};
