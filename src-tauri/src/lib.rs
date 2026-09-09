use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod dictate;
mod usage;

const SHELL_INIT: &str = include_str!("shell-init.ps1");
/// Extra Claude Code settings, handed to each pane's `claude` via --settings.
const CLAUDE_HOOKS: &str = include_str!("claude-hooks.json");
/// Statusline tee: saves each payload for `usage::session_usage`, then chains
/// to the statusline the user configured. Its path replaces __LOOM_STATUS__ in
/// CLAUDE_HOOKS at spawn.
const LOOM_STATUS: &str = include_str!("loom-status.ps1");
/// opencode plugin: turns session.idle into the same wake marker claude's Stop
/// hook drops. Installed globally (opencode loads local plugins from nowhere
/// else); inert outside a Loom pane.
const OPENCODE_PLUGIN: &str = include_str!("loom-opencode.js");

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<String, Session>>);
#[derive(Default)]
struct WindowStateReady(std::sync::atomic::AtomicBool);

pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    let mut dir = app.path().app_data_dir().expect("no app data dir");
    // Debug builds keep their own state, so `tauri dev` and an installed release
    // stop overwriting each other's workspaces.json and shell-init.ps1.
    if cfg!(debug_assertions) {
        dir.as_mut_os_string().push("-dev");
    }
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Drain the longest valid UTF-8 prefix, keeping a truncated trailing sequence
/// for the next read (8 KiB reads split multi-byte chars otherwise).
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(_) => String::from_utf8(std::mem::take(pending)).unwrap(),
        Err(e) => {
            let valid = e.valid_up_to();
            let mut out = String::from_utf8(pending[..valid].to_vec()).unwrap();
            let skip = e.error_len().unwrap_or(0);
            if skip > 0 {
                out.push('\u{fffd}');
            }
            pending.drain(..valid + skip);
            out
        }
    }
}

