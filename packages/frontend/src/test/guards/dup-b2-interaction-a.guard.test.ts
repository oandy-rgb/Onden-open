// @vitest-environment node
// Guard (dup batch 2, interaction a): five browser jobs have ONE owner each (allowlist, default deny).
// A file not named in an owner list may not do the job; the list says why each is there.
// Temporary exceptions are files other in-flight branches are editing; they only shrink.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const files = sourceFiles(".");

type Rule = { name: string; pattern: RegExp; owners: string[]; temporary?: string[]; violating: string; fine: string };

const RULES: Rule[] = [
  {
    name: "history pushState and popstate are hooks/useUrlLocation's",
    pattern: /\bpushState\b|["']popstate["']/,
    owners: ["hooks/useUrlLocation.ts"],
    violating: `window.history.pushState(null, "", href);`,
    fine: `window.history.replaceState(null, "", href);`,
  },
  {
    name: "a window/document keydown listener belongs to the key owners; Esc-leaves-a-surface is hooks/useEscapeKey",
    pattern: /\b(window|document)\.addEventListener\(\s*["']keydown["']|\bon(Window|Document)\(\s*["']keydown["']/,
    owners: [
      "hooks/useEscapeKey.ts", // the one Esc listener (a stack: only the newest surface answers)
      "hooks/useKeyboardShortcuts.ts", // registered shortcut chords (lib/shortcuts.ts)
      "components/ui/Modal.tsx", // keeps page keys out of an open modal
      "hooks/useEyedropper.ts", // capture-phase Esc/click while picking a colour
      "settings/ShortcutsSetting.tsx", // records the next chord, Esc cancels the recording
      "components/ShortcutsCheatsheet.tsx", // the "?" chord opens the sheet; Esc is the Modal's
      "lib/editorLinkFollow.ts", // modifier key state for link following
      // Tool chords of one surface, active only while that surface is mounted (no "leave" meaning):
      "components/KnowledgeWorkspace.tsx",
      "hooks/useBoardClipboard.ts", // ⌘D of the board (⌘C/⌘V are copy/paste events); live only while the board is on screen
      "components/PdfNodeView.tsx",
      "hooks/useCanvasTools.ts",
      "hooks/useBoardHistory.ts", // the board's one Ctrl/⌘+Z for cards and ink
      "modules/review/ReviewPanel.tsx",
      "modules/website/studio/InsertMenu.tsx",
    ],
    violating: `window.addEventListener("keydown", onKey);`, // onWindow("keydown", onKey) is the same listener
    fine: `useEscapeKey(exit, open);`,
  },
  {
    name: "coming back to the app (online, offline, visibilitychange, focus) is lib/appResume (re-check), lib/data/connectivity (connection state) or lib/pageHide (saving)",
    pattern: /(addEventListener|\bon(Window|Document))\(\s*["'](online|offline|visibilitychange|focus)["']/,
    owners: ["lib/appResume.ts", "lib/data/connectivity.ts", "lib/pageHide.ts"],
    violating: `window.addEventListener("online", recheck);`,
    fine: `onAppResume(recheck, ["online"]);`,
  },
  {
    name: "touch detection is lib/mediaQuery (primary pointer) and lib/ink/touch (touch screen present)",
    pattern: /pointer:\s*coarse|ontouchstart|maxTouchPoints/,
    owners: ["lib/mediaQuery.ts", "lib/ink/touch.ts"],
    violating: `window.matchMedia("(pointer: coarse)").matches`,
    fine: `isCoarsePointer()`,
  },
  {
    name: "visualViewport is hooks/useVirtualKeyboard's",
    pattern: /\bvisualViewport\b/,
    owners: ["hooks/useVirtualKeyboard.ts"],
    violating: `const vv = window.visualViewport;`,
    fine: `visibleViewportBottom()`,
  },
];

describe.each(RULES)("$name", (rule) => {
  it("is done by its owner only", () => {
    expect(findUses(files, rule.pattern, [...rule.owners, ...(rule.temporary ?? [])])).toEqual([]);
  });
  it("catches a violation and passes the owner's call (self-check)", () => {
    expect(rule.pattern.test(rule.violating)).toBe(true);
    expect(rule.pattern.test(rule.fine)).toBe(false);
  });
  it("lists only exceptions that still need it", () => {
    const still = new Set(findUses(files, rule.pattern).map((use) => use.split(":")[0]));
    for (const file of rule.temporary ?? []) expect(still.has(file), `${file} no longer needs its exception`).toBe(true);
    for (const file of rule.owners) expect(still.has(file), `${file} no longer needs its owner entry`).toBe(true);
  });
});
