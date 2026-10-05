use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod dictate;
mod awake;
mod helper;
mod codex_state;
mod output;
mod cache;
mod opencode;
mod usage;
mod pipe;
mod control;
mod deletion;
mod workspace;

const SHELL_INIT: &str = include_str!("shell-init.ps1");
/// Extra Claude Code settings, handed to each pane's `claude` via --settings.
/// Its statusline is loom.exe itself (helper.rs), whose path replaces
/// __LOOM_EXE__ at spawn.
const CLAUDE_HOOKS: &str = include_str!("claude-hooks.json");
/// opencode plugin: turns session.idle and question/permission prompts into
/// the same wake marker claude's Stop hook drops. Installed in OpenCode's
/// global config directory; inert outside a Loom pane.
const OPENCODE_PLUGIN: &str = include_str!("loom-opencode.js");

/// One `pty_write`: the bytes, and where the pane's writer thread reports the result.
type Input = (String, tauri::async_runtime::Sender<Result<(), String>>);

#[derive(Default)]
struct Resizes {
    active: bool,
    pending: Option<PtySize>,
}

struct Session {
    // Close the input pipe before ClosePseudoConsole runs in master's Drop.
    // The writer thread holds it weakly, so only a write in progress keeps it open.
    _writer: Arc<Mutex<Box<dyn Write + Send>>>,
    input: std::sync::mpsc::Sender<Input>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    resizes: Arc<Mutex<Resizes>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    /// The page's launch (Pane.generation) this process is: a stop or an exit
    /// for an older one must not end or mark the one that replaced it.
    launch: Option<u64>,
    flow: Arc<output::Flow>,
    _cache_lease: Option<std::fs::File>,
}

impl Session {
    /// Kill the shell AND everything it spawned. `killer` alone is a
    /// TerminateProcess on the shell; claude/node under it live on, and a
    /// process whose cwd is the worktree makes `git worktree remove` fail
    /// with "Permission denied" on Windows.
    fn kill(&mut self) {
        self.flow.close();
        if let Some(pid) = self.pid {
            taskkill(&[pid]);
        }
        let _ = self.killer.kill();
    }
}

/// `taskkill /T /F` on these process trees, one spawn per 32 of them: a spawn
/// costs about 0.45 s. A PID that is already gone only makes it exit nonzero;
/// the others still die.
fn taskkill(pids: &[u32]) {
    use std::os::windows::process::CommandExt;
    for chunk in pids.chunks(32) {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/T", "/F"]);
        for pid in chunk {
            cmd.args(["/PID", &pid.to_string()]);
        }
        let _ = cmd.creation_flags(0x0800_0000).output(); // CREATE_NO_WINDOW
    }
}

#[derive(Default)]
struct Ptys(Mutex<HashMap<String, Session>>);
#[derive(Default)]
struct WindowStateReady(std::sync::atomic::AtomicBool);
/// Tells the window-state saver the main window moved or resized (`run` setup).
struct WindowMoved(std::sync::mpsc::Sender<()>);
/// The main window's WebView2 folder, reused by the overlay: webviews on one
/// folder share a browser process, a second folder would start another.
struct ProfileDir(PathBuf);

/// Resolve explicit working directories before creating a pane or thread.
fn canonical_directory(path: String) -> Result<String, String> {
    let dir = std::fs::canonicalize(&path).map_err(|_| "Not an existing directory".to_string())?;
    if !dir.is_dir() { return Err("Not an existing directory".into()); }
    // Keep ordinary Windows paths usable by Git, PowerShell, and thread identity.
    let text = dir.to_string_lossy();
    Ok(if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
       else { text.strip_prefix(r"\\?\").unwrap_or(&text).to_string() })
}

/// The small always-on-top list of working and waiting agents that Loom shows
/// while it is in the background (overlay.ts). `Some(show)` builds it on first
/// use and shows or hides it; `None` closes it when the preference is turned off.
/// Async on purpose: building a window inside a synchronous command deadlocks
/// on Windows, which runs those on the event-loop thread the build waits for.
#[tauri::command]
async fn overlay(app: AppHandle, show: Option<bool>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
    let existing = app.get_webview_window("overlay");
    let Some(show) = show else {
        return existing.map_or(Ok(()), |w| w.destroy().map_err(|e| e.to_string()));
    };
    let w = match existing {
        Some(w) => w,
        None => tauri::WebviewWindowBuilder::new(&app, "overlay", tauri::WebviewUrl::App("overlay.html".into()))
            .title("Loom agents")
            // Resizable; the window-state plugin puts back its size and place.
            .inner_size(300.0, 240.0)
            .min_inner_size(220.0, 110.0)
            .decorations(false)
            .maximizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .background_color(tauri::window::Color(10, 15, 27, 255))
            .data_directory(app.state::<ProfileDir>().0.clone())
            .build()
            .map_err(|e| e.to_string())?,
    };
    // Not w.show(): tao shows with SW_SHOW, which activates the window and
    // would take the keyboard from whatever app you are typing in.
    let hwnd = w.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
    Ok(())
}

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
    bus: bool,
    launch: Option<u64>,
) -> Result<(), String> {
    if argv.is_empty() {
        return Err("empty argv".into());
    }
    if codex_state_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')) {
        return Err("invalid Codex state id".into());
    }
    let cwd = cwd.map(canonical_directory).transpose()?;
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
    let hooks_arg = hooks.display().to_string();
    let mut cmd_line = (argv.len() == 5 && argv[0].eq_ignore_ascii_case("cmd.exe") && argv[3] == "/c")
        // Codex's notify program goes in by path (agent.ts: CODEX_NOTIFY).
        .then(|| argv[4].replace("$LOOM_EXE", &exe.display().to_string()));
    if let Some(line) = cmd_line.as_mut().filter(|line| opencode::command(line).is_some()) {
        *line = opencode::launch(line, cwd.as_deref().unwrap_or("."))?;
        opencode::install(&app.path().home_dir().map_err(|e| e.to_string())?)?;
    }
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
    let mut cache_lease = None;
    if let Some(sid) = codex_state_id {
        // Codex's shared log DB can lock out concurrent startups. Keep each
        // pane's SQLite state across relaunches; auth/config/rollouts still
        // use CODEX_HOME. An explicit sqlite_home in Codex config still wins.
        let root = data_dir(&app).join("codex-sqlite");
        cache_lease = Some(cache::acquire(&root, &sid, &state_file(&app)).map_err(|e| e.to_string())?);
        let sqlite = root.join(sid);
        if let Some(home) = std::env::var_os("CODEX_HOME").map(PathBuf::from)
            .or_else(|| app.path().home_dir().ok().map(|h| h.join(".codex"))) {
            codex_state::seed(&home, &sqlite);
        }
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
    // opencode plugin) drop a marker named after this, and `send_wakes` turns
    // it back into a pane.
    cmd.env("LOOM_PANE", &id);
    // Which launch of the pane this process is (Pane.generation): every task
    // report carries it, so a late one from a replaced process moves nothing.
    if let Some(launch) = launch {
        cmd.env("LOOM_LAUNCH", launch.to_string());
    }
    cmd.env("LOOM_SESSION_FILE", data_dir(&app).join("session-marks").join(&id));
    // loomctl from inside a pane reaches the Loom that owns it (control.rs),
    // and finds loomctl.exe beside loom.exe without a PATH of its own.
    cmd.env("LOOM_PIPE", pipe::instance_pipe());
    if let Some(dir) = exe.parent() {
        let mut path = std::ffi::OsString::from(dir);
        if let Some(rest) = cmd.get_env("PATH") {
            path.push(";");
            path.push(rest);
        }
        cmd.env("PATH", path);
    }
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
    // Claude Code 2.1.284 turns its fullscreen renderer on by default: the
    // alternate screen with mouse tracking, so xterm keeps no scrollback (no
    // scrollbar) and every wheel tick is a redraw through ConPTY. Keep it
    // inline, as Codex is kept (agent.ts: tui.alternate_screen=never).
    cmd.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1");
    // Shell panes dot-source this (agent.ts: `. $env:LOOM_INIT`) — a variable,
    // not a literal path, so a data dir with spaces needs no quoting.
    cmd.env("LOOM_INIT", &init);
    // claude gets this via `--settings`; the hook inside reports which
    // transcript the pane ends up on, which the pinned session id can't (it goes
    // stale on /clear, or if claude is relaunched by hand).
    cmd.env("LOOM_HOOKS", &hooks);
    match cwd {
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
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    // Keystrokes reach the pane through its own thread, in order. A child that
    // stops reading fills its input pipe, and that wait must hold neither an
    // async worker nor the map lock.
    let (input, inputs) = std::sync::mpsc::channel::<Input>();
    let pipe = Arc::downgrade(&writer);
    std::thread::spawn(move || {
        for (data, reply) in inputs {
            let result = match pipe.upgrade() {
                Some(writer) => {
                    let mut writer = writer.lock().unwrap();
                    writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|e| e.to_string())
                }
                None => Err("no such pty".to_string()),
            };
            let _ = reply.blocking_send(result);
        }
    });

    // Reader → channel → emitter: the emitter drains whatever queued up while the
    // last send was in flight, so fast output becomes a few big IPC messages instead
    // of one per 8 KiB read. Adds no latency — try_recv never waits.
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(16);
    let flow = Arc::new(output::Flow::default());
    let channel = on_out.id();
    app.state::<output::Flows>().0.lock().unwrap().insert(channel, (id.clone(), flow.clone()));
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
    let output_flow = flow.clone();
    let output_app = app.clone();
    std::thread::spawn(move || {
        while let Ok(mut text) = rx.recv() {
            // Four unacknowledged chunks at most. Invalid UTF-8 can expand
            // an 8 KiB read to 24 KiB, so a chunk stays below 88 KiB.
            while text.len() < 64 << 10 {
                match rx.try_recv() {
                    Ok(more) => text.push_str(&more),
                    Err(_) => break,
                }
            }
            if !output_flow.acquire() { break; }
            // Tagged with this launch's channel, so a relaunch's late output is still told apart.
            let sent = match if bus { output_app.state::<output::Bus>().push(channel, text) } else { Err(text) } {
                Ok(()) => true,
                Err(text) => on_out.send(text).is_ok(),
            };
            if !sent { break; }
        }
        output_app.state::<output::Flows>().0.lock().unwrap().remove(&channel);
    });

    let previous = ptys.0.lock().unwrap().insert(
        id.clone(),
        Session {
            master: Arc::new(Mutex::new(pair.master)), resizes: Arc::default(),
            _writer: writer,
            input,
            killer,
            pid,
            launch,
            flow,
            _cache_lease: cache_lease,
        },
    );
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let ptys = app.state::<Ptys>();
        let session = {
            let mut map = ptys.0.lock().unwrap();
            // A replaced process must not remove or mark its replacement dead.
            if map.get(&id).is_some_and(|s| s.pid == pid) { map.remove(&id) } else { None }
        };
        if session.is_some() {
            // Output already read goes first, as it did before the bus batched it.
            app.state::<output::Bus>().flush();
            // A turn that ended just before the exit still rings. Left behind, its
            // marker would wake this pane's next launch, which reuses the id.
            send_wakes(&app, std::slice::from_ref(&id));
            send_task_events(&app, std::slice::from_ref(&id));
            let _ = app.emit(&format!("pty-exit:{id}"), serde_json::json!({ "code": code, "launch": launch }));
        }
        // Release the input pipe and console even if the exited pane stays open.
        // ClosePseudoConsole may drain output, so keep it outside the map lock.
        drop(session);
    });
    // Dropping a ConPTY can wait for its output to drain. Never do that while
    // holding the map lock that other panes' writes and resizes need.
    if let Some(mut previous) = previous { previous.kill(); }
    Ok(())
}

