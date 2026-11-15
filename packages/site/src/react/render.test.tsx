import { renderToString } from "react-dom/server";
import { Render } from "@puckeditor/core/rsc";
import { describe, expect, it } from "vitest";
import { stripLegacyIds } from "@onden/markdown";
import { withImplicitStacks } from "../topLevel.js";
import { createPuckConfig } from "./config.js";
import type { SiteRenderMeta } from "./meta.js";
import type { SiteRow } from "../rows.js";

const config = createPuckConfig();
const rowOf = (r: Pick<SiteRow, "id" | "title" | "slug"> & Partial<SiteRow>): SiteRow => ({ date: "", fields: {}, image: "", excerpt: "", ...r });
const note = (id: string, title: string, markdown: string) => ({ id, title, slug: id, markdown, date: "2026-01-02" });
/** A note whose fixture names its blocks the readable way (`text ^id`), as a published note arrives: the text
 *  without the marks, and the ids as anchors beside it (a block's identity is not in its text). */
const anchoredNote = (id: string, title: string, legacy: string) => {
  const out = stripLegacyIds(legacy);
  if ("refused" in out) throw new Error(`fixture not convertible: ${out.refused}`);
  return { ...note(id, title, out.markdown), part_anchors: out.anchors.map(({ id: anchorId, from, to }) => ({ id: anchorId, from, to })) };
};

const meta: SiteRenderMeta = {
  notes: {
    n1: note("n1", "關於我", "# 關於我\n\n我是 Andy。\n\n第二段。\n\n![封面](/api/media/a1.png)"),
    n2: anchoredNote("n2", "引言筆記", "前言\n\n一句話很重要 ^quote1\n\n結尾"),
  },
  resolved: {
    tv1: [
      rowOf({ id: "a", title: "第一篇", slug: "first", date: "2026-03-01", fields: { 狀態: "完成" }, image: "/api/media/x.png", excerpt: "摘要" }),
      rowOf({ id: "b", title: "第二篇", slug: "second" }),
    ],
    tl1: [rowOf({ id: "c", title: "事件", slug: "event", date: "2025-12-31" })],
  },
  tagNames: { t1: "專案", t2: "日誌" },
  renderMarkdown: (markdown) => <div className="md">{markdown}</div>,
  hrefFor: (slug) => `/site/${slug}/`,
};

const c = (type: string, props: Record<string, unknown>) => ({ type, props });
const html = (content: unknown[], m: SiteRenderMeta = meta) =>
  renderToString(<Render config={config} data={{ root: { props: {} }, content } as never} metadata={m} />);

