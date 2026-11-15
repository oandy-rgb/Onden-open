import { describe, expect, it } from "vitest";
import { exportPartLinks, partLinkTargets, partPlainText, type ExportedPart } from "./partLinkExport.js";

const other: ExportedPart = { noteTitle: "吃飯紀錄", text: "17:45–21:15 吃飯", anchorId: "ab12" };
const resolve = (target: string) => (target === "吃飯紀錄/17:45" ? other : null);
const text = "晚上 [[吃飯紀錄/17:45|那一餐]] 很久，另見 [[別篇/某處]]。\n";

describe("exportPartLinks", () => {
  it("text (default): the note link and the paragraph's words; unknown links stay", () => {
    expect(exportPartLinks(text, "text", resolve)).toEqual({ markdown: "晚上 [[吃飯紀錄|那一餐]]：17:45–21:15 吃飯 很久，另見 [[別篇/某處]]。\n", count: 1 });
  });
  it("footnote: the link's words plus a marker, the note's name and the paragraph in a footnote, once per part", () => {
    const out = exportPartLinks("甲 [[吃飯紀錄/17:45]] 乙 [[吃飯紀錄/17:45|再看]]\n", "footnote", resolve);
    expect(out.markdown).toBe("甲 吃飯紀錄 › 17:45–21:15 吃飯[^part-1] 乙 再看[^part-1]\n\n[^part-1]: 吃飯紀錄：17:45–21:15 吃飯\n");
    expect(out.count).toBe(2);
  });
  it("obsidian: [[筆記#^id]] to another note, and ` ^id` on a linked paragraph of this note", () => {
    const own = "第一段內容\n\n第二段 見 [[/第一段]]\n";
    const here = (target: string): ExportedPart | null => target === "/第一段" ? { noteTitle: "本篇", text: "第一段內容", anchorId: "c9", here: { from: 0, to: 5 } } : resolve(target);
    const out = exportPartLinks(own + "與 [[吃飯紀錄/17:45]]\n", "obsidian", here);
    expect(out.markdown).toBe("第一段內容 ^c9\n\n第二段 見 [[本篇#^c9]]\n與 [[吃飯紀錄#^ab12]]\n");
  });
  it("obsidian: a link typed by hand (no anchor) is written like the default; code is not touched", () => {
    const hand = (): ExportedPart => ({ noteTitle: "吃飯紀錄", text: "words", anchorId: null });
    expect(exportPartLinks("[[吃飯紀錄/words]] `[[吃飯紀錄/words]]`\n", "obsidian", hand).markdown).toBe("[[吃飯紀錄]]：words `[[吃飯紀錄/words]]`\n");
  });
});

describe("partLinkTargets / partPlainText", () => {
  it("lists the targets that can be part links, once", () => {
    expect(partLinkTargets("[[A/x]] ![[A/x]] [[B]] [[/y|別名]] [[C#^id]]")).toEqual(["A/x", "/y"]);
  });
  it("a paragraph as one line of plain words", () => {
    expect(partPlainText("- **粗體**字 {複習}\n  續行")).toBe("粗體字 續行");
  });
});
