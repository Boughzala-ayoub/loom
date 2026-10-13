//! Cursor's agent CLI in a pane, by its first name, `cursor-agent`: its newer
//! one, `agent`, is other CLIs' too (Grok's agent.exe), so agent.ts leaves that
//! a shell command.
//!
//! Its turn hooks (beforeSubmitPrompt, stop) run only from a hooks.json of the
//! user's or the project's: a plugin's hooks run for tools and sessions but
//! never for prompts and turn ends (2026.10.01). So Loom keeps its own entries
//! in ~/.cursor/hooks.json beside the user's. They run `loom.exe
//! --cursor-hook` (helper.rs), which does nothing outside a Loom pane; the
//! Cursor editor reads the file too, and runs them there for nothing. Cursor
//! runs every hook through PowerShell as `Get-Content <payload> | & { $input |
//! <command> }`, so the command is PowerShell as well.

use std::path::{Path, PathBuf};

/// The events Loom's entries answer, in hooks.json's names.
const EVENTS: [&str; 2] = ["beforeSubmitPrompt", "stop"];
/// What marks an entry as Loom's, whichever loom.exe it names.
const MARK: &str = "--cursor-hook";

/// The program a pane's startup line runs, when that is Cursor's CLI.
pub fn command(line: &str) -> Option<&str> {
    let name = line.trim_start().split_whitespace().next()?;
    (name == "cursor-agent").then_some(name)
}

