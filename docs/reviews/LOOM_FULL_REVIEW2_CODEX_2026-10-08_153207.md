# Loom second full review, Codex

Codex reviewed `main` at `6ffc85e` together with the 30-file working-tree diff (2305 insertions, 373 deletions) that holds the 29 fixes of `LOOM_FULL_REVIEW_CLAUDE_OPUS55_2026-10-08_113559.md` and their four follow-up fixes. It confirmed seven findings, each reproduced against the real code, and one maintenance note. This report records them. Claude Opus 5.5 fixes them on the branch `loom/codex-review-2`. Each finding gets a regression that fails on the code before its fix, the smallest fix, and the check that passes after it. The status section is filled in as each one is done.

## Findings

### 1. P1: trash expiry deletes a restored, live checkout after its repository moves

Location: `src-tauri/src/deletion.rs` `restored()` and `purge()`, the deleted-repository rule and the erase after it.

Failing scenario: delete a linked worktree into Loom's trash, then rename the repository. Move the retained Git record from the renamed `.git/loom-trash/<id>` back to `.git/worktrees/<entry>` and run `git -C <renamed repo> worktree repair <trash checkout>`. The checkout is live again: `git branch --show-current` says topic, `git status` shows a new `unsaved.txt`, and `git worktree list` registers it. Purge at expiry then erases it, unsaved file and all, because `restored()` only accepts a Git link into the saved repository's worktrees folder, and the saved repository path no longer exists, which the deleted-repository rule reads as gone.

### 2. P1: a stash action can hit another stash after the shared stack changes

Location: `src/main.ts` `showStashes()` and the `stashes`, `stash-apply` and `stash-drop` subcommands of `loomctl git`; `src/remote/changes.ts` `stashes()`.

Failing scenario: create stash A and list it as `stash@{0}`. Another worktree of the same repository then stashes B, which takes `stash@{0}`. Applying or dropping the listed `stash@{0}` acts on B. A position in the stash list isn't an identity, and every worktree of a repository shares one list.

### 3. P1: a base branch that exists only on the remote becomes a new branch from local HEAD

Location: `src/main.ts` `refExists()` and `createThread()`.

Failing scenario: clone a repository whose `origin/feature` has a commit local `main` lacks, then make a thread with base `feature`. `refExists` looks for `feature^{commit}`, fetches `origin feature`, then looks for the bare name again, which a fetch never creates. `createThread` then treats `feature` as missing and makes a new branch `feature` at local HEAD, without the remote commit.

### 4. P2: a branch switched in the terminal leaves Loom's cached branch stale

Location: `src/main.ts` `headBranch()`, `prUrl()`, `gitStatus()`, the branch-sensitive deletion inventory, and `loomctl git <thread> branches`.

Failing scenario: a thread cached on `main` runs `git switch topic` in its terminal. Git says topic, but Loom's status still says main, and Create PR pushes HEAD and then opens `compare/main...main`. Loom refreshes the branch only after git actions it ran itself.

### 5. P2: creating a thread whose new branch appears meanwhile retries forever

Location: `src/main.ts` `createThread()`, its folder-candidate loop.

Failing scenario: ask for a missing base `fresh`, which becomes a new branch of that name. After the missing-base check and before `git worktree add`, another creator makes branch `fresh`. Each `git worktree add -b fresh` then fails with "a branch named 'fresh' already exists". The loop reads any "already exists" as a taken folder, tries the next folder with the same branch, and never ends.

### 6. P2: the first dictation model download has no deadline and holds the model lock

Location: `src-tauri/src/dictate.rs` `ensure_ctx()` and `ensure_model()`.

Failing scenario: the download runs `curl -sSfL -o` with no connect, transfer or stall deadline. A server that answers 200, sends one byte and stops keeps it running for good, and `ensure_ctx` holds the shared model lock throughout, so every later dictation waits behind it.

### 7. P3: a huge `--timeout` makes loomctl panic

Location: `src-tauri/src/bin/loomctl.rs`, the `--timeout` parse and the `watch --follow` deadline, and its other second-to-duration conversions.

Failing scenario: `loomctl --json --timeout 1e300 watch --follow` panics with "cannot convert float seconds to Duration: value is either too big or NaN" before it connects, instead of a usage error in loomctl's JSON shape.

### Maintenance: npm audit

`npm audit` reports high-severity advisories in development-only packages, nanoid (GHSA-2v37-7h3g-55p8) and source-map-js (GHSA-68fv-2mgg-jv7q). `npm audit --omit=dev` reports none, so nothing shipped is affected. Fix with lockfile updates inside the existing version ranges only, if those suffice.

## Status

Open. Each finding gets its failing regression, fix and passing check here as it is done.