/// Write `text` to `path` only when it differs — these are rewritten on every
/// spawn, and an unchanged file should not get a new mtime (or a disk write).
fn ensure_file(path: &std::path::Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).map_or(true, |have| have != text) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(path, text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// (async) or this runs on the main thread: openpty + a PowerShell launch is
// ~a second, and restoring N panes serially freezes the window before it paints.
//
// `argv` is the program and its arguments, as agent.ts builds them: claude
// runs bare, codex/opencode under cmd.exe, shells under PowerShell. The pty
// spawner quotes each argument MSVC-style, so a path with spaces reaches a
// real executable intact — which is why `$LOOM_HOOKS` is substituted here as
// one argument rather than expanded by a shell.
#[tauri::command(async)]
fn pty_spawn(
    app: AppHandle,
    ptys: State<Ptys>,
    id: String,
    cwd: Option<String>,
    argv: Vec<String>,
    cols: u16,
    rows: u16,
    on_out: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    if argv.is_empty() {
        return Err("empty argv".into());
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let init = data_dir(&app).join("shell-init.ps1");
    ensure_file(&init, SHELL_INIT)?;
    let status = data_dir(&app).join("loom-status.ps1");
    ensure_file(&status, LOOM_STATUS)?;
    let hooks = data_dir(&app).join("claude-hooks.json");
    // The path lands inside a JSON string, so its backslashes need escaping.
    let hooks_json =
        CLAUDE_HOOKS.replace("__LOOM_STATUS__", &status.display().to_string().replace('\\', "\\\\"));
    ensure_file(&hooks, &hooks_json)?;
    let session_hook = data_dir(&app).join("loom-session.ps1");
    ensure_file(&session_hook, include_str!("loom-session.ps1"))?;
    if argv.iter().any(|a| a.contains("opencode")) {
        if let Ok(home) = app.path().home_dir() {
            let _ = ensure_file(&home.join(".config/opencode/plugins/loom.js"), OPENCODE_PLUGIN);
        }
    }

    let hooks_arg = hooks.display().to_string();
    let mut cmd = CommandBuilder::new(&argv[0]);
    if argv.len() == 5 && argv[0].eq_ignore_ascii_case("cmd.exe") && argv[3] == "/c" {
        // ConPTY quotes argv MSVC-style; cmd.exe does not understand \" inside
        // its command string. Expand the whole command after that quoting step.
        cmd.args(["/d", "/s", "/c", "%LOOM_COMMAND%"]);
        // Codex's notify script goes in by path (agent.ts: CODEX_NOTIFY).
        cmd.env("LOOM_COMMAND", argv[4].replace("$LOOM_SESSION_HOOK", &session_hook.display().to_string()));
    } else {
        cmd.args(argv[1..].iter().map(|a| if a == "$LOOM_HOOKS" { &hooks_arg } else { a }));
    }
    // aa's WEZTERM_PANE equivalent: Claude's Stop/Notification hooks (and the
    // opencode plugin) drop a marker named after this, and `take_wakes` turns
    // it back into a pane.
    cmd.env("LOOM_PANE", &id);
    cmd.env("LOOM_SESSION_FILE", data_dir(&app).join("session-marks").join(&id));
    // What every terminal tells its children. Nothing sets these on Windows
    // unless the terminal does, and Claude Code's Bun build draws in
    // monochrome without them; Orca and Windows Terminal both set them.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Loom");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Loom launched from inside an agent (a `tauri dev` run from a Claude
    // pane, say) inherits that agent's session markers, and a claude started
    // in a pane then believes it is a child session: transcripts off, nested
    // rendering. No pane is anyone's child — scrub them.
    for (k, _) in std::env::vars_os() {
        let key = k.to_string_lossy();
        // NO_COLOR too: a launcher's "no colour please" (Claude Code sets it
        // for the shells it runs) must not turn every pane monochrome.
        if key.starts_with("CLAUDE_CODE_")
            || matches!(&*key, "CLAUDECODE" | "CLAUDE_PID" | "CLAUDE_EFFORT" | "NO_COLOR")
        {
            cmd.env_remove(&k);
        }
    }
    // Shell panes dot-source this (agent.ts: `. $env:LOOM_INIT`) — a variable,
    // not a literal path, so a data dir with spaces needs no quoting.
    cmd.env("LOOM_INIT", &init);
    // claude gets this via `--settings`; the hook inside reports which
    // transcript the pane ends up on, which the pinned session id can't (it goes
    // stale on /clear, or if claude is relaunched by hand).
    cmd.env("LOOM_HOOKS", &hooks);
    match cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        Some(dir) => cmd.cwd(dir),
        None => {
            if let Ok(home) = app.path().home_dir() {
                cmd.cwd(home);
            }
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave); // else the reader never sees EOF on Windows

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Reader → channel → emitter: the emitter drains whatever queued up while the
    // last send was in flight, so fast output becomes a few big IPC messages instead
    // of one per 8 KiB read. Adds no latency — try_recv never waits.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let text = take_utf8(&mut pending);
            if !text.is_empty() && tx.send(text).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        while let Ok(mut text) = rx.recv() {
            // ponytail: 1 MiB cap per emit so a firehose can't build giant strings
            while text.len() < 1 << 20 {
                match rx.try_recv() {
                    Ok(more) => text.push_str(&more),
                    Err(_) => break,
                }
            }
            let _ = on_out.send(text);
        }
    });

    let exit_ev = format!("pty-exit:{id}");
    let handle = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let _ = handle.emit(&exit_ev, code);
    });

    ptys.0.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );
    Ok(())
}

