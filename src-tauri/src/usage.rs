//! What each pane's Claude session has spent, read from Claude Code's own logs.
//!
//! Every `claude` pane boots with `--session-id <sid>` (see session.ts) and Claude
//! Code writes that session to `~/.claude/projects/<slug of cwd>/<sid>.jsonl` — so
//! a pane's transcript is already addressable and nothing extra has to be recorded
//! to find it. The file is append-only, so each poll folds in only the bytes added
//! since the last one; an idle pane costs one metadata() call.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

/// One session's numbers. Tokens accumulate over the whole session; `ctx` is the
/// live context — what the most recent turn actually sent.
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    ctx: u64,
    window: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    turns: u64,
    /// Turns the main thread actually ran — no subagents, no synthetics. What a
    /// setting has to be overtaken by before it stops being the current one.
    main_turns: u64,
    /// The session actually being written, which is not always the one the pane
    /// was launched with — the caller re-pins itself to this.
    sid: String,
    /// What the last turn actually ran as, for the pane's config panel.
    model: String,
    effort: String,
    /// What the statusline tee says the pane runs RIGHT NOW — ahead of the
    /// transcript, which only learns at the next turn. Follows a /model typed
    /// by hand the moment it runs. Empty until the tee has fired.
    live_model: String,
    live_effort: String,
}
/// transcript path -> (bytes already folded in, totals so far). Keyed by path,
/// not pane or session: a pane that moves to a new session gets a new entry and
/// starts counting from zero, which is what it should do. Grows by one entry per
/// session opened in a run; nothing to evict at that scale.
#[derive(Default)]
pub struct Scanned(Mutex<HashMap<String, (u64, Usage)>>);

/// Only the fields worth adding up. Any other record shape fails to deserialize
/// and is skipped — which is also what rejects a user message that merely says
/// the word "usage".
#[derive(serde::Deserialize)]
struct Rec {
    #[serde(default, rename = "isSidechain")]
    sidechain: bool,
    /// What `/effort` is set to for the turn — recorded per record, so this
    /// follows a change made mid-session.
    #[serde(default)]
    effort: String,
    message: Msg,
}
#[derive(serde::Deserialize)]
struct Msg {
    #[serde(default)]
    model: String,
    usage: Tok,
}
#[derive(serde::Deserialize)]
struct Tok {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Claude Code's folder name for a working directory: every character that isn't
/// a letter or digit becomes `-` (`C:\Users\x\proj` → `C--Users-x-proj`).
fn slug(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Whether claude ever wrote the session a pane is pinned to. Decides resume vs
/// fresh at boot: `claude --resume` on an id nothing was written under exits,
/// and a pane opened and never typed into is exactly that.
#[tauri::command]
pub fn has_session(dir: String, sid: String) -> bool {
    let home: PathBuf = std::env::var_os("USERPROFILE")
        .map(Into::into)
        .unwrap_or_default();
    home.join(".claude/projects")
        .join(slug(&dir))
        .join(format!("{sid}.jsonl"))
        .is_file()
}

/// Whether the pane's claude is up: its SessionStart hook has written the
/// loom-tx marker. Pane ids are fresh every launch, so any marker is this boot's.
#[tauri::command]
pub fn pane_booted(pane: String) -> bool {
    std::env::temp_dir().join("loom-tx").join(pane).is_file()
}

/// 200k, or the big window when the configured model asks for one. A `/model`
/// typed inside a running session isn't written to disk anywhere, so it isn't
/// seen here — `session_usage` widens the window if a session outgrows it.
// ponytail: substring, not a JSON parse. "[1m]" only ever appears in a model id.
fn context_window(home: &Path) -> u64 {
    let cfg = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap_or_default();
    if cfg.contains("[1m]") {
        1_000_000
    } else {
        200_000
    }
}

/// Which transcript a pane is really on.
///
/// What claude reported on its way up beats what we asked it for: the pinned
/// session id stops being true the moment the session is cleared or claude is
/// relaunched by hand, and the gauge then reads a file nobody is writing to any
/// more. The marker comes from the SessionStart hook in claude-hooks.json;
/// falling back to the pinned id covers panes started before that existed, and
/// panes where claude was launched without Loom's --settings.
pub(crate) fn transcript(marks: &Path, home: &Path, pane: &str, dir: &str, sid: &str) -> PathBuf {
    std::fs::read_to_string(marks.join(pane))
        .map(|p| PathBuf::from(p.trim()))
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| {
            home.join(".claude/projects")
                .join(slug(dir))
                .join(format!("{sid}.jsonl"))
        })
}

/// Fold the lines appended since `off` into `u`. Whole lines only: a record still
/// being written is left for the next call.
fn scan(path: &Path, off: &mut u64, u: &mut Usage) -> std::io::Result<()> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    // Shorter than last time = a different file under the same name, so the
    // totals we hold describe something that no longer exists.
    if len < *off {
        *off = 0;
        *u = Usage::default();
    }
    if len == *off {
        return Ok(());
    }
    f.seek(SeekFrom::Start(*off))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)?; // offsets always land after a newline, so this stays valid UTF-8
    let end = buf.rfind('\n').map_or(0, |i| i + 1);
    for line in buf[..end].lines() {
        // Cheap gate first: most bytes in a transcript are tool output.
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(r) = serde_json::from_str::<Rec>(line) else {
            continue;
        };
        let Rec {
            sidechain,
            effort,
            message: Msg { model, usage: t },
        } = r;
        // A "<synthetic>" record — what a slash command or an interrupt leaves
        // behind — reports an all-zero usage and no model. Folding one in zeroes
        // the context gauge and, worse, looks like a turn ran, which throws away
        // a setting the pane was just given. It is not a turn: skip it whole.
        if model.starts_with('<') {
            continue;
        }
        u.turns += 1;
        u.input += t.input_tokens;
        u.output += t.output_tokens;
        u.cache_read += t.cache_read_input_tokens;
        u.cache_write += t.cache_creation_input_tokens;
        // A subagent's turn carries a context of its own — counting it as the
        // pane's would read as the conversation suddenly shrinking. Same for the
        // model and effort it ran under.
        if !sidechain {
            // Counted apart from `turns`: a subagent spends tokens without
            // changing what the main thread runs as, so only this says whether
            // a setting has actually been overtaken.
            u.main_turns += 1;
            u.ctx = t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;
            if !model.is_empty() {
                u.model = model;
            }
            if !effort.is_empty() {
                u.effort = effort;
            }
        }
    }
    *off += end as u64;
    Ok(())
}

