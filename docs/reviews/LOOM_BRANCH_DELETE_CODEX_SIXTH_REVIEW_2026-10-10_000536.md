# Loom branch deletion, sixth review

What this change does: commit `62e1c6e` resolves a linked worktree's relative `gitdir` record against its administration directory. The ordinary relative-path regression from the fifth review now passes. A repository reached through a Windows junction still resolves that record against the wrong directory.

Reviewed `5a4a696..62e1c6e`, including the connected deletion callers, repository restoration, worktree removal guards, process lookup, and native tests. HEAD was `62e1c6ea5dbbbab00c9e76cd905c1991588e85bc`. This review changes no production code. The watcher remains off.

## 1. P1: a repository junction can hide a busy worktree

**What the code does.** `src-tauri/src/deletion.rs:230` constructs the common Git directory using the repository path supplied by the caller. `worktree_of` at line 139 then resolves relative metadata with `std::path::absolute`. This resolves `..` against the spelling of that path. The busy-process check compares the resulting folder with the Git process's working directory.

**Why this is a problem.** Git writes relative worktree metadata against the physical administration directory. A junction can give that directory a different depth. Resolving `..` against the junction spelling produces a valid-looking absolute path to the wrong folder. The process check therefore misses a checkout in the actual linked worktree.

I reproduced this with real Git `2.48.1.windows.1` and a native driver extracted from the current production code:

```text
fixture/storage/repo      physical repository
fixture/repo-junction     junction to storage/repo
fixture/other             linked worktree
```

Git stored `../../../../../other/.git` in the linked worktree's administration directory. Through `repo-junction`, `rev-parse --git-common-dir` returned `.git`. Loom resolved the record against `fixture/repo-junction/.git/worktrees/other`, which pointed outside the fixture instead of to `fixture/other`.

The reproducer paused a plain Git checkout in `post-index-change`, after its index lock had gone and before HEAD changed. Native deletion returned `deleted`. Checkout then exited successfully with HEAD pointing to `refs/heads/topic`, but that branch no longer existed. `git rev-parse --verify HEAD` failed with `fatal: Needed a single revision`.

This reaches the application through a saved repository path. For example, moving the repository and replacing its old location with a junction preserves a previously saved path. Restoration at `src/main.ts:9948` and `10405` passes the saved repository into `openThread` at line 5696. Removal invokes `branch_delete` with that path at line 5920. New CLI threads canonicalize their paths, but restoration does not. The preceding worktree-removal check does not rule out this case: `entry_of` in `src-tauri/src/lib.rs:631` compares directory file identities, so the junction can refer to the correct administration directory while branch deletion later resolves its relative metadata incorrectly.

**Smallest suggested fix.** Establish the physical common or administration directory before resolving relative Git metadata in the read-only branch-safety lookup. Normalize Windows paths consistently for the process comparison and refuse deletion if that identity cannot be established. The existing `canonical_directory` helper at `src-tauri/src/lib.rs:243` already handles Windows path prefixes. Add a repository-junction regression to cover the checks before and after branch deletion. Keep the no-follow checks in destructive worktree removal unchanged.

**If left unfixed.** Loom can delete a branch another Git process is checking out, leaving that worktree with HEAD pointing to a missing branch. The remaining bug is in repository-directory resolution. A control case with only a junction alias for the linked worktree correctly refused deletion because Git's process working directory resolved to the physical worktree.

## Reproducer and evidence

Run from the repository root:

```powershell
node .cache/create-round4-native-driver.mjs
cargo build --manifest-path .cache/round4-native-driver/Cargo.toml --offline
node .cache/round6-repo-junction-relative-checkout.mjs
```

The reproducer asserts the broken result, so its successful exit confirms the finding. After a fix, it must instead require refusal or preservation of the branch. It releases its paused checkout before exiting.

- Failure evidence: `.cache/re-review-post-index-checkout-9dGYBY/evidence.json`.
- Safe worktree-junction control: `.cache/round6-junction-cwd-checkout.mjs`, with evidence in `.cache/re-review-post-index-checkout-wmgcuG/evidence.json`.
- Ordinary relative metadata now passes: `.cache/round5-relative-worktree-checkout.mjs`, with evidence in `.cache/re-review-post-index-checkout-wRbli0/evidence.json`.

## Validation

The full Rust suite passed: 140 library tests and 16 CLI tests, with five tests ignored. Log: `.cache/re-review-round6-rust.log`.

All five earlier reproducers passed against this revision: ordinary relative worktree metadata, unreadable metadata, checkout paused after index update, delayed checkout with an index lock, and a hook writing 256 KiB to stderr. The separate worktree-junction control passed too. These checks used a fresh native driver built from the reviewed source.

Verdict: fix finding 1 first. No other must-fix finding was confirmed in this range.

Not checked: the installed application or installer, the five ignored tests, and Node, task-check, or browser suites in this round. No frontend source changed in the reviewed range. The confirmed risk is deleting a branch during checkout when a restored repository path resolves through a junction.