/// Hands the bytes to the pane's writer thread and waits for its result, so a
/// failed write still rejects. A full input pipe holds no worker while it waits.
#[tauri::command]
async fn pty_write(ptys: State<'_, Ptys>, id: String, data: String) -> Result<(), String> {
    let (reply, mut result) = tauri::async_runtime::channel(1);
    ptys.0.lock().unwrap().get(&id).ok_or("no such pty")?.input.send((data, reply)).map_err(|_| "no such pty")?;
    result.recv().await.unwrap_or_else(|| Err("no such pty".into()))
}

#[tauri::command]
fn pty_ack(flows: State<output::Flows>, channel: u32) {
    if let Some((_, flow)) = flows.0.lock().unwrap().get(&channel) { flow.ack(); }
}

/// Where panes spawned with `bus` send their output: one message per flush for
/// all of them, `[channel, text]` entries (output.rs). Scripts that spawn
/// without it keep reading their own channels.
#[tauri::command]
fn output_bus(bus: State<output::Bus>, on_out: tauri::ipc::Channel<Vec<(u32, String)>>) {
    bus.open(move |batch| { let _ = on_out.send(batch); });
}

/// `pty_ack` for several panes and batches at once: `(channel, batches parsed)`.
#[tauri::command]
fn pty_acks(flows: State<output::Flows>, acks: Vec<(u32, usize)>) {
    let flows = flows.0.lock().unwrap();
    for (channel, n) in acks {
        if let Some((_, flow)) = flows.get(&channel) { flow.ack_n(n); }
    }
}

fn resize_pty(ptys: &Ptys, id: &str, cols: u16, rows: u16,
    mut resize: impl FnMut(&dyn MasterPty, PtySize) -> Result<(), String>) -> Result<(), String> {
    // ConPTY can stall here. Own this launch's handles, not the registry lock.
    let (master, resizes) = {
        let map = ptys.0.lock().unwrap();
        let s = map.get(id).ok_or("no such pty")?;
        (s.master.clone(), s.resizes.clone())
    };
    {
        let mut sizes = resizes.lock().unwrap();
        sizes.pending = Some(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 });
        // Later requests only replace the pending size. They never wait for
        // the console or occupy another blocked worker behind this resize.
        if sizes.active { return Ok(()); }
        sizes.active = true;
    }
    loop {
        let size = {
            let mut sizes = resizes.lock().unwrap();
            match sizes.pending.take() {
                Some(size) => size,
                None => { sizes.active = false; return Ok(()); }
            }
        };
        let result = resize(master.lock().unwrap().as_ref(), size);
        if result.is_err() {
            *resizes.lock().unwrap() = Resizes::default();
            return result;
        }
    }
}

fn pty_kill(ptys: State<Ptys>, flows: State<output::Flows>, id: String, launch: Option<u64>) -> Result<(), String> {
    // A stop for an older launch must not end the one that replaced it.
    if launch.is_some() && ptys.0.lock().unwrap().get(&id).is_some_and(|s| s.launch != launch) { return Ok(()); }
    // A child can exit before its final output is parsed. Closing that pane
    // must also release its emitter when no Session remains in the map.
    for (pane, flow) in flows.0.lock().unwrap().values() {
        if pane == &id { flow.close(); }
    }
    let session = ptys.0.lock().unwrap().remove(&id);
    if let Some(mut s) = session {
        s.kill();
    }
    Ok(())
}

fn pty_shutdown(ptys: State<Ptys>, flows: State<output::Flows>) {
    for (_, flow) in flows.0.lock().unwrap().values() { flow.close(); }
    let sessions = std::mem::take(&mut *ptys.0.lock().unwrap());
    taskkill(&sessions.values().filter_map(|s| s.pid).collect::<Vec<_>>());
    // Dropping a session runs ClosePseudoConsole, which can wait for its output
    // to drain, so drop them side by side. Returns once all are gone.
    std::thread::scope(|scope| {
        for (_, mut session) in sessions {
            scope.spawn(move || {
                session.flow.close();
                let _ = session.killer.kill();
            });
        }
    });
}

/// One git invocation in `dir`, stdout back, stderr as the error. The thread
/// model is built on this — worktree add/list/remove, branch names — and the
/// porcelain lives in the frontend, so this stays one function.
/// `ok`: extra exit codes to treat as success — `git diff --no-index` answers 1
/// when the files differ, which is the whole point of asking.
/// `preview`: a diff to show, bounded (diff_output) so a huge one fails fast
/// instead of crossing IPC whole. The Changes panel's numstat and the polls
/// aren't: a big repo's take longer, and their size follows the file count.
fn git_run(dir: String, mut args: Vec<String>, ok: Option<Vec<i32>>, preview: bool) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    if matches!(args.first().map(String::as_str), Some("diff" | "show")) {
        args.splice(1..1, ["--no-ext-diff".into(), "--no-textconv".into()]);
    }
    // The polls skip the cmd\git.exe wrapper's own process. Anything that may
    // commit, push or ask for credentials keeps it.
    let read = matches!(args.first().map(String::as_str), Some("status" | "diff" | "log" | "rev-parse" | "rev-list"));
    let mut command = read.then(git_direct).flatten().unwrap_or_else(|| std::process::Command::new("git"));
    command
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
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = if preview {
        diff_output(&mut command, 4 * 1024 * 1024)?
    } else { command.output().map_err(|e| format!("git: {e}"))? };
    let fine = out.status.success()
        || out.status.code().is_some_and(|c| ok.as_deref().unwrap_or(&[]).contains(&c));
    if fine {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git exited {:?}", out.status.code()) } else { err })
    }
}

fn diff_output(command: &mut std::process::Command, limit: usize) -> Result<std::process::Output, String> {
    use std::{process::Stdio, time::{Duration, Instant}};
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let (send, receive) = std::sync::mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    for (is_out, stream, cap) in [(true, Box::new(stdout) as Box<dyn Read + Send>, limit),
        (false, Box::new(stderr) as Box<dyn Read + Send>, 64 * 1024)] {
        let send = send.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut bytes = Vec::new();
            let result = (&mut stream).take(cap as u64 + 1).read_to_end(&mut bytes)
                .map_err(|e| e.to_string()).and_then(|_| if bytes.len() <= cap { Ok(bytes) } else if is_out {
                    Err("Diff preview exceeds its output limit (4 MiB). Open the file in an editor.".into())
                } else {
                    // Git's warnings (autocrlf prints one per file) show only on
                    // failure: keep their start, drain the rest so git never blocks.
                    bytes.truncate(cap);
                    let _ = std::io::copy(&mut stream, &mut std::io::sink());
                    Ok(bytes)
                });
            let _ = send.send((is_out, result));
        });
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = (|| {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        for _ in 0..2 {
            let (is_out, bytes) = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "Diff preview exceeded five seconds. Open the file in an editor.".to_string())?;
            if is_out { stdout = bytes?; } else { stderr = bytes?; }
        }
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Ok(std::process::Output { status, stdout, stderr });
            }
            if Instant::now() >= deadline { return Err("Diff preview exceeded five seconds".into()); }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    result
}

/// Git for Windows' real git.exe, with the environment its cmd\git.exe wrapper
/// would have set: MINGW64, its bin folders and ~\bin first on PATH, HOME and
/// PLINK_PROTOCOL when unset. scripts/git-direct-check.mjs compares the two,
/// environment and output, in every saved thread folder. None when Git isn't
/// laid out that way, and callers use the wrapper.
fn git_direct() -> Option<std::process::Command> {
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt;
    static REAL: std::sync::OnceLock<Option<(PathBuf, Vec<(&str, OsString)>)>> = std::sync::OnceLock::new();
    let (exe, env) = REAL.get_or_init(|| {
        let out = std::process::Command::new("git").arg("--exec-path").creation_flags(0x0800_0000).output().ok()?;
        // <root>/mingw64/libexec/git-core
        let exec = PathBuf::from(String::from_utf8(out.stdout).ok()?.trim().replace('/', "\\"));
        let root = exec.parent()?.parent()?.parent()?;
        let (exe, mingw, usr) = (exec.join("git.exe"), root.join("mingw64\\bin"), root.join("usr\\bin"));
        if !exe.is_file() || !mingw.is_dir() || !usr.is_dir() { return None; }
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty());
        let home = var("HOME").map(PathBuf::from)
            .or_else(|| {
                let mut drive = var("HOMEDRIVE")?;
                drive.push(var("HOMEPATH")?);
                Some(PathBuf::from(drive)).filter(|p| p.is_dir())
            })
            .or_else(|| var("USERPROFILE").map(PathBuf::from))?;
        let mut path = std::env::join_paths([mingw, usr, home.join("bin")]).ok()?;
        if let Some(rest) = var("PATH") { path.push(";"); path.push(rest); }
        let mut env = vec![("MSYSTEM", OsString::from("MINGW64")), ("PATH", path)];
        if var("PLINK_PROTOCOL").is_none() { env.push(("PLINK_PROTOCOL", "ssh".into())); }
        if var("HOME").is_none() { env.push(("HOME", home.into())); }
        Some((exe, env))
    }).as_ref()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    Some(cmd)
}

