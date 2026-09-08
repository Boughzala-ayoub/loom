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
 * one you're looking at isn't, and it still wants the beep. */
const CODEX_FLAGS =
  "-c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always";

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
 * Neither can be told a session id up front; both resume "the last session in
 * this directory", which is exactly one per thread since a thread is a worktree.
 * ponytail: two codex panes in one thread resume the same conversation.
 * `||` runs the fresh command when there is nothing to resume. */
export function launch(cmd: string, sid: string, resume: boolean, effort?: string): string[] {
  const c = cmd.trim();
  const agent = agentOf(c);
  const rest = c.slice(agent.length).trim();
  const args = rest ? rest.split(/\s+/) : []; // ponytail: no quoted args in startups
  switch (agent) {
    case "claude": {
      // Anything that already picks its own session is left alone.
      const own = /(^|\s)(-r|--resume|-c|--continue|--session-id)(\s|$)/.test(c);
      const eff = effort && !/(^|\s)--effort(\s|$)/.test(c) ? ["--effort", effort] : [];
      const set = /(^|\s)--settings(\s|$)/.test(c) ? [] : ["--settings", "$LOOM_HOOKS"];
      return own
        ? ["claude", ...args]
        : ["claude", resume ? "--resume" : "--session-id", sid, ...set, ...eff, ...args];
    }
    case "codex": {
      const fresh = `codex ${CODEX_FLAGS}${rest ? " " + rest : ""}`;
      return cmdHost(resume ? `codex resume --last ${CODEX_FLAGS}${rest ? " " + rest : ""} || ${fresh}` : fresh);
    }
    case "opencode": {
      const fresh = `opencode${rest ? " " + rest : ""}`;
      return cmdHost(resume ? `opencode -c${rest ? " " + rest : ""} || ${fresh}` : fresh);
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
