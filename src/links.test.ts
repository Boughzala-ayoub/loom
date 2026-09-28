// Run: node src/links.test.ts
import type { IBuffer } from '@xterm/xterm';
import { fileLinks as parseLinks, imageMime } from './links.ts';
const fileLinks = (buffer: IBuffer, y: number, cols = buffer.getLine(0)!.length) => parseLinks(buffer, y, cols);
const eq = (got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(got)} != ${JSON.stringify(want)}`);
};

function buffer(text: string, cols = 200): IBuffer {
  const rows = Array.from({ length: Math.ceil(text.length / cols) }, (_, i) => text.slice(i * cols, (i + 1) * cols));
  return {
    length: rows.length,
    getLine: (i: number) => rows[i] === undefined ? undefined : {
      isWrapped: i > 0, length: rows[i].length,
      getCell: (col: number) => ({ getWidth: () => 1, getChars: () => rows[i][col] }),
    },
  } as unknown as IBuffer;
}
for (const path of ['node_modules\\.cache\\ui-check\\theme-0-768.png', 'C:\\My Pictures\\screen shot.PNG', '"my pictures/screen shot.webp"', '\\\\server\\share\\image.gif', '/tmp/image.png', '\\temp\\image.png', 'image.png', 'src/main.ts:12:3']) {
  const link = fileLinks(buffer('  ' + path), 1)[0];
  eq(link.text, path.replace(/"/g, ''));
  eq(link.range.start.x, path.startsWith('"') ? 4 : 3);
}
const path = 'node_modules/.cache/ui-check/theme-picker-0-768.png';
for (const path of ['~\\AppData\\Local\\Temp\\opencode\\g375.png', '~/AppData/Local/Temp/opencode/g375b.png', '~\\My Pictures\\screen shot.png', '~/src/main.ts:12:3']) {
  for (const cols of [200, 20]) {
    const link = fileLinks(buffer('Read ' + path, cols), 1)[0];
    eq(link.text, path);
    eq(link.range.start, { x: 6, y: 1 });
  }
}
const wrapped = fileLinks(buffer(path, 20), 2)[0];
eq(wrapped.text, path);
eq(wrapped.range, { start: { x: 1, y: 1 }, end: { x: path.length % 20, y: 3 } });
eq(fileLinks(buffer('Viewed Image at 10:30'), 1).length, 0);
// Claude Code breaks a path longer than its box onto indented rows itself;
// xterm sees separate lines, not a wrap.
function screen(lines: string[], cols: number): IBuffer {
  const rows = lines.map(l => l.padEnd(cols));
  return {
    length: rows.length,
    getLine: (i: number) => rows[i] === undefined ? undefined : {
      isWrapped: false, length: cols,
      getCell: (col: number) => ({ getWidth: () => 1, getChars: () => rows[i][col] }),
    },
  } as unknown as IBuffer;
}
const deep = '~\\AppData\\Local\\Temp\\claude\\scratchpad\\shots\\fight-3boss-1280.png';
const read = screen(['● Reading ' + deep.slice(0, 30), '  ' + deep.slice(30)], 40);
for (const y of [1, 2]) eq(fileLinks(read, y), [{ text: deep, range: { start: { x: 11, y: 1 }, end: { x: 2 + deep.length - 30, y: 2 } } }]);
const result = screen(['  ⎿  ' + deep.slice(0, 25), '     ' + deep.slice(25, 50), '     ' + deep.slice(50)], 30);
for (const y of [1, 2, 3]) eq(fileLinks(result, y), [{ text: deep, range: { start: { x: 6, y: 1 }, end: { x: 5 + deep.length - 50, y: 3 } } }]);
// Word wrap that happens to reach the edge is two lines: the word would have fit.
const prose = screen(['Edited the file at src/main.ts', '  and ran the tests again'], 30);
eq(fileLinks(prose, 1).map(l => l.text), ['src/main.ts']);
eq(fileLinks(prose, 2), []);
// After a terminal shrinks, xterm can retain cells beyond the visible columns.
const screenshotPath = 'C:\\Users\\ayoub\\AppData\\Local\\Temp\\claude\\C--Users-ayoub-Videos-claude-fun-game-website\\f26b5a3e-41bf-40bf-822a-e80df8a49ddb\\scratchpad\\shots\\nat_big_spirit.png';
const split = screenshotPath.indexOf('scratchpad') + 3;
const firstRow = '● Read(' + screenshotPath.slice(0, split);
const resized = screen([firstRow, screenshotPath.slice(split) + ')'], firstRow.length + 15);
const getLine = resized.getLine;
resized.getLine = y => { const line = getLine(y); return line && { ...line, isWrapped: y > 0 }; };
for (const y of [1, 2]) eq(fileLinks(resized, y, firstRow.length)[0].text, screenshotPath);
eq(imageMime('C:\\Photos\\Screen.PNG'), 'image/png');
eq(imageMime('src/main.ts'), undefined);
eq(imageMime('image.png.exe'), undefined);
eq(imageMime('Object.constructor'), undefined);
console.log('PASS file links, wrapped paths, image formats');
