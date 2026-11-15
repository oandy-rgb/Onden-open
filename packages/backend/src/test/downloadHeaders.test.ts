import { describe, it, expect } from "vitest";
import { attachmentHeaders } from "../downloadHeaders.js";
import { containsPattern, escapeLike } from "../utils.js";

describe("attachmentHeaders", () => {
  it("keeps a Chinese title readable in filename*", () => {
    const h = attachmentHeaders("我的筆記.html", "text/html");
    expect(h["Content-Disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("我的筆記.html")}`);
    expect(h["Content-Disposition"]).toContain('filename="____.html"');
    expect(h["Content-Type"]).toBe("text/html");
  });

  it("keeps quotes, slashes and line breaks out of the header", () => {
    const v = attachmentHeaders('a"b/c\r\nSet-Cookie: x.md')["Content-Disposition"];
    expect(v).not.toMatch(/[\r\n]/);
    expect(v.match(/"/g)).toHaveLength(2);
    expect(v).not.toContain("/");
  });

  it("falls back to a name when the title is empty", () => {
    expect(attachmentHeaders("  ")["Content-Disposition"]).toContain('filename="download"');
  });
});

describe("escapeLike", () => {
  it("makes %, _ and \\ literal", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(containsPattern("100%")).toBe("%100\\%%");
  });
});

describe("attachmentHeaders length", () => {
  it("keeps a 400-character CJK title's header small and its extension", () => {
    const v = attachmentHeaders(`${"長".repeat(400)}.md`)["Content-Disposition"];
    expect(v.length).toBeLessThan(1500);
    expect(v).toContain(".md");
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(v)![1])).toBe(`${"長".repeat(117)}.md`);
  });
  it("leaves a short name untouched", () => {
    expect(attachmentHeaders("a.md")["Content-Disposition"]).toContain('filename="a.md"');
  });
});

describe("escapeLike non-strings", () => {
  it("accepts a number from a jsonb filter value", () => {
    expect(escapeLike(100)).toBe("100");
    expect(containsPattern(5)).toBe("%5%");
  });
});
