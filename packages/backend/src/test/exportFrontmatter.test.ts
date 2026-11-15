// Pure-helper coverage for services/exportZip.ts — the lossy round-trip fix.
//
// IMPORT writes tags (node_tags) + aliases (node_attributes) + media blobs;
// EXPORT previously dropped all three from the markdown zip. These assert the
// frontmatter now re-emits tags/aliases and that media references are both
// collected (so the blob is copied) and rewritten to the local attachments/
// folder so the archive is self-contained.

import { describe, it, expect } from "vitest";
import { exportedNoteFile, relationsAsLinks, rewriteMediaLinks } from "../services/exportZip.js";
import { mediaRefs } from "@onden/markdown";
import { importedNoteContent } from "../modules/importers/markdown/note.js";
import { extractFrontmatterAttributes } from "../utils.js";

const NODE = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "my-note",
  title: '課程 "Plan": Q3',
  markdown: "",
  updated_at: "2026-06-13T00:00:00Z",
  tags: ["projects/onden", "課程"],
};

describe("export frontmatter", () => {
  it("writes one block: export fields, attributes (lists stay lists), then the body", () => {
    const file = exportedNoteFile(NODE, [{ key: "aliases", value: '["MN","Plan: Q3"]' }, { key: "status", value: "reading" }, { key: "_internal", value: "x" }], "Body text\n");
    expect(file.match(/^---$/gm)).toHaveLength(2);
    expect(file).toContain('title: "課程 \\"Plan\\": Q3"');
    expect(file).toContain("  - 課程");
    expect(file).toContain("aliases:\n  - MN\n  - \"Plan: Q3\"");
    expect(file).toContain("status: reading");
    expect(file).not.toContain("_internal");
    expect(file.endsWith("---\n\nBody text\n")).toBe(true);
  });

  it("folds a stored frontmatter into the one block instead of stacking a second", () => {
    const stored = "---\nstatus: draft\nweird line without colon\nauthor:\n  name: Ann\n---\n\nBody\n";
    const file = exportedNoteFile({ ...NODE, tags: [] }, [{ key: "status", value: "done" }], stored);
    expect(file.match(/^---$/gm)).toHaveLength(2);
    expect(file).toContain("status: done");
    expect(file).toContain("weird line without colon");
    expect(file).toContain("author:\n  name: Ann");
  });
});

describe("a note kept off the site (「不發布」) in the frontmatter", () => {
  const OFF = { key: "_published", value: "false", source: "ui" };
  const tags = { ...NODE, tags: [] };

  it("travels as `publish: false`; a note that was not kept off writes nothing", () => {
    expect(exportedNoteFile(tags, [OFF], "Body\n")).toMatch(/^publish: false$/m);
    expect(exportedNoteFile(tags, [], "Body\n")).not.toMatch(/publish/);
  });

  it("never overwrites the author's own `publish` field: it stays, and the mark goes in a key that cannot collide", () => {
    const stored = "---\npublish: draft\n---\n\nBody\n";
    const file = exportedNoteFile(tags, [OFF, { key: "publish", value: "draft", source: "frontmatter" }], stored);
    expect(file).toMatch(/^publish: draft$/m);
    expect(file).toMatch(/^onden_publish: false$/m);
    expect(file).not.toMatch(/^publish: false$/m);
    // Their own field as an attribute only (never in the stored text) is kept too.
    const fromAttribute = exportedNoteFile(tags, [OFF, { key: "publish", value: "later", source: "ui" }], "Body\n");
    expect(fromAttribute).toMatch(/^publish: later$/m);
    expect(fromAttribute).toMatch(/^onden_publish: false$/m);
  });

  it("an author's `publish: false` already says it: one line, no second key", () => {
    const file = exportedNoteFile(tags, [OFF, { key: "publish", value: "false", source: "frontmatter" }], "---\npublish: false\n---\n\nBody\n");
    expect(file.match(/^publish: false$/gm)).toHaveLength(1);
    expect(file).not.toMatch(/onden_publish/);
  });

  it("is read back from either key, and the fallback key is not left in the note", () => {
    expect(importedNoteContent("---\ntitle: T\npublish: false\n---\nB").keptOff).toBe(true);
    const fallback = importedNoteContent("---\ntitle: T\npublish: draft\nonden_publish: false\n---\nB");
    expect(fallback.keptOff).toBe(true);
    expect(fallback.markdown).toContain("publish: draft");
    expect(fallback.markdown).not.toContain("onden_publish");
    expect(importedNoteContent("---\ntitle: T\npublish: draft\n---\nB").keptOff).toBeUndefined(); // the control
  });

  it("export → import → export keeps both the author's field and the mark", () => {
    const first = exportedNoteFile(tags, [OFF, { key: "publish", value: "draft", source: "frontmatter" }], "---\npublish: draft\n---\n\nBody\n");
    const imported = importedNoteContent(first);
    expect(imported.keptOff).toBe(true);
    const attributes = [OFF, { key: "publish", value: "draft", source: "frontmatter" }];
    expect(exportedNoteFile(tags, attributes, imported.markdown)).toBe(first);
  });
});

