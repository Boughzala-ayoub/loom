//! Identity of what deleting a worktree loses, for destructive approval. Never follow reparse points.
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
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

/// Why a worktree of the repository at `common` holds `branch`, as `git branch -D`
/// would refuse it: checked out there, or rebased or bisected there while its HEAD
/// is detached (Git's worktreepath ref atom misses those). Or why it may be about
/// to: a checkout holds the worktree's index.lock while it writes the files, then
/// HEAD.lock to name the branch, so a worktree with either lock might be checking
/// `branch` out, and Loom can't tell which branch. None: none holds it.
fn held_by(common: &Path, branch: &str) -> Result<Option<String>, String> {
    let mut dirs = vec![common.to_path_buf()];
    match fs::read_dir(common.join("worktrees")) {
        Ok(entries) => for entry in entries { dirs.push(entry.map_err(|e| e.to_string())?.path()); },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(e.to_string()),
    }
    let reference = format!("refs/heads/{branch}");
    let read = |path: &Path| match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    };
    for dir in dirs {
        // A linked worktree's gitdir names its .git file; the main one is the repository's.
        let at = || -> Result<String, String> {
            Ok(read(&dir.join("gitdir"))?.map(|g| g.trim_end_matches(['\r', '\n']).trim_end_matches(".git").trim_end_matches(['/', '\\']).to_owned())
                .unwrap_or_else(|| dir.parent().unwrap_or(&dir).display().to_string()))
        };
        // Only the line ending goes: a branch name may end in a space Unicode has.
        let head = read(&dir.join("HEAD"))?.unwrap_or_default();
        if head.strip_suffix("\r\n").or_else(|| head.strip_suffix('\n')).unwrap_or(&head) == format!("ref: {reference}") {
            return Ok(Some(format!("Cannot delete branch '{branch}': checked out at '{}'.", at()?)));
        }
        for lock in ["index.lock", "HEAD.lock"] {
            if dir.join(lock).try_exists().map_err(|e| e.to_string())? {
                return Ok(Some(format!("Cannot delete branch '{branch}' now: Git is busy in the worktree at '{}' ({lock}) and may be checking it out. Try again once it finishes.", at()?)));
            }
        }
        for marker in ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START", "rebase-merge/update-refs"] {
            let Some(text) = read(&dir.join(marker))? else { continue };
            if text.lines().any(|line| line == reference || (marker == "BISECT_START" && line == branch)) {
                return Ok(Some(format!("Cannot delete branch '{branch}': used by worktree operation at {}.", dir.display())));
            }
        }
    }
    Ok(None)
}

/// Deletes `branch` of `repo` only while its tip is still `tip` and no worktree
/// holds it (held_by). Git takes no lock to check a branch out, so neither this
/// nor `git branch -D` can make the look and the delete one step. This comes
/// closest: one update-ref transaction locks the ref and checks the tip, the
/// worktrees are read with that lock held, and the commit follows at once. A
/// checkout that still lands in between is seen right after, and the same
/// process puts the branch back at `tip`, so that worktree's HEAD names it again.
pub fn delete_branch(repo: &str, branch: &str, tip: &str) -> Result<(), String> {
    delete_branch_with(repo, branch, tip, || {})
}

