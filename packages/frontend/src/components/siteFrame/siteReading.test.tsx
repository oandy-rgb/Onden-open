// What a reader of the published site gets from the other notes: the sentence
// under each "Linked from" entry, the link-preview data of the page, and the
// guarantee that neither names a note that is not on the site.
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllEnhancers, renderHeadTags, siteHead } from "@onden/markdown";
import { defaultFrames } from "@onden/site";
import { anchored } from "../../test/helpers/anchoredText";
import { ArticleFrame } from "./SiteFrames";
import { backlinksOf, pagePreviews, previewTargetsOf, readSiteData, type SiteData } from "./siteModel";
import type { PublishedEdge, PublishedNode } from "../templates/publishedCore";

beforeAll(async () => { await loadAllEnhancers(); });

// Fixtures write a paragraph's id the old way (`text ^id`); a published page carries the text without it and the anchors
// (`part_anchors`) the snapshot brings for the paragraphs links and embeds point to.
const note = (id: string, title: string, markdown: string, extra: Partial<PublishedNode> = {}): PublishedNode => ({
  id, node_type: "content", title, slug: id, markdown: anchored(`# ${title}\n\n${markdown}`).markdown, part_anchors: anchored(`# ${title}\n\n${markdown}`).anchors, created_at: "2026-02-03T04:00:00Z", updated_at: "2026-03-04T04:00:00Z", ...extra,
});
const edge = (source_node_id: string, target_node_id: string): PublishedEdge => ({ source_node_id, target_node_id, edge_type: "knowledge_link" });

const site = (nodes: PublishedNode[], edges: PublishedEdge[], frames = defaultFrames()): SiteData => readSiteData({
  title: "花園", home_node_id: "target",
  payload: { nodes, edges, presentation: { site: { brand: "花園", locale: "zh-TW" }, time_zone: "Asia/Taipei", design: { v: 2, frames } } },
});
const html = (d: SiteData, id: string) => renderToString(<ArticleFrame data={d} node={d.nodes.find((n) => n.id === id)!} />);
const previewsOf = (out: string) => JSON.parse(/<script type="application\/json" id="s-previews">([\s\S]*?)<\/script>/.exec(out)![1]!.replace(/\\u003c/g, "<")) as ReturnType<typeof pagePreviews>;

describe("backlinksOf: the sentence a link sits in", () => {
  const target = note("target", "目標", "內容");

  it("gives the plain sentence with the link's words marked", () => {
    const source = note("src", "來源", "我讀了 **很多** 書，其中 [[目標|這一篇]] 最好。\n\n- 清單裡也有 [[目標]]");
    const [entry] = backlinksOf(target, [target, source], [edge("src", "target")]);
    expect(entry!.places).toEqual([
      { kind: "link", pieces: [{ text: "我讀了 很多 書，其中 ", mark: false }, { text: "這一篇", mark: true }, { text: " 最好。", mark: false }] },
      { kind: "link", pieces: [{ text: "清單裡也有 ", mark: false }, { text: "目標", mark: true }] },
    ]);
  });

  it("lists at most three places", () => {
    const source = note("src", "來源", Array.from({ length: 6 }, (_, i) => `第${i}段 [[目標]]`).join("\n\n"));
    expect(backlinksOf(target, [target, source], [edge("src", "target")])[0]!.places).toHaveLength(3);
  });

  it("quotes the first 34 characters of an embedded block of this note", () => {
    const withBlock = note("target", "目標", `${"句".repeat(50)} ^k1\n\n## 小節\n\n小節的內文`);
    const source = note("src", "來源", "[[目標#^k1]]\n\n[[目標#小節]]\n\n[[目標]]", { embeds: ["目標#^k1", "目標#小節", "目標"] });
    const places = backlinksOf(withBlock, [withBlock, source], [edge("src", "target")])[0]!.places;
    expect(places).toEqual([
      { kind: "embed", quote: `${"句".repeat(34)}…` },
      { kind: "embed", quote: "小節的內文" },
      { kind: "embed", quote: null },
    ]);
  });

  it("renders the sentence with <mark>, and an embed as its own wording", () => {
    const withBlock = note("target", "目標", "被內嵌的一句話 ^k1");
    const source = note("src", "來源", "提到 [[目標]] 了。\n\n[[目標#^k1]]", { embeds: ["目標#^k1"] });
    const out = html(site([withBlock, source], [edge("src", "target")]), "target");
    expect(out).toContain('<p class="s-backlinks__context">提到 <mark>目標</mark> 了。</p>');
    expect(out).toContain("內嵌了這篇的一段：『被內嵌的一句話』");
  });

  it("an entry whose link is not in the text (an edge only) still lists the note", () => {
    const source = note("src", "來源", "沒有連結");
    expect(backlinksOf(target, [target, source], [edge("src", "target")])).toEqual([{ node: source, places: [] }]);
  });
});

