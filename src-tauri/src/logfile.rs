//! Loom's own log, `%LOCALAPPDATA%\dev.ayoub.loom\logs\loom.log`, so a crash
//! leaves a trace (CRASH_INVESTIGATION.md): when Loom started, the windows and
//! panes it opened and closed, a heartbeat of how busy it was, the warnings
//! tauri, tao, wry and portable-pty log, and a panic's message and backtrace.
//! A log that stops without an "exit" line stopped in a crash.
//! The release exe is a GUI program with no stderr, so it writes the file; a
//! debug build writes stderr, its console. Write through `line`, not
//! `eprintln!`, which panics when the write fails (a full disk).
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::OnceLock;

static FILE: OnceLock<std::fs::File> = OnceLock::new();
/// Past this at startup the log moves to loom.1.log, replacing the one there.
const ROTATE: u64 = 5 << 20;
/// ponytail: past this, a run stops writing, so a warning storm can't fill the
/// disk; the size is looked at again only when Loom next starts.
const RUN_MAX: u64 = 50 << 20;
static WRITTEN: AtomicU64 = AtomicU64::new(0);
/// Pane output handed to the page since the last heartbeat.
static OUTPUT_BYTES: AtomicU64 = AtomicU64::new(0);
static OUTPUT_BATCHES: AtomicU64 = AtomicU64::new(0);

/// Once, before anything else runs: the file, the panic hook, the logger, and
/// the start line.
pub fn init() {
    if !cfg!(debug_assertions) {
        // tauri.conf.json's identifier: app_local_data_dir, where the trash lives too.
        let file = std::env::var_os("LOCALAPPDATA").and_then(|dir| open(&Path::new(&dir).join("dev.ayoub.loom").join("logs")));
        if let Some(file) = file { let _ = FILE.set(file); }
    }
    // panic = "abort" in release: this is the last thing a panic does.
    std::panic::set_hook(Box::new(|info| line(&format!("panic: {info}\n{}", std::backtrace::Backtrace::force_capture()))));
    if log::set_logger(&Logger).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
    let webview = tauri::webview_version().unwrap_or_else(|e| e.to_string());
    line(&format!("start: loom {} pid {} windows {} webview2 {webview}", env!("CARGO_PKG_VERSION"), std::process::id(), windows_build()));
}

/// `dir`'s loom.log for appending, moved aside first once it's past ROTATE.
/// Every Loom (a profile, a second launch) writes this one file and holds it
/// without FILE_SHARE_DELETE, so none can rename it while another writes: it
/// moves aside once its last writer has gone, and no Loom's lines go missing.
fn open(dir: &Path) -> Option<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join("loom.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > ROTATE) {
        let _ = std::fs::rename(&path, dir.join("loom.1.log"));
    }
    std::fs::OpenOptions::new().append(true).create(true).share_mode(1 | 2).open(path).ok() // FILE_SHARE_READ | FILE_SHARE_WRITE
}

/// One line, stamped with local time as the event log stamps crashes.
pub fn line(text: &str) {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let entry = format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} {text}\n", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    if WRITTEN.fetch_add(entry.len() as u64, Relaxed) > RUN_MAX {
        return;
    }
    // Appends: whole lines from any thread, no lock.
    let _ = match FILE.get() {
        Some(mut file) => file.write_all(entry.as_bytes()),
        None => std::io::stderr().write_all(entry.as_bytes()),
    };
}

/// One batch of pane output handed to the page (pty_spawn's emitter).
pub fn output(bytes: usize) {
    OUTPUT_BYTES.fetch_add(bytes as u64, Relaxed);
    OUTPUT_BATCHES.fetch_add(1, Relaxed);
}

/// How busy Loom was since the last heartbeat, so a crash can be lined up with load.
pub fn heartbeat(panes: usize) {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
    let mut mem = PROCESS_MEMORY_COUNTERS_EX { cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
    let mut handles = 0;
    unsafe {
        let _ = GetProcessMemoryInfo(GetCurrentProcess(), (&mut mem as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(), mem.cb);
        let _ = GetProcessHandleCount(GetCurrentProcess(), &mut handles);
    }
    line(&format!("heartbeat: {panes} panes, {} KiB of output in {} batches, {} MiB private, {handles} handles",
        OUTPUT_BYTES.swap(0, Relaxed) >> 10, OUTPUT_BATCHES.swap(0, Relaxed), mem.PrivateUsage >> 20));
}

/// Windows' real version: GetVersionEx answers what the manifest claims.
fn windows_build() -> String {
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut v = OSVERSIONINFOW { dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    let _ = unsafe { windows::Wdk::System::SystemServices::RtlGetVersion(&mut v) };
    format!("{}.{}.{}", v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber)
}

/// tauri's, tao's, wry's and portable-pty's `log` warnings and errors.
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            line(&format!("{} {}: {}", record.level(), record.target(), record.args()));
        }
    }
    fn flush(&self) {}
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_big_log_moves_aside_and_a_new_one_starts() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("loom-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        drop(super::open(&dir).expect("a new log"));
        std::fs::write(dir.join("loom.log"), vec![b'x'; super::ROTATE as usize + 1]).unwrap();
        let mut file = super::open(&dir).expect("the log after a rotation");
        file.write_all(b"next\n").unwrap();
        assert_eq!(std::fs::metadata(dir.join("loom.1.log")).unwrap().len(), super::ROTATE + 1, "the big one is kept once");
        assert_eq!(std::fs::read_to_string(dir.join("loom.log")).unwrap(), "next\n");
        drop(super::open(&dir).expect("a small log is appended to"));
        assert_eq!(std::fs::read_to_string(dir.join("loom.log")).unwrap(), "next\n");
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Review round 1, 6: a Loom starting while another writes can't move its file out from under it.
    #[test]
    fn a_log_another_loom_writes_stays_where_it_is() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("loom-log-shared-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut first = super::open(&dir).expect("the first Loom's log");
        first.write_all(&vec![b'x'; super::ROTATE as usize + 1]).unwrap();
        let (mut second, mut third) = (super::open(&dir).expect("a second Loom's"), super::open(&dir).expect("a third's"));
        for (file, text) in [(&mut first, "first\n"), (&mut second, "second\n"), (&mut third, "third\n")] {
            file.write_all(text.as_bytes()).unwrap();
        }
        assert!(!dir.join("loom.1.log").exists(), "nothing moves aside while a Loom writes");
        assert!(std::fs::read_to_string(dir.join("loom.log")).unwrap().ends_with("first\nsecond\nthird\n"), "every Loom's lines are in loom.log");
        drop((first, second, third));
        let mut next = super::open(&dir).expect("the log once they've gone");
        next.write_all(b"next\n").unwrap();
        assert!(std::fs::read_to_string(dir.join("loom.1.log")).unwrap().ends_with("third\n"), "the big one moves aside then");
        assert_eq!(std::fs::read_to_string(dir.join("loom.log")).unwrap(), "next\n");
        drop(next);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