#[tauri::command]
fn pty_write(ptys: State<Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such pty")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let s = map.get(&id).ok_or("no such pty")?;
    s.master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(ptys: State<Ptys>, id: String) -> Result<(), String> {
    if let Some(mut s) = ptys.0.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

/// One git invocation in `dir`, stdout back, stderr as the error. The thread
/// model is built on this — worktree add/list/remove, branch names — and the
/// porcelain lives in the frontend, so this stays one function.
/// `ok`: extra exit codes to treat as success — `git diff --no-index` answers 1
/// when the files differ, which is the whole point of asking.
#[tauri::command(async)]
fn git_run(dir: String, args: Vec<String>, ok: Option<Vec<i32>>) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(&args)
        // A fetch that needs credentials must fail, not wait on a prompt
        // nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("git: {e}"))?;
    let fine = out.status.success()
        || out.status.code().is_some_and(|c| ok.as_deref().unwrap_or(&[]).contains(&c));
    if fine {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git exited {:?}", out.status.code()) } else { err })
    }
}

/// Every file under `dir`, relative with `/`, for the Files tree. Folders git
/// would not track are skipped, so a `node_modules` never lands in the panel.
/// ponytail: no .gitignore parsing — `git ls-files` covers git checkouts and
/// this is the fallback for plain folders; caps at 20k entries.
#[tauri::command(async)]
fn list_files(dir: String) -> Vec<String> {
    let root = std::path::PathBuf::from(&dir);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                if !matches!(name.as_str(), ".git" | "node_modules" | "target" | ".build") {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(&root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= 20_000 {
                    return out;
                }
            }
        }
    }
    out
}

/// One file's text for the viewer tab. Binary bytes come back lossy; anything
/// past 4 MB is cut, which is past what a diff view is for anyway.
#[tauri::command(async)]
fn read_file(dir: String, path: String) -> Result<String, String> {
    let mut bytes = std::fs::read(std::path::Path::new(&dir).join(&path)).map_err(|e| e.to_string())?;
    let cut = bytes.len() > 4 << 20;
    bytes.truncate(4 << 20);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if cut {
        text.push_str("\n… truncated at 4 MB");
    }
    Ok(text)
}

#[tauri::command(async)]
fn read_image(dir: String, path: String) -> Result<tauri::ipc::Response, String> {
    let path = std::path::Path::new(&dir).join(path);
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif") {
        return Err("Unsupported image format".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Not an image file".into());
    }
    // ponytail: cap previews at 32 MB; stream larger images if needed.
    let mut bytes = Vec::new();
    file.take((32 << 20) + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 32 << 20 { return Err("Image exceeds the 32 MB preview limit".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}

/// `git_run` with the patch on stdin, which is the only way to hand `git apply`
/// one hunk: staging part of a file writes a patch nobody should have to keep
/// in a temp file.
#[tauri::command(async)]
fn git_stdin(dir: String, args: Vec<String>, patch: String) -> Result<String, String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    // Dropping the handle closes the pipe, which is what tells git the patch ended.
    child
        .stdin
        .take()
        .ok_or("git: no stdin")?
        .write_all(patch.as_bytes())
        .map_err(|e| format!("git: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git exited {:?}", out.status.code()) } else { err })
    }
}

/// `code` is a .cmd shim on Windows, so it can only run through cmd — but never
/// as a bare name: a `tauri dev` chain (npm → tauri-cli → cargo → here) inherits
/// a PATH past 16 KB, and cmd.exe's own search quietly gives up on one that long
/// and reports "'code' is not recognized". The installed build gets Explorer's
/// ~1 KB PATH and works, which is what makes this look like a dev-only ghost.
/// So: find the shim ourselves (`std::env::split_paths` has no such limit) and
/// hand cmd an absolute path.
fn code_shim() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("code.cmd"))
        .find(|p| p.is_file())
}

