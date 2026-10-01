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

/** What each --option of a command takes. A bool is on by being there and never
 * takes the next word; the rest need a value: `--name value` or `--name=value`. */
export type OptionType = "bool" | "string" | "int";
export type Options = Record<string, OptionType>;

/** A command's words and --options, checked against what it takes. After a
 * bare --, every word is a word. */
export function parseArgs(argv: string[], options: Options, command: string): Args {
  const a: Args = { _: [] };
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (rest || !w.startsWith("--")) {
      a._.push(w);
      continue;
    }
    if (w === "--") {
      rest = true;
      continue;
    }
    const eq = w.indexOf("=");
    const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
    const type = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : undefined;
    if (!type) {
      const known = Object.keys(options).map((k) => `--${k}`);
      throw new Error(`${command} doesn't take --${name}.${known.length ? ` It takes ${known.join(", ")}.` : ""}`);
    }
    let value = eq < 0 ? undefined : w.slice(eq + 1);
    if (type === "bool") {
      if (value === undefined || /^(true|yes|on|1)$/i.test(value)) a[name] = true;
      else if (/^(false|no|off|0)$/i.test(value)) a[name] = false;
      else throw new Error(`--${name} is on or off, not ${value}.`);
      continue;
    }
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
      i++;
    }
    if (type === "int") {
      if (!/^-?\d+$/.test(value.trim())) throw new Error(`--${name} takes a whole number, not ${value}.`);
      a[name] = Number(value);
    } else a[name] = value;
  }
  return a;
}

/** A bool option that is on. */
export const flag = (args: Args, name: string) => args[name] === true;

/** An int option, or `fallback` when it's missing; out of range is an error. */
export function num(args: Args, name: string, fallback: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`--${name} takes a whole number from ${min} to ${max}, not ${String(v)}.`);
  return v;
}

/** Drops the oldest settled entries once more than `keep` of them are settled.
 * Unsettled ones always stay and don't use up `keep`: a running --key or a
 * pending receipt must still be found, and must not push out a finished one
 * a retry or a late wait still needs. */
export function pruneSettled<V>(map: Map<string, V>, settled: (v: V) => boolean, keep: number) {
  let n = 0;
  for (const v of map.values()) if (settled(v)) n++;
  for (const [k, v] of map) {
    if (n <= keep) return;
    if (settled(v)) (map.delete(k), n--);
  }
}

/** A string option, or undefined when it's missing. */
export const str = (args: Args, name: string) => (typeof args[name] === "string" ? (args[name] as string) : undefined);

/** A folder as the caller meant it: relative to the terminal loomctl ran in,
 * not to Loom's own working folder. Windows paths only. */
export function callerPath(path: string, cwd: string | undefined): string {
  const p = path.replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(p) || p.startsWith("\\\\") || !cwd) return p;
  if (/^[a-zA-Z]:/.test(p)) return p; // drive-relative: left for git to read
  const parts = (p.startsWith("\\") ? cwd.slice(0, 2) : cwd).replace(/\//g, "\\").replace(/\\+$/, "").split("\\");
  for (const seg of p.split("\\")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join("\\") + (parts.length === 1 ? "\\" : "");
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
