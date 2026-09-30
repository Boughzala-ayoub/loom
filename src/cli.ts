/** loomctl's arguments, key names and text output: the parts of the loomctl
 * commands that need no Loom state, so they run under plain node. The commands
 * themselves are in main.ts (the loomctl section), beside the threads and panes
 * they act on. */

/** What loomctl sends: `_` holds the words, the rest are --options. */
export type Args = { _: string[]; [option: string]: unknown };

/** A pane named on the command line: nothing (or "current") for the pane in
 * front, "<thread>:<n>" for a thread's nth pane, anything else an id. */
export type PaneRef = { current: true } | { thread: string; n: number } | { id: string };

export function paneRef(sel: string | undefined): PaneRef {
  if (!sel || sel === "current" || sel === ".") return { current: true };
  const m = /^(.+):(\d+)$/.exec(sel);
  if (m && Number(m[2]) >= 1) return { thread: m[1], n: Number(m[2]) };
  return { id: sel };
}

/** An --option that is on: `--yes`, or `--yes=true|yes|on|1`. */
export function flag(args: Args, name: string): boolean {
  const v = args[name];
  return v === true || (typeof v === "string" && /^(true|yes|on|1)$/i.test(v));
}

/** A number option, or `fallback` when it's missing; out of range is an error. */
export function num(args: Args, name: string, fallback: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} takes a number from ${min} to ${max}, not ${String(v)}.`);
  return n;
}

/** On or off, for `loomctl set`. */
export function onOff(value: string | undefined, what: string): boolean {
  if (value && /^(on|true|yes|1)$/i.test(value)) return true;
  if (value && /^(off|false|no|0)$/i.test(value)) return false;
  throw new Error(`${what} takes on or off, not ${value ?? "nothing"}.`);
}

const NAMED: Record<string, string> = {
  enter: "\r", return: "\r", esc: "\x1b", escape: "\x1b", tab: "\t", "shift-tab": "\x1b[Z", backtab: "\x1b[Z",
  backspace: "\x7f", space: " ", delete: "\x1b[3~", del: "\x1b[3~", pageup: "\x1b[5~", pagedown: "\x1b[6~",
};
const ARROWS: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };

/** The bytes a key sends, or null for a name loomctl doesn't know. Arrows
 * follow the terminal's cursor-key mode, the way xterm would send them. A
 * single character is itself: menu digits, y and n. */
export function keyBytes(name: string, appCursor: boolean): string | null {
  const k = name.toLowerCase().replace(/\+/g, "-");
  if (k in NAMED) return NAMED[k];
  if (k in ARROWS) return (appCursor ? "\x1bO" : "\x1b[") + ARROWS[k];
  const ctrl = /^(?:ctrl|c)-([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  if ([...name].length === 1) return name;
  return null;
}

/** Rows as plain aligned columns; the last column runs free. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - [...cell].length))).join("  ").trimEnd())
    .join("\n");
}
