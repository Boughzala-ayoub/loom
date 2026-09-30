//! The name of a running Loom's control pipe. loom.exe serves it (control.rs)
//! and loomctl.exe connects to it, so both build it here. One per Windows
//! user and workspace: the default workspace, or a profile launch's file.

/// `\\.\pipe\loom-<user>`, or `-<hash>` after it for a profile file.
pub fn pipe_name(profile: Option<&str>) -> String {
    let user: String = std::env::var("USERNAME").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    match profile {
        None => format!(r"\\.\pipe\loom-{user}"),
        Some(file) => format!(r"\\.\pipe\loom-{user}-{:016x}", fnv1a(&normalize(file))),
    }
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
}
