//! loom.exe's helper modes, run by the agents as child processes: Claude Code's
//! statusline on every session state change and its SessionStart hook,
//! Codex's `notify` after every turn. They were PowerShell scripts, ~800 ms
//! and ~60 MB per run, and with eleven claude panes the statusline alone
//! started one a second. loom.exe starts in ~50 ms and leaves before Tauri is
//! touched (lib.rs `run`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Pane ids are Loom's own (uid() in main.ts) and name files: nothing else.
fn pane_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `loom.exe --statusline`, Loom's statusline tee. Claude Code re-runs it with
/// a fresh JSON payload every time session state changes (model, effort,
/// cost), which makes it the one push-based signal that follows /model and
/// /effort the moment they run. Save the payload for `usage::live_status`,
/// then hand it to the statusline the user configured, so their bar keeps
/// drawing exactly what it always did.
pub fn statusline() -> i32 {
    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    if let Some(pane) = std::env::var("LOOM_PANE").ok().filter(|p| pane_id(p)) {
        let dir = std::env::temp_dir().join("loom-status");
        let _ = std::fs::create_dir_all(&dir);
        // Line 1: the effort env var, since payloads have not always carried
        // effort. usage.rs prefers the payload's effort.level.
        let effort = std::env::var("CLAUDE_EFFORT").unwrap_or_default();
        let _ = std::fs::write(dir.join(marker_name(&pane, launch())), format!("{effort}\n{}", String::from_utf8_lossy(&input)));
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    match user_statusline(&cwd, &home) {
        Some(cmd) => chain(&cmd, &input),
        None => 0,
    }
}

/// `loom.exe --session-start`, Claude Code's SessionStart hook (claude-hooks.json).
/// It fires on startup, resume, /clear and compaction, the moments a pane's
/// transcript can change, and records the new one for `usage::transcript`.
/// Restores wait on that marker (`pane_booted`). Nothing outside a Loom pane
/// or for a payload without a transcript path; always exits 0.
pub fn session_start() -> i32 {
    let Some(pane) = std::env::var("LOOM_PANE").ok().filter(|p| pane_id(p)) else { return 0 };
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(input.trim_start_matches('\u{feff}')) else { return 0 };
    let Some(path) = payload["transcript_path"].as_str().filter(|p| !p.is_empty()) else { return 0 };
    let dir = std::env::temp_dir().join("loom-tx");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(marker_name(&pane, launch())), path);
    0
}

/// Which launch of its pane this process is (LOOM_LAUNCH), if Loom said.
fn launch() -> Option<u64> {
    std::env::var("LOOM_LAUNCH").ok().and_then(|l| l.parse().ok())
}

/// What a Claude marker (loom-tx, loom-status) is named: its pane and launch,
/// so a replaced process's late write is never read as its replacement's, which
/// reuses the pane id. Loom asks for `<pane>.<launch>` (main.ts claudeMarker).
pub(crate) fn marker_name(pane: &str, launch: Option<u64>) -> String {
    launch.map_or_else(|| pane.to_string(), |l| format!("{pane}.{l}"))
}

/// The statusline command the user configured. Project settings beat user
/// settings, matching Claude Code's own precedence.
fn user_statusline(cwd: &Path, home: &Path) -> Option<String> {
    [cwd.join(".claude/settings.json"), home.join(".claude/settings.json")]
        .iter()
        .find_map(|p| {
            let raw = std::fs::read_to_string(p).ok()?;
            let v: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
            Some(v["statusLine"]["command"].as_str()?.to_string()).filter(|c| !c.is_empty())
        })
}

