# Follow-up review of Loom pane 7 CLI control

Reviewed on 2026-10-01 UTC. Source snapshot: 20:51:14 UTC.

Checkout: `C:\Users\ayoub\Videos\claude\loom`, branch `main`, HEAD `3d5756ad39213b15a6b0d36f78e6269786358090`. No staged changes. The working diff against HEAD contains 1,173 additions and 96 deletions across ten files. `src-tauri/Cargo.toml` also appears in status with the pre-existing line-ending difference. This review compares the current files with `docs/reviews/LOOM_PANE7_REVIEW_AND_COMPLETION_NOTIFICATIONS_2026-10-01_201248.md` and its retained source snapshot.

At 20:50 UTC, `loom:7`, pane `mupi1loe-22`, generation 1, was idle with three completed turns. Its output reported all three P2 fixes, unit/build/UI checks and no commit. I read that output without sending input. Only five previously captured files changed for this follow-up: `src/main.ts`, `src/prompt.ts`, `src/prompt.test.ts`, `scripts/ui-check.mjs` and `docs/loomctl.md`. The earlier report is an additional preserved file.

## Assessment

The separator and Enter-failure fixes pass independent checks. Input arriving during the paste write or its echo wait now prevents Loom's automatic Enter and keeps the receipt. One narrower P2 race remains before the paste starts. I would fix it before claiming that a guarded send cannot submit input from another writer. There is also one P3 documentation correction concerning uncertain Enter delivery.

The reviewed features are not active in the running Loom. At 21:01 UTC, read-only checks identified PID `20088`, protocol `3`, version `3.0.0`, through `\\.\pipe\loom-ayoub-pid20088`. `help send` still showed only `--no-enter`, `--gen` and `--receipt`; `help receipt` and `help close-plan` returned unknown-command errors. Version and protocol alone do not identify this source revision. I did not install or restart Loom.

## Confirmed findings

### P2: An asynchronous writer can pass between the revision guard and the paste counter

Evidence: `src/main.ts:3461`, `src/main.ts:3464`, `src/main.ts:3473`, `src/main.ts:6874` and `src/main.ts:6901`.

`beforePaste` is async. Its `guard()` checks the requested input revision and whether replacement is allowed, then returns. `sendReply` awaits that callback before capturing `own = p.inputSeq + 1`. An already queued microtask can write to the input in this gap. Because the expected counter is captured after that write, the new post-paste check accepts it. For an initially empty composer, the suggestion check has nothing to check; replacing a suggestion also passes when that earlier writer has already replaced it.

The isolated reproduction evaluates the current `send`, `sendReply`, `inTurn`, `keys`, `submit`, `inputState` and receipt function bodies with fake panes and writes. It starts with a valid revision and sends `approved text` with `--input REV --replace --receipt`. A scheduled writer increments the same input counter and adds ` HUMAN` after the guard returns but before the awaiting function resumes. Both empty-input and suggestion cases submit:

```text
 HUMANapproved text
```

The send succeeds, writes Enter, and returns SHA-256 `5b45d3af2f796de0939d50e4fd38b7eb2eead1d4aef4c003ffb289b5b784441d`, the digest of `approved text`. This is a deterministic scheduling reproduction, not a claim that a real pane was exercised or that every keyboard event can occupy this gap. Loom has asynchronous unqueued input paths, including clipboard completion at `src/main.ts:1635` and dictation completion at `src/main.ts:1379`.

Impact: a headless caller can receive a successful guarded-send result even though another writer's text joined the submitted task. The digest audits the caller's supplied text, not the final combined composer.

Smallest fix: separate asynchronous preparation, such as waiting for a shell prompt, from the synchronous input guard. Run the final revision/kind check, capture the expected counter and start the paste in one synchronous segment. Alternatively retain the counter observed by the guard and reject a change before the paste rather than accepting a new baseline. Keep the existing counter check immediately before Enter.

Acceptance test: put a queued writer continuation between the async preflight and paste, with both empty input and a suggestion. It must refuse before typing or hold back Enter with `typed: true` and retain the receipt. Normal queued sends must continue to submit separately. Keep the passing tests for writers during the paste and echo wait.

### P3: The new documentation treats a later turn as proof of uncertain Enter delivery

Evidence: `docs/loomctl.md:452`, with the retained turn-receipt behavior at `src/main.ts:6907` and `src/main.ts:3528`.

The added documentation says that after uncertain Enter delivery, “if a turn comes back, it was submitted.” That implication does not hold. `turnsAt` is set before attempting Enter, and the next counted turn can acknowledge that receipt regardless of which input caused the turn.

The isolated reproduction makes Enter fail before delivery. There are zero submitted inputs. It then supplies a later turn on the same pane generation. The receipt reports:

```json
{"stage":"typed","uncertain":"submit","outcome":"acknowledged","turn":1}
```

