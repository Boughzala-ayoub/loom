// Self-check for readMenu / echoes. Run: node src/prompt.test.ts
import { readMenu, echoes, echoed, menuRev, type Menu } from "./prompt.ts";

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

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
