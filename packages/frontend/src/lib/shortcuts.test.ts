import { describe, it, expect, afterEach, vi } from "vitest";
import {
  SHORTCUTS, RESERVED_CHORDS, canonicalChord, chordOf, chordProblem, kbdHint, shortcutById, formatChord,
  matchShortcut, resetShortcuts, setShortcutChord, subscribeShortcuts,
} from "./shortcuts";

// Mirror the module's own platform detection so display assertions stay
// deterministic whatever env runs the suite (jsdom is non-mac, but don't bake
// that in). The chord-MATCHING logic below is platform-independent.
const IS_MAC = /mac|iphone|ipad|ipod/i.test(
  navigator.platform || navigator.userAgent || "",
);

// Minimal KeyboardEvent shape that chordOf / isEditableTarget actually read.
// A plain object is enough (and lets us inject an editable target cleanly).
function ev(init: {
  code?: string;
  key?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): KeyboardEvent {
  return {
    code: init.code ?? "",
    key: init.key ?? "",
    metaKey: !!init.mod,
    ctrlKey: false,
    shiftKey: !!init.shift,
    altKey: !!init.alt,
    target: init.target ?? null,
  } as unknown as KeyboardEvent;
}

describe("SHORTCUTS single source of truth", () => {
  it("has unique ids and unique chords", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    const chords = SHORTCUTS.map((s) => s.chord);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("shortcutById round-trips and misses cleanly", () => {
    expect(shortcutById("open-palette")?.chord).toBe("$mod+k");
    expect(shortcutById("nope")).toBeUndefined();
  });
});

describe("formatChord", () => {
  it("renders the platform modifier symbol", () => {
    const out = formatChord("$mod+k");
    expect(out).toContain("K");
    expect(out).toContain(IS_MAC ? "⌘" : "Ctrl");
  });

  it("joins with no separator on mac, '+' elsewhere", () => {
    const out = formatChord("$mod+shift+d");
    expect(out).toBe(IS_MAC ? "⌘⇧D" : "Ctrl+Shift+D");
  });

  it("passes a bare '?' through unchanged", () => {
    expect(formatChord("?")).toBe("?");
  });

  it("renders the delete chord as a glyph/word", () => {
    expect(formatChord("delete")).toBe(IS_MAC ? "⌫" : "Del");
  });
});

describe("matchShortcut — chord normalization (platform-independent)", () => {
  it("folds Cmd/Ctrl to $mod and matches via e.code", () => {
    expect(matchShortcut(ev({ code: "KeyK", key: "k", mod: true }))?.id).toBe(
      "open-palette",
    );
  });

  it("matches a multi-modifier chord ignoring e.key casing", () => {
    // Shift uppercases e.key to "N"; e.code keeps it stable.
    expect(
      matchShortcut(ev({ code: "KeyN", key: "N", mod: true, shift: true }))?.id,
    ).toBe("quick-capture");
  });

  it("returns undefined for an unbound chord", () => {
    expect(matchShortcut(ev({ code: "KeyZ", key: "z", mod: true }))).toBeUndefined();
  });
});

describe("matchShortcut — editable-target guard", () => {
  it("fires a bare-key chord ('?') outside editable fields", () => {
    expect(matchShortcut(ev({ key: "?" }))?.id).toBe("shortcuts-help");
  });

  it("suppresses a bare-key chord while a text field is focused", () => {
    const inInput = ev({ key: "?", target: { tagName: "INPUT" } });
    expect(matchShortcut(inInput)).toBeUndefined();
    const inCE = ev({ key: "?", target: { tagName: "DIV", isContentEditable: true } });
    expect(matchShortcut(inCE)).toBeUndefined();
  });

  it("still fires a command ($mod) chord while a text field is focused", () => {
    const inInput = ev({ code: "KeyS", key: "s", mod: true, target: { tagName: "TEXTAREA" } });
    expect(matchShortcut(inInput)?.id).toBe("save-draft");
  });

  it("suppresses the bare delete chord in a text field but fires it outside", () => {
    expect(matchShortcut(ev({ key: "Delete" }))?.id).toBe("delete-node");
    expect(
      matchShortcut(ev({ key: "Delete", target: { tagName: "INPUT" } })),
    ).toBeUndefined();
  });
});

// D85 — lib/shortcuts is the only key vocabulary: one grammar, one list of keys
// owned elsewhere, and the chord in effect read again when another tab
// changes it.
describe("one chord grammar", () => {
  // The event a keyboard sends for an authored chord. Letters come with their
  // code; a symbol comes as the character itself, which on US needs Shift.
  function press(chord: string, shiftForSymbol: boolean): KeyboardEvent {
    const parts = chord.split("+");
    const key = parts.pop()!;
    const named: Record<string, string> = { delete: "Delete", backspace: "Backspace", escape: "Escape", enter: "Enter", space: " " };
    const letter = /^[a-z]$/.test(key);
    const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
    return {
      code: letter ? `Key${key.toUpperCase()}` : "",
      key: named[key] ?? (letter && parts.includes("shift") ? key.toUpperCase() : key),
      metaKey: parts.includes("$mod"), ctrlKey: false,
      shiftKey: parts.includes("shift") || (symbol && shiftForSymbol),
      altKey: parts.includes("alt"),
      target: null,
    } as unknown as KeyboardEvent;
  }

  it("every authored chord is canonical and is what chordOf gives for its press", () => {
    for (const { chord } of [...SHORTCUTS, ...RESERVED_CHORDS]) {
      expect(canonicalChord(chord), chord).toBe(chord);
      expect(chordOf(press(chord, false)), chord).toBe(chord);
      expect(chordOf(press(chord, true)), chord).toBe(chord);
    }
  });

  it("drops the Shift that a symbol needs, keeps it on letters and digits", () => {
    expect(canonicalChord("shift+?")).toBe("?");
    expect(canonicalChord("shift+$mod+/")).toBe("$mod+/");
    expect(canonicalChord("alt+shift+$mod+K")).toBe("$mod+shift+alt+k");
    expect(canonicalChord("$mod+shift+1")).toBe("$mod+shift+1");
  });

  it("? opens the cheatsheet when it really comes with Shift (US Shift+/, AZERTY Shift+,)", () => {
    expect(matchShortcut(ev({ key: "?", code: "Slash", shift: true }))?.id).toBe("shortcuts-help");
    expect(matchShortcut(ev({ key: "?", code: "Comma", shift: true }))?.id).toBe("shortcuts-help");
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true }))?.id).toBe("shortcuts-help");
  });

  it("no default chord is reserved for something else", () => {
    for (const s of SHORTCUTS) expect(chordProblem(s.id, s.chord), s.id).toBeNull();
  });
});

