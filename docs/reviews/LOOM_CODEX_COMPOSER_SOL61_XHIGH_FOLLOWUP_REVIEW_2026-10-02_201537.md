# Loom Codex composer follow-up review

Saved: 2026-10-02T20:15:37.815Z.

## Findings

No findings.

The P1 in `docs/reviews/LOOM_CODEX_COMPOSER_SOL61_XHIGH_REVIEW_2026-10-02_190826.md` is fixed in the captured root checkout. The original leading-blank draft now reads as a draft with its full visible text. Both `send --replace` and `submit` refuse it before any paste or Enter. I found no actionable regression introduced by this parser fix in the reviewed changes or isolated checks.

## Previous finding disposition

The former scan stopped at the first blank row below the cursor. The current code at `src/prompt.ts:172-179` finds the blank separator above the final status block by scanning from the bottom, then validates all composer rows between the prompt and that separator. Internal blank rows remain part of the draft, including rows above and below the cursor. `src/prompt.ts:194` also returns unknown for a composer that is blank without a placeholder. Codex no longer returns empty.

I reran the exact reader reproduction against both the prior reviewed source copy and the current captured source. With plain cells and cursor `{ x: 2, y: 0, hidden: false }`:

```js
const rows = ["\u203a ", "", "  third line", "", "  model status"];
// Prior reviewed source: { kind: "empty", text: "" }
// Current source:        { kind: "draft", text: "\n\nthird line" }
```

The escape in that example is Codex's U+203A prompt glyph, not ASCII greater-than.

The current production bundle was served to fresh headless Chrome contexts and tested through real xterm cells and hardware cursor coordinates. Six draft forms at all their visible row positions produced 19 cases and 38 guarded command calls. They cover a blank first line, internal blanks, wrapped continuation rows, trailing blank rows, plain placeholder-like words on a later line and a colored pasted-content block below blanks. Every call refused with `typed: false`, wrote nothing, submitted no prompt and retained the original draft.

| Case | Current reader and command result |
| --- | --- |
| Original `\n\nthird line`, cursor on its first, blank or last row | Full draft; both guarded commands refuse |
| First line, internal blank, third line; cursor above, on or below the blank | Full draft; both guarded commands refuse |
| Wrapped rows followed by a blank and more text | Full draft; both guarded commands refuse |
| Plain `Ask Codex to do anything` | Draft; replacement refuses |
| Plain placeholder-like words or colored pasted block below blanks | Draft; both guarded commands refuse |
| Blank composer or dim words after a blank first line | Unknown; replacement refuses |
| Numbered approval | Unknown input; both guarded commands refuse |
| Actual dim placeholder, visible cursor in front | Suggestion; each guarded command delivers one paste and one Enter |
| Hidden Codex cursor | Unknown; replacement refuses; submit retains its documented unknown-input behavior |

Submit intentionally still permits unknown input outside a numbered question. That policy is unchanged. A successful hidden-cursor submit records `input: "unknown"`; it does not claim the input was empty. The P1 disposition concerns the known draft that previously passed as empty.

## Scope and source comparison

Target: root `C:\Users\ayoub\Videos\claude\loom`, branch main. This review did not target the old task-tracking worktree.

Captured at `2026-10-02T19:56:53.886Z`. HEAD `89f492b69bd89eced7adbdcadf5509d111f9aeb9`, 63 commits ahead of origin/main, no staged changes.

I inspected the complete current working diff for the Codex composer changes and the parser fix against the source snapshot used for the prior report. Since that review, the changed files are `src/prompt.ts`, `src/prompt.test.ts`, `scripts/task-check.mjs`, `scripts/ui-check.mjs` and `docs/loomctl.md`. Their comparison diffs are saved alongside this review's evidence. The original Codex integration in `src/main.ts` and the fixture were also inspected in the full HEAD diff.

Direct SHA-256 comparisons with the prior review show no intervening changes to `src/main.ts`, `src/task.ts`, `src/cli.ts`, `src/gitparse.ts`, `src/fixtures/codex-composer.json`, `src-tauri/src/lib.rs` or `src-tauri/src/helper.rs`. The semantic scope excludes the pre-existing dirty `src-tauri/Cargo.toml` and concurrent work elsewhere. Cargo.toml remains part of the preservation inventory.

I read `C:\Users\ayoub\AGENTS.md`, `C:\Users\ayoub\.codex\skills\.system\review-agent\SKILL.md` and the required `C:\Users\ayoub\.agents\skills\unslop\SKILL.md`. The ancestor and project scan found no further applicable AGENTS.md or local .agents/.codex instructions, excluding Git, dependency and generated directories. The report is the only authorized write to the root checkout.

Requested review lane: Sol6.1 Extra High. The available tools do not independently attest the running model or reasoning setting, so this report does not certify those settings.

## Test quality and adjacent behavior

The new reader tests at `src/prompt.test.ts:258-277` cover the prior reproduction, cursor movement across internal blanks, leading blank rows, a wrapped line followed by a blank and more text, placeholder-like draft text, a pasted block after blanks, missing status lines and approval content. The task test can now replay an explicit Codex screen using `codexRaw`; it no longer has to collapse every multiline input for this regression. It checks both guarded commands with the cursor on the first and last draft rows. The UI test adds the same leading-blank case. Existing assertions were retained in the fix diff.

The independent reader matrix adds 41 recorded cases, with padding and extra trailing screen rows checked for each draft cursor case. Missing or hidden cursor, a cursor under the prompt glyph or in the footer, unindented content, mixed dim/plain cells and inverse content stay unknown in the checked forms. The three stored raw Codex frames still replay as the expected placeholder, single-line draft and wrapped draft, with their exact captured cursor coordinates.