/// What the pane's claude runs right now. `found` = the tee has fired at all,
/// which is what says claude is up before it has answered anything.
#[derive(Default)]
struct Live {
    found: bool,
    model: String,
    effort: String,
    /// Live context and the running model's real window. `ctx` is 0 until the
    /// first turn — the payload carries no usage before one.
    ctx: u64,
    window: u64,
}

/// What the pane's claude runs right now, per the statusline tee's marker
/// (loom-status.ps1): line 1 is the CLAUDE_EFFORT env fallback, the rest the
/// payload Claude Code pushes on every state change. The payload's own
/// effort.level wins when present. Missing marker = tee never fired (claude
/// launched without Loom's --settings) — empty, and the transcript stands.
fn live_status(dir: &Path, pane: &str) -> Live {
    #[derive(Default, serde::Deserialize)]
    struct P {
        #[serde(default)]
        model: M,
        #[serde(default)]
        effort: E,
        #[serde(default)]
        context_window: C,
    }
    #[derive(Default, serde::Deserialize)]
    struct M {
        #[serde(default)]
        id: String,
    }
    #[derive(Default, serde::Deserialize)]
    struct E {
        #[serde(default)]
        level: String,
    }
    #[derive(Default, serde::Deserialize)]
    struct C {
        #[serde(default)]
        total_input_tokens: u64,
        #[serde(default)]
        context_window_size: u64,
    }
    let Ok(raw) = std::fs::read_to_string(dir.join(pane)) else {
        return Live::default();
    };
    let raw = raw.trim_start_matches('\u{feff}'); // Set-Content utf8 adds a BOM
    let (env_effort, payload) = raw.split_once('\n').unwrap_or(("", raw));
    let p: P = serde_json::from_str(payload).unwrap_or_default();
    Live {
        found: true,
        effort: if p.effort.level.is_empty() {
            env_effort.trim().to_string()
        } else {
            p.effort.level
        },
        model: p.model.id,
        // What the last turn sent, the same sum the transcript scan computes.
        ctx: p.context_window.total_input_tokens,
        window: p.context_window.context_window_size,
    }
}

/// `(pane id, cwd, session id)` in, usage per pane id out. A pane running claude
/// is answered from the moment it comes up, at zero; one that isn't — no
/// statusline marker, no transcript — is left out, which is what hides the gauge
/// on a plain shell.
pub fn session_usage(
    state: State<Scanned>,
    panes: Vec<(String, String, String)>,
) -> HashMap<String, Usage> {
    let home: PathBuf = std::env::var_os("USERPROFILE")
        .map(Into::into)
        .unwrap_or_default();
    // ponytail: markers are keyed by pane id, which is regenerated every launch,
    // so dead ones linger. They're a path each, and %TEMP% gets swept anyway —
    // clearing them here would break a second Loom running beside this one.
    let marks = std::env::temp_dir().join("loom-tx");
    let statuses = std::env::temp_dir().join("loom-status");
    let window = context_window(&home);
    let mut seen = state.0.lock().unwrap();
    let mut out = HashMap::new();
    for (id, dir, sid) in panes {
        let live = live_status(&statuses, &id);
        let path = transcript(&marks, &home, &id, &dir, &sid);
        let (off, u) = seen.entry(path.to_string_lossy().into_owned()).or_default();
        let read = scan(&path, off, u).is_ok();
        // The tee fires the moment claude comes up, so a pane that has it is a
        // claude pane and gets a gauge — at 0% until the first turn. Without it,
        // a transcript with a turn in it is the only evidence claude is there;
        // neither = a plain shell, and no gauge, which is the point.
        if !live.found && (!read || u.turns == 0) {
            continue;
        }
        u.sid = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        // On the clone, not the cache: the marker is current state, re-read
        // whole every poll, while the cache accumulates transcript history.
        let mut u = u.clone();
        // The payload names the running model's own window and its live context,
        // so it beats both the transcript (a poll behind) and the settings.json
        // guess (global, and blind to a /model typed into this pane).
        u.window = match live.window {
            0 if u.ctx > window => 1_000_000, // outgrew it = switched with /model
            0 => window,
            w => w,
        };
        // A window means the payload carried context at all — older Claude Code
        // versions don't, and there the transcript stays the only source.
        if live.window > 0 {
            u.ctx = live.ctx;
        }
        (u.live_model, u.live_effort) = (live.model, live.effort);
        out.insert(id, u);
    }
    out
}

// --- context profile ------------------------------------------------------
// The gauge says how full the window is; this says what filled it. A separate
// read from `scan` on purpose: that one skips every line without "usage", which
// is most of the file and exactly the lines this needs — so the 4s poll stays
// cheap and this is read whole, once, when the panel opens.

