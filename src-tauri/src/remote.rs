//! The phone remote (docs/phone-remote-study.md): a small HTTP server that
//! serves the phone page (remote.html) and runs loomctl commands for it
//! through control::ask, so a phone can do whatever loomctl can. It listens
//! on 127.0.0.1 only: `tailscale serve` carries it to your own devices over
//! HTTPS. A phone needs a token, which it gets once for the six-digit code
//! `loomctl remote pair` shows. A phone can also sign up for Loom's task
//! notices as Web Push notifications (docs/phone-notifications-study.md):
//! this keeps the subscriptions and posts what push.ts encrypts and signs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A debug build has its own port, so `tauri dev` leaves the installed Loom's alone.
const PORT: u16 = if cfg!(debug_assertions) { 7421 } else { 7420 };
/// A request's line and headers, and its body: a prompt, never a file.
const HEAD: usize = 16 << 10;
const BODY: usize = 1 << 20;
/// How long a client may take to send its request, or to take the answer.
const FRAME: Duration = Duration::from_secs(10);
/// A pairing code lasts this long, or until this many wrong guesses.
const PAIRING: Duration = Duration::from_secs(600);
const GUESSES: u8 = 5;
/// Connections served at once; past it a new one is closed unanswered.
const MAX_ACTIVE: usize = 32;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
const CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MANIFEST: &str = r##"{"name":"Loom","short_name":"Loom","start_url":"/","display":"standalone","background_color":"#111111","theme_color":"#111111","icons":[{"src":"/icon.svg","sizes":"any","type":"image/svg+xml"},{"src":"/icon.png","sizes":"512x512","type":"image/png"}]}"##;
const ICON: &[u8] = include_bytes!("../../src/logo.svg");
/// Android draws notification icons from PNGs only, and the status bar's
/// badge from its alpha alone: the logo's chevron and cursor, white.
const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");
const BADGE_PNG: &[u8] = include_bytes!("../icons/badge.png");
/// The service worker that shows Loom's pushes and opens the agent on a tap.
const WORKER: &str = include_str!("remote-sw.js");

/// `<workspace>.remote.json`, beside the workspace file, so each profile has its own.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    on: bool,
    port: Option<u16>,
    /// SHA-256 of each paired phone's token: the file alone lets nobody in.
    phones: Vec<String>,
    /// Loom's Web Push key, made once by its window (push.ts): `public`, the
    /// key phones subscribe with, and `private`, a JWK that only signs pushes.
    #[serde(default)]
    vapid: Option<Value>,
    /// Each phone's push subscription, by its token's hash: unpairing drops it.
    #[serde(default)]
    pushes: Vec<Push>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Push {
    phone: String,
    endpoint: String,
    p256dh: String,
    auth: String,
}

struct Pairing {
    code: String,
    until: Instant,
    wrong: u8,
}

#[derive(Default)]
pub struct Remote {
    config: Mutex<Config>,
    server: Mutex<Option<JoinHandle<()>>>,
    pairing: Mutex<Option<Pairing>>,
    /// Why the server isn't listening although it is on.
    error: Mutex<Option<String>>,
}

fn config_path(app: &AppHandle) -> PathBuf {
    crate::state_file(app).with_extension("remote.json")
}

/// Loads the settings and, if the remote is on, starts listening.
pub fn start(app: &AppHandle) {
    let config: Config = std::fs::read(config_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let (on, port) = (config.on, config.port.unwrap_or(PORT));
    *app.state::<Remote>().config.lock().unwrap() = config;
    if on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { let _ = listen(&app, port).await; });
    }
}

/// `loomctl remote`: status, on, off, pair and revoke.
#[tauri::command]
pub async fn remote(app: AppHandle, action: String, port: Option<u16>) -> Result<Value, String> {
    let remote = app.state::<Remote>();
    match action.as_str() {
        "status" => {}
        "on" => {
            let port = port.or(remote.config.lock().unwrap().port).unwrap_or(PORT);
            listen(&app, port).await?;
            update(&app, |c| { c.on = true; c.port = Some(port); })?;
        }
        "off" => {
            stop(&app).await;
            *remote.pairing.lock().unwrap() = None;
            update(&app, |c| c.on = false)?;
        }
        "pair" => {
            if remote.server.lock().unwrap().is_none() {
                return Err("The remote is off. Turn it on first: loomctl remote on".into());
            }
            let code = format!("{:06}", u32::from_le_bytes(random::<4>()) % 1_000_000);
            *remote.pairing.lock().unwrap() = Some(Pairing { code, until: Instant::now() + PAIRING, wrong: 0 });
        }
        "revoke" => {
            *remote.pairing.lock().unwrap() = None;
            update(&app, |c| { c.phones.clear(); c.pushes.clear(); })?;
        }
        _ => return Err(format!("remote takes on, off, pair or revoke, not {action}.")),
    }
    Ok(status(&app).await)
}

