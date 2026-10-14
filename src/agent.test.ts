// Self-check for agentOf / launch. Run: node src/agent.test.ts
import { agentOf, codexRunning, codexThread, codexTitle, grokTitle, launch, CODEX_NOTIFY, ownSession, validSessionId } from "./agent.ts";

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
const CX = "--no-daemon -c tui.alternate_screen=never -c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always -c tui.terminal_title=['thread-id','run-state']";

check("agentOf claude", agentOf("claude --effort max"), "claude");
check("agentOf claudette is a shell", agentOf("claudette"), "shell");
check("agentOf codex", agentOf("codex"), "codex");
check("agentOf opencode", agentOf(" opencode "), "opencode");
for (const cmd of ['opencode1', 'opencode2']) {
  check(`${cmd} is an OpenCode agent`, agentOf(cmd), 'opencode');
  check(`${cmd} keeps its executable on resume`, launch(`${cmd} --auto`, S, true, undefined, 'ses_saved')[4], `${cmd} --session ses_saved --auto`);
  check(`${cmd} explicit session`, ownSession(`${cmd} --session=ses_own`), true);
  check(`${cmd} does not replace an explicit session`, launch(`${cmd} -s ses_own`, S, true, undefined, 'ses_saved')[4], `${cmd} -s ses_own`);
}
check("agentOf cmd", agentOf("cmd"), "shell");
// OMP is an agent of its own that keeps its shell, so its resume is its own too.
check("agentOf omp", ["omp", " omp --model opus ", "ompx"].map(agentOf), ["omp", "omp", "shell"]);
check("omp keeps its PowerShell host", launch("omp", S, false), ["powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", `. $env:LOOM_INIT; $env:ZELLIJ_PANE_ID='loom-${S}'; omp`]);
// OMP finds a pane's last session by its pane id, so a restore resumes that pane's, not the folder's newest.
check("omp resumes its pane's session", launch("omp --model opus", S, true)[6], `. $env:LOOM_INIT; $env:ZELLIJ_PANE_ID='loom-${S}'; omp --continue --model opus`);
check("omp's own session choice wins", ["omp -c", "omp --resume=01a1", "omp -r 01a1", "omp --no-session", "omp --goal x", "omp -p hi", "omp --model opus"].map(ownSession), [true, true, true, true, true, true, false]);
check("omp -r is not continued", launch("omp -r 01a1", S, true)[6], `. $env:LOOM_INIT; $env:ZELLIJ_PANE_ID='loom-${S}'; omp -r 01a1`);
check("omp needs a safe pane id", launch("omp", "x'; rm", true)[6], ". $env:LOOM_INIT; omp");
check("ompx is just a shell command", launch("ompx", S, true)[6], ". $env:LOOM_INIT; ompx");

// Cursor's CLI by its first name, cursor-agent: `agent` may be Grok's. Its chat id comes from its prompt hook.
check("agentOf cursor", ["cursor-agent", " cursor-agent --model gpt-5 ", "agent", "cursor-agents", "cursor"].map(agentOf), ["cursor", "cursor", "shell", "shell", "shell"]);
check("new cursor pane starts a chat", launch("cursor-agent", S, false), ["cmd.exe", "/d", "/s", "/c", "cursor-agent"]);
check("restored cursor pane resumes its chat", launch("cursor-agent --model gpt-5", S, true, undefined, "b138b315-3d59")[4], "cursor-agent --resume b138b315-3d59 --model gpt-5");
check("no chat yet, a new one", launch("cursor-agent", S, true)[4], "cursor-agent");
check("cursor's own chat choice wins", ["cursor-agent resume", "cursor-agent ls", "cursor-agent --resume=abc", "cursor-agent --continue", "cursor-agent -p hi", "cursor-agent --model gpt-5"].map(ownSession), [true, true, true, true, true, false]);
// xAI's Grok CLI by its own name: `agent` is its agent.exe here but Cursor's elsewhere. Its session id comes from its prompt hook.
check("agentOf grok", ["grok", " grok --model grok-4.7 ", "agent", "groker"].map(agentOf), ["grok", "grok", "shell", "shell"]);
check("new grok pane starts a session, bare", launch("grok", S, false), ["grok"]);
check("restored grok pane resumes its session", launch("grok --model grok-4.7", S, true, undefined, "01a13766-164e-7d00"), ["grok", "--resume", "01a13766-164e-7d00", "--model", "grok-4.7"]);
check("no grok session yet, a new one", launch("grok", S, true), ["grok"]);
check("grok's own session choice wins", ["grok -r abc", "grok --resume=abc", "grok -c", "grok --session-id abc", "grok -p hi", "grok --model grok-4.7"].map(ownSession), [true, true, true, true, true, false]);
check("grok's titles name its session, not its spinner or status", [
  "Run node timeout then reply PONG - grok",
  "⠸ - Waiting for response… - Run node timeout then reply PONG - grok",
  "⠼ - Running 4 stop hooks… - Fix the login form - grok",
  "⠋ - Waiting for response… - grok",
  "⚠ Action Required - ⠴ - Remove the del1 directory recursively… - Run Node setTimeout then reply PONG - grok",
  "grok",
].map(grokTitle), ["Run node timeout then reply PONG", "Run node timeout then reply PONG", "Fix the login form", "", "Run Node setTimeout then reply PONG", "grok"]);
check("cursor's own --resume is left alone", launch("cursor-agent --resume abc", S, true, undefined, "saved")[4], "cursor-agent --resume abc");

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

