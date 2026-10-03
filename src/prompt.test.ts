// Self-check for readMenu / echoes. Run: node src/prompt.test.ts
import { readMenu, readInput, echoes, echoed, menuRev, claudeWorking, type Cell, type Cursor, type Menu } from "./prompt.ts";
import codexCapture from "./fixtures/codex-composer.json" with { type: "json" };

let fails = 0;
// The summary fields; `prompt` gets checks of its own.
const shape = (m: Menu | null) => m && { question: m.question, options: m.options, selected: m.selected, multi: m.multi };
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
  fails++;
}

const claude = `
● I'll clean the build folder first.

────────────────────────────────────────────────────────
 Bash command

   rm -rf build
   Remove the old build output

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in C:\\projects\\loom
   3. No, and tell Claude what to do differently (esc)

`;
check("Claude permission prompt", shape(readMenu(claude)), {
  question: ["Bash command", "rm -rf build", "Remove the old build output", "Do you want to proceed?"],
  options: ["Yes", "Yes, and don't ask again for rm commands in C:\\projects\\loom", "No, and tell Claude what to do differently (esc)"],
  selected: 0,
  multi: false,
});

const boxed = `
╭──────────────────────────────╮
│ Edit file                    │
│ Do you want to make this edit│
│   1. Yes                     │
│ ❯ 2. No (esc)                │
╰──────────────────────────────╯
`;
check("Boxed prompt, second option highlighted", shape(readMenu(boxed)), {
  question: ["Edit file", "Do you want to make this edit"], options: ["Yes", "No (esc)"], selected: 1, multi: false,
});

const codex = `
Would you like to run the following command?

  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;
check("Codex approval", readMenu(codex)?.options.length, 3);
check("Codex question", readMenu(codex)?.question, ["Would you like to run the following command?", "$ npm test"]);

const ask = `
 Which layout should the overview use?

 ❯ 1. Split view
      List on the left, terminal on the right.
   2. Modal
      Keep the current preview dialog.
   3. Type something.
`;
check("Options with descriptions", readMenu(ask)?.options, ["Split view", "Modal", "Type something."]);

// Claude Code 2.1's AskUserQuestion, rows as drawn (liveScreen(p, false)).
const claudeAsk = `
❯ Use the AskUserQuestion tool to ask me whether I prefer tea
  or coffee. Do nothing else.
──────────────────────────────────────────────────────────────
 ☐ Drink

Do you prefer tea or coffee?

❯ 1. Tea
     You prefer tea.
  2. Coffee
     You prefer coffee.
  3. Type something.
──────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
check("Claude AskUserQuestion", shape(readMenu(claudeAsk)), {
  question: ["☐ Drink", "Do you prefer tea or coffee?"], options: ["Tea", "Coffee", "Type something."], selected: 0, multi: false,
});

const multi = `
 Which checks should run?
 ❯ 1. [ ] Unit tests
   2. [x] UI check
`;
check("Multi-select is flagged", readMenu(multi)?.multi, true);

const input = `
● Done. I changed three things:
  1. Renamed the heading
  2. Removed the summary
  3. Disabled empty tabs

╭────────────────────────────────╮
│ > 1. also update the README    │
╰────────────────────────────────╯
  ? for shortcuts
`;
check("A numbered answer above the input box is not a menu", readMenu(input), null);
check("Codex composer text is not a menu", readMenu("› 1. fix the tests\n\n  100% context left"), null);
check("A cursor on a lone option is not a menu", readMenu("❯ 2. Something"), null);

