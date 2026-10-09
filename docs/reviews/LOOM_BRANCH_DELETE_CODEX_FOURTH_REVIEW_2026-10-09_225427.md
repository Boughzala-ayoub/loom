# Fourth review of branch deletion

What this change does: `9573090` holds every worktree's `HEAD.lock` and waits up to three seconds for Git processes in the repository before deleting a branch. It checks again after deletion and restores the approved tip when Git is still running. This review covers `cd4e545..9573090`, including the preserved third report in `dac2ff4`, for the normal Windows use of multiple agent worktrees.

All three original scenarios pass independently against the current production functions: the delayed smudge filter, the checkout paused after its index write, and the noisy reference-transaction hook. One new error path still permits the checkout to lose its branch.

## Must fix

1. **P1. An unreadable linked-worktree gitdir file makes Loom miss its running checkout.** `src-tauri/src/deletion.rs:131-133`, used by `git_running` at lines 172 and 181.
   - **What this is:** `worktree_of` supplies the worktree folders used to match running Git processes. A linked worktree's administration directory has a `gitdir` file that identifies its working folder.
   - **Problem:** Every read failure becomes the administration directory's parent, which is the wrong folder for a linked worktree. With a temporary Windows sharing lock on that file, the actual checkout's folder matches neither process scan, so Loom deletes the branch and the released checkout succeeds with HEAD naming a missing branch.
   - **Fix:** Propagate linked-worktree metadata read failures as an unknown or busy worktree and keep the branch. Reserve the parent-folder fallback for the known main administration directory; update all callers and add this file-lock case to the native regression tests.
   - **If we skip it:** A metadata-read failure disables the new checkout protection without warning. The user gets a successful branch deletion followed by a worktree whose HEAD cannot resolve.

### Reproduction

The isolated Cargo driver uses the current deletion functions and the process-reading functions from `procs.rs` verbatim. The shared-directory lookup calls real Git through a small wrapper. It uses Windows crate 0.61.3, as the repository does.

From the repository root:

```text
node .cache/create-round4-native-driver.mjs
cargo build --manifest-path .cache/round4-native-driver/Cargo.toml --offline
node .cache/round4-locked-gitdir-checkout.mjs
```

The script pauses a normal `git switch topic` in `post-index-change` with HEAD still detached and both locks absent. Its own PowerShell child opens that linked worktree's `gitdir` file for reading with `FileShare.None`. This changes no file contents; it only makes the metadata temporarily unreadable. It then calls the actual native deletion function, releases the file handle and hook, and checks the checkout's result.

Verified against `9573090636a99fef20856a74f2bf441c6816586d`:

```text
gitdir read: EBUSY
native deletion: deleted
checkout exit: 0
HEAD: refs/heads/topic
rev-parse --verify HEAD: fatal: Needed a single revision
```

Evidence: `.cache/re-review-post-index-checkout-2ve82H/evidence.json`. Both owned child processes finished, the metadata handle was released, and no HEAD.lock remained. The current script asserts the bad outcome; a regression test must instead assert that the branch is kept and the checkout's HEAD resolves to its approved tip.

## Validation and scope

- Original post-index-change case: refused because Git was busy; after release, checkout exited 0 and HEAD resolved to the approved tip. Script: `.cache/round4-post-index-checkout.mjs`.
- Original delayed-smudge case: refused because of `index.lock`; released checkout finished with a valid HEAD. Script: `.cache/round4-slow-checkout.mjs`.
- Original 256 KiB stderr hook case: deletion finished, branch removed, ref lock released. Script: `.cache/round4-hook-output.mjs`.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 140 library tests and 16 CLI tests passed, 5 ignored. The new checkout regression and both earlier regressions pass. Log: `.cache/re-review-round4-rust.log`.
- Read the full native change, its process-query dependency, deletion caller, the shared process reader's callers, added tests and updated documentation. Production code remained unchanged.
- The documented process-discovery limits remain: Git addressing the repository from another folder, WSL/libgit2, and 32-bit Git are outside its stated detection coverage. Git operations in other worktrees may briefly fail on Loom's HEAD locks, and killing Loom can leave those locks behind.

Verdict: fix 1 first.

Not checked: the installed app, release installer, five ignored Rust tests, or a repeat of Node/task-check/browser suites. No frontend source changed in this range. Claude reported 38 Node test files and 115 task-check cases passing; those results were not independently rerun here. Watching stayed off.
