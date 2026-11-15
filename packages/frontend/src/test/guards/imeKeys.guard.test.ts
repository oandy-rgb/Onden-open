// @vitest-environment node
// Guard: a keydown handler that acts on Enter / Escape / Tab / an arrow key goes through lib/keys.ts.
// While an input method is composing, those keys belong to its candidate list (Enter picks a candidate,
// Esc closes the list, arrows move through it); a handler that acts on them anyway submits, closes or
// moves on half-typed Chinese. A handler passes when it uses isImeComposing / isEnterKey / isEscapeKey /
// onEnter, or reads CodeMirror's view.composing. Run mid-composition by e2e/fullstack/imeComposition.spec.ts.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readSource, sourceFiles } from "../a11y/sourceFiles";

const COMPOSITION_KEYS = new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const IME_AWARE = /\b(isImeComposing|isEnterKey|isEscapeKey|onEnter|isComposing|composing)\b|keyCode/;

/** Why a file's key handlers may act on these keys mid-composition: no text field is ever focused inside them. */
const NO_TEXT_FIELD: Readonly<Record<string, string>> = {
  "modules/slides/PresentationPlayer.tsx": "full-screen slide player; no text field exists while it is open",
  "components/PdfNodeView.tsx": "window-level Esc over a PDF viewer; ignores events from fields and popovers",
  "components/ui/PaneHandle.tsx": "arrow keys on a separator handle; it is not a text field",
  "components/NavLayoutEditor.tsx": "arrow keys on drag-handle buttons",
  "components/OverviewSidebar.tsx": "arrow keys on tree-row buttons (the search box has its own guarded handler)",
  "components/history/HistorySlider.tsx": "arrow keys on a range slider",
  "components/history/NoteHistory.tsx": "Enter on a paragraph button, target === currentTarget",
  "components/history/WorkspaceHistoryChanges.tsx": "arrow/Enter on list rows (data-row buttons)",
  "components/history/WorkspaceHistoryDeleted.tsx": "arrow keys on list rows (data-row buttons)",
  "components/ui/Tabs.tsx": "arrow keys on role=tab buttons",
  "modules/review/ReviewPanel.tsx": "window handler that returns early for INPUT/TEXTAREA/contenteditable targets",
  "hooks/useCanvasTools.ts": "window handler that returns early through typingInto()",
  "lib/shortcuts.ts": "chordOf only names a chord for the shortcut recorder; it acts on nothing",
};

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
}

/** Innermost function containing `node`. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

/** `x.key` reads inside a function body, paired with the function that directly holds them. */
export function keyHandlersWithoutImeGuard(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const byFunction = new Map<ts.Node, { reads: boolean; keys: Set<string> }>();
  const entry = (fn: ts.Node) => byFunction.get(fn) ?? byFunction.set(fn, { reads: false, keys: new Set() }).get(fn)!;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "key" && !/^(row|item|entry|opt|option|e2e)\b/.test(node.expression.getText())) {
      const fn = enclosingFunction(node);
      if (fn) entry(fn).reads = true;
    }
    if (ts.isStringLiteralLike(node) && COMPOSITION_KEYS.has(node.text)) {
      const fn = enclosingFunction(node);
      if (fn) entry(fn).keys.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const found: string[] = [];
  for (const [fn, { reads, keys }] of byFunction) {
    if (!reads || keys.size === 0) continue;
    if (IME_AWARE.test(fn.getText())) continue;
    const { line } = file.getLineAndCharacterOfPosition(fn.getStart());
    found.push(`${path}:${line + 1} acts on ${[...keys].join("/")}`);
  }
  return found;
}

describe("keydown handlers on Enter/Escape/Tab/arrows check for an IME composition", () => {
  const files = [...sourceFiles("components", [".tsx", ".ts"]), ...sourceFiles("modules", [".tsx", ".ts"]),
    ...sourceFiles("hooks", [".tsx", ".ts"]), ...sourceFiles("lib", [".tsx", ".ts"])]
    .filter((p) => p !== "lib/keys.ts" && !(p in NO_TEXT_FIELD));

  it("every such handler goes through lib/keys.ts", () => {
    expect(files.flatMap((p) => keyHandlersWithoutImeGuard(p, readSource(p)))).toEqual([]);
  }, 120_000); // parses every source file; 6.7 s on a hosted 2-core runner beside the other guards

  it("flags a handler that does not (so the scan itself is live)", () => {
    const bad = `const f = (e: KeyboardEvent) => { if (e.key === "Enter") submit(); };`;
    expect(keyHandlersWithoutImeGuard("x.ts", bad)).toHaveLength(1);
    const good = `const f = (e: KeyboardEvent) => { if (e.key === "Enter" && !isImeComposing(e)) submit(); };`;
    expect(keyHandlersWithoutImeGuard("x.ts", good)).toEqual([]);
  });

  it("the exemptions still name files that exist", () => {
    for (const path of Object.keys(NO_TEXT_FIELD)) expect(() => readSource(path)).not.toThrow();
  });
});
