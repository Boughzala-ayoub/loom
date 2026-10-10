// Deterministic terminal workloads shared by the Rust and Node benches.
// scroll.bin : 70,000 lines of ~110 visible cells, truecolor runs, some box drawing / wide chars.
// tui.bin    : 2,000 full-screen redraws of a 120x45 grid, each cell run colored (Ink-style repaint).
import { writeFileSync } from "node:fs";

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(42);
const words = ["fn", "let", "match", "await", "src/lib.rs", "error[E0308]", "warning:", "claude", "read", "grep", "plan:", "restored", "24", "messages", "pty", "writer", "thread", "commit", "diff", "██", "─────", "│", "┌─┐", "→", "✓", "日本語", "ok", "the", "quick", "brown", "fox"];
const color = () => `\x1b[38;2;${(r() * 255) | 0};${(r() * 255) | 0};${(r() * 255) | 0}m`;

function line(width) {
  let out = "", used = 0;
  while (used < width) {
    const w = words[(r() * words.length) | 0];
    const len = [...w].length + 1;
    if (used + len > width) break;
    if (r() < 0.6) out += color();
    if (r() < 0.1) out += "\x1b[1m";
    out += w + " ";
    used += len + (/[日本語]/.test(w) ? 3 : 0);
    if (r() < 0.15) out += "\x1b[0m";
  }
  return out + "\x1b[0m";
}

const scroll = [];
for (let i = 0; i < 70000; i++) scroll.push(line(110) + "\r\n");
writeFileSync(new URL("./scroll.bin", import.meta.url), scroll.join(""));

const tui = [];
for (let f = 0; f < 2000; f++) {
  let s = "\x1b[H";
  for (let row = 1; row <= 45; row++) s += `\x1b[${row};1H` + line(118) + "\x1b[K";
  tui.push(s);
}
writeFileSync(new URL("./tui.bin", import.meta.url), tui.join(""));
console.log("scroll.bin and tui.bin written");