describe("markdown.zip round trip", () => {
  it("export → import → export gives the same file (CJK tags, quoted titles, aliases, attributes)", () => {
    const attributes = [{ key: "aliases", value: '["MN","Plan: Q3"]', source: "frontmatter" }, { key: "rating", value: "5", source: "ui" }];
    const first = exportedNoteFile(NODE, attributes, "Body with [[link]]\n");

    const imported = importedNoteContent(first);
    expect(imported.title).toBe(NODE.title);
    expect(imported.tags).toEqual(NODE.tags);
    // The stored body keeps the attribute lines (they feed the attributes) but not the export's own.
    expect(imported.markdown).not.toMatch(/^(id|slug|updated_at|title|tags):/m);
    const derived = Object.entries(extractFrontmatterAttributes(imported.markdown) ?? {}).map(([key, value]) => ({ key, value }));

    const second = exportedNoteFile({ ...NODE, title: imported.title!, tags: imported.tags }, derived, imported.markdown);
    expect(second).toBe(first);
  });

  it("values with quotes, backslashes and --- survive repeated round trips; drawings stay out", () => {
    const tricky = { ...NODE, title: "Q3---plan \\ \"x\"" };
    const attributes = [{ key: "quote", value: 'say "hi" \\ there', source: "ui" }, { key: "ink_data", value: '{"version":1,"strokes":[]}', source: "explicit" }];
    let file = exportedNoteFile(tricky, attributes, "Body\n");
    expect(file).not.toContain("ink_data");
    for (let round = 0; round < 3; round++) {
      const imported = importedNoteContent(file);
      expect(imported.title).toBe(tricky.title);
      expect(imported.tags).toEqual(tricky.tags);
      const derived = Object.entries(extractFrontmatterAttributes(imported.markdown) ?? {}).map(([key, value]) => ({ key, value }));
      expect(derived.find((a) => a.key === "quote")?.value).toBe('say "hi" \\ there');
      const next = exportedNoteFile({ ...tricky, title: imported.title!, tags: imported.tags }, derived, imported.markdown);
      expect(next).toBe(file);
      file = next;
    }
  });

  it("keeps an Obsidian note's own frontmatter byte for byte (nested maps, multi-line strings, empty keys)", () => {
    const own = [
      "---",
      "title: Imported",
      "author:",
      "  name: Ann",
      "  site: x.example",
      "cssclasses:",
      "description: |",
      "  line one",
      "  line two",
      "links:",
      "  - url: a",
      "    label: b",
      "tags: [x, y]",
      "---",
      "Body",
    ].join("\n");
    const imported = importedNoteContent(own);
    expect(imported.title).toBe("Imported");
    expect(imported.tags).toEqual(["x", "y"]);
    expect(imported.markdown).toBe([
      "---", "author:", "  name: Ann", "  site: x.example", "cssclasses:", "description: |", "  line one", "  line two",
      "links:", "  - url: a", "    label: b", "---", "Body",
    ].join("\n"));
    // Shapes the codec doesn't model give no attribute instead of a wrong one.
    expect(extractFrontmatterAttributes(imported.markdown)).toEqual({});
  });

  it("a title containing --- doesn't end the frontmatter", () => {
    const imported = importedNoteContent("---\ntitle: Q3---plan\ntags:\n  - a\n---\n\nBody");
    expect(imported).toEqual({ title: "Q3---plan", tags: ["a"], markdown: "Body" });
  });

  it("keeps an author's own id, slug and updated_at (only an Onden export's are dropped)", () => {
    const own = importedNoteContent("---\ntitle: Zettel\nid: 202410140930\nslug: my-slug\nupdated_at: yesterday\n---\nBody");
    expect(own.markdown).toBe("---\nid: 202410140930\nslug: my-slug\nupdated_at: yesterday\n---\nBody");
    const fromOnden = importedNoteContent(`---\ntitle: T\nid: ${NODE.id}\nslug: t\nupdated_at: 2026-06-13T00:00:00Z\n---\n\nBody`);
    expect(fromOnden.markdown).toBe("Body");
  });

  it("an author's own id, slug and updated_at survive export → import → export", () => {
    const own = "---\ntitle: Zettel\nid: 202310141200\nslug: my-custom-slug\nupdated_at: 2023-01-01\ncreated: 2023-01-01\n---\nBody";
    const imported = importedNoteContent(own);
    const attrs = Object.entries(extractFrontmatterAttributes(imported.markdown) ?? {}).map(([key, value]) => ({ key, value, source: "frontmatter" }));
    const file = exportedNoteFile({ ...NODE, title: "Zettel", tags: [] }, attrs, imported.markdown);
    expect(file).toContain("id: 202310141200");
    expect(file).toContain("slug: my-custom-slug");
    expect(file).toContain("updated_at: 2023-01-01");
    expect(file).not.toContain(NODE.id);
    expect(file.match(/^(id|slug|updated_at):/gm)).toHaveLength(3);
    const again = importedNoteContent(file);
    expect(again.markdown).toContain("id: 202310141200");
    expect(again.markdown).toContain("created: 2023-01-01");
  });

  it("only a UUID id with a full timestamp counts as an Onden export", () => {
    expect(importedNoteContent(`---\nid: ${NODE.id}\nupdated_at: 2023-01-01\n---\nB`).markdown).toContain("updated_at: 2023-01-01");
    expect(importedNoteContent(`---\nid: ${NODE.id}\nupdated_at: 2026-10-13 22:49:45.1+00\n---\nB`).markdown).toBe("B");
  });

  it("exports only values a person set; inline, automated and computed ones stay where they come from", () => {
    const file = exportedNoteFile({ ...NODE, tags: [] }, [
      { key: "mine", value: "x", source: "ui" },
      { key: "inline", value: "y", source: "markdown" },
      { key: "auto", value: "w", source: "dispatcher" },
      { key: "fallback", value: "v", source: "derived" },
    ], "Body\n");
    expect(file).toContain("mine: x");
    expect(file).not.toMatch(/^(inline|auto|fallback):/m);
  });

  // D106: a value set through Website › Collections before the writers moved
  // to `ui` is stored as legacy `explicit` — still a person's value.
  it("exports a legacy explicit value (an older Collections edit) like a ui one", () => {
    const file = exportedNoteFile({ ...NODE, tags: [] }, [
      { key: "author", value: "王小明", source: "explicit" },
      { key: "venue", value: "SIGCSE", source: "ui" },
    ], "Body\n");
    expect(file).toContain("author: 王小明");
    expect(file).toContain("venue: SIGCSE");
  });

  // D44: one key alphabet for the UI and the frontmatter codec.
  it("a CJK attribute set in the UI survives export → import → export", () => {
    const attributes = [{ key: "作者", value: "王", source: "ui" }, { key: "標籤", value: '["讀書","筆記"]', source: "ui" }];
    const first = exportedNoteFile({ ...NODE, tags: [] }, attributes, "Body\n");
    expect(first).toContain("作者: 王\n標籤:\n  - 讀書\n  - 筆記");
    const imported = importedNoteContent(first);
    expect(extractFrontmatterAttributes(imported.markdown)).toEqual({ 作者: "王", 標籤: '["讀書","筆記"]' });
    const derived = Object.entries(extractFrontmatterAttributes(imported.markdown) ?? {}).map(([key, value]) => ({ key, value, source: "frontmatter" }));
    expect(exportedNoteFile({ ...NODE, title: imported.title!, tags: imported.tags }, derived, imported.markdown)).toBe(first);
  });

  it("an Obsidian note's CJK properties import as attributes", () => {
    const imported = importedNoteContent("---\ntitle: 讀書筆記\n作者: 王小明\n狀態: \"讀完\"\ntags: [書]\n---\n評分:: 5\n");
    expect(imported.title).toBe("讀書筆記");
    expect(imported.tags).toEqual(["書"]);
    expect(extractFrontmatterAttributes(imported.markdown)).toEqual({ 作者: "王小明", 狀態: "讀完" });
  });

  it("a key outside the grammar and a multi-line value are written quoted and read back", () => {
    const attributes = [
      { key: "Due Date", value: "2026-10-16", source: "ui" },
      { key: "a: b", value: "y", source: "ui" },
      { key: "notes", value: "first line\nsecond \"line\"\n", source: "ui" },
    ];
    const file = exportedNoteFile({ ...NODE, tags: [] }, attributes, "Body\n");
    expect(file).toContain('"Due Date": 2026-10-16');
    const imported = importedNoteContent(file);
    expect(imported.markdown).toContain('"Due Date"');
    expect(extractFrontmatterAttributes(imported.markdown)).toEqual({ "Due Date": "2026-10-16", "a: b": "y", notes: "first line\nsecond \"line\"\n" });
    // And once more: export → import → export is stable.
    expect(exportedNoteFile({ ...NODE, title: imported.title!, tags: imported.tags }, attributes, imported.markdown)).toBe(file);
  });

  it("Onden's own child: keys and _ keys still stay out of the text", () => {
    const file = exportedNoteFile({ ...NODE, tags: [] }, [{ key: "child:status", value: "x", source: "ui" }, { key: "_hidden", value: "y", source: "ui" }], "Body\n");
    expect(file).not.toContain("child:");
    expect(file).not.toContain("_hidden");
  });

  it("writes each key once: a stored CJK line and a UI edit of it, a stored block repeating a key", () => {
    const stored = "---\n作者: 李\nstatus: draft\nstatus: stale\n---\nBody\n";
    const file = exportedNoteFile({ ...NODE, tags: [] }, [{ key: "作者", value: "王", source: "ui" }, { key: "status", value: "done", source: "ui" }], stored);
    expect(file.match(/^作者:/gm)).toHaveLength(1);
    expect(file.match(/^status:/gm)).toHaveLength(1);
    expect(extractFrontmatterAttributes(importedNoteContent(file).markdown)).toEqual({ 作者: "王", status: "done" });
  });

  it("a file without frontmatter imports unchanged", () => {
    expect(importedNoteContent("# Just text\n")).toEqual({ tags: [], markdown: "# Just text\n" });
  });
});

