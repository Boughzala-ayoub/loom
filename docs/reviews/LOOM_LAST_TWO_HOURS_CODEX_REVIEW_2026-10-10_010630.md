# Loom changes in the last two hours

What this change does: the native changes keep a branch when linked-worktree metadata cannot be read, resolve relative worktree records, and resolve repository junctions before reading those records. The frontend change adds more commit history to the desktop and phone Changes views. The earlier deletion failures now pass, but the physical-directory change introduces another deletion regression.

Reviewed the fixed window from October 9, 2026 at 23:06:30 to October 10 at 01:06:30, Tunis time. Range: `9573090..2e5b4a9`. Reviewed HEAD: `2e5b4a9aebb0a70a06f82fe4c669fdb681fb9764`. The tracked working tree stayed unchanged throughout this review. Temporary probes and logs are under `.cache`; production code is unchanged and the watcher remains off.

| Commit | Local time | Change |
| --- | --- | --- |
| `77ef14f` | October 9, 23:08 | Preserve the fourth deletion review |
| `5a4a696` | October 9, 23:23 | Refuse deletion while worktree metadata is unreadable and Git is running |
| `7a06045` | October 9, 23:44 | Preserve the fifth deletion review |
| `62e1c6e` | October 9, 23:56 | Resolve relative worktree metadata |
| `cb15fe6` | October 10, 00:18 | Preserve the sixth deletion review |
| `527721b` | October 10, 00:19 | Resolve the physical common Git directory |
| `2e5b4a9` | October 10, 01:05 | Page the desktop and phone commit lists |

I read the complete diff and the connected deletion, restoration, close-thread, process lookup, pagination, option parsing, and API callers. The assumed load is one Windows desktop with agent panes and overlapping Git operations, plus paired phone clients.

## Must fix

### 1. P1: a junction at `.git` hides a checkout in the main working tree

Locations: `src-tauri/src/deletion.rs:234`, with the main-folder assumption at line 135.

- **What this is:** The new code resolves the physical common Git directory before both safety checks. `worktree_of` still treats that directory's parent as the main working folder.
- **Problem:** With `repo/.git` junctioned to `storage/git-data`, that parent is `storage`, so Git running in `repo` goes unseen. The current code deleted `topic` during a paused checkout, which then completed with HEAD pointing to the missing branch.
- **Fix:** Keep the physical common directory for linked metadata and locks, and obtain the actual main working folder independently for the safety checks. Preserve and validate the working-folder identity before resolving the metadata link, and add a regression for this layout before deletion and between preparation and commit.
- **If we skip it:** Closing a linked worktree and deleting its branch can break a concurrent checkout in the main working tree, leaving HEAD unable to resolve its branch.

The controlled fixture uses real Git `2.48.1.windows.1`:

```text
fixture/repo                  main working tree
fixture/repo/.git              junction to fixture/storage/git-data
fixture/storage/git-data       physical Git administration directory
```

Git reports `.git` as the common directory. The checkout pauses in `post-index-change`, with no index lock and HEAD still on `main`. The native driver comes from the exact reviewed deletion source and unchanged process helpers.

| Native code | Delete result | Checkout result |
| --- | --- | --- |
| `62e1c6e`, before the physical common-directory change | Refused, naming the busy Git process in `repo` | Exited 0; HEAD resolves to the approved tip |
| `2e5b4a9`, including `527721b` | Returned `deleted` | Exited 0; HEAD names `refs/heads/topic`, but verification fails |

The current failure is `fatal: Needed a single revision`. No index or HEAD lock remains afterward. This is a regression introduced by `527721b`, independently of the earlier repository-junction finding that it fixes.

The real caller is `removeThread` at `src/main.ts:5920`. It invokes `branch_delete` with the repository path after removing a linked working folder. The preceding removal checks validate that linked folder and its administration entry; a junction at the repository's `.git` is not a junction at the removed folder's own path. The directory-identity check in `entry_of`, `src-tauri/src/deletion.rs:635`, also accepts two paths to the same administration directory.

Root lookup needs care. In this fixture `rev-parse --show-toplevel` returns the correct `repo` folder. The first `worktree list --porcelain` entry reports `storage/git-data`, so using that entry blindly would repeat the mistake. Keep the destructive removal safeguards unchanged.