async fn status(app: &AppHandle) -> Value {
    let remote = app.state::<Remote>();
    let (on, port, phones, pushes) = {
        let c = remote.config.lock().unwrap();
        (c.on, c.port.unwrap_or(PORT), c.phones.len(), c.pushes.len())
    };
    let listening = remote.server.lock().unwrap().is_some();
    let pairing = remote.pairing.lock().unwrap().as_ref().filter(|p| p.until > Instant::now()).map(|p| p.code.clone());
    let error = remote.error.lock().unwrap().clone();
    let name = tauri::async_runtime::spawn_blocking(tailnet_name).await.ok().flatten();
    json!({ "on": on, "listening": listening, "port": port, "phones": phones, "pushes": pushes, "pairing": pairing, "error": error, "address": name.map(|n| format!("https://{n}")) })
}

/// This PC's name on your tailnet, if Tailscale is installed and signed in.
fn tailnet_name() -> Option<String> {
    use std::os::windows::process::CommandExt;
    // Installed after Loom started, Tailscale isn't on Loom's PATH yet.
    ["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"].iter().find_map(|exe| {
        let out = std::process::Command::new(exe).args(["status", "--json"]).creation_flags(0x0800_0000).output().ok()?; // CREATE_NO_WINDOW
        let v: Value = serde_json::from_slice(&out.stdout).ok()?;
        v["Self"]["DNSName"].as_str().map(|n| n.trim_end_matches('.').to_string()).filter(|n| !n.is_empty())
    })
}

/// Saves a change to the settings; on a failed write nothing changes.
fn update(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    let remote = app.state::<Remote>();
    let mut config = remote.config.lock().unwrap();
    let mut next = config.clone();
    change(&mut next);
    let path = config_path(app);
    let tmp = path.with_extension("remote.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&next).unwrap())
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("Loom couldn't save {}: {e}", path.display()))?;
    *config = next;
    Ok(())
}

async fn listen(app: &AppHandle, port: u16) -> Result<(), String> {
    stop(app).await;
    let remote = app.state::<Remote>();
    let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
        let error = format!("Loom can't listen on 127.0.0.1:{port}: {e}. Pick another port: loomctl remote on --port N");
        *remote.error.lock().unwrap() = Some(error.clone());
        error
    })?;
    *remote.error.lock().unwrap() = None;
    *remote.server.lock().unwrap() = Some(tauri::async_runtime::spawn(accept(app.clone(), listener)));
    Ok(())
}

/// Stops listening, and waits for the port to be let go so `on` can take it again.
async fn stop(app: &AppHandle) {
    let server = app.state::<Remote>().server.lock().unwrap().take();
    if let Some(server) = server {
        server.abort();
        let _ = server.await;
    }
}

async fn accept(app: AppHandle, listener: TcpListener) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            // ponytail: a fixed 1 s back-off, as control.rs's pipe: a failure here is transient.
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if ACTIVE.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE {
            ACTIVE.fetch_sub(1, Ordering::AcqRel);
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = serve(&app, stream).await;
            ACTIVE.fetch_sub(1, Ordering::AcqRel);
        });
    }
}