describe("export media handling", () => {
  it("collects every distinct referenced media filename", () => {
    const body = [
      "![cover](/api/media/abc123.webp)",
      "see [doc](/api/media/deadbeef.pdf)",
      "and again ![](https://host.example/api/media/abc123.webp)",
    ].join("\n");
    const refs = mediaRefs(body).sort();
    expect(refs).toEqual(["abc123.webp", "deadbeef.pdf"]);
  });

  it("ignores path traversal in the media filename", () => {
    // A media id is one segment and never `.`/`..` — nothing escapes MEDIA_DIR.
    expect(mediaRefs("/api/media/..")).toEqual([]);
    expect(mediaRefs("/api/media/../x")).toEqual([]);
  });

  it("rewrites a whole absolute media URL, not just its path", () => {
    expect(rewriteMediaLinks("![](https://host.example/api/media/abc123.webp)")).toBe("![](./attachments/abc123.webp)");
  });

  it("rewrites scheme-relative and userinfo URLs whole and leaves a sub-path URL alone", () => {
    expect(rewriteMediaLinks("![](//h/api/media/a.png)")).toBe("![](./attachments/a.png)");
    expect(rewriteMediaLinks("![](https://u@h/api/media/a.png)")).toBe("![](./attachments/a.png)");
    expect(rewriteMediaLinks("![](https://h/sub/api/media/a.png)")).toBe("![](https://h/sub/api/media/a.png)");
  });

  it("leaves a traversal reference alone instead of pointing it outside attachments/", () => {
    expect(rewriteMediaLinks("![](/api/media/../secret.png)")).toBe("![](/api/media/../secret.png)");
  });

  it("rewrites media links to the local attachments folder", () => {
    const body = "![cover](/api/media/abc123.webp) and [doc](/api/media/x.pdf)";
    const out = rewriteMediaLinks(body);
    expect(out).toBe("![cover](./attachments/abc123.webp) and [doc](./attachments/x.pdf)");
  });
});

