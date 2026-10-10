# Independent follow-up review of Loom pane 7 CLI control

Saved 2026-10-01T22:43:58.854Z UTC.

No findings.

The P2 queued-writer gap and P3 documentation claim in `LOOM_PANE7_CLI_CONTROL_REVIEW_2026-10-01_211246.md` are fixed in the current source. I found no actionable regression in the requested safeguards. This conclusion covers the inspected source and isolated tests below. It does not establish what is installed or running in Loom.

This is the dedicated Sol6.1 Extra High report-only follow-up requested by the parent, separate from the command controller. Source capture completed at 2026-10-01 22:29:22 UTC. Checkout is `C:\Users\ayoub\Videos\claude\loom`, branch `main`, HEAD `3d5756ad39213b15a6b0d36f78e6269786358090`. There were no staged changes. The existing working diff has 1,261 additions and 95 deletions across ten files. `src-tauri/Cargo.toml` also remains in status with its existing line-ending difference.

I compared the current files with the retained source snapshot supporting the 21:12 report. The only changed files are `src/main.ts`, `scripts/ui-check.mjs`, and `docs/loomctl.md`. The 21:12 and 22:25 reports are additional files in this capture and were preserved. I did not use the older reviewer's conclusions or test totals as my results.

## Disposition of the prior findings

### P2 queued-writer gap is fixed

Evidence is at `src/main.ts:3464`, `src/main.ts:3469`, `src/main.ts:3472`, `src/main.ts:3475`, `src/main.ts:3484`, and `src/main.ts:6912`.

`sendReply` captures `inputSeq` before asynchronous preparation, then refuses a change before starting the paste. The caller's final `check`, the echo baseline, the expected paste counter, and the call to `keys` now run in one synchronous stretch. `keys` increments the counter and starts `pty_write` synchronously at `src/main.ts:3396`. No promise continuation can occupy the old gap after the revision guard and before counter capture. The counter check before Enter still rejects a writer during the paste or echo wait.

My fixture extracts the actual function bodies from the captured source. It queues a counted writer while `inputState` reads the final guard, for both empty input and a suggestion. As a positive control, the same fixture against the retained 20:50 source submits ` HUMANapproved text`. Against current code, the paste starts before the writer runs, Enter is held, the combined draft remains, and the receipt reports `stage: "typed"` and `outcome: "none"`. There are zero automatic submissions in both current cases.

Separate checks reject writers during a shell prompt wait and during the `await undefined` continuation before the final check, with no paste and no retained unwritten receipt. A normal shell prompt wait and two queued normal sends still submit successfully.

The fresh browser build independently exercises the real clipboard continuation and xterm input path with mocked Tauri IPC. Across 40 microtask depths for each of empty input and a suggestion, all 80 cases refuse the combined submission. Ten refuse before typing and 70 hold Enter after typing. These are scheduling tests against a mock provider, not live pane operations.

### P3 acknowledgement claim is corrected

Evidence is at `docs/loomctl.md:455`, `src/main.ts:3540`, `src/main.ts:6597`, and `src/main.ts:6916`.

The documentation now says that the next turn may acknowledge the receipt whatever input started that turn, and that acknowledgement does not prove delivery of this Enter or task. It no longer contains "if a turn comes back, it was submitted."

I reproduced the original counterexample independently. Enter fails before delivery, so the mock has zero submissions. A later unrelated turn acknowledges the receipt. Its record remains:

```json
{"outcome":"acknowledged","stage":"typed","uncertain":"submit","submittedAt":null}
```

The browser regression also passes this case. The coarse turn correlation remains, as documented; it is not a newly introduced defect or proof of task completion.

## Requested regression checks

