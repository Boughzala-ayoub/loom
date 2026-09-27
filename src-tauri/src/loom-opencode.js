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

function loomPane(lookup) {
  let selected, state, stopped = false, queue = Promise.resolve();
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
      const form = type === "form.created" ? data.form : data;
      const id = form?.sessionID;
      if (WAKES.has(type) || REPLIES.has(type)) {
        if (!await selectedSession(id, true)) return;
        const key = `${id}:${form.id || form.requestID || type.split('.')[0]}`;
        if (WAKES.has(type)) pending.add(key); else pending.delete(key);
        signal(pending.size ? "waiting" : "busy");
        return;
      }
      const status = BUSY.has(type) ? "busy" : IDLE.has(type) || type === "session.idle" ? "idle"
        : type === "session.status" ? data.status?.type : undefined;
      if (!status || !await selectedSession(data.sessionID)) return;
      if (status === "idle") { pending.clear(); signal("waiting"); }
      else if (status === "busy" || status === "retry") signal(pending.size ? "waiting" : "busy");
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