describe("relation values (D91)", () => {
  const A = "22222222-2222-2222-2222-222222222222", B = "33333333-3333-3333-3333-333333333333";
  const titles = new Map([[A, "Plan"], [B, "Q3 review"], [NODE.id, "a [weird] title"]]);

  it("writes a relation as [[Title]] (a list as a list) and leaves every other value alone", () => {
    const out = relationsAsLinks([
      { key: "owner", value: A, value_type: "node_ref" },
      { key: "refs", value: JSON.stringify([A, B]), value_type: "node_ref" },
      { key: "status", value: A, value_type: "text" },
    ], titles);
    expect(out.map((a) => a.value)).toEqual(["[[Plan]]", '["[[Plan]]","[[Q3 review]]"]', A]);
    const file = exportedNoteFile(NODE, out.map((a) => ({ ...a, source: "ui" })), "");
    expect(file).toContain('owner: "[[Plan]]"');
    expect(file).toContain('refs:\n  - "[[Plan]]"\n  - "[[Q3 review]]"');
  });

  it("keeps the id of a note outside the export or a title a link can't carry", () => {
    const other = "44444444-4444-4444-4444-444444444444";
    const out = relationsAsLinks([
      { key: "hidden", value: other, value_type: "node_ref" },
      { key: "weird", value: NODE.id, value_type: "node_ref" },
      { key: "mixed", value: JSON.stringify([A, other]), value_type: "node_ref" },
    ], titles);
    expect(out.map((a) => a.value)).toEqual([other, NODE.id, JSON.stringify([A, other])]);
  });
});
