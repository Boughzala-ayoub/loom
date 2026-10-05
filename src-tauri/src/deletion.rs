//! Identity of what deleting a worktree loses, for destructive approval. Never follow reparse points.
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Seek, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
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
struct Trashed {
    folder: PathBuf, at: PathBuf, entry: PathBuf, entry_at: PathBuf,
    #[serde(default)] pending: bool,
    #[serde(default)] from: Option<PathBuf>,
    #[serde(default)] branch: Option<String>,
    #[serde(default)] commit: Option<String>,
    #[serde(default)] restoring: Option<PathBuf>,
}

const PENDING: &str = "Loom trash transaction pending\n";

// Deny other readers/writers while this instance resumes or purges the record.
// Delete sharing lets the owner remove it without an unlocked read/delete gap.
fn open_record(path: &Path) -> std::io::Result<(fs::File, Trashed)> {
    let mut file = fs::OpenOptions::new().read(true).write(true).share_mode(4).open(path)?;
    let r = serde_json::from_reader(&mut file)?;
    Ok((file, r))
}

fn write_record(file: &mut fs::File, r: &Trashed) -> std::io::Result<()> {
    file.rewind()?;
    file.write_all(&serde_json::to_vec_pretty(r)?)?;
    let len = file.stream_position()?;
    file.set_len(len)?;
    file.sync_all()
}

