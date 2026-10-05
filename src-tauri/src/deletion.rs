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

/// How long a deleted worktree waits in Loom's trash before [`purge`] erases it.
pub const KEEP: Duration = Duration::from_secs(24 * 3600);

/// Where a deleted worktree's folder and git's record of it went. Written into
/// the trash before either moves, so even a crash leaves it: put both back to
/// undo the deletion.
#[derive(serde::Serialize, serde::Deserialize)]
struct Trashed { folder: PathBuf, at: PathBuf, entry: PathBuf, entry_at: PathBuf }

/// Delete `dir`, a linked worktree of `repo`, by moving it into `trash` and
/// git's record of it into the repository's loom-trash. Nothing is erased
/// here; [`purge`] does that a day later. So a file written into it after the
/// checks, or a wrong folder that got through them, is in the trash, not lost.
/// Git for Windows' `worktree remove` recurses through junctions and empties
/// their targets, so git never touches it. The folder itself is taken as it
/// is, never resolved: a link there goes nowhere. Returns where it went, or ""
/// when it was gone already and only git's record of it went.
pub fn remove_worktree(repo: &str, dir: &str, trash: &Path) -> Result<String, String> {
    let dir = Path::new(dir);
    let common = crate::git_run(repo.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    let common = Path::new(repo).join(common.trim());
    let worktrees = common.join("worktrees");
    let name = dir.file_name().ok_or_else(|| format!("{} has no folder name", dir.display()))?.to_string_lossy();
    // An older Loom that stopped mid-deletion left the folder claimed beside its
    // path, with git's record still naming the path: that deletion goes on here.
    let claim = dir.with_file_name(format!(".{name}.loom-deleting"));
    let from = match fs::symlink_metadata(dir) {
        Ok(_) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && fs::symlink_metadata(&claim).is_ok() => &claim,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return forget(&worktrees, dir).map(|()| String::new()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let meta = fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if meta.file_attributes() & 0x400 != 0 || !meta.is_dir() {
        return Err(format!("{} is a link or not a folder; Loom deletes only a worktree's own folder", from.display()));
    }
    let entry = entry_of(from, dir, &worktrees)?;
    // The walk refuses a folder holding another checkout, even with --force.
    fingerprint(from, None, &[])?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let id = format!("{stamp}-{name}");
    let file = trash.join(format!("{id}.json"));
    let mut record = Trashed { folder: dir.into(), at: trash.join(&id), entry: entry.clone(), entry_at: common.join("loom-trash").join(&id) };
    let write = |r: &Trashed| fs::create_dir_all(trash).and_then(|_| fs::write(&file, serde_json::to_vec_pretty(r).expect("paths serialize")));
    // Windows refuses to move a folder while anything inside is open (a
    // process's cwd, a file being written), so nothing is cut off mid-write.
    let mut moved = write(&record).and_then(|_| fs::rename(from, &record.at));
    if moved.as_ref().is_err_and(|e| e.raw_os_error() == Some(17)) {
        // ERROR_NOT_SAME_DEVICE: on another volume than Loom's trash, it waits beside its own path.
        record.at = dir.with_file_name(format!(".{id}.loom-trash"));
        moved = write(&record).and_then(|_| fs::rename(from, &record.at));
    }
    if let Err(e) = moved {
        let _ = fs::remove_file(&file);
        return Err(format!("couldn't move {} to Loom's trash; is something still using it? {e}", dir.display()));
    }
    fs::create_dir_all(common.join("loom-trash")).and_then(|_| fs::rename(&entry, &record.entry_at))
        .map_err(|e| format!("moved {} to {}, but git still records it, at {}: {e}", dir.display(), record.at.display(), entry.display()))?;
    Ok(record.at.to_string_lossy().into_owned())
}

/// Erase what went into `trash` more than `keep` ago: the folder each record
/// names, git's record of it, then the record. One put back by hand isn't
/// where its record says any more, so it stays. A failure waits for the next
/// purge.
// ponytail: a crash between the two moves leaves git's record in place, naming a
// folder that's gone; `git worktree prune` (run before each new thread) drops it.
pub fn purge(trash: &Path, keep: Duration) {
    let Ok(list) = fs::read_dir(trash) else { return };
    for file in list.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let due = fs::metadata(&file).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= keep));
        let Some(r) = due.then(|| fs::read(&file).ok()).flatten().and_then(|b| serde_json::from_slice::<Trashed>(&b).ok()) else { continue };
        // remove_dir_all removes each link inside as itself, never what it points to.
        let erase = |p: &Path| match fs::remove_dir_all(p) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e), _ => Ok(()) };
        if erase(&r.at).and_then(|_| erase(&r.entry_at)).is_ok() { let _ = fs::remove_file(&file); }
    }
}