/// One origin and how much it has poured into the conversation, at 4 chars a
/// token.
///
/// This is what the origin *produced* over the session, not what is in the
/// window right now — the two are not the same and the transcript only holds the
/// first. Claude Code prunes the request it actually sends (old file reads go,
/// superseded ones go) and records nothing about what it dropped, so summing the
/// log overshoots the live context several times over. Measured here: 3.4M
/// produced against a 716k window, and no recency rule fits — the reach back to
/// a real context ranged 7%..48% of the messages across four sessions. Anything
/// claiming to break down the live window would be guessing at an undocumented
/// pruner and would break on the next Claude Code release. What this answers
/// instead — which tool is generating the material you keep paying to re-cache —
/// is well defined and stable.
#[derive(serde::Serialize)]
pub struct Bucket {
    label: String,
    tokens: u64,
}

/// A compaction: what the context was just before, and what survived it.
#[derive(serde::Serialize)]
pub struct Drop {
    trigger: String,
    pre: u64,
    post: u64,
    /// Where in `series` it landed, so the drop is drawn where it happened.
    turn: usize,
}

#[derive(serde::Serialize)]
pub struct Profile {
    buckets: Vec<Bucket>,
    /// Context size per main-thread turn, oldest first. Exact — straight off the
    /// usage each turn reported, no estimating.
    series: Vec<u64>,
    drops: Vec<Drop>,
    /// The live context, exact, straight off the last turn — what the gauge
    /// shows. `est` is what the buckets add up to, which is a different quantity
    /// (see `Bucket`): everything produced, not what survived into the window.
    ctx: u64,
    est: u64,
}

/// 4 chars a token, the usual rule of thumb. Bytes rather than chars: non-ASCII
/// costs more tokens per character too, so counting it heavier is closer, not
/// further, and it saves walking the string.
fn est(s: &str) -> u64 {
    (s.len() as u64).div_ceil(4)
}

/// What a payload costs. Text costs its text; anything structured costs its JSON,
/// which is how a tool's input and a tool_result's blocks are actually sent.
fn weight(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::String(s) => est(s),
        serde_json::Value::Null => 0,
        other => est(&other.to_string()),
    }
}

/// Break a transcript down by where its tokens came from, and pull out the two
/// things about the window that *are* exact: its size at every turn, and every
/// compaction that emptied it.
fn profile_of(path: &Path) -> std::io::Result<Profile> {
    let raw = std::fs::read_to_string(path)?;
    let mut by: HashMap<String, u64> = HashMap::new();
    // tool_use id -> the tool's name, so a result is charged to the tool that
    // produced it ("Read", not "tool_result"). Never cleared: a result always
    // follows its call, so the pairs can't span a compaction.
    let mut tools: HashMap<String, String> = HashMap::new();
    let mut series: Vec<u64> = Vec::new();
    let mut drops: Vec<Drop> = Vec::new();
    let mut ctx = 0u64;
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // A subagent's messages never entered this conversation's window.
        if v["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        if v["subtype"] == "compact_boundary" {
            let m = &v["compactMetadata"];
            drops.push(Drop {
                trigger: m["trigger"].as_str().unwrap_or("auto").to_string(),
                pre: m["preTokens"].as_u64().unwrap_or(0),
                post: m["postTokens"].as_u64().unwrap_or(0),
                turn: series.len(),
            });
            // No reset of `by`: the buckets are what the session has produced,
            // and a compaction doesn't un-produce it. What it emptied is the
            // window, and the drop above is the exact record of that.
            continue;
        }
        // Injected context: skill listings, hook output, file attachments, task
        // reminders. Nobody typed these and no tool was called for them, which is
        // the point of giving them their own rows. The record is its content plus
        // a few short keys, so the whole line is a fair estimate of it.
        if let Some(t) = v["attachment"]["type"].as_str() {
            *by.entry(t.replace('_', " ")).or_default() += est(line);
            continue;
        }
        let msg = &v["message"];
        let user = v["type"] == "user";
        match &msg["content"] {
            // A plain string is either something you typed or, after a
            // compaction, the summary standing in for everything that was lost.
            serde_json::Value::String(s) => {
                let label = if v["isCompactSummary"].as_bool().unwrap_or(false) {
                    "compact summary"
                } else {
                    "you"
                };
                *by.entry(label.into()).or_default() += est(s);
            }
            serde_json::Value::Array(blocks) => {
                for b in blocks {
                    let (label, tokens) = match b["type"].as_str().unwrap_or("") {
                        "text" => (if user { "you" } else { "assistant" }.to_string(), weight(&b["text"])),
                        "thinking" => ("thinking".to_string(), weight(&b["thinking"])),
                        "tool_use" => {
                            // An MCP tool is named mcp__<server>__<tool>, which is
                            // three quarters plumbing and runs off the end of the
                            // legend. The tool's own name is the readable part.
                            let full = b["name"].as_str().unwrap_or("tool");
                            let name = match full.strip_prefix("mcp__").and_then(|r| r.rsplit_once("__")) {
                                Some((_, tool)) => tool.to_string(),
                                None => full.to_string(),
                            };
                            if let Some(id) = b["id"].as_str() {
                                tools.insert(id.to_string(), name.clone());
                            }
                            (name, weight(&b["input"]))
                        }
                        "tool_result" => (
                            b["tool_use_id"]
                                .as_str()
                                .and_then(|i| tools.get(i))
                                .cloned()
                                .unwrap_or_else(|| "tool".into()),
                            weight(&b["content"]),
                        ),
                        // ponytail: a flat guess. Images cost by area and the
                        // transcript carries base64, not dimensions — measuring it
                        // properly means decoding the PNG header of every one.
                        "image" => ("images".to_string(), 1600),
                        _ => continue,
                    };
                    *by.entry(label).or_default() += tokens;
                }
            }
            _ => {}
        }
        // Same rules as `scan`: a "<synthetic>" record is a slash command or an
        // interrupt, not a turn, and folding its all-zero usage in would draw the
        // context falling to nothing and back.
        if !user && msg.get("usage").is_some() && !msg["model"].as_str().unwrap_or("").starts_with('<') {
            let u = &msg["usage"];
            ctx = u["input_tokens"].as_u64().unwrap_or(0)
                + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            series.push(ctx);
        }
    }
    let total: u64 = by.values().sum();
    let mut buckets: Vec<Bucket> = by
        .into_iter()
        .filter(|(_, t)| *t > 0)
        .map(|(label, tokens)| Bucket { label, tokens })
        .collect();
    buckets.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.label.cmp(&b.label)));
    Ok(Profile {
        buckets,
        series,
        drops,
        ctx,
        est: total,
    })
}

