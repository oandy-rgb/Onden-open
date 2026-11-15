import { describe, expect, it } from "vitest";
import { mentionsBundledFiles, parseSkillMd, skillMdMarkdown, skillNoteMarkdown, SkillMdError, readSkillSettings, withSkillSettings } from "./skillFile.js";
import { readFrontmatter, fieldList, fieldValue } from "./frontmatter.js";

describe("parseSkillMd", () => {
  it("reads name, description and body; hyphens in the name become spaces", () => {
    const parsed = parseSkillMd('---\nname: reading-notes\ndescription: "Write a reflection: short"\n---\n\nSummarize first.\n');
    expect(parsed).toMatchObject({ title: "reading notes", description: "Write a reflection: short", instructions: "Summarize first.", ignoredKeys: [], bundledFiles: false });
  });

  it("accepts CRLF and a byte-order mark", () => {
    const parsed = parseSkillMd("﻿---\r\nname: a-b\r\ndescription: Hi\r\n---\r\nLine one\r\nLine two\r\n");
    expect(parsed.title).toBe("a b");
    expect(parsed.instructions).toBe("Line one\nLine two");
  });

  it("reads a folded or literal description", () => {
    expect(parseSkillMd("---\nname: x\ndescription: >\n  First part\n  second part.\n---\nBody").description).toBe("First part second part.");
    expect(parseSkillMd("---\nname: x\ndescription: |\n  Line a\n  Line b\n---\nBody").description).toBe("Line a\nLine b");
  });

  it("keeps the Onden keys it knows and lists the rest", () => {
    const parsed = parseSkillMd("---\nname: x\noutput: slide\ntools: [notes, web]\napplies_to: 論文\nlicense: MIT\nallowed-tools: Bash\n---\nBody");
    expect(parsed).toMatchObject({ output: "slide", appliesTo: ["論文"] });
    expect(parsed.ignoredKeys).toEqual(["tools", "license", "allowed-tools"]);
  });

  it("an unknown output value is ignored and listed", () => {
    const parsed = parseSkillMd("---\nname: x\noutput: pdf\n---\nBody");
    expect(parsed.output).toBeUndefined();
    expect(parsed.ignoredKeys).toEqual(["output"]);
  });

  it("without frontmatter the first heading is the title", () => {
    const parsed = parseSkillMd("# Weekly review\n\nLook at the week.\n");
    expect(parsed).toMatchObject({ title: "Weekly review", instructions: "Look at the week." });
    expect(parsed.description).toBeUndefined();
  });

  it("without frontmatter or heading the first line names it", () => {
    expect(parseSkillMd("Plain instructions\nmore").title).toBe("Plain instructions");
  });

  it("an empty body is an error", () => {
    expect(() => parseSkillMd("---\nname: x\n---\n\n")).toThrow(SkillMdError);
    expect(() => parseSkillMd("  ")).toThrow(SkillMdError);
  });

  it("flags bodies that point at scripts or extra files", () => {
    expect(parseSkillMd("---\nname: x\n---\nRun `python scripts/extract.py` first.").bundledFiles).toBe(true);
    expect(parseSkillMd("---\nname: x\n---\nSee [the guide](REFERENCE.md).").bundledFiles).toBe(true);
    expect(parseSkillMd("---\nname: x\n---\nRead references/style.md.").bundledFiles).toBe(true);
    expect(parseSkillMd("---\nname: x\n---\nSee [docs](https://example.com/a.html) and [here](#top).").bundledFiles).toBe(false);
    expect(mentionsBundledFiles("Summarize the note in three points.")).toBe(false);
  });
});

describe("skillNoteMarkdown", () => {
  it("writes settings as frontmatter that the skill catalogue reads", () => {
    const md = skillNoteMarkdown({ instructions: "Do it.", description: "A: b", output: "note", appliesTo: ["#論文"] });
    const front = readFrontmatter(md)!;
    expect(fieldValue(front.entries, "description")).toBe("A: b");
    expect(fieldValue(front.entries, "output")).toBe("note");
    expect(fieldList(front.entries, "tools")).toEqual([]);
    expect(fieldList(front.entries, "applies_to")).toEqual(["論文"]);
    expect(front.body.trim()).toBe("Do it.");
  });

  it("keeps an example as a section of the body", () => {
    const md = skillNoteMarkdown({ instructions: "Q1", example: "An answer\n\n---\n\nmore", exampleHeading: "範例" });
    expect(md).toBe("Q1\n\n## 範例\n\nAn answer\n\n---\n\nmore\n");
    expect(parseSkillMd(md).instructions).toContain("## 範例");
  });
});

describe("skillMdMarkdown", () => {
  it("writes name and description as frontmatter and reads back through parseSkillMd", () => {
    const md = skillMdMarkdown({ name: "weekly-review", description: "Write: a \"short\" review", instructions: "Body line" });
    expect(md.startsWith("---\nname: weekly-review\ndescription: ")).toBe(true);
    expect(parseSkillMd(md)).toMatchObject({ description: "Write: a \"short\" review", instructions: "Body line" });
  });
});

describe("skill settings in a note", () => {
  it("reads defaults for a note with no frontmatter", () => {
    expect(readSkillSettings("Just text")).toEqual({ description: "", output: "note", appliesTo: [], ai: "auto" });
  });

  it("changes only the asked keys and keeps other lines and the body", () => {
    const before = skillNoteMarkdown({ instructions: "Do it.", description: "old", output: "slide", appliesTo: ["論文"] }).replace("---\n", "---\nlicense: MIT\n");
    const after = withSkillSettings(before, { description: "new one", appliesTo: ["論文", "#作業系統"], ai: "manual" });
    expect(readSkillSettings(after)).toEqual({ description: "new one", output: "slide", appliesTo: ["論文", "作業系統"], ai: "manual" });
    expect(after).toContain("license: MIT");
    expect(after.endsWith("Do it.\n")).toBe(true);
    // Setting the default removes the key, and a second pass is stable.
    const back = withSkillSettings(after, { ai: "auto", appliesTo: [] });
    expect(readSkillSettings(back)).toMatchObject({ ai: "auto", appliesTo: [] });
    expect(back).not.toContain("ai:");
    expect(withSkillSettings(back, { ai: "auto" })).toBe(back);
  });

  it("starts a block on a note that had none", () => {
    const md = withSkillSettings("Body here\n", { ai: "manual" });
    expect(md).toBe("---\nai: manual\n---\n\nBody here\n");
    expect(withSkillSettings(md, { ai: "auto" })).toBe("Body here\n");
  });

  it("keeps ai through SKILL.md import and export", () => {
    const parsed = parseSkillMd("---\nname: x\nai: manual\n---\nBody");
    expect(parsed.ai).toBe("manual");
    expect(parsed.ignoredKeys).toEqual([]);
    const note = skillNoteMarkdown({ instructions: parsed.instructions, ai: parsed.ai });
    expect(readSkillSettings(note).ai).toBe("manual");
    expect(skillMdMarkdown({ name: "x", description: "d", instructions: "Body", ai: "manual" })).toContain("ai: manual");
    expect(skillMdMarkdown({ name: "x", description: "d", instructions: "Body" })).not.toContain("ai:");
  });
});
