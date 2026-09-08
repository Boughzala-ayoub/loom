// Self-check for wheelInit. Run: node src/scroll.test.ts
import { wheelInit, LINES } from "./scroll.ts";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  fails++;
}

const box = { left: 100, top: 50, width: 400, height: 200 };
const up = wheelInit(true, box);
const down = wheelInit(false, box);

check("up scrolls back", up.deltaY === -LINES, `deltaY ${up.deltaY}`);
check("down scrolls forward", down.deltaY === LINES, `deltaY ${down.deltaY}`);
check("line mode, not pixels", up.deltaMode === 1, `deltaMode ${up.deltaMode}`);
// xterm drops a wheel carrying shiftKey, and altKey is its x5 fastScrollModifier.
check(
  "carries no modifiers",
  !("shiftKey" in up) && !("altKey" in up) && !("ctrlKey" in up) && !("metaKey" in up),
  JSON.stringify(up),
);
// getMouseReportCoords clamps rather than rejects, but aim at the pane anyway.
check("aimed at the pane centre", up.clientX === 300 && up.clientY === 150, `${up.clientX},${up.clientY}`);

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
