//! Seed a new pane's session index without rescanning every rollout. Logs and
//! other mutable databases stay private to the pane. SQLite's online backup
//! includes committed WAL pages; copying a live .sqlite file alone would not.
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::Path;

// Windows ships SQLite, so the launcher needs no extra executable or library.
#[link(name = "winsqlite3")]
extern "C" {
    fn sqlite3_open_v2(path: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_backup_init(to: *mut c_void, to_name: *const c_char, from: *mut c_void, from_name: *const c_char) -> *mut c_void;
    fn sqlite3_backup_step(backup: *mut c_void, pages: c_int) -> c_int;
    fn sqlite3_backup_finish(backup: *mut c_void) -> c_int;
}

struct Db(*mut c_void);
impl Db {
    fn open(path: &Path, flags: c_int) -> Option<Self> {
        let path = CString::new(path.to_str()?).ok()?;
        let mut db = Self(std::ptr::null_mut());
        let ok = unsafe { sqlite3_open_v2(path.as_ptr(), &mut db.0, flags, std::ptr::null()) };
        (ok == 0).then_some(db)
    }
}
impl Drop for Db {
    fn drop(&mut self) { unsafe { sqlite3_close(self.0); } }
}

/// Best effort only: a missing/busy index falls back to Codex's normal scan.
/// Never replace an existing pane database or copy its shared logs database.
pub fn seed(home: &Path, pane: &Path) {
    let Ok(files) = std::fs::read_dir(home) else { return };
    for file in files.flatten() {
        let name = file.file_name();
        let Some(version) = name.to_str().and_then(|n| n.strip_prefix("state_")).and_then(|n| n.strip_suffix(".sqlite")) else { continue };
        if version.is_empty() || !version.bytes().all(|c| c.is_ascii_digit()) { continue; }
        let target = pane.join(&name);
        if target.exists() { continue; }
        // create_new reserves the staging file, including across Loom windows.
        let temp = target.with_extension("sqlite.seed");
        let Ok(reservation) = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp) else { continue };
        drop(reservation);
        let copied = snapshot(&file.path(), &temp);
        if copied && !target.exists() { let _ = std::fs::rename(&temp, &target); }
        let _ = std::fs::remove_file(&temp);
    }
}

fn snapshot(source: &Path, target: &Path) -> bool {
    let Some(source) = Db::open(source, 1 /* READONLY */) else { return false };
    let Some(target) = Db::open(target, 6 /* READWRITE | CREATE */) else { return false };
    unsafe {
        let backup = sqlite3_backup_init(target.0, c"main".as_ptr(), source.0, c"main".as_ptr());
        if backup.is_null() { return false; }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let done = loop {
            if std::time::Instant::now() >= deadline { break false; }
            match sqlite3_backup_step(backup, 128) {
                101 => break true, // SQLITE_DONE
                0 => continue, // more pages remain
                5 | 6 => std::thread::sleep(std::time::Duration::from_millis(10)),
                _ => break false,
            }
        };
        sqlite3_backup_finish(backup) == 0 && done
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "winsqlite3")]
    extern "C" {
        fn sqlite3_exec(db: *mut c_void, sql: *const c_char, callback: *const c_void, arg: *mut c_void, error: *mut *mut c_char) -> c_int;
    }
    fn sql(db: &Db, query: &str) {
        let query = CString::new(query).unwrap();
        assert_eq!(unsafe { sqlite3_exec(db.0, query.as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
    }
    #[test]
    fn seed_reads_committed_wal_without_copying_logs_or_replacing_a_pane() {
        let root = std::env::temp_dir().join(format!("loom-state-test-{}", std::process::id()));
        let home = root.join("home");
        let pane = root.join("pane");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&pane).unwrap();
        let source = Db::open(&home.join("state_5.sqlite"), 6).unwrap();
        sql(&source, "PRAGMA journal_mode=WAL; CREATE TABLE history(v INTEGER); INSERT INTO history VALUES(1); BEGIN IMMEDIATE; INSERT INTO history VALUES(2);");
        std::fs::write(home.join("logs_2.sqlite"), "do not copy").unwrap();
        seed(&home, &pane);
        assert!(!pane.join("logs_2.sqlite").exists());
        let dest = Db::open(&pane.join("state_5.sqlite"), 2).unwrap();
        sql(&dest, "CREATE TABLE verify(v INTEGER CHECK(v=1)); INSERT INTO verify SELECT count(*) FROM history; INSERT INTO history VALUES(9);");
        seed(&home, &pane);
        sql(&dest, "CREATE TABLE kept(v INTEGER CHECK(v=9)); INSERT INTO kept SELECT max(v) FROM history;");
        sql(&source, "ROLLBACK;");
        drop(dest);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}
