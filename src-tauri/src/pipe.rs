//! The names of a running Loom's control pipes. loom.exe serves them
//! (control.rs) and loomctl.exe connects to them, so both build them here.
//!
//! Each Loom serves two: its workspace's, which terminals use, and its own
//! process's, which its panes use. Only one Loom can own a workspace's name, so
//! a second one on the same workspace (or a `tauri dev` build beside the
//! installed app, before they were apart) would otherwise hand its panes a
//! name that reaches the other window.

/// Debug builds keep to themselves, the way their data folder does.
const PREFIX: &str = if cfg!(debug_assertions) { "loom-dev" } else { "loom" };

/// What loomctl and Loom say to each other. Raise it whenever a request or an
/// answer changes shape: an update replaces loomctl.exe while the old Loom may
/// still be running, and the two must refuse each other rather than misread a
/// command (the first version sent `args`, this one `argv`, and each read the
/// other's as no arguments at all, so `close <pane>` closed the pane in front).
pub const PROTOCOL: u64 = 2;

fn user() -> String {
    std::env::var("USERNAME").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// `\\.\pipe\loom-<user>` for the default workspace, `-<hash>` after it for a
/// profile file.
pub fn pipe_name(profile: Option<&str>) -> String {
    match profile {
        None => format!(r"\\.\pipe\{PREFIX}-{}", user()),
        Some(file) => format!(r"\\.\pipe\{PREFIX}-{}-{:016x}", user(), fnv1a(&normalize(file))),
    }
}

/// This process's own pipe: what its panes get as LOOM_PIPE.
#[allow(dead_code)] // loomctl builds this file too and never serves a pipe
pub fn instance_pipe() -> String {
    format!(r"\\.\pipe\{PREFIX}-{}-pid{}", user(), std::process::id())
}

/// The same file however it was spelled: absolute, backslashes, any case.
fn normalize(file: &str) -> String {
    let path = std::path::absolute(file).unwrap_or_else(|_| file.into());
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// A hash that stays the same across Rust versions, unlike std's.
fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_names_its_own_pipe_however_it_is_spelled() {
        let plain = pipe_name(None);
        assert!(plain.starts_with(r"\\.\pipe\loom-"));
        let a = pipe_name(Some(r"C:\Work\Client.json"));
        assert_eq!(a, pipe_name(Some("c:/work/client.json")));
        assert_ne!(a, plain);
        assert_ne!(a, pipe_name(Some(r"C:\Work\other.json")));
    }

    #[test]
    fn debug_builds_and_each_process_have_names_of_their_own() {
        let dev = cfg!(debug_assertions);
        assert_eq!(pipe_name(None).contains(r"\loom-dev-"), dev, "tauri dev must not share the installed app's pipe");
        let mine = instance_pipe();
        assert!(mine.ends_with(&format!("-pid{}", std::process::id())));
        assert_ne!(mine, pipe_name(None));
    }
}
