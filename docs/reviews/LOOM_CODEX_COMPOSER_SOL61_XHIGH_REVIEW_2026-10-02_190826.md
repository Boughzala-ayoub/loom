# Loom Codex composer review

Saved: 2026-10-02T19:08:26.863Z UTC.

One P1. The captured Codex placeholder, single-line draft and wrapped draft now read correctly, so the former unconditional unknown behavior is fixed for those forms. The composer reader is not yet safe for a multiline draft with blank rows below the cursor. It can report empty and permit a guarded paste plus Enter into an existing draft.

## Findings

### 1. [P1] Read the entire Codex composer before calling it empty

Location: `src/prompt.ts:172-176`, the forward scan ending at the first blank row below the cursor. The false empty result is returned at `src/prompt.ts:189` and consumed by the guarded-send check at `src/main.ts:7021`.

When a user moves the hardware cursor to the first line of a multiline draft, a blank line below the cursor can be part of the input rather than its footer separator. This scan treats that first blank as the composer's end and ignores later draft text. If the first line is also empty, the reader returns `kind: empty`. I reproduced both `send --replace` and `submit` accepting that false reading in the isolated production frontend, pasting `new task` and pressing Enter with the existing `third line` still in the input. The delivered prompt is `new task\n\nthird line`, not just the requested text.

Before this change, Codex's input was unknown and `send --replace` refused it. This introduces a concrete loss of that guard. Submit already allowed unknown input before the change, but its new known-draft protection also fails in this case, and the task falsely records its starting input as empty.

The case uses Codex's documented shape: a first row beginning with `› `, continuation rows indented by two columns, a visible hardware cursor, and a blank row before the status lines. No mixed styles, missing cursor, question or concurrent writer is needed. The new unit test already accepts a blank line inside a draft when the cursor is on its last line. Moving the cursor above that blank exposes the omitted suffix; two leading blank lines make the result falsely empty.

Minimal reader reproduction, with plain cells and cursor `{ x: 2, y: 0, hidden: false }`:

```js
const rows = ["› ", "", "  third line", "", "  model status"];
// Current result: { kind: "empty", text: "" }
// Cursor on row 2 instead: { kind: "draft", text: "\n\nthird line" }
```

The same content with the cursor on its last row is read as a draft and both guarded commands refuse before writing. That control isolates cursor placement and the blank-row boundary as the cause.

| Current built frontend case | Input reported | Writes | Result |
| --- | --- | --- | --- |
| Cursor on first empty row, `send --replace` | empty | One paste and one Enter | Accepted; combined prompt sent |
| Cursor on first empty row, `submit` | empty | One paste and one Enter | Accepted; combined prompt sent; task input is empty |
| Same draft, cursor on last row, `send --replace` | draft | None | Refused; draft retained |
| Same draft, cursor on last row, `submit` | draft | None | Refused; draft retained |

Evidence is in `review-codex-pure.json`, `review-codex-browser.json` and their `.mjs` runners in the isolated evidence directory below. The pure comparison imports the captured HEAD version as well, which returns unknown for the same Codex cells. The frontend reproduction uses real xterm cells, Loom's current inputState/sendText paths, a correctly positioned visible cursor, and a fake native handler that inserts the paste at that cursor. It sends no input to a real pane or provider.

Required invariant: classify an input as empty or suggestion only after establishing the full composer boundary. Read through internal blank rows, or return unknown when the boundary is ambiguous. Add a cursor-above-blank variant and a leading-blank draft to the reader and guarded-send tests. No source fix was applied.

## Scope and preservation baseline

Target: `C:\Users\ayoub\Videos\claude\loom`, the root main checkout. The old task-tracking worktree was not the review target.

Capture: `2026-10-02T18:43:48.172Z`. HEAD `89f492b69bd89eced7adbdcadf5509d111f9aeb9`, branch main, 63 commits ahead of origin/main. There were no staged changes.

Reviewed Codex changes: `src/prompt.ts`, `src/main.ts`, `src/prompt.test.ts`, `src/fixtures/codex-composer.json`, `scripts/task-check.mjs`, `scripts/ui-check.mjs` and `docs/loomctl.md`. I inspected the actual diff and the surrounding input, guard, echo, write-counter and task paths. I also checked the fixture's serialized screens and replayed its three stored raw terminal frames through the built frontend.

The pre-existing dirty `src-tauri/Cargo.toml` was included in preservation hashes and left untouched. Its captured SHA-256 is `0bdc9257769e5b3af44e15a5d8113fa5c0b1b26d731a00a0583160d5877e4b6f`. It is outside this review's semantic scope. Existing untracked documentation and reports were preserved. The concurrent event-bridge work elsewhere was neither reviewed nor changed.

Evidence and isolated source copy: `C:\Users\ayoub\Documents\Codex\2026-10-01\task-3\loom-root-codex-review-20261002T184338Z`.

I read the applicable `C:\Users\ayoub\AGENTS.md`, the local review-agent skill and the required Unslop skill. The target-path/project scan found no additional AGENTS.md or local .agents/.codex instructions, excluding Git, dependency and generated trees. The user's authorization covers this new report; no source changes or Git writes were made.

Requested lane: Sol6.1 Extra High. The available tools provide no independent runtime-model or reasoning-setting attestation, so this report does not certify those settings.

## Prior issue and test quality

The unconditional Codex unknown result is replaced with a reader that checks the hardware cursor, numbered menus, composer indentation and cell styles. The stored raw empty, draft and wrapped frames produce the expected suggestion/draft values and the exact captured cursor coordinates through real xterm. The styled-cell checks also cover cleared input, colored collapsed paste, hidden/missing/misplaced cursors, mixed styles, inverse text, transcript prompts and numbered choices. Claude's existing reader body is retained, and its tests still pass when cursor metadata is supplied or ignored.

