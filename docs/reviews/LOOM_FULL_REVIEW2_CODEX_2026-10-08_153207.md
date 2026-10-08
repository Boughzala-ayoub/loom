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

All seven are fixed, and the npm advisories are resolved. Six of the fixes and the lockfile are their own commits on `loom/codex-review-2`, each holding only that fix's lines. Each commit's own tree, HEAD plus that fix alone, was type-checked or built and ran its regression: `git archive` of the staged tree, outside the working tree. Finding 4 stays uncommitted, for the reason below.

| Finding | Commit | Failing regression (before the fix) | Fix | Passing check |
| --- | --- | --- | --- | --- |
| 1. Trash expiry erases a repaired live checkout | `5de46f1` | `purge_keeps_a_checkout_repaired_after_its_repository_moved`, real git: the checkout and its `unsaved.txt` were erased | `restored()` takes any repository whose record names the folder back, not only the saved one | that test and all 20 deletion tests; 18 on the commit's own tree |
| 2. A stash action follows a position | `fae4c37` | `main_cli.test.ts` 213, real git with two worktrees: applying the listed A applied B | stashes listed with their commit (`src/stash.ts`); apply by commit; drop finds the commit's place, checks what git dropped, puts back a stash that went instead and refuses | 213 (A applied and dropped; a drop raced by another stash refuses and loses nothing), on the commit's tree too |
| 3. A base only on origin becomes a new branch | `408744d` | `thread_create.test.ts`, real createThread and git: branch `feature` at local main | `resolveBase` returns the base, or after the fetch the commit `origin/<base>` or `FETCH_HEAD` has | that test, plus a missing base and an `origin/x` typo; on the commit's tree too |
| 4. A branch switched in the terminal stays stale | uncommitted | `main_cli.test.ts` 214: status said main after `git switch topic` | `syncBranch()` reads the branch from git before status, the Changes panel, Create PR, the deletion inventory and `branches` | 214: status, `compare/main...topic`, `branches` and the inventory follow topic; detached and unborn handled |
| 5. Creating a thread retries forever | `b6d2ea3` | `thread_create.test.ts`: four identical refusals until the test's stop | a branch git says exists stops the thread when the caller named it, takes the next number for `loom/<slug>`; 100 names at most | one try, an error naming the branch, and `loom/auto` becomes `loom/auto-2`; on the commit's tree too |
| 6. The model download has no deadline | `7081815` | `a_model_download_that_stalls_ends_and_leaves_no_partial_file`, a local socket that sends one byte: still running at 20 s | curl gets `--connect-timeout`, `--speed-limit 1024 --speed-time`, `--max-time`; the error names the stall | ends in about 2 s, partial file gone; on the commit's tree too |
| 7. A huge `--timeout` panics | `598b6a0` | `a_timeout_too_long_is_a_usage_error_and_none_panics` took 31536000.5; the review's command exited 101 with the panic | `--timeout` above a year is a usage error; checked follow deadline; saturating watchdog | the test, and the review's command prints `{"code":"usage",...}` and exits 1; on the commit's tree too |
| npm audit | `dd21a10` | `npm audit`: nanoid 3.3.16, source-map-js 1.2.1, both through Vite's PostCSS | the two lockfile entries, inside PostCSS's ranges: nanoid 3.3.20, source-map-js 1.2.2 | `npm audit` finds none; `npm run build` passes |

Finding 4 can't be committed apart from the earlier uncommitted work: `syncBranch()` builds on `headBranch()`, which that work added and HEAD lacks, and its test's lifted-names line is that work's too. It is in the working tree with that work.

The rest of the working tree changed with these fixes only where a check needed it: `ui-check.mjs`'s git mock answers `symbolic-ref` with each folder's branch, including one a `worktree add -b` made during the run, and gives `stash drop` git's answer; `main_cli.test.ts`'s fixture has a default `save()`, and test 210 expects the branch git had.

Checks on the final working tree (the fixes plus the earlier uncommitted work), one heavy step at a time:

- `npm test`: 18 files pass. `tsc` passes.
- `cargo test --offline --lib -- --test-threads=1`: 128 passed, 5 ignored. `cargo test --bin loomctl`: 16 passed.
- `scripts/update-check.ps1`: passes.
- `scripts/ui-check.mjs` on the served build (HTTP 200, the same bundle as `dist/`), one width at a time: 320, 375, 768, 1024 and 1280 px pass, 1437 rendered states.
- `scripts/remote-ui-check.mjs`: 39 checks pass, 252 views fit their width. The desktop stash menu at 768 px and the phone's stash sheet at 901 px look right.
- `TASK_REVIEW=untracked-approval scripts/task-check.mjs`: passes. The full task-check was stopped by the memory reaper after its first 40 cases, all passing, and was not run again.
- `scripts/remote-check.mjs` against a debug build at 375 px: all 16 steps, the phone's stash and restore among them.
- `npm run tauri build`: `src-tauri/target/release/bundle/nsis/Loom_3.0.0_x64-setup.exe`, 2,547,399 bytes, built 2026-10-08 17:09:57. A scratch makensis run shows it packs this build's `loom.exe` (7,039,488 bytes) and `loomctl.exe` (319,488 bytes). It was not run.
