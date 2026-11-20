// The published pages' bodies, rendered to strings without Astro: the home page
// (Puck Render with the site's metadata) with every component type, the article
// frame with each switch on and off, and the tag frame.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { defaultBoxes, defaultFrames, type SiteBoxes } from "@onden/site";
import { ArticleFrame, HomeBody, TagFrame } from "./SiteFrames";
import { readSiteData, type SiteData, type SiteSnapshot } from "./siteModel";
import type { PublishedNode } from "../templates/publishedCore";
import type { DiagramLayout } from "@onden/markdown";

const LAYOUT: DiagramLayout = {
  version: 1, kind: "flowchart", width: 200, height: 120, groups: [],
  nodes: [
    { id: "A", shape: "rect", x: 100, y: 20, w: 80, h: 30, label: "Start" },
    { id: "B", shape: "round", x: 100, y: 100, w: 80, h: 30, label: "Go" },
  ],
  edges: [{ id: "A_B", from: "A", to: "B", path: "M100,35L100,85", line: "solid", arrow_start: "none", arrow_end: "arrow", label: "", label_x: 0, label_y: 0 }],
};

beforeAll(async () => { await loadAllEnhancers(); });

const node = (id: string, title: string, markdown: string, extra: Partial<PublishedNode> = {}): PublishedNode => ({
  id, node_type: "content", title, slug: id, markdown, created_at: "2026-02-03T04:00:00Z", ...extra,
});

const nodes: PublishedNode[] = [
  node("home", "首頁", "# 首頁\n\n歡迎來到我的花園。\n\n第二段。\n\n![封面](/api/media/cover.png)"),
  node("guide", "園藝入門", "# 園藝入門\n\n![封面](/api/media/cover.png)\n\n## 土壤\n\n看 [[堆肥]] 與 [[不存在]]。\n\n### 酸鹼\n\n內文\n\n## 澆水\n\n結尾", {
    tags: ["文章", "花園"], parent_id: "series", order_key: "a2",
  }),
  node("compost", "堆肥", "# 堆肥\n\n落葉與廚餘。", { tags: ["花園"], parent_id: "series", order_key: "a3" }),
  node("seed", "播種", "# 播種\n\n春天。\n\n^quote1", { tags: ["文章"], parent_id: "series", order_key: "a1" }),
  node("series", "系列", "# 系列\n\n一組筆記。", { order_key: "a1" }),
  node("tag-garden", "花園", "# 花園\n\n與植物有關的筆記。"),
];

const rows = (...ids: string[]) => ids.map((id) => {
  const n = nodes.find((x) => x.id === id)!;
  return { id, title: n.title, slug: n.slug, date: "2026-02-03", fields: { 狀態: "完成" }, image: id === "guide" ? "/api/media/cover.png" : undefined, excerpt: `${n.title}的摘要` };
});

const c = (type: string, props: Record<string, unknown>) => ({ type, props });
const part = { bg: "none", heading: "auto", cls: "", css: "" };
const home = {
  root: { props: {} },
  content: [
    c("cover", { id: "cv", height: "m", ...part, items: [c("note", { id: "n-first", noteId: "home", blockId: "", display: "first" })] }),
    c("sidebar", {
      id: "sb", side: "left", width: "s", ...part,
      aside: [c("note", { id: "n-card", noteId: "series", blockId: "", display: "card" })],
      main: [c("stack", { id: "st", ...part, items: [c("tag_view", { id: "tv-list", tagId: "tag-garden", viewId: "", viewKind: "list", limit: 6, sort: "new" })] })],
    }),
    c("switcher", {
      id: "sw", count: 2, ...part,
      a: [c("tag_view", { id: "tv-cards", tagId: "tag-garden", viewId: "", viewKind: "cards", limit: 6, sort: "new" })],
      b: [c("tag_view", { id: "tv-table", tagId: "tag-garden", viewId: "", viewKind: "table", limit: 6, sort: "new" })],
    }),
    c("center", { id: "ce", width: "m", ...part, items: [c("note", { id: "n-full", noteId: "compost", blockId: "", display: "full" })] }),
    c("cards", { id: "cd", size: "s", ...part, items: [c("timeline", { id: "tl", tagId: "tag-garden", limit: 6, sort: "new" })] }),
  ],
};

