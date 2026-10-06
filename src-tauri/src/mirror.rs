//! Full Loom on the phone: the main window's page, streamed to the phone
//! remote (remote.rs) through the DevTools screencast, with the phone's taps,
//! scrolls and keys played back into it. Every menu and panel works from the
//! phone this way, without a phone version of each. While a phone watches,
//! the page lays out at the phone's size; the window keeps its own.
use base64::Engine;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};
use webview2_com::{take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{HSTRING, PWSTR};

/// A phone that asks for no frame this long has gone: the page takes the window's size again.
const IDLE: Duration = Duration::from_secs(20);
/// How long a phone's request for a frame waits for the page to change.
pub const WAIT: Duration = Duration::from_secs(15);
/// JPEG quality: text stays sharp at the phone's pixel ratio, a frame stays near 100 KB.
const QUALITY: u32 = 70;
/// What a phone may play into the page: the mouse, keys and typed text, nothing else of DevTools.
const INPUT: [&str; 3] = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"];

pub struct Frame {
    pub seq: u64,
    pub jpeg: Vec<u8>,
}

pub struct Mirror {
    frames: watch::Sender<Option<Arc<Frame>>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    on: bool,
    subscribed: bool,
    /// The screencast sends its next frame once this one is acknowledged:
    /// the phone's next request does it, so frames come as fast as the phone takes them.
    unacked: Option<i64>,
    /// Frames are numbered on across starts, so a phone's ?after=N stays meaningful.
    seq: u64,
    polled: Option<Instant>,
}

impl Default for Mirror {
    fn default() -> Self {
        Mirror { frames: watch::Sender::new(None), state: Mutex::default() }
    }
}

impl Mirror {
    fn got(&self, json: &str) {
        let Ok(v) = serde_json::from_str::<Value>(json) else { return };
        let Some(jpeg) = v["data"].as_str().and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()) else { return };
        let seq = {
            let mut s = self.state.lock().unwrap();
            s.unacked = v["sessionId"].as_i64();
            s.seq += 1;
            s.seq
        };
        self.frames.send_replace(Some(Arc::new(Frame { seq, jpeg })));
    }
}

/// One DevTools method on the main window's page, run on the main thread.
async fn cdp(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let window = app.get_webview_window("main").ok_or("Loom's window is closed.")?;
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let (name, params) = (HSTRING::from(method), HSTRING::from(params.to_string()));
    window
        .with_webview(move |webview| unsafe {
            // A refusal's JSON holds DevTools' own message; the HRESULT only says "invalid argument".
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let _ = tx.send(result.map(|()| json.clone()).map_err(|e| if json.is_empty() { e.to_string() } else { json }));
                Ok(())
            }));
            // On failure the handler is dropped unanswered, and the wait below says so.
            if let Ok(core) = webview.controller().CoreWebView2() {
                let _ = core.CallDevToolsProtocolMethod(&name, &params, &handler);
            }
        })
        .map_err(|e| e.to_string())?;
    let json = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| format!("Loom's page didn't answer {method}."))?
        .map_err(|_| format!("Loom's page refused {method}."))??;
    Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
}

/// Hands each screencast frame to the Mirror. Once: the handler stays for the page's life.
fn subscribe(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Loom's window is closed.")?;
    let handle = app.clone();
    window
        .with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Page.screencastFrame")) else { return };
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut json = PWSTR::null();
                    args.ParameterObjectAsJson(&mut json)?;
                    handle.state::<Mirror>().got(&take_pwstr(json));
                }
                Ok(())
            }));
            let mut token = 0;
            let _ = receiver.add_DevToolsProtocolEventReceived(&handler, &mut token);
        })
        .map_err(|e| e.to_string())
}

