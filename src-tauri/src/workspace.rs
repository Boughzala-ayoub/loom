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
        drop(first);
        drop(acquire(&path).unwrap());
        fs::remove_file(dir.join("work.tasks.lock")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
