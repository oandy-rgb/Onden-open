// The page-navigation widgets of a published article (SiteWidgets.tsx): the explorer is the
// published tree, the graph and its data hold published notes and the links between them only.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers } from "@onden/markdown";
import { defaultBoxes } from "@onden/site";
import { ArticleFrame } from "./SiteFrames";
import { linkedNotes, noteTree, readSiteData, siteGraph, type SiteData } from "./siteModel";
import type { PublishedNode } from "../templates/publishedCore";
import { layoutGraph, neighbourhood, shortLabel } from "../../lib/siteGraph";

beforeAll(async () => { await loadAllEnhancers(); });

const node = (id: string, title: string, extra: Partial<PublishedNode> = {}): PublishedNode => ({
  id, node_type: "content", title, slug: id, markdown: `# ${title}\n\n內文`, created_at: "2026-02-03T04:00:00Z", updated_at: "2026-03-01T04:00:00Z", ...extra,
});
const nodes: PublishedNode[] = [
  node("home", "首頁"),
  node("series", "系列", { order_key: "a1" }),
  node("guide", "園藝入門", { parent_id: "series", order_key: "a2" }),
  node("compost", "堆肥", { parent_id: "series", order_key: "a3" }),
  node("loose", "散篇", { order_key: "a2" }),
  node("lonely", "孤單", { order_key: "a3" }),
  node("deep", "深一層", { parent_id: "guide", order_key: "a1" }),
];
const edges = [
  { source_node_id: "compost", target_node_id: "guide", edge_type: "knowledge_link" as const },
  { source_node_id: "guide", target_node_id: "compost", edge_type: "knowledge_link" as const }, // the same pair the other way
  { source_node_id: "guide", target_node_id: "compost", edge_type: "nav_link" as const }, // the same direction twice
  { source_node_id: "loose", target_node_id: "secret", edge_type: "knowledge_link" as const }, // a note that is not on the site
];

const data = (): SiteData => readSiteData({
  title: "站", home_node_id: "home",
  payload: {
    nodes, edges,
    presentation: {
      site: { brand: "站", locale: "zh-TW" },
      design: {
        v: 3, rev: "r", studio_draft: true, preset: "simple", date_tags: [], reading: { cover: false, preview: true }, legacy_home: null,
        style: { preset: "quiet", accent: "#3f7d6e", scheme: "system" }, css: "", boxes: defaultBoxes(), resolved: {}, tag_pages: {}, tag_names: {},
      },
    },
  },
});
const article = (d: SiteData, id: string) => renderToString(<ArticleFrame data={d} node={d.nodes.find((n) => n.id === id)!} />);
const explorerOf = (html: string) => html.slice(html.indexOf("s-explorer__panel"), html.indexOf("</nav>", html.indexOf("s-explorer__panel")));

describe("explorer", () => {
  it("lists exactly the published notes, nested as the published tree", () => {
    const d = data();
    const panel = explorerOf(article(d, "loose"));
    const hrefs = [...panel.matchAll(/href="\/site\/([^"]+)"/g)].map((m) => m[1]);
    // the tree's own order, depth first
    const flat = (items: ReturnType<typeof noteTree>): string[] => items.flatMap((i) => [i.node.slug, ...flat(i.children)]);
    expect(hrefs).toEqual(flat(noteTree(d.nodes)));
    expect([...hrefs].sort()).toEqual(d.nodes.map((n) => n.slug).sort());
    // a note with notes under it is a folder around its link; the others are plain links
    expect(panel).toMatch(/<details data-folder="series"[^>]*><summary><a href="\/site\/series"/);
    expect(panel).toMatch(/<details data-folder="guide"[^>]*><summary><a href="\/site\/guide"/);
    expect(panel).not.toContain('data-folder="loose"');
  });

  it("opens the folders on the way to the current page, marks the page, and leaves the others closed", () => {
    const d = data();
    const deep = explorerOf(article(d, "deep"));
    expect(deep).toMatch(/data-folder="series" open/);
    expect(deep).toMatch(/data-folder="guide" open/);
    expect(deep).toContain('<a href="/site/deep" aria-current="page">');
    const loose = explorerOf(article(d, "loose"));
    expect(loose).not.toMatch(/data-folder="series" open/);
    expect(loose).not.toMatch(/data-folder="guide" open/);
  });

  it("has a labelled button for a narrow screen, closed by default", () => {
    const html = article(data(), "loose");
    expect(html).toContain('aria-expanded="false" aria-controls="s-explorer-panel"');
    expect(html).toContain("檔案樹");
  });

  it("is not drawn on a site with one note", () => {
    const d = data();
    const one = { ...d, nodes: [d.nodes[0]!], edges: [] };
    expect(article(one, "home")).not.toContain("s-explorer");
  });
});

