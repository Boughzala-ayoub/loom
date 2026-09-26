// Loom's opencode plugin. Installed to ~/.config/opencode/plugins/loom.js the
// first time a Loom pane starts opencode; a no-op anywhere else (no LOOM_PANE).
// opencode has no per-launch hook file the way claude has --settings, and the
// config "plugin" list takes npm packages only, so the global plugins folder
// is the one place a local file is picked up from.
//
// session.idle = the agent finished its turn and is waiting on you. A question
// or permission prompt blocks mid-turn and never goes idle, so those ring too.
// The marker is the same one claude's Stop hook drops:
// %TEMP%\loom-wait\<pane id>, which Loom polls and turns into the pane's
// yellow "waiting" state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WAKES = new Set(["session.idle", "question.asked", "permission.asked"]);

export const Loom = async ({ client }) => ({
  "chat.message": async ({ sessionID }) => {
    // A user message identifies the selected session, including /sessions.
    if (!process.env.LOOM_PANE) return;
    try {
      const session = await client.session.get({ path: { id: sessionID } });
      if (session.data && !session.data.parentID) remember(sessionID);
    } catch {}
  },
  event: async ({ event }) => {
    if (event.type === "session.created" && !event.properties?.info?.parentID) {
      remember(event.properties?.info?.id);
    }
    const pane = process.env.LOOM_PANE;
    if (!pane || !WAKES.has(event.type)) return;
    try {
      const dir = path.join(os.tmpdir(), "loom-wait");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, pane), "");
    } catch {}
  },
});

function remember(sessionID) {
  const file = process.env.LOOM_SESSION_FILE;
  if (!file || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionID ?? "")) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sessionID);
  } catch {}
}