/// The entry in `worktrees` that the folder at `from` is, by git's own two
/// links: from\.git names the entry, and the entry records the path git keeps
/// that worktree at, which must be `dir`. A folder reached through a moved or
/// redirected path names an entry that records its own path, so it isn't
/// taken for `dir`'s. A locked entry is refused.
fn entry_of(from: &Path, dir: &Path, worktrees: &Path) -> Result<PathBuf, String> {
    let not = || format!("{} isn't a linked worktree of this repository", dir.display());
    let id = |path: &Path| -> Result<(u64, u64), String> {
        // FILE_FLAG_BACKUP_SEMANTICS: folders open too.
        let f = fs::OpenOptions::new().access_mode(0x80).share_mode(7).custom_flags(0x0200_0000).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        crate::usage::file_identity(&f).ok_or_else(|| format!("{}: no file identity", path.display()))
    };
    let dot = from.join(".git");
    // The main checkout's .git is a folder.
    if !fs::symlink_metadata(&dot).is_ok_and(|m| m.is_file() && m.file_attributes() & 0x400 == 0) { return Err(not()); }
    let named = fs::read_to_string(&dot).map_err(|e| format!("{}: {e}", dot.display()))?;
    let entry = from.join(named.trim().strip_prefix("gitdir:").ok_or_else(not)?.trim());
    if id(entry.parent().ok_or_else(not)?)? != id(worktrees)? { return Err(not()); }
    let back = fs::read_to_string(entry.join("gitdir")).map_err(|_| not())?;
    let kept = entry.join(back.trim());
    if spelled(&kept) != spelled(&dir.join(".git")) {
        return Err(format!("{} leads to the worktree git keeps at {}, not to its own; Loom deletes a worktree only at the path git records for it",
            dir.display(), kept.parent().unwrap_or(&kept).display()));
    }
    if entry.join("locked").exists() { return Err(format!("{} is a locked worktree", dir.display())); }
    Ok(entry)
}

/// One spelling of a path: absolute, with `/` and `..` resolved as text (no
/// link followed) and case folded, as git records a worktree's path.
fn spelled(p: &Path) -> String {
    std::path::absolute(p).unwrap_or_else(|_| p.into()).to_string_lossy().to_lowercase()
}