describe("graph data", () => {
  it("has the published notes and the links between them: no edge to a note outside the site, no repeat", () => {
    const d = data();
    const graph = siteGraph(d);
    const ids = graph.notes.map((n) => n.id);
    expect(ids).toEqual(d.nodes.map((n) => n.id));
    const pairs = graph.links.map(([a, b]) => `${ids[a]}>${ids[b]}`);
    expect(pairs).toEqual(["compost>guide", "guide>compost"]);
    expect(JSON.stringify(graph)).not.toContain("secret");
  });

  it("linkedNotes: both directions, each note once, never the note itself", () => {
    const d = data();
    expect(linkedNotes(d.nodes.find((n) => n.id === "guide")!, d.nodes, d.edges).map((n) => n.id)).toEqual(["compost"]);
    expect(linkedNotes(d.nodes.find((n) => n.id === "loose")!, d.nodes, d.edges)).toEqual([]);
  });
});

describe("graph widget", () => {
  it("shows on a page that has links, with its neighbours as a list and the whole-site button", () => {
    const html = article(data(), "guide");
    expect(html).toContain('data-s-graph="guide"');
    expect(html).toContain('<li><a href="/site/compost">堆肥</a></li>');
    expect(html).toContain("data-s-graph-open");
    expect(html).toContain("打開整個網站的關係圖");
  });

  it("is not drawn on a page nothing links to or from (and a link to an unpublished note does not count)", () => {
    expect(article(data(), "loose")).not.toContain("s-graph");
    expect(article(data(), "lonely")).not.toContain("s-graph");
  });

  it("carries no script of its own: the page's HTML stays small, the code is loaded when the graph is seen", () => {
    expect(article(data(), "guide").replace(/<script type="application\/json"[\s\S]*?<\/script>/g, "")).not.toContain("<script");
  });
});

describe("graph layout", () => {
  const graph = siteGraph(data());
  it("the neighbourhood of a note is the note first, its neighbours and the links among them", () => {
    const local = neighbourhood(graph, "guide")!;
    expect(local.notes.map((n) => n.id)).toEqual(["guide", "compost"]);
    expect(local.links).toEqual([[1, 0], [0, 1]]);
    expect(neighbourhood(graph, "secret")).toBeNull();
  });
  it("lays every note out inside the box, the same way every time", () => {
    const a = layoutGraph(graph.notes.length, graph.links, 320, 240);
    expect(layoutGraph(graph.notes.length, graph.links, 320, 240)).toEqual(a);
    for (const p of a) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(320); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(240); }
    // none on top of another (a note's circle and label need about this much room)
    const gaps = a.flatMap((p, i) => a.slice(i + 1).map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
    expect(Math.min(...gaps)).toBeGreaterThan(25);
    expect(layoutGraph(0, [], 10, 10)).toEqual([]);
  });
  it("cuts a long title by characters, CJK included", () => {
    expect(shortLabel("園藝入門的第一課程", 5)).toBe("園藝入門…");
    expect(shortLabel("短", 5)).toBe("短");
  });
});