check("Echo found once", echoes("│ > Yes, go ahead   │", "Yes, go ahead"), [1, 1, 0]);
check("Echo ignores wrapping", echoes("│ > Yes, go ahead and also │\n│ update the README │", "Yes, go ahead and also update the README"), [1, 1, 0]);
check("No echo", echoes("❯ 1. Yes", "no, do X instead"), [0, 0, 0]);
check("Empty text never echoes", echoes("anything [Pasted text #1]", "   "), [0, 0, 0]);
// A task taller than the screen: its start scrolled away, its end is at the cursor.
const task = ["TASK-HEADER unique", ...Array.from({ length: 50 }, (_, i) => `step ${i} of the task`)].join("\n");
const bottom = task.split("\n").slice(-24).join("\n");
check("A long paste echoes by its end", echoed(echoes("> ", task), echoes(bottom, task)), true);
check("Claude's collapsed paste echoes", echoed(echoes("> ", task), echoes("> [Pasted text #1 +50 lines]", task)), true);
check("Codex's collapsed paste echoes", echoed(echoes("› ", task), echoes("│ › [Pasted Content 1024 │\n│ chars]", task)), true);
check("A second collapsed paste still counts", echoed(echoes("[Pasted text #1 +50 lines]", task), echoes("[Pasted text #1 +50 lines][Pasted text #2 +50 lines]", task)), true);
check("A menu that ignored the paste doesn't", echoed(echoes("❯ 1. Yes\n  2. No", task), echoes("❯ 1. Yes\n  2. No", task)), false);

const readme = readMenu("Read README.md?\n❯ 1. Yes\n  2. No")!;
const wipe = readMenu("Delete the project?\n❯ 1. Yes\n  2. No")!;
check("Same options under another question are another menu", menuRev(readme) === menuRev(wipe), false);
check("Moving the highlight keeps the menu", menuRev(readme) === menuRev(readMenu("Read README.md?\n  1. Yes\n❯ 2. No")!), true);
check("A menu revision is 8 hex digits", /^[0-9a-f]{8}$/.test(menuRev(readme)), true);

// The revision covers the whole prompt, not just the summary.
check("The prompt runs from the divider to the last option", readMenu(claude)?.prompt, [
  "Bash command", "rm -rf build", "Remove the old build output", "Do you want to proceed?",
  "1. Yes", "2. Yes, and don't ask again for rm commands in C:\\projects\\loom", "3. No, and tell Claude what to do differently (esc)",
]);
check("AskUserQuestion's descriptions are in it, the next divider ends it", readMenu(claudeAsk)?.prompt, [
  "☐ Drink", "Do you prefer tea or coffee?", "1. Tea", "You prefer tea.", "2. Coffee", "You prefer coffee.", "3. Type something.",
]);
const folder = (path: string) => readMenu(`Which folder should be removed?
❯ 1. Build output
     ${path}
  2. Cancel

  Esc to cancel`)!;
check("A changed path under an option is another menu", menuRev(folder("C:\\project\\build")) === menuRev(folder("C:\\project\\src")), false);
check("The footer below a blank line is not part of it", folder("C:\\project\\build").prompt.includes("Esc to cancel"), false);
check("The path is part of the prompt", folder("C:\\project\\build").prompt, ["Which folder should be removed?", "1. Build output", "C:\\project\\build", "2. Cancel"]);
const command = (cmd: string) => readMenu(`──────
 Bash command

   ${cmd}
   Clean up
   Uses the shell
   Runs in the repo

 Do you want to proceed?
 ❯ 1. Yes
   2. No`)!;
check("Same last four question lines, another command", JSON.stringify(command("rm -rf build").question) === JSON.stringify(command("rm -rf src").question), true);
check("is another menu", menuRev(command("rm -rf build")) === menuRev(command("rm -rf src")), false);
const moved = readMenu(claude.replace(" ❯ 1. Yes", "   1. Yes").replace("   2. Yes, and", " ❯ 2. Yes, and"))!;
check("Moving the highlight keeps a long prompt's revision", [moved.selected, menuRev(moved) === menuRev(readMenu(claude)!)], [1, true]);

