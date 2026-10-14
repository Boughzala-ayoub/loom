//! xAI's Grok CLI (Grok Build) in a pane, by its own name, `grok` (agent.ts).
//!
//! Its hooks name each turn (promptId) and say how it ended: Stop, StopFailure,
//! or StopCancelled (Ctrl+C, a dismissed or rejected permission prompt). Grok
//! reads every ~/.grok/hooks/*.json and trusts them all, so Loom keeps a file
//! of its own there, loom.json, and never edits the user's. Its entries run
//! `loom.exe --grok-hook` (helper.rs), which does nothing outside a Loom pane,
//! so a Grok session elsewhere runs them for nothing. Grok runs a hook's
//! command through the shell it finds on Windows: PowerShell in a pane (lib.rs
//! clears MSYSTEM and SHELL), Git Bash where those name it.

use std::path::{Path, PathBuf};

/// The events Loom's file answers: a prompt going in, each way a turn ends,
/// and Grok's notices, for the one it sends once it has settled (idle_prompt).
const EVENTS: [&str; 5] = ["UserPromptSubmit", "Stop", "StopFailure", "StopCancelled", "Notification"];

/// Whether a pane's program is Grok's CLI (agent.ts launches it bare).
pub fn is_grok(program: &str) -> bool {
    program.eq_ignore_ascii_case("grok")
}

/// Loom's hooks in `home`\.grok\hooks\loom.json, naming `exe`. Written only
/// when they changed, and through a rename, so panes starting together never
/// leave Grok a half-written file.
pub fn install(home: &Path, exe: &Path) -> Result<(), String> {
    let path = home.join(".grok").join("hooks").join("loom.json");
    let text = hooks(exe);
    if std::fs::read_to_string(&path).is_ok_and(|old| old == text) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    crate::cursor::replace(&path, &text).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// The command each entry runs. loom.exe's path with forward slashes, bare,
/// runs in PowerShell, Git Bash and cmd alike, so a Grok started from any of
/// them runs it quietly. A path with anything else in it (a space) is quoted
/// for PowerShell, the shell a pane's Grok uses.
fn command(exe: &Path) -> String {
    let path = exe.display().to_string().replace('\\', "/");
    if path.chars().all(|c| c.is_ascii_alphanumeric() || "/:._-".contains(c)) {
        format!("{path} --grok-hook")
    } else {
        format!("& '{}' --grok-hook", path.replace('\'', "''"))
    }
}

fn hooks(exe: &Path) -> String {
    let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command(exe), "timeout": 10 }] }]);
    let hooks: serde_json::Map<String, serde_json::Value> = EVENTS.iter().map(|e| (e.to_string(), entry.clone())).collect();
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks })).unwrap_or_default() + "\n"
}

/// Session `sid`'s chat history: ~\.grok\sessions\<the folder, URL-encoded>\<sid>\chat_history.jsonl,
/// found by its id under any folder.
pub fn transcript(home: &Path, sid: &str) -> Option<PathBuf> {
    session_file(home, sid, "chat_history.jsonl")
}

fn session_file(home: &Path, sid: &str, name: &str) -> Option<PathBuf> {
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    std::fs::read_dir(home.join(".grok").join("sessions")).ok()?.flatten()
        .map(|e| e.path().join(sid).join(name))
        .find(|p| p.is_file())
}

