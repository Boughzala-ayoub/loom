# Loom pane 7 CLI control follow-up review

Reviewed on 2026-10-01 UTC. Source snapshot captured at 22:15:03 UTC in `C:\Users\ayoub\Videos\claude\loom`, branch `main`, HEAD `3d5756ad39213b15a6b0d36f78e6269786358090`.

**No actionable findings were confirmed in the latest changes.** Both findings from `docs/reviews/LOOM_PANE7_CLI_CONTROL_REVIEW_2026-10-01_211246.md` are fixed in the reviewed source. The current independent checks preserve the earlier protections as well. This conclusion covers the bounded source snapshot and isolated tests; it does not certify the current installed or running Loom.

The working changes are uncommitted, with no staged diff. Against HEAD, the functional diff has 1,261 additions and 95 deletions across ten files. `src-tauri/Cargo.toml` still appears in status with its previously captured line-ending difference. Compared with the prior review snapshot, only `src/main.ts`, `docs/loomctl.md` and `scripts/ui-check.mjs` changed. The previous report is an additional preserved file. No new CLI source appeared among the untracked files.

| Previous finding | Current evidence and result |
| --- | --- |
| P2: writer between revision check and paste-counter capture | Fixed at `src/main.ts:3462`. The input counter is captured before asynchronous preparation at `3464`; generation and counter are rechecked after it. The final synchronous `check()` at `3472` runs directly before echo/baseline capture and the paste, with no intervening await. CLI passes `guard` as this check at `6913`. The counter check before Enter remains at `3484`. |
| P3: later turn described as proof of uncertain Enter delivery | Fixed at `docs/loomctl.md:455`. It explicitly says that any next turn can acknowledge the receipt without proving that this Enter or task reached the agent. `uncertain` remains `submit`. The tested receipt stays at stage `typed`, with no `submittedAt`, after an unrelated turn. |

The added browser regression at `scripts/ui-check.mjs:984` exercises the application's right-click clipboard path. It resolves the pending clipboard read at 40 microtask depths for each of two starting inputs, empty and suggestion. All 80 cases passed: 10 refused before typing and 70 retained the joined draft but held back Enter. None submitted text containing the injected writer's input. This is stronger coverage than a single mocked scheduling position, while remaining an isolated simulation rather than a live-pane test.

The new shell-prompt waiting test at `scripts/ui-check.mjs:1033` also passed: typing during that wait prevents the CLI's own text from being written. The failed-Enter/unrelated-turn test at `1045` passed with `acknowledged`, `typed`, `uncertain: submit` and a null submission timestamp. That result matches the corrected documentation; acknowledgement still does not prove task delivery or completion.

| Earlier protection | Independent recheck |
| --- | --- |
| Claude U+00A0 separator | Draft, suggestion and collapsed-paste classification passed. The current 53 prompt checks include focused/unfocused suggestions and unsupported separator refusal. |
| Input arriving during paste or echo wait | Four focused cases passed for empty input and suggestions. Enter was withheld and the typed receipt retained. Existing browser cases for typing, dictation and dropped files passed. |
| Failed Enter receipt retention | Failed paste, failed Enter and a lost Enter reply retained the receipt and conservative uncertainty. Errors without a receipt still reported Enter uncertainty. |
| Receipt digests | Exact caller-text UTF-8 digest and byte count passed for multiline text, tabs, accents, CJK and emoji, including shell receipt framing. The digest covers supplied text, not the final composer or provider acceptance. |
| Ignored-file deletion protection | `src/main.ts:4223` still requests `--ignored=matching`. An ignored-only fake tree blocked cleanup unless its loss was explicitly authorized. Target rename invalidated a deletion plan; changed inventory after pane closure kept the worktree and branch. No real deletion occurred. |
| Queuing and lifecycle | Focused concurrent sends submitted separately. Generation changes prevented Enter. Current browser regressions for restart/stop, menu revisions, stdin, long text, partial keys, shell exit status and same-key retries passed. |

| Check on the current isolated copy | Result |
| --- | --- |
| `src/cli.test.ts` | 64 passed, 0 failed |
| `src/prompt.test.ts` | 53 passed, 0 failed |
| `src/gitparse.test.ts` | 46 passed, 0 failed |
| Extracted current-source safety checks | 20 passed, no defects reproduced |
| TypeScript `--noEmit` | Passed |
| Vite production build | Passed; artifacts written only to the independent copy |
| Current `scripts/ui-check.mjs` at 1280 px | Passed: 251 rendered states, all CLI regression sections and the 80-case scheduling sweep |

The browser used a fresh production build served on loopback, with Tauri IPC, terminals, Git operations, settings and provider responses mocked. Dependencies were copied from the existing installation; nothing was installed or downloaded. The 1280 px run contains the CLI regression section and the new scheduling sweep. The other four widths were not rerun for this follow-up: the latest source changes concern CLI sequencing and documentation, and the prior review's five-width result is historical evidence rather than a fresh result for this snapshot.

No Loom CLI calls, pane input or app operations were performed in this review. The earlier capability check at 21:01 UTC found the older running CLI, but that observation does not establish the current running version. This report verifies the source fixes; their installation and live runtime behavior remain unverified.

Real-provider integration, destructive worktree tests, native transport/Rust tests, crash/reconnect tests and live GUI behavior were not run. Native source and the pure CLI/Git/prompt helpers are unchanged since the prior snapshot. Keys and receipts remain in memory; agent receipts still track a subsequent turn rather than a durable logical task. Input that bypasses Loom's counter remains outside these guards. Dictation's own automatic submission and settings-generated commands are outside `sendReply`. These are retained scope limits, not new findings in the current patch. Notification feature implementation was outside this review.

Evidence is retained under `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-pane7-review-20261001T221500`: source copies, `snapshot.json`, working/staged diffs, helper logs, `review-checks.mjs`, its log, typecheck/build logs and the current browser log.

Final verification checks all 144 pre-existing captured files, including the earlier reports, against their starting SHA-256 hashes. Branch, HEAD, staging and pre-existing Git status are checked unchanged, with this new report the only addition. Strict UTF-8 read-back and the report digest are recorded in `report-verification.json`. Ignored build output and dependency caches were outside that inventory; builds and test output were written only inside the independent review copy. The temporary test server was stopped. Source fixes, commits, installs, restarts and security/trust changes were not performed.
