// Self-check for dropText. Run: node src/drop.test.ts
import { dropText } from "./drop.ts";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  fails++;
}

const eq = (label: string, got: string, want: string) =>
  check(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

eq("plain path", dropText(["C:\\tmp\\a.png"]), "C:\\tmp\\a.png");
eq("space gets quoted", dropText(["C:\\my files\\a.png"]), '"C:\\my files\\a.png"');
eq("an already quoted path is left alone", dropText(['"C:\\my files\\a.png"']), '"C:\\my files\\a.png"');
// A multi-file drop must stay on one line: a newline at the pty submits the prompt.
eq(
  "several paths join on one line",
  dropText(["C:\\a.png", "C:\\my files\\b.png"]),
  'C:\\a.png "C:\\my files\\b.png"',
);
eq("UNC path survives", dropText(["\\\\srv\\share\\a.png"]), "\\\\srv\\share\\a.png");
eq("blank entries dropped", dropText(["", "  ", "C:\\a.png"]), "C:\\a.png");
eq("nothing dropped", dropText([]), "");

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