/// Run `cmd` through cmd.exe with the payload on stdin and its output straight
/// to ours, so the bar gets the user's bytes untouched.
fn chain(cmd: &str, input: &[u8]) -> i32 {
    use std::os::windows::process::CommandExt;
    let child = std::process::Command::new("cmd")
        // `/s` strips the outer quotes and runs the rest verbatim.
        .raw_arg(format!("/s /c \"{cmd}\""))
        // The statusline runs in the pane's folder, which cmd searches before
        // PATH: a `node.cmd` a checkout carries would run instead of node.
        .env("NoDefaultCurrentDirectoryInExePath", "1")
        .stdin(std::process::Stdio::piped())
        // Release loom.exe has no console; without this cmd gets a visible one.
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
    let Ok(mut child) = child else { return 1 };
    // A statusline that never reads stdin just breaks the pipe: fine.
    let _ = child.stdin.take().map(|mut s| s.write_all(input));
    child.wait().ok().and_then(|s| s.code()).unwrap_or(1)
}

/// `loom.exe --codex-notify <event json>`, Codex's `notify` program (agent.ts:
/// CODEX_NOTIFY). Codex runs it after every completed turn; the thread id in
/// the event is what `codex resume` takes, so it is recorded for this pane,
/// and the turn's prompts go to loomctl's tasks. Internal and ephemeral agents
/// inherit notify too, so only a real root rollout counts for either. Always
/// exits 0: session tracking must never get in the agent's way.
pub fn codex_notify(event: Option<&str>) -> i32 {
    let Some(home) = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".codex")))
    else {
        return 0;
    };
    let Some((event, id)) = event.and_then(|e| Some((e, root_thread(&home, e)?))) else { return 0 };
    // Codex names the turn's prompts, so a task completes only on the turn that carried it.
    if let (Some(pane), Some(task)) = (loom_pane(), codex_event(event)) {
        task_event(&pane, "codex", task);
    }
    if let Some(file) = std::env::var_os("LOOM_SESSION_FILE").map(PathBuf::from) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // With its launch, so a replaced process's late report is told apart.
        let launch = std::env::var("LOOM_LAUNCH").ok().filter(|l| l.parse::<u64>().is_ok());
        publish(&file, &launch.map_or_else(|| id.clone(), |l| format!("{id}\n{l}")));
    }
    0
}

/// Write a marker Loom consumes by opening it alone (lib.rs `claim`): a write
/// in that instant meets a sharing violation, waited out rather than lost.
pub fn publish(path: &Path, text: &str) -> bool {
    for _ in 0..40 {
        match std::fs::write(path, text) {
            Ok(()) => return true,
            // ERROR_ACCESS_DENIED while the claimed one's delete is pending, ERROR_SHARING_VIOLATION.
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32)) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
    false
}

/// A finished Codex turn as a task event: the end of the turn that carried
/// these prompts (`input-messages`, codex-cli 0.159), with the turn's and
/// thread's ids, so the same turn reported twice counts once, and its final
/// message named (`last-assistant-message`, see `response`).
fn codex_event(event: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(event).ok()?;
    (v["type"] == "agent-turn-complete").then(|| {
        let matches: Vec<String> = v["input-messages"].as_array().into_iter().flatten().filter_map(|m| m.as_str()).map(prompt_match).collect();
        response(serde_json::json!({ "kind": "end", "matches": matches, "turn": v["turn-id"], "thread": v["thread-id"] }), &v["last-assistant-message"])
    })
}

/// `event` with the agent's final message named as a prompt is (`prompt_match`),
/// never its text: the same answer seen twice names the same, so the relay
/// downstream of `watch --metadata` can tell a repeat from a new one.
fn response(mut event: serde_json::Value, message: &serde_json::Value) -> serde_json::Value {
    if let Some(text) = message.as_str() {
        event["response"] = prompt_match(text).into();
    }
    event
}

fn loom_pane() -> Option<String> {
    std::env::var("LOOM_PANE").ok().filter(|p| pane_id(p))
}