/// What one pane's context is made of. Read on demand — the panel opening is the
/// only thing that asks — because unlike `session_usage` this parses the whole
/// transcript, every line of it.
pub fn context_profile(pane: String, dir: String, sid: String) -> Option<Profile> {
    let home: PathBuf = std::env::var_os("USERPROFILE")
        .map(Into::into)
        .unwrap_or_default();
    let marks = std::env::temp_dir().join("loom-tx");
    profile_of(&transcript(&marks, &home, &pane, &dir, &sid)).ok()
}

// --- plan limits ----------------------------------------------------------
// The numbers behind Claude Code's own /usage panel: the 5-hour session window
// and the weekly ones. Claude Code caches a copy in ~/.claude.json, but only
// refreshes it on events of its own — it was four days stale here — so this asks
// the endpoint the desktop app asks.

/// One limit, already shaped for drawing: what to call it, how full, when it
/// resets. `label` is the API's `kind` resolved to the desktop app's wording.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    label: String,
    group: String,
    percent: f64,
    severity: String,
    resets_at: Option<String>,
}

#[derive(serde::Serialize)]
pub struct Plan {
    tier: String,
    limits: Vec<Limit>,
    /// Read off a statusline payload rather than the endpoint — the two
    /// account-wide windows only, so the caller merges instead of replacing.
    stale: bool,
}

#[derive(serde::Deserialize)]
struct Creds {
    #[serde(rename = "claudeAiOauth")]
    oauth: Oauth,
}
#[derive(serde::Deserialize)]
struct Oauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt", default)]
    expires_at: u128,
    #[serde(rename = "rateLimitTier", default)]
    tier: String,
}

#[derive(serde::Deserialize)]
struct ApiUsage {
    #[serde(default)]
    limits: Vec<ApiLimit>,
}
#[derive(serde::Deserialize)]
struct ApiLimit {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    percent: f64,
    #[serde(default)]
    severity: String,
    resets_at: Option<String>,
    scope: Option<Scope>,
}
#[derive(serde::Deserialize)]
struct Scope {
    model: Option<ScopeModel>,
}
#[derive(serde::Deserialize)]
struct ScopeModel {
    display_name: Option<String>,
}

/// One entry for the pane config panel's model list. Straight from the API, so
/// a model Anthropic adds shows up here on its own.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOpt {
    value: String,
    label: String,
    max_input: u64,
    max_output: u64,
}

#[derive(serde::Deserialize)]
struct ApiModels {
    #[serde(default)]
    data: Vec<ApiModel>,
}
#[derive(serde::Deserialize)]
struct ApiModel {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    max_input_tokens: u64,
    #[serde(default)]
    max_tokens: u64,
}

/// Every model this account can actually use, newest first. `/model` takes a
/// full id, so the ids come back as-is and nothing here needs a name table.
pub fn model_options() -> Result<Vec<ModelOpt>, String> {
    let body = get(
        "https://api.anthropic.com/v1/models?limit=100",
        &creds()?.access_token,
    )?;
    let m: ApiModels = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(m.data
        .into_iter()
        .map(|x| ModelOpt {
            label: if x.display_name.is_empty() {
                x.id.clone()
            } else {
                x.display_name
            },
            value: x.id,
            max_input: x.max_input_tokens,
            max_output: x.max_tokens,
        })
        .collect())
}

/// The signed-in account's credentials. Claude Code rotates the token in place,
/// so an expired one is its job to renew, not ours — say so rather than
/// half-work. Re-read every call for that reason.
fn creds() -> Result<Oauth, String> {
    let home: PathBuf = std::env::var_os("USERPROFILE")
        .map(Into::into)
        .unwrap_or_default();
    let raw = std::fs::read_to_string(home.join(".claude/.credentials.json"))
        .map_err(|_| "No Claude credentials found — run `claude` to sign in.".to_string())?;
    let c: Creds = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    if c.oauth.expires_at > 0 && c.oauth.expires_at < now {
        return Err("Claude session expired — run `claude` to sign in again.".into());
    }
    Ok(c.oauth)
}

/// GET the endpoint and hand back the body.
// ponytail: Windows' own curl rather than pulling reqwest — and with it tokio and
// a TLS stack — into the build for one request. The token goes in through a
// config on stdin, never argv, so it can't be read out of a process list.
fn get(url: &str, token: &str) -> Result<String, String> {
    let auth = format!("Bearer {token}");
    get_headers(url, &[("Authorization", &auth), ("anthropic-beta", "oauth-2025-04-20"), ("anthropic-version", "2023-06-01")])
}

