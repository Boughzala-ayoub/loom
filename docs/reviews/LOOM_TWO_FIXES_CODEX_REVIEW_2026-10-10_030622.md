# Review of the main-worktree and keyboard fixes

What this change does: the native fix finds the main checkout before following a junction at `.git`, while keeping metadata and locks on the physical Git directory. The desktop fix makes "Show more" a button that Tab, Enter, and Space can use. Both original failing cases now pass, but a configured main working folder can still go unseen during branch deletion.

Reviewed range: `2e5b4a9..13338d2`. Reviewed HEAD: `13338d22a5d3dbde5ea8da9a90b9f20d3378bb1f`.

| Commit | Change |
| --- | --- |
| `01f24b4` | Preserve the previous review report |
| `96d731c` | Find the main working folder independently of the physical `.git` directory |
| `13338d2` | Make desktop commit paging keyboard accessible |

I read the complete diff and the connected Git invocation, worktree removal, branch deletion, process lookup, paging, styling, and test code. The assumed load is one Windows desktop with agent panes, overlapping Git operations, and paired phone clients. The tracked checkout stayed unchanged during this review. Temporary probes and logs are under `.cache`; the watcher remains off.

## Must fix

### 1. P1: a configured main working folder still hides a checkout from branch deletion

Location: `src-tauri/src/deletion.rs:138`, with the result used by both process checks at lines 288 and 304.

- **What this is:** `main_worktree` accepts the parent of the path Git reports for its common directory when that parent's `.git` resolves to the same physical directory. Git's `core.worktree` setting can choose a different folder for the checkout.
- **Problem:** The helper accepts the metadata folder's parent even when the real checkout runs elsewhere. With a checkout paused after writing the index, the native code deletes `topic`; the checkout exits successfully with HEAD pointing to the missing branch.
- **Fix:** Validate the actual main working folder using Git's main-worktree configuration, or treat it as unknown when that identity cannot be proved. Use the correct folder or conservative refusal in both safety checks, and add a regression for the configured-folder case before deletion and in the preparation-to-commit gap.
- **If we skip it:** Closing a saved linked-worktree thread can delete a branch another Git process is checking out in the configured main working folder, leaving that checkout's HEAD unresolved.

The simplest reproduced layout needs no junction:

```text
fixture/repo/.git             ordinary Git administration directory
fixture/working              actual main working folder
core.worktree                absolute path to fixture/working
saved Loom repository path   fixture/repo
```

The fixture uses real Git `2.48.1.windows.1`. It moves the tracked main file into `working`, sets `core.worktree`, then runs `git -C repo switch topic`. Git reports `working` from `rev-parse --show-toplevel`. The native process helper also reports a real Git child running in `working`, independently confirming the folder used for the checkout.

The checkout pauses in `post-index-change`: `index.lock` is gone and HEAD still names `main`. The new helper accepts `repo` because `repo/.git` resolves to the physical common directory. The process filter checks `repo` and that administration directory, so the paused process in `working` matches neither.

| Observation | Current result |
| --- | --- |
| Native deletion | `deleted`, exit 0 |
| Checkout after releasing the hook | Exit 0 |
| HEAD | `refs/heads/topic` |
| `rev-parse --verify HEAD` | `fatal: Needed a single revision` |
| Remaining index or HEAD locks | None |

The safety assertion requires refusal and a valid HEAD. It fails with native exit 0 where exit 3 was required. A second fixture with `.git` junctioned to `storage/git-data` fails the same way.

This failure also exists in `62e1c6e`, before the recent physical-directory and main-folder fixes. It is a remaining safety bug in the code being changed, not a regression introduced by these three commits. The original junction scenario, with the checkout in the folder holding `.git`, is fixed.

The saved-path case reaches the real caller. `syncBranch` at `src/main.ts:5757` refreshes the branch while keeping the saved repository path. `removeThread` passes that path to `branch_delete` at line 5920 after removing the linked working folder. Native removal validates that linked folder and its administration entry; it does not validate the configured main working folder.

