//! Keep the CLI used to launch a pane for session reads too. `opencode` can be v1 or v2.
use std::{os::windows::process::CommandExt, path::Path, process::Command, sync::Mutex, time::{Duration, Instant}};

pub fn command(line: &str) -> Option<&str> {
    let name = line.split_whitespace().next()?;
    matches!(name, "opencode" | "opencode1" | "opencode2").then_some(name)
}

/// `name` runs from PATH, by its full path, never from `dir`, where cmd.exe
/// would look first (lib.rs `on_path`). `/s` strips the outer quotes and runs
/// the rest as it is, the quoted path included.
fn cli(name: &str, dir: &str, args: &str) -> Result<Command, String> {
    let line = super::with_program(&format!("{name} {args}"), super::on_path)?;
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(format!("/d /s /c \"{line}\""))
        .current_dir(dir).creation_flags(0x0800_0000)
        // For what `name` runs, such as an npm shim's `node` (lib.rs pty_spawn).
        .env("NoDefaultCurrentDirectoryInExePath", "1")
        // Read-only helper processes must not masquerade as the live pane.
        .env_remove("LOOM_PANE").env_remove("LOOM_SESSION_FILE");
    Ok(cmd)
}

fn major(name: &str, dir: &str) -> Result<u32, String> {
    if command(name) != Some(name) { return Err("Invalid OpenCode command".into()); }
    // OpenCode 2 startup serializes on its data files: five checks at once took 12 s each.
    // So one check runs at a time, and callers that queued behind it take its answer.
    static LAST: Mutex<Vec<(String, String, Instant, Result<u32, String>)>> = Mutex::new(Vec::new());
    let asked = Instant::now();
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((.., at, result)) = last.iter().find(|(n, d, ..)| n == name && d == dir) {
        if *at > asked { return result.clone(); }
    }
    let result = check_major(name, dir);
    last.retain(|(n, d, ..)| n != name || d != dir);
    last.push((name.into(), dir.into(), Instant::now(), result.clone()));
    result
}

fn check_major(name: &str, dir: &str) -> Result<u32, String> {
    // A lone check has taken 2.7 s here.
    let bytes = super::export_output(&mut cli(name, dir, "--version")?, Duration::from_secs(10))
        .ok_or_else(|| format!("Could not read {name} version. Check that it is installed."))?;
    let version = String::from_utf8_lossy(&bytes);
    match parse_major(&version) {
        Some(v @ (1 | 2)) => Ok(v),
        _ => Err(format!("Unsupported OpenCode version: {}", version.trim())),
    }
}

fn parse_major(version: &str) -> Option<u32> {
    version.split_whitespace().last()?.trim_start_matches('v').split('.').next()?.parse().ok()
}

pub fn launch(line: &str, dir: &str) -> Result<String, String> {
    let line = line.trim();
    let Some(name) = command(line) else { return Ok(line.into()) };
    if major(name, dir)? == 1 { return Ok(line.into()); }
    let args: Vec<_> = line.split_whitespace().collect();
    if args.iter().any(|s| *s == "--server" || s.starts_with("--server=")) {
        return Err("Loom needs a private OpenCode 2 server for pane tracking. Remove --server.".into());
    }
    Ok(if args.contains(&"--standalone") { line.into() }
        else { format!("{name} --standalone{}", &line[name.len()..]) })
}

pub fn install(home: &Path) -> Result<(), String> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    super::ensure_file(&base.join("opencode/plugins/loom.js"), super::OPENCODE_PLUGIN)
}

pub fn sessions(dir: &str, name: &str) -> Result<Vec<serde_json::Value>, String> {
    let version = major(name, dir)?;
    let args = if version == 2 { "session list --format json --standalone" } else { "session list --format json" };
    // V2 starts and shuts down a private server even for reads (measured 6–11s).
    let out = super::export_output(&mut cli(name, dir, args)?, Duration::from_secs(if version == 2 { 20 } else { 5 }))
        .ok_or("OpenCode session list failed or timed out")?;
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&out).map_err(|e| e.to_string())?;
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    Ok(rows.into_iter().filter(|r| r["directory"].as_str().is_some_and(|d| norm(d) == norm(dir))).collect())
}

