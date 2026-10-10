# Loom CLI operator experience review

Review date: 2026-10-01 UTC. Source snapshot: 2026-10-01T17:18:44.3401754Z.

Checkout: `C:\Users\ayoub\Videos\claude\loom`, branch `main`, HEAD `3d5756ad39213b15a6b0d36f78e6269786358090`. Git was rechecked at 17:39:38 UTC with the same branch, HEAD and worktree registry. The former `C:\Users\ayoub\loom\loom\go` directory and `loom/go` branch are absent. This review does not recreate them.

## Verdict

I would use this CLI for supervised task dispatch with a single writer per agent pane. Eight task submissions across guihelper, overlayv3 and Screenshot Studio returned the correct pane ID and a receipt. I found no observed duplicate submission, wrong-pane delivery or confirmed lost prompt in those sessions.

I would keep operator checks around unattended use. Plain terminal text cannot reliably tell me whether visible wording is editable input or a suggestion. Receipts identify an agent turn but do not retain the submitted text or prove the requested job succeeded. The worktree deletion guard excludes ignored files. These limits matter more in actual operation than adding more command aliases.

This is a retrospective review of the control sessions and the current implementation. Findings below distinguish a confirmed protection limit, observed API gaps and caller mistakes. It does not claim to repeat every earlier static review or to validate every current CLI command.

## Priority findings

### P2: Worktree deletion protection excludes ignored files

Classification: confirmed protection limit, reproduced with the current function in an isolated mock. No unintended loss occurred in the recorded deletion.

Evidence: `src/main.ts:4103` through `4116` checks `git status --porcelain=v1 -z -uall` and commits unique to the branch. That status command omits ignored files. `src/main.ts:6802` through `6807` therefore permits deletion without CLI `--force` when those two checks are clear. The removal itself calls `git worktree remove --force` at `src/main.ts:4158` and, for branch deletion, `git branch -D` at `4165`. Its internal force argument also skips the GUI confirmation.

The actual go worktree had 19,113 ignored files. After explicit user approval, `close-thread mupi1lp3-25 --yes --delete branch` succeeded without a CLI `--force` flag. The recorded preflight showed identical main and go HEADs and the ignored-file count. The subsequent verification confirmed the directory, Git worktree metadata and branch were gone. Other pane identities, refs and the nine retained review reports were unchanged.

Minimal reproduction: give the actual `atRisk` function a mocked clean status and zero unique commits. It returns an empty warning even if an external inventory contains ignored files. The check makes no ignored-file query. No worktree was created or removed to run this test.

Impact: an ignored file can be the only copy of user data. The documented promise that work which would be lost requires `--force` is broader than the implementation. In this session, the files were expected build and dependency output and deletion was authorized. That does not make the guard complete.

Smallest useful change: narrow the documentation immediately to the exact protection provided. Add a read-only deletion plan with the exact thread ID, pane IDs, worktree path, branch, tracked and untracked changes, unique commits and ignored-file counts. Define an explicit policy for ignored files before offering a stronger loss-protection guarantee. A plan token or revision check should refuse deletion if the target or protected state changed after approval. Report partial cleanup separately when panes close but filesystem or branch deletion fails.

Acceptance tests: a clean tree containing an ignored non-build file must appear in the plan. The chosen policy must require explicit authorization before discarding it. A changed thread or worktree after planning must fail before cleanup. A mocked deletion failure must identify which steps completed. Do not test this against a user's worktree.

### P2: CLI output cannot distinguish a suggestion from editable draft text

Classification: observed usability gap with a confirmed missing API guard. The initial interpretation and some unnecessary approval requests were my own conservative handling.

Evidence: `src/main.ts:3023` through `3032` uses xterm `translateToString` to read the screen. `read` at `6465` through `6485` returns only `pane`, `ref` and `text`. It discards cell styling and exposes no cursor, selection or draft metadata. `paneData` at `6291` through `6296` provides process and activity information but no input kind or draft revision. `send` at `6646` through `6652` pastes into the current input without an expected-input check.

During guihelper control, the screen showed `fix the sign-up form fields too`. I treated it as a possible unsent draft. The acknowledged End, Backspace, Ctrl-E and Ctrl-U attempts left the displayed text unchanged. This does not establish failed key delivery. After approval, typing a single `W` made the old wording disappear and left only `W`, which is consistent with a suggestion that typing dismisses.

Screenshot Studio showed `format those four spots`, then later `read CODE_REVIEW_2026-10-01 latest file and fix what have to be fixed`. Both records show authorized replacement, `ClearKey: null`, only my input verified before submission and no old text appended. Again, the first character dismissed the displayed wording. These sessions do not prove that a genuine user draft was deleted.