describe("chordProblem refuses keys another part of the app answers", () => {
  afterEach(() => resetShortcuts());

  it("refuses the editor's keys (⌘B bold, ⌘⇧K delete line, ⌘↵)", () => {
    expect(chordProblem("focus-search", "$mod+b")).toEqual({ reason: "reserved", owner: "editor" });
    expect(chordProblem("focus-search", "$mod+shift+k")).toEqual({ reason: "reserved", owner: "editor" });
    expect(chordProblem("focus-search", "$mod+enter")).toEqual({ reason: "reserved", owner: "keys" });
  });

  it("refuses the whiteboard's tool letters, with or without Shift", () => {
    expect(chordProblem("new-note", "c")).toEqual({ reason: "reserved", owner: "board" });
    expect(chordProblem("new-note", "shift+c")).toEqual({ reason: "reserved", owner: "board" });
  });

  it("refuses undo / redo and the clipboard", () => {
    expect(chordProblem("new-note", "$mod+z")).toEqual({ reason: "reserved", owner: "undo" });
    expect(chordProblem("new-note", "$mod+shift+z")).toEqual({ reason: "reserved", owner: "undo" });
    expect(chordProblem("new-note", "$mod+v")).toEqual({ reason: "reserved", owner: "keys" });
  });

  it("refuses a key without a modifier, as the settings text says, but not a shortcut's own default", () => {
    expect(chordProblem("new-note", "x")).toEqual({ reason: "bare" });
    expect(chordProblem("focus-search", "shift+?")).toEqual({ reason: "bare" });
    expect(chordProblem("shortcuts-help", "shift+?")).toBeNull();
    expect(chordProblem("delete-node", "delete")).toBeNull();
    expect(chordProblem("new-note", "$mod+j")).toBeNull();
    expect(chordProblem("new-note", "shift+alt+j")).toBeNull();
  });

  it("compares a taken chord in the one grammar", () => {
    setShortcutChord("new-note", "shift+$mod+?");
    expect(shortcutById("new-note")!.chord).toBe("$mod+?"); // stored canonical, no shift
    expect(chordProblem("focus-search", "$mod+shift+?")).toMatchObject({ reason: "taken", by: { id: "new-note" } });
    setShortcutChord("new-note", "$mod+j");
    expect(chordProblem("focus-search", "$mod+J")).toMatchObject({ reason: "taken", by: { id: "new-note" } });
  });
});