/// `between` runs after the worktrees were read and before the commit: a test's
/// checkout lands in the gap a real one could.
fn delete_branch_with(repo: &str, branch: &str, tip: &str, between: impl FnOnce()) -> Result<(), String> {
    use std::io::BufRead;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let common = crate::git_run(repo.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    let common = Path::new(repo).join(common.trim());
    let reference = format!("refs/heads/{branch}");
    let mut child = Command::new("git").arg("-C").arg(repo).args(["update-ref", "--no-deref", "--stdin", "-z"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn().map_err(|e| format!("git: {e}"))?;
    let mut input = child.stdin.take().expect("piped");
    let mut output = std::io::BufReader::new(child.stdout.take().expect("piped"));
    // Each verb answers "<verb>: ok"; a refused one ends git, and its stderr says why.
    let mut say = |words: &[&str]| -> Result<(), ()> {
        let verb = words.iter().rev().find(|w| ["start", "prepare", "commit", "abort"].contains(w)).copied();
        input.write_all(words.iter().map(|w| format!("{w}\0")).collect::<String>().as_bytes()).and_then(|_| input.flush()).map_err(drop)?;
        let Some(verb) = verb else { return Ok(()) };
        let mut line = String::new();
        output.read_line(&mut line).map_err(drop)?;
        (line.trim_end() == format!("{verb}: ok")).then_some(()).ok_or(())
    };
    let deleted = (|| {
        say(&["start"]).and_then(|_| say(&[&format!("delete {reference}"), tip, "prepare"])).map_err(|_| None)?;
        if let Some(why) = held_by(&common, branch).map_err(Some)? {
            let _ = say(&["abort"]);
            return Err(Some(why));
        }
        between();
        say(&["commit"]).map_err(|_| None)?;
        match held_by(&common, branch) {
            Ok(None) => Ok(()),
            Ok(Some(why)) => {
                let back = say(&["start"]).and_then(|_| say(&[&format!("create {reference}"), tip, "prepare"])).and_then(|_| say(&["commit"]));
                Err(Some(match back {
                    Ok(()) => format!("{why} That began while Loom deleted it, so Loom put it back at {tip}."),
                    Err(()) => format!("{why} That began while Loom deleted it, and Loom couldn't put it back at {tip}."),
                }))
            }
            Err(e) => Err(Some(e)),
        }
    })();
    drop(say);
    drop(input);
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    match deleted {
        Ok(()) => Ok(()),
        Err(Some(why)) => Err(if stderr.is_empty() { why } else { format!("{why} {stderr}") }),
        Err(None) => Err(if stderr.is_empty() { format!("git update-ref exited {:?}", out.status.code()) } else { stderr }),
    }
}

/// How long a deleted worktree waits in Loom's trash before [`purge`] erases it.
pub const KEEP: Duration = Duration::from_secs(24 * 3600);

/// Where a deleted worktree's folder and git's record of it went. Written into
/// the trash before either moves, so even a crash leaves it: put both back to
/// undo the deletion.
#[derive(serde::Serialize, serde::Deserialize)]
struct Trashed {
    folder: PathBuf, at: PathBuf, entry: PathBuf, entry_at: PathBuf,
    #[serde(default)] pending: bool,
    #[serde(default)] from: Option<PathBuf>,
    #[serde(default)] branch: Option<String>,
    #[serde(default)] commit: Option<String>,
    /// An older Loom's `trash restore` stopped on its way here: the folder may
    /// be there already, git's record still in the trash. Only a hand repair
    /// finishes it (docs/loomctl.md), so nothing here takes or erases it.
    #[serde(default, skip_serializing_if = "Option::is_none")] restoring: Option<PathBuf>,
}

const PENDING: &str = "Loom trash transaction pending\n";

/// git gc can't see Loom's trash: this ref keeps the retained HEAD's commit
/// until purge. A trash id can hold characters a ref can't, so every other
/// byte is spelled %XX.
fn keep_ref(id: &str) -> String {
    id.bytes().fold("refs/loom-trash/".into(), |mut s: String, b| {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' { s.push(b as char) } else { s += &format!("%{b:02X}") }
        s
    })
}

// Deny other readers/writers while this instance resumes or purges the record.
// Delete sharing lets the owner remove or replace it without an unlocked gap.
fn open_record(path: &Path) -> std::io::Result<(fs::File, Trashed)> {
    let mut file = fs::OpenOptions::new().read(true).write(true).share_mode(4).open(path)?;
    let r = serde_json::from_reader(&mut file)?;
    Ok((file, r))
}

/// The new state goes beside the record, then replaces it whole: a crash or a
/// failed write leaves the old state or the new one, never part of either. The
/// new file is held before it replaces the old, and its handle is the lock now.
fn write_record(file: &mut fs::File, path: &Path, r: &Trashed) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let mut next = fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).share_mode(4).open(&tmp)?;
    let written = next.write_all(&serde_json::to_vec_pretty(r)?).and_then(|_| next.sync_all()).and_then(|_| fs::rename(&tmp, path));
    if written.is_err() { let _ = fs::remove_file(&tmp); }
    written.map(|_| *file = next)
}

fn finish_record(file: &mut fs::File, path: &Path, r: &mut Trashed) -> Result<String, String> {
    if r.pending {
        // Loom locks git's record before the folder moves. Once the folder is in
        // the trash, a record without that lock isn't Loom's any more: unlocked by
        // hand, maybe pruned, and its name maybe taken by a new worktree since.
        let mut ours = false;
        if r.entry.try_exists().map_err(|e| e.to_string())? {
            let lock = r.entry.join("locked");
            let moved = r.from.is_some() && r.at.try_exists().map_err(|e| e.to_string())?;
            if !lock.try_exists().map_err(|e| e.to_string())? {
                if !moved {
                    let mut held = fs::OpenOptions::new().write(true).create_new(true).open(&lock).map_err(|e| e.to_string())?;
                    held.write_all(PENDING.as_bytes()).and_then(|_| held.sync_all()).map_err(|e| e.to_string())?;
                    ours = true;
                }
            } else if fs::read_to_string(&lock).map_err(|e| e.to_string())? == PENDING {
                ours = true;
            } else if !moved {
                return Err(format!("{} is a locked worktree", r.folder.display()));
            }
        }
        if let Some(from) = &r.from {
            if !r.at.try_exists().map_err(|e| e.to_string())? {
                fs::rename(from, &r.at).map_err(|e| format!("{}: {e}", from.display()))?;
            }
        }
        // Released as above, or gone while the repository is there: pruned by hand
        // (docs/loomctl.md), so nothing is left to move. A repository on a drive
        // that's offline isn't that.
        let released = !ours && (r.entry.try_exists().map_err(|e| e.to_string())?
            || r.entry.parent().and_then(Path::parent).is_some_and(|common| fs::read_dir(common).is_ok()));
        if !r.entry_at.try_exists().map_err(|e| e.to_string())? {
            if released {
                // An empty stand-in, so purge reads this record like any other: done, not restored.
                fs::create_dir_all(&r.entry_at).map_err(|e| format!("{}: {e}", r.entry_at.display()))?;
            } else {
                fs::create_dir_all(r.entry_at.parent().unwrap()).and_then(|_| fs::rename(&r.entry, &r.entry_at))
                    .map_err(|e| format!("retained {}, but git administration at {} is still pending: {e}", r.at.display(), r.entry.display()))?;
            }
        }
        let lock = r.entry_at.join("locked");
        if fs::read_to_string(&lock).is_ok_and(|s| s == PENDING) { fs::remove_file(lock).map_err(|e| e.to_string())?; }
        r.pending = false;
        write_record(file, path, r).map_err(|e| e.to_string())?;
    }
    Ok(r.at.to_string_lossy().into_owned())
}

fn resume(trash: &Path, worktrees: &Path, dir: &Path, pending_only: bool) -> Result<Option<String>, String> {
    let list = match fs::read_dir(trash) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        r => r.map_err(|e| e.to_string())?,
    };
    let mut completed: Option<(std::time::SystemTime, String)> = None;
    for path in list.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        // A record that can't be read, or is held by another operation, holds
        // up only its own path: trash list shows it, every other path goes on.
        let Ok((mut file, mut r)) = open_record(&path) else { continue };
        if (!pending_only || r.pending) && spelled(&r.folder) == spelled(dir) && r.entry.parent().is_some_and(|p| spelled(p) == spelled(worktrees))
            && (r.pending || !dir.try_exists().map_err(|e| e.to_string())?) {
            if let Some(to) = &r.restoring {
                return Err(format!("{} was being restored to {} by an older Loom; finish or clear that by hand first (loomctl trash)", r.folder.display(), to.display()));
            }
            if r.pending { return finish_record(&mut file, &path, &mut r).map(Some); }
            let stamp = file.metadata().and_then(|m| m.modified()).map_err(|e| e.to_string())?;
            if completed.as_ref().is_none_or(|(last, _)| stamp > *last) {
                completed = Some((stamp, r.at.to_string_lossy().into_owned()));
            }
        }
    }
    // A later worktree at the same path may have independently disappeared.
    // Its still-registered administration needs its own retained transaction.
    if completed.is_some() && missing_entry(worktrees, dir)?.is_some() { return Ok(None); }
    Ok(completed.map(|(_, at)| at))
}

/// A new thread may finish Loom's interrupted deletion at its requested path.
/// It cannot infer approval to remove any other missing worktree's metadata.
pub fn prepare_worktree(repo: &str, dir: &str, trash: &Path) -> Result<(), String> {
    let dir = Path::new(dir);
    if dir.try_exists().map_err(|e| e.to_string())? { return Ok(()); }
    let common = crate::git_run(repo.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    resume(trash, &Path::new(repo).join(common.trim()).join("worktrees"), dir, true)?;
    Ok(())
}

/// Delete `dir`, a linked worktree of `repo`, by moving it into `trash` and
/// git's record of it into the repository's loom-trash. Nothing is erased
/// here; [`purge`] does that a day later. So a file written into it after the
/// checks, or a wrong folder that got through them, is in the trash, not lost.
/// Git for Windows' `worktree remove` recurses through junctions and empties
/// their targets, so git never touches it. The folder itself is taken as it
/// is, never resolved: a link there goes nowhere. Returns where it went, or ""
/// when both the folder and git's record were gone already.
pub fn remove_worktree(repo: &str, dir: &str, trash: &Path) -> Result<String, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    remove_worktree_at(repo, dir, trash, stamp)
}

