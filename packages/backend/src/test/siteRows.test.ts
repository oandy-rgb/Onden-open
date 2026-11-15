// The rows of the site's home and tag pages (modules/website/publishing/siteRows.ts)
// and the takedown of a frozen design. No database.

import { beforeAll, describe, expect, it } from "vitest";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { cleanedChrome } from "../services/siteConfig.js";
import {
  EXCERPT_MAX, excerptOf, firstImageUrl, isoDateOf, safeImageUrl, siteRowOf, tagSlugs, takeDownDesign, viewKindFor,
} from "../modules/website/publishing/siteRows.js";
import type { SiteRow } from "@onden/site";
import { resetDayClock, setDayClock } from "../localDay.js";

const row = (id: string): SiteRow => ({ id, title: id, slug: id, date: "2026-10-01", fields: {}, image: "", excerpt: "" });

describe("viewKindFor", () => {
  // The view modules declare how a site draws their layout.
  beforeAll(registerShippedModules);

  it("maps a saved view's layout to the kind a home component draws", () => {
    expect(viewKindFor("gallery")).toBe("cards");
    expect(viewKindFor("table")).toBe("table");
    expect(viewKindFor("list")).toBe("list");
    expect(viewKindFor("calendar")).toBe("list");
    expect(viewKindFor("kanban")).toBe("list");
    expect(viewKindFor(undefined)).toBe("list");
  });
});

describe("safeImageUrl / firstImageUrl", () => {
  it("keeps https, http and site-relative URLs and drops everything else", () => {
    expect(safeImageUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(safeImageUrl("http://example.com/a.png")).toBe("http://example.com/a.png");
    expect(safeImageUrl("/api/media/ab12.png")).toBe("/api/media/ab12.png");
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/a.png", "ftp://x/a.png", "a.png", "", "https://x y"]) {
      expect(safeImageUrl(bad), bad).toBe("");
    }
  });

  it("takes the first image a page may show, markdown or <img>", () => {
    expect(firstImageUrl("text ![a](/api/media/one.png) and ![b](https://x.example/two.png)")).toBe("/api/media/one.png");
    expect(firstImageUrl("![x](javascript:alert(1))\n![y](https://x.example/ok.png)")).toBe("https://x.example/ok.png");
    expect(firstImageUrl('<img alt="" src="https://x.example/h.png">')).toBe("https://x.example/h.png");
    expect(firstImageUrl("![x](data:image/png;base64,AAAA)")).toBe("");
    expect(firstImageUrl("no image here")).toBe("");
  });

  it("ignores an image inside a code fence", () => {
    expect(firstImageUrl("```\n![x](/api/media/code.png)\n```\n![y](/api/media/real.png)")).toBe("/api/media/real.png");
  });

  it("reads a title with a parenthesis-free URL and an angle-bracket URL", () => {
    expect(firstImageUrl('![a](/api/media/t.png "A title")')).toBe("/api/media/t.png");
    expect(firstImageUrl("![a](<https://x.example/b.png>)")).toBe("https://x.example/b.png");
  });
});