/// `loom.exe --claude-hook`, Claude Code's prompt, turn and permission hooks
/// (claude-hooks.json), for loomctl's tasks (task.ts). UserPromptSubmit
/// starts a prompt, named by `prompt_match`, never by its text; Stop says the
/// turn stopped, which another Stop hook may overrule (Loom waits to see
/// Claude idle); StopFailure fails it with Claude's error; PermissionRequest
/// asks. Prints nothing and always exits 0: a UserPromptSubmit hook's output
/// would join the prompt, and exit 2 would block it.
pub fn claude_hook() -> i32 {
    let Some(pane) = loom_pane() else { return 0 };
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let Ok(p) = serde_json::from_str::<serde_json::Value>(input.trim_start_matches('\u{feff}')) else { return 0 };
    if let Some(event) = claude_event(&p) {
        task_event(&pane, "claude", event);
    }
    0
}

fn claude_event(p: &serde_json::Value) -> Option<serde_json::Value> {
    let text = |v: &serde_json::Value| v.as_str().map(|s| s.chars().take(200).collect::<String>());
    Some(match p["hook_event_name"].as_str()? {
        "UserPromptSubmit" => serde_json::json!({ "kind": "start", "match": prompt_match(p["prompt"].as_str()?) }),
        // Claude Code 2.1.288's Stop input has `last_assistant_message`, the text of the turn's last message.
        "Stop" => response(serde_json::json!({ "kind": "stop" }), &p["last_assistant_message"]),
        "StopFailure" => {
            let error = text(&p["error"]).unwrap_or_else(|| "unknown".into());
            let detail = match text(&p["error_details"]) {
                Some(more) => format!("{error}: {more}"),
                None => error,
            };
            serde_json::json!({ "kind": "fail", "detail": detail })
        }
        "PermissionRequest" => serde_json::json!({ "kind": "approval", "detail": text(&p["tool_name"]) }),
        _ => return None,
    })
}

/// How the agents' reports name a prompt, as task.ts `promptMatch` does:
/// FNV-1a 64 of the UTF-8 with each run of ASCII whitespace made one space
/// and the ends trimmed (Claude turns CRLF into LF and tabs into spaces, but
/// "edit foo bar" isn't "edit foobar"), and the tags Claude wraps a collapsed
/// paste in counted as spacing, in hex.
pub fn prompt_match(text: &str) -> String {
    let bare = without_paste_tags(text);
    let words: Vec<&str> = bare.split(|c| matches!(c, '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ')).filter(|w| !w.is_empty()).collect();
    let h = words.join(" ").bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

/// `text` with `<pasted_content id="8e95">` and `</pasted_content id="8e95">`
/// (four hex digits), which Claude Code 2.1.287 puts around a paste it
/// collapsed, made spaces.
fn without_paste_tags(text: &str) -> String {
    let (b, mut out, mut i) = (text.as_bytes(), String::with_capacity(text.len()), 0);
    while i < b.len() {
        let tag = ["<pasted_content id=\"", "</pasted_content id=\""].iter().find_map(|open| {
            let id = i + open.len();
            let hex = |c: &u8| c.is_ascii_digit() || (b'a'..=b'f').contains(c);
            (b[i..].starts_with(open.as_bytes()) && b.len() >= id + 6 && b[id..id + 4].iter().all(hex) && &b[id + 4..id + 6] == b"\">").then_some(id + 6)
        });
        match tag {
            Some(end) => {
                out.push(' ');
                i = end;
            }
            None => {
                let c = text[i..].chars().next().unwrap_or_default();
                out.push(c);
                i += c.len_utf8().max(1);
            }
        }
    }
    out
}

/// One agent event for `send_task_events` (lib.rs), from the pane launch in
/// LOOM_LAUNCH; a process started without one reports nothing.
fn task_event(pane: &str, src: &str, event: serde_json::Value) {
    let launch = std::env::var("LOOM_LAUNCH").ok().and_then(|l| l.parse().ok());
    write_task_event(&std::env::temp_dir().join("loom-task"), pane, launch, src, event);
}

/// `<dir>\<pane>.<µs>.<pid>.json`, written beside and renamed in, so the drain
/// never reads half of one, and named so a pane's events sort in the order
/// they were written. Claude's prompt hook runs in step (claude-hooks.json),
/// so its report is written before that turn's Stop can be.
fn write_task_event(dir: &Path, pane: &str, launch: Option<u64>, src: &str, mut event: serde_json::Value) {
    let Some(launch) = launch else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    event["src"] = src.into();
    event["t"] = (now.as_millis() as u64).into();
    event["launch"] = launch.into();
    let _ = std::fs::create_dir_all(dir);
    let name = format!("{pane}.{:016}.{}", now.as_micros(), std::process::id());
    let tmp = dir.join(format!("{name}.tmp"));
    if std::fs::write(&tmp, event.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join(format!("{name}.json")));
    }
}

