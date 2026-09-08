// Loom's opencode plugin. Installed to ~/.config/opencode/plugins/loom.js the
// first time a Loom pane starts opencode; a no-op anywhere else (no LOOM_PANE).
// opencode has no per-launch hook file the way claude has --settings, and the
// config "plugin" list takes npm packages only, so the global plugins folder
// is the one place a local file is picked up from.
//
// session.idle = the agent finished its turn and is waiting on you. The marker
// is the same one claude's Stop hook drops: %TEMP%\loom-wait\<pane id>, which
// Loom polls and turns into the pane's yellow "waiting" state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const Loom = async () => ({
  event: async ({ event }) => {
    const pane = process.env.LOOM_PANE;
    if (!pane || event.type !== "session.idle") return;
    try {
      const dir = path.join(os.tmpdir(), "loom-wait");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, pane), "");
    } catch {}
  },
});