describe("link previews", () => {
  const a = note("a", "甲", "看 [[乙]]、[[丙]] 與 [[甲]]。", { tags: ["花"] });
  const b = note("b", "乙", "乙的內文，第一句。", { tags: ["草", "樹"] });
  const c = note("c", "丙", "丙的內文");
  const far = note("far", "遠方", "沒有人連到它");
  const back = note("back", "反向", "連到 [[甲]]");
  const nodes = [a, b, c, far, back];
  const edges = [edge("a", "b"), edge("a", "c"), edge("back", "a")];

  it("carries the notes this page links to and the ones linking here, and no other", () => {
    const out = html(site(nodes, edges), "a");
    const { notes } = previewsOf(out);
    expect(Object.keys(notes).sort()).toEqual(["b", "back", "c"]);
    expect(out).not.toContain("沒有人連到它");
    expect(out).toContain('data-note="b"');
  });

  it("a card holds the title, the updated day, the reading time, a 60-character summary and the tags", () => {
    const long = note("b", "乙", `${"字".repeat(100)}`, { tags: ["草"] });
    const d = site([a, long, c], [edge("a", "b")]);
    const { notes, labels } = previewsOf(html(d, "a"));
    expect(notes.b).toEqual({ title: "乙", meta: "更新於 2026年3月4日 · 約 1 分鐘讀完", summary: `${"字".repeat(60)}…`, tags: ["草"] });
    expect(labels.open).toBe("打開這篇");
  });

  it("words the card in the site's language", () => {
    const { notes, labels } = pagePreviews([b], "en", "Asia/Taipei");
    expect(notes.b!.meta).toBe("Updated 2026-03-04 · 1 min read");
    expect(labels.open).toBe("Open this page");
  });

  it("is absent when the switch is off, and when the page links to nothing", () => {
    const off = site(nodes, edges, { ...defaultFrames(), article: { ...defaultFrames().article, preview: false } });
    expect(html(off, "a")).not.toContain("s-previews");
    expect(html(site(nodes, edges), "far")).not.toContain("s-previews");
  });

  it("a title cannot close the script element", () => {
    const evil = note("b", "</script><b>x", "內文");
    const out = html(site([note("a", "甲", "看 [[b]]"), evil], [edge("a", "b")]), "a");
    expect(out).not.toContain("</script><b>");
    expect(previewsOf(out).notes.b!.title).toBe("</script><b>x");
  });

  it("never previews the article itself", () => {
    expect(previewTargetsOf(a, nodes, backlinksOf(a, nodes, edges)).map((n) => n.id).sort()).toEqual(["b", "back", "c"]);
  });
});

describe("a note that is not on the site is never named", () => {
  // The served snapshot holds published notes only (servedSite.ts): a note taken
  // down or never published is not among `nodes`, and its edges are filtered
  // with it. The page text still has the link, which redaction made inert.
  const SECRET = { id: "secret-id-123", slug: "secret-slug", title: "祕密標題XYZ", body: "祕密摘要內容QQQ" };
  const pub = note("pub", "公開", `我提到 [[${SECRET.title}]] 與 [[${SECRET.slug}|別名]]，也連到 [[夥伴]]。`);
  const partner = note("partner", "夥伴", "夥伴連回 [[公開]]。");
  // edges as a stale snapshot could still hold them
  const edges = [edge("pub", SECRET.id), edge(SECRET.id, "pub"), edge("pub", "partner"), edge("partner", "pub")];
  const d = site([pub, partner], edges);
  const out = html(d, "pub");
  const head = renderHeadTags(siteHead({ brand: "花園" }, { pageTitle: "公開 — 花園", variant: "article", description: "公開" }));

  it("shows the link text only, not a link", () => {
    expect(out).toContain(`<span class="published-inline-link">${SECRET.title}</span>`);
    expect(out).not.toContain(`href="/site/${SECRET.slug}"`);
  });

  it("the preview data, the Linked-from list, the head and the searchable text hold nothing of it", () => {
    for (const leak of [SECRET.id, SECRET.slug, SECRET.body]) {
      expect(out, leak).not.toContain(leak);
      expect(head, leak).not.toContain(leak);
    }
    // the title appears only as the words the author wrote in the published text
    const previews = JSON.stringify(previewsOf(out));
    expect(previews).not.toContain(SECRET.title);
    const backlinks = /<section class="s-backlinks"[\s\S]*?<\/section>/.exec(out)?.[0] ?? "";
    expect(backlinks).not.toContain(SECRET.id);
    expect(backlinks).not.toContain("secret");
    expect(Object.keys(previewsOf(out).notes)).toEqual(["partner"]);
  });

  it("the Linked-from list counts only notes on the site", () => {
    const stray = backlinksOf(pub, [pub, partner], [...edges, edge("gone", "pub")]);
    expect(stray.map((e) => e.node.id)).toEqual(["partner"]);
  });
});

describe("a block link whose note no longer holds the block", () => {
  const target = note("target", "目標", "原文已搬走");
  const moved = note("moved", "搬家後", "被搬走的一句話 ^k1");

  it("quotes the block from the published note that holds it", () => {
    const source = note("src", "來源", "[[目標#^k1]]", { embeds: ["目標#^k1"] });
    const places = backlinksOf(target, [target, moved, source], [edge("src", "target")])[0]!.places;
    expect(places).toEqual([{ kind: "embed", quote: "被搬走的一句話" }]);
  });

  it("quotes nothing when the only holder is not on the site, and never names it", () => {
    const source = note("src", "來源", "[[目標#^k1]]", { embeds: ["目標#^k1"] });
    const places = backlinksOf(target, [target, source], [edge("src", "target")])[0]!.places;
    expect(places).toEqual([{ kind: "embed", quote: null }]);
    expect(JSON.stringify(places)).not.toContain("搬家後");
  });

  it("opens the holder's page from the link, and stays on the named page when it is ambiguous", async () => {
    const { makeSiteMarkdown } = await import("./siteMarkdown");
    const source = note("src", "來源", "看 [[目標#^k1]]");
    const render = (nodes: PublishedNode[]) => renderToString(<>{makeSiteMarkdown(nodes)(source.markdown, "src")}</>);
    expect(render([target, moved, source])).toContain('href="/site/moved"');
    const twin = note("twin", "副本", "貼過來的 ^k1");
    expect(render([target, moved, twin, source])).toContain('href="/site/target"');
  });
});
