/** What a waiting agent's screen is asking, read off the terminal.
 *
 * Claude's permission prompts, Codex's approvals and AskUserQuestion all draw a
 * numbered list with a cursor glyph on the highlighted option. Text pasted into
 * one of those is not an answer, and the Enter after it picks whatever is
 * highlighted, so the overview offers the options as buttons instead. */
/** `options` are each option's first row; `full`, each with the rows it wraps onto.
 * `unnumbered`: its numbers aren't keys (Cursor's), so only Loom counts them. */
export type Menu = { question: string[]; options: string[]; selected: number; multi: boolean; prompt: string[]; keys?: string[]; full?: string[]; unnumbered?: boolean };

export const claudeDivider = (line: string) => /^[ \t\u00a0]*[\u2500\u2501\u2550-]{3,}[ \t\u00a0]*$/.test(line);
export const claudeComposer = (line: string) => /^[ \t]*[\u276f>]([ \t\u00a0]|$)/.test(line);

/** Claude's optional session survey takes a digit directly, without Enter. */
export function readSurvey(screen: string): Menu | null {
  const match = [...screen.matchAll(/^[ \t]*How\s+is\s+Claude\s+doing\s+this\s+session\?\s*1:\s*Bad\s+2:\s*Fine\s+3:\s*Good\s+0:\s*Dismiss\s*$/gim)].find((candidate) => !screen.slice(candidate.index! + candidate[0].length).trim());
  if (!match || screen.slice(match.index + match[0].length).trim()) return null;
  // The survey owns the footer below the live composer. Transcript quotations
  // and a dismissed survey above a new composer cannot consume survey keys.
  const above = screen.slice(0, match.index).trimEnd().split("\n");
  if (!claudeDivider(above[above.length - 1] ?? "")) return null;
  let composer = above.length - 2;
  while (composer >= 0 && !claudeComposer(above[composer])) {
    if (claudeDivider(above[composer])) return null;
    composer--;
  }
  if (composer < 0) return null;
  return { question: ["How is Claude doing this session?"], options: ["Bad", "Fine", "Good", "Dismiss"], keys: ["1", "2", "3", "0"], selected: -1, multi: false, prompt: [match[0].replace(/\s+/g, " ")] };
}

