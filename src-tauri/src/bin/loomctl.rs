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

Usage: loomctl [--json] [--profile FILE] [--timeout SECONDS] <command> [args...]

  loomctl help            the commands the running Loom knows
  loomctl help <command>  one command's arguments
  loomctl info            which Loom answers: its version, process and own pipe

Put a command's own options after it: --name value, --name=value, or --flag.
After --, every word is an argument. An argument of - is standard input, sent
as it is: text starting with -- stays text. Inside a Loom pane, loomctl talks to
the Loom that owns the pane.

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
    /// An argument is `-`: standard input goes with the request, apart from
    /// the words, so Loom never parses it as options.
    stdin: bool,
}

fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut parsed = Parsed { cmd: String::new(), argv: Vec::new(), json: false, profile: None, timeout: None, version: false, stdin: false };
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
    if json {
        println!("{}", serde_json::to_string_pretty(&failure(code, sent, error, from_loom)).unwrap_or_default());
    }
    eprintln!("loomctl: {error}");
    exit
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
    let watch = Watchdog::start(json, timeout.min(HELLO_SECS));
    let file = match connect(&name) {
        Ok(f) => f,
        Err((code, error)) => return fail(json, code, 2, false, &error, &Value::Null),
    };
    let mut reader = BufReader::new(&file);
    let mut read = || -> Result<Value, String> {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| format!("lost the connection to Loom: {e}"))?;
        serde_json::from_str(&line).map_err(|_| "Loom closed the connection without an answer".to_string())
    };
    let send = |message: Value| (&file).write_all(format!("{message}\n").as_bytes());
    let hello = match send(json!({ "hello": pipe::PROTOCOL })).map_err(|e| format!("lost the connection to Loom: {e}")).and_then(|_| read()) {
        Ok(hello) => hello,
        Err(e) => return fail(json, "connection", 2, false, &e, &Value::Null),
    };
    if let Err(e) = greeted(&hello) {
        return fail(json, "version", 2, false, &e, &Value::Null);
    }
    if parsed.cmd == "info" {
        let info = json!({ "version": hello["version"], "protocol": hello["protocol"], "pid": hello["pid"], "pipe": hello["pipe"], "via": name });
        match json {
            true => println!("{}", serde_json::to_string_pretty(&info).unwrap_or_default()),
            false => println!("Loom {} (protocol {}), process {}\nits own pipe: {}", hello["version"].as_str().unwrap_or("?"), hello["protocol"], hello["pid"], hello["pipe"].as_str().unwrap_or("?")),
        }
        return 0;
    }
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let request = json!({ "cmd": parsed.cmd, "argv": parsed.argv, "stdin": stdin, "cwd": cwd, "timeout": timeout });
    // Loom answers a timed-out request itself, 5 s after its limit. This is for
    // a Loom that stopped answering altogether.
    watch.sent(timeout + 20.0);
    if let Err(e) = send(request) {
        // Loom runs only a request that arrived whole, with its newline, but a
        // failed write can't say how much got there, so this stays uncertain.
        let error = format!("lost the connection to Loom while sending the command ({e}). It may have reached Loom: check before trying again.");
        return fail(json, "connection", 2, true, &error, &Value::Null);
    }
    let reply = match read() {
        Ok(reply) => reply,
        Err(e) => return fail(json, "connection", 2, true, &format!("{e}. The command may have run: check before trying again."), &Value::Null),
    };
    watch.done();
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
    fn start(json: bool, secs: f64) -> Watchdog {
        use std::sync::atomic::Ordering::SeqCst;
        let start = std::time::Instant::now();
        let watch = Watchdog { start, deadline_ms: Default::default(), sent: Default::default() };
        watch.deadline_ms.store((secs * 1000.0) as u64, SeqCst);
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
    fn every_failure_has_one_shape() {
        let from_loom = json!({ "ok": false, "error": "Loom's words", "timeout": false, "typed": true });
        assert_eq!(
            failure("failed", true, "Loom's words", &from_loom),
            json!({ "ok": false, "code": "failed", "sent": true, "error": "Loom's words", "timeout": false, "typed": true })
        );
        assert_eq!(failure("usage", false, "bad", &Value::Null), json!({ "ok": false, "code": "usage", "sent": false, "error": "bad" }));
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