check("fresh codex", launch("codex", S, false), ["cmd.exe", "/d", "/s", "/c", `codex ${CX} ${CODEX_NOTIFY}`]);
check("explicit standalone flag isn't doubled", launch("codex --no-daemon", S, false)[4], `codex ${CX.replace('--no-daemon ', '')} ${CODEX_NOTIFY} --no-daemon`);
check("Codex preserves an explicit screen-mode override", launch("codex -c tui.alternate_screen=always", S, false)[4], `codex ${CX} ${CODEX_NOTIFY} -c tui.alternate_screen=always`);
check(
  "restored codex resumes its own real session",
  launch("codex -m o3", S, true, undefined, S),
  ["cmd.exe", "/d", "/s", "/c", `codex resume ${S} ${CX} ${CODEX_NOTIFY} -m o3`],
);
check("fresh opencode", launch("opencode", S, false), ["cmd.exe", "/d", "/s", "/c", "opencode"]);
check(
  "restored opencode resumes its own real session",
  launch("opencode", S, true, undefined, "ses_first"),
  ["cmd.exe", "/d", "/s", "/c", "opencode --session ses_first"],
);
check("codex picker (only via the pane notice), never guesses last", launch("codex", S, true)[4], `codex resume ${CX} ${CODEX_NOTIFY}`);
check("two codex panes stay distinct", launch("codex", S, true, undefined, S)[4] === launch("codex", S, true, undefined, "second")[4], false);
check("two opencode panes stay distinct", launch("opencode", S, true, undefined, "ses_first")[4] === launch("opencode", S, true, undefined, "ses_second")[4], false);
check("explicit codex resume isn't doubled", launch(`codex resume ${S}`, S, true)[4], `codex ${CX} ${CODEX_NOTIFY} resume ${S}`);
check("explicit opencode session isn't doubled", launch("opencode --session ses_own", S, true, undefined, "ses_other")[4], "opencode --session ses_own");
check("session IDs reject shell injection", validSessionId("abc & whoami"), false);
// Titles codex 0.157 really drew with tui.terminal_title=['thread-id'].
check("codex title: cut thread id", codexThread("01a0dc17-ee73-7f70-8741-74e25..."), "01a0dc17-ee73-7f70-8741-74e25");
check("codex title: working spinner", codexThread("01a0dc54-f0cf-7cf1-a727-6ebc1... ⠴"), "01a0dc54-f0cf-7cf1-a727-6ebc1");
check("codex title: whole thread id", codexThread("01a0dc05-98a2-70c1-abe8-e95fe172076e"), "01a0dc05-98a2-70c1-abe8-e95fe172076e");
check("codex title: anything else is a name", codexThread("Ready | 01a0dc18-3d9f-7fd1-bc1e-e076f..."), undefined);
// Titles codex 0.160 drew with tui.terminal_title=['thread-id','run-state'] (probed 2026-10-04).
check("codex title: state alone, before the thread", codexTitle("Ready"), { thread: undefined, state: "Ready" });
check("codex title: thread and state", codexTitle("01a1044e-bfac-7c21-8008-9a965... | Working"), { thread: "01a1044e-bfac-7c21-8008-9a965", state: "Working" });
check("codex title: thread alone, as before", codexTitle("01a0dc17-ee73-7f70-8741-74e25..."), { thread: "01a0dc17-ee73-7f70-8741-74e25", state: undefined });
check("codex title: a name with a bar", codexTitle("my project | Working"), undefined);
check("codex title: a name", codexTitle("Review workspace navigation"), undefined);
check("codex run state: a turn runs", ["Working", "Thinking", "Waiting", "Ready", "Starting", undefined].map(codexRunning), [true, true, true, false, false, false]);
check("ownSession codex resume", ownSession("codex resume abc"), true);
check("ownSession codex flags only", ownSession("codex -m o3"), false);
check("ownSession opencode --session=", ownSession("opencode --session=ses_x"), true);
check("ownSession shell", ownSession("cmd"), false);

const PS = ["powershell.exe", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command"];
check("shell command runs under PowerShell with shell-init", launch("cmd", S, true), [...PS, ". $env:LOOM_INIT; cmd"]);
check("empty command is a plain shell", launch("  ", S, false), [...PS, ". $env:LOOM_INIT"]);

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