describe("site render components", () => {
  it("nests slots, and every root element carries data-node", () => {
    const out = html([
      c("sidebar", {
        id: "sb", side: "right", width: "m", bg: "tint", heading: "auto", cls: "hero",
        aside: [c("note", { id: "ns", noteId: "n1", display: "first" })],
        main: [c("stack", { id: "st", items: [c("tag_view", { id: "tv1", tagId: "t1", viewKind: "list", limit: 6, sort: "new" })] })],
      }),
    ]);
    expect(out).toMatch(/<div data-node="sb"[^>]*class="s-part s-sidebar s-sidebar--right s-sidebar--m s-tint hero"/);
    // the aside holds the note, the main holds the stack, which holds the view
    expect(out).toMatch(/s-sidebar__aside"><article data-node="ns"/);
    expect(out).toMatch(/s-sidebar__main"><div data-node="st"[^>]*>.*<section data-node="tv1"/);
    expect(out).toContain('data-heading="auto"');
  });

  it("note: full, first paragraph, and card with the first image", () => {
    const full = html([c("stack", { id: "s", items: [c("note", { id: "a", noteId: "n1", display: "full" })] })]);
    expect(full).toContain("第二段。");
    const first = html([c("stack", { id: "s", items: [c("note", { id: "a", noteId: "n1", display: "first" })] })]);
    expect(first).toContain("我是 Andy。");
    expect(first).not.toContain("第二段。");
    expect(first).not.toContain("# 關於我");
    const card = html([c("cards", { id: "g", items: [c("note", { id: "a", noteId: "n1", display: "card" })] })]);
    expect(card).toContain('<a data-node="a" class="s-card" href="/site/n1/">');
    expect(card).toContain('src="/api/media/a1.png"');
    expect(card).toContain("<h3 class=\"s-card__title\">關於我</h3>");
  });

  it("note: a ^id paragraph with its source line", () => {
    const out = html([c("stack", { id: "s", items: [c("note", { id: "q", noteId: "n2", blockId: "quote1", display: "full" })] })]);
    expect(out).toContain("一句話很重要");
    expect(out).not.toContain("前言");
    expect(out).not.toContain("結尾");
    expect(out).toMatch(/<figure data-node="q" class="s-quote">/);
    expect(out).toContain('出自<a href="/site/n2/">〈引言筆記〉</a>');
  });

  it("note: an unpublished note, or an unknown block, renders nothing", () => {
    const out = html([
      c("stack", { id: "s", items: [c("note", { id: "gone", noteId: "zzz", display: "full" }), c("note", { id: "nb", noteId: "n2", blockId: "nope" })] }),
    ]);
    expect(out).not.toContain('data-node="gone"');
    expect(out).not.toContain('data-node="nb"');
    // the studio marks it instead
    expect(html([c("stack", { id: "s", items: [c("note", { id: "gone", noteId: "zzz" })] })], { ...meta, editing: true })).toContain("未發布");
  });

  it("note: title only links the title and no body", () => {
    const out = html([c("stack", { id: "s", items: [c("note", { id: "a", noteId: "n1", display: "title" })] })]);
    expect(out).toContain('<a href="/site/n1/">關於我</a>');
    expect(out).not.toContain("我是 Andy。");
  });

  it("note: in the studio an unpublished note draws its title and a 未發布 mark, never its words", () => {
    const studio: SiteRenderMeta = { ...meta, editing: true, drafts: { d1: { title: "草稿一" } } };
    const out = html([c("stack", { id: "s", items: [c("note", { id: "d", noteId: "d1", display: "full" })] })], studio);
    expect(out).toContain("草稿一");
    expect(out).toContain("未發布");
    expect(out).toContain('data-node="d"');
    // the published site has no such marker
    expect(html([c("stack", { id: "s", items: [c("note", { id: "d", noteId: "d1" })] })], { ...meta, drafts: { d1: { title: "草稿一" } } })).not.toContain("草稿一");
  });

  it("tag_view: list, cards and table", () => {
    const view = (viewKind: string, extra: Record<string, unknown> = {}) =>
      html([c("stack", { id: "s", items: [c("tag_view", { id: "tv1", tagId: "t1", viewKind, limit: 6, sort: "new", ...extra })] })]);
    const list = view("list");
    expect(list).toContain('<ul class="s-list">');
    expect(list).toContain('<a href="/site/first/">第一篇</a>');
    expect(list).toContain("專案");
    const cards = view("cards");
    expect(cards).toContain('<ul class="s-cardgrid">');
    expect(cards).toContain('src="/api/media/x.png"');
    expect(cards).toContain("摘要");
    const table = view("table");
    expect(table).toContain('<table class="s-table">');
    expect(table).toContain("<th>狀態</th>");
    expect(table).toContain("<td>完成</td>");
    expect(table).toContain("<th>日期</th>");
  });

  it("tag_view: limit and sort apply to the resolved rows", () => {
    const one = html([c("stack", { id: "s", items: [c("tag_view", { id: "tv1", tagId: "t1", viewKind: "list", limit: 1, sort: "new" })] })]);
    expect(one).toContain("第一篇");
    expect(one).not.toContain("第二篇");
    const byTitle = html([c("stack", { id: "s", items: [c("tag_view", { id: "tv1", tagId: "t1", viewKind: "list", limit: 6, sort: "title" })] })]);
    expect(byTitle.indexOf("第一篇")).toBeLessThan(byTitle.indexOf("第二篇"));
  });

  it("timeline renders an ordered list with dates", () => {
    const out = html([c("stack", { id: "s", items: [c("timeline", { id: "tl1", tagId: "t2", limit: 5 })] })]);
    expect(out).toContain('<ol class="s-timeline">');
    expect(out).toContain("2025-12-31");
    expect(out).toContain("日誌");
  });

  it("a view with no resolved rows renders nothing", () => {
    const out = html([c("stack", { id: "s", items: [c("tag_view", { id: "empty", tagId: "t1", viewKind: "list", limit: 6, sort: "new" })] })]);
    expect(out).not.toContain('data-node="empty"');
  });

  it("switcher renders only the first count slots", () => {
    const item = (id: string) => [c("note", { id, noteId: "n1", display: "card" })];
    const out = html([c("switcher", { id: "sw", count: 2, a: item("a1"), b: item("b1"), c: item("c1"), d: item("d1") })]);
    expect(out).toContain('data-node="a1"');
    expect(out).toContain('data-node="b1"');
    expect(out).not.toContain('data-node="c1"');
  });

  it("cards, cover and center carry their modifiers", () => {
    const out = html([
      c("cards", { id: "g", size: "l", items: [] }),
      c("cover", { id: "cv", height: "l", items: [] }),
      c("center", { id: "ce", width: "l", items: [] }),
    ]);
    expect(out).toContain("s-cards s-cards--l");
    expect(out).toContain("s-cover s-cover--l");
    expect(out).toContain("s-center s-center--l");
  });

  it("a pattern draws as the part it expands to, with its pre-filled slots", () => {
    const defaults = config.components.pattern_three_entries!.defaultProps as Record<string, unknown>;
    const out = html([c("pattern_three_entries", { id: "p", ...defaults, a: [c("note", { id: "x", noteId: "n1", display: "card" })] })]);
    expect(out).toContain("s-part s-switcher");
    expect(out).toContain('data-node="x"');
  });
});

describe("createPuckConfig", () => {
  it("has a component for every registry entry, with Chinese labels and categories", () => {
    expect(Object.keys(config.components).sort()).toEqual(
      ["center", "cards", "cover", "note", "pattern_intro_now", "pattern_three_entries", "pattern_timeline", "pattern_work_cards", "sidebar", "stack", "switcher", "tag_view", "timeline"].sort(),
    );
    expect(config.components.stack!.label).toBe("堆疊");
    expect(config.components.pattern_work_cards!.label).toBe("作品卡片");
    expect(Object.values(config.categories ?? {}).map((x) => x.title)).toEqual(["範本", "版面零件", "內容", "模組"]);
  });

  it("slot fields carry the nesting rules in `allow`", () => {
    const fields = config.components.stack!.fields as Record<string, { type: string; allow?: string[] }>;
    expect(fields.items).toMatchObject({ type: "slot" });
    expect(fields.items!.allow).toEqual(["note", "tag_view", "timeline", "stack", "cards", "switcher"]);
    const pattern = config.components.pattern_timeline!.fields as Record<string, { allow?: string[] }>;
    expect(pattern.items!.allow).toEqual(["note", "tag_view", "timeline"]);
  });

  it("an inner part (one with a parent) may hold content only; a switcher shows `count` slots", async () => {
    const stack = config.components.stack!;
    const resolve = stack.resolveFields as (d: unknown, p: unknown) => Record<string, { allow?: string[] }>;
    expect(resolve({ props: {} }, { parent: { type: "sidebar" } }).items!.allow).toEqual(["note", "tag_view", "timeline"]);
    expect(resolve({ props: {} }, { parent: null }).items!.allow).toContain("stack");
    const sw = config.components.switcher!.resolveFields as (d: unknown, p: unknown) => Record<string, unknown>;
    expect(Object.keys(sw({ props: { count: 3 } }, { parent: null })).filter((k) => ["a", "b", "c", "d"].includes(k))).toEqual(["a", "b", "c"]);
  });

  it("patterns pre-fill their slots", () => {
    const p = config.components.pattern_intro_now!.defaultProps as Record<string, Array<{ type: string; props: { id: string } }>>;
    expect(p.aside![0]!.type).toBe("note");
    expect(p.main![0]!.type).toBe("tag_view");
    expect(p.aside![0]!.props.id).not.toBe(p.main![0]!.props.id);
  });

  it("uses the supplied pickers for note, tag and view ids", () => {
    const note = { type: "text", label: "N" } as const;
    const custom = createPuckConfig({ fields: { note } });
    expect((custom.components.note!.fields as Record<string, unknown>).noteId).toBe(note);
  });
});

describe("content on the top level", () => {
  const stackOf = (id: string, item: ReturnType<typeof c>) =>
    c("stack", { id, bg: "none", heading: "auto", cls: "", css: "", items: [item] });
  const items = [
    c("note", { id: "a", noteId: "n1", display: "first" }),
    c("tag_view", { id: "tv1", tagId: "t1", viewKind: "list", limit: 6, sort: "new" }),
    c("timeline", { id: "tl1", tagId: "t2", limit: 6 }),
    c("note", { id: "q", noteId: "n2", blockId: "quote1", display: "full" }),
  ];
  const draw = (content: unknown[]) => html((withImplicitStacks({ root: { props: {} }, content: content as never }).content) as unknown[]);

  it("draws exactly like each one inside its own default stack", () => {
    const flat = draw(items);
    // the stack the old studio wrapped around each one, under the id the implicit one has
    const wrapped = html(items.map((item) => stackOf(`top-${item.props.id}`, item)));
    expect(flat).toBe(wrapped);
    expect(flat).toContain('class="s-part s-stack"');
    expect(flat).toContain("我是 Andy。");
  });

  it("leaves layouts as they are and mixes with them in order", () => {
    const sb = c("sidebar", { id: "sb", side: "left", width: "s", bg: "none", heading: "auto", cls: "", css: "", aside: [], main: [] });
    const out = draw([items[0], sb, items[1]]);
    expect(out.indexOf('data-node="top-a"')).toBeLessThan(out.indexOf('data-node="sb"'));
    expect(out.indexOf('data-node="sb"')).toBeLessThan(out.indexOf('data-node="top-tv1"'));
  });
});
