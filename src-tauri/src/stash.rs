//! Drops one stash by its commit, holding git's own lock on the stash list
//! while it finds that commit and takes it out. Every worktree of a repository
//! shares one list, refs/stash's reflog. git drops only by place, and both
//! `git stash drop` and `git reflog delete` work out which entry a place means
//! before they lock refs/stash, so a stash pushed or dropped in between moves
//! another stash into that place, and that one goes. Here the lock comes
//! first: while Loom holds it, a git that would change refs/stash or its reflog
//! waits or fails, so the entry found is the entry removed. The list is
//! rewritten as git's own drop rewrites it in the files ref store.
//!
//! The list changes in one step, the new reflog renamed over the old one, so a
//! Loom stopped anywhere leaves the list whole or without that one entry, never
//! without another. A Loom killed while it holds refs/stash.lock leaves the
//! file behind, and git stash refuses in every worktree until it is deleted,
//! as after a git killed mid-drop.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Drops the stash whose commit is `sha`, in full as `git stash list` gives
/// it, from the list of the repository `dir` is in.
pub fn drop(dir: &str, sha: &str) -> Result<(), String> {
    drop_holding(dir, sha, || {})
}

/// `held` runs once the lock is taken, before the list is read: the tests race it there.
fn drop_holding(dir: &str, sha: &str, held: impl FnOnce()) -> Result<(), String> {
    let sha = sha.to_ascii_lowercase();
    if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{sha} isn't a stash's full commit, so nothing was dropped."));
    }
    let common = crate::git_run(dir.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    let common = Path::new(dir).join(common.trim());
    if common.join("reftable").exists() {
        return Err("This repository keeps its refs in a reftable, where Loom can't drop a stash by its commit. Nothing was dropped.".into());
    }
    let (refs, log_path) = (common.join("refs"), common.join("logs").join("refs").join("stash"));
    let mut lock = Lock::take(refs.join("stash.lock"))?;
    held();
    let log = match fs::read(&log_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        r => r.map_err(|e| format!("{}: {e}", log_path.display()))?,
    };
    // Oldest first, each "<old> <new> <who> <when> <zone>\t<message>": stash@{0} is the last.
    let mut lines: Vec<Vec<u8>> = log.split(|&b| b == b'\n').filter(|l| !l.is_empty()).map(<[u8]>::to_vec).collect();
    let field = |l: &[u8], i| l.split(|&b| b == b' ').nth(i).unwrap_or_default().to_vec();
    let at = lines.iter().rposition(|l| field(l, 1) == sha.as_bytes())
        .ok_or("That stash isn't in the list any more, so nothing was dropped.")?;
    let gone = lines.remove(at);
    // As git's drop rewrites the list: the entry after the dropped one now follows the one before it.
    if let Some(next) = lines.get_mut(at) {
        let rest = next.split_off(next.iter().position(|&b| b == b' ').unwrap_or(next.len()));
        *next = [field(&gone, 0), rest].concat();
    }
    let none = |e: std::io::Error| format!("Nothing was dropped: {e}");
    let Some(top) = lines.last() else { return clear(&common, &refs, &log_path, lock) };
    let mut new_log = Lock::take(log_path.with_extension("lock"))?;
    new_log.write(&lines.iter().flat_map(|l| l.iter().chain(b"\n")).copied().collect::<Vec<u8>>()).map_err(none)?;
    lock.write(&[field(top, 1), b"\n".to_vec()].concat()).map_err(none)?;
    new_log.commit(&log_path).map_err(none)?;
    // refs/stash names the newest stash left, as git's drop leaves it.
    lock.commit(&refs.join("stash")).map_err(|e| format!("Dropped the stash, but refs/stash couldn't name the newest one left: {e}"))
}

