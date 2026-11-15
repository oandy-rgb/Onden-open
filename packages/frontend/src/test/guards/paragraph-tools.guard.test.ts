// @vitest-environment node
// Guard: the paragraph tools stay one list, built on what exists.
//   - the function list is the catalog's (lib/tagFunctions), never a second one (`paragraphFunctions`);
//   - 「交給 AI」 is HandToAi, never an `@ai` line written into the note;
//   - there is no 「這段」 button or menu: the actions are buttons of the toolbars and the handle's menu.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_TOOLS, PARAGRAPH_TOOLS, SELECTION_TOOLS } from "../../lib/toolbarLayout";

const src = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(src, file), "utf8");

describe("paragraph tools", () => {
  it("has no second function list: lib/paragraphFunctions does not exist", () => {
    expect(existsSync(join(src, "lib/paragraphFunctions.ts"))).toBe(false);
    expect(read("components/ParagraphMenu.tsx")).not.toMatch(/lib\/paragraphFunctions/);
  });

  it("hands text to the AI through HandToAi, not an @ai line", () => {
    const menu = read("components/ParagraphMenu.tsx");
    expect(menu).toContain("HandToAiMenu");
    expect(menu).not.toMatch(/AI_MENTION_ALIAS|@ai/);
  });

  it("has no 「這段」 button: no toolbar tool by that id, and every paragraph tool is a button of both toolbars", () => {
    for (const tools of [BAR_TOOLS, SELECTION_TOOLS]) {
      const ids = tools.map((tool) => tool.id);
      expect(ids).not.toContain("paragraph");
      expect(ids).not.toContain("blockActions");
      for (const id of PARAGRAPH_TOOLS) expect(ids, id).toContain(id);
    }
  });
});