/// One request per connection, then the connection closes.
async fn serve(app: &AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    let request = crate::control::within(FRAME, read(&mut stream)).await?;
    let gzip = request.as_ref().is_ok_and(|r| r.header("accept-encoding").is_some_and(|v| v.contains("gzip")));
    let reply = match request {
        Ok(request) => match crate::control::unless_gone(&mut stream, route(app, &request)).await {
            Some(reply) => reply,
            None => return Ok(()),
        },
        Err(reply) => reply,
    };
    crate::control::within(FRAME, async {
        stream.write_all(&reply.into_bytes(gzip)).await?;
        stream.shutdown().await
    }).await
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// An HTTP/1.1 request with a Content-Length body, or the reply that refuses it.
async fn read(stream: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Result<Request, Reply>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > HEAD {
            return Ok(Err(Reply::error(431, "The request's headers are too long.")));
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let Ok(head) = std::str::from_utf8(&buf[..end]) else { return Ok(Err(Reply::error(400, "The request isn't text."))) };
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let mut request = Request { method, path, headers, body: buf[end + 4..].to_vec() };
    if request.header("transfer-encoding").is_some() {
        return Ok(Err(Reply::error(411, "Send the body with a Content-Length.")));
    }
    let Ok(length) = request.header("content-length").unwrap_or("0").parse::<usize>() else { return Ok(Err(Reply::error(400, "Bad Content-Length."))) };
    if length > BODY {
        return Ok(Err(Reply::error(413, "The request is too large.")));
    }
    while request.body.len() < length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        request.body.extend_from_slice(&chunk[..n]);
    }
    request.body.truncate(length);
    Ok(Ok(request))
}

async fn route(app: &AppHandle, request: &Request) -> Reply {
    let path = request.path.split('?').next().unwrap_or("");
    match (request.method.as_str(), path) {
        ("GET", "/") => asset(app, "remote.html"),
        ("GET", "/manifest.webmanifest") => Reply::new(200, "application/manifest+json", MANIFEST.into()),
        ("GET", "/icon.svg") => Reply::new(200, "image/svg+xml", ICON.into()),
        ("GET", "/icon.png") => Reply::new(200, "image/png", ICON_PNG.into()),
        ("GET", "/badge.png") => Reply::new(200, "image/png", BADGE_PNG.into()),
        ("GET", "/sw.js") => Reply::new(200, "text/javascript", WORKER.into()),
        ("GET", p) if p.starts_with("/assets/") => asset(app, &p[1..]).cached(),
        ("POST", "/api/pair") => pair(app, request),
        ("POST", "/api/cli") => cli(app, request).await,
        ("POST", "/api/push") => push(app, request),
        _ => Reply::error(404, "Not found."),
    }
}

/// The page and its scripts from the bundle in loom.exe. Only `remote.html`
/// and plain names under `assets/`: Tauri answers a name it lacks with
/// index.html, the desktop page.
fn asset(app: &AppHandle, path: &str) -> Reply {
    let plain = |f: &str| !f.is_empty() && !f.starts_with('.') && f.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if path != "remote.html" && !path.strip_prefix("assets/").is_some_and(plain) {
        return Reply::error(404, "Not found.");
    }
    if let Some(a) = app.asset_resolver().get(path.into()) {
        if path.ends_with(".html") || a.mime_type() != "text/html" {
            return Reply::new(200, a.mime_type(), a.bytes().to_vec());
        }
        return Reply::error(404, "Not found.");
    }
    // A dev build embeds no bundle: it serves what `npm run build` left in dist.
    if cfg!(debug_assertions) {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist").join(path);
        if let Ok(bytes) = std::fs::read(file) {
            let kind = match path.rsplit('.').next() {
                Some("html") => "text/html",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };
            return Reply::new(200, kind, bytes);
        }
    }
    Reply::error(404, "Not found. Build the frontend: npm run build")
}

fn pair(app: &AppHandle, request: &Request) -> Reply {
    let code = serde_json::from_slice::<Value>(&request.body).ok().and_then(|v| v["code"].as_str().map(|c| c.trim().to_string())).unwrap_or_default();
    if let Err(error) = guess(&mut app.state::<Remote>().pairing.lock().unwrap(), &code, Instant::now()) {
        return Reply::error(403, error);
    }
    let token: String = random::<32>().iter().map(|b| format!("{b:02x}")).collect();
    match update(app, |c| c.phones.push(hash(&token))) {
        Ok(()) => Reply::json(200, json!({ "ok": true, "token": token })),
        Err(error) => Reply::error(500, &error),
    }
}

/// Checks a pairing code: a right one is used up, and so is one guessed wrong too often.
fn guess(pairing: &mut Option<Pairing>, code: &str, now: Instant) -> Result<(), &'static str> {
    let Some(open) = pairing.as_mut().filter(|p| p.until > now) else {
        *pairing = None;
        return Err("No pairing code is open. On the PC, run: loomctl remote pair");
    };
    if open.code == code {
        *pairing = None;
        return Ok(());
    }
    open.wrong += 1;
    if open.wrong >= GUESSES {
        *pairing = None;
        return Err("Wrong code too many times, so it no longer works. On the PC, run loomctl remote pair again.");
    }
    Err("Wrong code.")
}