/// Loom's entries in `home`\.cursor\hooks.json, naming `exe`, with every other
/// entry kept as it was. A file Loom can't read as JSON is left alone, and
/// the pane runs without turn reports.
pub fn install(home: &Path, exe: &Path) -> Result<(), String> {
    let path = home.join(".cursor").join("hooks.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    let Some(merged) = merge(text.as_deref(), exe)? else { return Ok(()) };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    replace(&path, &merged).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// `text` written beside `path` under a name no other write uses, then renamed
/// over it. Panes restored together install at once, and a read between
/// another's truncate and write (std::fs::write) took the empty file for none
/// and saved Loom's entries alone. Now a read gets the old file or the new one,
/// and a write that fails leaves the old one.
fn replace(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}-{n}.tmp", std::process::id()));
    let written = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()).and_then(|_| f.sync_all()))
        .and_then(|_| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// hooks.json with Loom's entries for `exe`, or None when it already has them
/// and nothing else of Loom's.
fn merge(text: Option<&str>, exe: &Path) -> Result<Option<String>, String> {
    let mut v: serde_json::Value = match text.map(|t| t.trim_start_matches('\u{feff}')).filter(|t| !t.trim().is_empty()) {
        // ponytail: a file with comments in it (Cursor strips /* */) is left alone, not rewritten without them.
        Some(t) => serde_json::from_str(t).map_err(|e| format!("~/.cursor/hooks.json isn't plain JSON, so Loom left it alone: {e}"))?,
        None => serde_json::json!({ "version": 1, "hooks": {} }),
    };
    // ponytail: serde_json writes the keys sorted, the user's too; Cursor reads them the same.
    let before = v.clone();
    let root = v.as_object_mut().ok_or("~/.cursor/hooks.json isn't a JSON object, so Loom left it alone")?;
    root.entry("version").or_insert(1.into());
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("~/.cursor/hooks.json's hooks isn't an object, so Loom left it alone")?;
    // Single quotes: PowerShell takes the path as it is, `$` and spaces and all.
    let ours = format!("& '{}' {MARK}", exe.display().to_string().replace('\'', "''"));
    for event in EVENTS {
        let list = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let list = list.as_array_mut().ok_or_else(|| format!("~/.cursor/hooks.json's {event} isn't a list, so Loom left it alone"))?;
        list.retain(|h| !h["command"].as_str().is_some_and(|c| c.contains(MARK)));
        list.push(serde_json::json!({ "command": ours }));
    }
    if v == before {
        return Ok(None);
    }
    serde_json::to_string_pretty(&v).map(|s| Some(s + "\n")).map_err(|e| e.to_string())
}

/// A cursor pane's command line (`cursor-agent <args>`, as agent.ts builds it
/// for cmd.exe) as a direct launch of the node.exe its shim would run: program,
/// argv, and the env the shim sets. The shim chain is cmd.exe → cursor-agent.cmd →
/// PowerShell → node, and cmd and PowerShell would then sit idle under the
/// pane for its whole life, ~70 MB between them. None = launch through cmd:
/// cmd syntax in the line, or an install laid out some other way. `find`
/// says where a program is on PATH.
pub fn direct(line: &str, find: impl FnOnce(&str) -> Option<PathBuf>) -> Option<(PathBuf, Vec<String>, Vec<(&'static str, String)>)> {
    let line = line.trim_start();
    let name = command(line)?;
    let tail = &line[name.len()..];
    if tail.contains(['&', '|', '<', '>', '^', '%', '!']) {
        return None;
    }
    let shim = find(name).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")))?;
    let root = shim.parent()?;
    let (node, index) = entry(root)?;
    let mut args = vec![index.display().to_string()];
    args.extend(crate::helper::split_args(tail));
    // What the shim names itself (%~nx0), as Cursor prints it back: "cursor-agent --resume=…".
    let mut env = vec![("CURSOR_INVOKED_AS", shim.file_name()?.to_string_lossy().to_ascii_lowercase())];
    // What the shim's PowerShell sets: node's compile cache, for a faster start.
    if std::env::var_os("NODE_COMPILE_CACHE").is_none() {
        let local = std::env::var_os("LOCALAPPDATA")?;
        env.push(("NODE_COMPILE_CACHE", PathBuf::from(local).join("cursor-compile-cache").display().to_string()));
    }
    Some((node, args, env))
}

/// node.exe and index.js as cursor-agent.ps1 finds them: beside it, or in the
/// newest folder under versions\ (YYYY.MM.DD-commit, or
/// YYYY.MM.DD-HH-MM-SS-commit), newest by its date. One an update is still
/// filling in is passed over.
fn entry(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let pair = |dir: &Path| {
        let (node, index) = (dir.join("node.exe"), dir.join("index.js"));
        (node.is_file() && index.is_file()).then_some((node, index))
    };
    if let Some(found) = pair(root) {
        return Some(found);
    }
    std::fs::read_dir(root.join("versions")).ok()?.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            Some((version_date(&name)?, name, pair(&e.path())?))
        })
        .max_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)))
        .map(|(_, _, found)| found)
}

/// YYYYMMDD of a versions\ folder's name, None for a name of any other form.
fn version_date(name: &str) -> Option<u32> {
    static FORM: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$").unwrap()
    });
    let c = FORM.captures(name)?;
    let n = |i: usize| c[i].parse::<u32>().ok();
    Some(n(1)? * 10_000 + n(2)? * 100 + n(3)?)
}

/// The chat `sid` as Cursor writes it down:
/// ~\.cursor\projects\<folder>\agent-transcripts\<sid>\<sid>.jsonl, where the
/// folder is the pane's path with each run of other characters made one dash.
/// Any project's when the name differs (a path with letters past ASCII).
pub fn transcript(home: &Path, dir: &str, sid: &str) -> Option<PathBuf> {
    let projects = home.join(".cursor").join("projects");
    let file = Path::new("agent-transcripts").join(sid).join(format!("{sid}.jsonl"));
    let own = projects.join(slug(dir)).join(&file);
    if own.is_file() {
        return Some(own);
    }
    std::fs::read_dir(&projects).ok()?.flatten().map(|e| e.path().join(&file)).find(|p| p.is_file())
}

