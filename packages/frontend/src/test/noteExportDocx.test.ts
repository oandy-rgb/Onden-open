import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { noteExportDocx, imageInfo, type DocxMedia } from "../lib/noteExportDocx";

// 1×1 PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const picture = async (id: string): Promise<DocxMedia | null> => id === "pic.png" ? { bytes: PNG, kind: "png", width: 1, height: 1 } : null;

const NOTE = `---
title: x
---
# 標題一
## 二級 \`h2\`

段落含**粗體**、*斜體*、~~刪除線~~、\`行內程式碼\` 與 [連結](https://example.com/a) 還有[[別的筆記|別名]] 和行內數學 $a^2$。

- 無序一
  - 巢狀
- [ ] 待辦
- [x] 完成

1. 第一
2. 第二

> 引言文字

> [!warning] 小心
> callout 內文

\`\`\`ts
const a = 1;
\`\`\`

| 甲 | 乙 |
| :- | -: |
| 1 | 2 |

---

腳註[^1]

![[別的筆記]]

![圖](/api/media/pic.png)

![缺](/api/media/gone.png)

$$
E=mc^2
$$

[^1]: 註腳內容
`;

async function build(font?: "sans" | "serif") {
  const blob = await noteExportDocx({ id: "n", title: "範例筆記", markdown: NOTE }, { loadMedia: picture, font });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return { zip, doc: await zip.file("word/document.xml")!.async("string"), styles: await zip.file("word/styles.xml")!.async("string") };
}

describe("noteExportDocx", () => {
  it("maps every element to Word", async () => {
    const { zip, doc } = await build();
    expect(doc).toContain("範例筆記");
    expect(doc).toMatch(/w:pStyle w:val="Title"/);
    expect(doc).toMatch(/w:pStyle w:val="Heading1"/); expect(doc).toMatch(/w:pStyle w:val="Heading2"/);
    expect(doc).not.toContain("title: x"); // frontmatter is not body
    for (const text of ["粗體", "斜體", "刪除線", "行內程式碼", "別名", "a^2", "無序一", "巢狀", "第一", "引言文字", "const a = 1;", "E=mc^2", "↪ 別的筆記", "[缺]"]) expect(doc).toContain(text);
    expect(doc).toContain("<w:b/>"); expect(doc).toContain("<w:i/>"); expect(doc).toContain("<w:strike/>");
    expect(doc).toContain("w:hyperlink"); expect(doc).toContain('w:rStyle w:val="Hyperlink"');
    expect(doc).toContain("☐ "); expect(doc).toContain("☑ ");
    expect(doc).toContain('w:pStyle w:val="CodeBlock"');
    expect(doc).toContain("<w:tbl>"); expect(doc).toContain("<w:tblHeader/>"); expect(doc).toContain('w:jc w:val="right"');
    expect(doc).toContain("小心"); expect(doc).toContain("callout 內文");
    expect(doc).toContain("w:footnoteReference");
    expect(doc).toContain("w:numPr");
    expect(doc).toContain("<w:pBdr>"); // quote bar, rule
    expect(await zip.file("word/footnotes.xml")!.async("string")).toContain("註腳內容");
  });

  it("embeds a fetched picture and writes alt text for one it cannot fetch", async () => {
    const { zip, doc } = await build();
    expect(doc).toContain("<w:drawing>");
    expect(doc.match(/<w:drawing>/g)).toHaveLength(1);
    expect(Object.keys(zip.files).some((name) => name.startsWith("word/media/"))).toBe(true);
    expect(doc).toContain("[缺]");
    expect(doc).toContain("r:embed");
  });

  it("sets the font in styles, east-asian slot included, and never per run", async () => {
    const sans = await build();
    expect(sans.styles).toMatch(/w:rFonts[^>]*w:eastAsia="Microsoft JhengHei"/);
    expect(sans.styles).toContain('w:eastAsia="zh-TW"');
    expect(sans.doc).not.toContain("w:rFonts");
    const serif = await build("serif");
    expect(serif.styles).toMatch(/w:rFonts[^>]*w:eastAsia="PMingLiU"/);
    expect(serif.styles).not.toMatch(/w:ascii="Microsoft JhengHei"/);
  });

  it("reads picture sizes from headers", () => {
    expect(imageInfo(PNG)).toMatchObject({ kind: "png", width: 1, height: 1 });
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
