import { getPrefJson, PREFS, prefKey, removePref, setPrefJson } from "./prefs";
import { FORMAT_KEYS } from "./editorFormat";
import { isImeComposing } from "./keys";

// WU-1 — single source of truth for keyboard shortcuts.
//
// Before this module the bindings lived in two places that DRIFTED: the
// dispatcher (useKeyboardShortcuts) bound the real chords, while the command
// palette advertised a different set in its `kbd` labels (it claimed ⌘D for
// the daily note when the dispatcher actually binds ⌘⇧D, and claimed ⌘1–⌘5
// for lenses/places that were never keyboard-bound at all). SHORTCUTS below is
// now the ONE list; the dispatcher matches against it, and any displayed kbd
// (palette, cheatsheet, topbar/sidebar titles via kbdHint) must read from it so
// they can never disagree again. Code that answers one of these actions on its
// own (the palette closing on its chord, a board card saving) asks
// matchShortcut too, never a literal key test.
//
// `chord` is canonical (see canonicalChord): "$mod" stands for Cmd (mac) /
// Ctrl (other); keys are lowercase; modifiers are joined with "+" in the order
// mod, shift, alt; a symbol key carries no "shift" because the character
// already says it ("?" is Shift+/ on US and Shift+, on AZERTY). E.g. "$mod+k",
// "$mod+shift+d", "?". chordOf turns a key event into this same form. `label`
// is the English source string — render it through t() at the consumer.
//
// A person can change a chord in Settings › Keyboard shortcuts. The change is
// this device's (PREFS.shortcutOverrides, id → chord); shortcutById,
// effectiveShortcuts, kbdHint and matchShortcut all read the chord in effect,
// so the dispatcher, palette, cheatsheet and hints follow it. SHORTCUTS keeps
// the defaults. chordProblem refuses a chord that RESERVED_CHORDS gives to
// another part of the app (editor keymaps, board tools, undo, clipboard).

export type Shortcut = {
  id: string;
  label: string;
  group: "Navigate" | "Capture" | "Editor" | "View";
  chord: string;
  /** Acts only on a whiteboard: listed only while the whiteboard is imported. */
  board?: true;
  /** Also answered while a modal is open: ui/Modal lets the chord reach the
   *  page's handler, and what it opens stacks on top (⌘K in Version history
   *  opens the palette above it). Every other shortcut waits until the modal
   *  closes. */
  overModals?: true;
};

// The canonical, ACTUALLY-bound set. Order is the cheatsheet display order.
export const SHORTCUTS: Shortcut[] = [
  { id: "open-palette",     label: "Open command palette",       group: "Navigate", chord: "$mod+k", overModals: true },
  { id: "focus-search",     label: "Focus search",               group: "Navigate", chord: "$mod+f" },
  // Not $mod chords, so matchShortcut drops them while a text field (the
  // editor, where Alt+← moves the caret by word on a Mac) has focus.
  { id: "nav-back",         label: "Previous page",              group: "Navigate", chord: "alt+arrowleft" },
  { id: "nav-forward",      label: "Next page",                  group: "Navigate", chord: "alt+arrowright" },
  { id: "quick-capture",    label: "Quick capture",              group: "Capture",  chord: "$mod+shift+n" },
  { id: "daily-note",       label: "Open today's note",          group: "Capture",  chord: "$mod+shift+d" },
  { id: "new-note",         label: "Create new note",            group: "Capture",  chord: "$mod+n" },
  { id: "save-draft",       label: "Save draft",                 group: "Editor",   chord: "$mod+s" },
  { id: "toggle-edit-preview", label: "Toggle edit / preview",   group: "Editor",   chord: "$mod+e" },
  { id: "delete-node",      label: "Remove selected cards from board", group: "Editor",   chord: "delete", board: true },
  { id: "paragraph-menu",   label: "Open this paragraph's menu", group: "Editor",   chord: "alt+p" },
  { id: "focus-mode",       label: "Toggle focus mode",          group: "View",     chord: "$mod+alt+f" },
  { id: "split-view",       label: "Open side by side / close the right side", group: "View", chord: "$mod+\\" },
  { id: "toggle-sidebar",   label: "Toggle notes list",          group: "View",     chord: "$mod+shift+b" },
  { id: "toggle-inspector", label: "Toggle inspector",           group: "View",     chord: "$mod+." },
  { id: "shortcuts-help",   label: "Keyboard shortcuts",         group: "View",     chord: "?" },
];