// readInput: Claude's input line, cell by cell. A run's style: d dim, i inverse, w wide (two cells).
const cells = (...runs: [string, string?][]): Cell[] => runs.flatMap(([t, s = ""]) => [...t].flatMap((ch) => {
  const c = { ch, dim: s.includes("d"), inverse: s.includes("i") };
  return s.includes("w") ? [c, { ...c, ch: "" }] : [c];
}));
const pad = (row: Cell[]) => [...row, ...cells([" ".repeat(Math.max(0, 60 - row.length))])];
const rule = "─".repeat(60);
// The screen around it: an earlier prompt in the transcript (no rule above), the
// input between two rules, then the shortcuts hint.
const claudeScreen = (...input: Cell[][]) => [
  cells(["> an earlier prompt in the transcript"]),
  cells(["● Done. The form validates now."]),
  cells([rule]),
  [...cells(["> "]), ...input[0]],
  ...input.slice(1).map((r) => [...cells(["  "]), ...r]),
  cells([rule]),
  cells(["  ? for shortcuts"]),
].map(pad);
const read = (...input: Cell[][]) => readInput(claudeScreen(...input), "claude");
const words = "fix the sign-up form fields too";
const ghost = read(cells([words[0], "i"], [words.slice(1), "d"]));
const typed = read(cells([words], [" ", "i"]));
check("A suggestion and a draft with the same words read apart", [ghost.kind, typed.kind, ghost.text, typed.text], ["suggestion", "draft", words, words]);
check("Unfocused, a suggestion is all dim", read(cells([words, "d"])), { kind: "suggestion", text: words });
check("Only the caret is an empty input", read(cells([" ", "i"])), { kind: "empty", text: "" });
check("No caret at all is empty too", read([]), { kind: "empty", text: "" });
check("One typed character is a draft", read(cells(["W"], [" ", "i"])), { kind: "draft", text: "W" });
check("The caret inside a draft is part of it", read(cells(["fix"], ["e", "i"], ["d"])), { kind: "draft", text: "fixed" });
check("A command's dim hint isn't part of the draft", read(cells(["/review"], [" [pr-number]", "d"])), { kind: "draft", text: "/review" });
check("One plain character before dim text could be either", read(cells(["f"], ["ix the form", "d"])).kind, "unknown");
check("Dim text before plain text isn't a known shape", read(cells(["old", "d"], ["new"])).kind, "unknown");
check("A draft over two rows", read(cells(["first line"]), cells(["second line"], [" ", "i"])), { kind: "draft", text: "first line\nsecond line" });
check("Wide characters count once", read(cells(["世界", "w"], [" ", "i"])), { kind: "draft", text: "世界" });
const boxedInput = ["╭" + "─".repeat(58) + "╮", "│ > draft text" + " ".repeat(45) + "│", "╰" + "─".repeat(58) + "╯"].map((l) => cells([l]));
check("Claude 1's boxed input", readInput(boxedInput, "claude"), { kind: "draft", text: "draft text" });
check("Bash mode's ! prompt", readInput([cells([rule]), cells(["! ls -la"]), cells([rule])].map(pad), "claude"), { kind: "draft", text: "ls -la" });
check("A menu instead of the input is unknown", readInput(claude.split("\n").map((l) => pad(cells([l]))), "claude").kind, "unknown");
check("An input cut off before its rule is unknown", readInput(claudeScreen(cells(["text"])).slice(0, 4), "claude").kind, "unknown");
check("Codex with no cursor is unknown", readInput(claudeScreen(cells([words])), "codex").kind, "unknown");
check("OpenCode's input is unknown", readInput(claudeScreen(cells([words])), "opencode", { x: 2, y: 3, hidden: false }).kind, "unknown");
check("Claude's reading ignores the cursor", readInput(claudeScreen(cells([words])), "claude", { x: 0, y: 0, hidden: true }), readInput(claudeScreen(cells([words])), "claude"));

