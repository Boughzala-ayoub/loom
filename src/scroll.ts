/** The wheel event Loom fakes for keyboard scrolling.
 *
 * Claude Code owns the alternate screen with mouse tracking on, so there is no
 * xterm scrollback to move — it scrolls its own transcript off encoded mouse
 * events. Synthesizing a wheel and letting xterm encode it keeps us
 * byte-identical to the real wheel whatever mouse protocol got negotiated,
 * and degrades correctly elsewhere (normal buffer → real scrollback; alt
 * screen without tracking → xterm's own arrow-key conversion).
 *
 * Modifiers are always dropped, whatever key triggered this: xterm discards a
 * wheel carrying `shiftKey` outright, and `altKey` is its `fastScrollModifier`
 * (x5). Alt+Shift+Arrow is the binding, so forwarding its modifiers would
 * prevent scrolling. */
export const LINES = 3;

export function wheelInit(
  up: boolean,
  box: { left: number; top: number; width: number; height: number },
) {
  return {
    deltaY: up ? -LINES : LINES,
    deltaMode: 1, // DOM_DELTA_LINE — skips the px math that needs cell height + dpr
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    bubbles: true,
    cancelable: true,
  };
}