Minimal reproduction: run the actual `liveScreen` and CLI `read` functions against fake xterm rows with identical text but different dim attributes. The JSON is identical and no cell attributes are read. A text-only consumer cannot recover that missing distinction.

Impact: a headless caller either delays for unnecessary approvals or risks appending to a real draft. `idle` and `menu: null` do not establish an empty, editable composer. Splitting a send into a one-character preview and a later remainder worked here, but the two calls release the input queue between them. They are not an atomic replacement operation against another CLI writer or human typing. No such race was observed.

Smallest useful change: expose cursor and cell attributes through a structured read option. Add provider-specific input metadata only where it can be supported, with explicit `unknown` when it cannot. A guarded submission or authorized replacement should validate an expected input revision inside the same queued operation that pastes and submits. Generation checks remain necessary but do not detect edits within the same process generation.

Acceptance tests: a ghost suggestion and a real draft with the same visible text must be distinguishable when the provider supports it, or return `unknown`. A real draft must survive an unapproved replacement. An approved replacement must not append old text. An intervening writer must invalidate the expected revision before any typing. Test both the one-call path and the preview workflow.

### P2: Receipts cannot audit the submitted text after the terminal view changes

Classification: observed visibility gap and a confirmed receipt-schema limit. No prompt-loss defect was established.

Evidence: receipt `0512e22855924d79` accepted the Screenshot Studio formatting request at 15:21:45 UTC. Later read-back still showed formatting-related activity but not the full prompt, filename or safety boundaries. Receipt `30b2f33146b34647` accepted the commit, build and relaunch request at 15:44:13 UTC. At 15:46:05, read-back showed Claude checking commit identity and comparing installed and built executables, while the complete submitted instructions were absent. Neither task was resent.

`src/main.ts:3400` stores pane, reference, generation, turn and outcome information. It stores no submitted text, digest, request key or delivery-stage metadata. `send` returns only pane and receipt at `6658`. `waitReceipt` at `6389` through `6395` reports an agent turn and current numbered-menu status, or a shell exit result. It has no task-success assertion or output snapshot. The keyed cache at `6908` through `6933` retains a private command identity and response, but the CLI has no query to retrieve that identity for audit.

Minimal reproduction: invoke the actual CLI `send` function with mocked delivery. The exact text reaches the mock, but the returned data is only pane and receipt, and the stored agent receipt contains no text or digest. Set its turn result and invoke the actual `waitReceipt`; it returns `done`, `turn` and `asking`, without a semantic job result. This is consistent with the documented contract.

Impact: after a TUI redraw or collapsed paste, I cannot independently recover the full task from Loom. My own saved dispatch record remains necessary. A caller who mistakes missing screen text for failed delivery may send twice. A caller who treats `done: true` as completed work may skip outcome verification.

Smallest useful change: add a queryable request or receipt record containing pane ID, generation, request key, UTF-8 payload digest, accepted time and delivery stage. State clearly which fields describe what Loom wrote and which describe what the agent actually acknowledged. Full payload retention should be optional and bounded because prompts may contain secrets. Durable storage across app restarts needs a separate policy. Even a digest-only receipt plus a caller-side saved prompt would make audit less fragile.

Acceptance tests: a long collapsed paste must retain the submitted digest after screen redraw. Newlines, tabs and non-ASCII text must produce the expected digest. A repeated key must resolve to the original record without a second submission. Querying after restart or eviction must return an explicit unavailable result. Agent completion must remain distinct from verified job success.

## What the sessions established

### Discovery and targeting worked when I used exact identities

The installed CLI was `C:\Users\ayoub\AppData\Local\Loom\loomctl.exe`. The control sessions identified Loom PID 20088, version 3.0.0 and protocol 3, then pinned `\\.\pipe\loom-ayoub-pid20088` through an ephemeral `LOOM_PIPE` value. Each task checked the project directory, thread ID, pane ID, Claude provider and generation 1 before input. I did not use the front-pane alias as a durable target.

| Project | Thread ID | Claude pane ID |
| --- | --- | --- |
| guihelper | `mupi1lrx-37` | `mupi1lsc-39` |
| overlayv3 | `mupi1lqh-31` | `mupi1lqh-32` |
| Screenshot Studio | `mupi1lr5-34` | `mupi1lr6-35` |

The source supports this pattern. `cliThread` checks stable IDs before names at `src/main.ts:6315`. It refuses ambiguous names at `6322`. `cliPane` locates a stable pane ID at `6339`. Names, numeric positions and current-pane aliases can still select a different target after user navigation or pane removal, so automated callers should keep using IDs.

The CLI cannot list every running Loom instance. This is documented at `docs/loomctl.md:397`. External process discovery was needed to choose an instance before pinning its pipe. A future `instances --json` command would reduce that setup step. No wrong-instance event was observed.

