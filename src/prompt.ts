/** What a waiting agent's screen is asking, read off the terminal.
 *
 * Claude's permission prompts, Codex's approvals and AskUserQuestion all draw a
 * numbered list with a cursor glyph on the highlighted option. Text pasted into
 * one of those is not an answer, and the Enter after it picks whatever is
 * highlighted, so the overview offers the options as buttons instead. */
export type Menu = { question: string[]; options: string[]; selected: number; multi: boolean };

const CURSOR = /^[❯›▶➤]\s*/; // Not ASCII ">": that is Claude's input prompt.
const OPTION = /^([❯›▶➤]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const RULE = /^[─━═╌┄\-_╭╮╰╯┌┐└┘\s]+$/; // A divider or a box edge ends the question.
const CHECKBOX = /^(\[[ xX✔✓]\]|[☐☑☒◯◉○●])\s/;
// Side borders of a boxed prompt, so "│ ❯ 1. Yes │" reads as "❯ 1. Yes".
const unbox = (line: string) => line.replace(/^[\s│┃║]+|[\s│┃║]+$/g, "");

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
    if (RULE.test(lines[i]) && lines[i].trim()) break;
    if (lines[i].trim()) question.unshift(lines[i].trim());
  }
  return {
    question,
    options: options.map(o => o.text),
    selected: options.findIndex(o => o.cursor),
    multi: options.some(o => CHECKBOX.test(o.text)),
  };
}

/** How many times the start of `text` shows on screen. Before and after a paste,
 * it says whether the agent took the text into an input it can submit. Spaces
 * and box borders are ignored, since an input box may wrap the text or pad it. */
export function echoes(screen: string, text: string): number {
  const flat = (s: string) => s.replace(/[\s│┃║]+/g, "");
  const key = flat(text).slice(0, 24);
  return key ? flat(screen).split(key).length - 1 : 0;
}