/// The paired phone a request comes from: its token's hash.
fn phone(app: &AppHandle, request: &Request) -> Option<String> {
    let token = request.header("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("").trim();
    let id = hash(token);
    (!token.is_empty() && app.state::<Remote>().config.lock().unwrap().phones.contains(&id)).then_some(id)
}

fn unpaired() -> Reply {
    Reply::json(401, json!({ "ok": false, "unpaired": true, "error": "This phone isn't paired, or its pairing was revoked." }))
}

/// A phone's notifications: `{}` asks for Loom's key and whether this phone
/// gets them, `{"subscription": …}` (the browser's PushSubscription.toJSON())
/// signs it up, replacing its last one, and `{"off": true}` stops them.
fn push(app: &AppHandle, request: &Request) -> Reply {
    let Some(phone) = phone(app, request) else { return unpaired() };
    let Ok(body) = serde_json::from_slice::<Value>(&request.body) else { return Reply::error(400, "The body isn't JSON.") };
    let next = if body["off"] == true {
        Some(None)
    } else if body["subscription"].is_object() {
        let Some(sub) = subscription(&phone, &body["subscription"]) else { return Reply::error(400, "That isn't a push subscription.") };
        Some(Some(sub))
    } else {
        None
    };
    if let Some(next) = next {
        let saved = update(app, |c| {
            c.pushes.retain(|p| p.phone != phone && next.as_ref().map_or(true, |n| n.endpoint != p.endpoint));
            c.pushes.extend(next);
        });
        if let Err(error) = saved {
            return Reply::error(500, &error);
        }
    }
    let remote = app.state::<Remote>();
    let c = remote.config.lock().unwrap();
    Reply::json(200, json!({ "ok": true, "key": c.vapid.as_ref().and_then(|k| k["public"].as_str()), "on": c.pushes.iter().any(|p| p.phone == phone) }))
}

/// A browser's subscription, checked: where to post, and its two keys in base64url.
fn subscription(phone: &str, v: &Value) -> Option<Push> {
    let endpoint = v["endpoint"].as_str().filter(|e| (e.starts_with("https://") || e.starts_with("http://")) && e.len() <= 2048 && !e.chars().any(char::is_control))?;
    let key = |name: &str, len: std::ops::RangeInclusive<usize>| {
        v["keys"][name].as_str().filter(|k| len.contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_=".contains(&b))).map(String::from)
    };
    Some(Push { phone: phone.into(), endpoint: endpoint.into(), p256dh: key("p256dh", 86..=88)?, auth: key("auth", 22..=24)? })
}

/// For push.ts: Loom's key, or null before its window made one, and every subscription.
#[tauri::command]
pub fn push_targets(app: AppHandle) -> Value {
    let remote = app.state::<Remote>();
    let c = remote.config.lock().unwrap();
    let subs: Vec<Value> = c.pushes.iter().map(|p| json!({ "endpoint": p.endpoint, "p256dh": p.p256dh, "auth": p.auth })).collect();
    json!({ "key": c.vapid, "subs": subs })
}

/// Keeps the key Loom's window made, unless one is kept already: the kept one answers.
#[tauri::command]
pub fn push_key(app: AppHandle, key: Value) -> Result<Value, String> {
    if !key["public"].is_string() || !key["private"].is_object() {
        return Err("That isn't a push key.".into());
    }
    if app.state::<Remote>().config.lock().unwrap().vapid.is_none() {
        update(&app, |c| { c.vapid.get_or_insert(key); })?;
    }
    Ok(app.state::<Remote>().config.lock().unwrap().vapid.clone().unwrap_or_default())
}

/// A subscription its push service no longer knows (404 or 410).
#[tauri::command]
pub fn push_forget(app: AppHandle, endpoint: String) -> Result<(), String> {
    update(&app, |c| c.pushes.retain(|p| p.endpoint != endpoint))
}

/// Posts one push that push.ts built; answers the push service's status.
#[tauri::command]
pub async fn push_post(endpoint: String, headers: Vec<(String, String)>, body: Vec<u8>) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || post(&endpoint, &headers, &body)).await.map_err(|e| e.to_string())?
}

