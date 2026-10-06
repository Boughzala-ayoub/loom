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

/** Drops the entries that settled longest ago once more than `keep` have
 * settled. `settledAt` is an entry's place in the order things settled (a
 * counter), or undefined while it runs. Unsettled ones always stay and don't
 * use up `keep`: a running --key or a pending receipt must still be found,
 * and must not push out a finished one a retry or a late wait still needs.
 * By settling order, not the map's, which is creation order: a request that
 * started first and finished last is the newest result, not the oldest. */
export function pruneSettled<V>(map: Map<string, V>, settledAt: (v: V) => number | undefined, keep: number) {
  const settled: [string, number][] = [];
  for (const [k, v] of map) {
    const at = settledAt(v);
    if (at !== undefined) settled.push([k, at]);
  }
  settled.sort((a, b) => a[1] - b[1]);
  for (const [k] of settled.slice(0, Math.max(0, settled.length - keep))) map.delete(k);
}

/** What deleting a worktree can lose, as close-thread's --discard names it:
 * changed tracked files, untracked files, ignored files, and (deleting the
 * branch) commits no other branch or remote has. */
export const LOSSES = ["tracked", "untracked", "ignored", "commits"] as const;
export type Loss = (typeof LOSSES)[number];

/** --discard's comma list, or all, as the losses it allows. */
export function discards(value: string | undefined): Set<Loss> {
  const out = new Set<Loss>();
  if (value === undefined) return out;
  for (const w of value.toLowerCase().split(",").map((s) => s.trim())) {
    if (w === "all") LOSSES.forEach((l) => out.add(l));
    else if ((LOSSES as readonly string[]).includes(w)) out.add(w as Loss);
    else throw new Error(`--discard takes ${LOSSES.join(", ")} or all, not ${w || "nothing"}.`);
  }
  return out;
}

/** SHA-256 of the text's UTF-8 bytes in hex: what a caller hashes on its side
 * to match a receipt to the prompt it saved. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  enter: "\r", return: "\r", esc: "\x1b", escape: "\x1b", tab: "\t", backtab: "\x1b[Z", backspace: "\x7f", space: " ",
};
const ARROWS: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const TILDE: Record<string, number> = {
  insert: 2, ins: 2, delete: 3, del: 3, pageup: 5, pagedown: 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};
const SS3: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
/** Ctrl with a character that isn't a letter, as xterm sends it. */
const CTRL: Record<string, string> = { "@": "\0", " ": "\0", "2": "\0", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "6": "\x1e", "_": "\x1f", "/": "\x1f", "-": "\x1f", "?": "\x7f" };

/** The bytes a key sends, or null for a name loomctl doesn't know. Arrows
 * follow the terminal's cursor-key mode, the way xterm would send them. A
 * single character is itself: menu digits, y and n. ctrl-, alt- and shift-
 * (or c-, meta-, m-) go before any key, in any order, as on a PC keyboard. */
export function keyBytes(name: string, appCursor: boolean): string | null {
  let rest = name.replace(/\+(?=.)/g, "-"), ctrl = false, alt = false, shift = false;
  for (let m; (m = /^(ctrl|c|alt|meta|m|shift)-(?=.)/i.exec(rest)); rest = rest.slice(m[0].length)) {
    const mod = m[1].toLowerCase();
    if (mod === "ctrl" || mod === "c") ctrl = true;
    else if (mod === "shift") shift = true;
    else alt = true;
  }
  const k = rest.toLowerCase();
  // xterm's modifier code: arrows, Home, End, Insert, Delete, PageUp, PageDown and F-keys carry it.
  const code = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  if (k in ARROWS) return code > 1 ? `\x1b[1;${code}${ARROWS[k]}` : (appCursor ? "\x1bO" : "\x1b[") + ARROWS[k];
  if (k in TILDE) return code > 1 ? `\x1b[${TILDE[k]};${code}~` : `\x1b[${TILDE[k]}~`;
  if (k in SS3) return code > 1 ? `\x1b[1;${code}${SS3[k]}` : `\x1bO${SS3[k]}`;
  // The rest: shift and ctrl change the character itself, alt puts Esc before it.
  let out = k in NAMED ? NAMED[k] : [...rest].length === 1 ? rest : null;
  if (out === null) return null;
  if (shift) out = k === "tab" ? "\x1b[Z" : out.toUpperCase();
  if (ctrl) out = /^[a-z]$/i.test(out) ? String.fromCharCode(out.toLowerCase().charCodeAt(0) - 96) : (CTRL[out] ?? out);
  return alt ? `\x1b${out}` : out;
}

/** Rows as plain aligned columns; the last column runs free. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, [...cell].length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - [...cell].length))).join("  ").trimEnd())
    .join("\n");
}
