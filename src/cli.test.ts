// Self-check for loomctl's pure helpers. Run: node src/cli.test.ts
import { callerPath, flag, keyBytes, num, onOff, paneRef, parseArgs, pruneSettled, str, table, type Args } from "./cli.ts";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  fails++;
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const throws = (label: string, fn: () => unknown) => {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
};

eq("no pane is the one in front", paneRef(undefined), { current: true });
eq("current is the one in front", paneRef("current"), { current: true });
eq("thread:n", paneRef("search-polish:2"), { thread: "search-polish", n: 2 });
eq("a thread name with a colon keeps it", paneRef("a:b:3"), { thread: "a:b", n: 3 });
eq("anything else is an id", paneRef("mz1k2-4"), { id: "mz1k2-4" });
eq("pane 0 is not a position", paneRef("t:0"), { id: "t:0" });

// A bool never swallows the next word, wherever it sits.
const send = { "no-enter": "bool" } as const;
eq("bool before the words", parseArgs(["--no-enter", "p1", "echo", "hi"], send, "send"), { _: ["p1", "echo", "hi"], "no-enter": true });
eq("bool between the words", parseArgs(["p1", "--no-enter", "echo", "hi"], send, "send"), { _: ["p1", "echo", "hi"], "no-enter": true });
eq("bool after the words", parseArgs(["p1", "echo", "--no-enter"], send, "send"), { _: ["p1", "echo"], "no-enter": true });
const close = { yes: "bool" } as const;
eq("close --yes target keeps its target", parseArgs(["--yes", "alpha:2"], close, "close"), { _: ["alpha:2"], yes: true });
eq("--yes=off", parseArgs(["--yes=off", "p"], close, "close"), { _: ["p"], yes: false });
throws("--yes=target is refused", () => parseArgs(["--yes=alpha:2"], close, "close"));
throws("an option the command doesn't take", () => parseArgs(["--force", "p"], close, "close"));
const make = { agent: "string", panes: "int" } as const;
eq("values, both spellings", parseArgs(["C:\\r", "--agent", "codex", "--panes=2"], make, "new"), { _: ["C:\\r"], agent: "codex", panes: 2 });
throws("a value is required", () => parseArgs(["C:\\r", "--agent"], make, "new"));
throws("a value can't be the next option", () => parseArgs(["--agent", "--panes", "2"], make, "new"));
throws("a count must be whole", () => parseArgs(["C:\\r", "--panes", "1.5"], make, "new"));
eq("after -- every word is a word", parseArgs(["p1", "--", "--no-enter", "--x"], send, "send"), { _: ["p1", "--no-enter", "--x"] });

const args = (o: Record<string, unknown>): Args => ({ _: [], ...o });
eq("--yes", flag(args({ yes: true }), "yes"), true);
eq("missing flag", flag(args({}), "yes"), false);
eq("a string is not a flag", flag(args({ yes: "alpha" }), "yes"), false);
eq("int option", num(args({ lines: 40 }), "lines", 0, 1, 1000), 40);
eq("missing number", num(args({}), "lines", 7, 1, 1000), 7);
throws("number out of range", () => num(args({ lines: 0 }), "lines", 1, 1, 1000));
throws("not a whole number", () => num(args({ lines: 1.5 }), "lines", 1, 1, 1000));
eq("string option", str(args({ agent: "codex" }), "agent"), "codex");
eq("a bare flag is no string", str(args({ agent: true }), "agent"), undefined);

eq("absolute stays", callerPath("C:\\code\\app", "D:\\x"), "C:\\code\\app");
eq("dot is the caller's folder", callerPath(".", "C:\\my work\\app"), "C:\\my work\\app");
eq("relative joins the caller's folder", callerPath("sub/dir", "C:\\my work"), "C:\\my work\\sub\\dir");
eq("parent steps up", callerPath("..\\other", "C:\\my work\\app"), "C:\\my work\\other");
eq("root-relative keeps the caller's drive", callerPath("\\code", "D:\\x\\y"), "D:\\code");
eq("up past the root stops at it", callerPath("..\\..\\..", "C:\\a"), "C:\\");
eq("UNC stays", callerPath("\\\\srv\\share", "C:\\x"), "\\\\srv\\share");
eq("on", onOff("On", "sound"), true);
eq("off", onOff("0", "sound"), false);
throws("neither", () => onOff("loud", "sound"));

eq("enter", keyBytes("Enter", false), "\r");
eq("esc", keyBytes("esc", false), "\x1b");
eq("arrow, normal mode", keyBytes("down", false), "\x1b[B");
eq("arrow, application mode", keyBytes("up", true), "\x1bOA");
eq("ctrl-c", keyBytes("ctrl-c", false), "\x03");
eq("ctrl+d", keyBytes("Ctrl+D", false), "\x04");
eq("a digit is itself", keyBytes("2", false), "2");
eq("shift-tab", keyBytes("shift-tab", false), "\x1b[Z");
eq("unknown words are refused", keyBytes("hello", false), null);

eq("table aligns all but the last column", table([["a", "bb", "x y"], ["ccc", "d", "z"]]), "a    bb  x y\nccc  d   z");

// pruneSettled: what the --key cache and the receipt store keep. Entries in
// creation order; each number is when it settled, undefined while it runs.
const entries = (...at: (number | undefined)[]) => new Map(at.map((a, i) => [`k${i}`, { at: a }]));
const kept = (m: Map<string, { at?: number }>) => [...m.keys()].join(" ");
let cache = entries(...Array(256).fill(undefined), 1, 2);
pruneSettled(cache, (e) => e.at, 256);
eq("256 running entries don't push out the 2 finished ones", cache.size, 258);
cache = entries(1, undefined, 2, 3, undefined);
pruneSettled(cache, (e) => e.at, 2);
eq("Past the limit, the first to finish go and the running stay", kept(cache), "k1 k2 k3 k4");
cache = entries(undefined, undefined, undefined);
pruneSettled(cache, (e) => e.at, 0);
eq("Running entries never go, whatever the limit", cache.size, 3);
// Created first, finished last: the newest result, so it stays and an older one goes.
cache = entries(257, ...Array.from({ length: 256 }, (_, i) => i + 1));
pruneSettled(cache, (e) => e.at, 256);
eq("A request that started first and finished last keeps its result", [cache.has("k0"), cache.has("k1"), cache.size], [true, false, 256]);
cache = entries(5, 2, undefined, 9, 1);
pruneSettled(cache, (e) => e.at, 2);
eq("Out of order, the two that finished last stay", kept(cache), "k0 k2 k3");

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
