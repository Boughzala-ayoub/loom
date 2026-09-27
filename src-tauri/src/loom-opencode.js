// Loom's opencode plugin. Installed to ~/.config/opencode/plugins/loom.js the
// first time a Loom pane starts opencode; a no-op anywhere else (no LOOM_PANE).
// opencode has no per-launch hook file the way claude has --settings, and the
// config "plugin" list takes npm packages only, so the global plugins folder
// is the one place a local file is picked up from.
//
// Status events survive hidden/truncated TUI footers. A question or permission
// prompt blocks mid-turn, so its reply restores busy even without a new status.
// Use the same marker transport as claude's Stop hook:
// %TEMP%\loom-wait\<pane id>, which Loom polls and turns into the pane's
// Working/Waiting state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WAKES = new Set(["question.asked", "permission.asked"]);
const REPLIES = new Set(["question.replied", "question.rejected", "permission.replied"]);

export const Loom = async ({ client }) => {
  let selected, state;
  let events = Promise.resolve();
  const select = (id) => { selected = id; remember(id); };
  const signal = (next) => {
    if (next === state) return;
    try {
      const dir = path.join(os.tmpdir(), "loom-wait");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, process.env.LOOM_PANE), `opencode:${next}`);
      state = next;
    } catch {}
  };
  return {
    "chat.message": async ({ sessionID }) => {
      // A user message identifies the selected session, including /sessions.
      if (!process.env.LOOM_PANE) return;
      try {
        const session = await client.session.get({ path: { id: sessionID } });
        if (session.data && !session.data.parentID) select(sessionID);
      } catch {}
    },
    // OpenCode does not await event hooks. Preserve order across session.get.
    event: ({ event }) => events = events.then(async () => {
      if (!process.env.LOOM_PANE) return;
      if (event.type === "session.created" && !event.properties?.info?.parentID) {
        select(event.properties?.info?.id);
      }
      if (event.type === "session.status" || event.type === "session.idle") {
        const id = event.properties?.sessionID;
        if (!id) return;
        // A resumed session has no session.created event. Resolve it once; a
        // subagent completing must never mark its still-running parent idle.
        if (!selected) {
          try {
            const session = await client.session.get({ path: { id } });
            if (!session.data || session.data.parentID) return;
            if (!selected) select(id);
          } catch { return; }
        }
        if (id !== selected) return;
        const status = event.type === "session.idle" ? "idle" : event.properties?.status?.type;
        if (status === "busy" || status === "retry") signal("busy");
        else if (status === "idle") signal("waiting");
      } else if (WAKES.has(event.type)) signal("waiting");
      else if (REPLIES.has(event.type)) signal("busy");
    }),
  };
};

function remember(sessionID) {
  const file = process.env.LOOM_SESSION_FILE;
  if (!file || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionID ?? "")) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sessionID);
  } catch {}
}
