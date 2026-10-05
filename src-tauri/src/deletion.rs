//! Identity of what deleting a worktree loses, for destructive approval. Never follow reparse points.
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, time::{Duration, Instant}};
use std::os::windows::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}};

/// One hash over the worktree at `root`. `hashed` (git's tracked changes and
/// untracked files, relative to `root`) and the index count by contents, the
/// rest by name, size and modified time, so ignored build output costs a
/// metadata walk. A link counts as itself and is never followed. Fails closed
/// when the bounded check can't finish.
pub fn fingerprint(root: &Path, index: Option<&Path>, hashed: &[String]) -> Result<String, String> {
    let started = Instant::now();
    let late = || started.elapsed() > Duration::from_secs(15);
    let mut hash = Sha256::new();
    let name = |hash: &mut Sha256, name: &std::ffi::OsStr| {
        let name: Vec<u16> = name.encode_wide().collect();
        hash.update((name.len() as u64).to_le_bytes());
        for unit in name { hash.update(unit.to_le_bytes()); }
    };
    let mut bytes = 0u64;
    let mut file = |path: &Path, hash: &mut Sha256| -> Result<(), String> {
        // Share read, write and delete: an agent, a dev server or SQLite may hold
        // it open. A size or time that moved while it was read means it changed.
        let mut f = fs::OpenOptions::new().read(true).share_mode(7).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let stamp = |f: &fs::File| f.metadata().map(|m| (m.len(), m.last_write_time())).map_err(|e| e.to_string());
        let before = stamp(&f)?;
        hash.update(before.0.to_le_bytes());
        let mut buf = [0; 65536];
        loop {
            if late() || bytes > 256 * 1024 * 1024 {
                return Err("Deletion check exceeded 15 seconds or 256 MiB of changed files; keep the folder and remove it manually after inspection".into());
            }
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            bytes += n as u64;
            hash.update(&buf[..n]);
        }
        if stamp(&f)? != before { return Err(format!("{} changed while the deletion check read it", path.display())); }
        Ok(())
    };
    let mut entries = 0usize;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let mut children = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            entries += 1;
            if entries > 2_000_000 || late() {
                return Err("Deletion check exceeded its traversal limit; keep the folder and inspect it manually".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            // From the directory listing itself: no extra open, links not followed.
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            children.push((entry.path(), meta));
        }
        children.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, meta) in children {
            if dir == root && path.file_name().is_some_and(|n| n == ".git") { continue; }
            name(&mut hash, path.strip_prefix(root).map_err(|e| e.to_string())?.as_os_str());
            if meta.file_attributes() & 0x400 != 0 { hash.update([2]); }
            else if meta.is_dir() { hash.update([1]); pending.push(path); }
            else { hash.update([0]); hash.update(meta.len().to_le_bytes()); hash.update(meta.last_write_time().to_le_bytes()); }
        }
    }
    let mut hashed: Vec<&String> = hashed.iter().collect();
    hashed.sort();
    hashed.dedup();
    for rel in hashed {
        name(&mut hash, rel.as_ref());
        let path = root.join(rel);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => hash.update([0]), // deleted
            Err(e) => return Err(format!("{}: {e}", path.display())),
            Ok(m) if m.is_file() && m.file_attributes() & 0x400 == 0 => { hash.update([1]); file(&path, &mut hash)?; }
            Ok(_) => hash.update([2]), // a submodule or a link: the walk has it
        }
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
    fn approval_reads_large_linked_and_busy_worktrees() {
        let dir = std::env::temp_dir().join(format!("loom-delete-scale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (root, outside) = (dir.join("wt"), dir.join("outside"));
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("big"), "outside").unwrap();
        // Built output: more entries than any content hash could afford.
        for i in 0..20_100 { fs::write(root.join("target").join(i.to_string()), "").unwrap(); }
        junction(&root.join("node_modules"), &outside);
        fs::write(root.join("dirty.txt"), "before").unwrap();
        fs::write(root.join("clean.txt"), "same").unwrap();
        let hashed = ["dirty.txt".to_string(), "gone.txt".to_string()];
        // An agent or a dev server holds a file open for writing.
        let _busy = fs::OpenOptions::new().append(true).open(root.join("dirty.txt")).unwrap();
        let first = fingerprint(&root, None, &hashed).unwrap();
        assert_eq!(first, fingerprint(&root, None, &hashed).unwrap());
        fs::write(outside.join("big"), "changed outside, never read").unwrap();
        assert_eq!(first, fingerprint(&root, None, &hashed).unwrap(), "a link is not followed");
        fs::write(root.join("dirty.txt"), "after!").unwrap();
        let second = fingerprint(&root, None, &hashed).unwrap();
        assert_ne!(first, second, "a listed file counts by contents");
        fs::write(root.join("target/7"), "built").unwrap();
        let third = fingerprint(&root, None, &hashed).unwrap();
        assert_ne!(second, third, "any other file counts by size and time");
        fs::write(root.join("gone.txt"), "").unwrap();
        assert_ne!(third, fingerprint(&root, None, &hashed).unwrap());
        drop(_busy);
        fs::remove_dir_all(dir).unwrap();
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
        let dirty = ["dirty".to_string()];
        let first = fingerprint(&dir, None, &dirty).unwrap();
        let stamp = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "after!").unwrap(); // same size and time: only the contents tell
        fs::File::options().write(true).open(&path).unwrap().set_modified(stamp).unwrap();
        let second = fingerprint(&dir, None, &dirty).unwrap();
        assert_ne!(first, second);
        fs::write(dir.join("ignored/child"), "new").unwrap();
        assert_ne!(second, fingerprint(&dir, None, &dirty).unwrap());
        fs::create_dir(dir.join(".git")).unwrap();
        let index = dir.join(".git/index");
        fs::write(&index, "index1").unwrap();
        let first = fingerprint(&dir, Some(&index), &[]).unwrap();
        fs::write(&index, "index2").unwrap();
        assert_ne!(first, fingerprint(&dir, Some(&index), &[]).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
}
