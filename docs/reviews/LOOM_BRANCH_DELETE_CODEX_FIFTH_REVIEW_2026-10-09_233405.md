# Fifth review of branch deletion

What this change does: `5a4a696` stops substituting a linked worktree's administration-folder parent when its `gitdir` file cannot be read. An unknown worktree folder now makes running Git processes block deletion, or causes the approved branch tip to be restored after deletion. This review covers `9573090..5a4a696`, including the preserved fourth report in `77ef14f`, for Windows repositories with concurrent agent worktrees.

The fourth review's sharing-lock case is fixed and passes independently. All three earlier cases also pass. One remaining path-handling issue is confirmed with actual relative-worktree metadata produced by Git.

## Must fix

1. **P1. Relative worktree metadata still makes Loom miss a running checkout.** `src-tauri/src/deletion.rs:136`, used by `git_running` at lines 182 and 192.
   - **What this is:** `worktree_of` reads the linked worktree's `gitdir` file to identify the folder used by a running Git process. Git can record that path relative to its administration directory through `worktree add --relative-paths` or `worktree.useRelativePaths`.
   - **Problem:** The helper returns a relative string such as `../../../../other` and compares it to the process's absolute current folder. Both process scans miss the paused checkout, so deletion succeeds and the released checkout exits successfully with HEAD naming the deleted branch.
   - **Fix:** Resolve the recorded path against its administration directory, normalize the dot segments, and extract the worktree parent before matching process folders. Follow the existing resolution pattern in `missing_entry` and `spelled`, retain unreadable-path refusal, and add a relative-path version of the native checkout regression.
   - **If we skip it:** A valid relative-path repository bypasses the new checkout protection. The user can end up with a successful checkout whose HEAD cannot resolve, despite Loom reporting successful branch deletion.

Git documents both the relative-path option and its configuration: [git-worktree](https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt---relative-paths), [git-config](https://git-scm.com/docs/git-config#Documentation/git-config.txt-worktreeuseRelativePaths). Claude mentioned this limitation in its closing summary. The real-Git reproduction confirms that the supported setting can leave a worktree with a missing branch.

### Reproduction

The installed Git is 2.39.1, so the review downloaded the official MinGit 2.48.1 archive into `.cache/MinGit-2.48.1-64-bit` and verified its SHA-256 against the publisher's [release checksums](https://github.com/git-for-windows/git/releases/tag/v2.48.1.windows.1). No installation or system PATH change was made. The script changes PATH only for itself and its children.

The driver contains the current deletion functions and process-reading functions verbatim. Rebuild it from the current production source, then run the real-Git fixture:

```text
node .cache/create-round4-native-driver.mjs
cargo build --manifest-path .cache/round4-native-driver/Cargo.toml --offline
node .cache/round5-relative-worktree-checkout.mjs
```

The script uses Git 2.48.1 to create a detached linked worktree with `--relative-paths`. Git itself writes the metadata and enables `extensions.relativeWorktrees`; no metadata is fabricated. `git worktree list --porcelain` correctly reports both absolute worktree folders. A normal switch is then paused in `post-index-change` before its HEAD update.

Verified against `5a4a696164e96633ddb3594d1ce6529dddd6df50`:

```text
Git: 2.48.1.windows.1
gitdir: ../../../../other/.git
extensions.relativeWorktrees: true
paused checkout: HEAD detached; index.lock and HEAD.lock absent
native deletion: deleted
checkout exit: 0
HEAD: refs/heads/topic
rev-parse --verify HEAD: fatal: Needed a single revision
```

Evidence: `.cache/re-review-post-index-checkout-S6IK5X/evidence.json`. The hook was released and its checkout process finished in cleanup. The current script asserts the bad outcome; a regression must assert that deletion refuses or restores the approved branch and that the released checkout has a valid HEAD.

## Validation and scope

- Fourth-review sharing-lock case: deletion refused, branch stayed at its approved tip, no HEAD locks remained, and the released checkout exited 0 with HEAD resolving to that tip. Evidence: `.cache/re-review-post-index-checkout-hySUdh/evidence.json`.
- Original absolute-path post-index-change case: deletion refused and the checkout finished with a valid HEAD.
- Original delayed-smudge case: deletion refused because of `index.lock`; released checkout finished with a valid HEAD.
- Original 256 KiB stderr hook case: deletion finished and its ref lock was released.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 140 library tests and 16 CLI tests passed, 5 ignored. No pane-job failures occurred in this run. Log: `.cache/re-review-round5-rust.log`.
- Read the full diff, all callers of the changed helpers, related deletion and process checks, the expanded native regression, documentation, and the existing relative-path resolution code. Production code remained unchanged, and watching stayed off.

Verdict: fix 1 first.

Not checked: installed Loom, release installer, five ignored Rust tests, or repeat Node/task-check/browser suites. No frontend source changed in this range. Other documented process-discovery limits remain, including Git addressing a repository from another folder, WSL/libgit2, and 32-bit Git.