/// What the checkout at `dir` stopped in the middle of: "merge", "revert",
/// "rebase" or "", first match in that order. Each leaves a marker in the
/// checkout's own git dir, so the usual answer starts no process. A marker is
/// confirmed with the command the Changes panel used to run on every refresh:
/// `rebase-apply` is also `git am`'s, and a rebase paused at `break` has no
/// current patch, and neither shows a rebase bar.
fn git_midway(dir: String) -> String {
    let Some(gd) = git_dir(std::path::Path::new(&dir)) else { return String::new() };
    let ok = |args: &[&str]| git_run(dir.clone(), args.iter().map(|a| a.to_string()).collect(), None, false).is_ok();
    if gd.join("MERGE_HEAD").exists() && ok(&["rev-parse", "-q", "--verify", "MERGE_HEAD"]) {
        return "merge".into();
    }
    if gd.join("REVERT_HEAD").exists() && ok(&["rev-parse", "-q", "--verify", "REVERT_HEAD"]) {
        return "revert".into();
    }
    if (gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists()) && ok(&["rebase", "--show-current-patch"]) {
        return "rebase".into();
    }
    String::new()
}

/// The git dir of the checkout holding `dir`: its `.git` folder, or where a
/// linked worktree's `.git` file points.
fn git_dir(dir: &std::path::Path) -> Option<PathBuf> {
    let root = dir.ancestors().find(|d| d.join(".git").exists())?;
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    Some(root.join(text.strip_prefix("gitdir:")?.trim()))
}

/// Every file under `dir`, relative with `/`, for the Files tree. Folders git
/// would not track are skipped, so a `node_modules` never lands in the panel.
/// ponytail: no .gitignore parsing — `git ls-files` covers git checkouts and
/// this is the fallback for plain folders; caps at 20k entries.
fn list_files(dir: String) -> Vec<String> {
    let root = std::path::PathBuf::from(&dir);
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            // Reuse the listing's type; only links need a lookup of their target.
            let folder = e.file_type().map_or_else(|_| p.is_dir(), |t| if t.is_symlink() { p.is_dir() } else { t.is_dir() });
            if folder {
                let name = e.file_name().to_string_lossy().into_owned();
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
fn read_file(dir: String, path: String) -> Result<String, String> {
    let file = std::fs::File::open(std::path::Path::new(&dir).join(&path)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take((4 << 20) + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let cut = bytes.len() > 4 << 20;
    bytes.truncate(4 << 20);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if cut {
        text.push_str("\n… truncated at 4 MB");
    }
    Ok(text)
}

fn read_image(dir: String, path: String) -> Result<tauri::ipc::Response, serde_json::Value> {
    let requested = std::path::Path::new(&path);
    let mut path = std::path::Path::new(&dir).join(requested);
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif") {
        return Err("Unsupported image format".into());
    }
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        // Harnesses can display just a basename in a tool summary. Keep full
        // paths exact, but find a unique artifact inside this thread's folder.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && requested.file_name() == Some(requested.as_os_str()) => {
            path = find_image(std::path::Path::new(&dir), requested)?;
            std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?
        }
        Err(e) => return Err(format!("{}: {e}", path.display()).into()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Not an image file".into());
    }
    // ponytail: cap previews at 32 MB; stream larger images if needed.
    let mut bytes = Vec::new();
    file.take((32 << 20) + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 32 << 20 { return Err("Image exceeds the 32 MB preview limit".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}

fn find_image(root: &std::path::Path, name: &std::path::Path) -> Result<PathBuf, serde_json::Value> {
    let mut dirs = vec![root.to_path_buf()];
    let mut found = Vec::new();
    let mut entries = 0;
    let started = std::time::Instant::now();
    // ponytail: bounded on-demand walk, including ignored caches; index artifacts
    // if projects outgrow this limit. Never choose from an incomplete search.
    while let Some(dir) = dirs.pop() {
        let children = std::fs::read_dir(&dir).map_err(|e| format!("Could not search {}: {e}. Open the full image path.", dir.display()))?;
        for child in children {
            entries += 1;
            if entries > 100_000 || started.elapsed().as_secs() >= 3 {
                return Err("Image search limit reached. Open the full image path.".into());
            }
            let child = child.map_err(|e| e.to_string())?;
            let kind = child.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() {
                if child.file_name() != ".git" { dirs.push(child.path()); }
            } else if kind.is_file() && child.file_name().to_string_lossy().eq_ignore_ascii_case(&name.to_string_lossy()) {
                found.push(child.path());
            }
        }
    }
    found.sort();
    match found.len() {
        0 => Err(format!("Image {} was not found under {}. Open its full path if it is outside this folder.", name.display(), root.display()).into()),
        1 => Ok(found.pop().unwrap()),
        _ => Err(serde_json::json!({ "matches": found })),
    }
}

/// `git_run` with the patch on stdin, which is the only way to hand `git apply`
/// one hunk: staging part of a file writes a patch nobody should have to keep
/// in a temp file.
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

/// Which of `ids` finished a turn, as a `wakes` event to the page, consumed as
/// they are read. Hooks can't write into the pane itself — a BEL sent to CONOUT$
/// is swallowed by conhost and never reaches ConPTY — so they drop a file
/// instead, exactly like aa does with WEZTERM_PANE. Only this Loom's panes: the
/// folder is per user, not per Loom, and a second Loom running at the same time
/// used to eat the other's markers. opencode's plugin has no other way to ring.
/// The page used to poll this over IPC four times a second, idle or not.
// ponytail: a 250 ms scan of one temp dir, no file watcher; the markers live in
// their own %TEMP%\loom-wait\ folder, so it only walks Loom's own files.
fn send_wakes(app: &AppHandle, ids: &[String]) {
    let woke = drain_wakes(&std::env::temp_dir().join("loom-wait"), ids);
    if !woke.is_empty() { let _ = app.emit("wakes", woke); }
}

/// What the agents reported for loomctl's tasks (helper.rs `task_event`, the
/// OpenCode plugin), as one `agent-events` event of (pane id, event), oldest
/// first per pane, consumed as they are read. Only this Loom's panes, as with
/// the wakes.
fn send_task_events(app: &AppHandle, ids: &[String]) {
    let got = drain_task_events(&std::env::temp_dir().join("loom-task"), ids);
    if !got.is_empty() { let _ = app.emit("agent-events", got); }
}

/// `<pane>.<ms>.<pid>.json` files: another Loom's are left for it, and dropped
/// after a day. A `.tmp` is one still being written.
fn drain_task_events(dir: &std::path::Path, ids: &[String]) -> Vec<(String, serde_json::Value)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.split('.').next() else { continue };
        if !ids.iter().any(|x| x == id) {
            let stale = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > std::time::Duration::from_secs(86_400));
            if stale { let _ = std::fs::remove_file(e.path()); }
            continue;
        }
        if name.ends_with(".json") { files.push((name.clone(), id.to_string(), e.path())); }
    }
    files.sort();
    files.into_iter().filter_map(|(_, id, path)| {
        let text = claim(&path)?;
        Some((id, serde_json::from_str(&text).ok()?))
    }).collect()
}

/// Hook markers are named by pane ids, which change every run, so nothing reads
/// one after its pane is gone. ponytail: by age, at startup. A pane up for over
/// `age` loses its marker until its session next starts, resumes or compacts.
fn prune_markers(dirs: &[PathBuf], age: std::time::Duration) {
    for e in dirs.iter().flat_map(std::fs::read_dir).flatten().flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > age);
        if old { let _ = std::fs::remove_file(e.path()); }
    }
}

/// A marker's text, consumed. The 250 ms poll and a pane's exit thread drain
/// the same folders: opened alone (no sharing) and deleted on close, a file
/// goes to one of them. A rename can't claim it: std renames through a handle,
/// which moves the file wherever the other drainer just put it.
fn claim(path: &std::path::Path) -> Option<String> {
    use std::os::windows::fs::OpenOptionsExt;
    const GENERIC_READ: u32 = 0x8000_0000;
    const DELETE: u32 = 0x0001_0000;
    const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
    let mut file = std::fs::OpenOptions::new().access_mode(GENERIC_READ | DELETE).share_mode(0)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE).open(path).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

/// loomctl's task journal (task.ts), beside the state file it belongs to:
/// `workspaces.tasks.jsonl`, or `<profile>.tasks.jsonl`.
fn task_journal_file(app: &AppHandle) -> PathBuf {
    state_file(app).with_extension("tasks.jsonl")
}

