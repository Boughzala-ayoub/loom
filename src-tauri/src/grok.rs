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

/// The events Loom's file answers: a prompt going in, and each way a turn ends.
const EVENTS: [&str; 4] = ["UserPromptSubmit", "Stop", "StopFailure", "StopCancelled"];

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
    std::fs::read_dir(home.join(".grok").join("sessions")).ok()?.flatten()
        .map(|e| e.path().join(sid).join("chat_history.jsonl"))
        .find(|p| p.is_file())
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
}
