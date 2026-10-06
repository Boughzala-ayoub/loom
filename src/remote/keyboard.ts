/** A PC keyboard for a phone: the keys a phone keyboard lacks, Ctrl, Alt and
 * Shift held for the next key, and a box whose typing goes straight through. */
import { button, el } from "./core";

export type Mods = { ctrl: boolean; alt: boolean; shift: boolean };
export type Typed = { key: string; mods: Mods } | { text: string };
const LABELS: Record<string, string> = {
  esc: "Esc", ctrl: "Ctrl", alt: "Alt", shift: "Shift", home: "Home", up: "↑", end: "End", tab: "Tab", "shift-tab": "⇧Tab",
  "ctrl-c": "^C", backspace: "⌫", left: "←", down: "↓", right: "→", fn: "Fn", insert: "Ins", delete: "Del",
  pageup: "PgUp", pagedown: "PgDn", space: "Space", enter: "Enter",
};
const PAGES = [
  [["esc", "ctrl", "alt", "shift", "home", "up", "end"], ["tab", "shift-tab", "ctrl-c", "backspace", "left", "down", "right"], ["fn", "insert", "delete", "pageup", "pagedown", "space", "enter"]],
  [["f1", "f2", "f3", "f4", "f5", "f6", "esc"], ["f7", "f8", "f9", "f10", "f11", "f12", "tab"], ["fn", "ctrl", "alt", "shift", "left", "right", "enter"]],
];
/** A physical keyboard's keys, by the names loomctl keys takes. */
const DOM_KEYS: Record<string, string> = {
  Escape: "esc", Tab: "tab", Enter: "enter", Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};
const SENTINEL = " "; // the type box keeps one character, so Backspace always has something to delete and reaches us

/** The keys a PC has and a phone keyboard lacks; Ctrl, Alt and Shift held for
 * the next key, as on a PC; and a box whose typing goes straight through. */
export function keyboard(box: HTMLElement, hint: string, out: (t: Typed) => void) {
  const mods: Mods = { ctrl: false, alt: false, shift: false };
  let page = 0;
  const keys = el("div", "keys");
  const draw = () => keys.replaceChildren(...PAGES[page].flat().map((k) => {
    const b = button(LABELS[k] ?? k.toUpperCase(), () => press(k));
    b.dataset.key = k;
    if (k === "fn") b.setAttribute("aria-pressed", String(page === 1));
    if (k in mods) b.setAttribute("aria-pressed", String(mods[k as keyof Mods]));
    // A key leaves the focus in the type box, so the phone's keyboard stays up.
    b.onpointerdown = (e) => e.preventDefault();
    return b;
  }));
  const press = (key: string, held: Partial<Mods> = {}) => {
    if (key === "fn") return (page = 1 - page), draw();
    if (key in mods) return (mods[key as keyof Mods] = !mods[key as keyof Mods]), draw();
    out({ key, mods: { ctrl: mods.ctrl || !!held.ctrl, alt: mods.alt || !!held.alt, shift: mods.shift || !!held.shift } });
    if (mods.ctrl || mods.alt || mods.shift) (mods.ctrl = mods.alt = mods.shift = false), draw();
  };
  // Text the phone's keyboard typed: with Ctrl, Alt or Shift held, each character is a key.
  const typed = (text: string) => {
    if (mods.ctrl || mods.alt || mods.shift) for (const ch of text) press(ch === " " ? "space" : ch);
    else out({ text });
  };
  const type = el("input", "type");
  Object.assign(type, { placeholder: hint, autocapitalize: "off", spellcheck: false });
  type.setAttribute("autocomplete", "off");
  type.setAttribute("autocorrect", "off");
  type.setAttribute("aria-label", hint);
  const reset = () => { type.value = SENTINEL; type.setSelectionRange(1, 1); };
  type.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // the phone's keyboard: beforeinput says what it typed
    const named = DOM_KEYS[e.key] ?? (/^F\d\d?$/.test(e.key) ? e.key.toLowerCase() : null);
    const combo = (e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1;
    if (!named && !combo) return;
    e.preventDefault();
    press(named ?? (e.key === " " ? "space" : e.key.toLowerCase()), { ctrl: e.ctrlKey, alt: e.altKey || e.metaKey, shift: e.shiftKey && !!named });
  });
  type.addEventListener("beforeinput", (e) => {
    if (e.isComposing || e.inputType === "insertCompositionText") return;
    if (e.inputType === "insertText" && e.data) typed(e.data);
    else if (e.inputType === "deleteContentBackward") press("backspace");
    else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") press("enter");
    else return;
    e.preventDefault();
  });
  // Words the keyboard composed (suggestions, swipe typing) arrive whole when it commits them.
  type.addEventListener("compositionend", (e) => { if (e.data) typed(e.data); reset(); });
  type.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    const extra = type.value.startsWith(SENTINEL) ? type.value.slice(SENTINEL.length) : type.value;
    if (extra) typed(extra);
    reset();
  });
  type.addEventListener("focus", () => setTimeout(reset));
  type.addEventListener("blur", () => (type.value = ""));
  box.replaceChildren(type, keys);
  draw();
  return type;
}

