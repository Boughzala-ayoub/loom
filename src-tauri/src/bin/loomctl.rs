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

--key NAME makes a retry safe: Loom runs a key once. The same command again
with that key gets the first answer, failures included, waiting for it if the
first is still running. The same key with another command is refused. A key
stays while its command runs; Loom keeps the last 256 finished ones until it
exits, and submit's in its task journal across restarts.

loomctl watch --follow prints task events as they come, one JSON line each
with --json, and reconnects when Loom goes away, from the last one it printed.
On a task it stops once the task is finished. A failure that ends it is one
more JSON line, with \"next\", the event number to resume from.

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
                if !(secs > 0.0 && secs.is_finite()) {
                    return Err(format!("--timeout needs seconds, not {v}"));
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

/// Opens the pipe, or the failure code and why not.
fn connect(name: &str) -> Result<std::fs::File, (&'static str, String)> {
    for _ in 0..100 {
        match std::fs::OpenOptions::new().read(true).write(true).open(name) {
            Ok(f) => return Ok(f),
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
        println!("{}", failure_text(code, sent, error, from_loom, stream));
    }
    eprintln!("loomctl: {error}");
    exit
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
fn exchange(name: &str, watch: &Watchdog, request: Option<&Value>, timeout: f64) -> Result<Value, Failure> {
    watch.arm(timeout.min(HELLO_SECS));
    let file = connect(name).map_err(|(code, error)| Failure::new(code, 2, false, error))?;
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
        return Ok(hello);
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
    Ok(reply)
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
        println!("loomctl {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if parsed.cmd.is_empty() {
        println!("{USAGE}");
        return 0;
    }
    // Inside a pane LOOM_PIPE names the Loom that owns it; --profile picks another.
    let name = match (&parsed.profile, std::env::var("LOOM_PIPE")) {
        (None, Ok(pipe)) if !pipe.is_empty() => pipe,
        (profile, _) => pipe::pipe_name(profile.as_deref()),
    };
    // Before connecting, so a slow pipe into loomctl doesn't hold Loom's.
    let stdin = parsed.stdin.then(|| {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    });
    let timeout = parsed.timeout.unwrap_or(if LONG.contains(&parsed.cmd.as_str()) { 3600.0 } else { DEFAULT_TIMEOUT });
    let watch = Watchdog::start(json);
    if parsed.cmd == "info" {
        let hello = match exchange(&name, &watch, None, timeout) {
            Ok(hello) => hello,
            Err(f) => return f.print(json),
        };
        let info = json!({ "version": hello["version"], "protocol": hello["protocol"], "pid": hello["pid"], "pipe": hello["pipe"], "via": name });
        match json {
            true => println!("{}", serde_json::to_string_pretty(&info).unwrap_or_default()),
            false => println!("Loom {} (protocol {}), process {}\nits own pipe: {}", hello["version"].as_str().unwrap_or("?"), hello["protocol"], hello["pid"], hello["pipe"].as_str().unwrap_or("?")),
        }
        return 0;
    }
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    if parsed.cmd == "watch" && parsed.argv.iter().take_while(|a| a.as_str() != "--").any(|a| a == "--follow") {
        return follow(&parsed, &name, &watch, &cwd);
    }
    let request = json!({ "cmd": parsed.cmd, "argv": parsed.argv, "stdin": stdin, "cwd": cwd, "timeout": timeout, "key": parsed.key });
    let reply = match exchange(&name, &watch, Some(&request), timeout) {
        Ok(reply) => reply,
        Err(f) => return f.print(json),
    };
    if reply["replayed"] == json!(true) {
        eprintln!("loomctl: the answer to the earlier request with this --key; the command didn't run again.");
    }
    if reply["ok"] != json!(true) {
        let error = reply["error"].as_str().unwrap_or("the command failed");
        return match reply["timeout"] == json!(true) {
            true => fail(json, "timeout", 3, true, error, &reply),
            false => fail(json, "failed", 1, true, error, &reply),
        };
    }
    if let Some(out) = render(&reply, json) {
        println!("{out}");
    }
    0
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
fn follow(parsed: &Parsed, name: &str, watch: &Watchdog, cwd: &str) -> i32 {
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
    let end = parsed.timeout.map(|s| std::time::Instant::now() + std::time::Duration::from_secs_f64(s));
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
        match exchange(name, watch, Some(&request), poll) {
            Ok(reply) if reply["ok"] == json!(true) => {
                if lost {
                    eprintln!("loomctl: reached Loom again; going on after event {after}.");
                    lost = false;
                }
                let data = &reply["data"];
                if data["gap"] == json!(true) {
                    eprintln!("loomctl: Loom no longer has every event after {after} (it keeps the last 500 finished tasks), or its journal started over.");
                }
                for e in data["events"].as_array().into_iter().flatten() {
                    match json {
                        true => println!("{e}"),
                        false => println!("{}", event_line(e)),
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
            // Loom went away, restarted, or is still starting: try again from the same number.
            Ok(reply) if reply["starting"] == json!(true) => {
                if !lost {
                    eprintln!("loomctl: Loom is still starting. Trying again every second, after event {after}.");
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
                    eprintln!("loomctl: {} Trying again every second, after event {after}.", f.error);
                    lost = true;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            Err(f) => return f.print(json),
        }
    }
}

/// An event as `watch` prints it without --json.
fn event_line(e: &Value) -> String {
    let s = |k: &str| e[k].as_str().unwrap_or("").to_string();
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
        self.deadline_ms.store(self.start.elapsed().as_millis() as u64 + (secs * 1000.0) as u64, SeqCst);
    }

    /// The command is about to go out: from now on it may run, and Loom gets `secs` more.
    fn sent(&self, secs: f64) {
        use std::sync::atomic::Ordering::SeqCst;
        self.sent.store(true, SeqCst);
        self.deadline_ms.store(self.start.elapsed().as_millis() as u64 + (secs * 1000.0) as u64, SeqCst);
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