fn get_headers(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    if headers.iter().any(|(_, value)| value.chars().any(char::is_control)) {
        return Err("Invalid usage request credentials".into());
    }
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let curl = std::env::var("SystemRoot")
        .map(|r| format!("{r}\\System32\\curl.exe"))
        .unwrap_or_else(|_| "curl.exe".into());
    let mut child = Command::new(curl)
        .args(["-sS", "--fail-with-body", "-m", "20", "-K", "-", url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no console flash
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;
    let cfg = headers.iter().map(|(name, value)| format!("header = {}\n", serde_json::to_string(&format!("{name}: {value}")).unwrap())).collect::<String>();
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(cfg.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(body);
    }
    // 429s are expected — this endpoint rate-limits hard — so keep the body,
    // which is where the API says what went wrong. Its own sentence, not the
    // JSON around it: this goes on screen as one line under the limits.
    #[derive(serde::Deserialize)]
    struct E {
        error: M,
    }
    #[derive(serde::Deserialize)]
    struct M {
        message: String,
    }
    Err(format!(
        "usage request failed: {}",
        match serde_json::from_str::<E>(&body) {
            Ok(e) => e.error.message,
            Err(_) if body.trim().is_empty() =>
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            Err(_) => body.trim().to_string(),
        }
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPlan {
    #[serde(flatten)]
    plan: Plan,
    #[serde(skip_serializing_if = "Option::is_none")]
    banked_resets: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    banked_reset_expiries: Option<Vec<Option<String>>>,
    note: String,
}

fn shape_codex(value: &serde_json::Value, live: bool) -> Option<CodexPlan> {
    let rate = if live { &value["rate_limit"] } else { value };
    let mut limits = Vec::new();
    for key in if live { ["primary_window", "secondary_window"] } else { ["primary", "secondary"] } {
        let w = &rate[key];
        let Some(percent) = w["used_percent"].as_f64().filter(|n| n.is_finite()) else { continue };
        let mins = if live { w["limit_window_seconds"].as_u64().unwrap_or(0).div_ceil(60) } else { w["window_minutes"].as_u64().unwrap_or(0) };
        let label = match mins {
            0 => "Usage".into(),
            10080 => "Weekly".into(),
            n if n >= 10080 => format!("{} wk", (n as f64 / 10080.0).round()),
            n if n >= 1440 => format!("{}-day", (n as f64 / 1440.0).round()),
            n if n >= 60 => format!("{}h limit", (n as f64 / 60.0).round()),
            n => format!("{n} min"),
        };
        limits.push(Limit {
            label, group: if mins >= 1440 { "weekly" } else { "session" }.into(),
            percent: percent.clamp(0.0, 100.0),
            severity: match percent { p if p >= 100.0 => "exceeded", p if p >= 90.0 => "critical", p if p >= 80.0 => "warning", _ => "ok" }.into(),
            resets_at: w[if live { "reset_at" } else { "resets_at" }].as_i64().filter(|n| *n > 0).map(|n| n.to_string()),
        });
    }
    if limits.is_empty() { return None; }
    Some(CodexPlan {
        plan: Plan { tier: value["plan_type"].as_str().unwrap_or("").into(), limits, stale: !live },
        banked_resets: if live { value["rate_limit_reset_credits"]["available_count"].as_u64().filter(|n| *n <= 9_007_199_254_740_991) } else { None },
        banked_reset_expiries: None,
        note: String::new(),
    })
}

fn codex_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") { homes.push(PathBuf::from(home).join(".codex")); }
    homes
}

fn codex_local(homes: &[PathBuf]) -> Option<CodexPlan> {
    // ponytail: two date folders and 20 files; widen for sessions spanning older dates.
    let mut files = Vec::new();
    let dirs = |path: &Path| std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect::<Vec<_>>();
    for home in homes {
        let mut days = Vec::new();
        for year in dirs(&home.join("sessions")) { for month in dirs(&year) { days.extend(dirs(&month)); } }
        days.sort();
        for day in days.iter().rev().take(2) {
            for entry in std::fs::read_dir(day).into_iter().flatten().flatten() {
                if entry.path().extension().is_some_and(|e| e == "jsonl") {
                    if let Ok(time) = entry.metadata().and_then(|m| m.modified()) { files.push((time, entry.path())); }
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    // Same bounded rollout tail as usageoverlayv2; never load whole transcripts.
    for (_, path) in files.into_iter().take(20) {
        let Ok(mut file) = std::fs::File::open(path) else { continue };
        let Ok(size) = file.metadata().map(|m| m.len()) else { continue };
        if file.seek(SeekFrom::Start(size.saturating_sub(256 * 1024))).is_err() { continue; }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() { continue; }
        let tail = String::from_utf8_lossy(&bytes);
        for line in tail.lines().rev().filter(|s| s.contains("\"rate_limits\"")) {
            if let Ok(row) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(mut plan) = shape_codex(&row["payload"]["rate_limits"], false) {
                    plan.note = "Live refresh unavailable; showing local session usage.".into();
                    return Some(plan);
                }
            }
        }
    }
    None
}

pub fn codex_plan_usage() -> Result<CodexPlan, String> {
    let homes = codex_homes();
    let auth = homes.iter().find_map(|home| {
        let raw = std::fs::read_to_string(home.join("auth.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let token = value["tokens"]["access_token"].as_str()?.to_string();
        if token.is_empty() { return None; }
        Some((home, token, value["tokens"]["account_id"].as_str().unwrap_or("").to_string()))
    });
    let mut error = "No Codex usage available. Run codex to sign in.".to_string();
    if let Some((home, token, account)) = auth {
        let auth = format!("Bearer {token}");
        let mut headers = vec![("Authorization", auth.as_str()), ("User-Agent", "codex-cli"), ("OpenAI-Beta", "codex-1"), ("originator", "Codex Desktop")];
        if !account.is_empty() { headers.push(("ChatGPT-Account-Id", account.as_str())); }
        match get_headers("https://chatgpt.com/backend-api/wham/usage", &headers)
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string())) {
            Ok(value) => if let Some(mut plan) = shape_codex(&value, true) {
                if plan.banked_resets.is_some_and(|n| n > 0) {
                    if let Ok(raw) = get_headers("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", &headers) {
                        if let Ok(details) = serde_json::from_str::<serde_json::Value>(&raw) {
                            plan.banked_reset_expiries = details["credits"].as_array().map(|credits| credits.iter().filter(|c| c["status"] == "available").map(|c| c["expires_at"].as_str().map(String::from)).collect());
                        }
                    }
                }
                return Ok(plan);
            },
            Err(e) => error = e,
        }
        // Keep offline readings tied to the home that supplied this account's token.
        return codex_local(std::slice::from_ref(home)).ok_or(error);
    }
    codex_local(&homes).ok_or(error)
}

/// Plan usage for the signed-in account. The caller polls this — the endpoint
/// rate-limits, and these numbers don't move fast enough to ask often.
pub fn plan_usage() -> Result<Plan, String> {
    let (tier, err) = match creds() {
        // The plan name is in the credentials file already — no second request.
        Ok(c) => match api_limits(&c.access_token) {
            Ok(limits) => {
                return Ok(Plan {
                    tier: c.tier,
                    limits,
                    stale: false,
                })
            }
            Err(e) => (c.tier, e),
        },
        Err(e) => (String::new(), e),
    };
    // This endpoint 429s readily — often enough that the chip would just never
    // appear. Claude Code pushes the same two numbers into every statusline
    // payload, so any pane that has run claude already has them on disk.
    plan_from_status(&std::env::temp_dir().join("loom-status"), tier).ok_or(err)
}

fn api_limits(token: &str) -> Result<Vec<Limit>, String> {
    let body = get("https://api.anthropic.com/api/oauth/usage", token)?;
    let u: ApiUsage = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(u.limits
        .into_iter()
        .map(|l| Limit {
            // A scoped limit names its model ("Fable"); the rest are named by
            // kind, which the frontend maps to the panel's own wording.
            label: l
                .scope
                .and_then(|s| s.model)
                .and_then(|m| m.display_name)
                .unwrap_or_else(|| l.kind.clone()),
            group: l.group,
            percent: l.percent.clamp(0.0, 100.0),
            severity: l.severity,
            resets_at: l.resets_at,
        })
        .collect())
}

/// `rate_limits` out of the newest statusline payload on disk. Only the two
/// windows Claude Code pushes — the API's per-model weeklies aren't in there —
/// and only as fresh as the last pane to report, which the reset countdown in the
/// panel makes plain enough.
// ponytail: newest of a handful of small files, re-read per poll. No watcher.
fn plan_from_status(dir: &Path, tier: String) -> Option<Plan> {
    #[derive(serde::Deserialize)]
    struct P {
        rate_limits: Rates,
    }
    #[derive(serde::Deserialize)]
    struct Rates {
        five_hour: Option<Bucket>,
        seven_day: Option<Bucket>,
    }
    #[derive(serde::Deserialize)]
    struct Bucket {
        used_percentage: Option<f64>,
        /// Unix seconds here, where the API sends a date string. The frontend
        /// reads both — converting one without a date crate costs more than it.
        resets_at: Option<i64>,
    }
    let mut best: Option<(std::time::SystemTime, Rates)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(at) = e.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_some_and(|(seen, _)| at <= *seen) {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        // Same two-part marker live_status reads: env effort, then the payload.
        let Some((_, payload)) = raw.trim_start_matches('\u{feff}').split_once('\n') else {
            continue;
        };
        if let Ok(p) = serde_json::from_str::<P>(payload) {
            best = Some((at, p.rate_limits));
        }
    }
    let (_, r) = best?;
    let limit = |label: &str, group: &str, b: Bucket| {
        let percent = b.used_percentage.unwrap_or(0.0).clamp(0.0, 100.0);
        Limit {
            label: label.into(),
            group: group.into(),
            percent,
            // ponytail: the endpoint sends its own severity; these only have to
            // hold until it answers again, and they match the panel's colours.
            severity: match percent {
                p if p >= 100.0 => "exceeded",
                p if p >= 90.0 => "critical",
                p if p >= 80.0 => "warning",
                _ => "ok",
            }
            .into(),
            resets_at: b.resets_at.map(|s| s.to_string()),
        }
    };
    Some(Plan {
        tier,
        // Labelled as the API's own kinds, so the frontend's wording table, the
        // "WEEKLY LIMITS" heading and its merge all apply unchanged.
        limits: r
            .five_hour
            .map(|b| limit("session", "session", b))
            .into_iter()
            .chain(r.seven_day.map(|b| limit("weekly_all", "weekly", b)))
            .collect(),
        stale: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{live_status, plan_from_status, profile_of, scan, slug, transcript, Usage};
    use std::io::Write;

    #[test]
    fn codex_usage_windows_and_fallback() {
        let live = serde_json::json!({"plan_type":"prolite", "rate_limit": {
            "primary_window":{"used_percent":4,"limit_window_seconds":604800,"reset_at":1900000000},
            "secondary_window":{"used_percent":125,"limit_window_seconds":18000,"reset_at":1900000100}
        }, "rate_limit_reset_credits":{"available_count":3}});
        let plan = super::shape_codex(&live, true).unwrap();
        assert_eq!(plan.plan.tier, "prolite");
        assert_eq!((plan.plan.limits[0].label.as_str(), plan.plan.limits[0].group.as_str()), ("Weekly", "weekly"));
        assert_eq!((plan.plan.limits[1].label.as_str(), plan.plan.limits[1].group.as_str(), plan.plan.limits[1].percent), ("5h limit", "session", 100.0));
        assert_eq!(plan.plan.limits[1].resets_at.as_deref(), Some("1900000100"));
        assert_eq!(plan.banked_resets, Some(3));
        assert!(!plan.plan.stale);
        assert!(super::shape_codex(&serde_json::json!({"rate_limit":{}}), true).is_none());
        for invalid in [serde_json::Value::Null, serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("3")] {
            let mut value = live.clone();
            value["rate_limit_reset_credits"]["available_count"] = invalid;
            assert!(super::shape_codex(&value, true).unwrap().banked_resets.is_none());
        }
        let root = std::env::temp_dir().join(format!("loom-codex-usage-test-{}", std::process::id()));
        let day = root.join("sessions/2026/09/09");
        std::fs::create_dir_all(&day).unwrap();
        let local = serde_json::json!({"payload":{"rate_limits":{"plan_type":"plus", "primary":{"used_percent":42.6,"window_minutes":300,"resets_at":1900000000}}}});
        // The tail can begin in a UTF-8 character or half-written JSON line.
        let mut file = std::fs::File::create(day.join("rollout-test.jsonl")).unwrap();
        file.write_all("é".repeat(140_000).as_bytes()).unwrap();
        writeln!(file, "\n{local}\n{{broken").unwrap();
        let fallback = super::codex_local(std::slice::from_ref(&root)).unwrap();
        assert!(fallback.plan.stale);
        assert_eq!(fallback.plan.limits[0].percent, 42.6);
        assert_eq!(fallback.plan.limits[0].group, "session");
        assert!(fallback.banked_resets.is_none());
        assert!(super::get_headers("https://example.invalid", &[("Authorization", "bad\nheader")]).is_err());
        drop(file);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Reads the signed-in account's live usage"]
    fn codex_live_usage() {
        let plan = super::codex_plan_usage().unwrap();
        assert!(!plan.plan.stale, "Codex usage must come from the live API, not local fallback");
        println!("Codex usage: {} windows, local fallback: {}, banked resets reported: {}", plan.plan.limits.len(), plan.plan.stale, plan.banked_resets.is_some());
    }

    /// Tokens are charged to the tool that produced them, a subagent's are not
    /// this conversation's, and the two exact readings — context per turn, and
    /// every compaction — come out intact.
    #[test]
    fn charges_each_origin_and_reports_every_compaction() {
        let path = std::env::temp_dir().join("loom-profile-test.jsonl");
        let turn = |ctx: u64| {
            format!(
                "{{\"type\":\"assistant\",\"message\":{{\"model\":\"m\",\"usage\":\
                 {{\"input_tokens\":{ctx},\"cache_read_input_tokens\":0,\
                 \"cache_creation_input_tokens\":0,\"output_tokens\":1}},\
                 \"content\":[{{\"type\":\"tool_use\",\"id\":\"t1\",\
                 \"name\":\"mcp__devtools__Read\",\"input\":{{}}}}]}}}}\n"
            )
        };
        std::fs::write(
            &path,
            // A Read and its result, a subagent's Read that is not this
            // conversation's, an injected skill listing, then a compaction.
            turn(9000)
                + "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\
                   \"tool_use_id\":\"t1\",\"content\":\"xxxxxxxxxxxxxxxx\"}]}}\n"
                + "{\"isSidechain\":true,\"type\":\"user\",\"message\":{\"content\":\
                   [{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"zzzzzzzz\"}]}}\n"
                + "{\"attachment\":{\"type\":\"skill_listing\",\"content\":\"sssssssss\"}}\n"
                + "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":\
                   {\"trigger\":\"auto\",\"preTokens\":9000,\"postTokens\":700}}\n"
                + "{\"type\":\"user\",\"isCompactSummary\":true,\"message\":\
                   {\"content\":\"xxxxxxxxxxxxxxxxxxxx\"}}\n"
                + &turn(800),
        )
        .unwrap();

        let p = profile_of(&path).unwrap();
        let got: Vec<_> = p.buckets.iter().map(|b| (b.label.as_str(), b.tokens)).collect();
        assert_eq!(
            got,
            // Read = its 16-char result (4) plus two "{}" calls (1 each), and it
            // is "Read" rather than the mcp__devtools__ name it was called by.
            // The subagent's 8-char result is charged to nobody, and the skill
            // listing is its whole record, which is mostly its content.
            [("skill listing", 16), ("Read", 6), ("compact summary", 5)],
            "charged to the tool that produced them, subagents excluded"
        );
        // est is what was produced; ctx is the live window. They do not agree,
        // and are not meant to — the transcript cannot see what Claude Code
        // pruned before sending.
        assert_eq!((p.ctx, p.est), (800, 27));
        assert_eq!(p.series, [9000, 800], "exact, and the subagent is not a turn");
        let d = &p.drops[0];
        assert_eq!(
            (p.drops.len(), d.trigger.as_str(), d.pre, d.post, d.turn),
            (1, "auto", 9000, 700, 1),
            "the drop lands between the two turns it happened between"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// The chip's numbers come off the statusline marker whenever the endpoint
    /// won't answer — which, at 429, is most of the time.
    #[test]
    fn plan_falls_back_to_the_statusline_payload() {
        let dir = std::env::temp_dir().join("loom-plan-fallback-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing on disk: no fallback, and the caller reports the API's error.
        assert!(plan_from_status(&dir, "t".into()).is_none());

        // An older pane, and a newer one whose payload carries no limits at all
        // (they aren't in every push) — the newest that *has* them wins.
        std::fs::write(
            dir.join("old"),
            "xhigh\n{\"rate_limits\":{\"five_hour\":{\"used_percentage\":9,\"resets_at\":1},\
             \"seven_day\":{\"used_percentage\":1,\"resets_at\":2}}}",
        )
        .unwrap();
        std::fs::write(
            dir.join("newer"),
            "xhigh\n{\"rate_limits\":{\"five_hour\":{\"used_percentage\":93,\"resets_at\":1786070400},\
             \"seven_day\":{\"used_percentage\":3,\"resets_at\":1786582800}}}",
        )
        .unwrap();
        std::fs::write(dir.join("newest"), "xhigh\n{\"rate_limits\":null}").unwrap();

        let p = plan_from_status(&dir, "default_claude_max_20x".into()).unwrap();
        assert_eq!((p.tier.as_str(), p.stale), ("default_claude_max_20x", true));
        let got: Vec<_> = p
            .limits
            .iter()
            .map(|l| {
                (
                    l.label.as_str(),
                    l.group.as_str(),
                    l.percent,
                    l.severity.as_str(),
                    l.resets_at.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("session", "session", 93.0, "critical", Some("1786070400")),
                ("weekly_all", "weekly", 3.0, "ok", Some("1786582800")),
            ],
            "labelled as the API's kinds so the panel's wording still applies"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_status_reads_the_tee_marker() {
        let dir = std::env::temp_dir().join("loom-status-parse-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let read = |p| {
            let l = live_status(&dir, p);
            (l.found, l.model, l.effort, l.ctx, l.window)
        };

        // No marker: the tee never fired, the transcript stands.
        assert_eq!(read("p1"), (false, String::new(), String::new(), 0, 0));

        // BOM (Set-Content utf8), env-effort first line, payload after. A session
        // with no turn yet reports a window but no usage — the gauge shows 0%
        // rather than waiting for the first answer.
        std::fs::write(
            dir.join("p1"),
            "\u{feff}max\n{\"model\":{\"id\":\"claude-fable-5\",\"display_name\":\"Fable 5\"},\
             \"context_window\":{\"total_input_tokens\":0,\"context_window_size\":1000000,\
             \"current_usage\":null,\"used_percentage\":null}}",
        )
        .unwrap();
        assert_eq!(read("p1"), (true, "claude-fable-5".into(), "max".into(), 0, 1_000_000));

        // A payload that carries effort itself beats the env line.
        std::fs::write(
            dir.join("p1"),
            "max\n{\"model\":{\"id\":\"claude-opus-5\"},\"effort\":{\"level\":\"high\"},\
             \"context_window\":{\"total_input_tokens\":66115,\"context_window_size\":200000}}",
        )
        .unwrap();
        assert_eq!(read("p1"), (true, "claude-opus-5".into(), "high".into(), 66115, 200_000));

        // Garbage payload: empty, never a poisoned panel — but the marker exists,
        // so claude is still up.
        std::fs::write(dir.join("p1"), "high\nnot json").unwrap();
        assert_eq!(read("p1"), (true, String::new(), "high".into(), 0, 0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hook_marker_wins_over_the_pinned_id() {
        let root = std::env::temp_dir().join("loom-tx-test");
        let (marks, home) = (root.join("marks"), root.join("home"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&marks).unwrap();
        let pinned = home
            .join(".claude/projects")
            .join(slug(r"C:\p"))
            .join("old.jsonl");
        std::fs::create_dir_all(pinned.parent().unwrap()).unwrap();
        std::fs::write(&pinned, "").unwrap();
        let live = root.join("live.jsonl");
        std::fs::write(&live, "").unwrap();

        // No marker yet: fall back to the session we asked for.
        assert_eq!(transcript(&marks, &home, "pane1", r"C:\p", "old"), pinned);

        // Marker present: follow it instead, trailing newline and all.
        std::fs::write(marks.join("pane1"), format!("{}\r\n", live.display())).unwrap();
        assert_eq!(transcript(&marks, &home, "pane1", r"C:\p", "old"), live);

        // Marker pointing at something deleted is worse than no marker.
        std::fs::remove_file(&live).unwrap();
        assert_eq!(transcript(&marks, &home, "pane1", r"C:\p", "old"), pinned);

        let _ = std::fs::remove_dir_all(&root);
    }

    fn append(path: &std::path::Path, s: &str) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    #[test]
    fn folds_each_line_once_and_ignores_subagents() {
        assert_eq!(slug("C:\\Users\\a\\newaa"), "C--Users-a-newaa");

        // ctx = input(2) + cache_read, so `read` sets the context this turn reports.
        let turn = |read: u64, out: u64, side: bool| {
            format!(
                "{{\"isSidechain\":{side},\"type\":\"assistant\",\"message\":{{\"model\":\"m\",\
                 \"usage\":{{\"input_tokens\":2,\"cache_read_input_tokens\":{read},\
                 \"cache_creation_input_tokens\":0,\"output_tokens\":{out}}}}}}}\n"
            )
        };
        let path = std::env::temp_dir().join("loom-usage-test.jsonl");
        std::fs::write(&path, turn(998, 10, false) + "not json at all\n").unwrap();

        let (mut off, mut u) = (0u64, Usage::default());
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!((u.ctx, u.output, u.turns), (1000, 10, 1));

        // A subagent turn, then a record still being written.
        append(&path, &(turn(48, 7, true) + "{\"isSidechain\":false,\"message\":{\"usage\""));
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!(
            (u.ctx, u.output, u.turns),
            (1000, 17, 2),
            "a subagent spends tokens but is not the pane's context"
        );

        // Finish that line: it lands on the next pass, and only then.
        append(
            &path,
            ":{\"input_tokens\":5,\"cache_read_input_tokens\":95,\"output_tokens\":3}}}\n",
        );
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!((u.ctx, u.output, u.turns), (100, 20, 3));
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!(u.turns, 3, "nothing is folded in twice");

        // A slash command leaves a "<synthetic>" record with an all-zero usage.
        // Folding one in used to zero the context gauge and count as a turn,
        // which threw away whatever the config panel had just set.
        append(
            &path,
            "{\"isSidechain\":false,\"message\":{\"model\":\"<synthetic>\",\"usage\":\
             {\"input_tokens\":0,\"cache_read_input_tokens\":0,\"output_tokens\":0}}}\n",
        );
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!(
            (u.ctx, u.turns, u.main_turns),
            (100, 3, 2),
            "a synthetic record is not a turn and does not move the context"
        );

        // Replaced by a shorter file: start the totals over rather than double them.
        std::fs::write(&path, turn(8, 1, false)).unwrap();
        scan(&path, &mut off, &mut u).unwrap();
        assert_eq!((u.ctx, u.output, u.turns), (10, 1, 1));

        let _ = std::fs::remove_file(&path);
    }
}