### All eight task submissions returned receipts

| Task | UTC | Receipt | Read-back evidence |
| --- | --- | --- | --- |
| guihelper first fixes | 12:54:49 | `4cbfb2f2358541a3` | Review reference and instructions visible |
| overlayv3 first fixes | 13:25:20 | `2a6f883a1a084f7b` | Full normalized prompt verified |
| Screenshot Studio first fixes | 13:28:45 | `62d815ab97e64b8d` | Full normalized prompt verified |
| overlayv3 latest verification | 14:16:39 | `2825ce47d945409b` | Full prompt verified |
| Screenshot Studio latest verification | 14:16:39 | `3a1b8256344c4c6a` | Full prompt verified |
| guihelper whitespace fix | 14:21:46 | `59fcdda2c8ef41de` | Full normalized prompt verified |
| Screenshot Studio formatting | 15:21:45 | `0512e22855924d79` | Accepted receipt, related work visible, full prompt unavailable |
| Screenshot Studio commit/build/relaunch | 15:44:13 | `30b2f33146b34647` | Accepted receipt, related work visible, full prompt unavailable |

Each submission returned exit 0 and the expected pane ID. Unique request keys were used. No task submission retry was performed. This supports successful dispatch, not a claim that every task's final result was independently verified.

### Delivery, idempotency and completion are different checks

Normal `send` holds one input queue through paste, settling and Enter at `src/main.ts:3358` through `3388`. The isolated checks confirmed ordering and refusal of a stale generation. The actual keyed handler at `6911` through `6934` ran concurrent requests with the same key once and refused changed text or cwd. These protections worked in the narrow tests.

The echo check deliberately accepts the beginning or end of a long paste or an increased collapsed-paste placeholder count. See `src/prompt.ts:77` through `92` and `docs/loomctl.md:184` through `191`. That is a delivery heuristic, not an exact reconstruction of every byte accepted by the provider. My whole-prompt read-back expectations were stronger than this contract.

`wait --receipt 30b2f33146b34647` later returned `done: true`, turn 4 and `asking: false`. I read the final agent answer and independently checked the resulting Screenshot Studio commit, clean tracked status, build logs and installed process. The commit was `95944864e3426cf0c2cd6994dc0d46747690f68b`. The installed executable matched the release executable after the expected three-byte NSIS marker adjustment, and one running installed instance was identified. Those checks established the result more reliably than the receipt alone.

That final verification came from earlier read-only tool output. The retained dispatch JSON files were written before completion and still say completion was not verified. Do not read those earlier fields as the final task outcome. I did not repeat the build, restart the app or operate capture and clipboard controls for this report.

Claude stopped the prior Screenshot Studio process rather than using a graceful quit path. That concerns the delegated app-replacement workflow and its authorization handling. It is not evidence of a Loom CLI delivery defect.

### States and menus need careful interpretation

For Claude, `src/main.ts:1983` through `1988` marks output activity busy and clears it after 1.5 seconds of quiet. The isolated mock confirmed this timer can produce idle without a completion event. Actual turns use agent signals. The initial guihelper submission briefly looked idle before work appeared. No prolonged quiet-running failure was observed, so I am not adding a new completion bug from that possibility.

`menu` intentionally recognizes numbered questions. The overlayv3 folder-trust screen had unnumbered choices and returned no menu. I stopped, obtained authorization for that exact folder, selected the trust choice with Down, checked the highlighted choice, then pressed Enter once. `docs/loomctl.md:250` documents this limitation. A null menu is not proof that there is no question.

Agent receipts use the next turn and can settle multiple submissions together. The isolated mock confirmed this documented behavior. Use one active task owner per agent pane. An agent receipt says the agent finished or asked; it cannot determine whether the requested change passed tests or stayed within scope. Shell receipts have separate command correlation, but that path was not exercised end to end in these sessions.

### Permission boundaries worked, but do not grant task authorization

The sandbox account initially received Windows access denied when opening the pipe. The authorized host account could access it. I did not change ACLs or security settings to make this work. Current source rejects remote named-pipe clients at `src-tauri/src/control.rs:56`, restricts access to the current Windows SID and LocalSystem at `81`, and checks the protocol before dispatch at `96` through `119`.

This is an account boundary. It does not isolate individual agents running as the same user. A prompt saying "do not commit" is an instruction for Claude, not a permission that Loom enforces. Raw terminal output may contain secrets and should be treated as data. Optional prompt or output retention must respect that same account scope and define its lifetime.

The trust decision, draft replacement and worktree deletion each involved user authorization. The deletion's recorded verification was particularly useful: 26 other pane identities and the nine main review reports survived unchanged. No live controls were used during this retrospective review.

