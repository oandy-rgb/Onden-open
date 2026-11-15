import { describe, expect, it } from "vitest";
import { noteLabel } from "../lib/noteLabel";

describe("noteLabel", () => {
  it("keeps a real title", () => {
    expect(noteLabel({ title: "數學作業", markdown: "第一題" })).toBe("數學作業");
  });
  it("uses the first line of text for a placeholder or empty title", () => {
    expect(noteLabel({ title: "Untitled", markdown: "\n## 買牛奶\n其他" })).toBe("買牛奶");
    expect(noteLabel({ title: "", markdown: "- [ ] 抄生字" })).toBe("抄生字");
  });
  it("keeps the placeholder when there is no text to read", () => {
    expect(noteLabel({ title: "Untitled" })).toBe("Untitled");
    expect(noteLabel({ title: "Untitled", markdown: "  \n" })).toBe("Untitled");
  });
  it("cuts a long first line", () => {
    expect(noteLabel({ title: "", markdown: "字".repeat(100) })).toHaveLength(60);
  });
});
