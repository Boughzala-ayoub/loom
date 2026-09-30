//! loomctl talks to a running Loom over a named pipe (pipe.rs): one JSON
//! request per connection, one JSON answer. The commands run in the page,
//! where the threads and panes live, through the functions the buttons call,
//! so whatever a command does shows in the window. This side only carries
//! requests there and answers back.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::oneshot;

/// Requests the page hasn't answered yet, by id.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// Set once the page has its handler: until then a request waits for it.
    ready: AtomicBool,
}

/// Serves `name` for the app's life. A second Loom on the same workspace
/// can't take the name (first_pipe_instance), so a command never reaches the
/// wrong one: that Loom answers only on its own process pipe (pipe.rs).
pub fn serve(app: AppHandle, name: String) {
    tauri::async_runtime::spawn(async move {
        let security = match owner_only() {
            Ok(s) => s,
            Err(e) => return eprintln!("control pipe: {e}"),
        };
        let mut first = true;
        loop {
            let server = match create(&name, first, security) {
                Ok(s) => s,
                Err(e) if first => return eprintln!("control pipe {name} is taken, likely by another Loom on this workspace: {e}"),
                Err(e) => return eprintln!("control pipe {name}: {e}"),
            };
            first = false;
            if server.connect().await.is_err() {
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = answer(app, server).await;
            });
        }
    });
}

fn create(name: &str, first: bool, security: usize) -> std::io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.first_pipe_instance(first).reject_remote_clients(true);
    // SAFETY: `security` is a SECURITY_ATTRIBUTES leaked by owner_only, alive for the app's life.
    unsafe { options.create_with_security_attributes_raw(name, security as *mut core::ffi::c_void) }
}

/// A pipe only this Windows account (and the system) can open. The default
/// descriptor also lets everyone read.
fn owner_only() -> Result<usize, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| e.to_string())?;
        let mut len = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let got = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        got.map_err(|e| e.to_string())?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(|e| e.to_string())?;
        let sddl = format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", sid.to_string().unwrap_or_default());
        let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
        let wide: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(wide.as_ptr()), SDDL_REVISION_1, &mut descriptor, None)
            .map_err(|e| e.to_string())?;
        let attributes = Box::new(SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        });
        Ok(Box::into_raw(attributes) as usize)
    }
}

async fn answer(app: AppHandle, pipe: NamedPipeServer) -> std::io::Result<()> {
    let (read, mut write) = tokio::io::split(pipe);
    let mut line = String::new();
    BufReader::new(read.take(1 << 20)).read_line(&mut line).await?;
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(request) => ask(&app, request).await,
        Err(e) => json!({ "ok": false, "error": format!("loomctl sent a request Loom can't read: {e}") }),
    };
    write.write_all(format!("{reply}\n").as_bytes()).await?;
    write.flush().await
}

/// Hands a request to the page and waits for its answer: the request's own
/// timeout (`wait` asks for long ones), plus a margin for the page's reply.
async fn ask(app: &AppHandle, request: Value) -> Value {
    let pending = app.state::<Pending>();
    for _ in 0..200 {
        if pending.ready.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !pending.ready.load(Ordering::Acquire) {
        return json!({ "ok": false, "error": "Loom is still starting. Try again in a moment." });
    }
    let id = pending.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending.waiting.lock().unwrap().insert(id, tx);
    let secs = request["timeout"].as_f64().unwrap_or(30.0).clamp(1.0, 86_400.0);
    // The words go to the page unparsed: only it knows which options each command takes.
    let event = json!({ "id": id, "cmd": request["cmd"], "argv": request["argv"], "cwd": request["cwd"], "timeout": secs });
    if let Err(e) = app.emit("cli", event) {
        pending.waiting.lock().unwrap().remove(&id);
        return json!({ "ok": false, "error": format!("Loom couldn't pass the command to its window: {e}") });
    }
    match tokio::time::timeout(Duration::from_secs_f64(secs + 5.0), rx).await {
        Ok(Ok(reply)) => reply,
        _ => {
            pending.waiting.lock().unwrap().remove(&id);
            json!({ "ok": false, "timeout": true, "error": format!("Loom didn't answer within {secs} s.") })
        }
    }
}

/// The page's answer to request `id`: `{ ok, data?, text?, error? }`.
#[tauri::command]
pub fn cli_reply(pending: State<Pending>, id: u64, reply: Value) {
    if let Some(tx) = pending.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send(reply);
    }
}

/// The page is listening: requests stop waiting for it.
#[tauri::command]
pub fn cli_ready(pending: State<Pending>) {
    pending.ready.store(true, Ordering::Release);
}