/// Like aa's F5. VS Code dedupes — an already-open window for the folder just
/// gets focused.
///
/// Null stdin, not inherited: run `tauri dev` from inside a Loom pane and this
/// process's stdout *is* that pane's pty. VS Code's main process would keep the
/// handle for its whole life and drip `update#setState checking for updates`
/// into the pane an hour later, on top of whatever TUI is drawing there. stdout
/// and stderr are captured below for the same reason.
#[tauri::command(async)]
fn open_vscode(dir: String, goto: Option<String>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    let shim = code_shim().ok_or("no code.cmd on PATH — is VS Code's `code` command installed?")?;

    // One raw argument, because Rust would quote each arg separately and cmd's
    // /c rule then strips the outer pair, splitting any path with a space in it.
    // `/s` says "trim the outermost quotes and run the rest verbatim", which is
    // the one form that survives spaces in both the shim path and the folder.
    let mut inner = format!("\"{}\" \"{dir}\"", shim.display());
    if let Some(g) = &goto {
        inner.push_str(&format!(" -g \"{g}\"")); // file:line:col
    }
    let out = std::process::Command::new("cmd")
        .raw_arg(format!("/s /c \"{inner}\""))
        .stdin(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no flashing console
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    // Don't swallow it: a silent no-op here is exactly how the PATH problem
    // above went unnoticed.
    Err(format!(
        "code exited {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Pane ids whose Claude finished a turn since the last call, consumed as they
/// are read. Hooks can't write into the pane itself — a BEL sent to CONOUT$ is
/// swallowed by conhost and never reaches ConPTY — so they drop a file instead,
/// exactly like aa does with WEZTERM_PANE.
// ponytail: (async) so the scan is off the main thread; the markers live in
// their own %TEMP%\loom-wait\ folder, so a poll only walks Loom's own files.
#[tauri::command(async)]
fn take_wakes(app: AppHandle, ptys: State<Ptys>) -> Vec<(String, String)> {
    let mut wakes = drain_wakes(&std::env::temp_dir().join("loom-wait"));
    // Read only this instance's panes. Another Loom window cannot consume a
    // session marker before its owner sees it.
    let base = data_dir(&app).join("session-marks");
    for id in ptys.0.lock().unwrap().keys() {
        let path = base.join(id);
        if let Ok(sid) = std::fs::read_to_string(&path) {
            if !sid.trim().is_empty() {
                wakes.push((format!("{id}.session"), sid.trim().to_string()));
                let _ = std::fs::remove_file(path);
            }
        }
    }
    wakes
}

#[tauri::command(async)]
fn opencode_sessions(dir: String) -> Result<Vec<serde_json::Value>, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "opencode session list --format json"])
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).into_owned()); }
    let raw = String::from_utf8_lossy(&out.stdout);
    if raw.trim().is_empty() { return Ok(Vec::new()); }
    let rows: Vec<serde_json::Value> = serde_json::from_str(raw.trim()).map_err(|e| e.to_string())?;
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    Ok(rows.into_iter().filter(|row| row["directory"].as_str().is_some_and(|d| norm(d) == norm(&dir))).collect())
}

/// Codex conversations started in `dir`, newest first, as `{id, title}`. Codex
/// has no machine-readable listing, so this reads what its own picker reads:
/// the `session_meta` first line of every rollout under $CODEX_HOME/sessions,
/// titled from session_index.jsonl (Codex's auto-name) or the first prompt.
// ponytail: one full walk per open of the picker, 20 newest matches.
#[tauri::command(async)]
fn codex_sessions(app: AppHandle, dir: String) -> Result<Vec<serde_json::Value>, String> {
    use std::io::BufRead;
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".codex")))
        .ok_or("no home dir")?;
    let mut names = std::collections::HashMap::new();
    for line in std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default().lines() {
        if let Ok(row) = serde_json::from_str::<serde_json::Value>(line) {
            if let (Some(id), Some(name)) = (row["id"].as_str(), row["thread_name"].as_str()) {
                names.insert(id.to_string(), name.to_string());
            }
        }
    }
    fn walk(dir: &std::path::Path, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")) {
                out.push((e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
            }
        }
    }
    let mut files = Vec::new();
    walk(&home.join("sessions"), &mut files);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let want = norm(&dir);
    let mut rows = Vec::new();
    for (_, path) in files {
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let mut lines = std::io::BufReader::new(file).lines().map_while(Result::ok);
        let Some(meta) = lines.next().and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok()) else { continue };
        let payload = &meta["payload"];
        if meta["type"] != "session_meta" || !payload["cwd"].as_str().is_some_and(|c| norm(c) == want) {
            continue;
        }
        let Some(id) = payload["id"].as_str() else { continue };
        let title = names.get(id).cloned().or_else(|| {
            // The first prompt you typed: a user message that is not one of the
            // injected instruction blocks (`# AGENTS.md …`, `<environment_context>`).
            lines.take(40).find_map(|l| {
                let v = serde_json::from_str::<serde_json::Value>(&l).ok()?;
                if v["type"] != "response_item" || v["payload"]["role"] != "user" {
                    return None;
                }
                let text = v["payload"]["content"][0]["text"].as_str()?.trim();
                if text.starts_with('<') || text.starts_with('#') {
                    return None;
                }
                Some(text.lines().next()?.chars().take(80).collect::<String>())
            })
        });
        rows.push(serde_json::json!({ "id": id, "title": title.unwrap_or_default() }));
        if rows.len() == 20 {
            break;
        }
    }
    Ok(rows)
}