Reproducers and evidence:

- Ordinary directory: `.cache/post-fix-core-worktree-plain-checkout.mjs`, `.cache/post-fix-core-worktree-plain-current.log`, and `.cache/post-fix-core-worktree-plain-WXvPHR/evidence.json`.
- The same ordinary-directory failure on older code: `.cache/post-fix-core-worktree-plain-before.log` and `.cache/post-fix-core-worktree-plain-7OklAP/evidence.json`.
- Junction layout: `.cache/post-fix-core-worktree-checkout.mjs`, `.cache/post-fix-core-worktree-current.log`, and `.cache/post-fix-core-worktree-2K0OBg/evidence.json`.
- Probe generator: `.cache/prepare-post-fix-core-worktree-probe.mjs`. The scripts require the safe result by default and release their paused checkout before exiting.

## Original findings and validation

Both findings in `LOOM_LAST_TWO_HOURS_CODEX_REVIEW_2026-10-10_010630.md` are closed against their original cases:

| Finding | Independent verification |
| --- | --- |
| `.git` junction hides a main checkout | The committed Rust regression keeps the branch before deletion, restores it when a checkout starts in the commit gap, and allows deletion when idle. The original exact-source driver fixture also passes. |
| Desktop "Show more" cannot take keyboard focus | The committed browser regression passes Tab, Enter, Space, and click paging through 10, 60, 110, and 160 commits. The control disappears at the end. |

Checks completed against the reviewed source:

- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 141 library tests and 16 CLI tests passed, five ignored. Log: `.cache/post-fix-13338d2-rust.log`.
- `npm run build` passed. A fresh preview returned HTTP 200 and served `main-BA5CsbVk.js`, `main-CpF6Dskf.css`, and `remote-CY_S-ULs.js`. Log: `.cache/post-fix-13338d2-build.log`.
- The native driver was regenerated from the reviewed deletion source, with the unchanged process and directory helpers. Its source snapshot SHA-256 matched production: `31a2e07fb7b71be1095d59decec4f89455912f4283685cd71f852cbc7af9bf4c`.
- All seven earlier real-Git reproducers and the original `.git`-junction fixture passed serially. Results: `.cache/post-fix-13338d2-native-regressions.json`.
- The complete desktop browser suite passed 1,462 rendered states at 320, 375, 768, 1024, and 1280 px, including views and open menus and dialogs. It checked horizontal overflow and clipped controls. Log: `.cache/post-fix-13338d2-ui.log`.
- Focused paging checks passed at those five widths and at 481, 601, 761, and 1101 px, just above the desktop breakpoints. All nine widths reported a native button, Tab reachability, and focus. All 36 page-width assertions passed. Log: `.cache/post-fix-13338d2-pagination.log`.
- The complete phone suite passed, including 312 view-width combinations at 320, 375, 768, 901, 1024, and 1280 px, plus asynchronous actions, notifications, dictation, and image regressions. It served the fresh phone bundle at HTTP 200. Log: `.cache/post-fix-13338d2-phone.log`.
- I inspected desktop screenshots at 320 and 768 px, focused paging at 320, 761, and 1101 px, and phone paging at 375 and 901 px. Controls fit and the focused desktop button has a visible outline. Screenshots are in `node_modules/.cache/post-fix-13338d2-ui`, `post-fix-13338d2-pagination`, and `post-fix-13338d2-phone`.

Browser checks exercise the served production bundle with Tauri or API boundaries mocked. No new regression was confirmed in the reviewed commits, and no unrelated cleanup was identified as necessary.

Verdict: fix 1 first.

Not checked independently in this round: the installed app, release packaging, the five ignored Rust tests, and the unchanged Node unit and separate task-check suites. Claude reported 38 Node and 115 task checks passing. The remaining configured-folder branch-deletion risk is confirmed despite the passing existing suites. The watcher is off.
