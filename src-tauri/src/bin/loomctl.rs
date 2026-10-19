//! loomctl: control a running Loom from a terminal, a script or an agent in a
//! pane. It sends one command over Loom's control pipe (control.rs) and prints
//! the answer; the running Loom does the work, so the window shows it. A
//! console program, unlike loom.exe, so shells wait for it and get its exit
//! code. `loomctl help` asks the running Loom for its commands.
//!
//! Only loomctl's own options are read here. The command's words go to Loom as
//! they are, because only Loom knows which options each command takes and which
//! of them are on/off flags that must not swallow the next word.
#[path = "../pipe.rs"]
mod pipe;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};

const USAGE: &str = "loomctl: control a running Loom.

Usage: loomctl [--json] [--profile FILE] [--timeout SECONDS] [--key NAME] <command> [args...]

  loomctl help            the commands the running Loom knows
  loomctl help <command>  one command's arguments
  loomctl info            which Loom answers: its version, process and own pipe

Put a command's own options after it: --name value, --name=value, or --flag.
After --, every word is an argument. An argument of - is standard input, sent
as it is: text starting with -- stays text. Inside a Loom pane, loomctl talks to
the Loom that owns the pane.
--profile FILE selects a workspace. Only one Loom may write that workspace
and its task journal; a second profile launch refuses to open it.

--key NAME makes a retry safe: Loom runs a key once. The same command again
with that key gets the first answer, failures included, waiting for it if the
first is still running. The same key with another command is refused. A key
stays while its command runs; Loom keeps the last 256 finished ones until it
exits, and submit's in its task journal across restarts.

loomctl watch --follow prints task events as they come, one JSON line each
with --json, and reconnects when Loom goes away, from the last one it printed.
On a task it stops once the task is finished. A failure that ends it is one
more JSON line, with \"next\", the event number to resume from.

loomctl watch --panes --follow does the same for pane states: one event each
time a pane settles as working, idle, waiting, exited or starting for 2 s,
with its thread, agent, title and last lines. --thread T, --pane P and
--state idle,waiting narrow it. loomctl wait <pane> --until idle blocks until
the pane has settled idle. loomctl webhook add <url> has Loom POST the same
events to a URL, from every thread, with nothing to set up per project.

With --json, every failure prints one JSON object: \"code\" (usage, not-running,
busy, unreachable, version, connection, timeout or failed), \"sent\" (whether
the command reached Loom: if so it may have run) and \"error\". From Loom it can
add \"typed\": true (text is in the pane, Enter wasn't pressed) or \"pressed\"
(how many keys went in before a restart stopped the rest).

Exit codes: 0 done, 1 the command failed, 2 Loom isn't running or is a
different version, 3 timed out. The hello before a command gets 10 seconds at
most, so a stuck Loom never holds loomctl past --timeout plus 20 seconds.";

/// Commands that wait for something get an hour unless told otherwise.
const LONG: [&str; 2] = ["wait", "wait-any"];
/// Other commands' answers, unless --timeout says otherwise.
const DEFAULT_TIMEOUT: f64 = 30.0;
/// The longest --timeout: a year. Past it, seconds overflow a Duration, an
/// Instant or the watchdog's milliseconds long before they mean anything.
const MAX_TIMEOUT: f64 = 31_536_000.0;

#[derive(Debug, PartialEq)]
struct Parsed {
    cmd: String,
    argv: Vec<String>,
    json: bool,
    profile: Option<String>,
    timeout: Option<f64>,
    version: bool,
    /// --key: the caller's name for this request. Loom runs a key once and
    /// answers a retry with the first answer.
    key: Option<String>,
    /// An argument is `-`: standard input goes with the request, apart from
    /// the words, so Loom never parses it as options.
    stdin: bool,
}

fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut parsed = Parsed { cmd: String::new(), argv: Vec::new(), json: false, profile: None, timeout: None, version: false, key: None, stdin: false };
    let mut help = false;
    let mut rest = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if rest {
            parsed.stdin |= a == "-";
            parsed.argv.push(a.clone());
            continue;
        }
        let (key, inline) = match a.strip_prefix("--") {
            Some(k) => match k.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (k, None),
            },
            None => ("", None),
        };
        let mut value = |name: &str, inline: Option<String>| -> Result<String, String> {
            if let Some(v) = inline {
                return Ok(v);
            }
            let v = args.get(i).filter(|v| !v.starts_with("--")).ok_or(format!("--{name} needs a value"))?.clone();
            i += 1;
            Ok(v)
        };
        match (a.as_str(), key) {
            ("--", _) => {
                rest = true;
                parsed.argv.push(a.clone());
            }
            (_, "json") => parsed.json = true,
            (_, "help") | ("-h", _) => help = true,
            (_, "version") | ("-V", _) => parsed.version = true,
            (_, "profile") => parsed.profile = Some(value("profile", inline)?),
            (_, "key") => {
                let v = value("key", inline)?;
                if v.is_empty() || v.len() > 200 {
                    return Err("--key takes a name of 1 to 200 characters".into());
                }
                parsed.key = Some(v);
            }
            (_, "timeout") => {
                let v = value("timeout", inline)?;
                let secs: f64 = v.parse().map_err(|_| format!("--timeout needs seconds, not {v}"))?;
                if !(secs > 0.0 && secs <= MAX_TIMEOUT) {
                    return Err(format!("--timeout needs seconds, more than 0 and at most {MAX_TIMEOUT} (a year), not {v}"));
                }
                parsed.timeout = Some(secs);
            }
            ("-", _) => {
                parsed.stdin = true;
                parsed.argv.push(a.clone());
            }
            _ if parsed.cmd.is_empty() && !a.starts_with('-') => parsed.cmd = a.clone(),
            _ => parsed.argv.push(a.clone()),
        }
    }
    if help {
        if !parsed.cmd.is_empty() {
            parsed.argv = vec![std::mem::take(&mut parsed.cmd)];
        }
        parsed.cmd = "help".into();
    }
    Ok(parsed)
}

/// Opens the first of `names` that exists (targets), and says which, or the
/// failure code and why not. Only a name that doesn't exist passes to the
/// next: one that another account owns, or that stays busy, ends it there.
fn connect(names: &[String]) -> Result<(std::fs::File, String), (&'static str, String)> {
    connect_as(names, &pipe::current_user().map_err(|e| ("unreachable", e))?)
}

fn connect_as(names: &[String], user: &[u8]) -> Result<(std::fs::File, String), (&'static str, String)> {
    for name in names {
        match open(name, user) {
            Err(("not-running", _)) => continue,
            got => return got.map(|f| (f, name.clone())),
        }
    }
    Err(("not-running", format!("Loom isn't running, or not for this workspace ({}).", names.first().map_or("", |n| n.as_str()))))
}

/// The targets for this call, in order. Inside a pane LOOM_PIPE names the Loom
/// that owns it, exactly; --profile picks another workspace. Otherwise the
/// workspace's names (pipe::pipe_names): Loom's own, then a pre-SID Loom's.
fn targets(profile: Option<&str>, env_pipe: Option<String>) -> Vec<String> {
    match (profile, env_pipe) {
        (None, Some(pipe)) if !pipe.is_empty() => vec![pipe],
        (profile, _) => pipe::pipe_names(profile),
    }
}

/// Opens the pipe if `user` owns it, or the failure code and why not.
fn open(name: &str, user: &[u8]) -> Result<std::fs::File, (&'static str, String)> {
    for _ in 0..100 {
        match std::fs::OpenOptions::new().read(true).write(true).open(name) {
            Ok(f) => {
                let owner = pipe::owner_is(&f, user).map_err(|e| format!("can't tell who serves {name}: {e}"));
                return match owner {
                    Ok(true) => Ok(f),
                    Ok(false) => Err(("unreachable", format!("{name} belongs to another Windows account, not this Loom, so nothing was sent."))),
                    Err(e) => Err(("unreachable", e)),
                };
            }
            // All pipe instances are serving other commands: they free up in milliseconds.
            Err(e) if e.raw_os_error() == Some(231) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(("not-running", format!("Loom isn't running, or not for this workspace ({name}).")));
            }
            Err(e) => return Err(("unreachable", format!("can't reach Loom at {name}: {e}"))),
        }
    }
    Err(("busy", "Loom is busy; try again.".into()))
}

/// Every failure, one shape: under --json a single object on stdout with a
/// stable `code` and `sent`, whether the command reached Loom (if it did, it
/// may have run), plus what Loom said (`timeout`, `typed`, `pressed`). The
/// message goes to stderr either way. Returns the exit status.
fn fail(json: bool, code: &str, exit: i32, sent: bool, error: &str, from_loom: &Value) -> i32 {
    use std::sync::atomic::Ordering::SeqCst;
    if json {
        let stream = STREAM.load(SeqCst).then(|| STREAM_NEXT.load(SeqCst));
        say(&failure_text(code, sent, error, from_loom, stream), exit);
    }
    note(error);
    exit
}

