/** The text a file drop pastes into a pane.
 *
 * Tauri's native drag-drop hands us real Windows paths, so there is nothing to
 * decode — only spaces need care, since an unquoted `C:\my files\a.png` reads
 * as two arguments at a prompt. Paths are joined with a space rather than a
 * newline: a newline reaching the pty submits the prompt.
 *
 * A plain array rather than the event, so it runs under plain node. */
export function dropText(paths: string[]): string {
  return paths
    .map((p) => p.trim())
    .filter(Boolean)
    .map(quote)
    .join(" ");
}

// ponytail: a space is the only thing worth quoting for. Add the rest of cmd's
// metacharacters when a filename with a `&` in it actually bites.
const quote = (s: string) => (s.includes(" ") && !s.startsWith('"') ? `"${s}"` : s);
