# Review of October 9's commits

- Range: `efe159b^..3fb97a9`, 22 commits on `main`.
- Reviewer: the read-only pane `loom:2`. The latest phone folding commit, `3fb97a9`, passed its checks.
- Two findings, both reproduced again before any fix.

## P1. Thread close can delete a branch another worktree just checked out

`src/main.ts` `removeThread`, around lines 5918 to 5923, from `8e9c22e`.

After the worktree moves to the trash, `removeThread` deletes the approved branch in five steps:

1. It runs `branch_in_progress`.
2. It reads `for-each-ref --format=%(refname)%00%(worktreepath)`.
3. It awaits `git config --list`.
4. It runs `update-ref --no-deref -d refs/heads/<branch> <approved tip>`.
5. It reports `branch: "deleted"`.

`update-ref` checks the tip under Git's ref lock, but it does not check worktrees. If another agent checks out the unchanged branch in another worktree after step 2, step 4 deletes the branch while it is checked out. The other worktree is left with a symbolic HEAD that names a branch that no longer exists: `rev-parse --verify HEAD` fails with `Needed a single revision`. `git branch -D` refuses the same deletion with `Cannot delete branch 'topic' checked out at '...other'`.

Reproduction: `.cache/today-branch-delete-race.mjs`. It lifts the committed `removeThread` into a VM, uses real disposable Git worktrees, and adds the second worktree right after the `for-each-ref` read.

Verified on 2026-10-09 against `3fb97a9`, whose `removeThread` is unchanged since `b4e9e20`. The run returned `{ removed: true, worktree: "removed", branch: "deleted" }`. The other worktree's HEAD was `refs/heads/topic`, `rev-parse --verify HEAD` failed, and `git branch -D` refused.

A fix must keep both guarantees:

- Never delete a branch that is checked out in another worktree.
- Never delete a tip other than the approved one.

Replacing the compare-and-delete with a separate tip check followed by `branch -D` gives up the second guarantee.

## P2. A large phone image times out before the server's own budget

`src/remote/images.ts`, around line 128, from `b4e9e20`.

Each upload attempt aborts after `AbortSignal.timeout(180_000)`, and each retry starts again from byte zero, up to three attempts. `src-tauri/src/remote.rs` takes a paired phone's image up to 20 MiB and gives its body 600 seconds (`CLIP_TOTAL`), with 15 seconds of silence allowed (`CLIP_IDLE`). A valid 20 MiB image at 0.5 Mbps takes about 336 seconds, so every attempt aborts before it finishes, although the server would have taken it.

Reproduction: `.cache/today-image-timeout.mjs`. It serves the built phone bundle and maps the 180-second budget to 20 ms. The mocked `/api/image` answers after 100 ms.

Verified on 2026-10-09 against the served bundle `assets/remote-DVQ5SfwU.js`:

| Measure | Result |
|---|---|
| Attempts | 3, with budgets `[180000, 180000, 180000]` |
| Submits | none |
| Attachment | kept |
| Slow upload | 335.5 s |
| Server budget | 600 s |

The client deadline should follow the server's ten-minute body budget, with a small margin for the reply. Keep the bounded retries, the authentication, and the existing refusal and draft handling.