const snapshot = (over: { design?: Record<string, unknown>; frames?: ReturnType<typeof defaultFrames> } = {}): SiteSnapshot => ({
  title: "我的花園",
  home_node_id: "home",
  payload: {
    nodes,
    edges: [
      { source_node_id: "compost", target_node_id: "guide", edge_type: "knowledge_link" },
      { source_node_id: "seed", target_node_id: "guide", edge_type: "knowledge_link" },
    ],
    presentation: {
      site: { brand: "我的花園", tagline: "慢慢長", locale: "zh-TW" },
      time_zone: "Asia/Taipei",
      design: {
        v: 2, rev: "r1", studio_draft: true, home,
        style: { preset: "quiet", base: 17, ratio: 1.25, density: "mid", head: "serif", body: "serif", accent: "#3f7d6e", radius: 4 },
        css: "", frames: over.frames ?? defaultFrames(),
        resolved: {
          "tv-list": rows("guide", "compost"), "tv-cards": rows("guide", "compost"), "tv-table": rows("guide", "compost"), tl: rows("seed"),
        },
        tag_pages: { "tag-garden": { name: "花園", slug: "garden", viewKind: "cards", rows: rows("guide", "compost") } },
        tag_names: { "tag-garden": "花園" },
        ...over.design,
      },
    },
  },
});

const data = (over?: Parameters<typeof snapshot>[0]): SiteData => readSiteData(snapshot(over));
/** A v3 design that keeps the home page above as its free-form one, with `boxes` laid over the defaults. */
const withBoxes = (boxes: Partial<SiteBoxes>, extra: Record<string, unknown> = {}): SiteData =>
  data({ design: { v: 3, preset: null, legacy_home: home, boxes: { ...defaultBoxes(), ...boxes }, date_tags: ["文章"], reading: { cover: true, preview: true }, ...extra } });
const article = (d: SiteData, id = "guide") => renderToString(<ArticleFrame data={d} node={d.nodes.find((n) => n.id === id)!} />);

describe("home page body", () => {
  const out = renderToString(<HomeBody data={data()} />);

  it("draws every component type from ids and the site's metadata", () => {
    for (const marker of ["s-cover", "s-sidebar", "s-switcher", "s-center", "s-cards", "s-view--list", "s-view--cards", "s-view--table", "s-view--timeline", "s-card"]) {
      expect(out, marker).toContain(marker);
    }
    expect(out).toContain("歡迎來到我的花園。"); // note, first paragraph
    expect(out).toContain("落葉與廚餘。"); // note, full
    expect(out).toContain("花園"); // tag name heading
  });

  it("links are anchors; nothing navigates through a button", () => {
    expect(out).toContain('href="/site/guide"');
    expect(out).toContain('href="/site/compost"');
    expect(out).not.toContain("<button");
  });
});

