import type { IBuffer } from '@xterm/xterm';

const IMAGE_TYPES = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
}));
export const imageMime = (path: string) => IMAGE_TYPES.get(path.split('.').pop()!.toLowerCase());

// Quoted paths may contain spaces. Unquoted absolute Windows paths may too.
const PATH_RE = /["'`]([^"'`\r\n]+\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?)["'`]|(?:[A-Za-z]:[\\/]|[\\/]{2}[^\s\\/"*?<>|]+[\\/]|~[\\/])[^\r\n"*?<>|]+?\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?(?=$|[\s"'`),;\]])|[\\/]?(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?/gu;

type Row = { text: string; cells: { x: number; y: number }[]; wrapped: boolean; cols: number };

/** One buffer row, one cell per UTF-16 unit of its text, wide characters included. */
function row(buffer: IBuffer, y: number, cols: number): Row {
  const line = buffer.getLine(y)!;
  let text = '';
  const cells: Row['cells'] = [];
  // xterm retains extra cells after some resizes; they are not part of the path.
  for (let col = 0; col < Math.min(line.length, cols); col++) {
    const cell = line.getCell(col)!;
    if (!cell.getWidth()) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: y + 1 });
  }
  return { text, cells, wrapped: line.isWrapped, cols };
}

/** Claude Code breaks a word too long for its box (a deep path) onto the next
 * row itself, indented to the box, so xterm never marks that row wrapped. Such
 * a row continues `a` when `a` runs to the right edge and the word across the
 * break could not have fit on `b` — a word that fits is ordinary word wrap.
 * Returns the indent to skip, 0 when `b` starts a line of its own. */
function hardWrap(a: Row, b: Row) {
  const end = a.text.trimEnd();
  if (b.wrapped || !end || a.cells[end.length - 1].x < a.cols - 4) return 0;
  const indent = /^ */.exec(b.text)![0].length;
  const head = /^\S+/.exec(b.text.slice(indent))?.[0];
  const tail = /\S+$/.exec(end)![0];
  return indent && head && tail.length + head.length > end.length - indent ? indent : 0;
}

/** Join terminal wraps, xterm's and Claude Code's own, and keep cell coordinates. */
export function fileLinks(buffer: IBuffer, y: number, cols: number) {
  let first = y - 1;
  for (let cur = row(buffer, first, cols); first > 0; first--) {
    const prev = row(buffer, first - 1, cols);
    if (!cur.wrapped && !hardWrap(prev, cur)) break;
    cur = prev;
  }
  let text = '';
  const cells: Row['cells'] = [];
  for (let i = first, prev: Row | null = null; i < buffer.length; i++) {
    const r = row(buffer, i, cols);
    const skip = prev && !r.wrapped ? hardWrap(prev, r) : 0;
    if (prev && !r.wrapped && !skip) break;
    if (skip) cells.length = (text = text.trimEnd()).length;
    text += r.text.slice(skip);
    cells.push(...r.cells.slice(skip));
    prev = r;
  }
  return [...text.trimEnd().matchAll(PATH_RE)].map(m => {
    const path = m[1] ?? m[0];
    const start = m.index! + (m[1] ? 1 : 0);
    return { text: path, range: { start: cells[start], end: cells[start + path.length - 1] } };
  // A network path (\\host\share) is matched whole so no part of it links, and
  // dropped: opening it would connect to whatever host an agent printed and
  // offer it your Windows sign-in.
  }).filter(link => !/^[\\/]{2}/.test(link.text) && link.range.start.y <= y && link.range.end.y >= y);
}
