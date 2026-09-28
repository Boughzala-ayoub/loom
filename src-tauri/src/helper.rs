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
        let _ = std::fs::write(dir.join(pane), format!("{effort}\n{}", String::from_utf8_lossy(&input)));
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
    let _ = std::fs::write(dir.join(pane), path);
    0
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
/// the event is what `codex resume` takes, so it is recorded for this pane.
/// Internal and ephemeral agents inherit notify too, so only a real root
/// rollout is recorded. Always exits 0: session tracking must never get in
/// the agent's way.
pub fn codex_notify(event: Option<&str>) -> i32 {
    let Some(file) = std::env::var_os("LOOM_SESSION_FILE") else { return 0 };
    let Some(home) = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".codex")))
    else {
        return 0;
    };
    if let Some(id) = event.and_then(|e| root_thread(&home, e)) {
        let file = PathBuf::from(file);
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, id);
    }
    0
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
/// before: cmd syntax in the line, or a codex that cmd would not resolve to a
/// plain npm install.
pub fn codex_direct(line: &str, cwd: Option<&Path>) -> Option<(PathBuf, Vec<String>, Vec<(&'static str, String)>)> {
    let tail = line.strip_prefix("codex").filter(|t| t.is_empty() || t.starts_with(' '))?;
    // cmd would act on these (`||` in a startup command, `%var%`): keep cmd.
    if tail.contains(['&', '|', '<', '>', '^', '%', '!']) {
        return None;
    }
    let shim_dir = codex_shim_dir(cwd)?;
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

/// The folder holding the npm `codex.cmd` that cmd.exe would run for `codex`:
/// the pane's folder first, then PATH, trying PATHEXT's extensions in order in
/// each. Anything else found first (a codex.exe on PATH, a codex.bat in the
/// repo) is None, and cmd runs that exactly as before.
fn codex_shim_dir(cwd: Option<&Path>) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let path = std::env::var_os("PATH")?;
    let dirs = cwd.map(Path::to_path_buf).into_iter().chain(std::env::split_paths(&path));
    for dir in dirs {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let hit = dir.join(format!("codex{ext}"));
            if hit.is_file() {
                let npm = ext.eq_ignore_ascii_case(".cmd")
                    && dir.join("node_modules/@openai/codex/bin/codex.js").is_file();
                return npm.then_some(dir);
            }
        }
    }
    None
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

    /// Against this machine's own npm codex: `cargo test -- --ignored codex_direct_real`.
    #[test]
    #[ignore]
    fn codex_direct_real_install() {
        let (exe, args, env) = codex_direct(r#"codex resume abc -c "notify=['C:\x\loom.exe','--codex-notify']""#, None)
            .expect("an npm codex on PATH");
        println!("{} {args:?} {env:?}", exe.display());
        assert!(exe.ends_with("x86_64-pc-windows-msvc/bin/codex.exe") && exe.is_file());
        assert_eq!(args, ["resume", "abc", "-c", r"notify=['C:\x\loom.exe','--codex-notify']"]);
        assert!(Path::new(&env[0].1).join("bin/codex.js").is_file(), "package root: {}", env[0].1);
    }

    #[test]
    fn codex_direct_keeps_cmd_syntax_on_cmd() {
        assert!(codex_direct("codex || echo gone", None).is_none());
        assert!(codex_direct("codex %X%", None).is_none());
        assert!(codex_direct("codexx", None).is_none());
    }
}