Reproducer: `.cache/two-hour-gitdir-junction-checkout.mjs`. Its default mode asserts the broken result, so a successful exit reproduces the bug. To require the safe result against the current driver:

```powershell
$env:LOOM_EXPECT_REFUSAL = '1'
node .cache/two-hour-gitdir-junction-checkout.mjs
```

That assertion fails on the reviewed code. It passes with `LOOM_REVIEW_DRIVER` pointing to the separately compiled pre-change driver. The script releases its paused checkout before exiting.

Evidence:

- Current failure: `.cache/review-gitdir-junction-l8y4lL/evidence.json` and `.cache/two-hour-gitdir-junction-current.log`.
- Prior safe behavior: `.cache/review-gitdir-junction-VxBlsq/evidence.json` and `.cache/two-hour-gitdir-junction-before.log`.
- Prior driver source: `.cache/two-hour-before-junction-driver/source-revision.txt`, extracted from `62e1c6e`.

### 2. P2: desktop "Show more" cannot be reached from the keyboard

Location: `src/main.ts:6857`.

- **What this is:** The new desktop control loads another 50 commits into the Changes panel.
- **Problem:** It is a plain `div` with an `onclick` handler. At every required width, Tab skips it, direct focus fails, and it has no button role.
- **Fix:** Use a native button with the existing row styling and add a browser check that focuses it and loads the next batch with Enter. Preserve the current paging behavior.
- **If we skip it:** Keyboard users cannot load older desktop commits through this control.

Fresh headless contexts tested 320, 375, 768, 1024, and 1280 px. Each reported `tag: DIV`, `tabIndex: -1`, `tabReached: false`, `focused: false`, and zero matching button roles. Mouse clicks correctly loaded 10, 60, 110, then 160 commits, with the control disappearing at the end. The phone control already uses a native button.

Probe: `.cache/two-hour-pagination-check.mjs`. Evidence: `.cache/two-hour-pagination.log`. The full desktop suite also recorded the keyboard failure at all five widths in `.cache/two-hour-review-ui.log`.

## Validation and earlier findings

The three earlier deletion findings are closed against their original scenarios. Unreadable worktree metadata refuses deletion, relative metadata identifies the correct folder, and a repository-root junction now identifies the linked working folder correctly.

- `npm run build` passed. A new local preview served the built bundle and returned HTTP 200 before testing.
- Full Rust tests passed: 140 library tests and 16 CLI tests, with five ignored. Log: `.cache/two-hour-review-rust.log`.
- All 38 Node tests passed, including real-Git commit-count and `moreCommits` assertions. Log: `.cache/two-hour-review-node.log`.
- All seven earlier native reproducers passed serially against a fresh driver whose source snapshot matched the reviewed source. Results: `.cache/two-hour-native-regressions.json`.
- The full desktop browser suite passed 1,467 rendered states at 320, 375, 768, 1024, and 1280 px, checking horizontal overflow and clipped controls across views and open menus and dialogs. Log: `.cache/two-hour-review-ui.log`.
- The full phone browser suite passed 312 view-width checks at 320, 375, 768, 901, 1024, and 1280 px, plus its asynchronous-action regressions. It served `assets/remote-CY_S-ULs.js` from the fresh build. Log: `.cache/two-hour-review-phone.log`.
- The focused pagination probe passed three successive "Show more" batches at every required width. All 20 page-width measurements satisfied `scrollWidth <= clientWidth`.
- I inspected pagination screenshots at 320 and 768 px on the desktop, and 375 and 901 px on the phone. Layout checks passed; the keyboard finding remains.

Browser checks exercised the served production bundle with Tauri and API boundaries mocked. Screenshots are in `node_modules/.cache/two-hour-review-ui`, `two-hour-review-phone`, and `two-hour-pagination`.

Verdict: fix 1 and 2 first. No other necessary fix was confirmed in this range.

Not checked: the installed application, release packaging or installer, the five ignored Rust tests, and the separate task-check suite in this round. The confirmed branch-deletion risk remains despite the passing existing suites. The watcher is off.