/// Lays the page out at the phone's size (CSS pixels, and its pixel ratio)
/// and streams it. Again with another size, as when the phone's keyboard opens.
pub async fn start(app: &AppHandle, width: u32, height: u32, scale: f64) -> Result<(), String> {
    let (width, height, scale) = (width.clamp(240, 2400), height.clamp(240, 3200), scale.clamp(1.0, 3.0));
    let window = app.get_webview_window("main").ok_or("Loom's window is closed.")?;
    // A minimized window draws nothing, so nothing would reach the phone.
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let mirror = app.state::<Mirror>();
    let (subscribed, was_on) = {
        let mut s = mirror.state.lock().unwrap();
        let before = (s.subscribed, s.on);
        (s.subscribed, s.on, s.polled) = (true, true, Some(Instant::now()));
        before
    };
    // The last frame of an earlier visit is another size and maybe long stale: wait for this one's.
    if !was_on {
        mirror.frames.send_replace(None);
    }
    if !subscribed {
        subscribe(app)?;
    }
    // The page keeps what the phone's size changes (the sidebar) to put back at stop.
    let _ = app.emit("mirror", true);
    let started = async {
        // A stream already running takes its new size from a fresh start.
        if was_on {
            let _ = cdp(app, "Page.stopScreencast", json!({})).await;
            mirror.state.lock().unwrap().unacked = None;
        }
        cdp(app, "Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": false })).await?;
        let (w, h) = ((width as f64 * scale).round() as u32, (height as f64 * scale).round() as u32);
        cdp(app, "Page.startScreencast", json!({ "format": "jpeg", "quality": QUALITY, "maxWidth": w, "maxHeight": h })).await
    };
    if let Err(e) = started.await {
        stop(app).await;
        return Err(e);
    }
    if !was_on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let mirror = app.state::<Mirror>();
                let gone = {
                    let s = mirror.state.lock().unwrap();
                    if !s.on {
                        break;
                    }
                    s.polled.is_none_or(|t| t.elapsed() > IDLE)
                };
                if gone {
                    stop(&app).await;
                    break;
                }
            }
        });
    }
    Ok(())
}

/// Ends the stream; the page takes the window's size again.
pub async fn stop(app: &AppHandle) {
    {
        let mirror = app.state::<Mirror>();
        let mut s = mirror.state.lock().unwrap();
        if !s.on {
            return;
        }
        (s.on, s.unacked) = (false, None);
    }
    let _ = cdp(app, "Page.stopScreencast", json!({})).await;
    let _ = cdp(app, "Emulation.clearDeviceMetricsOverride", json!({})).await;
    let _ = app.emit("mirror", false);
}

/// The first frame newer than `after`, or None if the page didn't change for WAIT.
pub async fn frame(app: &AppHandle, after: u64) -> Result<Option<Arc<Frame>>, String> {
    let mirror = app.state::<Mirror>();
    let unacked = {
        let mut s = mirror.state.lock().unwrap();
        if !s.on {
            return Err("Full Loom isn't on. Open it again.".into());
        }
        s.polled = Some(Instant::now());
        s.unacked.take()
    };
    if let Some(id) = unacked {
        let _ = cdp(app, "Page.screencastFrameAck", json!({ "sessionId": id })).await;
    }
    let mut frames = mirror.frames.subscribe();
    let newer = tokio::time::timeout(WAIT, frames.wait_for(|f| f.as_ref().is_some_and(|f| f.seq > after))).await;
    let frame = newer.ok().and_then(|r| r.ok().and_then(|f| f.clone()));
    Ok(frame)
}

/// Plays the phone's input into the page, in order.
pub async fn input(app: &AppHandle, events: &[Value]) -> Result<(), String> {
    if !app.state::<Mirror>().state.lock().unwrap().on {
        return Err("Full Loom isn't on. Open it again.".into());
    }
    for e in events {
        let method = e["method"].as_str().filter(|m| INPUT.contains(m)).ok_or("Input takes Input.dispatchMouseEvent, Input.dispatchKeyEvent or Input.insertText.")?;
        cdp(app, method, e["params"].clone()).await?;
    }
    Ok(())
}
