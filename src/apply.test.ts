// Self-check for the /model + /effort proof logic. Run: node src/apply.test.ts
import { proofFor, statusFor, flat, foot } from "./apply.ts";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) return console.log(`ok   ${label}`);
  console.log(`FAIL ${label}${detail ? "\n  " + detail : ""}`);
  fails++;
}

// The echoes as they land on screen (ANSI already stripped by the buffer).
const FABLE = "Set model to Fable 5 and saved as your default for new sessions";
const OPUS = "Set model to Opus 5 (1M context) and saved as your default for new sessions";
const HIGH = "Set effort level to high (saved as your default for new sessions)";

// The id the command took vs the display name the echo answers with.
check("full id with [1m] matches its echo", proofFor("model", "claude-fable-5[1m]").test(FABLE));
check("opus id matches its 1M-context echo", proofFor("model", "claude-opus-5[1m]").test(OPUS));
check("alias matches its echo", proofFor("model", "opus[1m]").test(OPUS));
// "/model default" echoes the RESOLVED model, tagged "(default)".
const DEFAULT = "Set model to Opus 5 (1M context) (default) and saved as your default for new sessions";
check("default matches its resolved-model echo", proofFor("model", "default").test(DEFAULT));
check("default matches a bare Default echo too", proofFor("model", "default").test("Set model to Default (recommended)"));
check(
  "'saved as your default' tail does not vouch for default",
  !proofFor("model", "default").test(FABLE),
);
check("opus proof accepts its (default) echo", proofFor("model", "claude-opus-5[1m]").test(DEFAULT));
check("legacy dashed id finds its family", proofFor("model", "claude-3-5-sonnet-20241022").test("Set model to Sonnet 3.5"));

// Value-specific: another value's echo must not vouch for this pick. This is
// what makes whole-screen matching safe — a stale match can only claim a value
// the submitted command lands on anyway.
check("fable proof rejects an opus echo", !proofFor("model", "claude-fable-5[1m]").test(OPUS));
check("typed command is not proof", !proofFor("model", "claude-fable-5[1m]").test("/model claude-fable-5[1m]"));
check(
  "a stray family mention elsewhere is not proof",
  !proofFor("model", "claude-fable-5[1m]").test(
    flat(`${OPUS}\njust below maximum (Fable 5, Opus 4.7+, Sonnet 5)`),
  ),
);
check(
  "display name with Claude prefix and version digits matches",
  proofFor("model", "claude-3-5-sonnet-20241022").test("Set model to Claude 3.5 Sonnet"),
);

check("effort matches its echo", proofFor("effort", "high").test(HIGH));
check("auto's flipped wording matches", proofFor("effort", "auto").test("Effort level set to auto"));
check("high does not match an xhigh echo", !proofFor("effort", "high").test("Set effort level to xhigh"));
check("xhigh does not match a high echo", !proofFor("effort", "xhigh").test(HIGH));

// The screen is matched whole and joined: an echo wrapped mid-word anywhere on
// it still counts — a bottom-rows window missed long echoes that started above
// it (the 6-line /effort max echo), and that false failure is the harmful case.
const re = proofFor("model", "claude-opus-5[1m]");
check(
  "echo wrapped mid-word matches through the join",
  re.test(flat("└  Set model to Op\nus 5 (1M context) and saved\n>")),
);
check(
  "a long echo far above the input still matches",
  re.test(flat(`└  ${OPUS}\n${"x\n".repeat(20)}> input`)),
);
check(
  "six-line wrapped effort echo matches",
  proofFor("effort", "max").test(
    flat(
      "/effort max\n└  Set effort level to\nmax (this session\nonly): Maximum capability with deepest\nreasoning. May use excessive tokens\n\n> ",
    ),
  ),
);
// xterm trims trailing spaces, so a wrap at a word boundary deletes the gap.
check(
  "wrap-eaten spaces still match",
  proofFor("effort", "high").test(flat("Set effort\nlevel to\nhigh (saved)")),
);
check(
  "wrap-eaten space does not blur high into xhigh",
  !proofFor("effort", "high").test(flat("Set effort level to\nxhigh (saved)")),
);
check("no echo anywhere, no match", !re.test(flat("plain shell output\n> ")));

// The status bar as confirmation: persistent state, no wording to chase.
const BAR = "Fable 5 | HIGH | newaa [PONYTAIL]\n▶▶ auto mode on (shift+tab to cycle)";
check("status bar confirms the model", statusFor("model", "claude-fable-5[1m]")!.test(BAR));
check("status bar confirms the effort", statusFor("effort", "high")!.test(BAR));
check("status HIGH does not pass for xhigh", !statusFor("effort", "xhigh")!.test(BAR));
check("status bar rejects another model", !statusFor("model", "claude-opus-5[1m]")!.test(BAR));
check("auto never trusts the status bar", statusFor("effort", "auto") === null, "the 'auto mode' hint always sits there");
check("default never trusts the status bar", statusFor("model", "default") === null);
check("foot is only the bottom rows", !statusFor("model", "claude-opus-5[1m]")!.test(foot(`Set model to Opus 5\nx\n${BAR}`)));

if (fails) throw new Error(`${fails} failed`);
console.log("all ok");