/// `dir` is gone already: drop the entry whose gitdir names dir\.git, if any.
fn forget(worktrees: &Path, dir: &Path) -> Result<(), String> {
    let want = spelled(&dir.join(".git"));
    let entries = match fs::read_dir(worktrees) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        r => r.map_err(|e| format!("{}: {e}", worktrees.display()))?,
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?.path();
        let Ok(back) = fs::read_to_string(entry.join("gitdir")) else { continue };
        if spelled(&entry.join(back.trim())) != want { continue; }
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
        let (repo, wt, outside, trash) = (dir.join("repo"), dir.join("wt"), dir.join("outside"), dir.join("trash"));
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
        assert!(remove_worktree(repo_s, repo.join("sub").to_str().unwrap(), &trash).is_err());
        assert!(remove_worktree(repo_s, repo_s, &trash).is_err());
        assert!(repo.join("sub").is_dir());
        let at = remove_worktree(repo_s, wt_s, &trash).unwrap();
        assert!(!wt.exists() && Path::new(&at).join("ro.txt").is_file());
        purge(&trash, Duration::ZERO);
        assert!(outside.join("keep.txt").is_file() && outside.join("deep/keep.txt").is_file(), "a junction's target was emptied");
        assert!(!Path::new(&at).exists());
        assert!(!git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_redirected_worktree_path_is_never_what_goes() {
        let dir = std::env::temp_dir().join(format!("loom-remove-redirected-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, outside, trash) = (dir.join("repo"), dir.join("wt"), dir.join("outside"), dir.join("trash"));
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
        assert!(remove_worktree(repo_s, wt.to_str().unwrap(), &trash).is_err());
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
        assert!(remove_worktree(repo_s, wt2.to_str().unwrap(), &trash).is_err());
        assert!(other.join("wt2").join("keep.txt").is_file(), "an unrelated folder behind a redirected parent was deleted");
        // A junction to the moved worktree itself: git's links check out, the link still isn't the folder.
        fs::remove_dir(&wt).unwrap();
        junction(&wt, &dir.join("wt-aside"));
        assert!(remove_worktree(repo_s, wt.to_str().unwrap(), &trash).is_err());
        assert!(git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t\n"), "git's record of a worktree that still exists went");
        // Already gone: only git's record of it goes.
        fs::remove_dir(&wt).unwrap();
        assert_eq!(remove_worktree(repo_s, wt.to_str().unwrap(), &trash).unwrap(), "");
        assert!(!git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/t\n"));
        assert!(dir.join("wt-aside").join(".git").is_file());
        fs::remove_dir_all(dir).unwrap(); // removes the junctions, not their targets
    }

    #[test]
    fn a_worktree_holding_another_checkout_stays() {
        let dir = std::env::temp_dir().join(format!("loom-remove-nested-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, outer, trash) = (dir.join("repo"), dir.join("outer"), dir.join("trash"));
        let inner = outer.join("nested");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "outer", outer.to_str().unwrap()]);
        git(&repo, &["worktree", "add", "-q", "-b", "inner", inner.to_str().unwrap()]);
        fs::write(inner.join("work.txt"), "unsaved").unwrap();
        git(&repo, &["worktree", "lock", inner.to_str().unwrap()]);
        let repo_s = repo.to_str().unwrap();
        assert!(remove_worktree(repo_s, outer.to_str().unwrap(), &trash).is_err(), "a worktree inside went with it");
        assert!(inner.join("work.txt").is_file());
        assert!(git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/inner"));
        // Another repository's checkout, which this repository's worktree list never shows.
        fs::remove_file(inner.join("work.txt")).unwrap();
        git(&repo, &["worktree", "unlock", inner.to_str().unwrap()]);
        git(&repo, &["worktree", "remove", inner.to_str().unwrap()]);
        fs::create_dir_all(outer.join("vendor/lib")).unwrap();
        git(&outer.join("vendor/lib"), &["init", "-q"]);
        assert!(remove_worktree(repo_s, outer.to_str().unwrap(), &trash).is_err(), "another repository inside went with it");
        assert!(outer.join("vendor/lib/.git").is_dir());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_deleted_worktree_waits_in_the_trash_until_purged() {
        let dir = std::env::temp_dir().join(format!("loom-remove-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a.txt"), "work").unwrap();
        let (repo_s, wt_s) = (repo.to_str().unwrap(), wt.to_str().unwrap());
        let listed = |branch: &str| git(&repo, &["worktree", "list", "--porcelain"]).contains(&format!("refs/heads/{branch}\n"));
        let records = || fs::read_dir(&trash).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).map(|e| e.path()).collect::<Vec<_>>();
        // Something still holds a file open in it: it can't move, nothing goes.
        let open = fs::File::open(wt.join("a.txt")).unwrap();
        assert!(remove_worktree(repo_s, wt_s, &trash).is_err());
        assert!(wt.join("a.txt").is_file() && listed("t") && records().is_empty());
        drop(open);
        let at = PathBuf::from(remove_worktree(repo_s, wt_s, &trash).unwrap());
        assert!(!wt.exists() && at.starts_with(&trash) && at.join("a.txt").is_file() && !listed("t"));
        // Undone by hand as its record says: git has it back, and a purge leaves it be.
        let [record] = &records()[..] else { panic!("one record") };
        let r: Trashed = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
        assert_eq!((r.folder.as_path(), r.at.as_path()), (wt.as_path(), at.as_path()));
        fs::rename(&r.at, &r.folder).unwrap();
        fs::rename(&r.entry_at, &r.entry).unwrap();
        assert!(listed("t") && git(&wt, &["status", "--porcelain"]).contains("a.txt"));
        purge(&trash, Duration::ZERO);
        assert!(wt.join("a.txt").is_file() && records().is_empty(), "a worktree put back was purged");
        // Deleted again: kept for a day, then erased with git's record of it.
        let at = PathBuf::from(remove_worktree(repo_s, wt_s, &trash).unwrap());
        purge(&trash, KEEP);
        assert!(at.join("a.txt").is_file());
        purge(&trash, Duration::ZERO);
        assert!(!at.exists() && records().is_empty() && fs::read_dir(repo.join(".git").join("loom-trash")).unwrap().count() == 0);
        // An older Loom stopped after claiming one, git's record still naming its path: it goes the same way.
        let wt2 = dir.join("wt2");
        git(&repo, &["worktree", "add", "-q", "-b", "t2", wt2.to_str().unwrap()]);
        fs::rename(&wt2, dir.join(".wt2.loom-deleting")).unwrap();
        let at = PathBuf::from(remove_worktree(repo_s, wt2.to_str().unwrap(), &trash).unwrap());
        assert!(!dir.join(".wt2.loom-deleting").exists() && at.join(".git").is_file() && !listed("t2"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_parent_redirected_to_another_worktree_never_takes_it() {
        let dir = std::env::temp_dir().join(format!("loom-remove-sibling-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, a, b, trash) = (dir.join("repo"), dir.join("A"), dir.join("B"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "ta", a.join("wt").to_str().unwrap()]);
        git(&repo, &["worktree", "add", "-q", "-b", "tb", b.join("wt").to_str().unwrap()]);
        fs::write(b.join("wt").join("unsaved.txt"), "B's work").unwrap();
        // A's folder moved aside, and a junction to B put where A was: A's thread now reaches B.
        fs::rename(&a, dir.join("A-aside")).unwrap();
        junction(&a, &b);
        assert!(remove_worktree(repo.to_str().unwrap(), a.join("wt").to_str().unwrap(), &trash).is_err(), "B's worktree went for A's");
        assert!(b.join("wt").join("unsaved.txt").is_file() && !trash.exists());
        assert!(git(&repo, &["worktree", "list", "--porcelain"]).contains("refs/heads/tb\n"));
        fs::remove_dir(&a).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_written_after_the_checks_is_never_destroyed() {
        let dir = std::env::temp_dir().join(format!("loom-remove-writer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("marker.txt"), "").unwrap();
        // Enough built output that checking it takes a while.
        fs::create_dir(wt.join("target")).unwrap();
        for i in 0..5_000 { fs::write(wt.join("target").join(i.to_string()), "").unwrap(); }
        // A writer that follows the folder wherever it's moved, and writes there.
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (dir, wt, trash, done) = (dir.clone(), wt.clone(), trash.clone(), done.clone());
            std::thread::spawn(move || {
                let mut wrote = Vec::new();
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(20) && !done.load(std::sync::atomic::Ordering::SeqCst) {
                    let moved = [&dir, &trash].into_iter().flat_map(fs::read_dir).flatten().flatten().map(|e| e.path())
                        .find(|p| *p != wt && p.join("marker.txt").is_file());
                    if let Some(moved) = moved {
                        let late = moved.join(format!("late-{}.txt", wrote.len()));
                        if fs::write(&late, "written after the checks").is_ok() { wrote.push(late); }
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                wrote
            })
        };
        let removed = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash);
        std::thread::sleep(Duration::from_millis(100));
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let wrote = writer.join().unwrap();
        assert!(!wrote.is_empty(), "the writer never found the folder");
        let lost: Vec<_> = wrote.iter().filter(|p| !p.is_file()).collect();
        assert!(lost.is_empty(), "{} of {} files written after the checks were destroyed", lost.len(), wrote.len());
        assert!(removed.is_ok(), "{removed:?}");
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