/// (pane id, effort level) pairs; effort is the marker's content — empty when
/// the hook had none to report (resume then falls back to the global default).
fn drain_wakes(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut ids = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return ids; // no folder yet = no hooks have fired
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(id) = name.to_str() else { continue };
        let Ok(effort) = std::fs::read_to_string(e.path()) else { continue };
        if id.ends_with(".session") && effort.trim().is_empty() { continue; }
        ids.push((id.to_string(), effort.trim().to_string()));
        let _ = std::fs::remove_file(e.path());
    }
    ids
}

/// Per-launch WebView2 user-data folder. WebView2's profile singleton is a
/// named kernel object derived from this path, and after Loom exits its
/// browser tree lingers 10-30s holding it (unkillable — TerminateProcess
/// succeeds but the processes stay). Reopening on the *same* path inside that
/// window stalls the new renderer 20s+ on the singleton; a fresh path per
/// launch never collides. A fresh profile costs nothing here: no
/// localStorage/cookies to keep, renderer spawn measured identical (646ms
/// fresh vs 623-786ms warm), ~10MB disk until the next sweep.
fn webview_profile_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .expect("no local data dir")
        .join("wv");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = base.join(now.to_string());
    let _ = std::fs::create_dir_all(&dir);

    // Sweep stale profiles (and the pre-2.1 shared `EBWebView`) off-thread.
    let mine = dir.clone();
    std::thread::spawn(move || sweep_stale_profiles(&base, &mine));
    dir
}

/// Delete every profile dir under `base` (plus the legacy shared one next to
/// it) except `keep`, skipping any still open in a live browser. A profile is
/// stale once its LevelDB LOCK has no open handles — true the moment its host
/// dies, even while the browser tree drains; a live instance (e.g. `tauri
/// dev` beside the release build) holds the handle and is left alone.
/// Deletes that race a draining tree just fail and are retried next launch.
fn sweep_stale_profiles(base: &std::path::Path, keep: &std::path::Path) {
    let legacy = base.parent().map(|p| p.join("EBWebView"));
    let stale = std::fs::read_dir(base)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .chain(legacy)
        .filter(|p| p != keep && p.exists());
    for p in stale {
        let lock = p.join("EBWebView\\Default\\Local Storage\\leveldb\\LOCK");
        let lock = if lock.exists() { lock } else { p.join("Default\\Local Storage\\leveldb\\LOCK") };
        let in_use = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0) // sharing violation while any live process holds it
                .open(&lock)
                .is_err()
                && lock.exists()
        };
        if !in_use {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

/// Profile launches: `loom.exe C:\x\client.json` lives entirely in that file;
/// no arg → the default `workspaces.json`, which a profile launch never touches.
/// `--reset` is not a profile (see `run`), so it's filtered out here.
fn profile_arg() -> Option<String> {
    std::env::args().nth(1).filter(|a| a != "--reset")
}

fn state_file(app: &AppHandle) -> PathBuf {
    profile_arg().map_or_else(|| data_dir(app).join("workspaces.json"), PathBuf::from)
}

#[tauri::command]
fn load_state(app: AppHandle) -> String {
    std::fs::read_to_string(state_file(&app)).unwrap_or_default()
}

#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    // Write beside the destination, then replace it, so an interrupted save
    // leaves either the old snapshot or the new one, never half a JSON file.
    let path = state_file(&app);
    let pending = path.with_extension("json.pending");
    std::fs::write(&pending, json).map_err(|e| e.to_string())?;
    std::fs::rename(pending, path).map_err(|e| e.to_string())
}