Impact: an agent following this sentence could conclude that a task was delivered when it remains unsent. The uncertainty field correctly remains set; the documentation should not turn the coarse turn acknowledgement into stronger evidence.

Smallest fix: replace that sentence with the exact limitation: a later turn can acknowledge the legacy turn receipt without proving that this Enter or task reached the provider. Continue requiring screen/result inspection. Task correlation is an already-known design gap, not a new implementation requested by this review.

Acceptance test: a failed Enter followed by an unrelated turn must not be described as verified submission. Documentation and consumer examples must preserve the distinction between `uncertain`, a turn acknowledgement and verified task completion.

## Previous findings and safeguards

| Prior finding or safeguard | Independently verified disposition |
| --- | --- |
| Human input during the paste delay joins the guarded send | The original write/echo-wait cases are fixed. Four focused cases cover empty input and suggestions, during the write and during settling. Enter is held and the receipt remains typed. The earlier pre-paste async gap above remains. |
| Claude U+00A0 separator is missed | Fixed. `src/prompt.ts:91` accepts ASCII space and U+00A0. Draft, focused/unfocused suggestion and collapsed-paste fixtures pass; unsupported separators stay unknown. |
| Enter-write failure drops an already-typed receipt | Fixed. `src/main.ts:6917` retains write progress and conservative uncertainty. Failed paste, failed Enter and an Enter whose reply was lost preserve the receipt and digest. The no-receipt error also reports uncertainty. |
| Ignored files omitted from deletion protection | Still protected. The inventory retains `--ignored=matching`; an ignored-only fake tree refuses cleanup without explicit loss authorization. |
| Deletion plan and cleanup recheck | Still protected in focused mocks. Renaming the target invalidates the plan before cleanup. Changed inventory after pane closure keeps the worktree and branch and reports the completed closure. No real worktree was removed. |
| Receipt digests | Still correct for the exact supplied UTF-8 text, including newlines, tabs, accents, CJK and emoji. The shell receipt comment is excluded from that digest and retained in the actual framed write. This does not authenticate the final composer or provider acceptance. |

## Independent tests

| Check | Result |
| --- | --- |
| Copied `src/cli.test.ts` | 64 passed, 0 failed |
| Copied `src/prompt.test.ts` | 53 passed, 0 failed |
| Copied `src/gitparse.test.ts` | 46 passed, 0 failed |
| Focused current-source mocks | 18 protective checks passed; the pre-paste race and the documentation counterexample were reproduced |
| TypeScript on the isolated copy | Passed with `--noEmit` |
| Vite production build on the isolated copy | Passed; outputs written only under the review snapshot |
| Existing mocked UI suite against that fresh served bundle | Passed: 1,229 states across 320, 375, 768, 1024 and 1280 px; CLI regression scenarios run at 1280 px, including same-key retries and the new fixes |
| Running Loom capability checks | Older send interface; receipt and close-plan unavailable |

The first sandboxed Vite attempt failed because esbuild could not read an ancestor directory. The approved owner-context retry against the same isolated copy passed. No security settings or Git trust configuration were changed. Existing dependencies were copied; nothing was installed or downloaded. The test server binds only loopback and serves the isolated build. Tauri IPC, panes, Git actions, providers and settings are mocked in the browser tests.

The focused reproduction script is expected to succeed when it proves the remaining race and the false documentation implication. Its exit status is not an acceptance-test pass for either defect. The script and logs are retained in `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3\loom-pane7-review-20261001T2050`.

## Scope and limits

This is a bounded snapshot of the latest CLI-related changes. Native transport and Rust source did not change between the previous and current snapshots. The untracked studies and benchmark files were preserved and were not executed. Deletion plans cover the documented inventory and identities, not the contents of every dirty or wholly ignored file.

I did not run real Loom or provider integration, submit tasks to live panes, perform destructive worktree tests, run Rust tests, install or restart apps, or test crash/reconnect recovery. The CLI still keeps keys and receipts in memory, and agent receipts correlate to a subsequent turn rather than a durable logical task. Writers outside Loom's input counter remain outside this protection. Dictation's own automatic Enter and settings-generated commands are outside `sendReply`; this review does not certify them as guarded sends. No notification listener, integration or event journal was implemented.

The save verification checks all 143 pre-existing captured files, including prior reports, against their starting SHA-256 hashes, and checks that branch, HEAD and the pre-existing Git status remain unchanged. The new report is the only addition to the checkout. Strict UTF-8 read-back and a report digest are recorded alongside the snapshot evidence. Ignored build artifacts and dependency caches were not part of that 143-file inventory; this review built and tested only the independent copy. The temporary loopback test server was stopped. No source fixes, commits, live-pane input, process control of Loom or user apps, trust changes or notification implementation were performed.