describe("matchShortcut leaves a press something already handled", () => {
  it("ignores a defaultPrevented event (CodeMirror ran its own key)", () => {
    const handled = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, cancelable: true });
    handled.preventDefault();
    expect(matchShortcut(handled)).toBeUndefined();
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true }))?.id).toBe("open-palette");
  });
});

describe("kbdHint", () => {
  afterEach(() => resetShortcuts());

  it("writes the chord in effect in this platform's spelling", () => {
    expect(kbdHint("open-palette")).toBe(formatChord("$mod+k"));
    expect(kbdHint("open-palette")).toBe(IS_MAC ? "⌘K" : "Ctrl+K");
    setShortcutChord("quick-capture", "$mod+shift+j");
    expect(kbdHint("quick-capture")).toBe(IS_MAC ? "⌘⇧J" : "Ctrl+Shift+J");
    expect(kbdHint("nope")).toBe("");
  });
});

describe("changes made in another tab", () => {
  afterEach(() => resetShortcuts());

  it("re-reads the shortcuts on the storage event and tells subscribers", () => {
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    const listener = vi.fn();
    const stop = subscribeShortcuts(listener);
    // The other tab writes; this tab's cache is still the old one.
    localStorage.setItem("onden.shortcuts", JSON.stringify({ "focus-search": "$mod+shift+f" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "onden.shortcuts" }));
    stop();
    expect(listener).toHaveBeenCalled();
    expect(shortcutById("focus-search")!.chord).toBe("$mod+shift+f");
  });

  it("keeps the other tab's change when this tab writes from a stale cache", () => {
    expect(shortcutById("quick-capture")!.chord).toBe("$mod+shift+n"); // cache filled
    localStorage.setItem("onden.shortcuts", JSON.stringify({ "focus-search": "$mod+shift+f" })); // no event yet
    setShortcutChord("quick-capture", "$mod+shift+j");
    expect(JSON.parse(localStorage.getItem("onden.shortcuts")!)).toEqual({
      "focus-search": "$mod+shift+f", "quick-capture": "$mod+shift+j",
    });
  });

  it("brings an older stored chord into the grammar and drops one that is no longer allowed", () => {
    localStorage.setItem("onden.shortcuts", JSON.stringify({ "new-note": "shift+$mod+j", "focus-search": "$mod+b", "daily-note": "x" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "onden.shortcuts" }));
    expect(shortcutById("new-note")!.chord).toBe("$mod+shift+j");
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    expect(shortcutById("daily-note")!.chord).toBe("$mod+shift+d");
  });

  it("an unrelated storage key leaves the cache alone", () => {
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    localStorage.setItem("onden.shortcuts", JSON.stringify({ "focus-search": "$mod+shift+f" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
  });
});

describe("letter shortcuts follow the keycap, not the key position", () => {
  it("a Dvorak 'K' (physical KeyV) opens the palette; the key at KeyK printing 'v' does not", () => {
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "k", code: "KeyV", ctrlKey: true }))?.id).toBe("open-palette");
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "v", code: "KeyK", ctrlKey: true }))?.id).not.toBe("open-palette");
  });

  it("falls back to the physical key when the layout prints no Latin letter", () => {
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "л", code: "KeyK", ctrlKey: true }))?.id).toBe("open-palette");
  });

  it("ignores a press that is choosing an IME candidate", () => {
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "Process", code: "KeyK", ctrlKey: true, isComposing: true }))).toBeUndefined();
    expect(matchShortcut(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, keyCode: 229 }))).toBeUndefined();
  });
});
