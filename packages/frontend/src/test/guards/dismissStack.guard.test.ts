// @vitest-environment node
// Guard: Back and Esc leave a surface only through hooks/useEscapeKey.ts (useDismiss: one stack, newest first, a
// browser CloseWatcher for Back). A new menu, panel or mode that listens for Esc itself is one Back cannot close: the
// page underneath would go instead (the owner's rule, 2026-11-14). Menus and popovers get it from ui/usePopover; a
// modal from the native <dialog> in ui/Modal; a custom surface calls useDismiss while it is open.
import { describe, expect, it } from "vitest";
import { readSource, sourceFiles } from "../a11y/sourceFiles";

/** Files that are the mechanism itself, or only name the key. */
const MECHANISM: Readonly<Record<string, string>> = {
  "lib/keys.ts": "defines isEscapeKey",
  "hooks/useEscapeKey.ts": "the stack",
  "components/ui/Modal.tsx": "native <dialog>: the browser's close request is its Esc and Back",
  "components/ui/usePopover.ts": "Esc on the focused surface; registers with the stack for Back",
  "lib/shortcuts.ts": "names the key for the shortcut recorder",
  "lib/editorMathSyntax.ts": "a parser node named Escape, not a key",
};

/** Esc cancels the edit of the field that has focus (a rename, a cell, a combobox): the field owns it, and
 *  the edit is not a surface stacked over the page. */
// ratchet:list ESC_IN_FIELD
const ESC_IN_FIELD = [
  "components/FeaturedFields.tsx", "components/InkPresetButton.tsx", "components/NewTagField.tsx", "components/RenameInput.tsx",
  "components/SelectionToolbar.tsx", "components/TagDescription.tsx", "components/TimeZonePicker.tsx", "components/TitleTagRow.tsx",
  "components/attributes/CustomRow.tsx", "components/attributes/SchemaRow.tsx", "components/attributes/TextValueField.tsx",
  "components/page/PageImageLayer.tsx", "components/page/TextBoxLayer.tsx", "components/ui/SearchField.tsx",
  "components/viewTabs/ViewTabs.tsx", "modules/rss/RssDestinationFields.tsx", "modules/table/TableLayout.tsx",
  "modules/tasks/QuickAddPanel.tsx", "settings/ShortcutsSetting.tsx", "components/MarkdownEditor.tsx",
];

/** Surfaces that still close on Esc alone, so Back leaves the page instead. Only ever shorter. */
// ratchet:list ESC_ONLY_SURFACES
const ESC_ONLY_SURFACES = [
  "hooks/useEyedropper.ts", // a pick mode; Back should cancel it
  "hooks/useKeyboardShortcuts.ts", // canvas search and the create panel
  "lib/editorFind.ts", // the editor's find bar
];

/** Esc cancels a gesture in progress (a drag), which Back must not do. */
// ratchet:list ESC_GESTURES
const ESC_GESTURES = ["components/splitView/SplitDropHint.tsx", "modules/daily/day/useBlockDrag.ts"];

const ESC = /\bisEscapeKey\b|["']Escape["']/;
const files = ["components", "modules", "hooks", "lib", "settings", "pages", "App"]
  .flatMap((dir) => { try { return sourceFiles(dir, [".tsx", ".ts"]); } catch { return []; } });

describe("Esc and Back leave a surface through the one dismiss stack", () => {
  it("a file that handles Esc is the mechanism, registers with it, or is listed", () => {
    const listed = new Set([...ESC_IN_FIELD, ...ESC_ONLY_SURFACES, ...Object.keys(MECHANISM)]);
    const stray = files.filter((p) => ESC.test(readSource(p)) && !/\buseDismiss\b/.test(readSource(p)) && !listed.has(p));
    expect(stray).toEqual([]);
  });

  it("useEscapeKey (Esc only) is for gestures; a surface uses useDismiss", () => {
    const users = files.filter((p) => /\buseEscapeKey\s*\(/.test(readSource(p)) && p !== "hooks/useEscapeKey.ts");
    expect(users.filter((p) => !ESC_GESTURES.includes(p))).toEqual([]);
  });

  it("only the stack creates a CloseWatcher", () => {
    expect(files.filter((p) => /\bCloseWatcher\b/.test(readSource(p)) && p !== "hooks/useEscapeKey.ts")).toEqual([]);
  });

  it("the lists name files that still exist and still need their entry", () => {
    for (const p of [...ESC_IN_FIELD, ...ESC_ONLY_SURFACES]) expect(ESC.test(readSource(p)), `${p} no longer handles Esc: remove it from the list`).toBe(true);
    for (const p of ESC_GESTURES) expect(/\buseEscapeKey\b/.test(readSource(p)), p).toBe(true);
    for (const p of Object.keys(MECHANISM)) expect(() => readSource(p)).not.toThrow();
  });
});