fn finish_record(file: &mut fs::File, r: &mut Trashed) -> Result<String, String> {
    if r.pending {
        if r.entry.try_exists().map_err(|e| e.to_string())? {
            let lock = r.entry.join("locked");
            if !lock.try_exists().map_err(|e| e.to_string())? {
                let mut held = fs::OpenOptions::new().write(true).create_new(true).open(&lock).map_err(|e| e.to_string())?;
                held.write_all(PENDING.as_bytes()).and_then(|_| held.sync_all()).map_err(|e| e.to_string())?;
            } else if fs::read_to_string(&lock).map_err(|e| e.to_string())? != PENDING {
                return Err(format!("{} is a locked worktree", r.folder.display()));
            }
        }
        if let Some(from) = &r.from {
            if !r.at.try_exists().map_err(|e| e.to_string())? {
                fs::rename(from, &r.at).map_err(|e| format!("{}: {e}", from.display()))?;
            }
        }
        if !r.entry_at.try_exists().map_err(|e| e.to_string())? {
            fs::create_dir_all(r.entry_at.parent().unwrap()).and_then(|_| fs::rename(&r.entry, &r.entry_at))
                .map_err(|e| format!("retained {}, but git administration at {} is still pending: {e}", r.at.display(), r.entry.display()))?;
        }
        let lock = r.entry_at.join("locked");
        if fs::read_to_string(&lock).is_ok_and(|s| s == PENDING) { fs::remove_file(lock).map_err(|e| e.to_string())?; }
        r.pending = false;
        write_record(file, r).map_err(|e| e.to_string())?;
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
        let (mut file, mut r) = open_record(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if (!pending_only || r.pending) && spelled(&r.folder) == spelled(dir) && r.entry.parent().is_some_and(|p| spelled(p) == spelled(worktrees))
            && (r.pending || !dir.try_exists().map_err(|e| e.to_string())?) {
            if r.restoring.is_some() { return Err("This trash record is being restored; finish its restore first".into()); }
            if r.pending { return finish_record(&mut file, &mut r).map(Some); }
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
    let branch = head.trim().strip_prefix("ref: ").map(str::to_owned);
    let commit = crate::git_run(repo.into(), vec!["rev-parse".into(), "--verify".into(), branch.as_deref().unwrap_or(head.trim()).into()], None, false)?.trim().to_owned();
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
    let mut record = Trashed { folder: dir.into(), at: trash.join(&id), entry: entry.clone(), entry_at: common.join("loom-trash").join(&id), pending: true, from: from.map(Path::to_path_buf), branch, commit: Some(commit), restoring: None };
    write_record(&mut held, &record).map_err(|e| e.to_string())?;
    // Git itself honors this lock, including a blanket prune from another instance.
    let mut lock = fs::OpenOptions::new().write(true).create_new(true).open(entry.join("locked")).map_err(|e| {
        let _ = fs::remove_file(&file);
        e.to_string()
    })?;
    lock.write_all(PENDING.as_bytes()).and_then(|_| lock.sync_all()).map_err(|e| e.to_string())?;
    drop(lock);
    // Windows refuses to move a folder while anything inside is open (a
    // process's cwd, a file being written), so nothing is cut off mid-write.
    let mut moved = from.map_or(Ok(()), |from| fs::rename(from, &record.at));
    if moved.as_ref().is_err_and(|e| e.raw_os_error() == Some(17)) {
        // ERROR_NOT_SAME_DEVICE: on another volume than Loom's trash, it waits beside its own path.
        record.at = dir.with_file_name(format!(".{id}.loom-trash"));
        moved = write_record(&mut held, &record).and_then(|_| fs::rename(from.unwrap(), &record.at));
    }
    if let Err(e) = moved {
        let _ = fs::remove_file(&file);
        let _ = fs::remove_file(entry.join("locked"));
        return Err(format!("couldn't move {} to Loom's trash; is something still using it? {e}", dir.display()));
    }
    finish_record(&mut held, &mut record)
}

fn restored(r: &Trashed) -> std::io::Result<bool> {
    // A replacement worktree can reuse the old administration name. It is a
    // restore only when the retained administration has left the trash.
    if !r.entry_at.try_exists()? && r.entry.try_exists()? {
        fs::read_dir(r.entry_at.parent().unwrap())?;
        return Ok(true);
    }
    // Manual repair may register the trash folder using another entry name.
    let dot = match fs::read_to_string(r.at.join(".git")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        r => r?,
    };
    let Some(entry) = dot.trim().strip_prefix("gitdir:") else { return Ok(false) };
    let entry = r.at.join(entry.trim());
    if entry.parent().map(spelled) != r.entry.parent().map(spelled) { return Ok(false); }
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
        let (_held, r) = open_record(&path).map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(r).map_err(|e| e.to_string())?;
        value["id"] = path.file_stem().unwrap().to_string_lossy().into_owned().into();
        records.push(value);
    }
    Ok(records.into())
}

/// Restore and cancel expiry under the same record lock used by purge. Keep
/// an interrupted restore recorded and excluded from purge until it is retried.
pub fn restore(trash: &Path, id: &str, destination: Option<&Path>) -> Result<String, String> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || id == "." || id == ".." { return Err("Invalid trash id".into()); }
    let path = trash.join(format!("{id}.json"));
    let (mut held, mut r) = open_record(&path).map_err(|e| e.to_string())?;
    if r.pending { finish_record(&mut held, &mut r)?; }
    let dest = destination.map(Path::to_path_buf).or_else(|| r.restoring.clone()).unwrap_or_else(|| r.folder.clone());
    if !dest.is_absolute() { return Err("Restore destination must be an absolute path".into()); }
    let exists = |p: &Path| p.try_exists().map_err(|e| e.to_string());
    if let Some(prior) = &r.restoring {
        if spelled(prior) != spelled(&dest) { return Err(format!("Resume this restore at {}", prior.display())); }
    } else {
        if spelled(&dest) != spelled(&r.at) && exists(&dest)? { return Err(format!("{} already exists; choose another destination", dest.display())); }
        if !exists(&r.at)? || !exists(&r.entry_at)? { return Err("The retained checkout or administration is unavailable".into()); }
        let original_entry = r.entry.clone();
        let name = original_entry.file_name().ok_or("No administration name")?.to_string_lossy();
        for suffix in 1.. {
            if !exists(&r.entry)? { break; }
            r.entry = original_entry.with_file_name(format!("{name}-restored-{suffix}"));
        }
        r.restoring = Some(dest.clone());
        write_record(&mut held, &r).map_err(|e| e.to_string())?;
    }
    let common = r.entry.parent().and_then(Path::parent).ok_or("Invalid administration path")?.to_string_lossy().into_owned();
    if let (Some(branch), Some(commit)) = (&r.branch, &r.commit) {
        let current = crate::git_run(common.clone(), vec!["rev-parse".into(), "--verify".into(), "--quiet".into(), branch.clone()], Some(vec![1]), false)?;
        if !current.trim().is_empty() && current.trim() != commit { return Err(format!("{branch} now points elsewhere; it was not overwritten")); }
        if current.trim().is_empty() {
            // The zero old value refuses a branch created by someone else meanwhile.
            crate::git_run(common.clone(), vec!["update-ref".into(), branch.clone(), commit.clone(), "0".repeat(commit.len())], None, false)?;
        }
    }
    if spelled(&dest) != spelled(&r.at) && exists(&r.at)? {
        if exists(&dest)? { return Err(format!("{} already exists", dest.display())); }
        fs::create_dir_all(dest.parent().ok_or("No destination parent")?).map_err(|e| e.to_string())?;
        fs::rename(&r.at, &dest).map_err(|e| e.to_string())?;
    }
    if exists(&r.entry_at)? {
        if exists(&r.entry)? { return Err(format!("{} already exists", r.entry.display())); }
        fs::create_dir_all(r.entry.parent().unwrap()).and_then(|_| fs::rename(&r.entry_at, &r.entry)).map_err(|e| e.to_string())?;
    }
    // Repair both links explicitly, including old records with relative paths.
    fs::write(dest.join(".git"), format!("gitdir: {}\n", r.entry.display())).map_err(|e| e.to_string())?;
    crate::git_run(common, vec!["worktree".into(), "repair".into(), dest.to_string_lossy().into_owned()], None, false)?;
    fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Erase what went into `trash` more than `keep` ago: the folder each record
/// names, git's record of it, then the record. One put back by hand isn't
/// where its record says any more, so it stays. A failure waits for the next
/// purge.
pub fn purge(trash: &Path, keep: Duration) {
    let Ok(list) = fs::read_dir(trash) else { return };
    for file in list.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let due = fs::metadata(&file).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age >= keep));
        if !due { continue; }
        let Ok((_held, r)) = open_record(&file) else { continue };
        if r.pending || r.restoring.is_some() { continue; }
        match restored(&r) {
            Ok(true) => { let _ = fs::remove_file(&file); continue; }
            Err(_) => continue,
            Ok(false) => {},
        }
        // NotFound can mean an unplugged volume or a temporarily moved parent.
        // Both recorded locations must be reachable before either is expired.
        let reachable = |p: &Path| p.parent().is_some_and(|parent| fs::read_dir(parent).is_ok());
        if !reachable(&r.at) || !reachable(&r.entry_at) { continue; }
        // remove_dir_all removes each link inside as itself, never what it points to.
        let erase = |p: &Path| match fs::remove_dir_all(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && reachable(p) => Ok(()),
            r => r,
        };
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
        assert!(!file.exists(), "restore must cancel expiry");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restore_to_another_path_recovers_the_deleted_branch_and_index() {
        let dir = std::env::temp_dir().join(format!("loom-restore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (repo, wt, trash) = (dir.join("repo"), dir.join("wt"), dir.join("trash"));
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
        git(&repo, &["worktree", "add", "-q", "-b", "t", wt.to_str().unwrap()]);
        fs::write(wt.join("a"), "committed").unwrap();
        git(&wt, &["add", "a"]);
        git(&wt, &["commit", "-qm", "branch only"]);
        let commit = git(&wt, &["rev-parse", "HEAD"]);
        fs::write(wt.join("a"), "staged").unwrap();
        git(&wt, &["add", "a"]);
        fs::write(wt.join("a"), "working").unwrap();
        remove_worktree(repo.to_str().unwrap(), wt.to_str().unwrap(), &trash).unwrap();
        git(&repo, &["branch", "-D", "t"]);
        let list = trash_records(&trash).unwrap();
        let id = list[0]["id"].as_str().unwrap();
        assert_eq!(list[0]["branch"], "refs/heads/t");
        assert_eq!(list[0]["commit"], commit.trim());
        git(&repo, &["worktree", "add", "-q", "-b", "replacement", wt.to_str().unwrap()]);
        fs::write(wt.join("replacement"), "keep").unwrap();
        assert!(restore(&trash, id, None).is_err(), "restore must refuse an occupied destination");
        let dest = dir.join("recovered");
        let file = trash.join(format!("{id}.json"));
        // Restore/purge share the record lock, even across different instances.
        let held = open_record(&file).unwrap();
        purge(&trash, Duration::ZERO);
        assert!(file.exists());
        drop(held);
        restore(&trash, id, Some(&dest)).unwrap();
        assert!(!file.exists(), "expiry must be cancelled before normal use");
        assert_eq!(git(&dest, &["rev-parse", "HEAD"]), commit);
        assert_eq!(git(&dest, &["show", ":a"]), "staged");
        assert_eq!(fs::read_to_string(dest.join("a")).unwrap(), "working");
        assert_eq!(fs::read_to_string(wt.join("replacement")).unwrap(), "keep");
        assert_eq!(git(&wt, &["branch", "--show-current"]).trim(), "replacement");
        purge(&trash, Duration::ZERO);
        assert!(dest.join("a").is_file());
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
        write_record(&mut held, &r).unwrap();
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