fn slug(dir: &str) -> String {
    dir.split(|c: char| !c.is_ascii_alphanumeric()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-")
}

/// A prompt as its transcript keeps it, without what Cursor wraps around it:
/// `<timestamp>…</timestamp>`, then the prompt inside `<user_query>` tags.
pub fn prompt_text(text: &str) -> &str {
    let inner = text.split_once("<user_query>").map_or(text, |(_, rest)| rest);
    inner.rsplit_once("</user_query>").map_or(inner, |(body, _)| body).trim()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn command_is_cursor_agent_only() {
        assert_eq!(super::command("cursor-agent --resume abc"), Some("cursor-agent"));
        assert_eq!(super::command("agent"), None, "may be Grok's");
        assert_eq!(super::command("cursor-agents"), None);
        assert_eq!(super::command("codex"), None);
    }

    #[test]
    fn merge_adds_once_and_keeps_the_users() {
        let exe = Path::new(r"C:\Program Files\Loom\loom.exe");
        let made = super::merge(None, exe).unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&made).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["hooks"]["stop"][0]["command"], r"& 'C:\Program Files\Loom\loom.exe' --cursor-hook");
        assert_eq!(v["hooks"]["beforeSubmitPrompt"].as_array().unwrap().len(), 1);
        assert_eq!(super::merge(Some(&made), exe).unwrap(), None, "unchanged: no rewrite");

        let theirs = "\u{feff}{\"version\":1,\"hooks\":{\"stop\":[{\"command\":\"./mine.ps1\"},{\"command\":\"& 'C:\\\\old\\\\loom.exe' --cursor-hook\"}],\"afterFileEdit\":[{\"command\":\"fmt\"}]}}";
        let v: serde_json::Value = serde_json::from_str(&super::merge(Some(theirs), exe).unwrap().unwrap()).unwrap();
        let stop: Vec<_> = v["hooks"]["stop"].as_array().unwrap().iter().map(|h| h["command"].as_str().unwrap()).collect();
        assert_eq!(stop, ["./mine.ps1", r"& 'C:\Program Files\Loom\loom.exe' --cursor-hook"], "the old loom.exe's entry goes");
        assert_eq!(v["hooks"]["afterFileEdit"][0]["command"], "fmt");

        let quote = super::merge(None, Path::new(r"C:\it's\loom.exe")).unwrap().unwrap();
        assert!(quote.contains(r"& 'C:\\it''s\\loom.exe' --cursor-hook"));
        assert!(super::merge(Some("/* mine */ {}"), exe).is_err(), "comments: left alone");
        assert!(super::merge(Some("[]"), exe).is_err());
    }

    /// Panes restored together install at once (main.ts restores them in
    /// parallel). Each must read the user's file whole, never one another
    /// install has half written, and keep the user's entries.
    #[test]
    fn parallel_installs_keep_the_users() {
        let home = std::env::temp_dir().join(format!("loom-cursor-parallel-{}", std::process::id()));
        let hooks = home.join(".cursor").join("hooks.json");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        let theirs = serde_json::json!({ "version": 1, "hooks": { "afterFileEdit": [{ "command": "fmt" }] }, "note": "x".repeat(16384) }).to_string();
        for attempt in 0..30 {
            std::fs::write(&hooks, &theirs).unwrap();
            let start = std::sync::Barrier::new(8);
            let errors: usize = std::thread::scope(|s| {
                let workers: Vec<_> = (0..8).map(|_| s.spawn(|| {
                    start.wait();
                    (0..30).filter(|_| super::install(&home, Path::new(r"C:\Loom\loom.exe")).is_err()).count()
                })).collect();
                workers.into_iter().map(|w| w.join().unwrap()).sum()
            });
            let kept = serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&hooks).unwrap()).ok().map(|v| v["hooks"]["afterFileEdit"][0]["command"] == "fmt");
            assert_eq!((kept, errors), (Some(true), 0), "attempt {attempt}: the user's hook kept, no install failed");
        }
        let left: Vec<_> = std::fs::read_dir(hooks.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, ["hooks.json"], "no temporary file left behind");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A write that fails, here because the file is held open without delete
    /// sharing, leaves the user's file as it was and no temporary file.
    #[test]
    fn failed_install_leaves_the_users() {
        use std::os::windows::fs::OpenOptionsExt;
        let home = std::env::temp_dir().join(format!("loom-cursor-held-{}", std::process::id()));
        let hooks = home.join(".cursor").join("hooks.json");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        let theirs = "{\"version\":1,\"hooks\":{\"afterFileEdit\":[{\"command\":\"fmt\"}]}}";
        std::fs::write(&hooks, theirs).unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(1 /* FILE_SHARE_READ */).open(&hooks).unwrap();
        assert!(super::install(&home, Path::new(r"C:\Loom\loom.exe")).is_err());
        drop(held);
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), theirs);
        let left: Vec<_> = std::fs::read_dir(hooks.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, ["hooks.json"], "no temporary file left behind");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Cursor's CLI as installed here: node.exe from its newest version folder.
    #[test]
    #[ignore]
    fn direct_real_install() {
        let (node, args, env) = super::direct("cursor-agent --resume abc --model gpt-5", crate::on_path).expect("Cursor's cursor-agent.cmd on PATH");
        println!("{} {args:?} {env:?}", node.display());
        assert!(node.ends_with("node.exe") && node.is_file());
        assert!(args[0].ends_with("index.js") && Path::new(&args[0]).is_file());
        assert_eq!(&args[1..], ["--resume", "abc", "--model", "gpt-5"]);
        assert_eq!(env[0], ("CURSOR_INVOKED_AS", "cursor-agent.cmd".to_string()));
        assert!(super::direct("cursor-agent || echo gone", crate::on_path).is_none(), "cmd syntax stays with cmd");
    }

    #[test]
    fn version_folders() {
        assert_eq!(super::version_date("2026.10.01-e373342"), Some(20261001));
        assert_eq!(super::version_date("2026.9.3-12-30-45-abc123"), Some(20260903));
        assert_eq!(super::version_date("2026.10.01"), None);
        assert_eq!(super::version_date("latest"), None);
        let root = std::env::temp_dir().join(format!("loom-cursor-versions-{}", std::process::id()));
        for (v, both) in [("2026.9.30-aaaa", true), ("2026.10.01-bbbb", true), ("2026.10.02-cccc", false), ("junk", true)] {
            let dir = root.join("versions").join(v);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("node.exe"), "").unwrap();
            if both {
                std::fs::write(dir.join("index.js"), "").unwrap();
            }
        }
        let (node, index) = super::entry(&root).unwrap();
        assert!(node.ends_with(r"2026.10.01-bbbb\node.exe") && index.ends_with(r"2026.10.01-bbbb\index.js"), "newest whole one: {node:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn transcript_folder_names() {
        assert_eq!(super::slug(r"C:\Users\a\Temp\C--x\484f-fb\cursor-probe\ws"), "C-Users-a-Temp-C-x-484f-fb-cursor-probe-ws");
        let home = std::env::temp_dir().join(format!("loom-cursor-home-{}", std::process::id()));
        let file = home.join(r".cursor\projects\D-w-repo\agent-transcripts\abc\abc.jsonl");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "").unwrap();
        assert_eq!(super::transcript(&home, r"D:\w\repo", "abc"), Some(file.clone()));
        assert_eq!(super::transcript(&home, r"D:\elsewhere", "abc"), Some(file), "found in any project");
        assert_eq!(super::transcript(&home, r"D:\w\repo", "nope"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn prompt_text_unwraps() {
        assert_eq!(super::prompt_text("<timestamp>Tuesday, Oct 13, 2026</timestamp>\n<user_query>\nReply with hi.\n</user_query>"), "Reply with hi.");
        assert_eq!(super::prompt_text("plain"), "plain");
    }
}
