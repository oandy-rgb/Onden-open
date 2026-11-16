// The box model on the published pages (docs/architecture/proposals/site-boxes-2026-11-01.md): what each
// widget draws from the published notes, when it draws nothing, how boxes fold, and
// golden output for the four home page styles × the four temperaments × light and dark.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import {
  BOX_IDS, HOME_PRESET_IDS, STYLE_PRESET_NAMES, WIDGETS, applyHomePreset, colorVars, defaultBoxes, picksOf, styleVars,
  type BoxId, type BoxPick, type HomePresetId, type SiteBoxes, type SiteStyle,
} from "@onden/site";
import { ArticleFrame, HomeBody, SiteFoot, SiteHeader, TagFrame } from "./SiteFrames";
import { readSiteData, type SiteData } from "./siteModel";
import { Box } from "./SiteWidgets";
import { boxContext } from "./SiteFrames";
import { articleFacts, footnotesOf, siteFacts, tagFacts } from "./siteWidgetData";
import type { PublishedNode } from "../templates/publishedCore";

beforeAll(async () => { await loadAllEnhancers(); });

const node = (id: string, title: string, markdown: string, extra: Partial<PublishedNode> = {}): PublishedNode => ({
  id, node_type: "content", title, slug: id, markdown, created_at: "2026-02-03T04:00:00Z", updated_at: "2026-03-01T04:00:00Z", ...extra,
});

const nodes: PublishedNode[] = [
  node("home", "首頁", "# 首頁\n\n我在這裡種花也寫字。第二句。\n\n第二段。"),
  node("guide", "園藝入門", "# 園藝入門\n\n開始前先看註腳[^a]。\n\n## 土壤\n\n看 [[堆肥]]。\n\n## 澆水\n\n內文\n\n## 光線\n\n結尾[^b]\n\n[^a]: 第一個註腳。\n[^b]: 第二個註腳。", {
    tags: ["文章", "花園", "常青"], parent_id: "series", order_key: "a2", updated_at: "2025-12-20T04:00:00Z", created_at: "2025-12-01T04:00:00Z",
  }),
  node("compost", "堆肥", "# 堆肥\n\n落葉與廚餘，見 [[園藝入門]]。", { tags: ["花園", "精選", "幼苗"], parent_id: "series", order_key: "a3", updated_at: "2026-03-05T04:00:00Z" }),
  node("seed", "播種", "# 播種\n\n春天。", { tags: ["文章"], parent_id: "series", order_key: "a1", updated_at: "2026-01-10T04:00:00Z" }),
  node("series", "系列", "# 系列\n\n一組筆記。", { order_key: "a1", updated_at: "2026-01-02T04:00:00Z" }),
  node("tag-garden", "花園", "# 花園\n\n與植物有關的筆記。"),
];
const row = (id: string, date: string) => {
  const n = nodes.find((x) => x.id === id)!;
  return { id, title: n.title, slug: n.slug, date, fields: {}, image: "", excerpt: `${n.title}的摘要` };
};

function snapshot(over: { boxes?: Partial<SiteBoxes>; nodes?: PublishedNode[]; tagPages?: boolean; style?: Partial<SiteStyle>; home?: string | null } = {}) {
  return {
    title: "我的花園",
    home_node_id: over.home === undefined ? "home" : over.home,
    payload: {
      nodes: over.nodes ?? nodes,
      edges: [{ source_node_id: "compost", target_node_id: "guide", edge_type: "knowledge_link" as const }],
      presentation: {
        site: { brand: "我的花園", tagline: "慢慢長", locale: "zh-TW" },
        time_zone: "Asia/Taipei",
        design: {
          v: 3, rev: "r1", studio_draft: true, preset: "simple", date_tags: ["文章"], reading: { cover: true, preview: true }, legacy_home: null,
          style: { preset: "quiet", accent: "#3f7d6e", scheme: "system", ...over.style },
          css: "",
          boxes: { ...defaultBoxes(), ...over.boxes },
          resolved: {},
          tag_pages: over.tagPages === false ? {} : { "tag-garden": { name: "花園", slug: "garden", viewKind: "list", rows: [row("guide", "2025-12-01"), row("compost", "2026-02-03")] } },
          tag_names: { "tag-garden": "花園" },
        },
      },
    },
  };
}
const data = (over?: Parameters<typeof snapshot>[0]): SiteData => readSiteData(snapshot(over));
const article = (d: SiteData, id = "guide") => renderToString(<ArticleFrame data={d} node={d.nodes.find((n) => n.id === id)!} />);
const home = (d: SiteData) => renderToString(<HomeBody data={d} />);