| Safeguard | Independently verified result |
| --- | --- |
| U+00A0 prompt separator | `src/prompt.ts:91` still accepts ASCII space and U+00A0. Empty input, focused and unfocused suggestions, and collapsed pasted drafts pass the copied prompt tests and browser cases. Unsupported separators remain unknown. |
| Failed Enter receipt retention | `src/main.ts:6926` retains the receipt, caller digest and conservative uncertainty. Paste failure, Enter failure before delivery, lost Enter reply, and failure without a requested receipt pass. An unrelated later turn preserves the uncertainty and typed stage. |
| Input guards | Stale counted input, changed visible draft without a counter increment, `--replace` over a draft or unreadable input, generation changes, missing echo, and a suggestion remaining after paste all refuse as expected. Suggestion-only changes, guarded replacement, `--no-enter`, and normal queued sends remain usable. |
| Ignored-file protection | `src/main.ts:4223` still requests `--ignored=matching`, and `src/gitparse.ts:36` retains ignored paths. An ignored-only fake worktree refuses cleanup without explicit `--discard ignored`. A changed ignored inventory or renamed target invalidates the plan before closure. A changed inventory during fake pane closure keeps the folder and branch. No real worktree was removed. |

## Tests and evidence

All tests ran against an independent copy under `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-sol61-review-20261001T222907Z`. Existing dependencies were copied. Nothing was installed or downloaded.

| Check | Result |
| --- | --- |
| Copied `src/cli.test.ts` | 64 checks passed |
| Copied `src/prompt.test.ts` | 53 checks passed |
| Copied `src/gitparse.test.ts` | 46 checks passed |
| Newly written `independent-review-checks.mjs` | 34 focused checks passed, including the old-source positive control |
| TypeScript `--noEmit` | Passed |
| Fresh Vite production build | Passed in owner context after the sandbox denied ancestor-directory reads |
| Existing `scripts/ui-check.mjs` on the fresh served bundle | Passed at 1280 px, 171 rendered states and the 80-case writer sweep |

The browser run used `UI_WIDTHS=1280` and `UI_THEME=sol61-review`. That value names its screenshot subdirectory and selects Loom's default theme through the existing unknown-theme fallback. The script skips its theme-palette sweep when `UI_THEME` is set. I did not run the full five-width/theme suite. I inspected the workspace and close-pane-dialog screenshots; they were readable at 1280 px.

The isolated build produced only the existing large-chunk advisory. The first failed build log is retained as `build-sandbox.log`; the successful build log is `build.log`. Unit logs, `ui.log`, `independent-review-checks.log`, and the structured `independent-review-checks.json` preserve these results. Tauri IPC, provider input, Git actions and pane lifecycle are mocked. The loopback server served only the independent `dist` and was stopped after the run.

## Scope and preservation

I read `C:\Users\ayoub\AGENTS.md`, the global `.agents/skills/unslop/SKILL.md`, the Review Agent skill, and the applicable Ponytail guidance. There are no `AGENTS.md` files under this checkout and no repo `.agents` directory. The report received the required Unslop writing pass.

No live pane commands, running-Loom capability checks, source fixes, commits, installs, trust configuration, security changes, or notification implementation were performed. Rust/native transport tests, real providers, crash/reconnect recovery, and destructive integration were not run. This review cannot certify activation of the source changes in the installed app. Receipts and retry keys remain in memory; turn acknowledgement still does not identify a durable logical task. Native or other writers outside Loom's input counter remain outside this guard.

Git repository discovery refused the different file owner. Read-only commands with the existing repository's explicit `--git-dir` and `--work-tree` succeeded without a trust override. Git warned that the user-global ignore file could not be read. The preservation inventory and Git comparisons therefore use the same accessible status view throughout.

The save verification checks all 145 captured pre-existing files by SHA-256, including all 13 prior review files. It also checks HEAD, branch refs, index, Git config, the staged and working diffs, and the existing status. The new report is the only checkout addition. `report-verification.json` records the final strict UTF-8 read-back, report digest and preservation results. Ignored build/dependency caches and `.agentflow` configuration are outside the file-hash inventory; no test or build ran in the main checkout.
