/** Which agent a startup command runs, and the argv that boots it in a pane.
 *
 * Four agents get first-class treatment — a session pinned per pane so the
 * next launch resumes it, a "turn finished" signal, and no shell host under
 * them (Claude, Codex, OpenCode, Cursor): a PowerShell sitting behind an agent costs ~65 MB a pane for nothing
 * but the prompt you land on when the agent quits, and a dead pane relaunches
 * on Enter instead. OMP is an agent that keeps the shell (launch). Anything
 * else is a shell command and gets PowerShell with shell-init.ps1 dot-sourced
 * (OSC 133 command marks, the busy dot). */
export type Agent = "claude" | "codex" | "opencode" | "omp" | "cursor" | "shell";

export const opencodeCommand = (cmd: string) => /^(opencode[12]?)(?=\s|$)/.exec(cmd.trim())?.[1];
const ompCommand = (cmd: string) => /^omp(\s|$)/.test(cmd.trim());
/** Cursor's agent CLI by its first name, `cursor-agent`. Its newer one,
 * `agent`, is other CLIs' too (Grok's agent.exe can come first on PATH), so a
 * startup of `agent` stays a shell command. */
export const cursorCommand = (cmd: string) => /^(cursor-agent)(?=\s|$)/.exec(cmd.trim())?.[1];

export function agentOf(cmd: string): Agent {
  if (opencodeCommand(cmd)) return "opencode";
  if (cursorCommand(cmd)) return "cursor";
  if (ompCommand(cmd)) return "omp";
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
 * the first turn ends (see codexTitle), and Codex's run state: Working,
 * Thinking or Waiting all through a turn, Ready between turns. That is how
 * Loom knows a turn still runs while Codex hides its status row, "esc to
 * interrupt" with it, as it does while it streams an answer. */
const CODEX_FLAGS =
  "-c tui.alternate_screen=never -c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always -c tui.terminal_title=['thread-id','run-state']";

/** Codex's run states as its title shows them (codex-rs status_surfaces.rs
 * run_state_status_text): Starting while its tools start, Ready between turns. */
const CODEX_STATES = new Set(["Starting", "Ready", "Working", "Thinking", "Waiting"]);
/** A codex pane's title: the thread id (Codex cuts it to 29 characters +
 * "...", still unique enough to find the rollout by, and may append a spinner
 * glyph) and, after " | ", its run state; the state alone before the thread
 * exists. Anything else is a name to show. */
export function codexTitle(title: string): { thread?: string; state?: string } | undefined {
  const parts = title.split(" | ");
  const state = CODEX_STATES.has(parts[parts.length - 1]) ? parts.pop() : undefined;
  if (parts.length > 1) return undefined;
  const thread = parts.length ? /^([0-9a-f]{8}-[0-9a-f-]{12,27})(?:\.\.\.)?(?:\s+\S)?$/u.exec(parts[0])?.[1] : undefined;
  if (parts.length && !thread) return undefined;
  return thread || state ? { thread, state } : undefined;
}
export const codexThread = (title: string) => codexTitle(title)?.thread;
/** A Codex turn runs: its title's run state says so. */
export const codexRunning = (state: string | undefined) => state === "Working" || state === "Thinking" || state === "Waiting";

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
  // --goal refuses a resume; --print and --no-session have none to keep.
  if (ompCommand(c)) return /(^|\s)(-c|--continue|-r|--resume|--no-session|--goal|-p|--print)([=\s]|$)/.test(c);
  const agent = agentOf(c);
  const rest = c.slice((opencodeCommand(c) || cursorCommand(c) || agent).length).trim();
  switch (agent) {
    case "claude":
      return /(^|\s)(-r|--resume|-c|--continue|--session-id)(\s|$)/.test(c);
    case "cursor":
      // `resume` and `ls` pick a chat; --print has none to keep.
      return /^(resume|ls)(\s|$)/.test(rest) || /(^|\s)(--resume|--continue|-p|--print)([=\s]|$)/.test(rest);
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
 * codex, opencode and cursor are shims (.cmd), so they need cmd.exe — a 4 MB
 * host. The Rust side launches an npm codex's native codex.exe straight from
 * this line instead (helper.rs: codex_direct), skipping cmd and node entirely,
 * and Cursor's node.exe (cursor.rs: direct), skipping cmd and PowerShell.
 * Their actual session IDs arrive from the provider (codex's notify script,
 * opencode's plugin, Cursor's prompt hook), separately from Claude's
 * preassigned sid. Never guess by
 * directory or hide resume errors: a codex resume without an id is its picker,
 * which a pane only reaches through its "Choose session" notice. */
export function launch(cmd: string, sid: string, resume: boolean, effort?: string, sessionId?: string): string[] {
  if (sessionId && !validSessionId(sessionId)) throw new Error("Invalid agent session ID");
  const c = cmd.trim();
  const agent = agentOf(c);
  const rest = c.slice((opencodeCommand(c) || cursorCommand(c) || agent).length).trim();
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
      // Our -c overrides require embedded mode; choose it explicitly to avoid the fallback warning.
      const standalone = args.includes("--no-daemon") ? "" : " --no-daemon";
      return cmdHost(`codex${select}${standalone} ${CODEX_FLAGS} ${CODEX_NOTIFY}${rest ? " " + rest : ""}`);
    }
    case "opencode": {
      const select = resume && sessionId && !own ? ` --session ${sessionId}` : "";
      return cmdHost(`${opencodeCommand(c)}${select}${rest ? " " + rest : ""}`);
    }
    case "cursor": {
      // Its chat id arrives from its beforeSubmitPrompt hook (helper.rs), so a
      // pane resumes the chat it last sent a prompt in; without one, a new chat.
      // The Rust side launches the node.exe its shim would run (cursor.rs: direct).
      const select = resume && sessionId && !own ? ` --resume ${sessionId}` : "";
      return cmdHost(`${cursorCommand(c)}${select}${rest ? " " + rest : ""}`);
    }
    default: {
      // OMP's --continue picks up the session its terminal ran last, found by
      // the terminal's pane id: ZELLIJ_PANE_ID is the first it reads, and it
      // reads it for nothing else. Named after the pane's sid, each pane gets
      // its own session back, not just the folder's newest.
      const run = ompCommand(c) && validSessionId(sid)
        ? `$env:ZELLIJ_PANE_ID='loom-${sid}'; omp${resume && !own ? " --continue" : ""}${c.slice(3)}`
        : c;
      // -NoExit so the pane survives the startup command exiting (like aa: the
      // command quits, you keep the shell in the same folder).
      return [
        "powershell.exe",
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        run ? `. $env:LOOM_INIT; ${run}` : ". $env:LOOM_INIT",
      ];
    }
  }
}

/** `/s` strips the outer quotes the spawner adds around a line with spaces and
 * runs the rest verbatim — the one form that keeps `||` meaning "or else". */
const cmdHost = (line: string) => ["cmd.exe", "/d", "/s", "/c", line];
