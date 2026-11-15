import { describe, expect, it } from "vitest";
import { importedImageLinks, importPath } from "../modules/importers/shared/imageLinks.js";

const urls = new Map<string, string | null>([
  ["課程/a/image.svg", "/api/media/red.svg"], ["課程/b/image.svg", "/api/media/blue.svg"],
  ["assets/中文 圖(1).png", "/api/media/chinese.png"], ["assets/unique.png", "/api/media/unique.png"],
  ["課程/a/broken.png", null], ["assets/broken.png", "/api/media/wrong.png"],
]);
describe("source-aware imported image links", () => {
  it("resolves note-relative and vault-root paths without basename collisions", () => {
    const links = importedImageLinks(urls);
    expect(links.rewrite("![a](image.svg) ![[課程/b/image.svg]]", "課程/a/note.md"))
      .toBe("![a](/api/media/red.svg) ![image](/api/media/blue.svg)");
    expect(links.unresolved).toBe(0);
  });
  it("an unclosed ![[ on one line leaves the next line's embed alone (a link never spans a line)", () => {
    const dir = "3.Archive（封存/Extra （額外資料/圖片";
    const links = importedImageLinks(new Map([
      [`${dir}/Pasted image 20241027003912.jpg`, "/api/media/a.jpg"],
      [`${dir}/Pasted image 20241027003046.jpg`, "/api/media/b.jpg"],
    ]));
    const body = "![[Pasted image 20241027003912.jpg\n![[Pasted image 20241027003046.jpg]]";
    expect(links.rewrite(body, "2.Area（領域/資工主內容/離散數學/Ppt離散數學.md"))
      .toBe("![[Pasted image 20241027003912.jpg\n![Pasted image 20241027003046](/api/media/b.jpg)");
    expect(links.unresolved).toBe(0);
  });
  it("links a PDF instead of embedding it, from ![[x.pdf]] and from ![](x.pdf)", () => {
    const links = importedImageLinks(new Map([["papers/exam.pdf", "/api/media/exam.pdf"]]));
    expect(links.rewrite("考卷：![[exam.pdf]] 和 ![題目](papers/exam.pdf#page=2)", "書籤.md"))
      .toBe("考卷：[exam](/api/media/exam.pdf) 和 [題目](/api/media/exam.pdf#page=2)");
    expect(links.unresolved).toBe(0);
  });
  it("keeps ambiguous shorthand and failed explicit paths instead of picking a different image", () => {
    const links = importedImageLinks(urls);
    const body = "![[image.svg]] ![broken](broken.png) ![missing](missing/image.svg)";
    expect(links.rewrite(body, "課程/a/sub/note.md")).toBe(body);
    expect(links.unresolved).toBe(3);
    expect(links.rewrite("![bad](broken.png)", "課程/a/note.md")).toBe("![bad](broken.png)");
    expect(links.unresolved).toBe(4);
    const explicit = importedImageLinks(new Map([["image.svg", "/api/media/root.svg"]]));
    const relative = "![local](./image.svg) ![[./image.svg]]";
    expect(explicit.rewrite(relative, "nested/note.md")).toBe(relative);
    expect(explicit.unresolved).toBe(2);
  });
  it("supports unique shorthand, encoded Unicode, spaces, balanced parentheses and titles", () => {
    const links = importedImageLinks(urls);
    expect(links.rewrite('![[unique.png|說明]] ![中文](<../../assets/中文 圖(1).png> "圖例")', "課程/a/note.md"))
      .toBe('![說明](/api/media/unique.png) ![中文](/api/media/chinese.png "圖例")');
    expect(links.rewrite('![x](assets/%E4%B8%AD%E6%96%87%20%E5%9C%96%281%29.png)', "note.md"))
      .toBe('![x](/api/media/chinese.png)');
    expect(links.rewrite('![x](unique.png?v=1#crop)', "note.md")).toBe('![x](/api/media/unique.png?v=1#crop)');
  });
  it("leaves fenced and inline code, escaped embeds and links, remote links and other values alone", () => {
    const links = importedImageLinks(urls);
    const body = '---\nexample: "![[unique.png]]x"\nstatus: draft\n---\n```md\n![a](image.svg)\n![[unique.png]]\n```\n`![a](image.svg)` \\![[unique.png]] \\[[unique.png]] [note](other.md) [[Some note]] ![remote](https://example.com/image.svg)';
    expect(links.rewrite(body, "課程/a/note.md")).toBe(body);
    expect(links.unresolved).toBe(0);
  });
  it("rewrites referenced images without changing the shared definition", () => {
    const links = importedImageLinks(urls);
    const body = '![picture][id] [download][id]\n\n[id]: image.svg "Title"';
    expect(links.rewrite(body, "課程/a/note.md")).toBe('![picture](/api/media/red.svg "Title") [download](/api/media/red.svg "Title")\n\n[id]: image.svg "Title"');
  });
  it("rewrites ordinary links, wikilinks and frontmatter values that name an uploaded file (D91)", () => {
    const links = importedImageLinks(new Map([
      ["attachments/x.pdf", "/api/media/new.pdf"], ["attachments/a.png", "/api/media/new.png"], ["audio/song.mp3", "/api/media/new.mp3"],
    ]));
    // An Onden export: the PDF note's pdf_url and a media field in the
    // frontmatter, a PDF link and an audio embed in the body.
    const body = '---\ntitle: Paper\npdf_url: "./attachments/x.pdf"\ncover: "[[a.png]]"\ngallery:\n  - ./attachments/a.png\n  - keep\nstatus: draft\n---\n[**the** paper](./attachments/x.pdf "PDF") ![](audio/song.mp3) [[x.pdf|讀這篇]] ![[song.mp3]] [[a.png]]\n';
    expect(links.rewrite(body, "Paper.md")).toBe(
      '---\ntitle: Paper\npdf_url: "/api/media/new.pdf"\ncover: "/api/media/new.png"\ngallery:\n  - "/api/media/new.png"\n  - keep\nstatus: draft\n---\n' +
      '[**the** paper](/api/media/new.pdf "PDF") ![](/api/media/new.mp3) [讀這篇](/api/media/new.pdf) ![song](/api/media/new.mp3) [a](/api/media/new.png)\n');
    expect(links.unresolved).toBe(0);
    // A link to a media file that was not uploaded keeps its bytes and is counted.
    expect(links.rewrite("[gone](./attachments/gone.pdf)", "Paper.md")).toBe("[gone](./attachments/gone.pdf)");
    expect(links.unresolved).toBe(1);
  });
  it("preserves case-distinct paths and refuses ambiguous case-insensitive shorthand", () => {
    const links = importedImageLinks(new Map([["A/IMAGE.png", "upper"], ["A/image.png", "lower"]]));
    expect(links.rewrite("![x](IMAGE.png) ![y](image.png)", "A/note.md")).toBe("![x](upper) ![y](lower)");
    expect(links.rewrite("![[Image.png]]", "other/note.md")).toBe("![[Image.png]]");
  });
  it("rejects upload paths outside the selected folder", () => {
    for (const path of ["../evil.png", "/root/a.png", "C:/a.png", "a\\b.png", "bad\0.png"]) expect(importPath(path)).toBeNull();
    expect(importPath("課程/./圖.png")).toBe("課程/圖.png");
  });
});