describe("excerptOf", () => {
  it("is the first paragraph with prose, as plain text", () => {
    const md = "# Title\n\n![cover](/api/media/c.png)\n\nHello **world**, see [[Other|the other note]] and [a link](https://x.example).\n\nSecond paragraph.";
    expect(excerptOf(md, "Title")).toBe("Hello world, see the other note and a link.");
  });

  it("skips a heading-only and a frontmatter block, and is empty for a note with no prose", () => {
    expect(excerptOf("---\nstatus: draft\n---\n\n## Section\n\nThe prose.", "Other")).toBe("The prose.");
    expect(excerptOf("# Only a title", "Only a title")).toBe("");
    expect(excerptOf("", "")).toBe("");
  });

  it("is at most 140 characters, ellipsis included", () => {
    const long = "word ".repeat(100).trim();
    const out = excerptOf(long, "t");
    expect(out.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(excerptOf("short", "t")).toBe("short");
    expect(excerptOf("字".repeat(300), "t").length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  it("uses only the first paragraph", () => {
    expect(excerptOf("First.\n\nSecond.", "t")).toBe("First.");
  });
});

describe("siteRowOf", () => {
  const note = { id: "n1", title: "Hello", slug: "hello", markdown: "![c](/api/media/c.png)\n\nBody text.", created_at: new Date("2026-10-03T23:30:00Z") };

  it("has exactly the contract's keys", () => {
    expect(siteRowOf(note)).toEqual({
      id: "n1", title: "Hello", slug: "hello", date: "2026-10-03", fields: {}, image: "/api/media/c.png", excerpt: "Body text.",
    });
  });

  it("keeps the view's fields but never a system `_` key", () => {
    expect(siteRowOf(note, { status: "done", _published: "true", rating: null }).fields).toEqual({ status: "done", rating: null });
  });

  it("has an empty date for an unknown created date", () => {
    expect(isoDateOf(undefined)).toBe("");
    expect(isoDateOf("not a date")).toBe("");
    expect(isoDateOf("2026-01-02T03:04:05Z")).toBe("2026-01-02");
  });

  it("cuts the day on the workspace clock, not on UTC", () => {
    setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 0 });
    try {
      expect(isoDateOf("2026-01-02T19:00:00Z")).toBe("2026-01-03");
      setDayClock({ timeZone: "Asia/Taipei", dayStartHour: 4 });
      expect(isoDateOf("2026-01-02T19:00:00Z")).toBe("2026-01-02");
    } finally { resetDayClock(); }
  });
});

describe("tagSlugs", () => {
  it("slugifies the name and suffixes a clash, in the given order", () => {
    const slugs = tagSlugs([{ id: "a", name: "Photo Work" }, { id: "b", name: "photo work" }, { id: "c", name: "photo-work" }, { id: "d", name: "文章" }, { id: "e", name: "!!!" }]);
    expect([...slugs.values()]).toEqual(["photo-work", "photo-work-2", "photo-work-3", "文章", "tag"]);
  });
});

describe("takeDownDesign", () => {
  // No served page text: rows keep their frozen excerpt; typed text is not made inert.
  const served = { pages: new Map(), redact: (text: string) => text };
  const design = {
    v: 3 as const,
    legacy_home: { root: { props: {} }, content: [{ type: "stack", props: { id: "s", items: [{ type: "note", props: { id: "n", noteId: "gone" } }] } }] },
    style: {}, css: "", date_tags: [],
    resolved: { c1: [row("a"), row("b")], c2: [row("b")] },
    tag_pages: {
      t1: { name: "One", slug: "one", viewKind: "list" as const, rows: [row("a"), row("b")] },
      t2: { name: "Two", slug: "two", viewKind: "list" as const, rows: [row("b")] },
      t3: { name: "Three", slug: "three", viewKind: "list" as const, rows: [row("a")] },
    },
    tag_names: { t1: "One", t2: "Two", t3: "Three" },
  };

  it("removes rows of notes no longer published, from resolved and tag pages", () => {
    const out = takeDownDesign(design, new Set(["a"]), new Set(["t1", "t2", "t3"]), served);
    expect(out.resolved).toEqual({ c1: [row("a")], c2: [] });
    expect(out.tag_pages.t1!.rows).toEqual([row("a")]);
  });

  it("drops a tag page whose tag is no longer shown or has no rows left, and its name", () => {
    const out = takeDownDesign(design, new Set(["a"]), new Set(["t1", "t2"]), served);
    expect(Object.keys(out.tag_pages)).toEqual(["t1"]); // t2 lost its row, t3 is hidden
    expect(out.tag_names).toEqual({ t1: "One", t2: "Two" });
  });

  it("empties home note components whose note is gone, and does not change its input", () => {
    const before = structuredClone(design);
    const out = takeDownDesign(design, new Set(), new Set(), served);
    expect(out.legacy_home.content[0]!.props.items[0]!.props.noteId).toBe("");
    expect(takeDownDesign(design, new Set(["gone"]), new Set(), served).legacy_home).toEqual(design.legacy_home);
    expect(out.resolved).toEqual({ c1: [], c2: [] });
    expect(out.tag_pages).toEqual({});
    expect(design).toEqual(before);
  });

  it("makes the excerpt of a row that stays from the served page, and its field values inert again", () => {
    const frozen = { ...row("a"), excerpt: "Tied to Gone Note here", fields: { related: "see [[Gone Note]]", n: null } };
    const out = takeDownDesign({ v: 3 as const, resolved: { c: [frozen] }, tag_pages: {}, tag_names: {} }, new Set(["a"]), new Set(), {
      pages: new Map([["a", { title: "A", markdown: "# A\n\nTied to (private) here" }]]),
      redact: (text) => text.replaceAll("[[Gone Note]]", "(private)"),
    });
    expect(out.resolved.c![0]!.excerpt).toBe("Tied to (private) here");
    expect(out.resolved.c![0]!.fields).toEqual({ related: "see (private)", n: null });
  });

  it("tolerates a design with no frozen parts", () => {
    expect(takeDownDesign({ v: 3 as const }, new Set(), new Set(), served)).toEqual({ v: 3, resolved: {}, tag_pages: {}, tag_names: {} });
  });
});

describe("cleanedChrome (the chrome write)", () => {
  const dirty = {
    v: 2, rev: "r1", studio_draft: true,
    home: { root: { props: {} }, content: [
      { type: "bogus", props: { id: "x" } },
      { type: "stack", props: { id: "s1", items: [{ type: "tag_view", props: { id: "tv", tagId: "t", limit: 99, sort: "random" } }] } },
    ] },
  };

  it("moves a v2 design to v3: a home page the owner built stays as legacy_home, cleaned, and rev and studio_draft stay as sent", () => {
    type Legacy = { content: Array<{ type: string; props: { items: Array<{ props: Record<string, unknown> }> } }> };
    const out = cleanedChrome(dirty) as { v: number; rev: string; studio_draft?: true; preset: unknown; legacy_home: Legacy };
    expect(out.v).toBe(3);
    expect(out.rev).toBe("r1");
    expect(out.studio_draft).toBe(true);
    expect(out.preset).toBeNull();
    expect(out.legacy_home.content.map((c) => c.type)).toEqual(["stack"]);
    expect(out.legacy_home.content[0]!.props.items[0]!.props).toMatchObject({ limit: 12, sort: "new" });
    expect(cleanedChrome({ ...dirty, studio_draft: undefined })).not.toHaveProperty("studio_draft");
  });

  it("cleans a v3 design: a box takes only its own widgets", () => {
    const out = cleanedChrome({ v: 3, rev: "r2", studio_draft: true, preset: "garden", boxes: { "home.hero": { widget: "rss", variant: "link" }, foot: [{ widget: "rss", variant: "link" }] } }) as
      { v: number; preset: string; boxes: { "home.hero": { widget: string }; foot: unknown[] } };
    expect(out.v).toBe(3);
    expect(out.preset).toBe("garden");
    expect(out.boxes["home.hero"].widget).toBe("intro");
    expect(out.boxes.foot).toEqual([{ widget: "rss", variant: "link" }]);
  });

  it("leaves a chrome without v: 2 or 3 (the old Studio's) as sent", () => {
    const old = { blocks: [{ type: "hero" }], studio_draft: true };
    expect(cleanedChrome(old)).toBe(old);
    expect(cleanedChrome(null)).toBeNull();
  });
});
