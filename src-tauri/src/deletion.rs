//! Content identity for destructive worktree approval. Never follow reparse points.
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, time::{Duration, Instant}};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

pub fn fingerprint(root: &Path, index: Option<&Path>) -> Result<String, String> {
    let started = Instant::now();
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut entries = 0usize;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut file = |path: &Path, hash: &mut Sha256| -> Result<(), String> {
        // Deny concurrent writes/deletion while reading this file; fail closed if busy.
        let mut f = fs::OpenOptions::new().read(true).share_mode(1).open(path).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        hash.update(len.to_le_bytes());
        let mut buf = [0; 65536];
        loop {
            if started.elapsed() > Duration::from_secs(5) || bytes > 256 * 1024 * 1024 {
                return Err("Deletion check exceeded 5 seconds or 256 MiB; keep the folder and remove it manually after inspection".into());
            }
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            bytes += n as u64;
            hash.update(&buf[..n]);
        }
        Ok(())
    };
    while let Some((path, depth)) = pending.pop() {
        entries += 1;
        if entries > 20_000 || depth > 64 || started.elapsed() > Duration::from_secs(5) {
            return Err("Deletion check exceeded its traversal limit; keep the folder and inspect it manually".into());
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Deletion check found a reparse point; keep the folder and inspect it manually".into());
        }
        let name = path.strip_prefix(root).map_err(|e| e.to_string())?.as_os_str();
        use std::os::windows::ffi::OsStrExt;
        let name: Vec<u16> = name.encode_wide().collect();
        hash.update((name.len() as u64).to_le_bytes());
        for unit in name { hash.update(unit.to_le_bytes()); }
        hash.update([u8::from(meta.is_dir())]);
        if meta.is_dir() {
            let mut children = Vec::new();
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                if entries + pending.len() + children.len() >= 20_000 || started.elapsed() > Duration::from_secs(5) {
                    return Err("Deletion check exceeded its traversal limit".into());
                }
                children.push(entry.map_err(|e| e.to_string())?.path());
            }
            children.sort();
            for child in children {
                if depth == 0 && child.file_name().is_some_and(|n| n == ".git") { continue; }
                pending.push((child, depth + 1));
            }
        } else if meta.is_file() { file(&path, &mut hash)?; }
        else { return Err("Deletion check found an unsupported file type".into()); }
    }
    if let Some(index) = index { file(index, &mut hash)?; }
    Ok(format!("{:x}", hash.finalize()))
}

/// Delete `dir`, a linked worktree of `repo`. Git for Windows' `worktree remove`
/// recurses through junctions and empties their targets, so git never walks it:
/// std's remove_dir_all removes each link itself, then git drops its record of
/// the folder, which it does once the folder is gone.
pub fn remove_worktree(repo: &str, dir: &str) -> Result<(), String> {
    let git = |args: &[&str]| crate::git_run(repo.into(), args.iter().map(|a| a.to_string()).collect(), None);
    if let Ok(real) = fs::canonicalize(dir) {
        let list = git(&["worktree", "list", "--porcelain"])?;
        // The first entry is the main checkout, never removed here.
        let entry = list.split("\n\n").skip(1).find(|e| {
            e.lines().next().and_then(|l| l.strip_prefix("worktree ")).and_then(|p| fs::canonicalize(p).ok()).as_ref() == Some(&real)
        });
        let entry = entry.ok_or_else(|| format!("{dir} isn't a worktree of {repo}"))?;
        if entry.lines().any(|l| l == "locked" || l.starts_with("locked ")) { return Err(format!("{dir} is a locked worktree")); }
        fs::remove_dir_all(&real).map_err(|e| e.to_string())?;
    }
    git(&["worktree", "remove", "--force", dir]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=check", "-c", "user.email=check@loom"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn junction(link: &Path, target: &Path) {
        assert!(Command::new("cmd").arg("/c").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap().status.success());
    }

    #[test]
    fn removing_a_worktree_never_follows_its_links() {
        let dir = std::env::temp_dir().join(format!("loom-remove-worktree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, outside) = (dir.join("repo"), dir.join("wt"), dir.join("outside"));
        fs::create_dir_all(outside.join("deep")).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        fs::write(outside.join("deep/keep.txt"), "keep").unwrap();
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        fs::create_dir(repo.join("sub")).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::create_dir_all(wt.join("a/b")).unwrap();
        junction(&wt.join("node_modules"), &outside);
        junction(&wt.join("a").join("b").join("link"), &outside.join("deep")); // mklink reads "/" as a switch
        fs::write(wt.join("ro.txt"), "x").unwrap();
        let mut ro = fs::metadata(wt.join("ro.txt")).unwrap().permissions();
        ro.set_readonly(true);
        fs::set_permissions(wt.join("ro.txt"), ro).unwrap();
        let (repo_s, wt_s) = (repo.to_str().unwrap(), wt.to_str().unwrap());
        // Only a worktree git lists goes: never the checkout itself or a folder in it.
        assert!(remove_worktree(repo_s, repo.join("sub").to_str().unwrap()).is_err());
        assert!(remove_worktree(repo_s, repo_s).is_err());
        assert!(repo.join("sub").is_dir());
        remove_worktree(repo_s, wt_s).unwrap();
        assert!(outside.join("keep.txt").is_file() && outside.join("deep/keep.txt").is_file(), "a junction's target was emptied");
        assert!(!wt.exists());
        assert!(!git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn approval_tracks_contents_ignored_children_and_index() {
        let dir = std::env::temp_dir().join(format!("loom-delete-check-{}", std::process::id()));
        fs::create_dir_all(dir.join("ignored")).unwrap();
        let path = dir.join("dirty");
        fs::write(&path, "before").unwrap();
        let first = fingerprint(&dir, None).unwrap();
        fs::write(&path, "after!").unwrap(); // same size, no timestamp dependency
        let second = fingerprint(&dir, None).unwrap();
        assert_ne!(first, second);
        fs::write(dir.join("ignored/child"), "new").unwrap();
        assert_ne!(second, fingerprint(&dir, None).unwrap());
        fs::create_dir(dir.join(".git")).unwrap();
        let index = dir.join(".git/index");
        fs::write(&index, "index1").unwrap();
        let first = fingerprint(&dir, Some(&index)).unwrap();
        fs::write(&index, "index2").unwrap();
        assert_ne!(first, fingerprint(&dir, Some(&index)).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