/// The journal's text: empty when there's none yet, an error when it can't
/// be read (never an empty journal: that would forget every task's --key).
/// Lossy, because an append cut off inside a UTF-8 character leaves bytes
/// that aren't text, and that must cost only the torn last line, which
/// task.ts skips, not every line before it.
fn read_task_journal(path: &std::path::Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn task_journal_write(app: AppHandle, text: String, append: bool) -> Result<(), String> {
    use std::io::Write;
    let path = task_journal_file(&app);
    if append { return append_journal(&path, &text); }
    // A rewrite (on load, and when appends pile up) replaces the file whole, as save_state does.
    let pending = path.with_extension("jsonl.pending");
    let mut f = std::fs::File::create(&pending).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(pending, path).map_err(|e| e.to_string())
}

/// Append records. After a torn last line (a crash mid-append) they start on
/// a line of their own, or the next replay would skip them with the fragment.
fn append_journal(path: &std::path::Path, text: &str) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut f = std::fs::OpenOptions::new().create(true).read(true).append(true).open(path).map_err(|e| e.to_string())?;
    let mut last = [b'\n'];
    if f.seek(SeekFrom::End(-1)).is_ok() { f.read_exact(&mut last).map_err(|e| e.to_string())?; }
    let text = if last[0] == b'\n' { text.to_string() } else { format!("\n{text}") };
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

/// `(pane id, session id)` for every pane in `ids` whose codex notify script
/// or opencode plugin has reported one, consumed as they are read. The caller
/// names its own panes, so another Loom window cannot consume a marker before
/// its owner sees it. Polled every 4 s, not with the wakes: only the next
/// launch needs these, and on the 250 ms tick this was a file open per pane
/// under the pty lock every keystroke waits on.
#[tauri::command(async)]
fn take_sessions(app: AppHandle, ids: Vec<String>) -> Vec<(String, String, Option<u64>)> {
    let base = data_dir(&app).join("session-marks");
    let mut out = Vec::new();
    for id in ids {
        // Pane ids are Loom's own (uid() in main.ts); anything else names no marker.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        let path = base.join(&id);
        // "sid", or "sid\nlaunch" from a writer that knows its launch (LOOM_LAUNCH).
        if let Ok(text) = std::fs::read_to_string(&path) {
            let mut lines = text.lines().map(str::trim);
            if let Some(sid) = lines.next().filter(|s| !s.is_empty()) {
                out.push((id, sid.to_string(), lines.next().and_then(|l| l.parse().ok())));
                let _ = std::fs::remove_file(path);
            }
        }
    }
    out
}

fn opencode_sessions(dir: String, command: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    opencode::sessions(&dir, command.as_deref().unwrap_or("opencode"))
}

/// Codex conversations started in `dir`, newest first, as `{id, title}`. Codex
/// has no machine-readable listing, so this reads what its own picker reads:
/// the `session_meta` first line of every rollout under $CODEX_HOME/sessions,
/// titled from session_index.jsonl (Codex's auto-name) or the first prompt.
// ponytail: one full walk per open of the picker, 20 newest matches.
fn codex_sessions(app: AppHandle, dir: String) -> Result<Vec<serde_json::Value>, String> {
    codex_session_rows(&codex_home(&app)?, &dir, None)
}

fn codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".codex")))
        .ok_or_else(|| "no home dir".to_string())
}

fn has_codex_session(app: AppHandle, sid: String) -> Result<bool, String> {
    Ok(!codex_session_rows(&codex_home(&app)?, "", Some(&sid))?.is_empty())
}

fn codex_session_rows(home: &std::path::Path, dir: &str, sid: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    use std::io::BufRead;
    let mut names = std::collections::HashMap::new();
    // Only a listing shows titles; a lookup by id never reads them.
    let index = if sid.is_none() { std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default() } else { String::new() };
    for line in index.lines() {
        if let Ok(row) = serde_json::from_str::<serde_json::Value>(line) {
            if let (Some(id), Some(name)) = (row["id"].as_str(), row["thread_name"].as_str()) {
                names.insert(id.to_string(), name.to_string());
            }
        }
    }
    let mut files = Vec::new();
    codex_rollouts(&home.join("sessions"), &mut files);
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

fn codex_rollouts(dir: &std::path::Path, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        // The listing already says what each entry is. Only a link (a symlink or
        // junction) needs a look at its target, so linked folders are still walked.
        let folder = e.file_type().map_or_else(|_| p.is_dir(), |t| if t.is_symlink() { p.is_dir() } else { t.is_dir() });
        if folder {
            codex_rollouts(&p, out);
        } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")) {
            out.push((e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
        }
    }
}

#[derive(Default, serde::Serialize, Debug, PartialEq)]
struct LastMessages {
    user: String,
    agent: String,
}

fn message_text(content: &serde_json::Value, kind: &str) -> String {
    let texts = content.as_str().into_iter().chain(
        content.as_array().into_iter().flatten()
            .filter(|part| part["type"] == kind)
            .filter_map(|part| part["text"].as_str())
    );
    let mut short = String::new();
    let mut count = 0;
    let mut space = false;
    // Normalize only the preview, even when one word or block is megabytes long.
    // Delay whitespace until the next non-space so trailing whitespace stays trimmed.
    for c in texts.flat_map(|s| s.chars().chain(std::iter::once(' '))) {
        if c.is_whitespace() {
            space = count > 0;
            continue;
        }
        for c in space.then_some(' ').into_iter().chain(std::iter::once(c)) {
            if count == 500 {
                short.push('…');
                return short;
            }
            short.push(c);
            count += 1;
        }
        space = false;
    }
    short
}

fn collect_message(last: &mut LastMessages, provider: &str, v: &serde_json::Value) {
    let (role, content, kind) = match provider {
        "claude" if !v["isSidechain"].as_bool().unwrap_or(false)
            && !v["isCompactSummary"].as_bool().unwrap_or(false)
            && !v["isMeta"].as_bool().unwrap_or(false) => {
            let role = v["type"].as_str().unwrap_or("");
            (role, &v["message"]["content"], "text")
        }
        "codex" if v["type"] == "response_item" && v["payload"]["type"] == "message" => {
            let role = v["payload"]["role"].as_str().unwrap_or("");
            if role == "assistant" && v["payload"]["phase"] == "analysis" { return; }
            (role, &v["payload"]["content"], if role == "user" { "input_text" } else { "output_text" })
        }
        "opencode" if v["type"] == "user" => ("user", &v["text"], "text"),
        "opencode" if v["type"] == "assistant" => ("assistant", &v["content"], "text"),
        "opencode" => (v["info"]["role"].as_str().unwrap_or(""), &v["parts"], "text"),
        _ => return,
    };
    if role != "user" && role != "assistant" { return; }
    if role == "user" && !last.user.is_empty() || role == "assistant" && !last.agent.is_empty() { return; }
    let text = message_text(content, kind);
    if text.is_empty() { return; }
    if role == "user" && (text.starts_with("<task-notification>") || text.starts_with("<system-reminder>")
        || text.starts_with("<environment_context>") || text.starts_with("<local-command")) { return; }
    if role == "user" { last.user = text; } else { last.agent = text; }
}

fn recent_messages(path: &std::path::Path, provider: &str) -> LastMessages {
    let mut last = LastMessages::default();
    let Ok(mut file) = std::fs::File::open(path) else { return last };
    let Ok(mut end) = file.metadata().map(|m| m.len()) else { return last };
    // ponytail: 8 MiB back from the end, and lines over 256 KiB (tool output)
    // skipped unbuffered. A turn longer than that leaves a field empty, and the
    // Overview keeps the one it had.
    let floor = end.saturating_sub(8 * 1024 * 1024);
    let (mut reversed, mut skipping) = (Vec::new(), false);
    while end > floor && (last.user.is_empty() || last.agent.is_empty()) {
        let start = end.saturating_sub(64 * 1024).max(floor);
        let mut chunk = vec![0; (end - start) as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut chunk).is_err() { break; }
        for byte in chunk.into_iter().rev() {
            if byte == b'\n' {
                if std::mem::take(&mut skipping) || reversed.is_empty() { continue; }
                reversed.reverse();
                if let Ok(v) = serde_json::from_slice(&reversed) { collect_message(&mut last, provider, &v); }
                reversed.clear();
                if !last.user.is_empty() && !last.agent.is_empty() { break; }
            } else if skipping {
            } else if reversed.len() >= 256 * 1024 {
                (reversed, skipping) = (Vec::new(), true);
            } else { reversed.push(byte); }
        }
        end = start;
    }
    if end == 0 && !skipping && !reversed.is_empty() && (last.user.is_empty() || last.agent.is_empty()) {
        reversed.reverse();
        if let Ok(v) = serde_json::from_slice(&reversed) { collect_message(&mut last, provider, &v); }
    }
    last
}

/// A stuck export must not occupy a worker forever or collect unlimited output.
fn export_output(command: &mut std::process::Command, timeout: std::time::Duration) -> Option<Vec<u8>> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(32 * 1024 * 1024 + 1);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.read_to_end(&mut bytes).ok().map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = std::time::Instant::now() + timeout;
    if let Ok(Some(bytes)) = rx.recv_timeout(timeout) {
        if bytes.len() <= 32 * 1024 * 1024 {
            while std::time::Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(status)) => return status.success().then_some(bytes),
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                    Err(_) => break,
                }
            }
        }
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000).output();
    let _ = child.kill();
    let _ = child.wait();
    None
}

fn opencode_export_messages(v: &serde_json::Value) -> LastMessages {
    let mut last = LastMessages::default();
    for message in v["messages"].as_array().into_iter().flatten().rev() {
        collect_message(&mut last, "opencode", message);
        if !last.user.is_empty() && !last.agent.is_empty() { break; }
    }
    last
}

/// `sid` is the full thread id (notify) or the 29-character prefix codex's
/// pane title carries until then (agent.ts: codexThread).
fn rollout_is(path: &std::path::Path, sid: &str) -> bool {
    path.file_stem().and_then(|n| n.to_str())
        .and_then(|n| n.get(n.len().saturating_sub(36)..))
        .is_some_and(|id| id.starts_with(sid))
}