/// One line to stdout. When its reader has gone (`| head -1`, a closed pipe,
/// ERROR_NO_DATA) there's no one left to tell: loomctl ends quietly with
/// `exit`, what it would have ended with anyway, instead of panicking.
fn say(text: &str, exit: i32) {
    if writeln!(std::io::stdout().lock(), "{text}").is_err() {
        std::process::exit(exit);
    }
}

/// A message to stderr, which may be closed too.
fn note(text: &str) {
    let _ = writeln!(std::io::stderr().lock(), "loomctl: {text}");
}

/// Set while `watch --follow --json` prints one JSON line per event, with the
/// number it would ask after next: a failure then ends the stream as one more
/// line, with that `next`, so every line parses on its own.
static STREAM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static STREAM_NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A failure as printed: pretty, or one line with `next` inside a stream.
fn failure_text(code: &str, sent: bool, error: &str, from_loom: &Value, stream: Option<u64>) -> String {
    let mut out = failure(code, sent, error, from_loom);
    match stream {
        Some(next) => {
            out["next"] = next.into();
            out.to_string()
        }
        None => serde_json::to_string_pretty(&out).unwrap_or_default(),
    }
}

fn failure(code: &str, sent: bool, error: &str, from_loom: &Value) -> Value {
    let mut out = from_loom.as_object().cloned().unwrap_or_default();
    out.extend([("ok".into(), json!(false)), ("code".into(), json!(code)), ("sent".into(), json!(sent)), ("error".into(), json!(error))]);
    Value::Object(out)
}

/// What to print for a successful answer: `--json` always prints JSON, `null`
/// included, so a consumer never gets empty output for a real answer.
fn render(reply: &Value, json: bool) -> Option<String> {
    let data = &reply["data"];
    if json {
        return Some(serde_json::to_string_pretty(data).unwrap_or_else(|_| "null".into()));
    }
    match reply["text"].as_str() {
        Some("") => None,
        Some(text) => Some(text.to_string()),
        None if data.is_null() => None,
        None => Some(serde_json::to_string_pretty(data).unwrap_or_default()),
    }
}

/// Checks the hello Loom sent back: same protocol, or why not.
fn greeted(hello: &Value) -> Result<(), String> {
    if hello["protocol"].as_u64().is_none() {
        // Loom from before the hello answers it as an unknown command, having run nothing.
        return Err("The running Loom is older than this loomctl. Restart Loom to finish the update.".into());
    }
    if hello["ok"] != json!(true) || hello["protocol"].as_u64() != Some(pipe::PROTOCOL) {
        return Err(hello["error"].as_str().unwrap_or("Loom and loomctl are different versions.").into());
    }
    Ok(())
}

/// Why a request didn't get an answer to print: the failure's `code`, the exit
/// status, whether the command had gone out, and what Loom said, if anything.
struct Failure {
    code: &'static str,
    exit: i32,
    sent: bool,
    error: String,
    from_loom: Value,
}

impl Failure {
    fn new(code: &'static str, exit: i32, sent: bool, error: impl Into<String>) -> Failure {
        Failure { code, exit, sent, error: error.into(), from_loom: Value::Null }
    }

    fn print(&self, json: bool) -> i32 {
        fail(json, self.code, self.exit, self.sent, &self.error, &self.from_loom)
    }
}

/// One connection to Loom: the hello, then `request` and Loom's answer to it
/// (or, with no request, the hello itself). The watchdog covers the hello,
/// then the answer, then stands down.
fn exchange(names: &[String], watch: &Watchdog, request: Option<&Value>, timeout: f64) -> Result<(Value, String), Failure> {
    watch.arm(timeout.min(HELLO_SECS));
    let (file, name) = connect(names).map_err(|(code, error)| Failure::new(code, 2, false, error))?;
    let mut reader = BufReader::new(&file);
    let mut read = || -> Result<Value, String> {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| format!("lost the connection to Loom: {e}"))?;
        serde_json::from_str(&line).map_err(|_| "Loom closed the connection without an answer".to_string())
    };
    let send = |message: &Value| (&file).write_all(format!("{message}\n").as_bytes());
    let hello = send(&json!({ "hello": pipe::PROTOCOL }))
        .map_err(|e| format!("lost the connection to Loom: {e}"))
        .and_then(|_| read())
        .map_err(|e| Failure::new("connection", 2, false, e))?;
    greeted(&hello).map_err(|e| Failure::new("version", 2, false, e))?;
    let Some(request) = request else {
        watch.done();
        return Ok((hello, name));
    };
    // Loom answers a timed-out request itself, 5 s after its limit. This is for
    // a Loom that stopped answering altogether.
    watch.sent(timeout + 20.0);
    // Loom runs only a request that arrived whole, with its newline, but a
    // failed write can't say how much got there, so this stays uncertain.
    send(request).map_err(|e| {
        let error = format!("lost the connection to Loom while sending the command ({e}). It may have reached Loom: check before trying again.");
        Failure::new("connection", 2, true, error)
    })?;
    let reply = read().map_err(|e| Failure::new("connection", 2, true, format!("{e}. The command may have run: check before trying again.")))?;
    watch.done();
    Ok((reply, name))
}

