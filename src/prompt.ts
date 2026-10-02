/** What a waiting agent's screen is asking, read off the terminal.
 *
 * Claude's permission prompts, Codex's approvals and AskUserQuestion all draw a
 * numbered list with a cursor glyph on the highlighted option. Text pasted into
 * one of those is not an answer, and the Enter after it picks whatever is
 * highlighted, so the overview offers the options as buttons instead. */
export type Menu = { question: string[]; options: string[]; selected: number; multi: boolean; prompt: string[] };

const CURSOR = /^[❯›▶➤]\s*/; // Not ASCII ">": that is Claude's input prompt.
const OPTION = /^([❯›▶➤]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const RULE = /^[─━═╌┄\-_╭╮╰╯┌┐└┘\s]+$/; // A divider or a box edge ends the question.
const CHECKBOX = /^(\[[ xX✔✓]\]|[☐☑☒◯◉○●])\s/;
// Side borders of a boxed prompt, so "│ ❯ 1. Yes │" reads as "❯ 1. Yes".
const unbox = (line: string) => line.replace(/^[\s│┃║]+|[\s│┃║]+$/g, "");
const isRule = (line: string) => RULE.test(line) && !!line.trim();

export function readMenu(screen: string): Menu | null {
  const lines = screen.split("\n").map(unbox);
  // The highlighted option nearest the bottom: menus sit under the transcript.
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (CURSOR.test(lines[i]) && OPTION.test(lines[i])) at = i;
  if (at < 0) return null;
  // Walk out from the cursor over consecutive numbers. Non-option lines between
  // them are wrapped text or per-option descriptions; three in a row end the list.
  const found = new Map<number, { line: number; text: string; cursor: boolean }>();
  const take = (i: number) => {
    const m = OPTION.exec(lines[i]);
    return m ? { n: Number(m[2]), line: i, text: m[3].trim(), cursor: !!m[1] } : null;
  };
  const first = take(at)!;
  found.set(first.n, first);
  for (const dir of [-1, 1]) {
    let want = first.n + dir, gap = 0;
    for (let i = at + dir; i >= 0 && i < lines.length && gap < 3 && want > 0; i += dir) {
      const o = take(i);
      if (o?.n === want) ((found.set(want, o), (want += dir), (gap = 0)));
      else if (o || (RULE.test(lines[i]) && lines[i].trim())) break;
      else gap++;
    }
  }
  const numbers = [...found.keys()].sort((a, b) => a - b);
  if (numbers[0] !== 1 || numbers.length < 2) return null;
  const options = numbers.map(n => found.get(n)!);
  const question: string[] = [];
  for (let i = options[0].line - 1; i >= 0 && question.length < 4; i--) {
    if (isRule(lines[i])) break;
    if (lines[i].trim()) question.unshift(lines[i].trim());
  }
  // The whole prompt as drawn, which menuRev covers: from the divider above it
  // (or the top of the screen) through the last option's wrapped text and
  // description, up to a blank line or a divider. `question` and `options` keep
  // only a summary; a command or a path in the rest decides what "Yes" does.
  let top = options[0].line, end = options[options.length - 1].line;
  while (top > 0 && !isRule(lines[top - 1])) top--;
  while (end + 1 < lines.length && lines[end + 1].trim() && !isRule(lines[end + 1])) end++;
  const prompt = lines.slice(top, end + 1).map(l => (OPTION.test(l) ? l.replace(CURSOR, "") : l).trim()).filter(Boolean);
  return {
    question,
    options: options.map(o => o.text),
    selected: options.findIndex(o => o.cursor),
    multi: options.some(o => CHECKBOX.test(o.text)),
    prompt,
  };
}

/** A menu's identity: the whole prompt as drawn and its kind, not which
 * option is highlighted. `loomctl menu` shows it and `choose --menu` must match
 * it, so an answer read for one question never goes to another with the same
 * options, or to the same question about another command or path. */
export function menuRev(m: Menu): string {
  return hash32(JSON.stringify([m.prompt, m.multi]));
}

/** FNV-1a, 8 hex digits: an id for screen text, not a secret. */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A screen cell, as much as reading an input line needs. The second cell of
 * a wide character is "". */
export type Cell = { ch: string; dim: boolean; inverse: boolean };
/** What an agent's input holds. `draft`: text someone typed and hasn't sent.
 * `suggestion`: text the agent shows that typing replaces. `unknown`: Loom
 * can't tell, so a caller must not assume either. */
export type Input = { kind: "empty" | "suggestion" | "draft" | "unknown"; text: string | null; why?: string };

// Claude's input line, bare when empty; ! is its bash mode. Claude 2.1 puts a
// no-break space after ❯ (seen in a live pane's read-back), older ones a space.
const PROMPT = /^[>❯!](?:[  ]|$)/;
const BORDER = /^[\s│┃║]$/;

/** The terminal cursor on the rows readInput gets: column, row, and whether
 * the program hid it. */
export type Cursor = { x: number; y: number; hidden: boolean };

/** What an agent's input holds, from the screen's cells: Claude's (below) and
 * Codex's (readCodexInput). Every other agent's is `unknown`: never checked. */
export function readInput(rows: Cell[][], agent: string, cursor?: Cursor): Input {
  if (agent === "codex") return readCodexInput(rows, cursor);
  if (agent !== "claude") return { kind: "unknown", text: null, why: `Loom can't tell a draft from a suggestion in ${agent}'s input.` };
  return readClaudeInput(rows);
}

/** What Claude Code's input line holds, from its cells. Claude 2.1 (read off
 * 2.1.286's renderer) draws typed text plain, and its placeholder and prompt
 * suggestion, shown only while the input is empty, dim: with the first
 * character inverse as the caret when the terminal has focus, all dim when it
 * doesn't. A draft can end in a dim hint ("/review [pr]"). The same words
 * plain or dim are a draft or a suggestion; anything else is `unknown`. */
function readClaudeInput(rows: Cell[][]): Input {
  const unknown = (why: string): Input => ({ kind: "unknown", text: null, why });
  const lines = rows.map((r) => unbox(r.map((c) => c.ch || "").join("")));
  // The last prompt line on screen right under a rule: earlier prompts in the
  // transcript have no rule above them.
  let at = -1;
  for (let i = lines.length - 1; i > 0 && at < 0; i--) if (PROMPT.test(lines[i]) && isRule(lines[i - 1])) at = i;
  if (at < 0) return unknown("Claude's input line isn't on screen.");
  let end = at + 1;
  while (end < lines.length && !isRule(lines[end])) end++;
  if (end === lines.length) return unknown("Claude's input line has no rule under it.");
  // Its text starts after the glyph and a space; wrapped rows indent to there.
  const start = rows[at].findIndex((c) => !BORDER.test(c.ch || " ")) + 2;
  const cells: Cell[] = [];
  for (let y = at; y < end; y++) {
    const row = rows[y].slice(start).filter((c) => c.ch !== "");
    while (row.length && BORDER.test(row[row.length - 1].ch) && !row[row.length - 1].inverse) row.pop();
    if (y > at) cells.push({ ch: "\n", dim: false, inverse: false });
    cells.push(...row);
  }
  const shown = cells.filter((c) => c.ch.trim());
  const plain = shown.filter((c) => !c.dim && !c.inverse), dim = shown.filter((c) => c.dim);
  const text = (keep: (c: Cell) => boolean) => cells.filter((c) => c.ch === "\n" || keep(c)).map((c) => c.ch).join("").replace(/\s+$/, "");
  if (!shown.length) return { kind: "empty", text: "" };
  if (!dim.length) return { kind: "draft", text: text(() => true) };
  // A suggestion: all dim, but for an inverse caret on its first character.
  if (!plain.length && shown.every((c, i) => c.dim || (i === 0 && c.inverse))) return { kind: "suggestion", text: text(() => true) };
  // Typed text, then a dim hint after it. One plain character before dim text
  // is also how the placeholder looks with its caret drawn plain: can't tell.
  const lastPlain = shown.length - 1 - [...shown].reverse().findIndex((c) => !c.dim), firstDim = shown.findIndex((c) => c.dim);
  if (lastPlain < firstDim && lastPlain >= 1) return { kind: "draft", text: text((c) => !c.dim) };
  return unknown("Claude's input mixes plain and dim text in a way Loom doesn't recognize.");
}

const CODEX_PROMPT = /^›(?: |$)/;

/** What Codex's composer holds. Codex 0.160 (captured live: src/fixtures/
 * codex-composer.json) draws "›" in column 0 and the input from column 2,
 * wrapped rows and the draft's own lines indented to it, blank lines included,
 * then a blank row and its status lines at the bottom. Typed text is plain (a
 * collapsed paste colored, not dim); "Ask Codex to do anything" is dim, and
 * shows only while the input is empty. There is no drawn caret: the terminal
 * cursor shows at the insertion point, so it places the input. A hidden or
 * missing cursor, a cursor outside the composer, a question on screen, an end
 * Loom can't find, or dim text the cursor doesn't sit in front of, and Loom
 * doesn't guess. */
function readCodexInput(rows: Cell[][], cursor: Cursor | undefined): Input {
  const unknown = (why: string): Input => ({ kind: "unknown", text: null, why });
  if (!cursor || cursor.hidden) return unknown(`Codex's cursor is ${cursor ? "hidden" : "unknown"}, so Loom can't place its input.`);
  const lines = rows.map((r) => r.map((c) => c.ch || "").join(""));
  // Approvals and other choices draw "› 1. ..." where the composer was.
  if (readMenu(lines.join("\n"))) return unknown("Codex is asking a question, not showing its input.");
  if (cursor.x < 2 || cursor.y < 0 || cursor.y >= lines.length) return unknown("Codex's cursor isn't in its composer.");
  // The composer's first row: the nearest "› " at or above the cursor.
  let at = cursor.y;
  while (at >= 0 && !CODEX_PROMPT.test(lines[at])) at--;
  if (at < 0) return unknown("Codex's composer isn't on screen.");
  // Its end, found from the bottom up: Codex's status lines are the last rows
  // with anything on them, one blank row above them. A blank row nearer the
  // cursor can be a blank line in the draft, with more of it below.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  while (end >= 0 && lines[end].trim()) end--;
  if (end <= cursor.y) return unknown("Codex's status lines aren't below the cursor, so Loom can't tell where its input ends.");
  // Everything in between is the input: rows indented to it, or blank.
  for (let y = at + 1; y < end; y++) {
    if (lines[y].trim() && !lines[y].startsWith("  ")) return unknown("Something other than Codex's input is drawn in its composer.");
  }
  const cells: Cell[] = [];
  for (let y = at; y < end; y++) {
    const row = rows[y].slice(2).filter((c) => c.ch !== "");
    while (row.length && !row[row.length - 1].ch.trim()) row.pop();
    if (y > at) cells.push({ ch: "\n", dim: false, inverse: false });
    cells.push(...row);
  }
  const shown = cells.filter((c) => c.ch.trim());
  const text = cells.map((c) => c.ch).join("").replace(/\s+$/, "");
  const atStart = cursor.y === at && cursor.x === 2;
  if (shown.some((c) => c.inverse)) return unknown("Codex's composer has inverse text, which it doesn't draw.");
  // Empty, Codex shows its placeholder. Blank without it, the input holds
  // blank lines (more text past the screen, perhaps) or is in a state never
  // seen: never "empty".
  if (!shown.length) return unknown("Codex's composer is blank without its placeholder, so it may hold blank lines.");
  if (shown.every((c) => !c.dim)) return { kind: "draft", text };
  // Its placeholder: one dim row, the cursor in front of it.
  if (shown.every((c) => c.dim) && end === at + 1 && atStart) return { kind: "suggestion", text };
  return unknown("Codex's composer mixes plain and dim text, or the cursor isn't where its placeholder puts it.");
}

// Long pastes show as one of these instead of the text: Claude's and Codex's.
const PASTED = /\[Pastedtext#\d+(?:\+\d+lines)?\]|\[PastedContent\d+chars\]/g;

/** Where a paste can show on screen: how many times the start of `text`, its
 * end and a collapsed-paste placeholder appear. Before and after a paste, they
 * say whether the agent took the text into an input it can submit (echoed).
 * The start of a long text scrolls away and a longer one collapses, so any of
 * the three counts. Spaces and box borders are ignored, since an input box may
 * wrap the text or pad it. */
export function echoes(screen: string, text: string): number[] {
  const flat = (s: string) => s.replace(/[\s│┃║]+/g, "");
  const shown = flat(screen), typed = flat(text);
  const count = (key: string) => (key ? shown.split(key).length - 1 : 0);
  return [count(typed.slice(0, 24)), count(typed.slice(-24)), typed ? (shown.match(PASTED) ?? []).length : 0];
}
export const echoed = (before: number[], after: number[]) => after.some((n, i) => n > before[i]);
