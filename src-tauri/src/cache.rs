//! Only expire caches created under this ownership protocol. Unknown caches
//! may belong to older running Loom versions and must be left alone.
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::time::Duration;

fn lock_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)
}

pub fn acquire(root: &Path, sid: &str, profile: &Path) -> std::io::Result<File> {
    fs::create_dir_all(root)?;
    let guard = lock_file(&root.join(".lock"))?;
    guard.lock()?;
    let path = root.join(sid);
    let existed = path.exists();
    fs::create_dir_all(&path)?;
    let lease = lock_file(&path.join(".lease"))?;
    lease.lock_shared()?;
    let marker = path.join(".loom-profiles.json");
    // Never adopt an unknown legacy directory: another old instance has no lease.
    if !existed || marker.exists() {
        let profiles = if existed {
            fs::read(&marker).ok().and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        } else { Some(Vec::new()) };
        // Retention metadata must not stop Codex starting if a prior write failed.
        if let Some(mut profiles) = profiles {
            let profile = std::path::absolute(profile)?.to_string_lossy().into_owned();
            if !profiles.contains(&profile) { profiles.push(profile); }
            let pending = marker.with_extension("pending");
            let _ = fs::write(&pending, serde_json::to_vec(&profiles)?)
                .and_then(|_| fs::rename(&pending, &marker));
        }
    }
    // Restoring many panes should scan the cache only once, not once per pane.
    static LAST_SWEEP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    if now.saturating_sub(LAST_SWEEP.load(std::sync::atomic::Ordering::Relaxed)) >= 24 * 60 * 60 {
        LAST_SWEEP.store(now, std::sync::atomic::Ordering::Relaxed);
        prune(root, Duration::from_secs(30 * 24 * 60 * 60));
    }
    Ok(lease)
}

fn prune(root: &Path, age: Duration) {
    let Ok(root) = root.canonicalize() else { return };
    let Ok(entries) = fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // Junctions and symlinks are not cache directories we own.
        use std::os::windows::fs::MetadataExt;
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 { continue; }
        let Ok(resolved) = path.canonicalize() else { continue };
        if resolved.parent() != Some(root.as_path()) { continue; }
        let marker = path.join(".loom-profiles.json");
        let Ok(meta) = fs::metadata(&marker) else { continue };
        if !meta.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|elapsed| elapsed >= age) { continue; }
        let Ok(profiles) = fs::read(&marker).and_then(|b| serde_json::from_slice::<Vec<String>>(&b).map_err(Into::into)) else { continue };
        let Some(sid) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let quoted_sid = serde_json::to_string(&sid).unwrap();
        if profiles.is_empty() || profiles.iter().any(|profile| {
            // Missing/moved/unreadable profiles remain protected too.
            fs::read_to_string(profile).ok().filter(|s| serde_json::from_str::<serde_json::Value>(s).is_ok())
                .is_none_or(|s| s.contains(&quoted_sid))
        }) { continue; }
        let Ok(lease) = lock_file(&path.join(".lease")) else { continue };
        if lease.try_lock().is_err() { continue; }
        let _ = fs::remove_dir_all(&resolved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_protects_live_saved_and_unknown_caches() {
        let root = std::env::temp_dir().join(format!("loom-cache-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let profile = root.join("state.json");
        fs::write(&profile, "{\"sid\":\"saved\"}").unwrap();
        let caches = root.join("caches");
        let live = acquire(&caches, "live", &profile).unwrap();
        drop(acquire(&caches, "saved", &profile).unwrap());
        drop(acquire(&caches, "expired", &profile).unwrap());
        fs::create_dir_all(caches.join("legacy")).unwrap();
        drop(acquire(&caches, "damaged", &profile).unwrap());
        fs::write(caches.join("damaged/.loom-profiles.json"), "partial").unwrap();
        drop(acquire(&caches, "damaged", &profile).unwrap());
        prune(&caches, Duration::ZERO);
        assert!(caches.join("live").exists());
        assert!(caches.join("saved").exists());
        assert!(caches.join("legacy").exists());
        assert!(caches.join("damaged").exists());
        assert!(!caches.join("expired").exists());
        drop(live);
        fs::remove_file(&profile).unwrap();
        prune(&caches, Duration::ZERO);
        assert!(caches.join("saved").exists());
        fs::write(&profile, "{}").unwrap();
        prune(&caches, Duration::ZERO);
        assert!(!caches.join("saved").exists());
        assert!(!caches.join("live").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
