import type { IBuffer } from '@xterm/xterm';

const IMAGE_TYPES = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
}));
export const imageMime = (path: string) => IMAGE_TYPES.get(path.split('.').pop()!.toLowerCase());

// Quoted paths may contain spaces. Unquoted absolute Windows paths may too.
const PATH_RE = /["'`]([^"'`\r\n]+\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?)["'`]|(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"*?<>|]+?\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?(?=$|[\s"'`),;\]])|[\\/]?(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?/gu;

/** Join terminal wraps and keep cell coordinates, including wide characters. */
export function fileLinks(buffer: IBuffer, y: number) {
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: { x: number; y: number }[] = [];
  for (let row = first; row < buffer.length; row++) {
    const line = buffer.getLine(row)!;
    if (row > first && !line.isWrapped) break;
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col)!;
      if (!cell.getWidth()) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: row + 1 });
    }
  }
  return [...text.trimEnd().matchAll(PATH_RE)].map(m => {
    const path = m[1] ?? m[0];
    const start = m.index! + (m[1] ? 1 : 0);
    return { text: path, range: { start: cells[start], end: cells[start + path.length - 1] } };
  }).filter(link => link.range.start.y <= y && link.range.end.y >= y);
}