fn last_messages(app: AppHandle, panes: Vec<(String, String, String, String)>) -> Result<HashMap<String, LastMessages>, String> {
    let mut codex_files = Vec::new();
    if panes.iter().any(|(_, agent, _, _)| agent == "codex") {
        if let Ok(home) = codex_home(&app) { codex_rollouts(&home.join("sessions"), &mut codex_files); }
    }
    let home = app.path().home_dir().unwrap_or_default();
    let marks = std::env::temp_dir().join("loom-tx");
    let mut messages = HashMap::new();
    for (id, agent, dir, sid) in panes {
        if sid.is_empty() || sid.len() > 128 || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { continue; }
        let last = match agent.as_str() {
            "claude" => recent_messages(&usage::transcript(&marks, &home, &id, &dir, &sid), "claude"),
            "codex" => codex_files.iter().find(|(_, path)| rollout_is(path, &sid))
                .map(|(_, path)| recent_messages(path, "codex")).unwrap_or_default(),
            "opencode" | "opencode1" | "opencode2" => opencode::messages(&dir, &sid, &agent).ok_or("OpenCode export failed or timed out")?,
            _ => continue,
        };
        messages.insert(id, last);
    }
    Ok(messages)
}

/// (pane id, effort level) pairs; effort is the marker's content — empty when
/// the hook had none to report (resume then falls back to the global default).
fn drain_wakes(dir: &std::path::Path, ids: &[String]) -> Vec<(String, String)> {
    let mut woke = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return woke; // no folder yet = no hooks have fired
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(id) = name.to_str() else { continue };
        if !ids.iter().any(|x| x == id) {
            // Another Loom's pane, left for its owner. One nobody took in a day
            // belonged to a pane that closed first.
            let stale = e.metadata().and_then(|m| m.modified()).ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > std::time::Duration::from_secs(86_400));
            if stale {
                let _ = std::fs::remove_file(e.path());
            }
            continue;
        }
        let Some(effort) = claim(&e.path()) else { continue };
        woke.push((id.to_string(), effort.trim().to_string()));
    }
    woke
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
    app.try_state::<workspace::Store>().map(|s| s.path.clone()).unwrap_or_else(||
        profile_arg().map_or_else(|| data_dir(app).join("workspaces.json"), PathBuf::from))
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<String, String> {
    read_workspace(&state_file(&app))
}

fn read_workspace(path: &std::path::Path) -> Result<String, String> {
    let bak = path.with_extension("json.bak");
    let fail = |why: String| {
        let copy = if bak.is_file() { format!("\n\nThe workspace as it was before its last save is {}: rename it to {} to restore it.", bak.display(), path.display()) } else { String::new() };
        Err(format!("{}: {why}{copy}", path.display()))
    };
    match std::fs::read_to_string(path) {
        // A power cut before the data reached the disk leaves zeros.
        Ok(text) if text.trim_matches(|c: char| c.is_whitespace() || c == '\0' || c == '\u{feff}').is_empty() => fail("workspace is empty".into()),
        Ok(text) => match serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
            Ok(_) => Ok(text),
            Err(e) => fail(format!("workspace isn't valid JSON ({e})")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => fail(e.to_string()),
    }
}

fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    write_workspace(&state_file(&app), &json)
}

/// Write beside the destination, flush it to disk, then replace it, so a crash
/// or power cut leaves the old snapshot or the new one, never an empty file:
/// NTFS journals the rename, not the data. The snapshot replaced stays as
/// `.bak` (a hard link, so no copy), what a broken workspace points you to.
fn write_workspace(path: &std::path::Path, json: &str) -> Result<(), String> {
    use std::io::Write;
    let pending = path.with_extension("json.pending");
    let mut file = std::fs::File::create(&pending).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    let bak = path.with_extension("json.bak");
    if path.exists() {
        let _ = std::fs::remove_file(&bak);
        let _ = std::fs::hard_link(path, &bak);
    }
    std::fs::rename(pending, path).map_err(|e| e.to_string())
}

/// The commands that wait on a process or the disk. Tauri runs async commands
/// on one Tokio worker per CPU, and every other command, keystrokes included,
/// queues behind a worker held by a slow Git call or an OpenCode read. These run
/// the same functions on the blocking pool instead, under the same names and
/// arguments, so the frontend doesn't change.
mod commands {
    use super::*;