/** The whiteboard's bare tool keys (hooks/useCanvasTools reads these; Shift
 *  picks the same tool). */
export const BOARD_TOOL_KEYS = { v: "select", c: "card", s: "section", p: "pen", e: "eraser" } as const;

/** Who already answers a reserved chord. */
export type ReservedOwner = "editor" | "board" | "undo" | "keys";

// Chords another part of the app answers, so a shortcut may not take them:
// CodeMirror handles its keys without stopping the event, and the window
// handlers below act on their own, so the shortcut and the other owner would
// both act (or the shortcut would silently lose in the editor).
export const RESERVED_CHORDS: readonly { chord: string; owner: ReservedOwner }[] = [
  // MarkdownEditor / CardNode keymaps: formatting, task promotion, then the
  // Mod/Alt chords of CodeMirror's defaultKeymap (blank line, indent, delete
  // line, matching bracket, comment, line boundary, tab focus, undo selection,
  // word delete). Its mac-only Ctrl-letter (emacs) keys are not listed: chordOf
  // folds Ctrl into $mod, and they would take ⌘K/⌘F/⌘N/⌘E from everyone.
  ...[
    ...FORMAT_KEYS.map(({ key }) => key.replace(/^Mod-/, "$mod+").toLowerCase()), "$mod+shift+enter", "$mod+enter", "$mod+[", "$mod+]",
    // Shift-Mod-\ (matching bracket) arrives as "|" on US keyboards.
    "$mod+alt+\\", "$mod+shift+k", "$mod+|", "$mod+/", "alt+a", "shift+alt+a", "alt+l",
    "$mod+m", "shift+alt+m", "$mod+shift+u", "alt+u",
    "$mod+backspace", "$mod+delete", "alt+backspace", "alt+delete",
  ].map((chord) => ({ chord, owner: "editor" as const })),
  // Whiteboard tools (hooks/useCanvasTools) and Space-to-pan while drawing.
  ...Object.keys(BOARD_TOOL_KEYS).flatMap((key) => [key, `shift+${key}`]).concat("space")
    .map((chord) => ({ chord, owner: "board" as const })),
  // Undo / redo: the editors, board card moves (useCanvasUndo), ink.
  ...["$mod+z", "$mod+shift+z", "$mod+y"].map((chord) => ({ chord, owner: "undo" as const })),
  // Select all, copy, cut, paste.
  ...["$mod+a", "$mod+c", "$mod+x", "$mod+v"].map((chord) => ({ chord, owner: "keys" as const })),
];

// Keys that keep their meaning with any modifiers: Escape closes dialogs
// everywhere; Tab and Enter move and confirm (⌘Enter sends in Ask and Quick
// capture); arrows, Home/End and Page keys move the caret or the selection.
const RESERVED_KEYS = new Set([
  "escape", "tab", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright",
  "home", "end", "pageup", "pagedown",
]);

const MODIFIERS = ["$mod", "shift", "alt"] as const;
const MODIFIER_KEYS = new Set(["", "$mod", "shift", "alt", "meta", "control"]);

// One printable character that is not a letter or digit: it already is the
// shifted (or unshifted) character, so Shift is not part of its chord.
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

function splitChord(chord: string): { mods: string[]; key: string } {
  // "+" itself can be the key: "$mod++" / "+".
  const plusKey = chord === "+" || chord.endsWith("++");
  const parts = (plusKey ? chord.slice(0, -1) : chord).split("+");
  const key = plusKey ? "+" : parts.pop() ?? "";
  return { mods: parts.filter((p) => p !== ""), key };
}

/** `chord` in the one grammar — modifiers in the order $mod, shift, alt, then
 *  the lowercase key, and no shift before a symbol. What chordOf produces; an
 *  authored or stored chord is compared only after this. */
