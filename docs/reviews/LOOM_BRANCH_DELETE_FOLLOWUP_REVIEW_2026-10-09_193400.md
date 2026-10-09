# Follow-up review of branch deletion, through f5c7461

- Range: through `f5c7461`.
- The image and dictation timeout fixes passed on their own and are out of scope.
- Two confirmed findings, both in `src-tauri/src/deletion.rs` (`held_by`, `delete_branch`, from `583ae5f`).
- Both reproduced again before any fix. The reproductions run the production functions, extracted by `.cache/create-re-review-delete-driver.mjs` into `.cache/re-review-delete-driver.rs` and compiled with `rustc --edition 2021`.

## P1. A checkout still writing files is missed by both scans

Around line 165. A plain `git switch topic` in another worktree reads the branch, then writes the working tree, then writes HEAD. A smudge filter can keep it in the middle step while HEAD is still detached. In that state neither scan in `delete_branch` sees it:

- The scan under the ref lock reads HEAD files and rebase and bisect markers, and finds nothing.
- The scan after the commit runs once, before the switch has written HEAD.

So `delete_branch` commits, finds nothing and reports success. The switch then finishes with exit 0. Its HEAD names `refs/heads/topic`, but `rev-parse --verify HEAD` fails.

Reproduction: `.cache/re-review-slow-checkout.mjs`, a real repository with a required smudge filter that waits for a release file. Verified on 2026-10-09 against `f5c7461`, with the driver regenerated and recompiled from the current source:

- The native deletion printed `deleted`.
- The checkout exited 0.
- HEAD was `refs/heads/topic`, and `rev-parse --verify HEAD` failed with `Needed a single revision`.

A fix must count checkouts in progress in the safety decision. Another repair scan after the delete does not close this case. Compare-and-delete must stay. Where deletion can't be shown safe, the branch must be kept and reported as kept.

## P2. A noisy reference-transaction hook stalls the delete with the ref locked

Around lines 145 to 154. The `update-ref --stdin` child has its stderr piped, but stderr is read only by `wait_with_output`, after the stdout protocol ends. A `reference-transaction` hook that writes enough to stderr fills that pipe. Git then blocks before its `prepare` reply, the helper blocks in `output.read_line`, and `refs/heads/topic.lock` stays held indefinitely.

Reproduction: `.cache/re-review-hook-output.mjs`, a hook that writes 256 KiB to stderr on `prepared`. Verified on 2026-10-09 with the regenerated driver:

- After 3 seconds the native deletion was still running.
- `topic.lock` was held.
- The script then killed only its own driver process tree.

Stderr must be drained while the protocol runs, keeping a bounded capture of the errors as `diff_output` in `src-tauri/src/lib.rs` does, and the process must be cleaned up on every error path.
