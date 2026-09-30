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
the Loom that owns the pane. With --json, a failure prints its answer as JSON
too; \"typed\": true there means text reached the pane but Enter wasn't pressed.

Exit codes: 0 done, 1 the command failed, 2 Loom isn't running or is a
different version, 3 timed out.";

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

fn connect(name: &str) -> Result<std::fs::File, i32> {
    for _ in 0..100 {
        match std::fs::OpenOptions::new().read(true).write(true).open(name) {
            Ok(f) => return Ok(f),
            // All pipe instances are serving other commands: they free up in milliseconds.
            Err(e) if e.raw_os_error() == Some(231) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("loomctl: Loom isn't running, or not for this workspace ({name}).");
                return Err(2);
            }
            Err(e) => {
                eprintln!("loomctl: can't reach Loom at {name}: {e}");
                return Err(2);
            }
        }
    }
    eprintln!("loomctl: Loom is busy; try again.");
    Err(2)
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
            eprintln!("loomctl: {e}");
            return 1;
        }
    };
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
    let file = match connect(&name) {
        Ok(f) => f,
        Err(code) => return code,
    };
    let mut reader = BufReader::new(&file);
    let mut exchange = |message: Value| -> Result<Value, String> {
        let mut line = String::new();
        writeln!(&file, "{message}").and_then(|_| (&file).flush()).and_then(|_| reader.read_line(&mut line)).map_err(|e| format!("lost the connection to Loom: {e}"))?;
        Ok(serde_json::from_str(&line).unwrap_or_else(|_| json!({ "ok": false, "error": "Loom closed the connection without an answer." })))
    };
    let hello = match exchange(json!({ "hello": pipe::PROTOCOL })) {
        Ok(hello) => hello,
        Err(e) => {
            eprintln!("loomctl: {e}");
            return 2;
        }
    };
    if let Err(e) = greeted(&hello) {
        eprintln!("loomctl: {e}");
        return 2;
    }
    if parsed.cmd == "info" {
        let info = json!({ "version": hello["version"], "protocol": hello["protocol"], "pid": hello["pid"], "pipe": hello["pipe"], "via": name });
        match parsed.json {
            true => println!("{}", serde_json::to_string_pretty(&info).unwrap_or_default()),
            false => println!("Loom {} (protocol {}), process {}\nits own pipe: {}", hello["version"].as_str().unwrap_or("?"), hello["protocol"], hello["pid"], hello["pipe"].as_str().unwrap_or("?")),
        }
        return 0;
    }
    let timeout = parsed.timeout.unwrap_or(if LONG.contains(&parsed.cmd.as_str()) { 3600.0 } else { DEFAULT_TIMEOUT });
    // Loom answers a timed-out request itself, 5 s after its limit. This is for
    // a Loom that stopped answering altogether. A command already running may
    // still finish after either.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs_f64(timeout + 20.0));
        eprintln!("loomctl: Loom didn't answer within {timeout} s. The command may still finish.");
        std::process::exit(3);
    });
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let request = json!({ "cmd": parsed.cmd, "argv": parsed.argv, "stdin": stdin, "cwd": cwd, "timeout": timeout });
    let reply = match exchange(request) {
        Ok(reply) => reply,
        Err(e) => {
            eprintln!("loomctl: {e}");
            return 2;
        }
    };
    if reply["ok"] != json!(true) {
        if parsed.json {
            println!("{}", serde_json::to_string_pretty(&reply).unwrap_or_default());
        }
        eprintln!("loomctl: {}", reply["error"].as_str().unwrap_or("the command failed"));
        return if reply["timeout"] == json!(true) { 3 } else { 1 };
    }
    if let Some(out) = render(&reply, parsed.json) {
        println!("{out}");
    }
    0
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
    fn json_prints_null_answers_and_text_stays_quiet() {
        let null = json!({ "ok": true, "data": null, "text": "Nobody is waiting." });
        assert_eq!(render(&null, true).as_deref(), Some("null"));
        assert_eq!(render(&null, false).as_deref(), Some("Nobody is waiting."));
        let silent = json!({ "ok": true, "data": { "pane": "p1" }, "text": "" });
        assert_eq!(render(&silent, false), None);
        assert!(render(&silent, true).unwrap().contains("\"pane\""));
    }
}