fn run(args: &[String]) -> i32 {
    let parsed = match parse(args) {
        Ok(p) => p,
        Err(e) => {
            let json = args.iter().take_while(|a| a.as_str() != "--").any(|a| a == "--json");
            return fail(json, "usage", 1, false, &e, &Value::Null);
        }
    };
    let json = parsed.json;
    if parsed.version {
        say(&format!("loomctl {}", env!("CARGO_PKG_VERSION")), 0);
        return 0;
    }
    if parsed.cmd.is_empty() {
        say(USAGE, 0);
        return 0;
    }
    let names = targets(parsed.profile.as_deref(), std::env::var("LOOM_PIPE").ok());
    // Before connecting, so a slow pipe into loomctl doesn't hold Loom's.
    let stdin = parsed.stdin.then(|| {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    });
    let timeout = parsed.timeout.unwrap_or(if LONG.contains(&parsed.cmd.as_str()) { 3600.0 } else { DEFAULT_TIMEOUT });
    let watch = Watchdog::start(json);
    if parsed.cmd == "info" {
        let (hello, via) = match exchange(&names, &watch, None, timeout) {
            Ok(got) => got,
            Err(f) => return f.print(json),
        };
        let info = json!({ "version": hello["version"], "protocol": hello["protocol"], "pid": hello["pid"], "pipe": hello["pipe"], "via": via });
        match json {
            true => say(&serde_json::to_string_pretty(&info).unwrap_or_default(), 0),
            false => say(&format!("Loom {} (protocol {}), process {}\nits own pipe: {}", hello["version"].as_str().unwrap_or("?"), hello["protocol"], hello["pid"], hello["pipe"].as_str().unwrap_or("?")), 0),
        }
        return 0;
    }
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    if parsed.cmd == "watch" && parsed.argv.iter().take_while(|a| a.as_str() != "--").any(|a| a == "--follow") {
        return follow(&parsed, &names, &watch, &cwd);
    }
    let request = json!({ "cmd": parsed.cmd, "argv": parsed.argv, "stdin": stdin, "cwd": cwd, "timeout": timeout, "key": parsed.key });
    let reply = match exchange(&names, &watch, Some(&request), timeout) {
        Ok((reply, _)) => reply,
        Err(f) => return f.print(json),
    };
    if reply["replayed"] == json!(true) {
        note("the answer to the earlier request with this --key; the command didn't run again.");
    }
    if reply["ok"] != json!(true) {
        let error = reply["error"].as_str().unwrap_or("the command failed");
        let (code, exit, sent) = failed_as(&reply);
        return fail(json, code, exit, sent, error, &reply);
    }
    if let Some(out) = render(&reply, json) {
        say(&out, 0);
    }
    0
}

/// A failure Loom answered, as `code`, exit status and whether the command
/// reached its window. `starting`: Loom hadn't passed it on yet, so nothing ran.
fn failed_as(reply: &Value) -> (&'static str, i32, bool) {
    if reply["starting"] == json!(true) {
        ("busy", 2, false)
    } else if reply["timeout"] == json!(true) {
        ("timeout", 3, true)
    } else {
        ("failed", 1, true)
    }
}

/// How long one `watch` asks Loom to hold an empty answer while following.
const FOLLOW_POLL: f64 = 25.0;

