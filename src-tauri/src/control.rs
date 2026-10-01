//! loomctl talks to a running Loom over a named pipe (pipe.rs): one JSON
//! request per connection, one JSON answer. The commands run in the page,
//! where the threads and panes live, through the functions the buttons call,
//! so whatever a command does shows in the window. This side only carries
//! requests there and answers back.
use crate::pipe::PROTOCOL;
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

/// loomctl says hello with its protocol first and gets this Loom's back; only
/// then does it send the command. A loomctl too old to say hello, or on
/// another protocol, is refused before anything runs. `loomctl info` stops
/// after the hello.
async fn answer(app: AppHandle, pipe: NamedPipeServer) -> std::io::Result<()> {
    let (read, mut write) = tokio::io::split(pipe);
    let mut read = BufReader::new(read.take(1 << 20));
    let mut line = String::new();
    read.read_line(&mut line).await?;
    let theirs = serde_json::from_str::<Value>(&line).ok().and_then(|v| v["hello"].as_u64()).unwrap_or(1);
    let hello = if theirs == PROTOCOL {
        json!({ "ok": true, "protocol": PROTOCOL, "version": app.package_info().version.to_string(), "pid": std::process::id(), "pipe": crate::pipe::instance_pipe() })
    } else {
        let error = if theirs < PROTOCOL {
            "This loomctl is older than the running Loom. Use the loomctl.exe installed beside loom.exe."
        } else {
            "The running Loom is older than this loomctl. Restart Loom to finish the update."
        };
        json!({ "ok": false, "protocol": PROTOCOL, "error": error })
    };
    write.write_all(format!("{hello}\n").as_bytes()).await?;
    write.flush().await?;
    if theirs != PROTOCOL {
        return Ok(());
    }
    line.clear();
    if read.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let reply = match request(&line) {
        Ok(request) => ask(&app, request).await,
        Err(error) => json!({ "ok": false, "error": error }),
    };
    write.write_all(format!("{reply}\n").as_bytes()).await?;
    write.flush().await
}

/// The command in loomctl's request line, if it is one to run: whole, JSON, a
/// command and a list of words. Whole means it ends in its newline. read_line
/// also hands back what came before a dropped connection or the size limit,
/// and that can be valid JSON, so without the newline loomctl can't tell
/// whether a failed send ran.
fn request(line: &str) -> Result<Value, String> {
    if !line.ends_with('\n') {
        return Err("loomctl's request was cut off, so it didn't run.".into());
    }
    let request: Value = serde_json::from_str(line).map_err(|e| format!("loomctl sent a request Loom can't read: {e}"))?;
    match request["cmd"].is_string() && request["argv"].as_array().is_some_and(|a| a.iter().all(Value::is_string)) {
        true => Ok(request),
        false => Err("loomctl sent a request without a command and its words.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::request;

    #[test]
    fn only_a_whole_request_line_runs() {
        let close = r#"{"cmd":"close","argv":["p1","--yes"],"stdin":null,"cwd":"C:\\","timeout":30}"#;
        assert!(request(&format!("{close}\n")).is_ok());
        // Valid JSON cut off before its newline, as read_line returns it at EOF or the size limit.
        assert!(request(close).unwrap_err().contains("cut off"));
        assert!(request(&close[..close.len() / 2]).is_err());
        assert!(request("{\"cmd\":\"close\",\"args\":{}}\n").unwrap_err().contains("without a command"));
    }
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
    // The words go to the page unparsed: only it knows which options each
    // command takes. Standard input comes apart from them, so text starting
    // with -- is never read as an option.
    let event = json!({ "id": id, "cmd": request["cmd"], "argv": request["argv"], "stdin": request["stdin"], "cwd": request["cwd"], "timeout": secs });
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
