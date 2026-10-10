What this change does: branch deletion reads the main working folder again after committing the deletion. If the answer changed, it treats that folder as unknown and restores the branch when a Git process could still be checking it out in either the old or new folder.

Looks good. Ship. No further necessary fix was confirmed in this range.

Reviewed range: `fc8aeee..4babbee`. Reviewed HEAD: `4babbeeacdb8785d3bcbdb4b1bf7ea08e6e77a21`.

| Commit | Change |
| --- | --- |
| `d7832a3` | Preserve the previous core.worktree review |
| `4babbee` | Refresh the main-folder identity for the final safety check, refuse conservatively when it changed, add the real-Git regression, and document that refusal |

I read the complete diff and the connected branch transaction, directory lookup, process filtering, HEAD locks, restoration, Git invocation, Tauri command, frontend deletion caller, and tests. The assumed load is one Windows desktop with agent panes and overlapping Git operations. Another active pane was editing external dev-mod files; the reviewed repository source stayed unchanged throughout the checks.

The change is four production lines in `src-tauri/src/deletion.rs:309`. An unchanged lookup retains its existing behavior. A changed answer becomes an unknown main folder, so the existing conservative process check covers a checkout running in either folder. A lookup failure also remains conservative. Both the final process check and the final HEAD inspection receive the resulting identity. Branch-tip validation, physical metadata, HEAD locks, restoration, and error reporting keep their existing behavior.

The destructive caller at `src/main.ts:5920` still passes the saved repository path and approved tip through the unchanged `branch_delete` command. The change fixes the shared native safety check without adding a frontend workaround or changing the command contract.

## Earlier finding is closed

The P2 in `LOOM_CORE_WORKTREE_CODEX_REVIEW_2026-10-10_035556.md` is closed against its original failing scenario. I regenerated the driver from current production and reran the same configuration-change probe with real Git `2.48.1.windows.1`. It now refuses and restores `topic` at the approved tip. Releasing the paused checkout gives exit 0, HEAD resolves to that tip, and no index or HEAD locks remain.

I also checked the reason for treating a changed answer as unknown instead of accepting only the new folder:

| Transaction-gap case | Independently observed result |
| --- | --- |
| Move the tracked file, change core.worktree, then start a checkout in the new folder | Native exit 3, branch restored, checkout exits 0 with valid HEAD, no locks |
| Start the paused checkout in the old folder, then change core.worktree | Native exit 3, branch restored, checkout exits 0 with valid HEAD, no locks |
| Start the paused checkout, then set core.worktree to a nonexistent folder so the final lookup fails | Native exit 3, branch restored, checkout exits 0 with valid HEAD, no locks |

The probes independently verify the actual Git child's working folder. They use the existing transaction-gap callback with `HEAD.lock` held, require the safe result by default, release their checkout in `finally`, and await its completion. For the old-folder and failed-lookup cases, the setting is restored after native deletion completes so the final HEAD check reads the original checkout.

Evidence:

- Original gap: `.cache/review-4babbee-review-fc8aeee-core-config-gap.log` and `.cache/review-fc8aeee-core-config-gap-OU07kJ/evidence.json`.
- Old folder: `.cache/review-4babbee-review-4babbee-core-old-folder-gap.log` and `.cache/review-4babbee-core-old-folder-gap-FEx4a6/evidence.json`.
- Failed lookup: `.cache/review-4babbee-review-4babbee-core-unreadable-gap.log` and `.cache/review-4babbee-core-unreadable-gap-SRlYiV/evidence.json`.

## Independent checks

- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 143 library tests and 16 CLI tests passed, five ignored. This includes the new configuration-change regression, the stable configured-folder cases, idle deletion, relative linked worktrees, and junction cases. Log: `.cache/review-4babbee-rust.log`.
- `npm test`: all 38 tests passed. Log: `.cache/review-4babbee-node.log`.
- The exact-source driver was regenerated and rebuilt. The production deletion source and driver snapshot both have SHA-256 `566e06ab860aec1015f102e2638ed4509ba8a0c8b313003c6216891355b0f81e`.
- All fifteen real-Git probes passed serially: the twelve earlier safety and configured-path cases, the original configuration-change gap, and the added old-folder and failed-lookup cases. Results: `.cache/review-4babbee-native-regressions.json`. Runner: `.cache/run-review-4babbee-native-repros.mjs`.
- The tracked checkout and HEAD remained unchanged. Review checkout helpers exited and their paused processes were released.

The fix adds one Git read after a successful deletion commit, while HEAD locks remain held. When the main-folder identity changes, an unrelated running Git process can make Loom keep the branch. That conservative refusal is documented and is preferable to losing a checkout's branch. No new dependency, unrelated cleanup, or additional abstraction is necessary.

No frontend code changed in this range, so the unchanged desktop and phone browser suites were not rerun. Claude reported 115 task checks passing against a fresh debug build and served bundle, plus an installer built from `4babbee`; those are reported results, not independently repeated checks in this round.

Verdict: Ship.

Not checked independently: the installed app, release packaging, the five ignored Rust tests, and the unchanged browser and separate task-check suites. No production edits, installation, or restart were performed. The watcher remains off.