// Claude 2.1 on this PC puts a no-break space after ❯. The last seven lines of
// pane 7's read-back (loomctl read, 2026-10-01), as they were.
const pane7 = ["✻ Cogitated for 32s · done 13:16", "", "─".repeat(138), "❯ [Pasted text #1]", "─".repeat(138), "  Opus 5.5 | XHIGH | ctx 12% | loom | main*  [PONYTAIL]", "  paste again to expand"];
check("Pane 7's collapsed paste is a draft", readInput(pane7.map((l) => cells([l])), "claude"), { kind: "draft", text: "[Pasted text #1]" });
check("Pane 7's empty input is a bare ❯", readInput(pane7.map((l, i) => cells([i === 3 ? "❯" : l])), "claude"), { kind: "empty", text: "" });
const nbsp = (...input: Cell[]) => readInput([cells([rule]), [...cells(["❯ "]), ...input], cells([rule])].map(pad), "claude");
check("After ❯ and a no-break space: a draft", nbsp(...cells([words], [" ", "i"])), { kind: "draft", text: words });
check("After ❯ and a no-break space: a suggestion", nbsp(...cells([words[0], "i"], [words.slice(1), "d"])), { kind: "suggestion", text: words });
check("After ❯ and a no-break space: an unfocused suggestion", nbsp(...cells([words, "d"])), { kind: "suggestion", text: words });
for (const [name, sep] of [["an em space", " "], ["a tab", "\t"]]) {
  check(`After ❯ and ${name}: still unknown`, readInput([cells([rule]), cells([`❯${sep}text`]), cells([rule])].map(pad), "claude").kind, "unknown");
}

// Codex 0.160's composer, captured live (src/fixtures/codex-composer.json): "›"
// in column 0, the input from column 2, the real cursor at the insertion point.
// A captured row marks styles: {d} dim, {i} inverse, {c} colored, {-} plain.
const styled = (row: string): Cell[] => {
  const out: Cell[] = [];
  let style = "";
  for (const part of row.split(/(\{[dic-]+\})/)) {
    if (/^\{[dic-]+\}$/.test(part)) style = part;
    else for (const ch of part) out.push({ ch, dim: style.includes("d"), inverse: style.includes("i") });
  }
  return out;
};
const shot = (name: string) => (codexCapture.screens as Record<string, { cursor: Cursor; rows: string[] }>)[name];
const codexRead = (rows: string[], cursor?: Cursor) => readInput(rows.map(styled), "codex", cursor);
const placeholder = "Ask Codex to do anything";
for (const name of ["empty", "cleared", "cleared2"]) {
  check(`Codex ${name}: its dim placeholder`, codexRead(shot(name).rows, shot(name).cursor), { kind: "suggestion", text: placeholder });
}
check("Codex draft", codexRead(shot("draft").rows, shot("draft").cursor), { kind: "draft", text: "fix the sign-up form fields too" });
check("Codex wrapped draft", codexRead(shot("wrapped").rows, shot("wrapped").cursor),
  { kind: "draft", text: "fix the sign-up form fields too and keep each error message right under its field when the window\nis narrow, then add tests" });
