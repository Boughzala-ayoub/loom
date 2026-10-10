MUST-FIX: 1

R17-1. Purge erases an older half-restored checkout's retained index after upgrade.

Location: `src-tauri/src/deletion.rs:93`, `src-tauri/src/deletion.rs:338`, `src-tauri/src/deletion.rs:355`. Introduced by `5173850`.

Scenario: Before upgrading, the old restore moves the working folder to its destination, but a busy index prevents the administration move. Its manifest has `pending: false` and `restoring: <destination>`; the old purge skips it. Install this version and release the busy handle. Once the record is due, deserialization silently drops `restoring`. The retained administration still exists, so `restored()` returns false. Purge accepts the absent `at` as already erased, deletes `entry_at` with its sole index, and removes the manifest. The recovered folder survives with a broken Git link and loses its staged-file mapping. This needs neither a crash nor a redirected path.

Fix: Retain the optional legacy `restoring` destination as compatibility data, show it in `trash list`, and exclude those records from purge until manual recovery or explicit cancellation. Keep the restore command removed.

Checked:

- Read FIX16 first and all five commits on `main`, HEAD `0ceb75e`; respected the accepted exclusions.
- Restore handler, native command and registration are removed. Regular older manifests retain their defaults; the legacy partial-restore problem is R17-1.
- Traced reload buffering, base-reply races, bounded close waits, second-close routing, final journal drain and destruction. The accepted startup-drop limit remains.
- Traced reservation cleanup and record replacement. Both old and replacement handles remain held across publication; scans ignore `.json.tmp`.
- Checked Windows sharing and rename fallback against the [Rust implementation](https://raw.githubusercontent.com/rust-lang/rust/1.90.0/library/std/src/sys/fs/windows.rs); direct Win32 probes were not treated as complete Rust reproductions.
- Scratch Git passed escaped-ID validity and distinctness, pending-lock protection from prune, ordinary GC with aged objects and a packed retention ref, and packed-ref deletion.
- Ref-write failures precede moves; purge removes the ref after erasing both retained locations or recognizing returned administration.
- Traced thread creation, close-thread and trash-list output. The v3 watch fields and loomctl transport are unchanged; ASH-LOOM-EVENT formatting is untouched.
- `git diff --check 66d9592..HEAD` passed. R17-1's purge outcome is source-based; no compiled Loom or live WebView execution is claimed.
- No builds, heavy suites, repo worktrees, staging or commits. Scratch folders removed; existing untracked docs untouched. Only this report was written.