/// `watch --follow`: `watch` again and again, from the number the last answer
/// gave, printing each event once as it comes (one JSON line each with
/// --json). When Loom goes away it keeps trying every second from the same
/// number, so nothing is printed twice or skipped; Loom keeps the numbers in
/// its journal, so they hold across its restarts. Stops when the task it
/// follows has finished (exit 0), after --timeout seconds (exit 3), or on a
/// failure that retrying can't fix.
fn follow(parsed: &Parsed, names: &[String], watch: &Watchdog, cwd: &str) -> i32 {
    use std::sync::atomic::Ordering::SeqCst;
    let json = parsed.json;
    STREAM.store(json, SeqCst);
    let (mut argv, mut after) = (Vec::new(), Some(0u64));
    let mut words = parsed.argv.iter();
    while let Some(w) = words.next() {
        match w.as_str() {
            "--follow" => {}
            "--after" => after = words.next().and_then(|n| n.parse().ok()),
            _ if w.starts_with("--after=") => after = w["--after=".len()..].parse().ok(),
            _ => argv.push(w.clone()),
        }
    }
    let Some(mut after) = after else {
        return fail(json, "usage", 1, false, "--after takes the number of an event (0 for the first).", &Value::Null);
    };
    STREAM_NEXT.store(after, SeqCst);
    // Checked: parse caps --timeout, and a deadline past what an Instant holds means none.
    let end = parsed.timeout.and_then(|s| std::time::Duration::try_from_secs_f64(s).ok()).and_then(|d| std::time::Instant::now().checked_add(d));
    let mut lost = false;
    loop {
        let left = end.map_or(f64::INFINITY, |e| e.saturating_duration_since(std::time::Instant::now()).as_secs_f64());
        if left <= 0.0 {
            let error = format!("Followed for {} s; the next event after {after} hasn't come.", parsed.timeout.unwrap_or_default());
            return fail(json, "timeout", 3, true, &error, &json!({ "timeout": true }));
        }
        let mut words = argv.clone();
        words.extend(["--after".to_string(), after.to_string()]);
        let poll = left.min(FOLLOW_POLL).max(1.0);
        let request = json!({ "cmd": "watch", "argv": words, "stdin": null, "cwd": cwd, "timeout": poll, "key": null });
        match exchange(names, watch, Some(&request), poll).map(|(reply, _)| reply) {
            Ok(reply) if reply["ok"] == json!(true) => {
                if lost {
                    note(&format!("reached Loom again; going on after event {after}."));
                    lost = false;
                }
                let data = &reply["data"];
                if data["gap"] == json!(true) {
                    note(&format!("Loom no longer has every event after {after}: it keeps the last 500 finished tasks and 500 pane events, and pane events start over when Loom does."));
                }
                for e in data["events"].as_array().into_iter().flatten() {
                    match json {
                        true => say(&e.to_string(), 0),
                        false => say(&event_line(e), 0),
                    }
                }
                if let Some(next) = data["next"].as_u64() {
                    after = next;
                    STREAM_NEXT.store(next, SeqCst);
                }
                if data["done"] == json!(true) {
                    return 0;
                }
            }
            // Loom went away, restarted, is still starting, or its window missed
            // the watch (a reload): try again from the same number.
            Ok(reply) if reply["starting"] == json!(true) || reply["timeout"] == json!(true) => {
                if !lost {
                    let why = if reply["starting"] == json!(true) { "Loom is still starting." } else { "Loom's window didn't answer." };
                    note(&format!("{why} Trying again every second, after event {after}."));
                    lost = true;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            Ok(reply) => {
                let error = reply["error"].as_str().unwrap_or("watch failed");
                return fail(json, "failed", 1, true, error, &reply);
            }
            Err(f) if matches!(f.code, "connection" | "not-running" | "busy" | "unreachable") => {
                if !lost {
                    note(&format!("{} Trying again every second, after event {after}.", f.error));
                    lost = true;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            Err(f) => return f.print(json),
        }
    }
}

/// An event as `watch` prints it without --json: a task's, or a pane's (`watch --panes`).
fn event_line(e: &Value) -> String {
    let s = |k: &str| e[k].as_str().unwrap_or("").to_string();
    if e.get("old").is_some() {
        let asking = if e["asking"] == json!(true) { " (asking)" } else { "" };
        return format!("{}  {}  {}  {} -> {}{asking}  {}", e["seq"], s("at"), s("ref"), s("old"), s("state"), s("title"));
    }
    let detail = s("detail");
    format!("{}  {}  {}  {}  {}{}", e["seq"], s("at"), s("task"), s("state"), s("signal"), if detail.is_empty() { detail } else { format!("  {detail}") })
}

/// Loom answers the hello at once, from Rust: a Loom that doesn't is stuck.
const HELLO_SECS: f64 = 10.0;

/// Ends loomctl with a timeout if Loom stops answering, from before the hello
/// on. It says whether the command had gone out: before, nothing ran; after,
/// it may still finish.
struct Watchdog {
    start: std::time::Instant,
    deadline_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
    sent: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Watchdog {
    /// Stands by until `arm`.
    fn start(json: bool) -> Watchdog {
        use std::sync::atomic::Ordering::SeqCst;
        let start = std::time::Instant::now();
        let watch = Watchdog { start, deadline_ms: Default::default(), sent: Default::default() };
        watch.deadline_ms.store(u64::MAX, SeqCst);
        let (deadline, sent) = (watch.deadline_ms.clone(), watch.sent.clone());
        std::thread::spawn(move || loop {
            let (now, limit) = (start.elapsed().as_millis() as u64, deadline.load(SeqCst));
            if now >= limit {
                let sent = sent.load(SeqCst);
                let error = match sent {
                    true => "Loom didn't answer in time. The command may still finish: check before trying again.",
                    false => "Loom didn't answer loomctl's hello in time, so no command was sent.",
                };
                std::process::exit(fail(json, "timeout", 3, sent, error, &json!({ "timeout": true })));
            }
            std::thread::sleep(std::time::Duration::from_millis((limit - now).min(250)));
        });
        watch
    }

    /// A connection is about to open: nothing is sent yet, and the hello gets `secs`.
    fn arm(&self, secs: f64) {
        use std::sync::atomic::Ordering::SeqCst;
        self.sent.store(false, SeqCst);
        self.deadline_ms.store(self.after(secs), SeqCst);
    }

    /// The command is about to go out: from now on it may run, and Loom gets `secs` more.
    fn sent(&self, secs: f64) {
        use std::sync::atomic::Ordering::SeqCst;
        self.sent.store(true, SeqCst);
        self.deadline_ms.store(self.after(secs), SeqCst);
    }

    /// `secs` from now, in ms since start: saturating, so no `secs` overflows
    /// (in a debug build) or wraps into a deadline already past (in release).
    fn after(&self, secs: f64) -> u64 {
        (self.start.elapsed().as_millis() as u64).saturating_add((secs.clamp(0.0, MAX_TIMEOUT + 3600.0) * 1000.0) as u64)
    }

    fn done(&self) {
        self.deadline_ms.store(u64::MAX, std::sync::atomic::Ordering::SeqCst);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&args));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_counts_only_when_this_account_owns_it() {
        use windows::Win32::Security::{Authorization::ConvertStringSidToSidW, PSID, SID_AND_ATTRIBUTES, TOKEN_USER};
        let name = format!(r"\\.\pipe\loomctl-owner-test-{}", std::process::id());
        let _server = tauri::async_runtime::block_on(async {
            tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).create(&name)
        }).unwrap();
        let client = std::fs::OpenOptions::new().read(true).write(true).open(&name).unwrap();
        assert!(pipe::owner_is(&client, &pipe::current_user().unwrap()).unwrap(), "a pipe this account made is its own");
        // As if another account had made it first: SYSTEM stands in for that owner.
        let mut system = PSID::default();
        unsafe { ConvertStringSidToSidW(windows::core::w!("S-1-5-18"), &mut system).unwrap() };
        let other = TOKEN_USER { User: SID_AND_ATTRIBUTES { Sid: system, Attributes: 0 } };
        let other = unsafe { std::slice::from_raw_parts(&other as *const TOKEN_USER as *const u8, std::mem::size_of::<TOKEN_USER>()) };
        assert!(!pipe::owner_is(&client, other).unwrap(), "an owner that isn't this account is refused");
    }

    #[test]
    fn a_loom_from_before_the_sid_names_is_found_after_an_update() {
        use windows::Win32::Security::{Authorization::ConvertStringSidToSidW, PSID, SID_AND_ATTRIBUTES, TOKEN_USER};
        let id = std::process::id();
        let name = |what: &str| format!(r"\\.\pipe\loomctl-legacy-test-{what}-{id}");
        let serve = |n: &str| tauri::async_runtime::block_on(async { tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).create(n) }).unwrap();
        let me = pipe::current_user().unwrap();
        // Loom's own name first, the pre-SID one after it; LOOM_PIPE alone, unless --profile picks a workspace.
        let own = pipe::pipe_names(None);
        let user: String = std::env::var("USERNAME").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        assert_eq!(own[0], pipe::pipe_name(None));
        assert_eq!(own.last().unwrap(), &format!(r"\\.\pipe\{}-{user}", if cfg!(debug_assertions) { "loom-dev" } else { "loom" }));
        let work = pipe::pipe_names(Some(r"C:\Work\Client.json"));
        assert_eq!(work[0], pipe::pipe_name(Some(r"C:\Work\Client.json")));
        assert_eq!(work.last().unwrap().rsplit('-').next(), work[0].rsplit('-').next(), "both name the profile alike");
        assert_eq!(targets(None, Some(r"\\.\pipe\x".into())), [r"\\.\pipe\x"], "LOOM_PIPE is the one to use, with no fallback");
        assert_eq!(targets(Some(r"C:\Work\Client.json"), Some(r"\\.\pipe\x".into())), work, "--profile beats LOOM_PIPE");
        assert_eq!(targets(None, Some(String::new())), own);
        assert_eq!(targets(None, None), own);
        // Only the old name is served: found there.
        let (gone, old) = (name("new-a"), name("old-a"));
        let _old = serve(&old);
        assert_eq!(connect_as(&[gone.clone(), old.clone()], &me).unwrap().1, old);
        // Both served: Loom's own name wins.
        let (new, old2) = (name("new-b"), name("old-b"));
        let (_new, _old2) = (serve(&new), serve(&old2));
        assert_eq!(connect_as(&[new.clone(), old2], &me).unwrap().1, new);
        // The old name served by another account: refused, nothing sent, and nothing after it tried.
        let mut system = PSID::default();
        unsafe { ConvertStringSidToSidW(windows::core::w!("S-1-5-18"), &mut system).unwrap() };
        let other = TOKEN_USER { User: SID_AND_ATTRIBUTES { Sid: system, Attributes: 0 } };
        let other = unsafe { std::slice::from_raw_parts(&other as *const TOKEN_USER as *const u8, std::mem::size_of::<TOKEN_USER>()) };
        let (gone2, theirs, after) = (name("new-c"), name("old-c"), name("after-c"));
        let (_theirs, _after) = (serve(&theirs), serve(&after));
        let refused = connect_as(&[gone2.clone(), theirs.clone(), after], other).unwrap_err();
        assert_eq!(refused.0, "unreachable");
        assert!(refused.1.contains(&theirs) && refused.1.contains("another Windows account"), "{}", refused.1);
        // Neither served: not running, named by Loom's own name.
        let none = connect_as(&[gone2.clone(), name("old-d")], &me).unwrap_err();
        assert_eq!(none.0, "not-running");
        assert!(none.1.contains(&gone2), "{}", none.1);
    }

    fn p(words: &[&str]) -> Parsed {
        let args: Vec<String> = words.iter().map(|s| s.to_string()).collect();
        parse(&args).unwrap()
    }
    fn v(words: &[&str]) -> Vec<String> {
        words.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_command_and_its_words_go_through_untouched() {
        let x = p(&["send", "t1:2", "--no-enter", "echo", "hello"]);
        assert_eq!(x.cmd, "send");
        assert_eq!(x.argv, v(&["t1:2", "--no-enter", "echo", "hello"]));
        // A command's own options before its name stay its own.
        let x = p(&["--yes", "close", "alpha:2"]);
        assert_eq!(x.cmd, "close");
        assert_eq!(x.argv, v(&["--yes", "alpha:2"]));
    }

    #[test]
    fn a_timeout_too_long_is_a_usage_error_and_none_panics() {
        let t = |s: &str| parse(&v(&["--timeout", s, "watch"])).map(|p| p.timeout);
        assert_eq!(t("0.25"), Ok(Some(0.25)), "fractional seconds");
        assert_eq!(t("31536000"), Ok(Some(31_536_000.0)), "a year");
        for bad in ["31536000.5", "1e19", "1e300", "inf", "NaN", "0", "-1"] {
            assert!(t(bad).unwrap_err().contains("--timeout"), "{bad} was taken");
        }
        // Whatever reaches the deadlines saturates instead of overflowing or wrapping.
        let watch = Watchdog::start(true);
        watch.arm(f64::MAX);
        watch.sent(1e300);
        watch.done();
        // From the command line: a usage failure (exit 1, loomctl's JSON shape), before any connection.
        assert_eq!(run(&v(&["--profile", "loom-review-timeout-nonexistent", "--json", "--timeout", "1e300", "watch", "--follow"])), 1);
    }

    #[test]
    fn own_options_anywhere_but_not_after_double_dash() {
        let x = p(&["--json", "read", "--timeout", "5", "p1", "--profile=w.json"]);
        assert!(x.json);
        assert_eq!(x.timeout, Some(5.0));
        assert_eq!(x.profile.as_deref(), Some("w.json"));
        assert_eq!((x.cmd.as_str(), x.argv), ("read", v(&["p1"])));
        let x = p(&["send", "p1", "--", "--json", "-"]);
        assert!(!x.json);
        assert_eq!(x.argv, v(&["p1", "--", "--json", "-"]));
    }

    #[test]
    fn a_dash_stays_a_word_and_standard_input_goes_apart() {
        // Loom swaps the text in after parsing options, so stdin starting with -- stays text.
        let x = p(&["send", "p1", "-"]);
        assert!(x.stdin);
        assert_eq!(x.argv, v(&["p1", "-"]));
        let x = p(&["send", "p1", "--", "-"]);
        assert!(x.stdin);
        assert_eq!(x.argv, v(&["p1", "--", "-"]));
        assert!(!p(&["send", "p1", "a-b", "--x=-"]).stdin);
    }

    #[test]
    fn a_loom_on_another_protocol_is_refused_before_the_command() {
        assert!(greeted(&json!({ "ok": true, "protocol": pipe::PROTOCOL, "pid": 7 })).is_ok());
        // The first Loom answers the hello as an unknown command.
        let old = greeted(&json!({ "ok": false, "error": "Unknown command \"null\"." })).unwrap_err();
        assert!(old.contains("older than this loomctl"), "{old}");
        let refused = json!({ "ok": false, "protocol": pipe::PROTOCOL + 1, "error": "This loomctl is older than the running Loom." });
        assert_eq!(greeted(&refused).unwrap_err(), "This loomctl is older than the running Loom.");
    }

    #[test]
    fn help_and_bad_options() {
        assert_eq!((p(&["--help"]).cmd, p(&["--help"]).argv), ("help".to_string(), vec![]));
        let x = p(&["send", "--help"]);
        assert_eq!((x.cmd.as_str(), x.argv), ("help", v(&["send"])));
        assert_eq!(p(&["help", "send"]).argv, v(&["send"]));
        for bad in [&["read", "--timeout"][..], &["read", "--timeout", "soon"], &["read", "--timeout", "0"], &["--profile"]] {
            assert!(parse(&v(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_key_is_loomctls_own_option() {
        let x = p(&["--key", "job-7", "send", "p1", "hi"]);
        assert_eq!((x.key.as_deref(), x.argv), (Some("job-7"), v(&["p1", "hi"])));
        assert_eq!(p(&["send", "p1", "--key=job-8", "hi"]).key.as_deref(), Some("job-8"));
        assert_eq!(p(&["send", "p1", "--", "--key", "x"]).key, None);
        assert!(parse(&v(&["--key=", "status"])).is_err());
    }

    #[test]
    fn every_failure_has_one_shape() {
        let from_loom = json!({ "ok": false, "error": "Loom's words", "timeout": false, "typed": true });
        assert_eq!(
            failure("failed", true, "Loom's words", &from_loom),
            json!({ "ok": false, "code": "failed", "sent": true, "error": "Loom's words", "timeout": false, "typed": true })
        );
        assert_eq!(failure("usage", false, "bad", &Value::Null), json!({ "ok": false, "code": "usage", "sent": false, "error": "bad" }));
    }

    #[test]
    fn a_command_loom_never_passed_on_is_not_sent() {
        let starting = json!({ "ok": false, "starting": true, "error": "Loom is still starting. Try again in a moment." });
        assert_eq!(failed_as(&starting), ("busy", 2, false), "nothing reached the window, so nothing ran");
        assert_eq!(failed_as(&json!({ "ok": false, "timeout": true, "error": "x" })), ("timeout", 3, true));
        assert_eq!(failed_as(&json!({ "ok": false, "error": "x" })), ("failed", 1, true));
    }

    #[test]
    fn a_failure_in_a_stream_is_one_line_with_its_place() {
        // watch --follow --json: every line must parse alone, the last one too (review P2).
        let line = failure_text("timeout", true, "Followed for 3 s.", &json!({ "timeout": true }), Some(41));
        assert!(!line.contains('\n'), "{line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!((v["ok"].clone(), v["code"].clone(), v["next"].clone()), (json!(false), json!("timeout"), json!(41)));
        // Outside a stream, failures print as they always have.
        assert!(failure_text("failed", true, "x", &Value::Null, None).contains("\n  \"code\""));
    }

    #[test]
    fn json_prints_null_answers_and_text_stays_quiet() {
        let null = json!({ "ok": true, "data": null, "text": "Nobody is waiting." });
        assert_eq!(render(&null, true).as_deref(), Some("null"));
        assert_eq!(render(&null, false).as_deref(), Some("Nobody is waiting."));
        let silent = json!({ "ok": true, "data": { "pane": "p1" }, "text": "" });
        assert_eq!(render(&silent, false), None);
        assert!(render(&silent, true).unwrap().contains("\"pane\""));
    }
}