pub fn messages(dir: &str, sid: &str, name: &str) -> Option<super::LastMessages> {
    let version = major(name, dir).ok()?;
    let args = if version == 2 { format!("session export {sid} --standalone") }
        else { format!("export {sid} --pure") };
    let out = super::export_output(&mut cli(name, dir, &args).ok()?, Duration::from_secs(if version == 2 { 20 } else { 5 }))?;
    let data = serde_json::from_slice(&out).ok()?;
    Some(super::opencode_export_messages(&data))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_known_commands() {
        assert_eq!(super::parse_major("1.18.32\r\n"), Some(1));
        assert_eq!(super::parse_major("opencode v2.0.18\r\n"), Some(2));
        assert_eq!(super::parse_major("command not found"), None);
        for name in ["opencode", "opencode1", "opencode2"] {
            assert_eq!(super::command(&format!("{name} --session ses_test")), Some(name));
        }
        assert_eq!(super::command("opencode-evil"), None);
        assert_eq!(super::command("opencode&calc"), None);
    }

    /// `opencode`, `opencode1` and `opencode2` on PATH, in a folder with a space
    /// in its name, each running the `stand-in.cmd` of the folder it runs in by
    /// its full path: the test's own behaviour. Loom runs these from PATH only.
    fn stand_ins() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let bin = std::env::temp_dir().join("loom opencode stand-ins");
            std::fs::create_dir_all(&bin).unwrap();
            for name in ["opencode", "opencode1", "opencode2"] {
                std::fs::write(bin.join(format!("{name}.cmd")), "@\"%CD%\\stand-in.cmd\" %*\r\n").unwrap();
            }
            let mut path = std::ffi::OsString::from(&bin);
            path.push(";");
            path.push(std::env::var_os("PATH").unwrap_or_default());
            std::env::set_var("PATH", path);
        });
    }

    /// What an agent or a branch could leave in the checkout, by each name.
    fn plant(root: &std::path::Path) {
        for name in ["opencode", "opencode1", "opencode2"] {
            for ext in ["cmd", "bat"] {
                std::fs::write(root.join(format!("{name}.{ext}")), "@echo off\r\necho x>>planted.txt\r\necho opencode v1.0.0\r\n").unwrap();
            }
        }
    }

    #[test]
    fn queued_version_checks_share_one_call() {
        stand_ins();
        let root = std::env::temp_dir().join(format!("loom-opencode-queue-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("stand-in.cmd"), "@echo off\r\necho x>>calls.txt\r\n\"%SystemRoot%\\System32\\PING.EXE\" -n 2 127.0.0.1 >nul\r\necho opencode v2.0.18\r\n").unwrap();
        plant(&root);
        let dir = root.to_str().unwrap().to_string();
        let calls = || std::fs::read_to_string(root.join("calls.txt")).unwrap().lines().count();
        let threads: Vec<_> = (0..4).map(|_| { let dir = dir.clone(); std::thread::spawn(move || super::major("opencode", &dir)) }).collect();
        for t in threads { assert_eq!(t.join().unwrap(), Ok(2)); }
        assert_eq!(calls(), 1);
        // A check asked after the last one finished runs again.
        assert_eq!(super::major("opencode", &dir), Ok(2));
        assert_eq!(calls(), 2);
        assert!(!root.join("planted.txt").exists(), "the checkout's opencode.cmd ran");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn routes_launch_list_and_export_by_actual_version() {
        stand_ins();
        let root = std::env::temp_dir().join(format!("loom-opencode-routing-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        plant(&root);
        let dir = root.to_str().unwrap();
        let rows = serde_json::json!([{"id":"ses_test","directory":dir},{"id":"ses_other","directory":"C:/elsewhere"}]);
        std::fs::write(root.join("list.json"), rows.to_string()).unwrap();
        for version in [1, 2] {
            let data = if version == 1 { serde_json::json!({"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"Hello"}]}]}) }
                else { serde_json::json!({"messages":[{"type":"user","text":"Hello"}]}) };
            std::fs::write(root.join("export.json"), data.to_string()).unwrap();
            let script = format!("@echo off\r\nif defined LOOM_PANE exit /b 9\r\nif defined LOOM_SESSION_FILE exit /b 9\r\nif \"%~1\"==\"--version\" (echo opencode v{version}.18.32 & exit /b 0)\r\necho %*>>calls.txt\r\nif \"%~1 %~2\"==\"session list\" (type list.json & exit /b 0)\r\ntype export.json\r\n");
            std::fs::write(root.join("stand-in.cmd"), script).unwrap();
            for name in ["opencode", "opencode1", "opencode2"] {
                let started = super::launch(&format!("{name} --session ses_test"), dir).unwrap();
                assert_eq!(started.contains("--standalone"), version == 2);
                assert!(started.starts_with(name));
                if version == 2 {
                    assert!(super::launch(&format!("{name} --server http://localhost:1234"), dir).is_err());
                    assert_eq!(super::launch(&format!("{name} --standalone"), dir).unwrap(), format!("{name} --standalone"));
                }
                assert_eq!(super::sessions(dir, name).unwrap().len(), 1);
                assert_eq!(super::messages(dir, "ses_test", name).unwrap().user, "Hello");
            }
        }
        let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
        assert!(calls.contains("export ses_test --pure"));
        assert!(calls.contains("session export ses_test --standalone"));
        assert!(super::sessions(dir, "opencode & calc").is_err());
        assert!(!root.join("planted.txt").exists(), "the checkout's opencode.cmd ran");
        std::fs::remove_dir_all(root).unwrap();
    }
}
