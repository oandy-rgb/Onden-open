// @vitest-environment node
// Guard: a text box that saves when it loses focus must not lose its text when the person leaves without a blur
// (tab closed, the phone kills the app, the component unmounts). The commit on blur / Enter goes through
// hooks/useFieldDraft (or hooks/useCardDraft, which it wraps): it also commits on unmount and on page hide,
// always to the target the text was typed on. A file that puts `onBlur` on an input or textarea without either
// hook is listed below with the reason, and the list only shrinks (npm run ratchet:check).
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SRC, sourceFiles } from "./sources";

const INPUT_ELEMENTS = new Set(["input", "textarea", "TextField", "TextArea", "SearchField", "RenameInput"]);
const SHARED_HOOKS = /from\s+"(?:\.\.?\/)+(?:hooks\/)?use(?:FieldDraft|CardDraft)"/;

/** Names of input-like JSX elements in the source that have an `onBlur` attribute. */
export function blurInputs(source: string): string[] {
  const found: string[] = [];
  const file = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(file);
      const hasBlur = node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(file) === "onBlur");
      if (hasBlur && INPUT_ELEMENTS.has(name)) found.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// ratchet:list BLUR_ONLY_FIELDS
const BLUR_ONLY_FIELDS: Record<string, string> = {
  // Blur is not the save here.
  "components/MarkdownEditor.tsx": "the attribute input's blur cancels it; the editor body saves through useCardDraft's owner",
  "components/ParentCombobox.tsx": "blur only closes the list",
  "components/TitleTagRow.tsx": "blur only closes the tag suggestions",
  "components/attributes/SchemaRow.tsx": "blur only folds an empty 「新增選項」 box; a typed option is added with Enter / the button",
  "components/collections/QuickAddRow.tsx": "blur only folds an empty quick-add row",
  "components/TagsPanel.tsx": "every keystroke already patches the schema draft (useSchemaDraft, which saves on page hide); blur only derives the field key",
  "components/page/TextBoxLayer.tsx": "the text is held by the page-text controller, saved on page hide and unmount (lib/pageLayer/useLayerController)",
  // Blur commits and the draft is still lost on a page hide: not in the 2026-11 audit, move onto useFieldDraft next.
  "components/InkColorPicker.tsx": "hex code typed, applied on blur; not yet moved",
  "components/InkPresetButton.tsx": "preset rename saved on blur; not yet moved",
  "components/RenameInput.tsx": "sidebar rename: owners save in onCommit on blur; not yet moved",
  "components/attributes/MediaFieldEditor.tsx": "media link text saved on blur; not yet moved",
  "components/viewTabs/ViewTabs.tsx": "view tab rename saved on blur; not yet moved",
  "modules/skills/SkillNoteFields.tsx": "skill 'when' text saved on blur; not yet moved",
  "settings/SettingRenderer.tsx": "a setting's text value persisted on blur; not yet moved",
};

describe("a text box saved on blur also saves when it is left without one", () => {
  const files = sourceFiles(".").filter((f) => f.endsWith(".tsx"));
  const flagged = files.filter((f) => blurInputs(readFileSync(f, "utf8")).length > 0 && !SHARED_HOOKS.test(readFileSync(f, "utf8")));
  const rel = (f: string) => f.slice(SRC.length + 1).replaceAll("\\", "/");

  it("every input with onBlur uses useFieldDraft / useCardDraft, or is listed with its reason", () => {
    const unlisted = flagged.map(rel).filter((f) => !(f in BLUR_ONLY_FIELDS));
    expect(unlisted, "move the commit onto hooks/useFieldDraft (it saves on blur, unmount and page hide)").toEqual([]);
  });

  it("a listed file that no longer needs its exception is removed from the list", () => {
    const flaggedRel = new Set(flagged.map(rel));
    expect(Object.keys(BLUR_ONLY_FIELDS).filter((f) => !flaggedRel.has(f)), "remove these from BLUR_ONLY_FIELDS").toEqual([]);
  });

  it("sees an input with onBlur that does not use the hook (the guard itself works)", () => {
    expect(blurInputs(`export const A = () => <input value="" onBlur={() => save()} />;`)).toEqual(["input"]);
    expect(blurInputs(`export const A = () => <button onBlur={() => hide()} />;`)).toEqual([]);
    expect(blurInputs(`export const A = () => <TextField onChange={x} />;`)).toEqual([]);
  });
});
