/** Proof that a `/model` or `/effort` slash command actually took.
 *
 * Claude Code answers each with a line naming what it set — but the echo uses
 * the model's display name ("Set model to Fable 5") where the command took an
 * id ("claude-fable-5[1m]"), so the proof matches the family word both share.
 * Value-specific on purpose: "Set model to …" lines from earlier changes pile
 * up on screen, and a bare phrase match would let any of them vouch for a pick
 * that was silently dropped. */
export function proofFor(kind: "model" | "effort", value: string): RegExp {
  // `\s*`, not spaces: the screen is matched joined across wrapped rows, and
  // xterm trims each row's trailing space — an echo wrapped at a word boundary
  // comes back as "…level tomax…". A hard wrap can land between any two words,
  // so every gap in the phrase must survive going missing. Two word orders,
  // both observed: "Set effort level to high (saved…)" but "Effort level set
  // to auto".
  if (kind === "effort")
    return new RegExp(
      `(?:set\\s*effort\\s*level\\s*to|effort\\s*level\\s*set\\s*to)\\s*${value}`,
      "i",
    );
  // "/model default" echoes the model it RESOLVED to — "Set model to Opus 5
  // (1M context) (default) and saved…" — so the anchor is the parenthesized
  // "(default)", not a family name. Parenthesized on purpose: every echo ends
  // in "saved as your default for new sessions", so a bare "default" would
  // let any old echo vouch. The second form covers a CLI that words it
  // "Set model to Default" instead.
  if (value === "default")
    return /set\s*model\s*to\s*(?:.*\(default\)|(?:claude)?[^a-z]*default)/i;
  // The family must sit right after "to" (past an optional "Claude" and any
  // version digits) — the screen is matched whole, and a looser gap would let
  // a stray mention elsewhere ("…just below maximum (Fable 5, Opus 4.7+…)")
  // vouch for a different pick.
  return new RegExp(`set\\s*model\\s*to\\s*(?:claude)?[^a-z]*${family(value)}`, "i");
}

/** "claude-fable-5[1m]" → "fable", "opus[1m]" → "opus", "default" → "default",
 * "claude-3-5-sonnet-20241022" → "sonnet" (the first run of letters) — the one
 * word an id and its display name share. */
const family = (value: string) => value.replace(/^claude-/, "").match(/[a-z]+/i)?.[0] ?? value;

/** How the pane's own status bar confirms a setting. Claude Code redraws it
 * with the CURRENT model and effort ("Fable 5 | HIGH | …"), so unlike the
 * echo it is persistent state — no scroll-off, no per-command wording. Null
 * when the status can't say: "default" shows up there as the model it
 * resolved to, and "auto" would match the "auto mode" hint that always sits
 * in those rows. */
export function statusFor(kind: "model" | "effort", value: string): RegExp | null {
  if (value === "default" || value === "auto") return null;
  return new RegExp(`\\b${kind === "model" ? family(value) : value}\\b`, "i");
}

/** The bottom `n` rows — where the status bar lives. Kept apart from the rest
 * of the screen so a family word in the transcript (or in text the user has
 * typed into the input) can't pass for the status bar's verdict. */
export const foot = (screen: string, n = 3) => screen.split("\n").slice(-n).join("\n");

/** The whole screen joined without row breaks, so an echo the pane wrapped
 * mid-word still matches. Whole-screen on purpose: proofs are value-specific,
 * so an older echo can only vouch for the same kind+value — a command that was
 * submitted anyway and lands on the value the panel already claims, which is
 * harmless. Every freshness scheme tried instead (match counting, bottom-rows
 * windows) produced false FAILURES — scroll-off cancelling the count, long
 * echoes starting above the window — and those are the harmful direction:
 * they snapped selects back and invited retries of commands that had landed. */
export const flat = (screen: string) => screen.replace(/\n/g, "");