const CURSOR = /^[❯›▶➤]\s*/; // Not ASCII ">": that is Claude's input prompt.
const OPTION = /^([❯›▶➤]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const RULE = /^[─━═╌┄\-_╭╮╰╯┌┐└┘\s]+$/; // A divider or a box edge ends the question.
const CHECKBOX = /^(\[[ xX✔✓]\]|[☐☑☒◯◉○●])\s/;
// Side borders of a boxed prompt, so "│ ❯ 1. Yes │" reads as "❯ 1. Yes".
const unbox = (line: string) => line.replace(/^[\s│┃║]+|[\s│┃║]+$/g, "");
const isRule = (line: string) => RULE.test(line) && !!line.trim();

/** The single keys that answer `menu` at once: its numbers (or its own keys),
 * and a letter an option names as its shortcut, Codex's "Yes, proceed (y)",
 * also where a narrow pane wrapped it onto the option's next row, or Cursor's
 * "[a] Trust this workspace". */
export const menuKeys = (menu: Menu) => [
  ...(menu.keys ?? (menu.unnumbered ? [] : menu.options.map((_, i) => String(i + 1)))),
  ...(menu.full ?? menu.options).flatMap((o) => (/\(([a-z])\)\s*$/i.exec(o) ?? /^\[([a-z])\]\s/i.exec(o))?.[1].toLowerCase() ?? []),
];

// Cursor's menus have no numbers. An approval marks its highlighted option
// "→ Run (once) (y)", each option ending in its key ("(tab)", "(shift+tab)",
// "(esc or n)", a Write approval's "(esc or n or p)"); its trust box, "▶ [a]
// Trust this workspace", each starting with it. Up and Down move the highlight,
// as in the numbered ones.
const CURSOR_PICK = /^[→▶]\s+/;
const CURSOR_KEY = /\([a-z]+(?:\+[a-z]+)?(?: or [a-z]+(?:\+[a-z]+)?)*\)$/i;
const CURSOR_LETTER = /^\[[a-z]\]\s+\S/i;

/** Cursor's question on the screen's `raw` rows, or null. Its options sit
 * where the text after the highlighted one's glyph starts, the one nearest
 * the bottom: the question above them sits further left. An option narrow
 * pane wrapped goes on at that column to the row with its key (xterm's own
 * wraps come joined: liveScreen). Its composer, "→ Add a follow-up", is a
 * "→" row too, which takes a question's place: one under the options makes
 * them an answered question left in the transcript. So does Claude's or
 * Codex's input under them: options quoted in its transcript (inputBelow). */
function cursorMenu(raw: string[]): Menu | null {
  const rows = raw.map((l) => {
    const inner = l.replace(/^\s*[│┃║]/, "").replace(/[\s│┃║]+$/, ""), text = inner.trimStart();
    return { at: inner.length - text.length, text };
  });
  const text = (i: number) => rows[i].text.replace(CURSOR_PICK, "");
  const keyed = (i: number) => CURSOR_KEY.test(rows[i].text) || CURSOR_LETTER.test(text(i));
  // The row an option that starts at row i ends on, or -1: none starts there.
  const end = (i: number, col: number) => {
    if (CURSOR_LETTER.test(text(i))) return i;
    for (let j = i; j < Math.min(rows.length, i + 4); j++) {
      if (j > i && (rows[j].at !== col || CURSOR_PICK.test(rows[j].text))) return -1;
      if (CURSOR_KEY.test(rows[j].text)) return j;
    }
    return -1;
  };
  let pick = -1, col = 0;
  for (let i = rows.length - 1; i >= 0 && pick < 0; i--) {
    const glyph = CURSOR_PICK.exec(rows[i].text);
    if (glyph && end(i, rows[i].at + glyph[0].length) >= 0) (pick = i), (col = rows[i].at + glyph[0].length);
  }
  if (pick < 0) return null;
  const options = [{ first: pick, last: end(pick, col) }];
  for (let i = options[0].last + 1, last; i < rows.length && rows[i].at === col && (last = end(i, col)) >= 0; i = last + 1) options.push({ first: i, last });
  for (let i = pick - 1; i >= 0 && rows[i].at === col && keyed(i); ) {
    let first = i;
    while (!CURSOR_LETTER.test(text(first)) && first > 0 && rows[first - 1].at === col && !keyed(first - 1)) first--;
    options.unshift({ first, last: i });
    i = first - 1;
  }
  const first = options[0].first, last = options[options.length - 1].last;
  if (options.length < 2 || rows.slice(last + 1).some((r) => CURSOR_PICK.test(r.text))) return null;
  const lines = raw.map(unbox);
  if (inputBelow(lines, last)) return null;
  const said = options.map((o) => [text(o.first), ...rows.slice(o.first + 1, o.last + 1).map((r) => r.text)].join(" "));
  const question: string[] = [];
  for (let i = first - 1; i >= 0 && question.length < 4 && !isRule(lines[i]); i--) if (lines[i].trim()) question.unshift(lines[i].trim());
  let top = first;
  while (top > 0 && !isRule(lines[top - 1])) top--;
  const prompt = lines.slice(top, last + 1).map((l) => l.replace(CURSOR_PICK, "").trim()).filter(Boolean);
  return { question, options: said, selected: options.findIndex((o) => o.first === pick), multi: false, prompt, full: said, unnumbered: true };
}

/** Whether an agent's live input sits below row `end` of the unboxed `lines`:
 * then a menu above it is one in the transcript, a sent prompt drawn with the
 * same glyph or a question quoted, since a question takes the input's place.
 * Claude's input row sits under a rule; Codex's is a "›" row that isn't an option. */
const inputBelow = (lines: string[], end: number) =>
  lines.some((l, i) => i > end && ((PROMPT.test(l) && isRule(lines[i - 1])) || (CODEX_PROMPT.test(l) && !OPTION.test(l))));

/** The question on `screen`, or null. `agent`: the pane's, when known. Only
 * Cursor draws its unnumbered menus, so on another agent's screen one is
 * quoted text, whatever input that agent draws below it. */
export function readMenu(screen: string, agent?: string): Menu | null {
  const lines = screen.split("\n").map(unbox);
  // The highlighted option nearest the bottom: menus sit under the transcript.
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (CURSOR.test(lines[i]) && OPTION.test(lines[i])) at = i;
  if (at < 0) return agent === undefined || agent === "cursor" ? cursorMenu(screen.split("\n")) : null;
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
  // Codex keeps working above its Shift+Left question, so that transcript is not part of the menu.
  const start = lines.lastIndexOf("• Queued follow-up inputs", options[0].line - 1) + 1;
  // A numbered draft in Claude's input box: its first row sits right under the box's rule.
  if (PROMPT.test(lines[options[0].line]) && options[0].line > 0 && isRule(lines[options[0].line - 1])) return null;
  const question: string[] = [];
  for (let i = options[0].line - 1; i >= start && question.length < 4; i--) {
    if (isRule(lines[i])) break;
    if (lines[i].trim()) question.unshift(lines[i].trim());
  }
  // The whole prompt as drawn, which menuRev covers: from the divider above it
  // (or the top of the screen) through the last option's wrapped text and
  // description, up to a blank line or a divider. `question` and `options` keep
  // only a summary; a command or a path in the rest decides what "Yes" does.
  let top = options[0].line, end = options[options.length - 1].line;
  while (top > start && !isRule(lines[top - 1])) top--;
  while (end + 1 < lines.length && lines[end + 1].trim() && !isRule(lines[end + 1])) end++;
  if (inputBelow(lines, end)) return null;
  const prompt = lines.slice(top, end + 1).map(l => (OPTION.test(l) ? l.replace(CURSOR, "") : l).trim()).filter(Boolean);
  // Each option through the rows before the next one (the last: to the prompt's end).
  const full = options.map((o, k) => [o.text, ...lines.slice(o.line + 1, options[k + 1]?.line ?? end + 1).map(l => l.trim())].filter(Boolean).join(" "));
  return {
    question,
    options: options.map(o => o.text),
    selected: options.findIndex(o => o.cursor),
    multi: options.some(o => CHECKBOX.test(o.text)),
    prompt,
    full,
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
  if (readMenu(lines.join("\n"), "codex")) return unknown("Codex is asking a question, not showing its input.");
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

// Codex's "Working (3s • esc to interrupt)", OpenCode's "esc interrupt" ("esc again to interrupt" after one press).
const HINT = /\besc\s+(?:again\s+)?(?:to\s+)?interrupt/i;
// Cursor's composer row while a turn runs ("→ Add a follow-up … ctrl+c to stop"),
// and its spinner, two braille frames then a word ("⠘⠣ Running", "⠰⠳ Working").
const CURSOR_HINT = /ctrl\+c to stop\s*$/;
const CURSOR_SPIN = /^\s?[\u2800-\u28ff]{2} +\S/;
// Claude Code 2.1.288+ keeps the hint only in its API retry banner, which takes
// its spinner's row: a frame in column 0, never the transcript's "●".
const CLAUDE_RETRY = /^[·✢✳*✶✻✽] .*·\s*next try in\s.*·\s*esc to interrupt\s*$/;
// Codex's status row, shown only while a turn runs: "[frame ]<header> (<clock>
// • esc to interrupt)[ · …]", its clock 5s, 1m 05s or 1h 02m 05s, and cut
// with "…" when narrow, hint and all. A transcript quote has no clock.
const CODEX_STATUS = /^\s*(?:\S )?[^\s(][^(]* \(\d+[hms](?: \d+[hms])*(?![\w])/;
/** Codex draws its status row's "(elapsed" dim. Its transcript can say the same
 * words, its own "• " in front, but plain: only the cells tell them apart. The
 * rows nearest the bottom that make up `line` (wrapped ones joined) are read. */
function codexOwn(line: string, cells?: () => Cell[][]): boolean {
  const rows = cells?.() ?? [], text = rows.map((r) => r.map((c) => c.ch).join(""));
  for (let y = rows.length - 1; y >= 0; y--) {
    let k = y, joined = text[y];
    while (joined.length < line.length && k + 1 < rows.length) joined += text[++k];
    if (joined.trimEnd() !== line.trimEnd()) continue;
    return !!rows.slice(y, k + 1).flat().find((c) => c.ch === "(")?.dim;
  }
  return false;
}

/** An agent's "esc to interrupt" hint, or its working status, read only off
 * the rows that are the agent's own, since the transcript can quote it and a
 * draft can say it. Claude: its retry banner in the live rows above its input
 * box, or the footer under the box. Codex: its status row in the few rows
 * above the "›" composer, or the footer below the composer's own rows.
 * Cursor: its "→" composer's row and the spinner above it. Anything else
 * (OpenCode's footer): the last three rows with text. */
export function interruptHint(screen: string, agent: string, cells?: () => Cell[][]): boolean {
  const lines = screen.split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  const from = (i: number) => lines.slice(Math.max(0, i), end).some((l) => HINT.test(l));
  if (agent === "claude") {
    // The input box: the last prompt row right under a rule, to the rule under it.
    for (let i = end - 1; i > 0; i--) {
      if (!PROMPT.test(unbox(lines[i])) || !isRule(unbox(lines[i - 1]))) continue;
      let j = i + 1;
      while (j < end && !isRule(unbox(lines[j]))) j++;
      if (from(j + 1)) return true;
      // The live rows: the block above the box, past the blank row between.
      let k = i - 2;
      while (k >= 0 && !lines[k].trim()) k--;
      for (; k >= 0 && lines[k].trim(); k--) if (CLAUDE_RETRY.test(lines[k])) return true;
      return false;
    }
    return false;
  }
  if (agent === "codex") for (let i = end - 1; i >= 0; i--) {
    if (!CODEX_PROMPT.test(lines[i]) || OPTION.test(lines[i])) continue;
    // Below: the composer's own rows (its draft, wrapped) to a blank row, then the footer.
    let j = i + 1;
    while (j < end && lines[j].trim()) j++;
    // ponytail: the status row within four rows of the composer (it may carry detail rows).
    // Cut before its "(elapsed" in a pane that narrow, it reads idle: only
    // Codex's run-state title (Pane.codexState) can say then, and it wins when present.
    return from(j) || lines.slice(Math.max(0, i - 4), i).some((l) => CODEX_STATUS.test(l) && codexOwn(l, cells));
  }
  if (agent === "cursor") {
    // Its composer, the last "→" row: the hint at its end, or the spinner in
    // the rows above it (a narrow pane may leave the hint out). A question's
    // highlighted option is a "→" row too, with neither: asking isn't working.
    for (let i = end - 1; i >= 0; i--) {
      if (!/^\s*→\s/.test(lines[i])) continue;
      return CURSOR_HINT.test(lines[i]) || lines.slice(Math.max(0, i - 8), i).some((l) => CURSOR_SPIN.test(l));
    }
    return false;
  }
  return from(end - 3);
}

// Long pastes show as one of these instead of the text: Claude's and Codex's.
const PASTED = /\[Pastedtext#\d+(?:\+\d+lines)?\]|\[PastedContent\d+chars\]|\[Image#\d+\]/g;

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

/** Claude Code's working line, as a screen of text shows it: a spinner frame
 * in the first column, the verb with "…", then its timer, "✢ Topsy-turvying…
 * (22m 17s · ↓ 98.5k tokens · thought for 8s)". 2.1.288 dropped "esc to
 * interrupt" from it (only its API retry banner keeps that). The frames are
 * · ✢ * ✶ ✻ ✽ on Windows, ✳ for * elsewhere. The line a turn leaves behind,
 * "✻ Worked for 3m 2s", has no "…", and tool lines ("⎿  Running…") are
 * indented. */
export const claudeWorking = (screen: string) => /^[·✢✳*✶✻✽] [^\n]*…(?: \(|$)/m.test(screen);
