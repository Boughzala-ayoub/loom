//! loomctl: control a running Loom from a terminal, a script or an agent in a
//! pane. It sends one command over Loom's control pipe (control.rs) and prints
//! the answer; the running Loom does the work, so the window shows it. A
//! console program, unlike loom.exe, so shells wait for it and get its exit
//! code. `loomctl help` asks the running Loom for its commands.
#[path = "../pipe.rs"]
mod pipe;

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Write};

const USAGE: &str = "loomctl: control a running Loom.

Usage: loomctl [--json] [--profile FILE] [--timeout SECONDS] <command> [args...]

  loomctl help            the commands the running Loom knows
  loomctl help <command>  one command's arguments

Options go anywhere: --key value, --key=value, or --flag on its own. After --,
every word is an argument. An argument of - is read from standard input.
Inside a Loom pane, loomctl talks to the Loom that owns the pane.

Exit codes: 0 done, 1 the command failed, 2 Loom isn't running, 3 timed out.";

/// Commands that wait for something get an hour unless told otherwise.
const LONG: [&str; 2] = ["wait", "wait-any"];

#[derive(Debug, PartialEq)]
struct Parsed {
    cmd: String,
    args: Map<String, Value>,
    json: bool,
    profile: Option<String>,
    timeout: Option<f64>,
}

fn parse(argv: &[String], stdin: &mut dyn FnMut() -> String) -> Result<Parsed, String> {
    let mut parsed = Parsed { cmd: String::new(), args: Map::new(), json: false, profile: None, timeout: None };
    let mut words = Vec::new();
    let mut rest = false;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        i += 1;
        if rest || !a.starts_with("--") || a == "--" {
            if a == "--" && !rest {
                rest = true;
            } else if a == "-" && !rest {
                words.push(Value::String(stdin()));
            } else if !rest && a == "-h" {
                parsed.cmd = "help".into();
            } else {
                words.push(Value::String(a.clone()));
            }
            continue;
        }
        let (key, inline) = match a[2..].split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (a[2..].to_string(), None),
        };
        let takes = |i: usize| argv.get(i).filter(|n| !n.starts_with("--") || n.as_str() == "--");
        match key.as_str() {
            "json" => parsed.json = true,
            "help" => parsed.cmd = "help".into(),
            "profile" | "timeout" => {
                let value = match inline {
                    Some(v) => v,
                    None => {
                        let v = takes(i).filter(|v| v.as_str() != "--").ok_or(format!("--{key} needs a value"))?.clone();
                        i += 1;
                        v
                    }
                };
                if key == "profile" {
                    parsed.profile = Some(value);
                } else {
                    parsed.timeout = Some(value.parse().map_err(|_| format!("--timeout needs seconds, not {value}"))?);
                }
            }
            _ => {
                let value = match inline {
                    Some(v) => Value::String(v),
                    None => match takes(i).filter(|v| v.as_str() != "--") {
                        Some(v) => {
                            i += 1;
                            Value::String(if v == "-" { stdin() } else { v.clone() })
                        }
                        None => Value::Bool(true),
                    },
                };
                parsed.args.insert(key, value);
            }
        }
    }
    let mut words = words.into_iter();
    if parsed.cmd.is_empty() {
        parsed.cmd = match words.next() {
            Some(Value::String(c)) => c,
            _ => String::new(),
        };
    }
    parsed.args.insert("_".into(), Value::Array(words.collect()));
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

fn run(argv: &[String]) -> i32 {
    let mut stdin = || {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    };
    let parsed = match parse(argv, &mut stdin) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("loomctl: {e}");
            return 1;
        }
    };
    if parsed.cmd.is_empty() {
        println!("{USAGE}");
        return 0;
    }
    if parsed.cmd == "--version" {
        println!("loomctl {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    // Inside a pane LOOM_PIPE names the Loom that owns it; --profile picks another.
    let name = match (&parsed.profile, std::env::var("LOOM_PIPE")) {
        (None, Ok(pipe)) if !pipe.is_empty() => pipe,
        (profile, _) => pipe::pipe_name(profile.as_deref()),
    };
    let mut file = match connect(&name) {
        Ok(f) => f,
        Err(code) => return code,
    };
    let timeout = parsed.timeout.or(LONG.contains(&parsed.cmd.as_str()).then_some(3600.0));
    let mut request = json!({ "cmd": parsed.cmd, "args": parsed.args });
    if let Some(t) = timeout {
        request["timeout"] = json!(t);
    }
    let mut reply = String::new();
    let sent = writeln!(file, "{request}").and_then(|_| file.flush()).and_then(|_| BufReader::new(&file).read_line(&mut reply));
    if let Err(e) = sent {
        eprintln!("loomctl: lost the connection to Loom: {e}");
        return 2;
    }
    let reply: Value = serde_json::from_str(&reply).unwrap_or_else(|_| json!({ "ok": false, "error": "Loom closed the connection without an answer." }));
    if reply["ok"] != json!(true) {
        eprintln!("loomctl: {}", reply["error"].as_str().unwrap_or("the command failed"));
        return if reply["timeout"] == json!(true) { 3 } else { 1 };
    }
    let data = &reply["data"];
    match (parsed.json, reply["text"].as_str()) {
        (false, Some(text)) => {
            if !text.is_empty() {
                println!("{text}");
            }
        }
        _ if !data.is_null() => println!("{}", serde_json::to_string_pretty(data).unwrap_or_default()),
        _ => {}
    }
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&argv));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(words: &[&str]) -> Parsed {
        let argv: Vec<String> = words.iter().map(|s| s.to_string()).collect();
        parse(&argv, &mut || "from stdin".to_string()).unwrap()
    }

    #[test]
    fn words_flags_and_values() {
        let x = p(&["send", "t1:2", "hello", "world", "--no-enter"]);
        assert_eq!(x.cmd, "send");
        assert_eq!(x.args["_"], json!(["t1:2", "hello", "world"]));
        assert_eq!(x.args["no-enter"], json!(true));
        let x = p(&["new", "C:\\repo", "--agent", "codex", "--name=fix it", "--panes", "2"]);
        assert_eq!(x.args["agent"], json!("codex"));
        assert_eq!(x.args["name"], json!("fix it"));
        assert_eq!(x.args["panes"], json!("2"));
        assert_eq!(x.args["_"], json!(["C:\\repo"]));
    }

    #[test]
    fn own_options_anywhere_and_the_rest_after_double_dash() {
        let x = p(&["--json", "read", "--timeout", "5", "p1", "--profile", "w.json"]);
        assert!(x.json);
        assert_eq!(x.timeout, Some(5.0));
        assert_eq!(x.profile.as_deref(), Some("w.json"));
        assert_eq!(x.args["_"], json!(["p1"]));
        let x = p(&["send", "p1", "--", "--not-a-flag", "-"]);
        assert_eq!(x.args["_"], json!(["p1", "--not-a-flag", "-"]));
    }

    #[test]
    fn a_dash_reads_standard_input() {
        let x = p(&["send", "p1", "-"]);
        assert_eq!(x.args["_"], json!(["p1", "from stdin"]));
        let x = p(&["send", "p1", "--text", "-"]);
        assert_eq!(x.args["text"], json!("from stdin"));
    }

    #[test]
    fn help_and_bad_options() {
        assert_eq!(p(&["--help"]).cmd, "help");
        assert_eq!(p(&["help", "send"]).args["_"], json!(["send"]));
        let argv = vec!["read".to_string(), "--timeout".to_string()];
        assert!(parse(&argv, &mut String::new).is_err());
    }
}
