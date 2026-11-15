// The folder import says how many `- [ ]` lines came in as plain checkboxes (Onden tasks carry
// a `{task}` mark), so a vault's Obsidian Tasks lines are not silently left as text.
import { describe, expect, it } from "vitest";
import { plainCheckboxLines } from "../modules/importers/obsidian/import.js";

describe("plainCheckboxLines", () => {
  it("counts checkbox lines without a task mark, and those with an Obsidian Tasks date", () => {
    const md = [
      "- [ ] 交報告 📅 2026-11-07", "  - [x] 做完了 ✅ 2026-11-01", "* [ ] 無日期", "- [ ] 已是任務 {task} ^t1",
      "- 不是核取方塊", "```", "- [ ] 程式碼裡", "```", "- [ ]沒有空白",
    ].join("\n");
    expect(plainCheckboxLines(md)).toEqual({ plain: 3, dated: 2 });
    expect(plainCheckboxLines("")).toEqual({ plain: 0, dated: 0 });
  });

  it("a code fence closes only with its own kind of fence", () => {
    const md = "~~~\n```\n- [ ] in code\n~~~\n- [ ] after\n````\n```\n- [ ] still code\n````\n- [ ] last";
    expect(plainCheckboxLines(md)).toEqual({ plain: 2, dated: 0 });
  });

  it("a fence inside a list item hides its checkbox lines, and a quoted one too", () => {
    const md = "- item\n  ```\n  - [ ] in code\n  ```\n- [ ] after\n> ~~~\n> - [ ] quoted code\n> ~~~";
    expect(plainCheckboxLines(md)).toEqual({ plain: 1, dated: 0 });
  });
});