/// Through Windows' curl.exe, as usage.rs does: Loom's Rust has no TLS. The
/// headers and the address go in a config on stdin and the body in a temp
/// file, so none of them shows on a command line.
fn post(endpoint: &str, headers: &[(String, String)], body: &[u8]) -> Result<u16, String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) || headers.iter().any(|(k, v)| k.chars().chain(v.chars()).any(char::is_control)) {
        return Err("That isn't a push request.".into());
    }
    let file = std::env::temp_dir().join(format!("loom-push-{}.bin", random::<8>().iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::write(&file, body).map_err(|e| format!("Loom couldn't stage the push: {e}"))?;
    let quote = |s: &str| serde_json::to_string(s).unwrap();
    let mut config: String = headers.iter().map(|(k, v)| format!("header = {}\n", quote(&format!("{k}: {v}")))).collect();
    config += &format!("url = {}\ndata-binary = {}\n", quote(endpoint), quote(&format!("@{}", file.display())));
    let curl = std::env::var("SystemRoot").map(|r| format!("{r}\\System32\\curl.exe")).unwrap_or_else(|_| "curl.exe".into());
    let out = Command::new(curl)
        .args(["-q", "-sS", "-m", "20", "-o", "NUL", "-w", "%{http_code}", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no console flash
        .spawn()
        .and_then(|mut child| {
            child.stdin.take().expect("piped").write_all(config.as_bytes())?;
            child.wait_with_output()
        });
    let _ = std::fs::remove_file(&file);
    let out = out.map_err(|e| format!("curl: {e}"))?;
    match String::from_utf8_lossy(&out.stdout).trim().parse::<u16>() {
        Ok(status) if status > 0 => Ok(status),
        _ => Err(format!("The push didn't reach its push service (curl exit {}).", out.status.code().unwrap_or(-1))),
    }
}

async fn cli(app: &AppHandle, request: &Request) -> Reply {
    if phone(app, request).is_none() {
        return unpaired();
    }
    let Ok(mut command) = serde_json::from_slice::<Value>(&request.body) else { return Reply::error(400, "The body isn't JSON.") };
    let words = command["argv"].as_array().is_some_and(|a| a.iter().all(Value::is_string));
    let optional = |v: &Value| v.is_null() || v.is_string();
    if !command["cmd"].is_string() || !words || !optional(&command["stdin"]) || !optional(&command["key"]) {
        return Reply::error(400, "Send a command, its words, and optionally stdin and a key.");
    }
    // A folder on the phone means nothing on the PC: paths it sends are whole.
    command["cwd"] = Value::Null;
    Reply::json(200, crate::control::ask(app, command).await)
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("Windows has no random numbers");
    bytes
}

struct Reply {
    status: u16,
    kind: String,
    body: Vec<u8>,
    cached: bool,
}

impl Reply {
    fn new(status: u16, kind: &str, body: Vec<u8>) -> Self {
        Reply { status, kind: kind.into(), body, cached: false }
    }

    fn json(status: u16, body: Value) -> Self {
        Self::new(status, "application/json", body.to_string().into_bytes())
    }

    fn error(status: u16, error: &str) -> Self {
        Self::json(status, json!({ "ok": false, "error": error }))
    }

    /// Bundle files carry a hash in their names, so the phone may keep them.
    fn cached(mut self) -> Self {
        self.cached = self.status == 200;
        self
    }

    fn into_bytes(self, gzip: bool) -> Vec<u8> {
        use std::io::Write;
        let text = self.kind.starts_with("text/") || self.kind.contains("json") || self.kind.contains("javascript") || self.kind.contains("svg");
        let squeeze = gzip && text && self.body.len() > 1024;
        let body = if squeeze {
            let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            z.write_all(&self.body).and_then(|_| z.finish()).unwrap_or(self.body)
        } else {
            self.body
        };
        let reason = match self.status {
            200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found",
            411 => "Length Required", 413 => "Payload Too Large", 431 => "Request Header Fields Too Large", _ => "Internal Server Error",
        };
        let cache = if self.cached { "public, max-age=31536000, immutable" } else { "no-store" };
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {CSP}\r\n",
            self.status, self.kind, body.len()
        );
        if squeeze {
            head.push_str("Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n");
        }
        head.push_str("\r\n");
        [head.into_bytes(), body].concat()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &[u8]) -> std::io::Result<Result<Request, Reply>> {
        tauri::async_runtime::block_on(read(&mut &raw[..]))
    }

    #[test]
    fn a_request_is_read_whole_and_only_whole() {
        let r = parse(b"POST /api/cli?x HTTP/1.1\r\nHost: a\r\nauthorization: Bearer t\r\nContent-Length: 5\r\n\r\nhello").unwrap().ok().unwrap();
        assert_eq!((r.method.as_str(), r.path.as_str(), r.body.as_slice()), ("POST", "/api/cli?x", &b"hello"[..]));
        assert_eq!(r.header("Authorization"), Some("Bearer t"));
        // A body cut short is no request: nothing runs.
        assert!(parse(b"POST / HTTP/1.1\r\nContent-Length: 9\r\n\r\nhello").is_err());
        assert_eq!(parse(b"POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n").unwrap().err().unwrap().status, 413);
        assert_eq!(parse(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap().err().unwrap().status, 411);
        let long = [b"GET / HTTP/1.1\r\nX: ".as_slice(), &[b'a'; HEAD + 10]].concat();
        assert_eq!(parse(&long).unwrap().err().unwrap().status, 431);
    }

    #[test]
    fn a_pairing_code_works_once_and_not_after_too_many_guesses() {
        let now = Instant::now();
        let open = |code: &str| Some(Pairing { code: code.into(), until: now + PAIRING, wrong: 0 });
        let mut p = open("123456");
        assert!(guess(&mut p, "123456", now).is_ok());
        assert!(guess(&mut p, "123456", now).is_err(), "a used code must not pair a second phone");
        let mut p = open("123456");
        for _ in 0..GUESSES {
            assert!(guess(&mut p, "000000", now).is_err());
        }
        assert!(guess(&mut p, "123456", now).is_err(), "the right code after too many wrong ones");
        let mut p = open("123456");
        assert!(guess(&mut p, "123456", now + PAIRING).is_err(), "an expired code");
        assert!(guess(&mut None, "", now).is_err());
    }

    #[test]
    fn a_subscription_needs_an_address_and_both_keys() {
        let good = json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": { "p256dh": "B".repeat(87), "auth": "a".repeat(22) } });
        let sub = subscription("phone", &good).unwrap();
        assert_eq!((sub.phone.as_str(), sub.endpoint.as_str(), sub.p256dh.len(), sub.auth.len()), ("phone", "https://fcm.googleapis.com/fcm/send/abc", 87, 22));
        for bad in [
            json!({ "endpoint": "file:///C:/x", "keys": good["keys"] }),
            json!({ "endpoint": "https://a/\r\nx", "keys": good["keys"] }),
            json!({ "endpoint": good["endpoint"], "keys": { "p256dh": "B".repeat(87) } }),
            json!({ "endpoint": good["endpoint"], "keys": { "p256dh": "B+/".repeat(29), "auth": "a".repeat(22) } }),
        ] {
            assert!(subscription("phone", &bad).is_none(), "{bad}");
        }
        // A remote.json from before pushes loads, with none.
        let old: Config = serde_json::from_str(r#"{"on":true,"port":7420,"phones":["x"]}"#).unwrap();
        assert!(old.vapid.is_none() && old.pushes.is_empty());
    }

    #[test]
    fn a_push_reaches_its_push_service_with_its_headers_and_body() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let got = std::thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            // Read until the body is all in.
            loop {
                let n = s.read(&mut buf).unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some(at) = text.find("\r\n\r\n") {
                    let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if raw.len() >= at + 4 + len { break; }
                }
            }
            s.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n").unwrap();
            raw
        });
        let body: Vec<u8> = (0..=255).collect();
        let headers = vec![("Content-Encoding".to_string(), "aes128gcm".to_string()), ("TTL".to_string(), "43200".to_string())];
        assert_eq!(post(&format!("http://127.0.0.1:{port}/push/abc"), &headers, &body).unwrap(), 201);
        let raw = got.join().unwrap();
        let at = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..at]).to_string();
        assert!(head.starts_with("POST /push/abc HTTP/1.1"), "{head}");
        assert!(head.contains("Content-Encoding: aes128gcm") && head.contains("TTL: 43200"), "{head}");
        assert_eq!(&raw[at + 4..], body.as_slice(), "the body arrives byte for byte");
        assert!(post("ftp://x", &headers, &body).is_err());
        assert!(post("http://127.0.0.1:1/", &[("A".into(), "b\r\nc".into())], &body).is_err(), "no header may carry a line break");
    }

    #[test]
    fn replies_carry_their_length_and_compress_only_when_asked() {
        let body = "x".repeat(4000);
        let plain = Reply::new(200, "text/javascript", body.clone().into_bytes()).into_bytes(false);
        assert!(String::from_utf8_lossy(&plain).contains("Content-Length: 4000\r\n"));
        let squeezed = Reply::new(200, "text/javascript", body.into_bytes()).into_bytes(true);
        let text = String::from_utf8_lossy(&squeezed);
        assert!(text.contains("Content-Encoding: gzip") && squeezed.len() < 1000);
        assert!(text.contains("frame-ancestors 'none'"));
    }
}