/// The last stash: no reflog and no refs/stash, as git leaves an empty list.
/// In git's order for deleting a ref: its reflog, its packed copy (git gc packs
/// refs/stash, and a copy left there would bring an old stash back), then the
/// loose file, all under packed-refs.lock too, so no git packs it meanwhile.
fn clear(common: &Path, refs: &Path, log_path: &Path, _lock: Lock) -> Result<(), String> {
    let packed = common.join("packed-refs");
    let _packing = Lock::take(common.join("packed-refs.lock"))?;
    let text = match fs::read(&packed) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        r => r.map_err(|e| format!("{}: {e}", packed.display()))?,
    };
    let mut stash = false;
    let kept: Vec<u8> = text.split_inclusive(|&b| b == b'\n').filter(|line| {
        if line.starts_with(b"^") { return !stash; } // the line above's peeled commit
        stash = line.split(|&b| b == b' ').nth(1).is_some_and(|r| r.trim_ascii_end() == b"refs/stash");
        !stash
    }).flatten().copied().collect();
    let fresh = packed.with_extension("new");
    if kept != text {
        fs::File::create(&fresh).and_then(|mut f| f.write_all(&kept).and_then(|_| f.sync_all()))
            .map_err(|e| format!("Nothing was dropped: {}: {e}", fresh.display()))?;
    }
    remove(log_path).map_err(|e| format!("Nothing was dropped: {e}"))?;
    let after = |e: std::io::Error| format!("Dropped the stash, but refs/stash is still there: {e}");
    if kept != text { rename(&fresh, &packed).map_err(after)?; }
    remove(&refs.join("stash")).map_err(after)
}

fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Windows refuses to replace a file while a git has it open to read, so the
/// rename is tried again for a second, as Git for Windows does.
fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    for _ in 0..20 {
        if fs::rename(from, to).is_ok() { return Ok(()); }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    fs::rename(from, to)
}

/// A git lock file: made only when none is there, and deleted with this unless
/// `commit` renamed it onto the file it locks, which is how git commits one.
struct Lock { path: PathBuf, file: Option<fs::File> }

