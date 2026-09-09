// Run: node src/links.test.ts
import type { IBuffer } from '@xterm/xterm';
import { fileLinks, imageMime } from './links.ts';
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
const wrapped = fileLinks(buffer(path, 20), 2)[0];
eq(wrapped.text, path);
eq(wrapped.range, { start: { x: 1, y: 1 }, end: { x: path.length % 20, y: 3 } });
eq(fileLinks(buffer('Viewed Image at 10:30'), 1).length, 0);
eq(imageMime('C:\\Photos\\Screen.PNG'), 'image/png');
eq(imageMime('src/main.ts'), undefined);
eq(imageMime('image.png.exe'), undefined);
eq(imageMime('Object.constructor'), undefined);
console.log('PASS file links, wrapped paths, image formats');
