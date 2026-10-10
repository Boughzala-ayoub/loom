// xterm.js (headless) on the same workloads as the Rust bench. Loom's real stack adds the renderer on top.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");

const scroll = readFileSync(new URL("./scroll.bin", import.meta.url));
const tui = readFileSync(new URL("./tui.bin", import.meta.url));
const COLS = 120, ROWS = 45, PANES = 24;
const mb = (n) => (n / 1048576).toFixed(1);
const snap = () => { global.gc(); const m = process.memoryUsage(); return { rss: m.rss, heap: m.heapUsed + m.arrayBuffers }; };

function write(t, buf) {
  // 64 KiB chunks, the way a PTY reader delivers them
  return new Promise((res) => {
    let i = 0;
    const next = () => {
      if (i >= buf.length) return res();
      const end = Math.min(i + 65536, buf.length);
      t.write(buf.subarray(i, end), next);
      i = end;
    };
    next();
  });
}

async function memory(scrollback, lines) {
  const chunk = scroll.subarray(0, indexOfLine(scroll, lines));
  const base = snap();
  const terms = [];
  for (let p = 0; p < PANES; p++) terms.push(new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true }));
  const empty = snap();
  for (const t of terms) await write(t, chunk);
  const full = snap();
  const cells = PANES * (scrollback + ROWS) * COLS;
  console.log(`scrollback ${scrollback}: empty +${mb(empty.heap - base.heap)} MB, filled +${mb(full.heap - base.heap)} MB heap+buffers, +${mb(full.rss - base.rss)} MB rss; ${((full.heap - base.heap) / cells).toFixed(1)} bytes per cell`);
  terms.forEach((t) => t.dispose());
}

function indexOfLine(buf, n) {
  let c = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10 && ++c === n) return i + 1;
  return buf.length;
}

async function throughput(name, buf) {
  const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1500, allowProposedApi: true });
  const t0 = performance.now();
  await write(t, buf);
  const s = (performance.now() - t0) / 1000;
  console.log(`${name}: ${mb(buf.length)} MB in ${s.toFixed(2)} s = ${(buf.length / 1048576 / s).toFixed(1)} MB/s`);
  t.dispose();
}

const [mode, arg] = process.argv.slice(2);
console.log(`xterm.js headless ${mode} ${arg ?? ""}`);
if (mode === "mem") await memory(+arg, +arg + ROWS + 100);
else { await throughput("scroll", scroll); await throughput("tui   ", tui); }
