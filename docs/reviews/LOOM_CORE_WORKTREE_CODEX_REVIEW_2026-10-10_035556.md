What this change does: branch deletion now asks Git for the main working folder, so a configured `core.worktree` counts when Loom looks for an active checkout. The original configured-folder failure is fixed, including a relative setting and a call from a linked worktree. One narrower race remains when the setting changes during deletion.

Reviewed range: `13338d2..fc8aeee`. Reviewed HEAD: `fc8aeee70ad77631295f0b6447d798ae2c2f477b`.

| Commit | Change |
| --- | --- |
| `67c6b07` | Preserve the previous review report |
| `fc8aeee` | Resolve the main folder through Git, add a before-deletion and transaction-gap regression, and update the safety documentation |

I read the complete diff and the connected Git invocation, directory resolution, process lookup, branch transaction, worktree removal, frontend caller, and tests. The assumed load is one Windows desktop with agent panes and overlapping Git operations. Production source stayed unchanged. The watcher is off.

## Must fix

### 1. P2: changing core.worktree during deletion leaves the final check using the old folder

Location: `src-tauri/src/deletion.rs:309`. The stale value is computed at line 252.

- **What this is:** `delete_branch_with` resolves the main working folder once, before starting the reference transaction. The final process check reuses that value after committing the deletion.
- **Problem:** If another process relocates the main checkout and sets `core.worktree` in the preparation-to-commit gap, a checkout in the new folder goes unseen. A real-Git probe returns `deleted`, then the checkout succeeds with HEAD pointing to the missing branch.
- **Fix:** Revalidate the main folder for the final safety check, or refuse conservatively if its identity has changed or cannot be proved. Add a committed regression that changes the setting in the existing transaction-gap callback before starting the paused checkout.
- **If we skip it:** Closing a linked-worktree thread while another terminal or agent relocates the main checkout can leave that checkout's HEAD unresolved. The normal stable-configuration case is now protected; this needs a concurrent configuration change, so it is narrower than the original P1.

The fixture starts with an ordinary `repo/.git` and no `core.worktree`. After Loom has read the worktrees and taken `HEAD.lock`, the existing test callback moves the original tracked file to `working`, sets `core.worktree` to that folder, and starts `git -C repo switch topic`. The checkout pauses in `post-index-change`, with `index.lock` gone and HEAD still naming `main`. Moving the original file preserves the clean checkout and its contents.

Git `2.48.1.windows.1` reports `working` as the top-level folder. The unchanged production process helper independently reports the actual Git child running there. This is an external checkout, not a child of Loom's reference-transaction process, so the transaction's descendant exclusion does not apply. The final check still searches the cached `repo` folder and the metadata folder.

| Observation | Current production-source driver |
| --- | --- |
| Callback state | `HEAD.lock` held, `index.lock` absent |
| Actual Git CWD | `fixture/working` |
| Native deletion | `deleted`, exit 0 |
| Checkout after releasing the hook | Exit 0 |
| HEAD | `refs/heads/topic` |
| HEAD resolution | `fatal: Needed a single revision` |
| Remaining index or HEAD locks | None |

The safe assertion fails with native exit 0 where exit 3 is required. The same fixture also fails with the existing older `62e1c6e` driver. This is a remaining safety bug, not a new regression introduced by `fc8aeee`.

The real caller still reaches this code. `src/main.ts:5920` passes the saved repository path to `branch_delete` after removing the linked worktree. `syncBranch` updates the branch without replacing that saved path. An external configuration change is therefore not prevented by the frontend.

I proved the cause with an isolated driver change, leaving production untouched. Its only change replaces the cached `&top` in the final `git_running` call with a fresh `main_worktree(&given, &common)` result. The same probe then returns exit 3, names the new working folder, restores the branch at the approved tip, and lets the checkout finish with a valid HEAD. It leaves no locks. This proves a small fix is possible; the production fix still needs its regression and checks.

Reproducer and evidence:

- `.cache/review-fc8aeee-core-config-gap.mjs` requires the safe result by default. It uses a bounded native invocation with file output, and releases and awaits its paused checkout in `finally`.
- Current failure: `.cache/review-fc8aeee-core-config-gap.log` and `.cache/review-fc8aeee-core-config-gap-i0Subn/evidence.json`.
- Older-code failure: `.cache/review-fc8aeee-core-config-gap-before.log` and `.cache/review-fc8aeee-core-config-gap-0h3SX4/evidence.json`.
- One-line proof: `.cache/review-fc8aeee-prepare-gap-guard.mjs`, `.cache/review-fc8aeee-gap-guard-driver/review-only-change.txt`, `.cache/review-fc8aeee-core-config-gap-guard.log`, and `.cache/review-fc8aeee-core-config-gap-2UvSc0/evidence.json`.

To reproduce against current production, regenerate the normal driver, build it, clear `LOOM_REVIEW_DRIVER`, and run the gap probe. Select the separate guard driver only when checking the review-only proof.

## Original finding and independent validation

The original P1 in `LOOM_TWO_FIXES_CODEX_REVIEW_2026-10-10_030622.md` is closed against its failing scenario. Both configured-folder probes now refuse deletion and leave HEAD resolving to the approved tip. The new committed Rust regression passes for an already-running checkout, one starting in the transaction gap with a stable setting, and idle deletion.

Checks completed against the reviewed source:

- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 142 library tests and 16 CLI tests passed, five ignored. Log: `.cache/review-fc8aeee-rust.log`.
- `npm test`: all 38 tests passed. Log: `.cache/review-fc8aeee-node.log`.
- The native driver was regenerated and rebuilt from current production deletion code with the unchanged process and directory helpers. The deletion source and snapshot SHA-256 both equal `a2194425e4057cd8aa1bbf0f681f495701b10269ec446e65bccce83d7bc453d1`.
- All ten existing real-Git cases passed serially, including both configured-folder fixtures and all eight earlier safety cases. Added review variants for relative `core.worktree` and a linked-worktree caller also passed, for twelve passing cases. Results: `.cache/review-fc8aeee-native-regressions.json`. Runner: `.cache/run-review-fc8aeee-native-repros.mjs`.
- The new configuration-change probe fails on current and older code, and passes with the isolated final-folder refresh.
- HEAD and reviewed source were unchanged after testing. Review checkout helpers exited, and all completed gap fixtures were released.

No frontend code changed in this range. The previous desktop and phone browser checks still cover the unchanged frontend source, but were not rerun in this round. No unrelated cleanup or new dependency is necessary.

Verdict: fix 1 first.

Not checked independently in this round: the installed app, release packaging, the five ignored Rust tests, the unchanged browser suites, and the separate full task-check suite. Claude reported 115 task checks passing and an installer built from `fc8aeee`. The confirmed concurrent-configuration race remains in production. The watcher is off.
