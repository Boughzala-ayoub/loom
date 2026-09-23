use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod dictate;
mod helper;
mod usage;

const SHELL_INIT: &str = include_str!("shell-init.ps1");
/// Extra Claude Code settings, handed to each pane's `claude` via --settings.
/// Its statusline is loom.exe itself (helper.rs), whose path replaces
/// __LOOM_EXE__ at spawn.
const CLAUDE_HOOKS: &str = include_str!("claude-hooks.json");
/// opencode plugin: turns session.idle into the same wake marker claude's Stop
/// hook drops. Installed globally (opencode loads local plugins from nowhere
/// else); inert outside a Loom pane.
const OPENCODE_PLUGIN: &str = include_str!("loom-opencode.js");

struct Session {
    // Close the input pipe before ClosePseudoConsole runs in master's Drop.
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

impl Session {
    /// Kill the shell AND everything it spawned. `killer` alone is a
    /// TerminateProcess on the shell; claude/node under it live on, and a
    /// process whose cwd is the worktree makes `git worktree remove` fail
    /// with "Permission denied" on Windows.
    fn kill(&mut self) {
        use std::os::windows::process::CommandExt;
        if let Some(pid) = self.pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
        }
        let _ = self.killer.kill();
    }
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
    codex_state_id: Option<String>,
    cols: u16,
    rows: u16,
    on_out: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    if argv.is_empty() {
        return Err("empty argv".into());
    }
    if codex_state_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')) {
        return Err("invalid Codex state id".into());
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
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hooks = data_dir(&app).join("claude-hooks.json");
    // Claude Code runs the statusline through a shell (Git Bash here), which
    // eats unquoted backslashes; forward slashes also need no JSON escaping.
    let hooks_json = CLAUDE_HOOKS.replace("__LOOM_EXE__", &exe.display().to_string().replace('\\', "/"));
    ensure_file(&hooks, &hooks_json)?;
    if argv.iter().any(|a| a.contains("opencode")) {
        if let Ok(home) = app.path().home_dir() {
            let _ = ensure_file(&home.join(".config/opencode/plugins/loom.js"), OPENCODE_PLUGIN);
        }
    }

    let hooks_arg = hooks.display().to_string();
    let cmd_line = (argv.len() == 5 && argv[0].eq_ignore_ascii_case("cmd.exe") && argv[3] == "/c")
        // Codex's notify program goes in by path (agent.ts: CODEX_NOTIFY).
        .then(|| argv[4].replace("$LOOM_EXE", &exe.display().to_string()));
    let pane_dir = cwd.as_deref().map(std::path::Path::new).filter(|d| d.is_dir());
    let direct = cmd_line.as_deref().and_then(|line| helper::codex_direct(line, pane_dir));
    let mut cmd = match &direct {
        Some((exe, args, env)) => {
            let mut cmd = CommandBuilder::new(exe);
            cmd.args(args);
            for k in ["CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM", "CODEX_MANAGED_BY_VITE_PLUS"] {
                cmd.env_remove(k);
            }
            for (k, v) in env {
                cmd.env(k, v);
            }
            cmd
        }
        None => CommandBuilder::new(&argv[0]),
    };
    if let Some(sid) = codex_state_id {
        // Codex's shared log DB can lock out concurrent startups. Keep each
        // pane's SQLite state across relaunches; auth/config/rollouts still
        // use CODEX_HOME. An explicit sqlite_home in Codex config still wins.
        let sqlite = data_dir(&app).join("codex-sqlite").join(sid);
        std::fs::create_dir_all(&sqlite).map_err(|e| e.to_string())?;
        cmd.env("CODEX_SQLITE_HOME", sqlite);
    }
    if direct.is_some() {
        // argv is already in place.
    } else if let Some(line) = cmd_line {
        // ConPTY quotes argv MSVC-style; cmd.exe does not understand \" inside
        // its command string. Expand the whole command after that quoting step.
        cmd.args(["/d", "/s", "/c", "%LOOM_COMMAND%"]);
        cmd.env("LOOM_COMMAND", line);
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
    let pid = child.process_id();
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

    let previous = ptys.0.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
            pid,
        },
    );
    // Dropping a ConPTY can wait for its output to drain. Never do that while
    // holding the map lock that other panes' writes and resizes need.
    if let Some(mut previous) = previous { previous.kill(); }
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

#[tauri::command(async)]
fn pty_kill(ptys: State<Ptys>, id: String) -> Result<(), String> {
    let session = ptys.0.lock().unwrap().remove(&id);
    if let Some(mut s) = session {
        s.kill();
    }
    Ok(())
}

