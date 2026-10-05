//! Identity of what deleting a worktree loses, for destructive approval. Never follow reparse points.
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}, time::{Duration, Instant}};
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
            if path.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".git")) {
                if dir == root { continue; }
                // Another worktree or repository, with its own changes, commits and
                // lock: no approval of this folder covers it, not even --force.
                return Err(format!("{} holds another checkout at {}; move or delete that one first", root.display(), dir.display()));
            }
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
/// std's remove_dir_all removes each link inside as itself, then the worktree's
/// entry in `repo` goes, as `git worktree remove` drops it. The folder itself
/// is taken as it is, never resolved: a link there goes nowhere.
pub fn remove_worktree(repo: &str, dir: &str) -> Result<(), String> {
    let dir = Path::new(dir);
    let common = crate::git_run(repo.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    let worktrees = Path::new(repo).join(common.trim()).join("worktrees");
    let meta = match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return forget(&worktrees, dir),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
        Ok(m) => m,
    };
    if meta.file_attributes() & 0x400 != 0 || !meta.is_dir() {
        return Err(format!("{} is a link or not a folder; Loom deletes only a worktree's own folder", dir.display()));
    }
    let entry = entry_of(dir, &worktrees)?;
    fingerprint(dir, None, &[])?; // the walk refuses a folder holding another checkout
    fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    fs::remove_dir_all(&entry).map_err(|e| format!("removed {} but not git's record of it, {}: {e}", dir.display(), entry.display()))
}

/// The entry in `worktrees` that `dir` is, by git's own two links: dir\.git
/// names the entry and the entry's gitdir names that same .git back. Compared
/// as files, not spellings, so a folder put at the worktree's path, or behind
/// a redirected parent, isn't taken for it. A locked entry is refused.
fn entry_of(dir: &Path, worktrees: &Path) -> Result<PathBuf, String> {
    let not = || format!("{} isn't a linked worktree of this repository", dir.display());
    let id = |path: &Path| -> Result<(u64, u64), String> {
        // FILE_FLAG_BACKUP_SEMANTICS: folders open too.
        let f = fs::OpenOptions::new().access_mode(0x80).share_mode(7).custom_flags(0x0200_0000).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        crate::usage::file_identity(&f).ok_or_else(|| format!("{}: no file identity", path.display()))
    };
    let dot = dir.join(".git");
    // The main checkout's .git is a folder.
    if !fs::symlink_metadata(&dot).is_ok_and(|m| m.is_file() && m.file_attributes() & 0x400 == 0) { return Err(not()); }
    let named = fs::read_to_string(&dot).map_err(|e| format!("{}: {e}", dot.display()))?;
    let entry = dir.join(named.trim().strip_prefix("gitdir:").ok_or_else(not)?.trim());
    if id(entry.parent().ok_or_else(not)?)? != id(worktrees)? { return Err(not()); }
    let back = fs::read_to_string(entry.join("gitdir")).map_err(|_| not())?;
    if id(&entry.join(back.trim()))? != id(&dot)? { return Err(not()); }
    if entry.join("locked").exists() { return Err(format!("{} is a locked worktree", dir.display())); }
    Ok(entry)
}

/// `dir` is gone already: drop the entry whose gitdir names dir\.git, if any.
// ponytail: absolute gitdir text only; a relative one (git 2.48 worktree.useRelativePaths) isn't matched and its entry stays for `git worktree prune`.
fn forget(worktrees: &Path, dir: &Path) -> Result<(), String> {
    let key = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let want = key(&dir.join(".git"));
    let entries = match fs::read_dir(worktrees) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        r => r.map_err(|e| format!("{}: {e}", worktrees.display()))?,
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?.path();
        let Ok(back) = fs::read_to_string(entry.join("gitdir")) else { continue };
        if key(Path::new(back.trim())) != want { continue; }
        if entry.join("locked").exists() { return Err(format!("{} is a locked worktree", dir.display())); }
        return fs::remove_dir_all(&entry).map_err(|e| format!("{}: {e}", entry.display()));
    }
    Ok(())
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
    fn a_redirected_worktree_path_is_never_what_goes() {
        let dir = std::env::temp_dir().join(format!("loom-remove-redirected-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, outside) = (dir.join("repo"), dir.join("wt"), dir.join("outside"));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        let repo_s = repo.to_str().unwrap();
        // Moved aside, and a junction to another folder put in its place: git still lists the path.
        fs::rename(&wt, dir.join("wt-aside")).unwrap();
        junction(&wt, &outside);
        assert!(remove_worktree(repo_s, wt.to_str().unwrap()).is_err());
        assert!(outside.join("keep.txt").is_file(), "the junction's target was deleted");
        assert!(dir.join("wt-aside").join(".git").is_file());
        // An ancestor redirected: the folder now at the worktree's path is someone else's.
        let (anc, other) = (dir.join("anc"), dir.join("other"));
        let wt2 = anc.join("wt2");
        git(&repo, &["worktree", "add", "-q", "-b", "t2", wt2.to_str().unwrap()]);
        fs::rename(&anc, dir.join("anc-aside")).unwrap();
        fs::create_dir_all(other.join("wt2")).unwrap();
        fs::write(other.join("wt2").join("keep.txt"), "keep").unwrap();
        junction(&anc, &other);
        assert!(remove_worktree(repo_s, wt2.to_str().unwrap()).is_err());
        assert!(other.join("wt2").join("keep.txt").is_file(), "an unrelated folder behind a redirected parent was deleted");
        // A junction to the moved worktree itself: git's links check out, the link still isn't the folder.
        fs::remove_dir(&wt).unwrap();
        junction(&wt, &dir.join("wt-aside"));
        assert!(remove_worktree(repo_s, wt.to_str().unwrap()).is_err());
        assert!(git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t\n"), "git's record of a worktree that still exists went");
        // Already gone: only git's record of it goes.
        fs::remove_dir(&wt).unwrap();
        remove_worktree(repo_s, wt.to_str().unwrap()).unwrap();
        assert!(!git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t\n"));
        assert!(dir.join("wt-aside").join(".git").is_file());
        fs::remove_dir_all(dir).unwrap(); // removes the junctions, not their targets
    }

    #[test]
    fn a_worktree_holding_another_checkout_stays() {
        let dir = std::env::temp_dir().join(format!("loom-remove-nested-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, outer) = (dir.join("repo"), dir.join("outer"));
        let inner = outer.join("nested");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "outer", outer.to_str().unwrap()]);
        git(&repo, &["worktree", "add", "-q", "-b", "inner", inner.to_str().unwrap()]);
        fs::write(inner.join("work.txt"), "unsaved").unwrap();
        git(&repo, &["worktree", "lock", inner.to_str().unwrap()]);
        let repo_s = repo.to_str().unwrap();
        assert!(remove_worktree(repo_s, outer.to_str().unwrap()).is_err(), "a worktree inside went with it");
        assert!(inner.join("work.txt").is_file());
        assert!(git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/inner"));
        // Another repository's checkout, which this repository's worktree list never shows.
        fs::remove_file(inner.join("work.txt")).unwrap();
        git(&repo, &["worktree", "unlock", inner.to_str().unwrap()]);
        git(&repo, &["worktree", "remove", inner.to_str().unwrap()]);
        fs::create_dir_all(outer.join("vendor/lib")).unwrap();
        git(&outer.join("vendor/lib"), &["init", "-q"]);
        assert!(remove_worktree(repo_s, outer.to_str().unwrap()).is_err(), "another repository inside went with it");
        assert!(outer.join("vendor/lib/.git").is_dir());
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