check("Codex collapsed paste (colored, not dim)", codexRead(shot("pasted").rows, shot("pasted").cursor), { kind: "draft", text: "[Pasted Content 2509 chars]" });
const blank = shot("empty"), draftShot = shot("draft"), y = blank.cursor.y;
const swap = (rows: string[], edits: Record<number, string>) => rows.map((r, i) => edits[i] ?? r);
const samePlain = swap(blank.rows, { [y]: `› ${placeholder}` });
check("The placeholder's words typed plain are a draft", codexRead(samePlain, { ...blank.cursor, x: 2 + placeholder.length }), { kind: "draft", text: placeholder });
check("... with the cursor moved back to their start too", codexRead(samePlain, blank.cursor), { kind: "draft", text: placeholder });
check("Dim words the cursor isn't in front of: unknown", codexRead(blank.rows, { ...blank.cursor, x: 2 + placeholder.length }).kind, "unknown");
check("Blank without its placeholder: unknown, never empty", codexRead(swap(blank.rows, { [y]: "›" }), blank.cursor).kind, "unknown");
// Review 2026-10-02 19:08 (P1): a blank row under the cursor can be a blank line
// in the draft. The composer runs to the blank row above the status lines.
const review = ["› ", "", "  third line", "", "  model status"];
check("Review case, cursor on the blank first line: the whole draft", codexRead(review, { x: 2, y: 0, hidden: false }), { kind: "draft", text: "\n\nthird line" });
check("Review case, cursor on its last line: the same draft", codexRead(review, { x: 12, y: 2, hidden: false }), { kind: "draft", text: "\n\nthird line" });
const lines3 = swap(blank.rows, { [y - 2]: "› first line", [y - 1]: "", [y]: "  third line" });
for (const [where, at] of [["above the blank line", { x: 12, y: y - 2 }], ["on the blank line", { x: 2, y: y - 1 }], ["below it", { x: 12, y }]] as const) {
  check(`A blank line in a draft, the cursor ${where}`, codexRead(lines3, { ...at, hidden: false }), { kind: "draft", text: "first line\n\nthird line" });
}
check("Two blank lines first, the cursor at the top", codexRead(swap(blank.rows, { [y - 3]: "› ", [y - 2]: "", [y - 1]: "", [y]: "  third line" }), { x: 2, y: y - 3, hidden: false }),
  { kind: "draft", text: "\n\n\nthird line" });
const wrappedRows = shot("wrapped").rows, wy = shot("wrapped").cursor.y; // its draft wraps over rows wy-1 and wy
check("A wrapped first line, a blank line, more, the cursor at the top",
  codexRead(swap(wrappedRows, { [wy - 3]: wrappedRows[wy - 1], [wy - 2]: wrappedRows[wy], [wy - 1]: "", [wy]: "  last line" }), { x: 2, y: wy - 3, hidden: false }),
  { kind: "draft", text: "fix the sign-up form fields too and keep each error message right under its field when the window\nis narrow, then add tests\n\nlast line" });
check("The placeholder's words typed on a later line: a draft", codexRead(swap(blank.rows, { [y - 2]: "› ", [y - 1]: "", [y]: `  ${placeholder}` }), { x: 2, y: y - 2, hidden: false }),
  { kind: "draft", text: `\n\n${placeholder}` });
check("Dim words below a blank first line aren't the placeholder: unknown", codexRead(swap(blank.rows, { [y - 2]: "› ", [y - 1]: "", [y]: `  {d}${placeholder}` }), { x: 2, y: y - 2, hidden: false }).kind, "unknown");
check("A pasted block after a blank line, the cursor at the top", codexRead(swap(shot("pasted").rows, { [y - 2]: "› ", [y - 1]: "", [y]: "  {c}[Pasted Content 2509 chars]" }), { x: 2, y: y - 2, hidden: false }),
  { kind: "draft", text: "\n\n[Pasted Content 2509 chars]" });