/// The event's thread id, if it names a saved root conversation.
fn root_thread(codex_home: &Path, event: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(event).ok()?;
    let id = v["thread-id"].as_str()?;
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    let rows = crate::codex_session_rows(codex_home, "", Some(id)).ok()?;
    (!rows.is_empty()).then(|| id.to_string())
}

/// A codex pane's command line (`codex <args>`, as agent.ts builds it for
/// cmd.exe) as a direct launch of the native codex.exe: program, argv, and the
/// env the npm shim would have set. The shim chain is cmd.exe → codex.cmd →
/// node codex.js → codex.exe, and cmd and node then sit idle under every pane
/// for its whole life, ~25 MB between them. None = launch through cmd as
/// before: cmd syntax in the line, or a codex on PATH that isn't a plain npm
/// install.
pub fn codex_direct(line: &str) -> Option<(PathBuf, Vec<String>, Vec<(&'static str, String)>)> {
    let tail = line.strip_prefix("codex").filter(|t| t.is_empty() || t.starts_with(' '))?;
    // cmd would act on these (`||` in a startup command, `%var%`): keep cmd.
    if tail.contains(['&', '|', '<', '>', '^', '%', '!']) {
        return None;
    }
    let shim_dir = codex_shim_dir()?;
    let pkg = shim_dir.join("node_modules/@openai/codex");
    // pnpm and bun installs keep their own layouts and manager env: cmd path.
    if shim_dir.join("node_modules/.modules.yaml").exists() || shim_dir.to_string_lossy().contains(".bun") {
        return None;
    }
    // Where codex.js's require.resolve looks: nested first, then hoisted,
    // then the package's own vendor folder.
    let exe = [
        pkg.join("node_modules/@openai/codex-win32-x64/vendor"),
        shim_dir.join("node_modules/@openai/codex-win32-x64/vendor"),
        pkg.join("vendor"),
    ]
    .into_iter()
    .map(|v| PathBuf::from(v.join("x86_64-pc-windows-msvc/bin/codex.exe").to_string_lossy().replace('/', "\\")))
    .find(|p| p.is_file())?;
    let root = std::fs::canonicalize(&pkg).ok()?;
    let root = root.to_string_lossy();
    let root = root.strip_prefix(r"\\?\").unwrap_or(&root).to_string();
    // What codex.js sets for an npm install (and it clears the other managers').
    let env = vec![("CODEX_MANAGED_PACKAGE_ROOT", root), ("CODEX_MANAGED_BY_NPM", "1".into())];
    Some((exe, split_args(tail), env))
}

/// The folder holding the npm `codex.cmd` that `codex` is on PATH, never the
/// pane's folder (lib.rs `on_path`). Anything else found first (a codex.exe on
/// PATH, a pnpm or bun shim) is None, and cmd runs that by its full path.
fn codex_shim_dir() -> Option<PathBuf> {
    let hit = crate::on_path("codex")?;
    let dir = hit.parent()?;
    let npm = hit.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
        && dir.join("node_modules/@openai/codex/bin/codex.js").is_file();
    npm.then(|| dir.to_path_buf())
}

/// Split a command line the way the MSVC runtime does, which is how node and
/// then codex.exe would have received it: whitespace separates, quotes group,
/// backslashes are literal unless they precede a quote.
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut any) = (false, false);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut n = 1;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    n += 1;
                }
                if chars.peek() == Some(&'"') {
                    cur.extend(std::iter::repeat('\\').take(n / 2));
                    if n % 2 == 1 {
                        chars.next();
                        cur.push('"');
                    }
                } else {
                    cur.extend(std::iter::repeat('\\').take(n));
                }
                any = true;
            }
            '"' => {
                // `""` inside quotes is a literal quote.
                if quoted && chars.peek() == Some(&'"') {
                    chars.next();
                    cur.push('"');
                } else {
                    quoted = !quoted;
                }
                any = true;
            }
            ' ' | '\t' if !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            _ => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_msvc() {
        let got = split_args(r#" resume abc -c tui.x=true -c "notify=['C:\Users\a b\loom.exe','--codex-notify']" -m o3 "#);
        assert_eq!(got, ["resume", "abc", "-c", "tui.x=true", "-c", r"notify=['C:\Users\a b\loom.exe','--codex-notify']", "-m", "o3"]);
        assert_eq!(split_args(r#"a\\"b c" d\"e "" x"#), [r#"a\b c"#, r#"d"e"#, "", "x"]);
        assert!(split_args("").is_empty());
    }

    #[test]
    fn statusline_prefers_project_settings() {
        let root = std::env::temp_dir().join(format!("loom-statusline-test-{}", std::process::id()));
        let (cwd, home) = (root.join("repo"), root.join("home"));
        for d in [&cwd, &home] {
            std::fs::create_dir_all(d.join(".claude")).unwrap();
        }
        assert_eq!(user_statusline(&cwd, &home), None, "no settings: nothing to chain");
        // BOM, as PowerShell's Set-Content writes it.
        std::fs::write(home.join(".claude/settings.json"), "\u{feff}{\"statusLine\":{\"command\":\"user\"}}").unwrap();
        assert_eq!(user_statusline(&cwd, &home).as_deref(), Some("user"));
        std::fs::write(cwd.join(".claude/settings.json"), r#"{"permissions":{}}"#).unwrap();
        assert_eq!(user_statusline(&cwd, &home).as_deref(), Some("user"), "project without one falls through");
        std::fs::write(cwd.join(".claude/settings.json"), r#"{"statusLine":{"command":"project"}}"#).unwrap();
        assert_eq!(user_statusline(&cwd, &home).as_deref(), Some("project"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chain_pipes_payload_and_output() {
        // findstr exits 0 only on a match in stdin: the payload got in, and the
        // exit code came back out. Quoted and absolute, like a real statusline
        // command (and cmd gives up on the long PATH `cargo test` can have).
        let findstr = r#""%SystemRoot%\System32\findstr.exe""#;
        assert_eq!(chain(&format!("{findstr} display_name >nul"), br#"{"display_name":"Fable 5"}"#), 0);
        assert_eq!(chain(&format!("{findstr} nothing-here >nul"), br#"{"display_name":"Fable 5"}"#), 1);
    }

    #[test]
    fn notify_records_only_root_rollouts() {
        let home = std::env::temp_dir().join(format!("loom-notify-test-{}", std::process::id()));
        let sessions = home.join("sessions/2026/09/12");
        std::fs::create_dir_all(&sessions).unwrap();
        for (id, source) in [("root-1", serde_json::json!("cli")), ("guardian", serde_json::json!({"subagent": {"other": "guardian"}}))] {
            let meta = serde_json::json!({"type": "session_meta", "payload": {"id": id, "source": source}});
            std::fs::write(sessions.join(format!("rollout-test-{id}.jsonl")), format!("{meta}\n")).unwrap();
        }
        let ev = |id: &str| serde_json::json!({"type": "agent-turn-complete", "thread-id": id}).to_string();
        assert_eq!(root_thread(&home, &ev("root-1")).as_deref(), Some("root-1"));
        assert_eq!(root_thread(&home, &ev("ephemeral")), None, "no saved rollout");
        assert_eq!(root_thread(&home, &ev("guardian")), None, "subagent");
        assert_eq!(root_thread(&home, &ev("../x")), None, "not an id");
        assert_eq!(root_thread(&home, "not json"), None);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn prompts_are_named_as_task_ts_names_them() {
        // The same values src/task.test.ts pins for promptMatch.
        assert_eq!(prompt_match("Reply with exactly the word ALPHA.\r\nLine two  \r\n\tline three with a tab"), "45f3880110629eda");
        assert_eq!(prompt_match("Reply with exactly the word ALPHA.\nLine two  \n    line three with a tab"), "45f3880110629eda");
        assert_eq!(prompt_match("héllo wörld ✓"), "4aee6004cebc55b9");
        // Where spacing falls counts (the review's collision), and only ASCII spacing is spacing.
        assert_eq!((prompt_match("edit foo bar").as_str(), prompt_match("edit foobar").as_str()), ("5614147f87873c08", "150936de3eb42a92"));
        assert_eq!(prompt_match("\u{a0}x\u{a0}"), "9baab6eab24e743f");
        // A collapsed paste, as Claude Code 2.1.287 reported it in a live session.
        let lines: Vec<String> = (0..40).map(|i| format!("    filler line {i}  ")).collect();
        let hook = format!("\n\n<pasted_content id=\"8e95\">\nReply with exactly the word LINES.\n{}\n</pasted_content id=\"8e95\">\n", lines.join("\n"));
        assert_eq!(prompt_match(&hook), "99f2aa029a84bdb5");
        assert_ne!(prompt_match("<pasted_content id=\"zz\">x"), prompt_match("x"), "only Claude's own tag shape");
        assert_eq!(without_paste_tags("é<pasted_content id=\"0a1f\">ü</pasted_content id=\"0a1f\">"), "é ü ");
    }

    #[test]
    fn claude_hooks_become_task_events() {
        use serde_json::json;
        let ev = |v: serde_json::Value| claude_event(&v);
        // Payload shapes as Claude Code 2.1.287 sends them.
        assert_eq!(ev(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "run the tests" })), Some(json!({ "kind": "start", "match": prompt_match("run the tests") })));
        assert_eq!(ev(json!({ "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": "done" })), Some(json!({ "kind": "stop", "response": prompt_match("done") })), "a Stop another hook may overrule, naming its final message");
        assert_eq!(ev(json!({ "hook_event_name": "Stop", "stop_hook_active": false })), Some(json!({ "kind": "stop" })), "no final message, none named");
        assert_eq!(prompt_match("Done.\r\n\r\nAll  tests pass."), prompt_match("Done.\nAll tests pass."), "named by its words, not its spacing");
        assert_eq!(ev(json!({ "hook_event_name": "StopFailure", "error": "rate_limit", "error_details": "429" })), Some(json!({ "kind": "fail", "detail": "rate_limit: 429" })));
        assert_eq!(ev(json!({ "hook_event_name": "StopFailure" })), Some(json!({ "kind": "fail", "detail": "unknown" })));
        assert_eq!(ev(json!({ "hook_event_name": "PermissionRequest", "tool_name": "Write" })), Some(json!({ "kind": "approval", "detail": "Write" })));
        assert_eq!(ev(json!({ "hook_event_name": "SessionEnd" })), None);
        assert_eq!(ev(json!({ "hook_event_name": "UserPromptSubmit" })), None, "no prompt, no start");
        // The prompt's text never leaves the hook: only its match does.
        assert!(!ev(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "secret-token-123" })).unwrap().to_string().contains("secret"));
        assert!(!ev(json!({ "hook_event_name": "Stop", "last_assistant_message": "secret-answer-456" })).unwrap().to_string().contains("secret"), "nor the answer's");
    }

    #[test]
    fn a_codex_turn_names_its_prompts() {
        // What codex-cli 0.159.3's notify sent for `codex exec` with a two-line prompt.
        let real = r#"{"type":"agent-turn-complete","thread-id":"01a0f9f2-5116-7ca3-981e-f2988675d53e","turn-id":"01a0f9f2-6368-77d3-b0b9-e0b499cc8f4c","cwd":"C:\\x","client":"codex_exec","input-messages":["Reply with exactly the word OK.\nSecond line\twith a tab."],"last-assistant-message":"OK"}"#;
        let sent = "Reply with exactly the word OK.\r\nSecond line\twith a tab.";
        let turn = "01a0f9f2-6368-77d3-b0b9-e0b499cc8f4c";
        assert_eq!(codex_event(real), Some(serde_json::json!({ "kind": "end", "matches": [prompt_match(sent)], "turn": turn, "thread": "01a0f9f2-5116-7ca3-981e-f2988675d53e", "response": prompt_match("OK") })));
        assert_eq!(codex_event(r#"{"type":"approval-requested"}"#), None);
        assert_eq!(codex_event("not json"), None);
    }

    #[test]
    fn a_task_event_names_its_launch_or_isnt_written() {
        let dir = std::env::temp_dir().join(format!("loom-task-event-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_task_event(&dir, "p-1", None, "claude", serde_json::json!({ "kind": "stop" }));
        assert!(!dir.exists() || std::fs::read_dir(&dir).unwrap().next().is_none(), "no launch, no report");
        write_task_event(&dir, "p-1", Some(7), "claude", serde_json::json!({ "kind": "start", "match": "ab" }));
        write_task_event(&dir, "p-1", Some(7), "claude", serde_json::json!({ "kind": "stop" }));
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|n| n.starts_with("p-1.") && n.ends_with(".json") && n.split('.').nth(1).unwrap().len() == 16), "{names:?}");
        let first: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(&names[0])).unwrap()).unwrap();
        assert_eq!((first["kind"].as_str(), first["launch"].as_u64(), first["src"].as_str()), (Some("start"), Some(7), Some("claude")), "written first, sorted first");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_marker_written_while_loom_takes_the_last_one_lands_after() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = std::env::temp_dir().join(format!("loom-publish-test-{}", std::process::id()));
        std::fs::write(&path, "old").unwrap();
        // Loom's claim (lib.rs): read and delete access, opened alone, deleted on close.
        let held = std::fs::OpenOptions::new().access_mode(0x8001_0000).share_mode(0).custom_flags(0x0400_0000).open(&path).unwrap();
        let release = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(200)); drop(held); });
        assert!(publish(&path, "new"));
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        std::fs::remove_file(path).unwrap();
    }

    /// Against this machine's own npm codex: `cargo test -- --ignored codex_direct_real`.
    #[test]
    #[ignore]
    fn codex_direct_real_install() {
        let (exe, args, env) = codex_direct(r#"codex resume abc -c "notify=['C:\x\loom.exe','--codex-notify']""#)
            .expect("an npm codex on PATH");
        println!("{} {args:?} {env:?}", exe.display());
        assert!(exe.ends_with("x86_64-pc-windows-msvc/bin/codex.exe") && exe.is_file());
        assert_eq!(args, ["resume", "abc", "-c", r"notify=['C:\x\loom.exe','--codex-notify']"]);
        assert!(Path::new(&env[0].1).join("bin/codex.js").is_file(), "package root: {}", env[0].1);
    }

    #[test]
    fn codex_direct_keeps_cmd_syntax_on_cmd() {
        assert!(codex_direct("codex || echo gone").is_none());
        assert!(codex_direct("codex %X%").is_none());
        assert!(codex_direct("codexx").is_none());
    }
}