export function canonicalChord(chord: string): string {
  const { mods, key: rawKey } = splitChord(chord);
  const key = rawKey.toLowerCase();
  const has = new Set(mods.map((m) => m.toLowerCase()));
  return [
    ...MODIFIERS.filter((m) => has.has(m) && !(m === "shift" && isSymbol(key))),
    key,
  ].join("+");
}

/** Who already answers `chord` (see RESERVED_CHORDS), or undefined. */
export function reservedOwner(chord: string): ReservedOwner | undefined {
  const c = canonicalChord(chord);
  if (RESERVED_KEYS.has(splitChord(c).key)) return "keys";
  return RESERVED_CHORDS.find((r) => r.chord === c)?.owner;
}

export type ChordProblem =
  | { reason: "modifiers_only" | "bare" }
  | { reason: "reserved"; owner: ReservedOwner }
  | { reason: "taken"; by: Shortcut };

// What is wrong with `chord` (canonical) for shortcut `id` by itself, before
// looking at the other shortcuts. A shortcut's own default is always fine, so
// "?" and Delete stay possible through Reset.
function ownProblem(id: string, chord: string): Exclude<ChordProblem, { reason: "taken" }> | null {
  const { mods, key } = splitChord(chord);
  if (MODIFIER_KEYS.has(key)) return { reason: "modifiers_only" };
  if (chord === defaultChord(id)) return null;
  const owner = reservedOwner(chord);
  if (owner) return { reason: "reserved", owner };
  // A key with no ⌘/Ctrl, Shift or Alt would fire while you meant something else.
  if (mods.length === 0) return { reason: "bare" };
  return null;
}

type Overrides = Record<string, string>;
let overridesCache: Overrides | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Read from storage once, then from the cache until this tab or another one
// changes it. A chord stored by an older version is brought into the grammar
// ("shift+?" → "?"); one that can no longer be a shortcut is dropped.
function overrides(): Overrides {
  if (overridesCache) return overridesCache;
  const raw = getPrefJson(PREFS.shortcutOverrides);
  const next: Overrides = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (defaultChord(id) === undefined || typeof value !== "string" || value === "") continue;
      const chord = canonicalChord(value);
      if (chord !== defaultChord(id) && !ownProblem(id, chord)) next[id] = chord;
    }
  }
  overridesCache = next;
  return overridesCache;
}

// Another tab changed or cleared the shortcuts: read them again and re-render.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== prefKey(PREFS.shortcutOverrides)) return;
    overridesCache = null;
    notify();
  });
}

function withChord(s: Shortcut): Shortcut {
  const chord = overrides()[s.id];
  return chord ? { ...s, chord } : s;
}

/** Every shortcut with the chord in effect on this device, in display order. */
export function effectiveShortcuts(): Shortcut[] {
  return SHORTCUTS.map(withChord);
}

/** The shortcut with the chord in effect on this device. */
export function shortcutById(id: string): Shortcut | undefined {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s && withChord(s);
}

/** The chord a shortcut has before any change. */
export function defaultChord(id: string): string | undefined {
  return SHORTCUTS.find((s) => s.id === id)?.chord;
}

/** The keys of shortcut `id` in effect, as this platform writes them ("⌘⇧N",
 *  "Ctrl+Shift+N"); "" for an unknown id. For every hint outside the
 *  cheatsheet — a title, a placeholder, a <kbd>. Components re-render on a
 *  change through hooks/useKbdHint. */
export function kbdHint(id: string): string {
  const s = shortcutById(id);
  return s ? formatChord(s.chord) : "";
}

/** Why `chord` can't be given to shortcut `id`, or null when it can. It needs a
 *  key besides modifiers; ⌘/Ctrl, Shift or Alt unless it is the shortcut's own
 *  default; no key another part of the app answers (RESERVED_CHORDS); and no
 *  other shortcut may already have it. */
export function chordProblem(id: string, chord: string): ChordProblem | null {
  const c = canonicalChord(chord);
  const own = ownProblem(id, c);
  if (own) return own;
  const by = effectiveShortcuts().find((s) => s.id !== id && s.chord === c);
  return by ? { reason: "taken", by } : null;
}

/** Give shortcut `id` a new chord on this device (null: back to its default).
 *  The caller checks chordProblem first. Storage is read again before the
 *  write, so a change another tab made meanwhile is kept. */