    #[tauri::command]
    pub async fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
        blocking(move || resize_pty(&app.state::<Ptys>(), &id, cols, rows,
            |master, size| master.resize(size).map_err(|e| e.to_string()))).await
    }

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        tauri::async_runtime::spawn_blocking(f).await.expect("blocking command panicked")
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn pty_spawn(app: AppHandle, id: String, cwd: Option<String>, argv: Vec<String>, codex_state_id: Option<String>,
        cols: u16, rows: u16, on_out: tauri::ipc::Channel<String>, bus: Option<bool>, launch: Option<u64>) -> Result<(), String> {
        blocking(move || super::pty_spawn(app.clone(), app.state(), id, cwd, argv, codex_state_id, cols, rows, on_out, bus == Some(true), launch)).await
    }
    #[tauri::command]
    pub async fn pty_kill(app: AppHandle, id: String, launch: Option<u64>) -> Result<(), String> {
        blocking(move || super::pty_kill(app.state(), app.state(), id, launch)).await
    }
    #[tauri::command]
    pub async fn pty_shutdown(app: AppHandle) {
        blocking(move || super::pty_shutdown(app.state(), app.state())).await
    }
    #[tauri::command]
    pub async fn worktree_fingerprint(dir: String, hashed: Vec<String>) -> Result<String, String> {
        blocking(move || {
            let index = super::git_run(dir.clone(), vec!["rev-parse".into(), "--git-path".into(), "index".into()], None, false)?;
            let index = PathBuf::from(&dir).join(index.trim());
            deletion::fingerprint(std::path::Path::new(&dir), index.exists().then_some(index.as_path()), &hashed)
        }).await
    }
    /// Off the main thread: a folder on an unreachable share waits out the SMB
    /// timeout, and a sync command would stall the window and every request.
    #[tauri::command]
    pub async fn canonical_directory(path: String) -> Result<String, String> {
        blocking(move || super::canonical_directory(path)).await
    }
    #[tauri::command]
    pub async fn worktree_remove(repo: String, dir: String) -> Result<(), String> {
        blocking(move || deletion::remove_worktree(&repo, &dir)).await
    }
    #[tauri::command]
    pub async fn git_run(dir: String, args: Vec<String>, ok: Option<Vec<i32>>, preview: Option<bool>) -> Result<String, String> {
        blocking(move || super::git_run(dir, args, ok, preview == Some(true))).await
    }
    #[tauri::command]
    pub async fn git_midway(dir: String) -> String {
        blocking(move || super::git_midway(dir)).await
    }
    #[tauri::command]
    pub async fn git_stdin(dir: String, args: Vec<String>, patch: String) -> Result<String, String> {
        blocking(move || super::git_stdin(dir, args, patch)).await
    }
    #[tauri::command]
    pub async fn list_files(dir: String) -> Vec<String> {
        blocking(move || super::list_files(dir)).await
    }
    #[tauri::command]
    pub async fn read_file(dir: String, path: String) -> Result<String, String> {
        blocking(move || super::read_file(dir, path)).await
    }
    #[tauri::command]
    pub async fn read_image(dir: String, path: String) -> Result<tauri::ipc::Response, serde_json::Value> {
        blocking(move || super::read_image(dir, path)).await
    }
    #[tauri::command]
    pub async fn open_vscode(dir: String, goto: Option<String>) -> Result<(), String> {
        blocking(move || super::open_vscode(dir, goto)).await
    }
    #[tauri::command]
    pub async fn opencode_sessions(dir: String, command: Option<String>) -> Result<Vec<serde_json::Value>, String> {
        blocking(move || super::opencode_sessions(dir, command)).await
    }
    #[tauri::command]
    pub async fn codex_sessions(app: AppHandle, dir: String) -> Result<Vec<serde_json::Value>, String> {
        blocking(move || super::codex_sessions(app, dir)).await
    }
    #[tauri::command]
    pub async fn has_codex_session(app: AppHandle, sid: String) -> Result<bool, String> {
        blocking(move || super::has_codex_session(app, sid)).await
    }
    #[tauri::command]
    pub async fn last_messages(app: AppHandle, panes: Vec<(String, String, String, String)>) -> Result<HashMap<String, LastMessages>, String> {
        blocking(move || super::last_messages(app, panes)).await
    }
    #[tauri::command]
    pub async fn task_journal_read(app: AppHandle) -> Result<String, String> {
        blocking(move || super::read_task_journal(&super::task_journal_file(&app))).await
    }
    /// The page chains these, so appends land in order.
    #[tauri::command]
    pub async fn task_journal_write(app: AppHandle, text: String, append: bool) -> Result<(), String> {
        blocking(move || super::task_journal_write(app, text, append)).await
    }
    /// Off the main thread too; the frontend's saveQueue keeps saves in order.
    #[tauri::command]
    pub async fn save_state(app: AppHandle, json: String) -> Result<(), String> {
        blocking(move || super::save_state(app, json)).await
    }
    #[tauri::command]
    pub async fn session_usage(app: AppHandle, panes: Vec<(String, String, String)>) -> HashMap<String, usage::Usage> {
        blocking(move || usage::session_usage(app.state(), panes)).await
    }
    #[tauri::command]
    pub async fn codex_session_usage(app: AppHandle, panes: Vec<(String, String)>) -> HashMap<String, usage::Usage> {
        blocking(move || {
            let out = HashMap::new();
            let Ok(home) = super::codex_home(&app) else { return out };
            usage::codex_usage(&app.state::<usage::CodexScanned>(), &home, panes)
        }).await
    }
    #[tauri::command]
    pub async fn context_profile(pane: String, dir: String, sid: String) -> Option<usage::Profile> {
        blocking(move || usage::context_profile(pane, dir, sid)).await
    }
    #[tauri::command]
    pub async fn model_options() -> Result<Vec<usage::ModelOpt>, String> {
        blocking(usage::model_options).await
    }
    #[tauri::command]
    pub async fn plan_usage() -> Result<usage::Plan, String> {
        blocking(usage::plan_usage).await
    }
    #[tauri::command]
    pub async fn codex_plan_usage() -> Result<usage::CodexPlan, String> {
        blocking(usage::codex_plan_usage).await
    }
    #[tauri::command]
    pub async fn dictate_start(app: AppHandle) -> Result<(), String> {
        blocking(move || dictate::dictate_start(app.clone(), app.state())).await
    }
    #[tauri::command]
    pub async fn dictate_stop(app: AppHandle, lang: Option<String>) -> Result<String, String> {
        blocking(move || dictate::dictate_stop(app.clone(), app.state(), lang)).await
    }
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
    // portable-pty probes for conpty.dll. Allow deliberate app-local DLLs,
    // but never silently borrow another terminal's implementation from PATH.
    #[link(name = "kernel32")]
    extern "system" { fn SetDefaultDllDirectories(flags: u32) -> i32; }
    unsafe { SetDefaultDllDirectories(0x1000); } // LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
    // `loom --help` from a terminal. Release is a GUI-subsystem exe whose
    // stdout only exists when redirected; AttachConsole grabs the launching
    // terminal's console for the direct case (and fails harmlessly when there
    // already is one, as in debug, or none at all, as from Explorer).
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Helper modes the agents run (helper.rs): gone before any window exists.
    match args.first().map(String::as_str) {
        Some("--statusline") => std::process::exit(helper::statusline()),
        Some("--session-start") => std::process::exit(helper::session_start()),
        Some("--codex-notify") => std::process::exit(helper::codex_notify(args.get(1).map(String::as_str))),
        Some("--claude-hook") => std::process::exit(helper::claude_hook()),
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
    // Profile ownership is enforced by the storage lease in setup.
    #[cfg(not(debug_assertions))]
    let builder = if profile_arg().is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
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
        .manage(output::Flows::default())
        .manage(output::Bus::default())
        .manage(control::Pending::default())
        .manage(WindowStateReady::default())
        .manage(dictate::Dictation::default())
        .manage(usage::Scanned::default())
        .manage(usage::CodexScanned::default())
        // The window is config-defined but built here ("create": false) because
        // enable_clipboard_access has no tauri.conf.json equivalent — without it
        // WebView2 shows a permission prompt on navigator.clipboard.readText.
        // from_config carries "backgroundColor" through: WebView2 paints its own
        // white until the document's first frame, so without it startup flashes
        // white for as long as the webview takes to come up.
        .setup(|app| {
            // Before reset, window construction, or any workspace/journal access.
            let path = state_file(app.handle());
            match workspace::acquire_waiting(&path, std::time::Duration::from_secs(2)) {
                Ok(store) => { app.manage(store); }
                Err(e) => {
                    use tauri_plugin_dialog::DialogExt;
                    app.dialog().message(format!("Cannot open {} for writing. Another Loom may already own this workspace, or its directory is unavailable. No workspace files were changed.\n\n{e}", path.display()))
                        .title("Workspace unavailable").blocking_show();
                    // Not Err: Tauri panics on a setup error, and the release build
                    // aborts into a crash report for what is an ordinary refusal.
                    std::process::exit(1);
                }
            }
            let marks = [std::env::temp_dir().join("loom-status"), std::env::temp_dir().join("loom-tx"), data_dir(app.handle()).join("session-marks")];
            std::thread::spawn(move || prune_markers(&marks, std::time::Duration::from_secs(7 * 86_400)));
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
            let profile = webview_profile_dir(app.handle());
            app.manage(ProfileDir(profile.clone()));
            tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .data_directory(profile)
                .enable_clipboard_access()
                .build()?;
            // A drag or resize fires dozens of events a second: save once it has
            // been still for 500 ms. On the main thread, as before: the plugin's own
            // event handler takes the lock a save holds while it reads the window.
            let (moved, moves) = std::sync::mpsc::channel::<()>();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                while moves.recv().is_ok() {
                    while moves.recv_timeout(std::time::Duration::from_millis(500)).is_ok() {}
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let _ = app.save_window_state(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS);
                    });
                }
            });
            app.manage(WindowMoved(moved));
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<output::Bus>().run());
            control::serve(app.handle().clone(), pipe::pipe_name(profile_arg().as_deref()));
            control::serve(app.handle().clone(), pipe::instance_pipe());
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                // Copied out: file reads never hold the lock keystrokes wait on.
                let ids: Vec<String> = handle.state::<Ptys>().0.lock().unwrap().keys().cloned().collect();
                if !ids.is_empty() { send_wakes(&handle, &ids); send_task_events(&handle, &ids); }
            });
            app.state::<WindowStateReady>().0.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        })
        // ConPTY children are not reaped when the app exits — kill them explicitly.
        .on_window_event(|window, event| {
            if window.state::<WindowStateReady>().0.load(std::sync::atomic::Ordering::Relaxed) {
                match event {
                    // Persist while running too: stopping `tauri dev` need not send CloseRequested.
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => { let _ = window.state::<WindowMoved>().0.send(()); }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        let _ = window.app_handle().save_window_state(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS);
                    }
                    _ => {}
                }
            }
            // The frontend may cancel close if its final save fails. Only the
            // main window owns the terminals, and the overlay must not keep the
            // app running without it.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                let _ = awake::apply(false);
                pty_shutdown(window.state::<Ptys>(), window.state::<output::Flows>());
                if let Some(o) = window.app_handle().get_webview_window("overlay") {
                    let _ = o.destroy();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::canonical_directory,
            commands::pty_spawn, output_bus, control::cli_reply, control::cli_ready, pty_write, pty_ack, pty_acks, commands::pty_resize, commands::pty_kill, commands::pty_shutdown, load_state, commands::save_state, commands::open_vscode,
            commands::worktree_fingerprint, commands::worktree_remove, commands::git_run, commands::git_midway, commands::git_stdin, commands::list_files, commands::read_file, commands::read_image, take_sessions, commands::opencode_sessions, commands::codex_sessions, commands::has_codex_session, commands::session_usage, commands::codex_session_usage, usage::has_session, usage::pane_booted, commands::plan_usage, commands::codex_plan_usage,
            commands::model_options, commands::context_profile, commands::last_messages, overlay, awake::set_keep_awake,
            commands::task_journal_read, commands::task_journal_write,
            commands::dictate_start,
            commands::dictate_stop,
            dictate::dictate_level
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn diff_output_keeps_going_past_noisy_stderr() {
        use std::os::windows::process::CommandExt;
        // Git's autocrlf warnings, one per file: only shown on failure, never a reason to fail.
        let mut command = std::process::Command::new("cmd");
        command.args(["/d", "/c", "(for /l %i in (1,1,1000) do @echo warning: in the working copy of 'src/some/long/path/file.ts', LF will be replaced by CRLF 1>&2) & echo done"]).creation_flags(0x0800_0000);
        let out = super::diff_output(&mut command, 16).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "done");
        assert!(out.stderr.len() <= 64 * 1024);
    }
    #[test]
    fn only_previews_are_bounded() {
        let dir = std::env::temp_dir().join(format!("loom-git-bound-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str], preview| super::git_run(dir.to_string_lossy().into(), args.iter().map(|a| a.to_string()).collect(), None, preview);
        run(&["init", "-q"], false).unwrap();
        std::fs::write(dir.join("big.txt"), "a line of text\n".repeat(400_000)).unwrap();
        run(&["add", "big.txt"], false).unwrap();
        assert!(run(&["diff", "--cached"], false).unwrap().len() > 4 * 1024 * 1024, "the Changes panel's reads aren't previews");
        assert!(run(&["diff", "--cached"], true).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn diff_output_refuses_excess_bytes_before_ipc() {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        command.args(["/d", "/c", "echo 0123456789012345678901234567890123456789"]).creation_flags(0x0800_0000);
        assert!(super::diff_output(&mut command, 16).is_err());
    }
    #[test]
    fn journal_appends_start_after_a_torn_line() {
        let path = std::env::temp_dir().join(format!("loom-journal-torn-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        super::append_journal(&path, "{\"a\":1}\n").unwrap();
        std::fs::OpenOptions::new().append(true).open(&path).and_then(|mut f| std::io::Write::write_all(&mut f, b"{\"torn\":")).unwrap();
        super::append_journal(&path, "{\"notify\":false}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}\n{\"torn\":\n{\"notify\":false}\n");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn workspace_read_errors_preserve_the_original() {
        let dir = std::env::temp_dir().join(format!("loom-workspace-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(super::read_workspace(&dir).is_err());
        let path = dir.join("state.json");
        assert_eq!(super::read_workspace(&path).unwrap(), "{}");
        std::fs::write(&path, b"\xff").unwrap();
        assert!(super::read_workspace(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"\xff");
        std::fs::write(&path, "").unwrap();
        assert!(super::read_workspace(&path).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn workspace_saves_keep_the_snapshot_they_replace() {
        let dir = std::env::temp_dir().join(format!("loom-workspace-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let bak = dir.join("state.json.bak");
        super::write_workspace(&path, r#"{"n":1}"#).unwrap();
        super::write_workspace(&path, r#"{"n":2}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"n":2}"#);
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), r#"{"n":1}"#);
        assert!(!dir.join("state.json.pending").exists());
        // A power cut zero-filled it: refused, naming the copy.
        std::fs::write(&path, [0u8; 64]).unwrap();
        let err = super::read_workspace(&path).unwrap_err();
        assert!(err.contains("state.json.bak"), "{err}");
        std::fs::write(&path, "{\"threads\": [").unwrap();
        assert!(super::read_workspace(&path).unwrap_err().contains("state.json.bak"));
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), r#"{"n":1}"#);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stalled_resize_releases_registry_for_input_and_stop() {
        use super::*;
        use std::time::Duration;
        #[derive(Debug)]
        struct Killer;
        impl ChildKiller for Killer {
            fn kill(&mut self) -> std::io::Result<()> { Ok(()) }
            fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> { Box::new(Killer) }
        }
        let ptys = Arc::new(Ptys::default());
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let (input, inputs) = std::sync::mpsc::channel();
        ptys.0.lock().unwrap().insert("pane".into(), Session {
            master: Arc::new(Mutex::new(pair.master)), resizes: Arc::default(), _writer: Arc::new(Mutex::new(Box::new(std::io::sink()))),
            input, killer: Box::new(Killer), pid: None, launch: None, flow: Arc::default(), _cache_lease: None,
        });
        let (entered, entry) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel();
        let worker = ptys.clone();
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let applied = sizes.clone();
        let resize = std::thread::spawn(move || {
            let mut first = true;
            resize_pty(&worker, "pane", 90, 25, |_, size| {
                applied.lock().unwrap().push(size.cols);
                if first { first = false; entered.send(()).unwrap(); held.recv().unwrap(); }
                Ok(())
            })
        });
        entry.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done, completion) = std::sync::mpsc::channel();
        let worker = ptys.clone();
        let other = std::thread::spawn(move || {
            for cols in 100..200 {
                resize_pty(&worker, "pane", cols, 25, |_, _| Ok(())).unwrap();
            }
            let session = worker.0.lock().unwrap().remove("pane").unwrap();
            let (reply, _) = tauri::async_runtime::channel(1);
            session.input.send(("input".into(), reply)).unwrap();
            done.send(()).unwrap();
            session
        });
        let progressed = completion.recv_timeout(Duration::from_millis(500)).is_ok();
        release.send(()).unwrap();
        resize.join().unwrap().unwrap();
        drop(other.join().unwrap());
        assert!(progressed, "PTY input and stop must proceed while resize is stalled");
        assert_eq!(inputs.recv().unwrap().0, "input");
        assert_eq!(*sizes.lock().unwrap(), [90, 199], "only the latest pending size should be applied");
    }

    #[test]
    fn explicit_working_directories_must_exist_and_canonicalize() {
        let dir = std::env::temp_dir();
        let plain = super::canonical_directory(dir.to_string_lossy().into()).unwrap();
        assert_eq!(super::canonical_directory(dir.join(".").to_string_lossy().into()).unwrap(), plain);
        // The command loomctl new calls runs on the blocking pool, not the window's thread.
        assert_eq!(tauri::async_runtime::block_on(super::commands::canonical_directory(dir.to_string_lossy().into())).unwrap(), plain);
        let file = dir.join(format!("loom-cwd-test-{}.txt", std::process::id()));
        std::fs::write(&file, "test").unwrap();
        assert!(super::canonical_directory(file.to_string_lossy().into()).is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(super::canonical_directory(file.to_string_lossy().into()).is_err());
    }

    #[test]
    fn export_has_a_deadline_and_preserves_successful_output() {
        use std::time::{Duration, Instant};
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/d", "/c", "echo ready"]).creation_flags(0x0800_0000);
        assert_eq!(super::export_output(&mut command, Duration::from_secs(2)).unwrap(), b"ready\r\n");
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/d", "/c", "ping -n 20 127.0.0.1 >nul"]).creation_flags(0x0800_0000);
        let start = Instant::now();
        assert!(super::export_output(&mut command, Duration::from_millis(100)).is_none());
        assert!(start.elapsed() < Duration::from_secs(3));
    }
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

    /// A folder joined into sessions/ by a junction is walked like a real one.
    #[test]
    fn codex_rollouts_follow_junctions() {
        let root = std::env::temp_dir().join(format!("loom-junction-test-{}", std::process::id()));
        let (day, elsewhere, link) = (root.join("sessions").join("2026"), root.join("archive"), root.join("sessions").join("linked"));
        std::fs::create_dir_all(&day).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(day.join("rollout-a.jsonl"), "").unwrap();
        std::fs::write(elsewhere.join("rollout-b.jsonl"), "").unwrap();
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&elsewhere).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let mut found = Vec::new();
        super::codex_rollouts(&root.join("sessions"), &mut found);
        let mut names: Vec<_> = found.iter().map(|(_, p)| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["rollout-a.jsonl", "rollout-b.jsonl"]);
        std::fs::remove_dir(&link).unwrap(); // the junction, before anything could follow it
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn message_previews_preserve_whitespace_unicode_and_block_boundaries() {
        use serde_json::json;
        for (input, expected) in [
            (String::new(), String::new()),
            (" \t\r\n\u{2003}".into(), String::new()),
            (" \tHello\u{a0}世界\n🙂  ".into(), "Hello 世界 🙂".into()),
            ("é".repeat(500), "é".repeat(500)),
            (format!("{} \t\n", "é".repeat(500)), "é".repeat(500)),
            ("🙂".repeat(501), format!("{}…", "🙂".repeat(500))),
            (format!("{} x", "a".repeat(499)), format!("{} …", "a".repeat(499))),
            (format!("{} x", "a".repeat(500)), format!("{}…", "a".repeat(500))),
            ("x".repeat(8 * 1024 * 1024), format!("{}…", "x".repeat(500))),
        ] {
            for kind in ["text", "input_text", "output_text"] {
                assert_eq!(super::message_text(&json!(input), kind), expected);
                let blocks = json!([
                    {"type":"reasoning", "text":"ignored"},
                    {"type":kind, "text":" \t"},
                    {"type":kind, "text":input},
                    {"type":kind, "text":"\n"},
                    {"type":kind, "text":null},
                ]);
                assert_eq!(super::message_text(&blocks, kind), expected);
            }
        }
        for content in [json!(null), json!(42), json!({}), json!([])] {
            assert_eq!(super::message_text(&content, "text"), "");
        }
        for n in [0, 498, 499, 500, 501] {
            let blocks = json!([{"type":"text", "text":"a".repeat(n)}, {"type":"text", "text":" b "}]);
            let normalized = format!("{} b", "a".repeat(n)).trim().to_string();
            let mut expected: String = normalized.chars().take(500).collect();
            if normalized.chars().count() > 500 { expected.push('…'); }
            assert_eq!(super::message_text(&blocks, "text"), expected);
        }
    }

    #[test]
    #[ignore = "Manual message preview timing: run with --ignored --nocapture"]
    fn message_preview_benchmark() {
        for (label, content) in [
            ("long word", serde_json::json!("x".repeat(8 * 1024 * 1024))),
            ("many words", serde_json::json!("word ".repeat(1_600_000))),
            ("blocks", serde_json::json!([
                {"type":"text", "text":"word ".repeat(800_000)},
                {"type":"text", "text":"word ".repeat(800_000)},
            ])),
        ] {
            let mut samples = Vec::new();
            for _ in 0..11 {
                let start = std::time::Instant::now();
                let preview = super::message_text(std::hint::black_box(&content), "text");
                samples.push(start.elapsed());
                assert_eq!(preview.chars().count(), 501);
            }
            samples.sort();
            println!("{label}: median {:?}", samples[5]);
        }
    }

    #[test]
    fn dashboard_reads_latest_human_and_agent_messages() {
        let root = std::env::temp_dir().join(format!("loom-last-messages-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let claude = root.join("claude.jsonl");
        let records = [
            serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":"Earlier request"}]}}),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Earlier answer"}]}}),
            serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":"Check the final patch"}]}}),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"The patch is ready"}]}}),
            serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","content":"tool output"}]}}),
            serde_json::json!({"type":"user","isCompactSummary":true,"message":{"content":"Not a human prompt"}}),
            serde_json::json!({"type":"user","message":{"content":"<task-notification>Background task finished</task-notification>"}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"Subagent reply"}]}}),
            serde_json::json!({"type":"progress","data":"x".repeat(70_000)}),
        ];
        std::fs::write(&claude, records.iter().map(|v| format!("{v}\n")).collect::<String>()).unwrap();
        assert_eq!(super::recent_messages(&claude, "claude"), super::LastMessages {
            user: "Check the final patch".into(), agent: "The patch is ready".into(),
        });

        let codex = root.join("codex.jsonl");
        let records = [
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Previous answer"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"New request"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Working on it"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"Private reasoning"}]}}),
        ];
        std::fs::write(&codex, records.iter().map(|v| format!("{v}\n")).collect::<String>()).unwrap();
        let rollout = std::path::Path::new("rollout-2026-09-26T05-42-29-01a0dc05-98a2-70c1-abe8-e95fe172076e.jsonl");
        assert!(super::rollout_is(rollout, "01a0dc05-98a2-70c1-abe8-e95fe172076e"));
        assert!(super::rollout_is(rollout, "01a0dc05-98a2-70c1-abe8-e95fe"), "the title's cut id");
        assert!(!super::rollout_is(rollout, "01a0dc05-99dc-7242-b5fc-33105"), "a sibling thread");
        assert_eq!(super::recent_messages(&codex, "codex"), super::LastMessages {
            user: "New request".into(), agent: "Working on it".into(),
        });
        // A long turn's tool output: lines over 256 KiB skipped, and nothing past 8 MiB read.
        let big = |n: usize| format!("{}\n", serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","output":"x".repeat(n)}}));
        std::fs::write(&codex, format!("{}{}", std::fs::read_to_string(&codex).unwrap(), big(400_000))).unwrap();
        assert_eq!(super::recent_messages(&codex, "codex").agent, "Working on it");
        std::fs::write(&codex, format!("{}{}", std::fs::read_to_string(&codex).unwrap(), big(100_000).repeat(90))).unwrap();
        assert_eq!(super::recent_messages(&codex, "codex"), super::LastMessages::default(), "bounded at 8 MiB");

        let export = serde_json::json!({"messages":[
            {"info":{"role":"user"},"parts":[{"type":"text","text":"Review this"}]},
            {"info":{"role":"assistant"},"parts":[{"type":"reasoning","text":"Private"},{"type":"text","text":"Reviewed"}]},
            {"info":{"role":"assistant"},"parts":[{"type":"tool","text":"Not a reply"}]},
        ]});
        assert_eq!(super::opencode_export_messages(&export), super::LastMessages {
            user: "Review this".into(), agent: "Reviewed".into(),
        });
        let export = serde_json::json!({"messages":[
            {"type":"user","text":"Review v2"},
            {"type":"assistant","content":[{"type":"reasoning","text":"Private"},{"type":"text","text":"Reviewed v2"}]},
            {"type":"assistant","content":[{"type":"tool","content":"Tool output"}]},
            {"type":"synthetic","text":"Internal message"},
            {"type":"idle","outcome":"succeeded"},
        ]});
        assert_eq!(super::opencode_export_messages(&export), super::LastMessages {
            user: "Review v2".into(), agent: "Reviewed v2".into(),
        });
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_preview_preserves_limits_lossy_text_and_errors() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("loom-file-preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("preview.txt");
        let read = || super::read_file(dir.to_string_lossy().into_owned(), "preview.txt".into());
        assert!(read().is_err());
        for bytes in [b"".as_slice(), b"hello\r\n", &[0xff, b'a']] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(read().unwrap(), String::from_utf8_lossy(bytes));
        }
        let limit = 4 << 20;
        let text = "x".repeat(limit);
        std::fs::write(&path, &text).unwrap();
        assert_eq!(read().unwrap(), text);
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"!").unwrap();
        assert_eq!(read().unwrap(), format!("{text}\n… truncated at 4 MB"));
        // The byte limit may split a UTF-8 character; keep the existing replacement.
        let text = "x".repeat(limit - 1);
        std::fs::write(&path, format!("{text}€")).unwrap();
        assert_eq!(read().unwrap(), format!("{text}�\n… truncated at 4 MB"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_listing_skips_build_folders_and_follows_junctions() {
        let root = std::env::temp_dir().join(format!("loom-list-files-test-{}", std::process::id()));
        let tree = root.join("tree");
        let archive = root.join("archive");
        for dir in [&tree, &archive] { std::fs::create_dir_all(dir).unwrap(); }
        std::fs::write(tree.join("main.rs"), "").unwrap();
        std::fs::write(archive.join("target"), "").unwrap(); // a file with a skipped folder name
        for name in [".git", "node_modules", "target", ".build"] {
            let dir = tree.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("hidden.txt"), "").unwrap();
        }
        let link = tree.join("linked");
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
            .arg(&link).arg(&archive).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let mut files = super::list_files(tree.to_string_lossy().into_owned());
        files.sort();
        assert_eq!(files, ["linked/target", "main.rs"]);
        std::fs::remove_dir(&link).unwrap();
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
        // Harness summaries show only the basename, even for ignored artifacts.
        let shots = dir.join("node_modules").join(".cache").join("ui-check");
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::write(shots.join("workspace-1280.png"), image).unwrap();
        let response = super::read_image(root.clone(), "workspace-1280.png".into()).unwrap().body().unwrap();
        assert!(matches!(response, InvokeResponseBody::Raw(bytes) if bytes == image));
        assert!(super::read_image(root.clone(), "node_modules/.cache/ui-check/workspace-1280.png".into()).is_ok());
        // An explicit missing path must not silently open another artifact.
        assert!(super::read_image(root.clone(), "missing/workspace-1280.png".into()).is_err());
        assert!(super::read_image(root.clone(), dir.join("missing/workspace-1280.png").to_string_lossy().into()).is_err());
        let other = dir.join("output");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("workspace-1280.png"), image).unwrap();
        let third = shots.join("porcelain");
        std::fs::create_dir_all(&third).unwrap();
        std::fs::write(third.join("workspace-1280.png"), image).unwrap();
        let error = serde_json::to_value(super::read_image(root.clone(), "workspace-1280.png".into()).err().unwrap()).unwrap();
        let mut expected = vec![shots.join("workspace-1280.png"), other.join("workspace-1280.png"), third.join("workspace-1280.png")];
        expected.sort();
        assert_eq!(error["matches"], serde_json::json!(expected));
        for path in error["matches"].as_array().unwrap() {
            let response = super::read_image(root.clone(), path.as_str().unwrap().into()).unwrap().body().unwrap();
            assert!(matches!(response, InvokeResponseBody::Raw(bytes) if bytes == image));
        }
        // A real root-level file still wins over same-named nested files.
        std::fs::write(dir.join("workspace-1280.png"), image).unwrap();
        assert!(super::read_image(root.clone(), "workspace-1280.png".into()).is_ok());
        assert!(super::read_image(root.clone(), "missing.png".into()).is_err());
        assert!(super::read_image(root.clone(), "script.exe".into()).is_err());
        let large = std::fs::File::create(shots.join("large.png")).unwrap();
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
        let mine = ["abc".to_string(), "def".to_string()];
        assert!(drain_wakes(&dir, &mine).is_empty(), "missing folder is not an error");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abc"), "max\r\n").unwrap(); // Set-Content may add a newline
        std::fs::write(dir.join("def"), "").unwrap();
        std::fs::write(dir.join("other"), "").unwrap(); // Another Loom's pane

        let mut got = drain_wakes(&dir, &mine);
        got.sort();
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(got, vec![pair("abc", "max"), pair("def", "")]);
        assert!(drain_wakes(&dir, &mine).is_empty(), "markers must not fire twice");
        assert!(dir.join("other").exists(), "another Loom's marker is left for it");
        assert_eq!(drain_wakes(&dir, &["other".to_string()]), vec![pair("other", "")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_torn_journal_keeps_every_line_before_the_tear() {
        let dir = std::env::temp_dir().join(format!("loom-journal-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("w.tasks.jsonl");
        assert_eq!(super::read_task_journal(&path).unwrap(), "", "no journal yet: an empty one");
        // An append cut off after the first byte of "é" (C3 A9), as the follow-up review reproduced.
        let mut bytes = b"{\"seq\":2,\"pruned\":0}\n{\"task\":{\"id\":\"k1\",\"key\":\"review-torn\"}}\n{\"event\":{\"seq\":3,\"detail\":\"caf".to_vec();
        bytes.push(0xC3);
        std::fs::write(&path, &bytes).unwrap();
        let text = super::read_task_journal(&path).unwrap();
        assert!(text.contains("\"key\":\"review-torn\""), "the lines before the tear survive: {text}");
        assert!(text.ends_with("caf\u{fffd}"), "only the torn character is lost");
        // A folder where the file should be: an error, not an empty journal.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(super::read_task_journal(&path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn claude_reports_a_prompt_before_its_turn_can_end() {
        // UserPromptSubmit must hold the prompt until its report is written: run
        // async beside an async Stop, the Stop's file could land first and the
        // task would never see its turn end (LOOM_CLI_TASK_TRACKING review, P2).
        let hooks: serde_json::Value = serde_json::from_str(super::CLAUDE_HOOKS).unwrap();
        let hook = |event: &str| hooks["hooks"][event][0]["hooks"][0].clone();
        assert_eq!(hook("UserPromptSubmit")["async"], serde_json::Value::Null, "the prompt hook runs before the turn");
        assert!(hook("UserPromptSubmit")["command"].as_str().unwrap().ends_with("--claude-hook"));
        for event in ["Stop", "StopFailure"] {
            assert_eq!(hook(event)["async"], true, "{event} needn't hold Claude");
        }
    }

    #[test]
    fn task_events_come_once_in_order_and_whole() {
        use super::drain_task_events;
        let dir = std::env::temp_dir().join(format!("loom-task-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mine = ["p-1".to_string()];
        assert!(drain_task_events(&dir, &mine).is_empty(), "missing folder is not an error");
        std::fs::create_dir_all(&dir).unwrap();
        // Written out of order; the name's time puts them back.
        std::fs::write(dir.join("p-1.1700000000200.9.json"), r#"{"kind":"end"}"#).unwrap();
        std::fs::write(dir.join("p-1.1700000000100.9.json"), r#"{"kind":"start","match":"ab"}"#).unwrap();
        std::fs::write(dir.join("p-1.1700000000300.9.tmp"), r#"{"kind":"fai"#).unwrap(); // still being written
        std::fs::write(dir.join("p-1.1700000000050.9.json"), "not json").unwrap();
        std::fs::write(dir.join("q-2.1700000000100.9.json"), r#"{"kind":"end"}"#).unwrap(); // another Loom's pane
        let got = drain_task_events(&dir, &mine);
        let kinds: Vec<_> = got.iter().map(|(id, v)| (id.as_str(), v["kind"].as_str().unwrap_or(""))).collect();
        assert_eq!(kinds, [("p-1", "start"), ("p-1", "end")]);
        assert!(drain_task_events(&dir, &mine).is_empty(), "events must not come twice");
        assert!(dir.join("q-2.1700000000100.9.json").exists(), "another Loom's event is left for it");
        assert!(dir.join("p-1.1700000000300.9.tmp").exists(), "a half-written event waits for its rename");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_drainers_take_each_event_once() {
        let dir = std::env::temp_dir().join(format!("loom-task-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mine = ["p-1".to_string()];
        for i in 0..400u64 { std::fs::write(dir.join(format!("p-1.{}.9.json", 1_700_000_000_000 + i)), r#"{"kind":"end"}"#).unwrap(); }
        // The 250 ms poll and a pane's exit thread, at once.
        let (a, b) = std::thread::scope(|s| {
            let (a, b) = (s.spawn(|| super::drain_task_events(&dir, &mine).len()), s.spawn(|| super::drain_task_events(&dir, &mine).len()));
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_eq!(a + b, 400, "{a} + {b}");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_markers_are_pruned() {
        let dir = std::env::temp_dir().join(format!("loom-marks-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (old, new) = (dir.join("gone-pane"), dir.join("live-pane"));
        std::fs::write(&old, "x").unwrap();
        std::fs::write(&new, "x").unwrap();
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86_400)).unwrap();
        super::prune_markers(&[dir.clone(), dir.join("missing")], std::time::Duration::from_secs(7 * 86_400));
        assert!(!old.exists() && new.exists());
        std::fs::remove_dir_all(dir).unwrap();
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