describe("article frame", () => {
  it("draws every part with the default switches (tree off)", () => {
    const out = article(data());
    expect(out).toContain('<h1 class="s-article__title">園藝入門</h1>');
    expect(out).toContain("s-article__cover");
    expect(out).toContain('<time class="s-date" dateTime="2026-02-03">2026-02-03</time>'); // the 文章 tag shows a date
    expect(out).toContain('href="/site/tag/garden/"'); // 花園 has a tag page
    expect(out).toContain("<span>文章</span>"); // 文章 has none: plain text
    expect(out).toContain('class="s-backlinks"');
    expect(out).toContain('rel="prev"'); // 播種 comes before in the series
    expect(out).toContain('rel="next"');
    expect(out).toContain('class="s-toc"');
    expect(out).not.toContain("s-explorer");
    // [[links]] are anchors; the heading list is the table of contents
    expect(out).toContain('<a class="published-inline-link" href="/site/compost" data-note="compost">堆肥</a>');
    expect(out).toContain('href="#user-content-土壤"');
    expect(out).not.toContain("<button");
    // the cover image leaves the body; the title line is not repeated
    expect(out.match(/<img[^>]*cover\.png/g)).toHaveLength(1);
    expect(out).not.toContain("<h1>園藝入門");
  });

  it("each box turns its widget off, and the cover and preview switches are separate", () => {
    expect(article(withBoxes({}, { reading: { cover: false, preview: true } }))).not.toContain("s-article__cover");
    const empty = article(withBoxes({ "note.meta": null }));
    expect(empty).not.toContain("s-article__meta");
    expect(empty).not.toContain("s-article__tags");
    expect(article(withBoxes({ "note.end": [] }))).not.toContain("s-backlinks");
    expect(article(withBoxes({ "note.end": [{ widget: "backlinks", variant: "quote" }] }))).not.toContain("s-prevnext");
    expect(article(withBoxes({ "note.end": [{ widget: "prevnext", variant: "links" }] }))).not.toContain("s-backlinks");
    expect(article(withBoxes({ "note.right": null }))).not.toContain("s-toc");
    expect(article(withBoxes({ "note.left": null }))).not.toContain("s-explorer");
    expect(article(withBoxes({ "note.left": null }))).toContain("s-article__title");
  });

  it("the left note tree appears when its widget is in the box, and marks the current note", () => {
    const out = article(withBoxes({ "note.left": { widget: "tree", variant: "tree" } }));
    expect(out).toContain('class="s-tree s-explorer"');
    expect(out).toContain('<a href="/site/guide" aria-current="page">');
    expect(out).toContain("s-box--note-left");
  });

  it("shows no date when the note has none of the date tags", () => {
    expect(article(data(), "compost")).not.toContain('class="s-date"');
    const dated = withBoxes({}, { date_tags: ["花園"] });
    expect(article(dated, "compost")).toContain('class="s-date"');
  });

  it("a mermaid fence stays readable code (the page has no script to draw it)", () => {
    const d = data();
    const diagram = node("diagram", "圖", "# 圖\n\n```mermaid\ngraph TD; A-->B;\n```");
    const out = renderToString(<ArticleFrame data={{ ...d, nodes: [...d.nodes, diagram] }} node={diagram} />);
    expect(out).toContain("language-mermaid");
    expect(out).toContain("graph TD; A--&gt;B;");
    expect(out).not.toContain("md-mermaid");
  });

  it("a mermaid fence with a layout from publish time is drawn from it, without any script", () => {
    const d = data();
    const source = "flowchart TD\n  A[Start] --> B[Go]";
    const layout = { ...LAYOUT, kind: "flowchart" as const };
    const diagram = node("diagram", "圖", `# 圖\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n\`\`\`mermaid\nflowchart TD\n  P --> Q\n\`\`\``);
    const withLayout = { ...d, nodes: [...d.nodes, diagram], diagrams: new Map([[source, layout]]) };
    const out = renderToString(<ArticleFrame data={withLayout} node={diagram} />);
    expect(out).toContain('<div class="md-mermaid"><svg class="dg"');
    expect(out).toContain("Start");
    expect(out).not.toMatch(/<script|foreignObject|\son\w+=/);
    // the other fence has no layout: still readable code
    expect(out).toContain("language-mermaid");
    expect(out).toContain("P --&gt; Q");
  });

  it("prints the reading time next to the date, and the 日期・標籤 look leaves it out", () => {
    expect(article(data())).toContain("約 1 分鐘讀完");
    expect(article(data(), "compost")).toContain("約 1 分鐘讀完"); // also without a date
    expect(article(withBoxes({ "note.meta": { widget: "meta", variant: "date-tags" } }))).not.toContain("s-reading");
  });
});

describe("tag frame", () => {
  const d = data();
  const page = d.design.tag_pages["tag-garden"]!;
  const out = renderToString(<TagFrame data={d} tagId="tag-garden" page={page} />);

  it("shows the tag, the tag note as description, and the rows with the shared renderer", () => {
    expect(out).toContain('<h1 class="s-tag__title">花園</h1>');
    expect(out).toContain("與植物有關的筆記。");
    expect(out).toContain("s-cardgrid"); // the tag's view kind is cards
    expect(out).toContain('href="/site/guide"');
  });

  it("leaves the description out when the tag note is not published or its box is empty", () => {
    const unpublished = readSiteData({ ...snapshot(), payload: { ...snapshot().payload, nodes: nodes.filter((n) => n.id !== "tag-garden") } });
    expect(renderToString(<TagFrame data={unpublished} tagId="tag-garden" page={page} />)).not.toContain("s-tag__description");
    const off = withBoxes({ "tag.desc": null });
    expect(renderToString(<TagFrame data={off} tagId="tag-garden" page={off.design.tag_pages["tag-garden"]!} />)).not.toContain("s-tag__description");
  });
});
