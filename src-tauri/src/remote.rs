//! The phone remote (docs/phone-remote-study.md): a small HTTP server that
//! serves the phone page (remote.html) and runs loomctl commands for it
//! through control::ask, so a phone can do whatever loomctl can. It listens
//! on 127.0.0.1 only: `tailscale serve` carries it to your own devices over
//! HTTPS. A phone needs a token, which it gets once for the six-digit code
//! `loomctl remote pair` shows. A phone can also sign up for Loom's task
//! notices as Web Push notifications (docs/phone-notifications-study.md):
//! this keeps the subscriptions and posts what push.ts encrypts and signs.
//! On the phone's own hotspot, where Tailscale can't reach it, the phone link
//! (link.rs) carries the phone's page to this same port instead.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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
/// A dictated clip: the phone stops at 3 minutes, 5.5 MiB of samples. On a
/// slow uplink that takes minutes, so it may go on as long as bytes keep
/// coming, up to CLIP_TOTAL, and stops when none come for CLIP_IDLE.
const CLIP: usize = 6 << 20;
const CLIP_IDLE: Duration = Duration::from_secs(15);
const CLIP_TOTAL: Duration = Duration::from_secs(600);
/// An image from the phone: a screenshot is a few MiB, a camera photo up to
/// ten or so. It may take as long as a clip.
const IMAGE: usize = 20 << 20;
/// How long a phone's image stays on the PC: an agent may look at it again later in its session.
const IMAGE_KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
/// A pairing code lasts this long, or until this many wrong guesses.
const PAIRING: Duration = Duration::from_secs(600);
const GUESSES: u8 = 5;
/// Connections served at once; past it a new one is closed unanswered.
const MAX_ACTIVE: usize = 32;
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
/// Of those, the ones that haven't shown a paired phone's token (Strangers).
const MAX_STRANGERS: usize = 8;
static STRANGERS: Strangers = Strangers(Mutex::new((0, VecDeque::new())));
/// A phone not seen for this long is unpaired, with its notifications.
const EXPIRY_MS: u64 = 90 * 24 * 3600 * 1000;
/// How often a phone's last-seen time is written to remote.json.
const SEEN_SAVE_MS: u64 = 3600 * 1000;
const CSP: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
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
    /// What Loom knows of each phone, by its token's hash. One paired before
    /// Loom kept this has none until it's next seen.
    #[serde(default)]
    devices: HashMap<String, Device>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Device {
    /// From its browser's User-Agent: "Chrome on Android".
    name: String,
    /// Unix ms; None for a phone paired before Loom kept this.
    paired: Option<u64>,
    /// Unix ms of its last request, as saved: at most hourly (Remote::seen has it exact).
    seen: Option<u64>,
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
    /// Each phone's last request, unix ms, by its token's hash.
    seen: Mutex<HashMap<String, u64>>,
}

fn config_path(app: &AppHandle) -> PathBuf {
    crate::state_file(app).with_extension("remote.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Loads the settings and, if the remote is on, starts listening.
pub fn start(app: &AppHandle) {
    let config: Config = std::fs::read(config_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let (on, port) = (config.on, config.port.unwrap_or(PORT));
    *app.state::<Remote>().config.lock().unwrap() = config;
    forget_stale(app);
    if on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { let _ = listen(&app, port).await; });
    }
}

/// `loomctl remote`: status, on, off, pair and revoke. `phone` with revoke
/// unpairs only that phone: its id in status's `devices`.
#[tauri::command]
pub async fn remote(app: AppHandle, action: String, port: Option<u16>, phone: Option<String>) -> Result<Value, String> {
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
            if phone.is_none() { *remote.pairing.lock().unwrap() = None; }
            // Checked on a copy first: a refusal saves nothing.
            revoke(&mut remote.config.lock().unwrap().clone(), phone.as_deref())?;
            update(&app, |c| { let _ = revoke(c, phone.as_deref()); })?;
        }
        _ => return Err(format!("remote takes on, off, pair or revoke, not {action}.")),
    }
    Ok(status(&app).await)
}

/// Unpairs the phone whose id (status's `devices`) is `id`, or every phone,
/// with their notifications. An id that names no phone or several is refused.
fn revoke(c: &mut Config, id: Option<&str>) -> Result<(), String> {
    let Some(id) = id else {
        c.phones.clear();
        c.pushes.clear();
        c.devices.clear();
        return Ok(());
    };
    let id = id.trim().to_ascii_lowercase();
    let hits: Vec<String> = c.phones.iter().filter(|h| !id.is_empty() && h.starts_with(&id)).cloned().collect();
    match &hits[..] {
        [one] => {
            c.phones.retain(|h| h != one);
            c.pushes.retain(|p| &p.phone != one);
            c.devices.remove(one);
            Ok(())
        }
        [] => Err(format!("No paired phone has the id {id}. loomctl remote lists them.")),
        _ => Err(format!("More than one phone's id starts with {id}. Give all 12 characters.")),
    }
}