fn remove_worktree_at(repo: &str, dir: &str, trash: &Path, stamp: u128) -> Result<String, String> {
    let dir = Path::new(dir);
    let common = crate::git_run(repo.into(), vec!["rev-parse".into(), "--git-common-dir".into()], None, false)?;
    let common = Path::new(repo).join(common.trim());
    let worktrees = common.join("worktrees");
    if let Some(at) = resume(trash, &worktrees, dir, false)? { return Ok(at); }
    let name = dir.file_name().ok_or_else(|| format!("{} has no folder name", dir.display()))?.to_string_lossy();
    // An older Loom that stopped mid-deletion left the folder claimed beside its
    // path, with git's record still naming the path: that deletion goes on here.
    let claim = dir.with_file_name(format!(".{name}.loom-deleting"));
    let from = match fs::symlink_metadata(dir) {
        Ok(_) => Some(dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && fs::symlink_metadata(&claim).is_ok() => Some(claim.as_path()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let entry = if let Some(from) = from {
        let meta = fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
        if meta.file_attributes() & 0x400 != 0 || !meta.is_dir() {
            return Err(format!("{} is a link or not a folder; Loom deletes only a worktree's own folder", from.display()));
        }
        let entry = entry_of(from, dir, &worktrees)?;
        // The walk refuses a folder holding another checkout, even with --force.
        fingerprint(from, None, &[])?;
        entry
    } else {
        let Some(entry) = missing_entry(&worktrees, dir)? else { return Ok(String::new()) };
        entry
    };
    let head = fs::read_to_string(entry.join("HEAD")).map_err(|e| e.to_string())?;
    let head = head.strip_suffix("\r\n").or_else(|| head.strip_suffix('\n')).unwrap_or(&head);
    let branch = head.strip_prefix("ref: ").map(str::to_owned);
    // A branch with no commit yet (unborn) answers 1 and nothing: there's no commit to keep.
    let commit = crate::git_run(repo.into(), vec!["rev-parse".into(), "-q".into(), "--verify".into(), branch.as_deref().unwrap_or(head).into()], Some(vec![1]), false)?;
    let commit = Some(commit.trim().to_owned()).filter(|c| !c.is_empty());
    fs::create_dir_all(trash).map_err(|e| e.to_string())?;
    let mut suffix = 0u64;
    let (id, file, mut held) = loop {
        let id = format!("{stamp}-{name}-{suffix}");
        let file = trash.join(format!("{id}.json"));
        match fs::OpenOptions::new().read(true).write(true).create_new(true).share_mode(4).open(&file) {
            Ok(held) => break (id, file, held),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => suffix += 1,
            Err(e) => return Err(e.to_string()),
        }
    };
    let mut record = Trashed { folder: dir.into(), at: trash.join(&id), entry: entry.clone(), entry_at: common.join("loom-trash").join(&id), pending: true, from: from.map(Path::to_path_buf), branch, commit: commit.clone(), restoring: None };
    // Git itself honors this lock, including a blanket prune from another
    // instance, and the ref keeps the commit. Until both hold, nothing has
    // moved: a reservation that can't be written goes again rather than stay
    // half-written.
    let keep = keep_ref(&id);
    let reserved = write_record(&mut held, &file, &record).and_then(|_| {
        let lock = entry.join("locked");
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&lock)?;
        f.write_all(PENDING.as_bytes()).and_then(|_| f.sync_all())
            .and_then(|_| commit.map_or(Ok(()), |commit| crate::git_run(repo.into(), vec!["update-ref".into(), keep.clone(), commit], None, false).map(drop).map_err(std::io::Error::other)))
            .inspect_err(|_| { let _ = fs::remove_file(&lock); })
    });
    if let Err(e) = reserved {
        let _ = fs::remove_file(&file);
        return Err(e.to_string());
    }
    // Windows refuses to move a folder while anything inside is open (a
    // process's cwd, a file being written), so nothing is cut off mid-write.
    let mut moved = from.map_or(Ok(()), |from| fs::rename(from, &record.at));
    if moved.as_ref().is_err_and(|e| e.raw_os_error() == Some(17)) {
        // ERROR_NOT_SAME_DEVICE: on another volume than Loom's trash, it waits beside its own path.
        record.at = dir.with_file_name(format!(".{id}.loom-trash"));
        moved = write_record(&mut held, &file, &record).and_then(|_| fs::rename(from.unwrap(), &record.at));
    }
    if let Err(e) = moved {
        let _ = fs::remove_file(&file);
        let _ = fs::remove_file(entry.join("locked"));
        let _ = crate::git_run(repo.into(), vec!["update-ref".into(), "-d".into(), keep], None, false);
        return Err(format!("couldn't move {} to Loom's trash; is something still using it? {e}", dir.display()));
    }
    finish_record(&mut held, &file, &mut record)
}

fn restored(r: &Trashed) -> std::io::Result<bool> {
    // A replacement worktree can reuse the old administration name. It is a
    // restore only when the retained administration has left the trash.
    if !r.entry_at.try_exists()? && r.entry.try_exists()? {
        fs::read_dir(r.entry_at.parent().unwrap())?;
        return Ok(true);
    }
    // Manual repair may register the trash folder using another entry name, or
    // in the repository at its new path: whatever repository the folder's link
    // names, if that one records the folder back, the folder is a live checkout.
    let dot = match fs::read_to_string(r.at.join(".git")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        r => r?,
    };
    let Some(entry) = dot.trim().strip_prefix("gitdir:") else { return Ok(false) };
    let entry = r.at.join(entry.trim());
    match fs::read_to_string(entry.join("gitdir")) {
        Ok(back) => Ok(spelled(&entry.join(back.trim())) == spelled(&r.at.join(".git"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

pub fn trash_records(trash: &Path) -> Result<serde_json::Value, String> {
    let list = match fs::read_dir(trash) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!([])),
        r => r.map_err(|e| e.to_string())?,
    };
    let mut records = Vec::new();
    for path in list.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let id = path.file_stem().unwrap().to_string_lossy().into_owned();
        records.push(match open_record(&path) {
            Ok((_held, r)) => {
                let mut value = serde_json::to_value(r).map_err(|e| e.to_string())?;
                value["id"] = id.into();
                value
            }
            // Damaged (a write cut short) or held by another operation right now.
            Err(e) => serde_json::json!({ "id": id, "error": e.to_string() }),
        });
    }
    Ok(records.into())
}

/// Erase what went into `trash` more than `keep` ago: the folder each record
/// names, git's record of it, the ref keeping its commit, then the record. One
/// put back by hand isn't where its record says any more, so it stays. A
/// failure waits for the next purge. A deletion whose folder moved but whose
/// git record couldn't follow (something held it) is finished first, whenever
/// that lets go, and then waits out its own `keep`.
pub fn purge(trash: &Path, keep: Duration) {
    let Ok(list) = fs::read_dir(trash) else { return };
    for file in list.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let due = fs::metadata(&file).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= keep));
        let Ok((mut held, mut r)) = open_record(&file) else { continue };
        if r.restoring.is_some() { continue; }
        // The repository is the one that held the administration. Deleted since,
        // with its drive still there: nothing of git's is left to move or erase.
        let common = r.entry.parent().and_then(Path::parent).map(Path::to_path_buf);
        let deleted = common.as_deref().is_some_and(|c| matches!(c.try_exists(), Ok(false)) && c.ancestors().last().is_some_and(|root| fs::read_dir(root).is_ok()));
        if r.pending && !deleted {
            // A folder that never moved (a crash before it) waits for its path's next deletion.
            if r.at.try_exists().unwrap_or(false) { let _ = finish_record(&mut held, &file, &mut r); }
            continue;
        }
        if !due { continue; }
        let unkeep = || deleted || common.as_deref().is_none_or(|common| crate::git_run(common.to_string_lossy().into_owned(),
            vec!["update-ref".into(), "-d".into(), keep_ref(&file.file_stem().unwrap().to_string_lossy())], None, false).is_ok());
        match restored(&r) {
            Ok(true) => { if unkeep() { let _ = fs::remove_file(&file); } continue; }
            Err(_) => continue,
            Ok(false) => {},
        }
        // NotFound can mean an unplugged volume or a temporarily moved parent.
        // Both recorded locations must be reachable before either is expired.
        let reachable = |p: &Path| p.parent().is_some_and(|parent| fs::read_dir(parent).is_ok());
        if !reachable(&r.at) || !(deleted || reachable(&r.entry_at)) { continue; }
        // remove_dir_all removes each link inside as itself, never what it points to.
        let erase = |p: &Path| match fs::remove_dir_all(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && reachable(p) => Ok(()),
            r => r,
        };
        if erase(&r.at).and_then(|_| if deleted { Ok(()) } else { erase(&r.entry_at) }).is_ok() && unkeep() { let _ = fs::remove_file(&file); }
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

/// `dir` is gone already: retain the entry whose gitdir names dir\.git, if any.
fn missing_entry(worktrees: &Path, dir: &Path) -> Result<Option<PathBuf>, String> {
    let want = spelled(&dir.join(".git"));
    let entries = match fs::read_dir(worktrees) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        r => r.map_err(|e| format!("{}: {e}", worktrees.display()))?,
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?.path();
        let Ok(back) = fs::read_to_string(entry.join("gitdir")) else { continue };
        if spelled(&entry.join(back.trim())) != want { continue; }
        if entry.join("locked").exists() { return Err(format!("{} is a locked worktree", dir.display())); }
        return Ok(Some(entry));
    }
    Ok(None)
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
    fn trash_preserves_exact_unicode_branch_and_commit() {
        let dir = std::env::temp_dir().join(format!("loom-trash-identity-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        for (n, branch) in ["approved\u{a0}", "\u{a0}approved", "approved"].iter().enumerate() {
            let (repo, wt, trash) = (dir.join(n.to_string()).join("repo"), dir.join(n.to_string()).join("wt"), dir.join(n.to_string()).join("trash"));
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            fs::write(repo.join("f"), "main").unwrap();
            git(&repo, &["add", "f"]); git(&repo, &["commit", "-qm", "main"]);
            git(&repo, &["worktree", "add", "-q", "-b", branch, wt.to_str().unwrap()]);
            fs::write(wt.join("f"), "A").unwrap(); git(&wt, &["commit", "-qam", "A"]);
            let a = git(&wt, &["rev-parse", "HEAD"]).trim().to_owned();
            let b = git(&repo, &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "B"]).trim().to_owned();
            git(&repo, &[if *branch == "approved" { "tag" } else { "branch" }, "approved", &b]);
            // Git's HEAD file may use CRLF; only the line ending may be removed.
            let entry = repo.join(".git/worktrees/wt");
            fs::write(entry.join("HEAD"), format!("ref: refs/heads/{branch}\r\n")).unwrap();
            let moved = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
            let id = Path::new(&moved).file_name().unwrap().to_str().unwrap();
            let (_, record) = open_record(&trash.join(format!("{id}.json"))).unwrap();
            assert_eq!(record.branch.as_deref(), Some(format!("refs/heads/{branch}").as_str()));
            assert_eq!(record.commit.as_deref(), Some(a.as_str()));
            assert_eq!(git(&repo, &["rev-parse", &keep_ref(id)]).trim(), a);
            git(&repo, &["update-ref", "--no-deref", "-d", &format!("refs/heads/{branch}"), &a]);
            git(&repo, &["gc", "--prune=now", "--quiet"]);
            git(&repo, &["cat-file", "-e", &format!("{a}^{{commit}}")]);
            assert_eq!(git(&repo, &["rev-parse", if *branch == "approved" { "refs/tags/approved" } else { "refs/heads/approved" }]).trim(), b);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn branch_deletion_keeps_rebase_and_bisect_branches_even_while_detached() {
        let dir = std::env::temp_dir().join(format!("loom-branch-operation-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let (repo, wt) = (dir.join("repo"), dir.join("wt"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("f"), "base").unwrap();
        git(&repo, &["add", "f"]); git(&repo, &["commit", "-qm", "base"]);
        let base = git(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["worktree", "add", "-q", "-b", "topic", wt.to_str().unwrap()]);
        fs::write(wt.join("f"), "topic").unwrap(); git(&wt, &["commit", "-qam", "topic"]);
        git(&wt, &["branch", "topic-mid"]);
        git(&wt, &["commit", "-q", "--allow-empty", "-m", "second"]);
        fs::write(repo.join("f"), "main").unwrap(); git(&repo, &["commit", "-qam", "main"]);
        let rebasing = Command::new("git").arg("-C").arg(&wt).args(["rebase", "--update-refs", "main"]).output().unwrap();
        assert!(!rebasing.status.success());
        assert!(git(&repo, &["for-each-ref", "--format=%(worktreepath)", "refs/heads/topic"]).trim().is_empty());
        let tip = |branch: &str| git(&repo, &["rev-parse", &format!("refs/heads/{branch}")]).trim().to_owned();
        for branch in ["topic", "topic-mid"] {
            assert!(delete_branch(repo.to_str().unwrap(), branch, &tip(branch)).unwrap_err().contains("used by worktree"));
            let refused = Command::new("git").arg("-C").arg(&repo).args(["branch", "-D", branch]).output().unwrap();
            assert!(!refused.status.success());
        }
        git(&wt, &["rebase", "--abort"]);
        git(&wt, &["bisect", "start", "topic", base.trim()]);
        assert!(delete_branch(repo.to_str().unwrap(), "topic", &tip("topic")).unwrap_err().contains("used by worktree"));
        git(&wt, &["bisect", "reset"]);
        // Back on topic: checked out, as branch -D says too.
        assert!(delete_branch(repo.to_str().unwrap(), "topic", &tip("topic")).unwrap_err().contains("checked out at"));
        git(&wt, &["switch", "-q", "--detach"]);
        let gone = tip("topic");
        delete_branch(repo.to_str().unwrap(), "topic", &gone).unwrap();
        assert!(!git(&repo, &["for-each-ref", "refs/heads/"]).contains("refs/heads/topic\n"), "topic stayed");
        fs::remove_dir_all(dir).unwrap();
    }

    /// Writes its file when dropped, so a checkout a failed test left paused still finishes.
    struct Release(PathBuf);
    impl Drop for Release {
        fn drop(&mut self) { let _ = fs::write(&self.0, "go"); }
    }

    #[test]
    fn a_checkout_still_writing_files_keeps_the_branch() {
        let dir = std::env::temp_dir().join(format!("loom-branch-slow-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let (repo, other) = (dir.join("repo"), dir.join("other"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join(".gitattributes"), "slow.txt filter=slow\n").unwrap();
        fs::write(repo.join("slow.txt"), "main\n").unwrap();
        git(&repo, &["add", "-A"]); git(&repo, &["commit", "-qm", "main"]);
        git(&repo, &["switch", "-qc", "topic"]);
        fs::write(repo.join("slow.txt"), "topic\n").unwrap();
        git(&repo, &["commit", "-qam", "topic"]);
        let tip = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
        git(&repo, &["switch", "-q", "main"]);
        git(&repo, &["worktree", "add", "-q", "--detach", other.to_str().unwrap(), "main"]);
        git(&repo, &["config", "filter.slow.clean", "cat"]);
        git(&repo, &["config", "filter.slow.required", "true"]);
        let r = repo.to_str().unwrap();
        // `git switch topic` in the other worktree, paused in a smudge filter (as LFS or a big file
        // keeps one) with its files half written and HEAD still detached. Returns once it is.
        let slow_switch = |run: &str| {
            let (started, release) = (dir.join(format!("{run}-started")), dir.join(format!("{run}-release")));
            let unix = |p: &Path| p.to_str().unwrap().replace('\\', "/");
            git(&repo, &["config", "filter.slow.smudge", &format!("sh -c 'touch \"{}\"; while [ ! -f \"{}\" ]; do sleep 0.05; done; cat'", unix(&started), unix(&release))]);
            let child = Command::new("git").arg("-C").arg(&other).args(["switch", "-q", "topic"]).spawn().unwrap();
            let release = Release(release);
            for _ in 0..400 { if started.exists() { break; } std::thread::sleep(Duration::from_millis(50)); }
            assert!(started.exists(), "the checkout never reached its filter");
            assert!(Command::new("git").arg("-C").arg(&other).args(["symbolic-ref", "-q", "HEAD"]).output().unwrap().stdout.is_empty(), "HEAD changed before the files were written");
            (child, release)
        };
        let finished = |(mut child, release): (std::process::Child, Release)| {
            drop(release);
            assert!(child.wait().unwrap().success(), "the checkout failed");
            assert_eq!(git(&other, &["symbolic-ref", "HEAD"]).trim(), "refs/heads/topic");
            assert_eq!(git(&other, &["rev-parse", "--verify", "HEAD"]).trim(), tip, "HEAD names a branch that's gone");
            git(&other, &["switch", "-q", "--detach", "main"]);
        };
        // Already writing files when the delete looks: kept, and the checkout ends on a branch that's there.
        let running = slow_switch("before");
        let error = delete_branch(r, "topic", &tip).unwrap_err();
        assert!(error.contains("busy") && error.contains("index.lock"), "{error}");
        finished(running);
        // It starts between the look and the commit: the look after the commit sees it, and the branch comes back.
        let mut running = None;
        let error = delete_branch_with(r, "topic", &tip, || running = Some(slow_switch("between"))).unwrap_err();
        assert!(error.contains("busy") && error.contains("put it back"), "{error}");
        finished(running.unwrap());
        // Nothing running: deleted.
        delete_branch(r, "topic", &tip).unwrap();
        assert!(!git(&repo, &["for-each-ref", "refs/heads/"]).contains("refs/heads/topic\n"), "topic stayed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_branch_checked_out_while_it_is_deleted_comes_back_at_its_tip() {
        let dir = std::env::temp_dir().join(format!("loom-branch-race-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let (repo, first) = (dir.join("repo"), dir.join("first"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join("base.txt"), "base").unwrap();
        git(&repo, &["add", "-A"]); git(&repo, &["commit", "-qm", "base"]);
        // The thread's worktree, its own commit on topic, then the worktree gone as Loom's close leaves it.
        git(&repo, &["worktree", "add", "-q", "-b", "topic", first.to_str().unwrap()]);
        fs::write(first.join("only.txt"), "topic only").unwrap();
        git(&first, &["add", "-A"]); git(&first, &["commit", "-qm", "topic-only"]);
        let approved = git(&first, &["rev-parse", "HEAD"]).trim().to_owned();
        git(&repo, &["worktree", "remove", "--force", first.to_str().unwrap()]);
        let (r, at) = (repo.to_str().unwrap(), |name: &str| dir.join(name).to_str().unwrap().to_owned());
        let tip = || Command::new("git").arg("-C").arg(&repo).args(["rev-parse", "-q", "--verify", "refs/heads/topic"]).output().unwrap();
        // Checked out elsewhere before the delete: refused, as branch -D refuses.
        git(&repo, &["worktree", "add", "-q", &at("early"), "topic"]);
        assert!(delete_branch(r, "topic", &approved).unwrap_err().contains("checked out at"));
        git(&repo, &["worktree", "remove", &at("early")]);
        // A tip other than the approved one: refused, the new tip kept.
        git(&repo, &["branch", "-f", "topic", "main"]);
        assert!(delete_branch(r, "topic", &approved).is_err());
        assert_ne!(String::from_utf8_lossy(&tip().stdout).trim(), approved);
        git(&repo, &["branch", "-f", "topic", &approved]);
        // Another agent switches a worktree to the unchanged branch after the worktrees were read.
        // switch takes no lock, so it lands: the branch comes back at its tip, that worktree's HEAD
        // resolves, and the delete reports it didn't happen.
        let late = at("late");
        git(&repo, &["worktree", "add", "-q", "--detach", &late, "main"]);
        let error = delete_branch_with(r, "topic", &approved, || { git(Path::new(&late), &["switch", "-q", "topic"]); }).unwrap_err();
        assert!(error.contains("checked out at") && error.contains("put it back"), "{error}");
        assert_eq!(String::from_utf8_lossy(&tip().stdout).trim(), approved);
        assert_eq!(git(Path::new(&late), &["symbolic-ref", "HEAD"]).trim(), "refs/heads/topic");
        assert_eq!(git(Path::new(&late), &["rev-parse", "--verify", "HEAD"]).trim(), approved);
        // A new worktree on it in the same gap: worktree add locks the branch to write its HEAD, which the
        // transaction holds, so Git refuses it, and the branch goes at its approved tip.
        git(Path::new(&late), &["switch", "-q", "--detach"]);
        let added = std::cell::Cell::new(None);
        delete_branch_with(r, "topic", &approved, || added.set(Some(Command::new("git").arg("-C").arg(&repo).args(["worktree", "add", "-q", &at("added"), "topic"]).output().unwrap()))).unwrap();
        let added = added.take().unwrap();
        assert!(!added.status.success() && String::from_utf8_lossy(&added.stderr).contains("topic.lock"), "{}", String::from_utf8_lossy(&added.stderr));
        assert!(!tip().status.success(), "topic stayed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_administration_survives_retry_and_prune() {
        let dir = std::env::temp_dir().join(format!("loom-pending-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        // A reused path also has an older completed transaction. It must not
        // mask the second deletion's unfinished administration move on retry.
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "t"]);
        fs::write(wt.join("a.txt"), "staged").unwrap();
        git(&wt, &["add", "a.txt"]);
        fs::write(wt.join("a.txt"), "working").unwrap();
        let entry = repo.join(".git/worktrees/wt");
        let index = fs::read(entry.join("index")).unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(entry.join("index")).unwrap();
        let remove = || remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash);
        assert!(remove().is_err());
        assert!(!wt.exists(), "the first move must succeed");
        assert!(remove().is_err(), "the held administration must remain pending");
        assert!(entry.join("HEAD").is_file(), "retry recursively erased administrative neighbors");
        git(&repo, &["worktree", "prune"]);
        assert_eq!(fs::read(entry.join("index")).unwrap(), index);
        assert!(entry.join("HEAD").is_file());
        purge(&trash, Duration::ZERO);
        assert!(entry.join("HEAD").is_file(), "purge discarded pending administration");
        drop(held);
        let at = PathBuf::from(remove().unwrap());
        let records: Vec<_> = fs::read_dir(&trash).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).collect();
        assert_eq!(records.len(), 1);
        let r: Trashed = serde_json::from_slice(&fs::read(records[0].path()).unwrap()).unwrap();
        assert_eq!(fs::read(r.entry_at.join("index")).unwrap(), index);
        assert!(r.entry_at.join("HEAD").is_file() && !entry.exists());
        assert_eq!(fs::read_to_string(at.join("a.txt")).unwrap(), "working");
        assert_eq!(remove().unwrap(), at.to_string_lossy());
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "t"]);
        fs::rename(&wt, dir.join("temporarily-moved")).unwrap();
        let missing = remove().unwrap();
        assert!(!entry.exists() && Path::new(&missing) != at, "an older completed record hid a later missing worktree's administration");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_held_git_record_finishes_on_a_later_purge_or_after_a_hand_prune() {
        let dir = std::env::temp_dir().join(format!("loom-pending-finish-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, trash) = (dir.join("repo"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        let records = || fs::read_dir(&trash).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect::<Vec<_>>();
        // Purge finishes it once the holder (a git process, TGitCache) lets go, and erases it a day after that.
        let wt = dir.join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        let entry = repo.join(".git/worktrees/wt");
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(entry.join("index")).unwrap();
        let error = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap_err();
        assert!(error.starts_with("retained "), "main.ts reads this prefix as pending: {error}");
        purge(&trash, KEEP);
        assert!(entry.join("HEAD").is_file(), "a held record can't move yet");
        drop(held);
        purge(&trash, KEEP);
        let [record] = &records()[..] else { panic!("one record") };
        let r: Trashed = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
        assert!(!r.pending && !entry.exists() && r.entry_at.join("HEAD").is_file() && r.at.is_dir(), "purge left it pending");
        purge(&trash, Duration::ZERO);
        assert!(records().is_empty() && !r.at.exists() && !r.entry_at.exists());
        assert_eq!(git(&repo, &["for-each-ref", "refs/loom-trash"]), "");
        // Unlocked and pruned by hand: nothing is left to move, and the record completes.
        git(&repo, &["worktree", "add", "-q", "-b", "t2", wt.to_str().unwrap()]);
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(entry.join("index")).unwrap();
        assert!(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).is_err());
        drop(held);
        fs::remove_file(entry.join("locked")).unwrap();
        git(&repo, &["worktree", "prune"]);
        assert!(!entry.exists());
        let at = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).expect("a record pruned by hand stayed pending");
        let [record] = &records()[..] else { panic!("one record") };
        assert!(!open_record(record).unwrap().1.pending && Path::new(&at).is_dir());
        purge(&trash, Duration::ZERO);
        assert!(records().is_empty() && !Path::new(&at).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn purge_leaves_a_new_worktree_that_took_a_hand_pruned_records_name() {
        let dir = std::env::temp_dir().join(format!("loom-pending-reused-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        // The repository's first deletion, so there's no loom-trash folder yet.
        let entry = repo.join(".git/worktrees/wt");
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(entry.join("index")).unwrap();
        assert!(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).is_err());
        drop(held);
        fs::remove_file(entry.join("locked")).unwrap();
        git(&repo, &["worktree", "prune"]);
        let other = dir.join("other").join("wt");
        git(&repo, &["worktree", "add", "-q", "-b", "t2", other.to_str().unwrap()]);
        assert!(entry.join("HEAD").is_file(), "git reuses the name");
        purge(&trash, KEEP);
        assert!(entry.join("HEAD").is_file() && !entry.join("locked").exists(), "purge took the new worktree's record");
        assert_eq!(git(&other, &["branch", "--show-current"]).trim(), "t2");
        purge(&trash, Duration::ZERO);
        assert!(fs::read_dir(&trash).unwrap().next().is_none(), "the trashed folder or its record stayed");
        assert!(entry.join("HEAD").is_file() && other.is_dir());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unborn_branch_and_a_deleted_repository_dont_hold_up_deletion() {
        let dir = std::env::temp_dir().join(format!("loom-unborn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        // A branch with no commit yet: nothing for a ref to keep.
        git(&wt, &["checkout", "-q", "--orphan", "fresh"]);
        fs::write(wt.join("a.txt"), "work").unwrap();
        let at = remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).expect("an unborn branch refused deletion");
        assert!(Path::new(&at).join("a.txt").is_file() && !wt.exists());
        let file = fs::read_dir(&trash).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "json")).unwrap();
        let r: Trashed = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!((r.branch.as_deref(), r.commit.as_deref()), (Some("refs/heads/fresh"), None));
        assert_eq!(git(&repo, &["for-each-ref", "refs/loom-trash"]), "");
        // The repository deleted since, on a drive that's still there: the trash goes anyway.
        fs::remove_dir_all(&repo).unwrap();
        purge(&trash, Duration::ZERO);
        assert!(!file.exists() && !Path::new(&at).exists(), "a deleted repository kept its trash for good");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preparing_a_path_finishes_only_its_pending_transaction() {
        let dir = std::env::temp_dir().join(format!("loom-prepare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "staged").unwrap();
        git(&wt, &["add", "a"]);
        let entry = repo.join(".git/worktrees/wt");
        let index = fs::read(entry.join("index")).unwrap();
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(entry.join("index")).unwrap();
        assert!(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).is_err());
        drop(held);
        prepare_worktree(repo.to_str().unwrap(), dir.join("unrelated").to_str().unwrap(), &trash).unwrap();
        assert!(entry.join("index").exists());
        prepare_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        assert!(!entry.exists());
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        let r: Trashed = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(fs::read(r.entry_at.join("index")).unwrap(), index);
        git(&repo, &["worktree", "add", "-q", "-b", "replacement", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn purge_keeps_a_checkout_repaired_at_its_trash_path() {
        let dir = std::env::temp_dir().join(format!("loom-repaired-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "staged").unwrap();
        git(&wt, &["add", "a"]);
        let at = PathBuf::from(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap());
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        let r: Trashed = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        fs::rename(&r.entry_at, &r.entry).unwrap();
        git(&repo, &["worktree", "repair", at.to_str().unwrap()]);
        fs::write(at.join("a"), "recovered working data").unwrap();
        purge(&trash, Duration::ZERO);
        assert_eq!(fs::read_to_string(at.join("a")).unwrap(), "recovered working data", "purge erased a repaired live checkout");
        assert_eq!(git(&at, &["show", ":a"]), "staged");
        assert!(!file.exists(), "a checkout put back by hand must cancel expiry");
        assert_eq!(git(&repo, &["for-each-ref", "refs/loom-trash"]), "", "a cancelled record left its ref");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn purge_keeps_a_checkout_repaired_after_its_repository_moved() {
        let dir = std::env::temp_dir().join(format!("loom-repaired-moved-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, moved, wt, trash) = (dir.join("repo"), dir.join("moved"), dir.join("topic"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "topic", wt.to_str().unwrap()]);
        let at = PathBuf::from(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap());
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        let r: Trashed = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        // The repository moves, then its retained record goes back by hand and git repairs the checkout.
        fs::rename(&repo, &moved).unwrap();
        let (git_dir, entry) = (moved.join(".git"), r.entry.file_name().unwrap());
        fs::rename(git_dir.join("loom-trash").join(r.entry_at.file_name().unwrap()), git_dir.join("worktrees").join(entry)).unwrap();
        git(&moved, &["worktree", "repair", at.to_str().unwrap()]);
        fs::write(at.join("unsaved.txt"), "live work").unwrap();
        assert_eq!(git(&at, &["branch", "--show-current"]).trim(), "topic");
        assert_eq!(git(&at, &["status", "--porcelain"]).trim(), "?? unsaved.txt");
        assert!(git(&moved, &["worktree", "list"]).to_lowercase().contains(&at.to_string_lossy().replace('\\', "/").to_lowercase()));
        purge(&trash, Duration::ZERO);
        assert!(at.join("unsaved.txt").exists(), "purge erased a live checkout because its saved repository path is gone");
        assert_eq!(git(&at, &["branch", "--show-current"]).trim(), "topic");
        assert_eq!(git(&at, &["status", "--porcelain"]).trim(), "?? unsaved.txt");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_older_restore_stopped_halfway_is_never_purged() {
        let dir = std::env::temp_dir().join(format!("loom-half-restored-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "staged").unwrap();
        git(&wt, &["add", "a"]);
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        // The removed `loomctl trash restore` moved the folder out, then git's
        // record couldn't follow: the index is only in the trash now.
        let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        let dest = dir.join("restored");
        fs::rename(saved["at"].as_str().unwrap(), &dest).unwrap();
        saved["restoring"] = dest.to_str().unwrap().into();
        fs::write(&file, serde_json::to_vec(&saved).unwrap()).unwrap();
        let index = Path::new(saved["entry_at"].as_str().unwrap()).join("index");
        purge(&trash, Duration::ZERO);
        assert!(index.is_file() && file.exists(), "purge erased a half-restored checkout's index");
        assert_eq!(trash_records(&trash).unwrap()[0]["restoring"], dest.to_str().unwrap(), "trash list hides where the restore went");
        assert!(remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).is_err(), "deleting its path again took the half restore as done");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_or_busy_record_holds_up_only_itself() {
        let dir = std::env::temp_dir().join(format!("loom-damaged-record-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, other, trash) = (dir.join("repo"), dir.join("other"), dir.join("trash"));
        for r in [&repo, &other] {
            fs::create_dir_all(r).unwrap();
            git(r, &["init", "-q"]);
            git(r, &["commit", "-q", "--allow-empty", "-m", "start"]);
        }
        // Another repository's deletion, its record held by an operation still running.
        git(&other, &["worktree", "add", "-q", "-b", "t", dir.join("other-wt").to_str().unwrap()]);
        remove_worktree(other.to_str().unwrap(), dir.join("other-wt").to_str().unwrap(), &trash).unwrap();
        let busy = fs::read_dir(&trash).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "json")).unwrap();
        let held = open_record(&busy).unwrap();
        // A reservation whose first write never happened: a crash, or a full disk.
        fs::write(trash.join("1-lost-0.json"), "").unwrap();
        prepare_worktree(repo.to_str().unwrap(), dir.join("new").to_str().unwrap(), &trash).expect("a damaged or busy record stopped thread creation");
        git(&repo, &["worktree", "add", "-q", "-b", "t", dir.join("wt").to_str().unwrap()]);
        let at = remove_worktree(repo.to_str().unwrap(), dir.join("wt").to_str().unwrap(), &trash).expect("a damaged or busy record stopped deletion");
        let list = trash_records(&trash).expect("one damaged record hid the whole trash");
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|r| r["at"] == at.as_str()));
        assert!(list.iter().any(|r| r["id"] == "1-lost-0" && r["error"].is_string()), "the damaged record isn't reported");
        assert!(list.iter().any(|r| r["id"] == busy.file_stem().unwrap().to_str().unwrap() && r["error"].is_string()));
        drop(held);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_is_replaced_whole_and_stays_locked() {
        let dir = std::env::temp_dir().join(format!("loom-record-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        // The first write fails (here its temporary name is taken by a folder):
        // nothing moves, and neither the reservation nor git's lock stays.
        fs::create_dir_all(trash.join("7-wt-0.json.tmp")).unwrap();
        assert!(remove_worktree_at(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash, 7).is_err());
        assert!(!trash.join("7-wt-0.json").exists() && !repo.join(".git/worktrees/wt/locked").exists() && wt.join(".git").is_file());
        fs::remove_dir(trash.join("7-wt-0.json.tmp")).unwrap();
        remove_worktree_at(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash, 7).unwrap();
        let file = trash.join("7-wt-0.json");
        let (mut held, mut r) = open_record(&file).unwrap();
        r.branch = Some("refs/heads/changed".into());
        write_record(&mut held, &file, &r).unwrap();
        assert!(open_record(&file).is_err(), "an update released the record lock");
        drop(held);
        assert_eq!(open_record(&file).unwrap().1.branch.as_deref(), Some("refs/heads/changed"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_gc_keeps_the_retained_commit_until_purge() {
        let dir = std::env::temp_dir().join(format!("loom-trash-gc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "branch only").unwrap();
        git(&wt, &["add", "a"]);
        git(&wt, &["commit", "-qm", "branch only"]);
        let commit = git(&wt, &["rev-parse", "HEAD"]).trim().to_owned();
        // An old checkout's objects: weeks past git's two-week grace for unreachable ones.
        let old = std::time::SystemTime::now() - Duration::from_secs(31 * 24 * 3600);
        for objects in fs::read_dir(repo.join(".git/objects")).unwrap().flatten().filter(|d| d.file_name().len() == 2) {
            for object in fs::read_dir(objects.path()).unwrap().flatten() {
                fs::OpenOptions::new().access_mode(0x100).open(object.path()).unwrap().set_modified(old).unwrap(); // FILE_WRITE_ATTRIBUTES: they're read-only
            }
        }
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        git(&repo, &["branch", "-D", "t"]);
        git(&repo, &["gc", "--quiet"]);
        let exists = || Command::new("git").arg("-C").arg(&repo).args(["cat-file", "-e", &commit]).status().unwrap().success();
        assert!(exists(), "git gc collected the deleted worktree's commit before purge");
        purge(&trash, Duration::ZERO);
        assert_eq!(git(&repo, &["for-each-ref", "refs/loom-trash"]), "", "purge left the ref keeping the commit");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn same_millisecond_deletions_never_replace_another_record() {
        let dir = std::env::temp_dir().join(format!("loom-trash-collision-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let trash = dir.join("trash");
        let mut retained = Vec::new();
        for n in 0..3 {
            let repo = dir.join(n.to_string()).join("repo");
            let wt = dir.join(n.to_string()).join("login");
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q"]);
            git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
            git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
            fs::write(wt.join("a"), format!("work {n}")).unwrap();
            // Same central trash, same basename and clock tick. The last move
            // fails independently, and must remove only its own reservation.
            let held = (n == 2).then(|| fs::OpenOptions::new().read(true).share_mode(1).open(wt.join("a")).unwrap());
            let moved = remove_worktree_at(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash, 12345);
            if n == 2 { assert!(moved.is_err()); }
            else { retained.push(PathBuf::from(moved.expect("a collision must reserve another id"))); }
            drop(held);
            let records = trash_records(&trash).unwrap();
            assert_eq!(records.as_array().unwrap().len(), retained.len(), "a colliding deletion overwrote or removed another record");
        }
        assert_ne!(retained[0], retained[1]);
        for (n, at) in retained.iter().enumerate() { assert_eq!(fs::read_to_string(at.join("a")).unwrap(), format!("work {n}")); }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn purge_retains_an_unavailable_external_parent_until_it_returns() {
        let dir = std::env::temp_dir().join(format!("loom-offline-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "retained").unwrap();
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        let (mut held, mut r) = open_record(&file).unwrap();
        // The same layout as the cross-volume sibling fallback, without a
        // second drive: moving its parent makes that whole location unavailable.
        let external = dir.join("external");
        fs::create_dir(&external).unwrap();
        let sibling = external.join(".wt.loom-trash");
        fs::rename(&r.at, &sibling).unwrap();
        r.at = sibling;
        write_record(&mut held, &file, &r).unwrap();
        drop(held);
        fs::rename(&external, dir.join("offline")).unwrap();
        purge(&trash, Duration::ZERO);
        assert!(file.exists() && r.entry_at.exists(), "an offline location must keep its manifest and administration");
        fs::rename(dir.join("offline"), &external).unwrap();
        assert!(r.at.join("a").is_file());
        purge(&trash, Duration::ZERO);
        assert!(!file.exists() && !r.at.exists() && !r.entry_at.exists());
        // The administrative trash parent can be unavailable too. Reusing
        // its former entry name does not prove the old administration restored.
        git(&repo, &["worktree", "add", "-q", "-b", "again", wt.to_str().unwrap()]);
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        let file = fs::read_dir(&trash).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "json")).unwrap().path();
        let r: Trashed = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        git(&repo, &["worktree", "add", "-q", "-b", "replacement", wt.to_str().unwrap()]);
        let admin_parent = r.entry_at.parent().unwrap();
        fs::rename(admin_parent, dir.join("offline-admin")).unwrap();
        purge(&trash, Duration::ZERO);
        assert!(file.exists() && r.at.exists(), "an unavailable administration parent was mistaken for a restore");
        fs::rename(dir.join("offline-admin"), admin_parent).unwrap();
        purge(&trash, Duration::ZERO);
        assert!(!file.exists() && !r.at.exists());
        assert_eq!(git(&wt, &["branch", "--show-current"]).trim(), "replacement");
        fs::remove_dir_all(dir).unwrap();
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
        // Already gone: git's record is retained in trash too.
        fs::remove_dir(&wt).unwrap();
        assert!(!remove_worktree(repo_s, wt.to_str().unwrap(), &trash).unwrap().is_empty());
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