#[tauri::command(async)]
fn pty_shutdown(ptys: State<Ptys>) {
    let sessions = std::mem::take(&mut *ptys.0.lock().unwrap());
    for (_, mut session) in sessions { session.kill(); }
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
        // The polls run `status` and `diff` every few seconds in every thread.
        // Without this each one refreshes and REWRITES .git/index under
        // index.lock — a disk write per poll, and the lock an agent's own
        // `git commit` in a pane then trips over. Same switch VS Code's status
        // poll uses; the read-only commands stay correct, they just don't
        // persist the refreshed stat cache.
        .env("GIT_OPTIONAL_LOCKS", "0")
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
fn take_wakes() -> Vec<(String, String)> {
    drain_wakes(&std::env::temp_dir().join("loom-wait"))
}

/// `(pane id, session id)` for every pane in `ids` whose codex notify script
/// or opencode plugin has reported one, consumed as they are read. The caller
/// names its own panes, so another Loom window cannot consume a marker before
/// its owner sees it. Polled every 4 s, not with the wakes: only the next
/// launch needs these, and on the 250 ms tick this was a file open per pane
/// under the pty lock every keystroke waits on.
#[tauri::command(async)]
fn take_sessions(app: AppHandle, ids: Vec<String>) -> Vec<(String, String)> {
    let base = data_dir(&app).join("session-marks");
    let mut out = Vec::new();
    for id in ids {
        // Pane ids are Loom's own (uid() in main.ts); anything else names no marker.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        let path = base.join(&id);
        if let Ok(sid) = std::fs::read_to_string(&path) {
            if !sid.trim().is_empty() {
                out.push((id, sid.trim().to_string()));
                let _ = std::fs::remove_file(path);
            }
        }
    }
    out
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
    codex_session_rows(&codex_home(&app)?, &dir, None)
}

fn codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".codex")))
        .ok_or_else(|| "no home dir".to_string())
}

#[tauri::command(async)]
fn has_codex_session(app: AppHandle, sid: String) -> Result<bool, String> {
    Ok(!codex_session_rows(&codex_home(&app)?, "", Some(&sid))?.is_empty())
}

fn codex_session_rows(home: &std::path::Path, dir: &str, sid: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    use std::io::BufRead;
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
        if sid.is_some_and(|id| !path.file_name().unwrap().to_string_lossy().ends_with(&format!("-{id}.jsonl"))) {
            continue;
        }
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let mut lines = std::io::BufReader::new(file).lines().map_while(Result::ok);
        let Some(meta) = lines.next().and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok()) else { continue };
        let payload = &meta["payload"];
        if meta["type"] != "session_meta" || payload["source"].get("subagent").is_some() {
            continue;
        }
        let Some(id) = payload["id"].as_str() else { continue };
        if let Some(sid) = sid {
            if id == sid { return Ok(vec![serde_json::json!({ "id": id })]); }
            continue;
        }
        if !payload["cwd"].as_str().is_some_and(|c| norm(c) == want) { continue; }
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
    // Helper modes the agents run (helper.rs): gone before any window exists.
    match args.first().map(String::as_str) {
        Some("--statusline") => std::process::exit(helper::statusline()),
        Some("--codex-notify") => std::process::exit(helper::codex_notify(args.get(1).map(String::as_str))),
        _ => {}
    }
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
                pty_shutdown(window.state::<Ptys>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill, pty_shutdown, load_state, save_state, open_vscode,
            git_run, git_stdin, list_files, read_file, read_image, take_wakes, take_sessions, opencode_sessions, codex_sessions, has_codex_session, usage::session_usage, usage::has_session, usage::pane_booted, usage::plan_usage, usage::codex_plan_usage,
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
    fn codex_resume_rejects_missing_and_internal_sessions() {
        let root = std::env::temp_dir().join(format!("loom-resume-test-{}", std::process::id()));
        let sessions = root.join("sessions/2026/09/12");
        std::fs::create_dir_all(&sessions).unwrap();
        for (id, source) in [("root", serde_json::json!("cli")), ("child", serde_json::json!({"subagent":{"other":"guardian"}}))] {
            std::fs::write(sessions.join(format!("rollout-test-{id}.jsonl")), format!("{}\n", serde_json::json!({
                "type": "session_meta", "payload": {"id": id, "source": source, "cwd": "C:\\project"}
            }))).unwrap();
        }
        let rows = super::codex_session_rows(&root, "c:/project/", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "root");
        assert_eq!(super::codex_session_rows(&root, "", Some("root")).unwrap().len(), 1);
        assert!(super::codex_session_rows(&root, "", Some("child")).unwrap().is_empty());
        assert!(super::codex_session_rows(&root, "", Some("ephemeral")).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

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