export function setShortcutChord(id: string, chord: string | null): void {
  overridesCache = null;
  const next = { ...overrides() };
  const c = chord === null ? null : canonicalChord(chord);
  if (c === null || c === defaultChord(id)) delete next[id]; else next[id] = c;
  overridesCache = next;
  if (Object.keys(next).length === 0) removePref(PREFS.shortcutOverrides); else setPrefJson(PREFS.shortcutOverrides, next);
  notify();
}

/** Put every shortcut back to its default on this device. */
export function resetShortcuts(): void {
  overridesCache = {};
  removePref(PREFS.shortcutOverrides);
  notify();
}

/** Re-render on a shortcut change (Settings, the cheatsheet, the palette,
 *  hints), including one made in another tab. */
export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

// Display label for a single key token (already lowercased canonical form).
function displayKey(key: string): string {
  switch (key) {
    case "$mod": return IS_MAC ? "⌘" : "Ctrl";
    case "shift": return IS_MAC ? "⇧" : "Shift";
    case "alt": return IS_MAC ? "⌥" : "Alt";
    case "delete": return IS_MAC ? "⌫" : "Del";
    case "backspace": return IS_MAC ? "⌫" : "Backspace";
    case "enter": return IS_MAC ? "↵" : "Enter";
    case "escape": return "Esc";
    case "arrowleft": return "←";
    case "arrowright": return "→";
    case "space": return "Space";
    case "\\": return "\\";
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

// Platform-aware display: mac concatenates with no separator (⌘⇧D); other
// platforms join with "+" (Ctrl+Shift+D).
export function formatChord(chord: string): string {
  const { mods, key } = splitChord(chord);
  const parts = [...mods, key].map(displayKey);
  return IS_MAC ? parts.join("") : parts.join("+");
}

// A chord is "global" (safe to fire while a text field is focused) when it is a
// command chord — i.e. it carries the $mod modifier. Bare keys ("?", "delete",
// "escape") would otherwise swallow real typing, so they only fire outside
// editable fields.
function isGlobal(chord: string): boolean {
  return chord.startsWith("$mod");
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

// Build the canonical chord string for a keyboard event so it can be compared
// against SHORTCUTS[].chord. metaKey/ctrlKey both fold to "$mod".
export function chordOf(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("$mod");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");

  // Letter keys: the letter printed on the keycap (e.key) wins, so Dvorak or
  // AZERTY users get the key the help page names, and lowercasing undoes
  // Shift's "D". Only when e.key is not a Latin letter (a Russian layout, or
  // Alt turning "d" into "∂" on a Mac) does the physical key (e.code) stand in.
  // Everything else uses the lowercased e.key; a symbol's e.key is already the
  // shifted character, and canonicalChord drops the Shift that produced it.
  let key: string;
  const code = e.code;
  if (/^[a-zA-Z]$/.test(e.key)) {
    key = e.key.toLowerCase();
  } else if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3).toLowerCase();
  } else {
    switch (e.key) {
      case "Delete": key = "delete"; break;
      case "Backspace": key = "backspace"; break;
      case "Escape": key = "escape"; break;
      case " ": key = "space"; break;
      default: key = e.key.toLowerCase();
    }
  }
  return canonicalChord([...mods, key].join("+"));
}

// Normalize the event and return the matching SHORTCUTS entry, or undefined.
// Skips bare-key chords while an editable field is focused; command chords
// ($mod) always win. An event something already handled (defaultPrevented —
// e.g. CodeMirror ran one of its own keys) is that owner's, not a shortcut:
// the defaults never collide with an editor key, and chordProblem keeps a
// changed chord off RESERVED_CHORDS, so this only stops a double action.
export function matchShortcut(e: KeyboardEvent): Shortcut | undefined {
  if (e.defaultPrevented) return undefined;
  // A key that is composing text (an IME candidate being chosen) is the IME's.
  if (isImeComposing(e)) return undefined;
  const chord = chordOf(e);
  const hit = effectiveShortcuts().find((s) => s.chord === chord);
  if (!hit) return undefined;
  if (!isGlobal(hit.chord) && isEditableTarget(e.target)) return undefined;
  return hit;
}
