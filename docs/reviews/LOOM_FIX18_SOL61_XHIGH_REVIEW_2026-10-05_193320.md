MUST-FIX: 0

No must-fix findings, safe to install.

- Read FIX17 first; reviewed the single commit `0ceb75e..6d460c4` on `main`.
- Traced both `restoring` guards. R17-1's retained administration cannot reach purge's erasure path; repeat deletion of the absent original path refuses.
- Source-checked ordinary purge, resume/prepare, repeated deletions, four-field/pending/restoring manifests, serialization defaults, and damaged-record isolation.
- `CLI_ITEM=304 node --experimental-strip-types src/main_cli.test.ts` passed for ordinary, unreadable and restoring list output, destination display, and rejection of the removed restore command.
- Scratch Git verified the documented recovery at original and alternate destinations, and before the folder move. Index bytes, staged mapping, working files and worktree registration survived.
- Confirmed the installed executable's 03:48:38 timestamp and the empty real trash; respected the stated upgrade-state limits and accepted exclusions.
- The v3 `watch --metadata --policy` handler, loomctl transport and documented ASH-LOOM-EVENT contract are unchanged by this commit.
- Rust checks were source-only; no builds or heavy suites. `git diff --check 0ceb75e..HEAD` passed. Scratch folders removed; only this report written, existing untracked docs untouched.
