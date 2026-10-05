use std::os::windows::fs::OpenOptionsExt;
use std::{fs::{self, File, OpenOptions}, path::{Path, PathBuf}};

pub struct Store {
    pub path: PathBuf,
    _lease: File,
}

pub fn acquire(path: &Path) -> std::io::Result<Store> {
    let path = std::path::absolute(path)?;
    let path = if path.exists() { path.canonicalize()? } else {
        let parent = path.parent().ok_or_else(|| std::io::Error::other("Workspace has no parent directory"))?;
        fs::create_dir_all(parent)?;
        parent.canonicalize()?.join(path.file_name().unwrap())
    };
    let lease = OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0)
        .open(path.with_extension("tasks.lock"))?;
    Ok(Store { path, _lease: lease })
}

/// `acquire`, retried for `wait`: a Loom that is still exiting holds the lease a moment longer.
pub fn acquire_waiting(path: &Path, wait: std::time::Duration) -> std::io::Result<Store> {
    let end = std::time::Instant::now() + wait;
    loop {
        match acquire(path) {
            Err(_) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(100)),
            lease => return lease,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_writer_per_workspace_and_journal() {
        let dir = std::env::temp_dir().join(format!("loom-owner-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("work.json");
        let first = acquire(&path).unwrap();
        assert!(acquire(&dir.join("./work.json")).is_err(), "a second instance must not write the same journal");
        assert!(acquire(&dir.join("work.txt")).is_err(), "different extensions share one tasks.jsonl path");
        use std::os::windows::process::CommandExt;
        let alias = dir.join("alias");
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
            .arg(&alias).arg(&dir).creation_flags(0x0800_0000).output().unwrap();
        assert!(made.status.success());
        assert!(acquire(&alias.join("work.json")).is_err(), "junction aliases share ownership");
        assert_eq!(crate::pipe::pipe_name(Some(&path.to_string_lossy())), crate::pipe::pipe_name(Some(&alias.join("work.json").to_string_lossy())));
        fs::remove_dir(alias).unwrap();
        // A Loom still exiting: the next one waits for its lease, and gives up on one held for good.
        assert!(acquire_waiting(&path, std::time::Duration::from_millis(300)).is_err());
        let exiting = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(300)); drop(first); });
        drop(acquire_waiting(&path, std::time::Duration::from_secs(5)).unwrap());
        exiting.join().unwrap();
        fs::remove_file(dir.join("work.tasks.lock")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
