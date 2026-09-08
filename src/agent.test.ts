// Self-check for agentOf / launch. Run: node src/agent.test.ts
import { agentOf, launch } from "./agent.ts";

let fails = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
  fails++;
}

const S = "11111111-2222-4333-8444-555555555555";
const H = ["--settings", "$LOOM_HOOKS"];
const CX = "-c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always";

check("agentOf claude", agentOf("claude --effort max"), "claude");
check("agentOf claudette is a shell", agentOf("claudette"), "shell");
check("agentOf codex", agentOf("codex"), "codex");
check("agentOf opencode", agentOf(" opencode "), "opencode");
check("agentOf cmd", agentOf("cmd"), "shell");

check("new claude pane pins an id", launch("claude", S, false), ["claude", "--session-id", S, ...H]);
check("restored claude pane resumes", launch("claude", S, true), ["claude", "--resume", S, ...H]);
check(
  "extra flags survive",
  launch("claude --dangerously-skip-permissions", S, false),
  ["claude", "--session-id", S, ...H, "--dangerously-skip-permissions"],
);
check(
  "user's own --settings wins",
  launch("claude --settings mine.json", S, false),
  ["claude", "--session-id", S, "--settings", "mine.json"],
);
check("explicit --resume left alone", launch("claude --resume abc", S, true), ["claude", "--resume", "abc"]);
check(
  "effort re-pinned on resume",
  launch("claude", S, true, "max"),
  ["claude", "--resume", S, ...H, "--effort", "max"],
);
check(
  "user's own --effort wins",
  launch("claude --effort low", S, true, "max"),
  ["claude", "--resume", S, ...H, "--effort", "low"],
);

check("fresh codex", launch("codex", S, false), ["cmd.exe", "/d", "/s", "/c", `codex ${CX}`]);
check(
  "restored codex resumes this directory's last session, else fresh",
  launch("codex -m o3", S, true),
  ["cmd.exe", "/d", "/s", "/c", `codex resume --last ${CX} -m o3 || codex ${CX} -m o3`],
);
check("fresh opencode", launch("opencode", S, false), ["cmd.exe", "/d", "/s", "/c", "opencode"]);
check(
  "restored opencode continues, else fresh",
  launch("opencode", S, true),
  ["cmd.exe", "/d", "/s", "/c", "opencode -c || opencode"],
);

const PS = ["powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command"];
check("shell command runs under PowerShell with shell-init", launch("cmd", S, true), [...PS, ". $env:LOOM_INIT; cmd"]);
check("empty command is a plain shell", launch("  ", S, false), [...PS, ". $env:LOOM_INIT"]);

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
