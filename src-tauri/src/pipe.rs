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
/// 3: requests carry `--key`, which a protocol-2 Loom dropped without a word,
/// running a retried mutation twice.
pub const PROTOCOL: u64 = 3;

/// This account, as a hash of its SID. Not USERNAME with its odd characters
/// dropped: "a.b" and "ab", or two non-ASCII names, came out the same, and
/// the account that made the name first held it. The owner check (owner_is)
/// still guards every connection.
fn user() -> String {
    static USER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    USER.get_or_init(|| match sid() {
        Some(sid) => format!("{:016x}", fnv1a(&sid)),
        // ponytail: an account whose token can't be read keeps the old name.
        None => legacy_user(),
    }).clone()
}

/// What Loom called this account before the SID names: USERNAME with all but
/// ASCII letters and digits dropped.
fn legacy_user() -> String {
    std::env::var("USERNAME").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// This account's SID as text, S-1-5-21-....
pub fn sid() -> Option<String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    let user = current_user().ok()?;
    unsafe {
        let mut raw = windows::core::PWSTR::null();
        ConvertSidToStringSidW(sid_of(&user)?, &mut raw).ok()?;
        let text = raw.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(raw.0.cast())));
        text
    }
}

/// `\\.\pipe\loom-<user>` for the default workspace, `-<hash>` after it for a
/// profile file. `<user>` is 16 hex digits (user).
pub fn pipe_name(profile: Option<&str>) -> String {
    name_for(&user(), profile)
}

fn name_for(user: &str, profile: Option<&str>) -> String {
    match profile {
        None => format!(r"\\.\pipe\{PREFIX}-{user}"),
        Some(file) => format!(r"\\.\pipe\{PREFIX}-{user}-{:016x}", fnv1a(&normalize(file))),
    }
}

/// The names loomctl tries for `profile`'s workspace, in order: Loom's own
/// (pipe_name), then the one a Loom from before the SID names serves.
/// update.ps1 replaces loomctl.exe while that Loom keeps running until it
/// restarts, and protocol 3 hasn't changed, so the new loomctl must still
/// reach it. Each name goes through the same owner check and hello.
#[allow(dead_code)] // loom.exe serves pipe_name only
pub fn pipe_names(profile: Option<&str>) -> Vec<String> {
    let (own, before) = (pipe_name(profile), name_for(&legacy_user(), profile));
    if before == own { vec![own] } else { vec![own, before] }
}

/// This process's own pipe: what its panes get as LOOM_PIPE.
#[allow(dead_code)] // loomctl builds this file too and never serves a pipe
pub fn instance_pipe() -> String {
    format!(r"\\.\pipe\{PREFIX}-{}-pid{}", user(), std::process::id())
}

/// The same file however it was spelled: absolute, backslashes, any case.
fn normalize(file: &str) -> String {
    let path = std::path::absolute(file).unwrap_or_else(|_| file.into());
    let path = path.canonicalize().unwrap_or_else(|_| {
        path.parent().and_then(|p| p.canonicalize().ok()).and_then(|p| path.file_name().map(|n| p.join(n))).unwrap_or(path)
    });
    let text = path.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.replace('/', "\\").to_lowercase()
}

/// A hash that stays the same across Rust versions, unlike std's.
fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// This account's SID, as the bytes of its TOKEN_USER (the SID points inside).
pub fn current_user() -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let fail = |e: windows::core::Error| format!("can't read this account's identity: {e}");
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(fail)?;
        let mut len = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut user = vec![0u8; len as usize];
        let got = GetTokenInformation(token, TokenUser, Some(user.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        got.map_err(fail)?;
        Ok(user)
    }
}

/// The SID in `user`, a TOKEN_USER's bytes from current_user. Read unaligned:
/// a Vec<u8> promises the struct no alignment. The SID it points to lives on
/// inside `user`. None when the bytes are too short to be one.
fn sid_of(user: &[u8]) -> Option<windows::Win32::Security::PSID> {
    use windows::Win32::Security::TOKEN_USER;
    (user.len() >= size_of::<TOKEN_USER>()).then(|| unsafe { std::ptr::read_unaligned(user.as_ptr().cast::<TOKEN_USER>()) }.User.Sid)
}

/// Whether the pipe is owned by `user` (a TOKEN_USER from current_user). Loom
/// makes its pipes owned by its account (control.rs). A name is only a name:
/// another account could create it first, so the owner is checked before
/// anything is sent; only that account or an administrator can set it.
#[allow(dead_code)]
pub fn owner_is(pipe: &std::fs::File, user: &[u8]) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows::Win32::Security::{EqualSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID};
    let sid = sid_of(user).ok_or("not an account's identity")?;
    unsafe {
        let (mut owner, mut descriptor) = (PSID::default(), PSECURITY_DESCRIPTOR::default());
        let got = GetSecurityInfo(HANDLE(pipe.as_raw_handle()), SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
            Some(&mut owner), None, None, None, Some(&mut descriptor));
        if got.is_err() { return Err(format!("{got:?}")); }
        let same = EqualSid(owner, sid).is_ok();
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        Ok(same)
    }
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
    fn the_name_is_this_accounts_sid_not_its_user_name() {
        let sid = sid().expect("this account's SID");
        assert!(sid.starts_with("S-1-"), "{sid}");
        let id = format!("{:016x}", fnv1a(&sid));
        assert_eq!(pipe_name(None), format!(r"\\.\pipe\{PREFIX}-{id}"));
        assert!(instance_pipe().starts_with(&format!(r"\\.\pipe\{PREFIX}-{id}-pid")));
    }

    #[test]
    fn a_sid_is_read_only_from_a_whole_token_user() {
        let user = current_user().unwrap();
        assert!(sid_of(&user).is_some());
        assert!(sid_of(&user[..4]).is_none(), "too short to be a TOKEN_USER");
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