/// Drops the phones not seen for EXPIRY_MS, by the later of what's saved and
/// `seen`, with their notifications. A phone never seen (paired before Loom
/// kept this) stays until it is. Whether any went.
fn expire(c: &mut Config, now: u64, seen: &HashMap<String, u64>) -> bool {
    let stale: Vec<String> = c.phones.iter().filter(|h| {
        let last = c.devices.get(*h).and_then(|d| d.seen).max(seen.get(*h).copied());
        last.is_some_and(|t| now.saturating_sub(t) > EXPIRY_MS)
    }).cloned().collect();
    for h in &stale {
        c.phones.retain(|p| p != h);
        c.pushes.retain(|p| &p.phone != h);
        c.devices.remove(h);
    }
    !stale.is_empty()
}

/// expire, saved, when there's anything to drop.
fn forget_stale(app: &AppHandle) {
    let remote = app.state::<Remote>();
    let (now, seen) = (now_ms(), remote.seen.lock().unwrap().clone());
    let stale = expire(&mut remote.config.lock().unwrap().clone(), now, &seen);
    if stale { let _ = update(app, |c| { expire(c, now, &seen); }); }
}

/// Each paired phone: `id`, the first 12 hex digits of its token's hash, which
/// revoke takes; its name; when it paired and was last seen (unix ms, null when
/// unknown); and whether it gets notifications. Last seen first.
fn devices(c: &Config, seen: &HashMap<String, u64>) -> Vec<Value> {
    let mut rows: Vec<(Option<u64>, Value)> = c.phones.iter().map(|h| {
        let d = c.devices.get(h);
        let last = d.and_then(|d| d.seen).max(seen.get(h).copied());
        (last, json!({ "id": &h[..h.len().min(12)], "name": d.map_or("Phone", |d| &d.name), "paired": d.and_then(|d| d.paired),
            "seen": last, "push": c.pushes.iter().any(|p| &p.phone == h) }))
    }).collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.into_iter().map(|(_, row)| row).collect()
}

async fn status(app: &AppHandle) -> Value {
    forget_stale(app);
    let remote = app.state::<Remote>();
    let (on, port, phones, pushes, devices) = {
        let seen = remote.seen.lock().unwrap().clone();
        let c = remote.config.lock().unwrap();
        (c.on, c.port.unwrap_or(PORT), c.phones.len(), c.pushes.len(), devices(&c, &seen))
    };
    let listening = remote.server.lock().unwrap().is_some();
    let pairing = remote.pairing.lock().unwrap().as_ref().filter(|p| p.until > Instant::now()).map(|p| p.code.clone());
    let error = remote.error.lock().unwrap().clone();
    let name = tauri::async_runtime::spawn_blocking(tailnet_name).await.ok().flatten();
    json!({ "on": on, "listening": listening, "port": port, "phones": phones, "pushes": pushes, "devices": devices, "pairing": pairing, "error": error, "address": name.map(|n| format!("https://{n}")) })
}

/// The status bar's word on the remote (main.ts paintStatus): None while off,
/// else its port, whether it listens, and why not. Locks only: the bar asks every few seconds.
pub fn bar(app: &AppHandle) -> Option<Value> {
    let remote = app.state::<Remote>();
    let (on, port) = { let c = remote.config.lock().unwrap(); (c.on, c.port.unwrap_or(PORT)) };
    on.then(|| json!({ "port": port, "listening": remote.server.lock().unwrap().is_some(), "error": remote.error.lock().unwrap().clone() }))
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
    let port = listener.local_addr().map_or(PORT, |a| a.port());
    // The phone link runs while the server does: `stop` aborting this ends it too. A debug build's
    // has its own name, so the phone keeps it apart from the installed Loom's.
    let _link = Abort(tauri::async_runtime::spawn(crate::link::run(if cfg!(debug_assertions) { "loom-dev" } else { "loom" }, port)));
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
            use std::future::Future;
            let (id, evicted) = STRANGERS.enter();
            // Whichever comes first: served, or made room for a newer stranger.
            let (mut served, mut ended) = (std::pin::pin!(serve(&app, stream, port, id)), std::pin::pin!(evicted.notified()));
            std::future::poll_fn(|cx| match served.as_mut().poll(cx).is_ready() || ended.as_mut().poll(cx).is_ready() {
                true => std::task::Poll::Ready(()),
                false => std::task::Poll::Pending,
            }).await;
            STRANGERS.leave(id);
            ACTIVE.fetch_sub(1, Ordering::AcqRel);
        });
    }
}

/// Aborts its task when dropped.
struct Abort(JoinHandle<()>);

impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Connections that haven't shown a paired phone's token: still sending their
/// head, or asking for the page or pairing. At most MAX_STRANGERS at once; a
/// new one past that ends the one that has waited longest. So idle connections
/// can't hold every slot and keep a phone out: a phone's head arrives at once,
/// and with its token it leaves this list.
struct Strangers(Mutex<(u64, VecDeque<(u64, Arc<tokio::sync::Notify>)>)>);