The safety issue is in the new forward boundary detection, not in an intentional relaxation of the guard itself. inputState still hashes draft text and uses the existing generation/input counter; sendText still rejects known drafts and refuses unknown input for `send --replace`. A false empty result bypasses those checks. The counter protections catch another writer arriving during a send, but cannot correct a draft that was already present and misread before the paste.

The repository tests miss the failing form:

- `src/prompt.test.ts:270-271` tests a blank line inside a draft only with the cursor on the last line. The forward scan never crosses that internal blank in this test.
- The task fixture always collapses an input containing a newline to a pasted-content label. It therefore cannot represent a manually edited multiline draft with visible internal blank rows.
- The new UI replay tests use the three stored raw frames: placeholder, plain single-line draft and wrapped draft. None has an internal blank below the cursor.

Existing assertions were retained in the reviewed test diff; I found no separate weakening of the other guards. The claimed eight mutation checks were not independently rerun because no mutation runner was part of the reviewed files. Passing those checks would not replace the missing cursor/boundary case demonstrated here.

## Independent validation

| Check | Result |
| --- | --- |
| Prompt/input unit checks | 81 passed |
| CLI unit checks | 64 passed |
| Git parsing/loss-inventory unit checks | 46 passed |
| Task unit checks | 99 passed |
| Total unit checks | 290 passed |
| TypeScript `tsc --noEmit` | Passed |
| Isolated production Vite build | Passed, with the standard large-chunk warning |
| Full current task browser suite | 39 passed, with real-time quiet cases enabled and the captured native hook supplied |
| Independent pending paste/Enter cases | Four passed for Claude/Codex, including journal, reload and keyed replay |
| Independent buffered/queued-write cases | Five passed, including separate queued prompts, lost Enter replies for three providers, and journal recovery |
| Independent delivery-outcome matrix | Nine passed for Claude, Codex and OpenCode |
| Raw Codex fixture replay through the built frontend | All three stored raw frames matched expected input and cursor values |
| New guard reproduction/control cases | Two defect cases reproduced; two controls refused without writing |
| Pure reader and HEAD comparison | False empty reproduced; last-row cursor reads draft; HEAD reads unknown |

The 18 independent lifecycle cases preserve the prior pending-write fix and delivery uncertainty. A failed Enter remains uncertain after a later matching turn and ends unknown; a successful delivered submission still completes. A native reply lost after actual fake delivery does not prove submission. Journal failure exposes only durable watch events, recovery retains the unknown outcome, and replay does not type again. The full task suite also rechecks the prior Stop/approval buffering, generation and answer-uncertainty cases. No new lifecycle regression was found in those checks.

The browser tests execute the freshly built bundle over Tauri mocks, not source-only substitutes. The Claude hook wrapper was compiled from the captured root helper and exact supporting functions using the existing Rust compiler and cached serde_json dependency. It writes only reviewer-owned temporary event data. No installer was built, and no dependencies were installed.

All build/test artifacts went to the isolated copy. Structured results and logs include `*-result.json`, `*.log`, `review-codex-browser.json`, `review-codex-pure.json`, `review-pending-enter-fixed.json`, `review-buffer-adjacent.json` and `review-outcome-matrix.json`.

## Execution limits

The extra browser runner initially let the generic mock redraw its old Claude-like screen when replayed Codex output generated terminal replies. I disabled mock redraw during the read-only raw-frame replay. The fixture contains three raw frames and six styled snapshots; the runner was corrected to replay only the three existing raw frames. The independent queued-send runner also initially required the second task to remain submitted, although the normal screen sweep may already make it working. Its final assertion requires an open submitted/working task, screen correlation if working, and a subsequent matching end before completion. These reviewer-fixture corrections did not modify application code or repository tests.

The P1 reproduction is deterministic in the reader and isolated built frontend. The real Codex rendering/keystroke sequence for this leading-blank draft was not exercised, and no frequency claim is made. The geometry follows the reader's documented composer format and the multiline blank-row form already accepted by the new unit test.

No live Loom panes or input were read or modified. Real Codex approval dialogs and live application behavior remain untested. No commits, merges, source fixes, installer builds, installs or security/trust changes were made.

The full UI suite, screenshots at all widths and the author's reported memory-pressure/focus reruns were not independently repeated. The focused xterm/guard browser checks use a fresh 1280x900 context. This report makes no responsive-layout claim. The full Cargo/Tauri/native suite and the eight claimed mutations were not run. The native helper integration was run through the task suite; that is not a full Rust test pass.

Git warned that the sandbox could not read the global ignore file. The same read-only Git commands and direct hashes were used for the initial and final preservation checks. No Git configuration or ignore file was changed.

## Preservation and report readback

Before saving, all 159 captured pre-existing nonignored project files matched their original SHA-256 hashes, including all 22 prior reports and the dirty Cargo.toml. All 19 captured Git metadata files matched, including index, HEAD, refs, logs, packed refs and repository configuration. The working and staged diff hashes and branch/HEAD matched the capture; no project files had been added.

The report save uses exclusive creation with a fresh timestamp under root `docs/reviews`. The procedure repeats those checks before and after, reads the report back as strict UTF-8 without a BOM, verifies its hash against the isolated evidence copy, and requires the only project/status addition to be this report. `saved-report.json` and `report-verification.json` record its exact path, size, hash and preservation results. Earlier reports are not overwritten.

The reviewer-owned Node preview was stopped after verifying its PID, executable and script identity. Its port then refused connections. `preview-cleanup.json` and `preview-port-cleanup.json` record this. No live Loom process was stopped. Ignored dependency/build trees were read or copied for the isolated checks and did not receive a full before/after hash inventory.
