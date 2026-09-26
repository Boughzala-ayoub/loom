/** Which agent a startup command runs, and the argv that boots it in a pane.
 *
 * Three agents get first-class treatment — a session pinned per pane so the
 * next launch resumes it, a "turn finished" signal, and no shell host under
 * them: a PowerShell sitting behind an agent costs ~65 MB a pane for nothing
 * but the prompt you land on when the agent quits, and a dead pane relaunches
 * on Enter instead. Anything else is a shell command and gets PowerShell with
 * shell-init.ps1 dot-sourced (OSC 133 command marks, the busy dot). */
export type Agent = "claude" | "codex" | "opencode" | "shell";

export function agentOf(cmd: string): Agent {
  const m = /^(claude|codex|opencode)(\s|$)/.exec(cmd.trim());
  return (m?.[1] as Agent) ?? "shell";
}

/** Codex answers a finished turn (and an approval prompt) with OSC 9, which the
 * pane turns into its yellow "waiting" state. Off by default, and by default
 * only when the terminal reports itself unfocused — hidden threads are, the
 * one you're looking at isn't, and it still wants the beep.
 * Inline mode keeps history in xterm so its scrollbar can be dragged. Codex's
 * alternate screen owns its transcript and leaves xterm no scrollback.
 * The title carries the thread id from startup, which notify only reports once
 * the first turn ends: see codexThread. */
const CODEX_FLAGS =
  "-c tui.alternate_screen=never -c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always -c tui.terminal_title=['thread-id']";

/** The thread id in a codex pane's title. Codex cuts the item to 29
 * characters + "...", still unique enough to find the rollout by, and appends
 * a spinner glyph while it works. */
export const codexThread = (title: string) => /^([0-9a-f]{8}-[0-9a-f-]{12,27})(?:\.\.\.)?(?:\s+\S)?$/u.exec(title)?.[1];

// Codex runs `notify` after every completed turn with the event as one JSON
// argument, thread id included — and unlike its hooks, it needs no trust
// prompt (a hook given on the command line never gets one, so it never ran).
// `$LOOM_EXE` is replaced by the Rust side with loom.exe's own path; its
// --codex-notify mode (helper.rs) drops the id where take_sessions picks it up.
export const CODEX_NOTIFY = `-c "notify=['$LOOM_EXE','--codex-notify']"`;

export const validSessionId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** The startup command already picks its own session, so Loom neither pins
 * nor resumes one for it. */
export function ownSession(cmd: string): boolean {
  const c = cmd.trim();
  const agent = agentOf(c);
  const rest = c.slice(agent.length).trim();
  switch (agent) {
    case "claude":
      return /(^|\s)(-r|--resume|-c|--continue|--session-id)(\s|$)/.test(c);
    case "codex":
      return /^(resume|fork)(\s|$)/.test(rest);
    case "opencode":
      return /(^|\s)(-s|--session|-c|--continue)([=\s]|$)/.test(rest);
    default:
      return false;
  }
}

/** argv for pty_spawn. `resume` = this pane is being restored and its session
 * should be picked up where it was.
 *
 * claude runs bare — `claude.exe` is a real executable and takes its own args,
 * so a settings path with spaces in it survives. `$LOOM_HOOKS` is replaced by
 * the Rust side with Loom's own settings file (the SessionStart marker and the
 * statusline tee). Resume vs fresh is the caller's call: `--resume` on a session
 * that was never written exits, so it checks the transcript exists first.
 *
 * codex and opencode are npm shims (.cmd), so they need cmd.exe — a 4 MB host.
 * The Rust side launches an npm codex's native codex.exe straight from this
 * line instead (helper.rs: codex_direct), skipping cmd and node entirely.
 * Their actual session IDs arrive from the provider (codex's notify script,
 * opencode's plugin), separately from Claude's preassigned sid. Never guess by
 * directory or hide resume errors: a codex resume without an id is its picker,
 * which a pane only reaches through its "Choose session" notice. */
export function launch(cmd: string, sid: string, resume: boolean, effort?: string, sessionId?: string): string[] {
  if (sessionId && !validSessionId(sessionId)) throw new Error("Invalid agent session ID");
  const c = cmd.trim();
  const agent = agentOf(c);
  const rest = c.slice(agent.length).trim();
  const args = rest ? rest.split(/\s+/) : []; // ponytail: no quoted args in startups
  const own = ownSession(c);
  switch (agent) {
    case "claude": {
      const eff = effort && !/(^|\s)--effort(\s|$)/.test(c) ? ["--effort", effort] : [];
      const set = /(^|\s)--settings(\s|$)/.test(c) ? [] : ["--settings", "$LOOM_HOOKS"];
      return own
        ? ["claude", ...args]
        : ["claude", resume ? "--resume" : "--session-id", sid, ...set, ...eff, ...args];
    }
    case "codex": {
      const select = resume && !own ? ` resume${sessionId ? " " + sessionId : ""}` : "";
      return cmdHost(`codex${select} ${CODEX_FLAGS} ${CODEX_NOTIFY}${rest ? " " + rest : ""}`);
    }
    case "opencode": {
      const select = resume && sessionId && !own ? ` --session ${sessionId}` : "";
      return cmdHost(`opencode${select}${rest ? " " + rest : ""}`);
    }
    default:
      // -NoExit so the pane survives the startup command exiting (like aa: the
      // command quits, you keep the shell in the same folder).
      return [
        "powershell.exe",
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        c ? `. $env:LOOM_INIT; ${c}` : ". $env:LOOM_INIT",
      ];
  }
}

/** `/s` strips the outer quotes the spawner adds around a line with spaces and
 * runs the rest verbatim — the one form that keeps `||` meaning "or else". */
const cmdHost = (line: string) => ["cmd.exe", "/d", "/s", "/c", line];