check("No status lines under it: a blank first line is unknown, never empty", codexRead(["› ", "", "  third line", "", ""], { x: 2, y: 0, hidden: false }).kind, "unknown");
check("An approval under blank rows: unknown", codexRead(["› ", "", ...codex.split("\n").slice(1, 10), ""], { x: 2, y: 0, hidden: false }).kind, "unknown");
check("A hidden cursor: unknown", codexRead(blank.rows, { ...blank.cursor, hidden: true }).kind, "unknown");
check("No cursor: unknown", codexRead(blank.rows).kind, "unknown");
check("The cursor under the glyph: unknown", codexRead(blank.rows, { ...blank.cursor, x: 0 }).kind, "unknown");
check("The cursor on the status line: unknown", codexRead(blank.rows, { ...blank.cursor, y: y + 2 }).kind, "unknown");
check("The cursor past an empty composer: unknown", codexRead(swap(blank.rows, { [y]: "›" }), { ...blank.cursor, x: 9 }).kind, "unknown");
// An approval where the composer was puts the same "›" on its first option.
const approval = [...blank.rows.slice(0, 20), ...codex.split("\n").slice(1, 10), ""];
const option = approval.findIndex((r) => r.startsWith("› 1."));
check("An approval's highlighted option isn't the composer", codexRead(approval, { x: 2, y: option, hidden: false }).kind, "unknown");
check("... nor with its cursor hidden", codexRead(approval, { x: 2, y: option, hidden: true }).kind, "unknown");
check("A typed numbered list reads as a question: unknown", codexRead(swap(blank.rows, { [y - 1]: "› 1. fix the tests", [y]: "  2. then lint" }), { x: 15, y, hidden: false }).kind, "unknown");
check("An earlier prompt in the transcript doesn't count", codexRead(swap(draftShot.rows, { 10: "› run the tests" }), draftShot.cursor), { kind: "draft", text: "fix the sign-up form fields too" });
check("A draft with a blank line in it", codexRead(swap(blank.rows, { [y - 2]: "› first line", [y - 1]: "", [y]: "  third line" }), { x: 12, y, hidden: false }),
  { kind: "draft", text: "first line\n\nthird line" });
check("Something drawn right under the composer: unknown", codexRead(swap(draftShot.rows, { [y + 1]: "Working (3s)" }), draftShot.cursor).kind, "unknown");
check("... even with a blank row further down", codexRead(swap(draftShot.rows, { [y + 1]: "Working (3s)", [y + 2]: "" }), draftShot.cursor).kind, "unknown");
check("The cursor on a row that isn't the composer's: unknown", codexRead(swap(blank.rows, { [y - 2]: "› fix the tests", [y - 1]: "", [y]: "Esc to interrupt", [y + 1]: "", [y + 2]: "", [y + 3]: "" }), { x: 5, y, hidden: false }).kind, "unknown");
check("No blank row under the composer: unknown", codexRead(draftShot.rows.slice(0, y + 1), draftShot.cursor).kind, "unknown");
check("Plain and dim mixed: unknown", codexRead(swap(blank.rows, { [y]: "› fix {d}the tests" }), { ...blank.cursor, x: 6 }).kind, "unknown");
check("Inverse text, which Codex doesn't draw: unknown", codexRead(swap(draftShot.rows, { [y]: "› fix {i}t{-}he tests" }), draftShot.cursor).kind, "unknown");

// Claude Code 2.1.288 at work and after, as a live pane's screen read (2026-10-03).
const claudeBusy = [
  "● Bash(grep -n \"const INTERRUPT_HINT\" src/main.ts)",
  "  ⎿  Running…",
  "",
  "✢ Topsy-turvying… (22m 17s · ↓ 98.5k tokens · thought for 8s)",
  "",
  "─".repeat(40),
  "❯",
  "─".repeat(40),
  "  Opus 5.5 | XHIGH | ctx 26% | loom | main*",
  "  ⏵⏵ auto mode on · 2 shells · ← for agents",
].join("\n") + "\n";
check("Claude 2.1.288 working, no esc hint: working", claudeWorking(claudeBusy), true);
check("Its frame before the timer shows: working", claudeWorking("* Thinking…\n❯\n"), true);
check("The line a turn leaves: not working", claudeWorking(claudeBusy.replace(/^✢ .*$/m, "✻ Worked for 22m 17s")), false);
check("A tool still running, indented: not the working line", claudeWorking(claudeBusy.replace(/^✢ .*\n/m, "")), false);
check("A truncated line ending in …: not working", claudeWorking("● Read(src/main.ts…)\n* a bullet that ends here…ish\n"), false);

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
