import { describe, it, expect } from "vitest";
import { looksLikeSummary } from "./fullText";

describe("looksLikeSummary", () => {
  it("short or teaser-ending text is a summary; a long article is not", () => {
    expect(looksLikeSummary("")).toBe(true);
    expect(looksLikeSummary("<p>A short description of the post.</p>")).toBe(true);
    const long = `<p>${"A full paragraph of the article. ".repeat(40)}</p>`;
    expect(looksLikeSummary(long)).toBe(false);
    expect(looksLikeSummary(`${long}<p>Continue reading »</p>`)).toBe(true);
    expect(looksLikeSummary(`<p>${"文章內容。".repeat(200)}</p><a href="#">閱讀全文</a>`)).toBe(true);
  });
});