Claude's reader body is unchanged. Three separate built-frontend cases verified its U+00A0 prompt separator with a hidden hardware cursor: a typed draft blocks both commands, and a dim suggestion permits each command to submit once. Its unit coverage also passes.

The input generation, revision and write counters remain in the same code paths. In two additional checks using a known Codex placeholder, typing through the window while the task reservation was held blocked the paste, and typing while the paste write was pending blocked Enter. The latter left the combined text in the input without submission. No counter or guard was bypassed.

All 18 independent lifecycle cases passed. Earlier matching turns cannot finalize an accepted task while its paste or Enter is pending. Failed or lost Enter replies retain submit uncertainty and end unknown after later matching reports, including actual fake delivery followed by a lost reply. Successful delivery still completes. Queued submissions keep prompts separate, journal failure exposes only durable events, recovery preserves the unknown outcome, and reload/key replay does not type again.

Ignored-file deletion code and Git parsing code were unchanged from the prior review. The 46 Git parsing/loss-inventory unit checks passed. No deletion, installation or live ignored-file mutation was performed.

## Independent checks

| Check | Result |
| --- | --- |
| Prompt/input units | 93 passed |
| CLI units | 64 passed |
| Git parsing/loss-inventory units | 46 passed |
| Task units | 99 passed |
| Total units | 302 passed |
| TypeScript `tsc --noEmit` | Passed |
| Production Vite build of the captured source | Passed; standard large-chunk warning |
| Full current task browser suite | 39 passed; real-time quiet cases enabled |
| Independent reader matrix and prior/current comparison | 41 recorded cases passed |
| Captured raw Codex terminal frames | All three matched expected input and cursor |
| Independent visible multiline draft guard checks | 19 cursor/form cases, 38 calls refused without writing |
| Independent composer ambiguity and positive-send checks | Passed |
| Claude U+00A0 built-frontend checks | Three passed |
| Known Codex placeholder with competing window writer | Two passed |
| Pending paste/Enter lifecycle checks | Four passed |
| Buffered/queued-write and journal recovery checks | Five passed |
| Delivery-outcome matrix across Claude, Codex and OpenCode | Nine passed |

The browser checks used the freshly built served bundle over Tauri mocks, not a substituted application reader. The preview returned HTTP 200 before execution. The full task suite supplied a freshly compiled wrapper around the exact captured root Claude hook and supporting root lookup functions. It used the existing Rust compiler and read-only cached serde_json build artifacts; all outputs and event data were reviewer-owned. This is native helper integration coverage, not a full Rust or Tauri test pass.

Evidence directory: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-root-codex-review-20261002T195644Z`.

Evidence includes `prior-comparison.json`, `comparison-*.diff`, the unit/build logs and result JSON, `review-codex-followup-pure.json`, `review-codex-followup-browser.json`, `review-claude-input-browser.json`, `review-codex-counter-browser.json`, `review-pending-enter-fixed.json`, `review-buffer-adjacent.json` and `review-outcome-matrix.json`. Their runners are retained there.

## Limits and execution corrections

No live Loom pane, real Codex approval or manual Codex editing sequence was exercised. The prior P1 and its current guards are deterministic in the reader and isolated production frontend. Actual composer screens were covered by the three stored raw frames. The bottom status boundary is still inferred from the final contiguous nonblank block; this review does not establish behavior for every unfamiliar or partially redrawn Codex screen.

The full UI suite, all-width screenshots, memory-pressure/focus runs, mutation checks and full Cargo/Tauri tests were not rerun. The focused browser contexts were 1280x900. No responsive-layout claim is made.

The default sandbox initially blocked esbuild's ancestor-directory lookup. The same isolated build passed after an approved execution escalation; `build-sandbox-blocked.log` retains the initial failure. The first reviewer-written pure matrix used ASCII greater-than instead of Codex's U+203A glyph and correctly got unknown. I corrected the reviewer fixtures to use the actual glyph, then the matrix and browser checks passed. Neither correction changed source or repository tests.

Git warned that the sandbox could not read the global ignore file. The same read-only Git commands and direct hashes were used for capture and preservation. No Git configuration, trust or security setting was changed.

## Preservation and report readback

All 160 captured pre-existing nonignored project files matched their original hashes before saving. This includes all 23 prior reports, user documentation and the dirty Cargo.toml. Cargo.toml's SHA-256 remains `0bdc9257769e5b3af44e15a5d8113fa5c0b1b26d731a00a0583160d5877e4b6f`.

All 19 captured Git metadata files matched, including index, HEAD, refs, logs, packed refs and repository configuration. Branch/HEAD, working diff and staged diff also matched. Builds and tests ran only in the isolated source copy. Root ignored dependency/build trees were read or copied, not built into; they did not receive a full before/after hash inventory.

The report is created exclusively under root `docs/reviews` with a fresh timestamp. The save procedure checks preservation immediately before and after, requires the new report to be the only project/status addition, and verifies strict UTF-8 readback without a BOM against an identical evidence copy. `saved-report.json`, `report-verification.json` and `final-readback.json` record the final path, byte count, SHA-256 and preservation results. Prior reports are not overwritten.

The reviewer-owned Node preview was stopped after its PID, executable and script identity were checked, and its port then refused connections. Cleanup evidence is retained. No live Loom process was stopped. No source fix, commit, merge, installer build, install, live-pane command or notification implementation was made.