// ASCII only: legacy consoles read stdout in the OEM codepage.
const HELP: &str = "\
loom - multi-folder agentic terminal workspace

Usage: loom [state.json] [--reset]

Arguments:
  state.json     open with this state file (a profile) instead of the default;
                 created on first save if missing

Options:
      --reset    delete the state file before starting (fresh start)
  -h, --help     print this help
  -V, --version  print the version";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `loom --help` from a terminal. Release is a GUI-subsystem exe whose
    // stdout only exists when redirected; AttachConsole grabs the launching
    // terminal's console for the direct case (and fails harmlessly when there
    // already is one, as in debug, or none at all, as from Explorer).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| matches!(a.as_str(), "--help" | "-h" | "--version" | "-V")) {
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(pid: u32) -> i32;
        }
        unsafe { AttachConsole(u32::MAX) }; // ATTACH_PARENT_PROCESS
        if args.iter().any(|a| a == "--version" || a == "-V") {
            println!("loom {}", env!("CARGO_PKG_VERSION"));
        } else {
            println!("{HELP}");
        }
        std::process::exit(0);
    }

    let builder = tauri::Builder::default();
    // Must be first: a second instance should raise the live window, not
    // open a duplicate. (Webview profiles are per-launch, so there is no
    // user-data contention — this is purely about not duplicating the app.)
    // Release-only, so `tauri dev` can run beside the installed app. Skipped
    // for profile launches so `loom.exe work` opens beside the default.
    // ponytail: two launches of the SAME profile both open; last save wins.
    #[cfg(not(debug_assertions))]
    let builder = if profile_arg().is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
    };
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Ptys::default())
        .manage(WindowStateReady::default())
        .manage(dictate::Dictation::default())
        .manage(usage::Scanned::default())
        // The window is config-defined but built here ("create": false) because
        // enable_clipboard_access has no tauri.conf.json equivalent — without it
        // WebView2 shows a permission prompt on navigator.clipboard.readText.
        // from_config carries "backgroundColor" through: WebView2 paints its own
        // white until the document's first frame, so without it startup flashes
        // white for as long as the webview takes to come up.
        .setup(|app| {
            // The plugin accepts an absolute filename. Keep geometry beside the
            // workspace so dev, release, and explicit profiles stay independent.
            let window_file = std::path::absolute(state_file(app.handle()))?.with_extension("window.json");
            // `loom.exe --reset` starts fresh: the state file is gone before the
            // webview ever calls load_state. Composes with profiles — `loom.exe
            // p.json --reset` wipes that profile instead of the default.
            if std::env::args().any(|a| a == "--reset") {
                let _ = std::fs::remove_file(state_file(app.handle()));
                let _ = std::fs::remove_file(&window_file);
            }
            app.handle().plugin(tauri_plugin_window_state::Builder::default()
                .with_filename(window_file.to_string_lossy())
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS)
                .build())?;
            let cfg = app.config().app.windows.first().expect("window config").clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .data_directory(webview_profile_dir(app.handle()))
                .enable_clipboard_access()
                .build()?;
            app.state::<WindowStateReady>().0.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        })
        // ConPTY children are not reaped when the app exits — kill them explicitly.
        .on_window_event(|window, event| {
            if window.state::<WindowStateReady>().0.load(std::sync::atomic::Ordering::Relaxed)
                && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::CloseRequested { .. }) {
                // Persist while running too: stopping `tauri dev` need not send CloseRequested.
                let _ = window.app_handle().save_window_state(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS);
            }
            // The frontend may cancel close if its final save fails.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                for (_, mut s) in window.state::<Ptys>().0.lock().unwrap().drain() {
                    let _ = s.killer.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill, load_state, save_state, open_vscode,
            git_run, git_stdin, list_files, read_file, read_image, take_wakes, opencode_sessions, codex_sessions, usage::session_usage, usage::has_session, usage::plan_usage, usage::codex_plan_usage,
            usage::model_options, usage::context_profile,
            dictate::dictate_start,
            dictate::dictate_stop,
            dictate::dictate_level
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{drain_wakes, sweep_stale_profiles, take_utf8};

    #[test]
    fn image_preview_reads_bytes_and_rejects_invalid_files() {
        use tauri::ipc::{IpcResponse, InvokeResponseBody};
        let dir = std::env::temp_dir().join(format!("loom-image-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let image = include_bytes!("../icons/128x128.png");
        std::fs::write(dir.join("screen shot.PNG"), image).unwrap();
        let response = super::read_image(root.clone(), "screen shot.PNG".into()).unwrap().body().unwrap();
        assert!(matches!(response, InvokeResponseBody::Raw(bytes) if bytes == image));
        assert!(super::read_image(root.clone(), dir.join("screen shot.PNG").to_string_lossy().into()).is_ok());
        assert!(super::read_image(root.clone(), "missing.png".into()).is_err());
        assert!(super::read_image(root.clone(), "script.exe".into()).is_err());
        let large = std::fs::File::create(dir.join("large.png")).unwrap();
        large.set_len((32 << 20) + 1).unwrap();
        drop(large);
        assert!(super::read_image(root, "large.png".into()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sweep_keeps_current_and_live_profiles() {
        let base = std::env::temp_dir().join("loom-sweep-test").join("wv");
        let _ = std::fs::remove_dir_all(base.parent().unwrap());
        let lock_rel = "EBWebView\\Default\\Local Storage\\leveldb";

        let keep = base.join("111");
        let stale = base.join("222");
        let live = base.join("333");
        let legacy = base.parent().unwrap().join("EBWebView");
        for d in [&keep, &stale, &live] {
            std::fs::create_dir_all(d.join(lock_rel)).unwrap();
            std::fs::write(d.join(lock_rel).join("LOCK"), "").unwrap();
        }
        std::fs::create_dir_all(legacy.join("Default\\Local Storage\\leveldb")).unwrap();
        std::fs::write(legacy.join("Default\\Local Storage\\leveldb\\LOCK"), "").unwrap();

        // an open handle on the LOCK marks `live` as in use
        let held = std::fs::File::open(live.join(lock_rel).join("LOCK")).unwrap();
        sweep_stale_profiles(&base, &keep);
        drop(held);

        assert!(keep.exists(), "current profile must survive");
        assert!(live.exists(), "held-LOCK profile must survive");
        assert!(!stale.exists(), "stale profile must be removed");
        assert!(!legacy.exists(), "legacy shared EBWebView must be removed");
        let _ = std::fs::remove_dir_all(base.parent().unwrap());
    }

    #[test]
    fn wake_markers_are_consumed_once() {
        let dir = std::env::temp_dir().join("loom-wake-test");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(drain_wakes(&dir).is_empty(), "missing folder is not an error");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abc"), "max\r\n").unwrap(); // Set-Content may add a newline
        std::fs::write(dir.join("def"), "").unwrap();

        let mut got = drain_wakes(&dir);
        got.sort();
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(got, vec![pair("abc", "max"), pair("def", "")]);
        assert!(drain_wakes(&dir).is_empty(), "markers must not fire twice");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utf8_split_across_reads() {
        // "é" is 0xC3 0xA9 — arriving one byte per read must not corrupt it.
        let mut p = vec![b'a', 0xC3];
        assert_eq!(take_utf8(&mut p), "a");
        p.push(0xA9);
        assert_eq!(take_utf8(&mut p), "é");
        assert!(p.is_empty());

        let mut bad = vec![b'x', 0xFF, b'y'];
        assert_eq!(take_utf8(&mut bad), "x\u{fffd}");
        assert_eq!(take_utf8(&mut bad), "y");
    }
}
