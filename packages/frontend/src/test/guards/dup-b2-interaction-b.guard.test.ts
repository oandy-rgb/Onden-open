// @vitest-environment node
// Guard (dup batch 2, interaction b): long press + haptics, list keyboard navigation, pointer capture and
// drag slop, element size observation, and autosave debounce each have ONE owner (allowlist, default deny).
// A file not named in `owners` may not do the job. `temporary` are files other in-flight branches are
// editing; `reasons` are different jobs that merely look alike. Both lists only shrink.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const files = sourceFiles(".");

type Rule = {
  name: string;
  pattern: RegExp;
  owners: string[];
  /** Different jobs with a similar shape: each says why it is not the shared one. */
  reasons?: Record<string, string>;
  /** Still the old way; they move after the branch that edits them lands. */
  temporary?: string[];
  violating: string;
  fine: string;
};

const NAV_EDITOR_TEMP = "components/NavLayoutEditor.tsx"; // being changed by fix/settings-simplify
const TAG_ROW_TEMP = "components/TitleTagRow.tsx";

const RULES: Rule[] = [
  {
    name: "long-press timing and slop constants are lib/touchHold's",
    pattern: /\b(LONG_PRESS\w*|HOLD_MS|HOLD_SLOP\w*|MOVE_TOLERANCE)\s*=/,
    owners: ["lib/touchHold.ts"],
    // ratchet:list touch-hold-reasons
    reasons: { "lib/ink/engine.ts": "a pen resting to snap a stroke into a shape is not a press on a control" },
    violating: `const LONG_PRESS_MS = 500;`,
    fine: `import { LONG_PRESS_MS } from "../lib/touchHold";`,
  },
  {
    name: "the long-press hook is hooks/useLongPress",
    pattern: /function useLongPress\b/,
    owners: ["hooks/useLongPress.ts"],
    violating: `export function useLongPress(onLongPress: () => void) {`,
    fine: `import { useLongPress } from "../hooks/useLongPress";`,
  },
  {
    name: "importing useLongPress from NavLayoutEditor (it moved to hooks/useLongPress)",
    pattern: /import\s*\{[^}]*\buseLongPress\b[^}]*\}\s*from\s*["'][^"']*NavLayoutEditor["']/,
    owners: [],
    violating: `import { useLongPress } from "./NavLayoutEditor";`,
    fine: `import { useLongPress } from "../hooks/useLongPress";`,
  },
  {
    name: "navigator.vibrate is lib/haptics's vibrate()",
    pattern: /navigator\.vibrate/,
    owners: ["lib/haptics.ts"],
    violating: `navigator.vibrate?.(8);`,
    fine: `vibrate(8);`,
  },
  {
    name: "setPointerCapture is lib/pointerDrag's capturePointer()",
    pattern: /\.setPointerCapture\b/,
    owners: ["lib/pointerDrag.ts"],
    // ratchet:list pointer-capture-temporary
    temporary: [],
    violating: `e.currentTarget.setPointerCapture?.(e.pointerId);`,
    fine: `capturePointer(e.currentTarget, e.pointerId);`,
  },
  {
    name: "the drag slop is lib/pointerDrag's DRAG_SLOP_PX (a holding touch has HOLD_SLOP in lib/touchHold)",
    pattern: /\b(DRAG_SLOP\w*|MOVE_SLOP\w*)\s*=/,
    owners: ["lib/pointerDrag.ts"],
    violating: `const MOVE_SLOP_PX = 4;`,
    fine: `import { DRAG_SLOP_PX } from "../lib/pointerDrag";`,
  },
  {
    name: "a ResizeObserver is lib/observeSize's",
    pattern: /new ResizeObserver\b/,
    owners: ["lib/observeSize.ts"],
    violating: `const observer = new ResizeObserver(measure);`,
    fine: `return observeSize(el, measure);`,
  },
  {
    name: "ArrowDown moving the active option of a field-driven list is lib/listNav's stepActive",
    pattern: /\.key === ["']ArrowDown["']/,
    owners: ["lib/listNav.ts", "components/ui/usePopover.ts"],
    // ratchet:list list-nav-reasons
    reasons: {
      "components/InkColorPicker.tsx": "a slider value, not a list",
      "components/OverviewSidebar.tsx": "moves focus between tree rows, not an active option",
      "components/ParagraphMenu.tsx": "moves focus into the panel's first button",
      "components/ToolbarLayoutEditor.tsx": "reorders a list item, not an active option",
      "components/history/HistorySlider.tsx": "a slider",
      "components/history/WorkspaceHistoryChanges.tsx": "moves focus between history rows",
      "components/history/WorkspaceHistoryDeleted.tsx": "moves focus between history rows",
      "components/page/PageImageLayer.tsx": "nudges a picture, not a list",
    },
    // ratchet:list list-nav-temporary
    temporary: [NAV_EDITOR_TEMP, TAG_ROW_TEMP],
    violating: `else if (e.key === "ArrowDown") { setActive(Math.min(index + 1, n - 1)); }`,
    fine: `const next = stepActive(e.key, index, n);`,
  },
  {
    name: "closing a list when its field loses focus is not a timer (rows keep focus with onMouseDown preventDefault)",
    pattern: /onBlur=.*setTimeout\(/,
    owners: [],
    // ratchet:list list-blur-temporary
    temporary: [TAG_ROW_TEMP],
    violating: `onBlur={() => { window.setTimeout(close, 150); }}`,
    fine: `onBlur={close}`,
  },
  {
    name: "an autosave debounce is lib/persistScheduler's createSaveDebounce with a SAVE_DEBOUNCE_MS delay",
    pattern: /(save|flush|autosave|persist|draft)\w*\s*(\.current)?\s*=\s*(window\.)?setTimeout\(|(window\.)?setTimeout\(.*\b(flush|save)\w*\(/i,
    owners: ["lib/persistScheduler.ts"],
    violating: `timer.current = setTimeout(() => void flush(), 600);`,
    fine: `debounce.run(() => void flush());`,
  },
];

describe("dup batch 2 interaction b: one owner per interaction job", () => {
  for (const rule of RULES) {
    describe(rule.name, () => {
      const allowed = [...rule.owners, ...Object.keys(rule.reasons ?? {}), ...(rule.temporary ?? [])];
      it("nobody else does it", () => {
        expect(findUses(files, rule.pattern, allowed)).toEqual([]);
      });
      it("every listed exception still uses it (the list only shrinks)", () => {
        const stale = [...Object.keys(rule.reasons ?? {}), ...(rule.temporary ?? [])]
          .filter((rel) => findUses(files, rule.pattern, allowed.filter((a) => a !== rel)).every((hit) => !hit.startsWith(`${rel}:`)));
        expect(stale).toEqual([]);
      });
      it("catches a violation and accepts the fine form", () => {
        expect(rule.pattern.test(rule.violating)).toBe(true);
        expect(rule.pattern.test(rule.fine)).toBe(false);
      });
    });
  }
});