/// How Grok's session log says turn `turn` of session `sid` ended: the
/// stop_reason of its turn_completed in updates.jsonl, at or after byte `from`
/// (the log's length at the turn's Stop), or "error" where it names an
/// error_kind. Grok writes it once, as the turn really ends, after any Stop
/// another hook sent the turn on from (seen in 1.0.52's logs). None until then,
/// and where the log can't be read.
pub fn turn_end(home: &Path, sid: &str, turn: &str, from: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut log = std::fs::File::open(session_file(home, sid, "updates.jsonl")?).ok()?;
    log.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::new();
    log.read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes).lines()
        .filter(|l| l.contains("turn_completed") && l.contains(turn))
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| v["params"]["update"].clone())
        .find(|u| u["sessionUpdate"] == "turn_completed" && u["prompt_id"] == turn)
        .map(|u| if u["error_kind"].is_null() { u["stop_reason"].as_str().unwrap_or("unknown").to_string() } else { "error".to_string() })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn grok_is_grok_only() {
        assert!(super::is_grok("grok") && super::is_grok("GROK"));
        assert!(!super::is_grok("agent"), "may be Cursor's");
        assert!(!super::is_grok("grok.cmd"));
    }

    #[test]
    fn hooks_run_loom_in_any_shell() {
        assert_eq!(super::command(Path::new(r"C:\Users\a\AppData\Local\Loom\loom.exe")), "C:/Users/a/AppData/Local/Loom/loom.exe --grok-hook");
        assert_eq!(super::command(Path::new(r"C:\Program Files\Loom's\loom.exe")), "& 'C:/Program Files/Loom''s/loom.exe' --grok-hook");
        let v: serde_json::Value = serde_json::from_str(&super::hooks(Path::new(r"C:\L\loom.exe"))).unwrap();
        for event in super::EVENTS {
            assert_eq!(v["hooks"][event][0]["hooks"][0]["command"], "C:/L/loom.exe --grok-hook", "{event}");
        }
    }

    #[test]
    fn install_writes_loom_json_once_and_leaves_the_users_files() {
        let home = std::env::temp_dir().join(format!("loom-grok-test-{}", std::process::id()));
        let hooks = home.join(".grok").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("mine.json"), "{\"hooks\":{}}").unwrap();
        super::install(&home, Path::new(r"C:\L\loom.exe")).unwrap();
        let written = std::fs::metadata(hooks.join("loom.json")).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        super::install(&home, Path::new(r"C:\L\loom.exe")).unwrap();
        assert_eq!(std::fs::metadata(hooks.join("loom.json")).unwrap().modified().unwrap(), written, "unchanged: not rewritten");
        super::install(&home, Path::new(r"C:\M\loom.exe")).unwrap();
        assert!(std::fs::read_to_string(hooks.join("loom.json")).unwrap().contains("C:/M/loom.exe"), "a new loom.exe is named");
        assert_eq!(std::fs::read_to_string(hooks.join("mine.json")).unwrap(), "{\"hooks\":{}}");
        let session = home.join(".grok").join("sessions").join("C%3A%5Cw").join("01a1");
        std::fs::create_dir_all(&session).unwrap();
        std::fs::write(session.join("chat_history.jsonl"), "").unwrap();
        assert_eq!(super::transcript(&home, "01a1"), Some(session.join("chat_history.jsonl")));
        assert_eq!(super::transcript(&home, "02b2"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_turns_end_is_its_turn_completed_in_the_session_log() {
        let home = std::env::temp_dir().join(format!("loom-grok-log-{}", std::process::id()));
        let session = home.join(".grok").join("sessions").join("C%3A%5Cw").join("01a1");
        std::fs::create_dir_all(&session).unwrap();
        // Lines as Grok Build 1.0.52 writes them (updates.jsonl).
        let line = |update: &str| format!(r#"{{"timestamp":1791978290,"method":"_x.ai/session/update","params":{{"sessionId":"01a1","update":{update}}}}}"#);
        let stop = line(r#"{"sessionUpdate":"hook_execution","event_name":"stop","runs":[]}"#);
        let lines = [
            stop.clone(),
            line(r#"{"sessionUpdate":"turn_completed","prompt_id":"pA","stop_reason":"end_turn","elapsed_ms":39681}"#),
            line(r#"{"sessionUpdate":"turn_completed","prompt_id":"pB","stop_reason":"cancelled","elapsed_ms":1314}"#),
            line(r#"{"sessionUpdate":"turn_completed","prompt_id":"pC","stop_reason":"end_turn","error_kind":"rate_limit"}"#),
            line(r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"turn_completed pD"}}"#),
        ];
        std::fs::write(session.join("updates.jsonl"), lines.join("\n") + "\n").unwrap();
        let end = |turn: &str, from: u64| super::turn_end(&home, "01a1", turn, from);
        assert_eq!(end("pA", 0).as_deref(), Some("end_turn"));
        assert_eq!(end("pB", 0).as_deref(), Some("cancelled"));
        assert_eq!(end("pC", 0).as_deref(), Some("error"), "an error is no success, whatever its stop_reason");
        assert_eq!(end("pD", 0), None, "not written yet: a message that names it is no end");
        assert_eq!(end("pA", stop.len() as u64 + 1 + 40), None, "only from the Stop on");
        assert_eq!(end("pA", 1 << 40), None, "from past the end");
        assert_eq!(super::turn_end(&home, "02b2", "pA", 0), None, "another session");
        assert_eq!(super::turn_end(&home, "..", "pA", 0), None, "no way out of sessions");
        let _ = std::fs::remove_dir_all(&home);
    }
}