## Changes I would make to the caller first

1. Set PowerShell native input and output to UTF-8 for each control script, and read task files explicitly as UTF-8. Prefer stdin for long exact text. Encoding conversion can create false read-back mismatches; it is not a Rust JSON defect.
2. Pin the process pipe, require exactly one matching project and provider, retain pane ID and generation, and stop on ambiguity. Replace the documentation example's `Select-Object -First 1` at `docs/loomctl.md:366` with a uniqueness check for reliable automation.
3. Treat visible composer wording as unknown until there is better metadata. Ask only when a real destructive replacement decision remains. Do not assume Ctrl-U or Backspace proves the input is empty, and do not use Ctrl-C as a generic clearing action.
4. Save the prompt, key and returned receipt locally before waiting. After an accepted send, use the receipt and read the result. Missing prompt text in later output is not a reason to resend.
5. Retry only with the same key and identical command against the same verified instance. The cache retains the last 256 settled keys and receipts retain the last 500 settled outcomes. Both are in memory. After eviction or restart, rediscover and inspect before deciding whether a new send is safe. A timeout stops waiting, not the running operation.
6. Verify outcomes through the agent answer and relevant artifacts or read-only checks. Keep permission questions visible while waiting for a receipt. Do not equate `idle`, `asking: false` or `done: true` with a successful requested job.

## Tests and limits

All checks below used copied pure helpers or selected current function bodies in isolated mocks. They did not import app startup, open a pipe, write to a PTY, invoke a project hook, create a worktree or run a deletion.

| Check | Result |
| --- | --- |
| Node 24.18.0, copied current `cli.test.ts` | 52 passed, 0 failed |
| Copied current `prompt.test.ts` | 30 passed, 0 failed |
| Current-source operator mocks | 7 passed, 0 failed |
| Hash comparison of 131 tracked and 10 existing untracked files | 141 unchanged before report save |
| Read-only Git recheck | Same main branch, HEAD, refs, worktree registry and existing status |

The seven operator mocks covered plain-text styling loss, ignored-file omission, receipt metadata and turn results, multiple agent receipts sharing a turn, concurrent key replay and mismatch refusal, queued input and stale generation, and Claude's idle timer.

Not run: full Rust or frontend builds, GUI tests, live PTY delivery, provider upgrades, disconnected-pipe or process-restart fault injection, actual concurrent human editing, shell exit-code integration, stop/restart/add workflows, destructive cleanup tests or a fresh app replacement. The recorded live sessions involved Claude; Codex and OpenCode were inspected only through source and helper fixtures. No claim is made about all providers or all malformed transport messages.

No settings, Git trust, repository configuration, source files, commits or running applications were changed for this review. The report is a new untracked file on the existing main checkout, not a commit on main. The pre-existing Cargo file status and ten untracked benchmark/study files are preserved. Final read-back, strict UTF-8 decoding and preservation checks accompany the saved report.

## Evidence locations

The records live under `C:\Users\ayoub\Documents\Codex\2026-09-30\task-3`. They are local review evidence, not files committed to Loom.

| Evidence | Files |
| --- | --- |
| Main snapshot and protected-file hashes | `loom-cli-experience-review-snapshot.json` |
| First task submissions | `guihelper-review-dispatch.json`, `overlayv3-review-dispatch.json`, `screenshot-studio-review-dispatch.json` |
| First full-prompt verification | `overlayv3-review-dispatch-verification.json`, `screenshot-studio-review-dispatch-verification.json` |
| Latest review submissions | `overlayv3-review-135109-dispatch.json`, `screenshot-studio-review-134205-dispatch.json`, `guihelper-review-133405-dispatch.json` |
| guihelper normalized echo | `guihelper-review-133405-dispatch-verification.json` |
| Formatting receipt and read-back | `screenshot-studio-formatting-dispatch-20261001T152145.json`, corresponding `-verification.json` |
| Commit/build/relaunch receipt and read-back | `screenshot-studio-commit-build-relaunch-dispatch-20261001T154413.json`, corresponding `-verification.json` |
| Exact folder-trust approval | `overlayv3-trust-action.json` |
| Authorized go deletion and preservation | `loom-go-delete-preflight.json`, `loom-go-delete-result.json`, `loom-go-delete-verification.json` |
| Isolated checks | `loom-cli-operator-checks.mjs`, `loom-cli-operator-tests\cli-test.log`, `prompt-test.log`, `operator-checks.log` |

Review methods follow the global `AGENTS.md`, the local Unslop writing skill and Windows PowerShell guidance. The Library skill routes this explicit local Markdown destination to filesystem tools. No Library copy or external publication was requested or created.