impl Strangers {
    fn enter(&self) -> (u64, Arc<tokio::sync::Notify>) {
        let mut s = self.0.lock().unwrap();
        s.0 += 1;
        let id = s.0;
        if s.1.len() >= MAX_STRANGERS {
            // A permit: it ends even if it isn't waiting yet.
            if let Some((_, oldest)) = s.1.pop_front() { oldest.notify_one(); }
        }
        let evicted = Arc::new(tokio::sync::Notify::new());
        s.1.push_back((id, evicted.clone()));
        (id, evicted)
    }

    fn leave(&self, id: u64) {
        self.0.lock().unwrap().1.retain(|(i, _)| *i != id);
    }
}

/// One request per connection, then the connection closes.
async fn serve(app: &AppHandle, mut stream: TcpStream, port: u16, stranger: u64) -> std::io::Result<()> {
    let request = read(&mut stream, |r| {
        let paired = phone(app, r).is_some();
        if paired { STRANGERS.leave(stranger); }
        paired
    }).await?;
    let gzip = request.as_ref().is_ok_and(|r| r.header("accept-encoding").is_some_and(|v| v.contains("gzip")));
    let reply = match request {
        Ok(request) => match crate::control::unless_gone(&mut stream, route(app, &request, port)).await {
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

/// The most a request's body may hold, how long its client may go without
/// sending a byte of it, and how long from its first byte it may take in all:
/// a clip for /api/dictate, an image for /api/image, a prompt otherwise.
fn limits(path: &str) -> (usize, Duration, Duration) {
    match path.split('?').next() {
        Some("/api/dictate") => (CLIP, CLIP_IDLE, CLIP_TOTAL),
        Some("/api/image") => (IMAGE, CLIP_IDLE, CLIP_TOTAL),
        _ => (BODY, FRAME, FRAME),
    }
}

/// More of the request, unless its deadline passes first.
async fn more(stream: &mut (impl AsyncRead + Unpin), buf: &mut Vec<u8>, until: tokio::time::Instant) -> std::io::Result<()> {
    let mut chunk = [0u8; 4096];
    let n = tokio::time::timeout_at(until, stream.read(&mut chunk)).await.map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
    if n == 0 {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    buf.extend_from_slice(&chunk[..n]);
    Ok(())
}

/// An HTTP/1.1 request with a Content-Length body, or the reply that refuses it.
/// Its head comes within FRAME; its path says how big and slow the rest may be.
async fn read(stream: &mut (impl AsyncRead + Unpin), paired: impl Fn(&Request) -> bool) -> std::io::Result<Result<Request, Reply>> {
    let begun = tokio::time::Instant::now();
    let mut buf = Vec::new();
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > HEAD {
            return Ok(Err(Reply::error(431, "The request's headers are too long.")));
        }
        more(stream, &mut buf, begun + FRAME).await?;
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
    // Only a paired phone may take a clip's size and time: a stranger keeps a prompt's.
    let (most, idle, total) = if paired(&request) { limits(&request.path) } else { (BODY, FRAME, FRAME) };
    if length > most {
        return Ok(Err(Reply::error(413, "The request is too large.")));
    }
    while request.body.len() < length {
        more(stream, &mut request.body, (tokio::time::Instant::now() + idle).min(begun + total)).await?;
    }
    request.body.truncate(length);
    Ok(Ok(request))
}

async fn route(app: &AppHandle, request: &Request, port: u16) -> Reply {
    let path = request.path.split('?').next().unwrap_or("");
    match (request.method.as_str(), path) {
        ("GET", "/") => asset(app, "remote.html"),
        ("GET", "/manifest.webmanifest") => Reply::new(200, "application/manifest+json", MANIFEST.into()),
        ("GET", "/icon.svg") => Reply::new(200, "image/svg+xml", ICON.into()),
        ("GET", "/icon.png") => Reply::new(200, "image/png", ICON_PNG.into()),
        ("GET", "/badge.png") => Reply::new(200, "image/png", BADGE_PNG.into()),
        ("GET", "/sw.js") => Reply::new(200, "text/javascript", WORKER.into()),
        ("GET", p) if p.starts_with("/assets/") => asset(app, &p[1..]).cached(),
        ("POST", "/api/pair") => match pairable(request, port) {
            Some(refused) => refused,
            None => pair(app, request),
        },
        ("POST", "/api/cli") => cli(app, request).await,
        ("POST", "/api/dictate") => dictate(app, request).await,
        ("POST", "/api/image") => image(app, request).await,
        ("POST", "/api/push") => push(app, request),
        ("POST", "/api/procs") => procs(app, request).await,
        ("POST", "/api/bar") => strip(app, request).await,
        ("GET", "/api/link") => link_secret(request),
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
        // Any other page is Tauri's index.html fallback, the desktop page.
        if path == "remote.html" || a.mime_type() != "text/html" {
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

/// Pairing is the one route a token doesn't guard, so a web page open on this
/// PC could post guesses to it, or, rebinding its own name to 127.0.0.1, read
/// a token back. Refused unless the body is JSON, which a page can only send
/// after a preflight Loom never answers, and the Host is this PC or a tailnet
/// name, which a rebound name isn't. None: go on.
fn pairable(request: &Request, port: u16) -> Option<Reply> {
    let kind = request.header("content-type").unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if kind != "application/json" {
        return Some(Reply::error(415, "Send the pairing code as application/json."));
    }
    let host = request.header("host").unwrap_or("").to_ascii_lowercase();
    let local = [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&host);
    let tailnet = host.split(':').next().unwrap_or("").trim_end_matches('.').ends_with(".ts.net");
    (!local && !tailnet).then(|| Reply::error(403, "Pair from this PC or your tailnet's address."))
}

/// The phone link's secret (link.rs), for the phone over Tailscale only: the
/// tailnet is what vouches for it. Its own token isn't asked for, since the
/// link is the phone app's, which has none.
fn link_secret(request: &Request) -> Reply {
    let host = request.header("host").unwrap_or("").to_ascii_lowercase();
    if !host.split(':').next().unwrap_or("").trim_end_matches('.').ends_with(".ts.net") {
        return Reply::error(403, "Ask over Tailscale.");
    }
    Reply::json(200, json!({ "secret": crate::link::secret() }))
}

fn pair(app: &AppHandle, request: &Request) -> Reply {
    let code = serde_json::from_slice::<Value>(&request.body).ok().and_then(|v| v["code"].as_str().map(|c| c.trim().to_string())).unwrap_or_default();
    if let Err(error) = guess(&mut app.state::<Remote>().pairing.lock().unwrap(), &code, Instant::now()) {
        return Reply::error(403, error);
    }
    let token: String = random::<32>().iter().map(|b| format!("{b:02x}")).collect();
    let (id, now) = (hash(&token), now_ms());
    let device = Device { name: device_name(request.header("user-agent").unwrap_or("")), paired: Some(now), seen: Some(now) };
    match update(app, |c| { c.phones.push(id.clone()); c.devices.insert(id, device); }) {
        Ok(()) => Reply::json(200, json!({ "ok": true, "token": token })),
        Err(error) => Reply::error(500, &error),
    }
}

/// What to call a phone, from its browser's User-Agent: "Chrome on Android",
/// "Safari on iPhone", or just "Phone".
fn device_name(ua: &str) -> String {
    // First match wins: Edge and Samsung's say Chrome too, and every one says Safari.
    let browser = [("EdgA/", "Edge"), ("EdgiOS/", "Edge"), ("Edg/", "Edge"), ("SamsungBrowser/", "Samsung Internet"), ("OPR/", "Opera"),
        ("Firefox/", "Firefox"), ("FxiOS/", "Firefox"), ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]
        .iter().find(|(k, _)| ua.contains(k)).map(|(_, v)| *v);
    let system = [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"), ("Mac OS X", "Mac"), ("CrOS", "ChromeOS"), ("Linux", "Linux")]
        .iter().find(|(k, _)| ua.contains(k)).map(|(_, v)| *v);
    match (browser, system) {
        (Some(b), Some(s)) => format!("{b} on {s}"),
        (Some(x), None) | (None, Some(x)) => x.into(),
        (None, None) => "Phone".into(),
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

/// The paired phone a request comes from: its token's hash. It counts as seen.
fn phone(app: &AppHandle, request: &Request) -> Option<String> {
    let token = request.header("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("").trim();
    let id = hash(token);
    let remote = app.state::<Remote>();
    if token.is_empty() { return None; }
    let now = now_ms();
    let (paired, admitted) = {
        let c = remote.config.lock().unwrap();
        (c.phones.contains(&id), admit(&c, &mut remote.seen.lock().unwrap(), &id, now))
    };
    let Some(stale) = admitted else {
        // Paired but unseen too long: unpaired now, with its notifications, as status does.
        if paired { forget_stale(app); }
        return None;
    };
    if stale {
        let name = device_name(request.header("user-agent").unwrap_or(""));
        let _ = update(app, |c| {
            if !c.phones.contains(&id) { return; }
            c.devices.entry(id.clone()).or_insert(Device { name, paired: None, seen: None }).seen = Some(now);
        });
    }
    Some(id)
}

/// Lets phone `id` in at `now`, and counts the request as a sighting. Some(save):
/// in, and whether its saved last-seen time is due to be written (hourly; one
/// paired before Loom kept this gets its record now). None: refused, and
/// nothing changes. A phone unseen for EXPIRY_MS, by the later of its saved and
/// in-memory times, is refused before its request counts as seen: expire runs
/// only at startup and on status, and a sighting first would make it fresh.
/// One never seen (paired before Loom kept this) comes in, as expire keeps it.
fn admit(c: &Config, seen: &mut HashMap<String, u64>, id: &str, now: u64) -> Option<bool> {
    if !c.phones.iter().any(|h| h == id) { return None; }
    let saved = c.devices.get(id).map(|d| d.seen);
    let last = saved.flatten().max(seen.get(id).copied());
    if last.is_some_and(|t| now.saturating_sub(t) > EXPIRY_MS) { return None; }
    seen.insert(id.to_owned(), now);
    Some(saved.is_none_or(|seen| seen.is_none_or(|t| now.saturating_sub(t) >= SEEN_SAVE_MS)))
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
/// file, so none of them shows on a command line. `-g`: a webhook's address
/// is one request, its braces and brackets characters, never a curl glob.
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
        .args(["-q", "-g", "-sS", "-m", "20", "-o", "NUL", "-w", "%{http_code}", "-K", "-"])
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

/// A clip the phone recorded (docs/phone-dictation-study.md): 16-bit samples at
/// 16 kHz, mono, as the body, and `?lang=` the language whisper hears (none: it
/// detects). An empty body loads the model while you talk. Answers the text.
async fn dictate(app: &AppHandle, request: &Request) -> Reply {
    if phone(app, request).is_none() {
        return unpaired();
    }
    let query = request.path.split_once('?').map_or("", |(_, q)| q);
    let lang = query.split('&').find_map(|kv| kv.strip_prefix("lang=")).filter(|l| !l.is_empty()).map(String::from);
    // A whisper code, so nothing reaches its C string that could stop Loom.
    if lang.as_ref().is_some_and(|l| l.len() > 8 || !l.bytes().all(|b| b.is_ascii_lowercase())) {
        return Reply::error(400, "That isn't a language code.");
    }
    if request.body.len() % 2 != 0 {
        return Reply::error(400, "Send 16-bit samples.");
    }
    let (app, pcm) = (app.clone(), request.body.clone());
    match tauri::async_runtime::spawn_blocking(move || crate::dictate::phone(&app, &pcm, lang.as_deref())).await {
        Ok(Ok(text)) => Reply::json(200, json!({ "ok": true, "text": text })),
        Ok(Err(error)) => Reply::error(500, &error),
        Err(error) => Reply::error(500, &error.to_string()),
    }
}

/// An image for an agent: PNG, JPEG, WebP or GIF, as the body. Loom saves it in
/// its data folder's phone-images under a name of its own and answers the path,
/// which the phone puts in the agent's prompt.
async fn image(app: &AppHandle, request: &Request) -> Reply {
    if phone(app, request).is_none() {
        return unpaired();
    }
    let (dir, bytes) = (crate::data_dir(app).join("phone-images"), request.body.clone());
    match tauri::async_runtime::spawn_blocking(move || keep_image(&dir, &bytes, std::time::SystemTime::now())).await {
        Ok(Ok(path)) => Reply::json(200, json!({ "ok": true, "path": path })),
        Ok(Err((status, error))) => Reply::error(status, &error),
        Err(error) => Reply::error(500, &error.to_string()),
    }
}

/// What kind of image `bytes` are, by their first bytes alone: its extension.
fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("gif"),
        _ => None,
    }
}

/// Saves an image in `dir`, which holds nothing else, as `<unix ms>-<random>.<kind>`,
/// and drops the ones there older than IMAGE_KEEP. Its path, or the status and why not.
fn keep_image(dir: &Path, bytes: &[u8], now: std::time::SystemTime) -> Result<String, (u16, String)> {
    use std::io::Write;
    let Some(kind) = image_kind(bytes) else { return Err((415, "Loom takes PNG, JPEG, WebP and GIF images.".into())) };
    std::fs::create_dir_all(dir).map_err(|e| (500, format!("Loom couldn't make {}: {e}", dir.display())))?;
    for file in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let aged = file.metadata().ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok())
            .is_some_and(|at| now.duration_since(at).is_ok_and(|age| age > IMAGE_KEEP));
        if aged { let _ = std::fs::remove_file(file.path()); }
    }
    let ms = now.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = dir.join(format!("{ms}-{}.{kind}", random::<4>().iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let saved = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).and_then(|mut f| f.write_all(bytes));
    if let Err(e) = saved {
        let _ = std::fs::remove_file(&path);
        return Err((500, format!("Loom couldn't save the image in {}: {e}", dir.display())));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// The phone's task manager: the PC's CPU, memory and processes (procs.rs).
/// Read here, not through loomctl: the window would only hand Rust's answer
/// back to Rust, every 2 s while the phone shows it.
async fn procs(app: &AppHandle, request: &Request) -> Reply {
    if phone(app, request).is_none() {
        return unpaired();
    }
    match tauri::async_runtime::spawn_blocking(crate::procs::read).await {
        Ok(data) => Reply::json(200, json!({ "ok": true, "data": data })),
        Err(error) => Reply::error(500, &error.to_string()),
    }
}

/// The phone's strip above its tabs: the PC status bar's reading (lib.rs
/// status_reading), every 3 s while the page is in view. Read here, as procs is.
async fn strip(app: &AppHandle, request: &Request) -> Reply {
    if phone(app, request).is_none() {
        return unpaired();
    }
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || crate::status_reading(&app)).await {
        Ok(data) => Reply::json(200, json!({ "ok": true, "data": data })),
        Err(error) => Reply::error(500, &error.to_string()),
    }
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
            411 => "Length Required", 413 => "Payload Too Large", 415 => "Unsupported Media Type", 431 => "Request Header Fields Too Large", _ => "Internal Server Error",
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
        tauri::async_runtime::block_on(read(&mut &raw[..], |_| true))
    }

    #[test]
    fn a_clip_may_be_six_times_a_prompt_and_only_from_a_paired_phone() {
        let head = |path: &str, length: usize| format!("POST {path} HTTP/1.1\r\nContent-Length: {length}\r\n\r\n").into_bytes();
        let status = |raw: &[u8], paired: bool| tauri::async_runtime::block_on(read(&mut &raw[..], |_| paired)).map(|r| r.err().map(|e| e.status));
        // Past the limit: refused before a byte of the body. Under it: read on, so a short body is no request.
        assert_eq!(status(&head("/api/dictate?lang=fr", CLIP + 1), true).unwrap(), Some(413));
        assert_eq!(status(&head("/api/dictate", CLIP), true).unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(status(&head("/api/cli", BODY + 1), true).unwrap(), Some(413), "a prompt keeps 1 MiB");
        assert_eq!(status(&head("/api/cli", BODY), true).unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(status(&head("/api/dictate", BODY + 1), false).unwrap(), Some(413), "a stranger's clip is a prompt");
        assert_eq!((limits("/api/dictate?lang=en"), limits("/api/cli"), limits("/api/dictatex")), ((CLIP, CLIP_IDLE, CLIP_TOTAL), (BODY, FRAME, FRAME), (BODY, FRAME, FRAME)));
        // A whole clip arrives whole.
        let mut raw = head("/api/dictate", 4);
        raw.extend([1, 0, 255, 127]);
        let r = parse(&raw).unwrap().ok().unwrap();
        assert_eq!(r.body, [1, 0, 255, 127]);
    }

    #[test]
    fn an_image_is_kept_by_its_bytes_under_a_name_loom_picks() {
        let dir = std::env::temp_dir().join(format!("loom-phone-images-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let now = std::time::SystemTime::now();
        let png = [&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], b"rest of it"].concat();
        let kinds = [(png.clone(), "png"), (b"\xFF\xD8\xFF\xE0jfif".to_vec(), "jpg"), (b"RIFF\x10\0\0\0WEBPVP8 ".to_vec(), "webp"), (b"GIF89a..".to_vec(), "gif")];
        for (bytes, kind) in &kinds {
            let path = keep_image(&dir, bytes, now).unwrap();
            assert!(path.ends_with(&format!(".{kind}")) && Path::new(&path).parent() == Some(dir.as_path()), "{path}");
            assert_eq!(&std::fs::read(&path).unwrap(), bytes);
        }
        // Kept by what its bytes are, whatever it claims: an SVG, HTML, an EXE, a cut-off PNG, or nothing.
        for junk in [&b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..], b"<html><script>", b"MZ\x90\0", b"", b"\x89PNG"] {
            assert_eq!(keep_image(&dir, junk, now).unwrap_err().0, 415);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 4, "a refused body left a file");
        // A week on, the next one takes the old ones with it; one six days old stays.
        let six_days = keep_image(&dir, &png, now).unwrap();
        std::fs::File::options().write(true).open(&six_days).unwrap().set_modified(now - Duration::from_secs(6 * 24 * 3600)).unwrap();
        for f in std::fs::read_dir(&dir).unwrap().flatten().filter(|f| f.path() != Path::new(&six_days)) {
            std::fs::File::options().write(true).open(f.path()).unwrap().set_modified(now - IMAGE_KEEP - Duration::from_secs(60)).unwrap();
        }
        let fresh = keep_image(&dir, &png, now).unwrap();
        let mut left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|f| f.path()).collect();
        left.sort();
        let mut want = vec![PathBuf::from(&six_days), PathBuf::from(&fresh)];
        want.sort();
        assert_eq!(left, want);
        assert_eq!(limits("/api/image"), (IMAGE, CLIP_IDLE, CLIP_TOTAL));
        std::fs::remove_dir_all(dir).unwrap();
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
    fn a_clip_on_a_slow_uplink_arrives_while_bytes_keep_coming() {
        use tokio::io::AsyncWriteExt;
        // Paused clock: a body that trickles in for longer than CLIP_IDLE in all,
        // never quiet for that long, arrives; one that stops goes.
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
        let (status, stalled) = rt.block_on(async {
            let send = |gap: Duration, chunks: usize| async move {
                let (mut client, mut server) = tokio::io::duplex(1 << 16);
                let writer = tokio::spawn(async move {
                    let _ = client.write_all(format!("POST /api/dictate HTTP/1.1\r\nContent-Length: {chunks}\r\n\r\n").as_bytes()).await;
                    for _ in 0..chunks {
                        tokio::time::sleep(gap).await;
                        if client.write_all(&[0]).await.is_err() { break; }
                    }
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    drop(client);
                });
                let got = read(&mut server, |_| true).await;
                writer.abort();
                got
            };
            (send(Duration::from_secs(10), 12).await.map(|r| r.map(|r| r.body.len()).ok()), send(CLIP_IDLE + Duration::from_secs(1), 2).await)
        });
        assert_eq!(status.unwrap(), Some(12), "two minutes of steady upload is a clip, not a timeout");
        assert_eq!(stalled.err().unwrap().kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn the_link_secret_is_for_the_tailnet_only() {
        let status = |host: &str| link_secret(&Request { method: "GET".into(), path: "/api/link".into(), body: Vec::new(),
            headers: vec![("Host".into(), host.into())] }).status;
        for host in ["127.0.0.1:7420", "localhost:7420", "evil.example", "ts.net.evil.example", ""] {
            assert_eq!(status(host), 403, "{host}");
        }
        assert_eq!(status("pc.tail1234.ts.net"), 200);
    }

    #[test]
    fn pairing_takes_json_from_this_pc_or_the_tailnet_only() {
        let req = |kind: &str, host: &str| Request { method: "POST".into(), path: "/api/pair".into(), body: Vec::new(),
            headers: vec![("Content-Type".into(), kind.into()), ("Host".into(), host.into())] };
        let status = |kind: &str, host: &str| pairable(&req(kind, host), 7420).map(|r| r.status);
        for host in ["127.0.0.1:7420", "localhost:7420", "LocalHost:7420", "[::1]:7420", "pc.tail1234.ts.net", "pc.tail1234.ts.net:443"] {
            assert_eq!(status("application/json", host), None, "{host}");
        }
        assert_eq!(status("application/json; charset=utf-8", "127.0.0.1:7420"), None);
        // A page's simple request needs no preflight: refused for its type.
        for kind in ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""] {
            assert_eq!(status(kind, "127.0.0.1:7420"), Some(415), "{kind}");
        }
        // A rebound name, another port, or none.
        for host in ["evil.example:7420", "127.0.0.1:7421", "127.0.0.1", "ts.net.evil.example", ""] {
            assert_eq!(status("application/json", host), Some(403), "{host}");
        }
    }

    #[test]
    fn a_phone_is_named_after_its_browser() {
        let name = |ua: &str| device_name(ua);
        assert_eq!(name("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
        assert_eq!(name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
        assert_eq!(name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1"), "Chrome on iPhone");
        assert_eq!(name("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Windows");
        assert_eq!(name("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36"), "Samsung Internet on Android");
        assert_eq!(name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0"), "Edge on Windows");
        assert_eq!(name("node"), "Phone");
        assert_eq!(name(""), "Phone");
    }

    #[test]
    fn phones_are_revoked_one_at_a_time_and_expire_unseen() {
        let day = 24 * 3600 * 1000;
        let now = 400 * day;
        let (a, b, old) = ("a1".repeat(32), "b2".repeat(32), "c3".repeat(32));
        let push = |phone: &str| Push { phone: phone.into(), endpoint: format!("https://push.example/{phone}"), p256dh: "k".into(), auth: "a".into() };
        let device = |seen: Option<u64>| Device { name: "Chrome on Android".into(), paired: Some(day), seen };
        let mut c = Config { phones: vec![a.clone(), b.clone(), old.clone()], pushes: vec![push(&a), push(&b), push(&old)], ..Config::default() };
        c.devices.insert(a.clone(), device(Some(now - 91 * day)));
        c.devices.insert(b.clone(), device(Some(now - 89 * day)));
        // Listed by last seen; the phone paired before this has no record, and nulls.
        let rows = devices(&c, &HashMap::from([(b.clone(), now - day)]));
        assert_eq!(rows.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), [&b[..12], &a[..12], &old[..12]]);
        assert_eq!(rows[1], json!({ "id": &a[..12], "name": "Chrome on Android", "paired": day, "seen": now - 91 * day, "push": true }));
        assert_eq!(rows[2], json!({ "id": &old[..12], "name": "Phone", "paired": null, "seen": null, "push": true }));
        // Seen this session (memory) keeps a phone the saved time would drop.
        let mut kept = c.clone();
        assert!(!expire(&mut kept, now, &HashMap::from([(a.clone(), now - day)])));
        // 91 days unseen goes with its pushes; 89 stays; never seen stays until it is.
        assert!(expire(&mut c, now, &HashMap::new()));
        assert_eq!(c.phones, [b.clone(), old.clone()]);
        assert!(!c.pushes.iter().any(|p| p.phone == a) && !c.devices.contains_key(&a));
        assert!(!expire(&mut c, now, &HashMap::new()), "nothing more to drop");
        // One by its id: the rest stay paired, with their notifications.
        assert!(revoke(&mut c.clone(), Some("ffffffffffff")).unwrap_err().contains("No paired phone"));
        let mut twins = Config { phones: vec!["abc1".repeat(16), "abc2".repeat(16)], ..Config::default() };
        assert!(revoke(&mut twins, Some("abc")).unwrap_err().contains("More than one"));
        assert!(revoke(&mut twins, Some("")).is_err());
        revoke(&mut c, Some(&b[..12].to_uppercase())).unwrap();
        assert_eq!((c.phones.clone(), c.pushes.len(), c.devices.len()), (vec![old.clone()], 1, 0));
        revoke(&mut c, None).unwrap();
        assert!(c.phones.is_empty() && c.pushes.is_empty() && c.devices.is_empty());
    }

    #[test]
    fn a_phone_unseen_too_long_cant_come_back_by_asking() {
        let day = 24 * 3600 * 1000;
        let now = 400 * day;
        let [stale, fresh, recent, timeless, older, stranger] = ["a1", "b2", "c3", "d4", "e5", "f6"].map(|s| s.repeat(32));
        let device = |seen: Option<u64>| Device { name: "Chrome on Android".into(), paired: Some(day), seen };
        let mut c = Config { phones: vec![stale.clone(), fresh.clone(), recent.clone(), timeless.clone(), older.clone()], ..Config::default() };
        c.devices.insert(stale.clone(), device(Some(now - 91 * day)));
        c.devices.insert(fresh.clone(), device(Some(now - 90 * day)));
        c.devices.insert(recent.clone(), device(Some(now - 10 * 60 * 1000)));
        c.devices.insert(timeless.clone(), device(None));
        // `older` was paired before Loom kept records: it has none.
        let mut seen = HashMap::new();
        // 91 days unseen, with Loom open and no status since: refused, and the
        // refusal isn't a sighting, so asking again can't make it fresh.
        assert_eq!(admit(&c, &mut seen, &stale, now), None);
        assert!(!seen.contains_key(&stale), "a refused request counts as seen");
        assert_eq!(admit(&c, &mut seen, &stale, now + 1), None, "a stale phone's second request got in");
        assert!(expire(&mut c.clone(), now + 1, &seen), "status still unpairs it");
        // Seen this session within the 90 days keeps one whose saved time is older.
        assert_eq!(admit(&c, &mut HashMap::from([(stale.clone(), now - day)]), &stale, now), Some(true));
        // 90 days to the ms still gets in, and is written down, as is one with no time or no record.
        assert_eq!(admit(&c, &mut seen, &fresh, now), Some(true));
        assert_eq!(admit(&c, &mut seen, &timeless, now), Some(true));
        assert_eq!(admit(&c, &mut seen, &older, now), Some(true));
        // Seen 10 minutes ago: in, and not written again before the hour.
        assert_eq!(admit(&c, &mut seen, &recent, now), Some(false));
        assert_eq!(seen.get(&recent), Some(&now));
        assert_eq!(admit(&c, &mut seen, &stranger, now), None);
    }

    #[test]
    fn idle_strangers_make_room_for_new_ones() {
        let strangers = Strangers(Mutex::new((0, VecDeque::new())));
        let first: Vec<_> = (0..MAX_STRANGERS).map(|_| strangers.enter()).collect();
        let (newest, _) = strangers.enter();
        // The longest waiting is told to end; nobody else is.
        let woke = |n: &Arc<tokio::sync::Notify>| tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_millis(50), n.notified()).await.is_ok()
        });
        assert!(woke(&first[0].1));
        assert!(!woke(&first[1].1));
        // One that showed a phone's token leaves the list and can't be ended.
        strangers.leave(first[1].0);
        strangers.enter(); // takes the slot it freed
        assert!(!woke(&first[2].1));
        strangers.enter(); // past the cap again: the longest waiting of those left
        assert!(!woke(&first[1].1));
        assert!(woke(&first[2].1));
        assert_eq!(strangers.0.lock().unwrap().1.len(), MAX_STRANGERS);
        assert!(strangers.0.lock().unwrap().1.iter().any(|(id, _)| *id == newest));
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
        // A remote.json from before pushes and phone records loads, with none,
        // and its phone stays paired until it has been seen.
        let mut old: Config = serde_json::from_str(r#"{"on":true,"port":7420,"phones":["x"]}"#).unwrap();
        assert!(old.vapid.is_none() && old.pushes.is_empty() && old.devices.is_empty());
        assert!(!expire(&mut old, u64::MAX, &HashMap::new()) && old.phones == ["x"]);
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

    /// Review round 1, 1: curl's URL globbing would turn one delivery into several.
    #[test]
    fn a_webhook_address_is_one_request_braces_and_brackets_included() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        // Answers 200 to each request and keeps its request line, until a connection sends nothing.
        let lines = std::thread::spawn(move || {
            let mut lines = vec![];
            for stream in server.incoming() {
                let mut stream = stream.unwrap();
                let (mut got, mut buf) = (vec![], [0; 4096]);
                while let Ok(n @ 1..) = stream.read(&mut buf) {
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()));
                    if got.len() >= end + 4 + length.unwrap_or(0) {
                        break;
                    }
                }
                if got.is_empty() {
                    break;
                }
                lines.push(String::from_utf8_lossy(&got).lines().next().unwrap().to_string());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
            lines
        });
        let status = post(&format!("http://127.0.0.1:{port}/{{one,two}}/[1-3]"), &[("X-Loom-Event".into(), "pane-state".into())], b"{}");
        drop(std::net::TcpStream::connect(("127.0.0.1", port)).unwrap());
        assert_eq!(status, Ok(200), "one status, not one per globbed address");
        assert_eq!(lines.join().unwrap(), ["POST /{one,two}/[1-3] HTTP/1.1"]);
    }
}
