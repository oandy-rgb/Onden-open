import { describe, expect, it } from "vitest";
import { parseSkillMd, skillNoteMarkdown } from "@onden/markdown";
import { renderSkillMd } from "../services/harness/index.js";
import { toSkill } from "../services/harness/noteSkills.js";

// 匯入 SKILL.md → 筆記 → 匯出 SKILL.md：名稱、description、完整正文（含範例區段）不變。
// 純函式，不需要資料庫：toSkill 是目錄讀技能筆記的同一條路徑。
const ID = "11111111-2222-3333-4444-555555555555";

/** Import `source` as a skill note, then export that note again. */
function roundTrip(source: string) {
  const parsed = parseSkillMd(source);
  const markdown = skillNoteMarkdown(parsed);
  const skill = toSkill({ id: ID, title: parsed.title, markdown, description: null, output: null });
  return { markdown, skill, exported: renderSkillMd(skill) };
}

describe("SKILL.md import → export", () => {
  it("gives back an equivalent SKILL.md", () => {
    const original = renderSkillMd({
      id: ID, name: "reading notes", description: "Write a reflection: short, in my voice",
      instructions: "Summarize first.\n\n## 範例\n\nA good result\n\n---\n\nwith a rule and [1]",
    });
    const { exported, skill } = roundTrip(original.markdown);
    expect(exported).toEqual(original);
    expect(skill.instructions).toContain("## 範例");
  });

  it("is stable for CRLF input and Onden-only keys", () => {
    const source = "---\r\nname: weekly-review\r\ndescription: Look at the week\r\noutput: slide\r\n---\r\nBody line\r\n";
    const { skill, exported } = roundTrip(source);
    expect(skill).toMatchObject({ name: "weekly review", description: "Look at the week", output: "slide", instructions: "Body line" });
    expect(exported.filename).toBe("weekly-review/SKILL.md");
    expect(exported.markdown).toBe('---\nname: weekly-review\ndescription: Look at the week\n---\n\nBody line\n');
    // Exporting what was exported changes nothing.
    expect(roundTrip(exported.markdown).exported).toEqual(exported);
  });

  it("a skill with no frontmatter keeps its instructions whole", () => {
    const { skill } = roundTrip("# Tidy up\n\nFix the headings.\n\n## Example\n\nBefore → after");
    expect(skill).toMatchObject({ name: "Tidy up", instructions: "Fix the headings.\n\n## Example\n\nBefore → after" });
  });
});
