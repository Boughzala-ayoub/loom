// Self-check for loomctl's pure helpers. Run: node src/cli.test.ts
import { flag, keyBytes, num, onOff, paneRef, table, type Args } from "./cli.ts";

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

const args = (o: Record<string, unknown>): Args => ({ _: [], ...o });
eq("--yes", flag(args({ yes: true }), "yes"), true);
eq("--yes=on", flag(args({ yes: "on" }), "yes"), true);
eq("missing flag", flag(args({}), "yes"), false);
eq("--yes=no", flag(args({ yes: "no" }), "yes"), false);
eq("number option", num(args({ lines: "40" }), "lines", 0, 1, 1000), 40);
eq("missing number", num(args({}), "lines", 7, 1, 1000), 7);
throws("number out of range", () => num(args({ lines: "0" }), "lines", 1, 1, 1000));
throws("not a number", () => num(args({ lines: "many" }), "lines", 1, 1, 1000));
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

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