describe("the default site reads like a notes garden", () => {
  const d = data();
  const out = home(d);

  it("home: the self-introduction first, then recent updates, topics and all articles by year", () => {
    expect(out).toContain("我在這裡種花也寫字。");
    const order = ["s-w--intro", "s-w--recent", "s-w--topics", "s-w--all"].map((m) => out.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("最近更新");
    expect(out).toContain("更新於 2026-03-05"); // 「更新於…」, newest first
    expect(out.indexOf("堆肥")).toBeLessThan(out.indexOf("園藝入門"));
    expect(out).toContain('class="s-year__label">2025</h3>'); // by year
    expect(out).toContain('href="/site/tag/garden/"'); // topics link to the tag page
    expect(out).toContain("2 篇");
  });

  it("the home note is not listed as an article, and neither is a tag's own note", () => {
    const recent = out.slice(out.indexOf("s-w--recent"), out.indexOf("s-w--topics"));
    expect(recent).not.toContain("首頁");
    expect(recent).not.toContain('href="/site/tag-garden"');
  });

  it("article: meta is the date and reading time, a contents list left, side notes right, backlinks with their sentence and neighbours at the end", () => {
    const a = article(d);
    expect(a).toContain('data-box="note.left"');
    expect(a).toContain('class="s-toc"');
    expect(a).toContain('data-box="note.right"');
    expect(a).toContain("s-sidenotes");
    expect(a).toContain("第一個註腳。");
    expect(a).toContain('class="s-backlinks"');
    expect(a).toContain("s-backlinks__context");
    expect(a).toContain('rel="prev"');
    expect(a).toContain("約 1 分鐘讀完");
    expect(a).not.toContain("s-article__tags"); // the default look is 日期・閱讀時間
  });

  it("tag page: the description, the notes by year, and a feed for only this tag", () => {
    const t = renderToString(<TagFrame data={d} tagId="tag-garden" page={d.design.tag_pages["tag-garden"]!} />);
    expect(t).toContain("與植物有關的筆記。");
    expect(t).toContain('class="s-year__label">2026</h3>');
    expect(t).toContain('href="/site/tag/garden/feed.xml"');
  });

  it("foot: copyright, RSS and the light/dark button; header: the site name and the search", () => {
    const foot = renderToString(<SiteFoot data={d} />);
    expect(foot).toContain("© 2026 我的花園");
    expect(foot).toContain('href="/site/feed.xml"');
    expect(foot).toContain("data-s-scheme");
    const head = renderToString(<SiteHeader data={d} />);
    expect(head).toContain("我的花園");
    expect(head).toContain("data-s-search");
  });
});

describe("a widget with nothing to show draws nothing", () => {
  const widgetBox = (id: BoxId, pick: BoxPick, over?: Parameters<typeof snapshot>[0]) => data({ ...over, boxes: { [id]: id === "home.list" ? [pick] : pick } as Partial<SiteBoxes> });

  it("the self-introduction needs a home note or a 關於 note with prose", () => {
    const none = widgetBox("home.hero", { widget: "intro", variant: "paragraph" }, { home: null, nodes: nodes.filter((n) => n.id !== "home") });
    expect(home(none)).not.toContain("s-w--intro");
    const about = node("about", "關於", "# 關於\n\n我是誰。");
    expect(home(widgetBox("home.hero", { widget: "intro", variant: "paragraph" }, { home: null, nodes: [...nodes.filter((n) => n.id !== "home"), about] }))).toContain("我是誰。");
    const bare = node("home", "首頁", "# 首頁");
    expect(home(widgetBox("home.hero", { widget: "intro", variant: "paragraph" }, { nodes: [bare, ...nodes.slice(1)] }))).not.toContain("s-w--intro");
  });

  it("topics need tag pages; featured needs notes tagged 精選; recent and all need articles", () => {
    expect(home(widgetBox("home.list", { widget: "topics", variant: "list" }, { tagPages: false }))).not.toContain("s-topics");
    expect(home(widgetBox("home.list", { widget: "featured", variant: "list" }))).toContain("堆肥");
    const unfeatured = nodes.map((n) => ({ ...n, tags: (n.tags ?? []).filter((t) => t !== "精選") }));
    expect(home(widgetBox("home.list", { widget: "featured", variant: "list" }, { nodes: unfeatured }))).not.toContain("s-w--featured");
    const alone = [nodes[0]!, nodes[5]!];
    expect(home(widgetBox("home.list", { widget: "recent", variant: "list" }, { nodes: alone }))).not.toContain("s-w--recent");
  });

  it("a box whose widgets all have nothing to show is not drawn at all", () => {
    const bare = data({ boxes: { "home.hero": null, "home.list": [{ widget: "featured", variant: "list" }] }, nodes: nodes.map((n) => ({ ...n, tags: [] })) });
    expect(home(bare)).not.toContain("s-box");
  });

  it("contents need three headings; side notes need footnotes; backlinks need links in", () => {
    const d = data();
    const few = node("few", "短文", "# 短文\n\n## 一\n\n## 二\n\n內文");
    const three = node("three", "三節", "# 三節\n\n## 一\n\n## 二\n\n## 三\n\n內文");
    const all = { ...d, nodes: [...d.nodes, few, three] };
    expect(article(all, "few")).not.toContain("s-toc");
    expect(article(all, "three")).toContain("s-toc");
    expect(article(all, "few")).not.toContain("s-sidenotes");
    expect(article(all, "guide")).toContain("s-sidenotes");
    expect(article(all, "seed")).not.toContain("s-backlinks");
    expect(articleFacts(all, all.nodes.find((n) => n.id === "three")!).headings).toBe(3);
  });

  it("the light/dark button shows only when the site follows the reader's system", () => {
    expect(renderToString(<SiteFoot data={data({ style: { scheme: "light" } })} />)).not.toContain("data-s-scheme");
    expect(renderToString(<SiteFoot data={data()} />)).toContain("data-s-scheme");
  });

  it("an empty header or foot box draws no header or foot", () => {
    const d = data({ boxes: { header: null, foot: [] } });
    expect(renderToString(<SiteHeader data={d} />)).toBe("");
    expect(renderToString(<SiteFoot data={d} />)).toBe("");
  });

  it("the website screen keeps the box and says why, instead of drawing nothing", () => {
    const d = data({ boxes: { "home.hero": null, "home.list": [{ widget: "featured", variant: "list" }] }, nodes: nodes.map((n) => ({ ...n, tags: [] })) });
    const shown = renderToString(<Box id="home.list" ctx={boxContext(d, {}, { emptyLabel: "留空" })} />);
    expect(shown).toContain("s-w--missing");
    expect(shown).toContain("需要標了「精選」的已發布筆記");
    expect(renderToString(<Box id="home.hero" ctx={boxContext(d, {}, { emptyLabel: "留空" })} />)).toContain("留空");
  });
});

describe("widgets", () => {
  it("meta looks: 日期・閱讀時間, 日期・標籤, 全部, 成熟度・日期; a note without a date tag says 更新於", () => {
    const meta = (variant: string, id = "guide") => article(data({ boxes: { "note.meta": { widget: "meta", variant } } }), id);
    expect(meta("date-reading")).toContain("2025-12-01");
    expect(meta("date-reading")).toContain("約 1 分鐘讀完");
    expect(meta("date-tags")).toContain("s-article__tags");
    expect(meta("date-tags")).not.toContain("s-reading");
    expect(meta("all")).toContain("s-article__tags");
    expect(meta("all")).toContain("s-reading");
    expect(meta("maturity-date")).toContain('data-level="3"');
    expect(meta("date-reading", "compost")).toContain("更新於 2026-03-05");
  });

  it("all articles: by year, the last 10, with the growth stage", () => {
    const list = (variant: string) => home(data({ boxes: { "home.hero": null, "home.list": [{ widget: "all", variant }] } }));
    expect(list("byYear")).toContain("s-year__label");
    const many = Array.from({ length: 14 }, (_, i) => node(`n${i}`, `筆記${i}`, `# 筆記${i}\n\n字`, { updated_at: `2026-03-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
    const ten = home(data({ nodes: [...nodes, ...many], boxes: { "home.hero": null, "home.list": [{ widget: "all", variant: "recent10" }] } }));
    expect((ten.match(/href="\/site\/n\d+"/g) ?? [])).toHaveLength(10);
    const stage = list("maturity");
    expect(stage).toContain('data-level="3"'); // 常青
    expect(stage).toContain('data-level="1"'); // 幼苗
  });

  it("the latest article is the newest by creation date", () => {
    const fresh = node("fresh", "新的一篇", "# 新的一篇\n\n剛寫好。", { created_at: "2026-05-01T00:00:00Z" });
    const out = home(data({ nodes: [...nodes, fresh], boxes: { "home.hero": null, "home.list": [{ widget: "latest", variant: "card" }] } }));
    expect(out).toContain("新的一篇");
    expect(out).toContain("剛寫好。");
  });

  it("backlinks can leave out the quoted sentence", () => {
    expect(article(data({ boxes: { "note.end": [{ widget: "backlinks", variant: "titles" }] } }))).not.toContain("s-backlinks__context");
  });

  it("subscribe links the site's feed; the tag page's feed link is that tag's own", () => {
    expect(home(data({ boxes: { "home.hero": { widget: "subscribe", variant: "rss" } } }))).toContain('href="/site/feed.xml"');
  });

  it("footnotes are read in the order the text refers to them", () => {
    expect(footnotesOf("a[^2] b[^1]\n\n[^1]: one\n[^2]: two").map((f) => f.label)).toEqual(["2", "1"]);
    expect(footnotesOf("no notes")).toEqual([]);
    expect(footnotesOf("a[^x]\n\n[^x]: first\n    continued").map((f) => f.text)).toEqual(["first continued"]);
  });

  it("a footnote-shaped line inside a code block is code, not a footnote", () => {
    expect(footnotesOf("a[^x]\n\n```\n[^x]: in code\n```")).toEqual([]);
    expect(footnotesOf("a[^x]\n\n[^x]: real\n\n```\n[^y]: in code\n```").map((f) => f.label)).toEqual(["x"]);
  });

  it("the footnote section of the text speaks the site's language, not English", () => {
    const zh = article(data());
    expect(zh).toContain("註腳");
    expect(zh).not.toContain("Footnotes");
    const en = readSiteData({ ...snapshot(), payload: { ...snapshot().payload, presentation: { ...snapshot().payload.presentation, site: { brand: "G", locale: "en" } } } });
    expect(article(en)).toContain("Footnotes");
  });
});

describe("folding on a narrow screen", () => {
  const a = article(data());

  it("the side boxes sit before and after the article in the markup, marked with how they fold", () => {
    expect(a.indexOf('data-box="note.left"')).toBeLessThan(a.indexOf("s-article__title"));
    expect(a.indexOf('data-box="note.right"')).toBeGreaterThan(a.indexOf("s-article__body"));
    expect(a).toContain('data-box="note.left" data-fold="hide"');
    expect(a).toContain('data-box="note.right" data-fold="after"');
    expect(a).toContain("s-w--narrow-hide"); // contents and side notes: not drawn narrow, in either box
  });

  it("folds with CSS only: a container query, no script", async () => {
    const { readFileSync } = await import("node:fs");
    const sheet = readFileSync("src/components/siteFrame/siteFrame.css", "utf8");
    expect(sheet).toMatch(/@container site \(min-width: 1280px\)/);
    expect(sheet).toMatch(/\.s-article-layout > \.s-box--note-left \{ display: none; \}/);
    expect(a.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, "")).not.toContain("<script"); // only the link-preview data
  });
});

describe("every home page style, every temperament, light and dark", () => {
  const colors = ["--s-bg", "--s-text", "--s-link", "--s-muted", "--s-border"] as const;

  it.each(HOME_PRESET_IDS)("home page style %s draws", (id: HomePresetId) => {
    const d = data({ boxes: applyHomePreset(defaultBoxes(), id) });
    expect(home(d)).toMatchSnapshot();
  });

  it.each(STYLE_PRESET_NAMES)("temperament %s: type and colours, light and dark", (preset) => {
    const style: SiteStyle = { preset, accent: "#3f7d6e", scheme: "system" };
    const vars = styleVars(style, { mode: "light" });
    const golden = {
      font: vars["--s-font-b"], measure: vars["--s-measure"], base: vars["--s-base"],
      light: Object.fromEntries(colors.map((c) => [c, colorVars(style, "light")[c]])),
      dark: Object.fromEntries(colors.map((c) => [c, colorVars(style, "dark")[c]])),
    };
    expect(golden).toMatchSnapshot();
  });

  it("each of the four styles is complete: every box is a known one and every widget in them draws on this site", () => {
    for (const id of HOME_PRESET_IDS) {
      const boxes = applyHomePreset(defaultBoxes(), id);
      const d = data({ boxes });
      const facts = siteFacts(d);
      for (const box of BOX_IDS) for (const p of picksOf(boxes, box)) {
        const w = WIDGETS.get(p.widget)!;
        if (box.startsWith("home")) expect(w.ready ? w.ready(facts) : true, `${id}: ${p.widget}`).toBe(true);
      }
      expect(tagFacts(d, "tag-garden").tagDescription).toBe(true);
    }
  });
});