impl Lock {
    fn take(path: PathBuf) -> Result<Lock, String> {
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => Ok(Lock { path, file: Some(file) }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
                "{} is there: another git is changing the stash list, or one that stopped left it. Nothing was dropped. Try again, and if it stays, delete that file while no git is running.",
                path.display())),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let file = self.file.as_mut().expect("a lock is written before its commit");
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn commit(mut self, to: &Path) -> std::io::Result<()> {
        self.file = None;
        rename(&self.path, to)?;
        self.path = PathBuf::new();
        Ok(())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        self.file = None;
        if !self.path.as_os_str().is_empty() { let _ = fs::remove_file(&self.path); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Output};

    fn git(dir: &Path, args: &[&str]) -> Output {
        Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=check", "-c", "user.email=check@loom", "-c", "core.autocrlf=false"]).args(args).output().unwrap()
    }
    fn ok(dir: &Path, args: &[&str]) -> String {
        let out = git(dir, args);
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }
    /// A repository and a second worktree of it: one stash list between them.
    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("loom-stash-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (repo, other) = (base.join("repo"), base.join("other"));
        fs::create_dir_all(&repo).unwrap();
        ok(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("f.txt"), "base\n").unwrap();
        ok(&repo, &["add", "-A"]);
        ok(&repo, &["commit", "-qm", "start"]);
        ok(&repo, &["worktree", "add", "-q", "-b", "other", other.to_str().unwrap()]);
        (base, repo, other)
    }
    /// Stashes `text` in f.txt from `dir`: the stash's commit.
    fn stash(dir: &Path, text: &str) -> String {
        fs::write(dir.join("f.txt"), format!("{text}\n")).unwrap();
        ok(dir, &["stash", "push", "-q", "-m", text]);
        ok(dir, &["rev-parse", "refs/stash"])
    }
    /// The list as `git stash list` has it, newest first, by message.
    fn listed(dir: &Path) -> Vec<String> {
        ok(dir, &["stash", "list", "--format=%gs"]).lines().map(|l| l.split_once(": ").map_or(l, |(_, m)| m).to_owned()).collect()
    }
    fn drop(dir: &Path, sha: &str) -> Result<(), String> { super::drop(dir.to_str().unwrap(), sha) }

    #[test]
    fn a_stash_goes_by_its_commit_wherever_it_is_in_the_list_and_the_last_takes_refs_stash_with_it() {
        let (base, repo, other) = fixture("places");
        let a = stash(&repo, "A");
        let b = stash(&other, "B");
        let c = stash(&repo, "C");
        // Byte for byte what git's own drop of that place writes.
        let files = [repo.join(".git/logs/refs/stash"), repo.join(".git/refs/stash")];
        let was = files.each_ref().map(|f| fs::read(f).unwrap());
        ok(&repo, &["stash", "drop", "-q", "stash@{1}"]);
        let by_git = files.each_ref().map(|f| fs::read(f).unwrap());
        for (f, bytes) in files.iter().zip(&was) { fs::write(f, bytes).unwrap(); }
        drop(&other, &b).unwrap();
        assert_eq!(files.each_ref().map(|f| fs::read(f).unwrap()), by_git, "the list isn't the one git's drop leaves");
        assert_eq!(listed(&repo), ["C", "A"], "the middle one");
        assert_eq!(ok(&repo, &["rev-parse", "stash@{1}"]), a);
        drop(&repo, &c).unwrap();
        assert_eq!((listed(&other), ok(&repo, &["rev-parse", "refs/stash"])), (vec!["A".to_owned()], a.clone()), "the newest, and refs/stash follows");
        ok(&repo, &["stash", "apply", "-q"]);
        assert_eq!(fs::read_to_string(repo.join("f.txt")).unwrap(), "A\n", "stash@{{0}} is A to git");
        assert!(drop(&repo, &c).unwrap_err().contains("isn't in the list"));
        // git gc packs refs/stash; a later stash leaves that copy under the loose one.
        ok(&repo, &["checkout", "--", "f.txt"]);
        ok(&repo, &["pack-refs", "--all"]);
        let d = stash(&repo, "D");
        drop(&repo, &d).unwrap();
        drop(&repo, &a.to_uppercase()).unwrap();
        assert!(listed(&repo).is_empty());
        assert!(!git(&repo, &["rev-parse", "-q", "--verify", "refs/stash"]).status.success(), "refs/stash, loose or packed, outlived the last stash");
        assert_eq!(ok(&repo, &["for-each-ref", "--format=%(refname)"]), "refs/heads/main\nrefs/heads/other", "the other packed refs stay");
        ok(&repo, &["fsck", "--no-dangling"]);
        let e = stash(&other, "E");
        assert_eq!((listed(&repo), ok(&repo, &["rev-parse", "stash@{0}"])), (vec!["E".to_owned()], e), "a new list starts clean");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_stash_pushed_before_the_drop_stays_and_one_pushed_while_it_holds_the_lock_waits() {
        // Review 3's case: A picked by its commit, then B pushed just before the drop takes B's place.
        let (base, repo, other) = fixture("race");
        let a = stash(&repo, "A");
        stash(&other, "B");
        drop(&repo, &a).unwrap();
        assert_eq!(listed(&repo), ["B"], "B went instead of A");
        // Another worktree stashes while the drop holds refs/stash.lock: git refuses, and its change stays.
        let c = stash(&repo, "C");
        fs::write(other.join("f.txt"), "D\n").unwrap();
        let mut pushed = None;
        super::drop_holding(repo.to_str().unwrap(), &c, || pushed = Some(git(&other, &["stash", "push", "-m", "D"]))).unwrap();
        let pushed = pushed.unwrap();
        assert!(!pushed.status.success(), "a stash pushed into a held lock: {pushed:?}");
        assert_eq!(fs::read_to_string(other.join("f.txt")).unwrap(), "D\n", "the refused stash kept its change");
        assert_eq!(listed(&repo), ["B"]);
        ok(&other, &["stash", "push", "-q", "-m", "D"]);
        assert_eq!(listed(&repo), ["D", "B"], "and stashes once the drop is done");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_lock_someone_else_holds_drops_nothing_and_stays() {
        // Review 3's case: refs/stash.lock held. Before, the undo after a wrong drop failed here.
        let (base, repo, other) = fixture("held");
        let a = stash(&repo, "A");
        stash(&other, "B");
        let lock = repo.join(".git").join("refs").join("stash.lock");
        fs::write(&lock, "").unwrap();
        assert!(drop(&repo, &a).unwrap_err().contains("stash.lock"));
        assert!(lock.exists(), "another git's lock was deleted");
        fs::remove_file(&lock).unwrap();
        // A drop that stopped once it had the lock: the list as it was, and its lock gone.
        fs::write(repo.join(".git").join("logs").join("refs").join("stash.lock"), "").unwrap();
        assert!(drop(&repo, &a).unwrap_err().contains("stash.lock"));
        assert!(!lock.exists(), "a refused drop left its own lock");
        assert_eq!(listed(&repo), ["B", "A"]);
        let _ = fs::remove_dir_all(base);
    }
}
